import { Socket } from "socket.io";
import { RoomModel } from "../models/room.model";
import { DrawingModel } from "../models/drawing.model";
import { DrawShape } from "../../shared/types/drawing";

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
const SAVE_DEBOUNCE_MS = 1500;

const MIN_CANVAS = 320;
const MAX_CANVAS = 4096;
const DEFAULT_CANVAS_W = 1280;
const DEFAULT_CANVAS_H = 720;

const clampCanvas = (n: number) =>
  Math.min(Math.max(Math.round(n), MIN_CANVAS), MAX_CANVAS);

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

// Coerces untrusted client input into a safe shape, or null if unusable.
function sanitizeShape(raw: any): DrawShape | null {
  if (!raw || typeof raw.id !== "string" || raw.id.length > 100) return null;

  const points = Array.isArray(raw.points)
    ? raw.points
        .slice(0, MAX_POINTS)
        .map((n: any) => (Number.isFinite(n) ? Number(n) : 0))
    : [];
  if (points.length < 2) return null;

  const stroke = typeof raw.stroke === "string" ? raw.stroke.slice(0, 32) : "#000000";
  const strokeWidth = Number.isFinite(raw.strokeWidth)
    ? Math.min(Math.max(Number(raw.strokeWidth), 1), 100)
    : 3;

  return {
    id: raw.id,
    points,
    x: Number.isFinite(raw.x) ? Number(raw.x) : 0,
    y: Number.isFinite(raw.y) ? Number(raw.y) : 0,
    stroke,
    strokeWidth,
  };
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
