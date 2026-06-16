import { Socket } from "socket.io";
import { promises as fs } from "fs";
import { RoomModel } from "../models/room.model";
import { DrawingModel } from "../models/drawing.model";
import { DrawShape } from "../../shared/types/drawing";
import { roomUploadDir } from "../config/uploads";

// In-memory authoritative state for each active room's canvas. The server is the
// single source of truth: clients send minimal mutations, we validate/apply them
// here and rebroadcast. The DB only holds a debounced snapshot for persistence.
interface RoomDrawing {
  shapes: Map<string, DrawShape>;
  ownerId: string;
  drawingOwnerOnly: boolean;
  canvasWidth: number;
  canvasHeight: number;
}

const rooms = new Map<string, RoomDrawing>();
const saveTimers = new Map<string, NodeJS.Timeout>();

const MAX_SHAPES = 2000; // hard cap per room to bound memory/payload
const MAX_POINTS = 2000; // flat numbers (i.e. 1000 x/y pairs) per stroke
const MAX_TEXT_LEN = 5000; // characters per text shape
const MAX_COORD = 20000; // bound for positions / sizes
const SAVE_DEBOUNCE_MS = 1500;

const MIN_CANVAS = 320;
const MAX_CANVAS = 4096;
const DEFAULT_CANVAS_W = 1280;
const DEFAULT_CANVAS_H = 720;

const clampCanvas = (n: number) =>
  Math.min(Math.max(Math.round(n), MIN_CANVAS), MAX_CANVAS);

// Generic numeric clamp with a fallback for non-finite input.
const clampNum = (n: any, min: number, max: number, def: number) =>
  Number.isFinite(n) ? Math.min(Math.max(Number(n), min), max) : def;

const clampCoord = (n: any) => clampNum(n, -MAX_COORD, MAX_COORD, 0);

// Colours are passed straight to Konva; we only bound the length (CSS colour
// strings are short) to keep payloads small and reject junk.
const clampColor = (s: any, def: string) =>
  typeof s === "string" && s.length > 0 && s.length <= 32 ? s : def;

// Optional fill: a colour string, or undefined for "no fill" (transparent).
const sanitizeFill = (s: any): string | undefined =>
  typeof s === "string" && s.length > 0 && s.length <= 32 ? s : undefined;

const sanitizePoints = (raw: any): number[] =>
  Array.isArray(raw)
    ? raw.slice(0, MAX_POINTS).map((n: any) => (Number.isFinite(n) ? Number(n) : 0))
    : [];

// An image `src` must be a path we issued (`/uploads/<roomId>/<file>`). Rejecting
// arbitrary URLs / data URLs prevents SSRF-ish abuse and keeps the snapshot lean.
const sanitizeSrc = (raw: any): string | null => {
  if (typeof raw !== "string" || raw.length > 300) return null;
  if (raw.includes("..")) return null;
  return /^\/uploads\/[A-Za-z0-9_\-/.]+$/.test(raw) ? raw : null;
};

interface SocketUser {
  id: string;
  username: string;
}

// Loads (or returns cached) authoritative state for a room. Returns null if the
// room no longer exists.
async function loadRoom(roomId: string): Promise<RoomDrawing | null> {
  const cached = rooms.get(roomId);
  if (cached) return cached;

  const room = await RoomModel.findById(roomId);
  if (!room) return null;

  const doc = await DrawingModel.findOne({ roomId });
  const shapes = new Map<string, DrawShape>();
  doc?.shapes.forEach((s) => {
    const shape = sanitizeShape(s);
    if (shape) shapes.set(shape.id, shape);
  });

  const entry: RoomDrawing = {
    shapes,
    ownerId: room.owner.toString(),
    drawingOwnerOnly: !!room.drawingOwnerOnly,
    canvasWidth: clampCanvas(room.canvasWidth || DEFAULT_CANVAS_W),
    canvasHeight: clampCanvas(room.canvasHeight || DEFAULT_CANVAS_H),
  };
  rooms.set(roomId, entry);
  return entry;
}

// Coerces untrusted client input into a safe shape, or null if unusable. Each
// shape `type` validates/clamps its own fields. A shape with no `type` is treated
// as a freehand `'line'` for backwards compatibility with the original board.
function sanitizeShape(raw: any): DrawShape | null {
  if (!raw || typeof raw.id !== "string" || raw.id.length > 100) return null;

  const type = typeof raw.type === "string" ? raw.type : "line";
  const base = {
    id: raw.id,
    x: clampCoord(raw.x),
    y: clampCoord(raw.y),
    rotation: clampNum(raw.rotation, -360, 360, 0),
  };

  switch (type) {
    case "line": {
      const points = sanitizePoints(raw.points);
      if (points.length < 2) return null;
      return {
        ...base,
        type: "line",
        points,
        stroke: clampColor(raw.stroke, "#000000"),
        strokeWidth: clampNum(raw.strokeWidth, 1, 100, 3),
      };
    }
    case "rect": {
      return {
        ...base,
        type: "rect",
        width: clampNum(raw.width, 1, MAX_COORD, 1),
        height: clampNum(raw.height, 1, MAX_COORD, 1),
        stroke: clampColor(raw.stroke, "#000000"),
        strokeWidth: clampNum(raw.strokeWidth, 0, 100, 3),
        fill: sanitizeFill(raw.fill),
      };
    }
    case "ellipse": {
      return {
        ...base,
        type: "ellipse",
        radiusX: clampNum(raw.radiusX, 1, MAX_COORD, 1),
        radiusY: clampNum(raw.radiusY, 1, MAX_COORD, 1),
        stroke: clampColor(raw.stroke, "#000000"),
        strokeWidth: clampNum(raw.strokeWidth, 0, 100, 3),
        fill: sanitizeFill(raw.fill),
      };
    }
    case "arrow": {
      const points = sanitizePoints(raw.points);
      if (points.length < 4) return null;
      return {
        ...base,
        type: "arrow",
        points: points.slice(0, 4),
        stroke: clampColor(raw.stroke, "#000000"),
        strokeWidth: clampNum(raw.strokeWidth, 1, 100, 3),
        arrow: raw.arrow !== false,
      };
    }
    case "text": {
      const text = typeof raw.text === "string" ? raw.text.slice(0, MAX_TEXT_LEN) : "";
      if (!text) return null;
      return {
        ...base,
        type: "text",
        text,
        fontSize: clampNum(raw.fontSize, 6, 400, 24),
        fill: clampColor(raw.fill, "#000000"),
        width: Number.isFinite(raw.width) ? clampNum(raw.width, 1, MAX_COORD, 200) : undefined,
      };
    }
    case "image": {
      const src = sanitizeSrc(raw.src);
      if (!src) return null;
      return {
        ...base,
        type: "image",
        src,
        width: clampNum(raw.width, 1, MAX_COORD, 100),
        height: clampNum(raw.height, 1, MAX_COORD, 100),
      };
    }
    default:
      return null;
  }
}

// Persists the room's current snapshot, debounced so a burst of edits (drags,
// rapid strokes) collapses into a single write.
function scheduleSave(roomId: string) {
  if (saveTimers.has(roomId)) return;
  const timer = setTimeout(async () => {
    saveTimers.delete(roomId);
    const entry = rooms.get(roomId);
    if (!entry) return;
    try {
      await DrawingModel.findOneAndUpdate(
        { roomId },
        { shapes: [...entry.shapes.values()] },
        { upsert: true }
      );
    } catch (err) {
      console.error("Erro ao salvar desenho:", err);
    }
  }, SAVE_DEBOUNCE_MS);
  saveTimers.set(roomId, timer);
}

function canDraw(entry: RoomDrawing, userId: string): boolean {
  return !entry.drawingOwnerOnly || entry.ownerId === userId;
}

// Drops a room's in-memory canvas state (and any pending save timer) so the
// `rooms` map doesn't grow unbounded. By default it flushes the current snapshot
// to the DB first, so edits made within the debounce window aren't lost when the
// last member leaves. Pass `persist = false` when the room is being deleted.
export async function evictRoomDrawing(roomId: string, persist = true) {
  const timer = saveTimers.get(roomId);
  if (timer) {
    clearTimeout(timer);
    saveTimers.delete(roomId);
  }
  const entry = rooms.get(roomId);
  rooms.delete(roomId);

  if (persist && entry) {
    try {
      await DrawingModel.findOneAndUpdate(
        { roomId },
        { shapes: [...entry.shapes.values()] },
        { upsert: true }
      );
    } catch (err) {
      console.error("Erro ao salvar desenho:", err);
    }
  }
}

// Removes a room's drawing entirely (in-memory + persisted snapshot + uploaded
// images on disk). Used on room delete so nothing is orphaned.
export async function deleteRoomDrawing(roomId: string) {
  await evictRoomDrawing(roomId, false);
  try {
    await DrawingModel.deleteOne({ roomId });
  } catch (err) {
    console.error("Erro ao remover desenho:", err);
  }
  try {
    await fs.rm(roomUploadDir(roomId), { recursive: true, force: true });
  } catch (err) {
    console.error("Erro ao remover imagens da sala:", err);
  }
}

// Sends the full board state to a single socket (on join / explicit request).
export async function sendDrawState(socket: Socket, roomId: string) {
  if (!socket.rooms.has(roomId)) return;
  const entry = await loadRoom(roomId);
  if (!entry) return;
  const user = socket.data.user as SocketUser;
  socket.emit("draw_state", {
    roomId,
    shapes: [...entry.shapes.values()],
    drawingOwnerOnly: entry.drawingOwnerOnly,
    canvasWidth: entry.canvasWidth,
    canvasHeight: entry.canvasHeight,
    isOwner: entry.ownerId === user.id,
  });
}

export function registerDrawingHandlers(socket: Socket) {
  const user = socket.data.user as SocketUser;

  // Client (re)requests the current board, e.g. when opening the whiteboard panel.
  socket.on("draw_request_state", async (roomId: string) => {
    await sendDrawState(socket, roomId);
  });

  // A completed stroke. We send the full (small) shape once, on pointer-up.
  socket.on("draw_add", async ({ roomId, shape }: { roomId: string; shape: any }) => {
    if (!socket.rooms.has(roomId)) return;
    const entry = await loadRoom(roomId);
    if (!entry || !canDraw(entry, user.id)) return;
    if (entry.shapes.size >= MAX_SHAPES) return;

    const clean = sanitizeShape(shape);
    if (!clean) return;

    entry.shapes.set(clean.id, clean);
    socket.to(roomId).emit("draw_add", { roomId, shape: clean });
    scheduleSave(roomId);
  });

  // Live drag of an existing stroke. Throttled by the client; we forward only the
  // minimal { id, x, y } to everyone else. Sender is excluded (it already moved).
  socket.on(
    "draw_move",
    async ({ roomId, id, x, y }: { roomId: string; id: string; x: number; y: number }) => {
      if (!socket.rooms.has(roomId)) return;
      const entry = await loadRoom(roomId);
      if (!entry || !canDraw(entry, user.id)) return;

      const shape = entry.shapes.get(id);
      if (!shape) return;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;

      shape.x = Number(x);
      shape.y = Number(y);
      socket.to(roomId).emit("draw_move", { roomId, id, x: shape.x, y: shape.y });
      scheduleSave(roomId);
    }
  );

  // Partial update of an existing shape: resize, rotate, restyle, or edit text.
  // The client sends the full (small) shape; we re-sanitize, force its original
  // `type` (no type changes via update) and rebroadcast. Used at transform-end /
  // text-commit, so it's low-frequency unlike the throttled drag stream.
  socket.on("draw_update", async ({ roomId, shape }: { roomId: string; shape: any }) => {
    if (!socket.rooms.has(roomId)) return;
    const entry = await loadRoom(roomId);
    if (!entry || !canDraw(entry, user.id)) return;
    if (!shape || typeof shape.id !== "string") return;

    const existing = entry.shapes.get(shape.id);
    if (!existing) return; // update only applies to shapes that already exist

    const merged = sanitizeShape({ ...existing, ...shape, type: existing.type });
    if (!merged) return;

    entry.shapes.set(merged.id, merged);
    socket.to(roomId).emit("draw_update", { roomId, shape: merged });
    scheduleSave(roomId);
  });

  socket.on("draw_remove", async ({ roomId, id }: { roomId: string; id: string }) => {
    if (!socket.rooms.has(roomId)) return;
    const entry = await loadRoom(roomId);
    if (!entry || !canDraw(entry, user.id)) return;
    if (!entry.shapes.delete(id)) return;

    socket.to(roomId).emit("draw_remove", { roomId, id });
    scheduleSave(roomId);
  });

  socket.on("draw_clear", async ({ roomId }: { roomId: string }) => {
    if (!socket.rooms.has(roomId)) return;
    const entry = await loadRoom(roomId);
    if (!entry || !canDraw(entry, user.id)) return;

    entry.shapes.clear();
    socket.to(roomId).emit("draw_clear", { roomId });
    scheduleSave(roomId);
  });

  // Owner-only board settings: the "owner-only drawing" beta toggle and the
  // shared canvas size. Provided fields are applied, persisted, and broadcast so
  // every client re-evaluates its draw permission / resizes its board in sync.
  socket.on(
    "draw_settings",
    async ({
      roomId,
      drawingOwnerOnly,
      canvasWidth,
      canvasHeight,
    }: {
      roomId: string;
      drawingOwnerOnly?: boolean;
      canvasWidth?: number;
      canvasHeight?: number;
    }) => {
      if (!socket.rooms.has(roomId)) return;
      const entry = await loadRoom(roomId);
      if (!entry || entry.ownerId !== user.id) return;

      const update: Record<string, unknown> = {};
      if (typeof drawingOwnerOnly === "boolean") {
        entry.drawingOwnerOnly = drawingOwnerOnly;
        update.drawingOwnerOnly = entry.drawingOwnerOnly;
      }
      if (Number.isFinite(canvasWidth) && Number.isFinite(canvasHeight)) {
        entry.canvasWidth = clampCanvas(canvasWidth as number);
        entry.canvasHeight = clampCanvas(canvasHeight as number);
        update.canvasWidth = entry.canvasWidth;
        update.canvasHeight = entry.canvasHeight;
      }
      if (Object.keys(update).length === 0) return;

      try {
        await RoomModel.findByIdAndUpdate(roomId, update);
      } catch (err) {
        console.error("Erro ao salvar configuração de desenho:", err);
      }
      // Broadcast to the whole room (including sender) so toolbars stay in sync.
      socket.nsp.to(roomId).emit("draw_settings", {
        roomId,
        drawingOwnerOnly: entry.drawingOwnerOnly,
        canvasWidth: entry.canvasWidth,
        canvasHeight: entry.canvasHeight,
      });
    }
  );
}
