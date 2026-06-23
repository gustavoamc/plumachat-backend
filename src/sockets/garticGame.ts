import { Socket } from "socket.io";
import { RoomModel } from "../models/room.model";
import { getIO } from "./setupSocket";
import { setGameDrawer, clearRoomDrawingShapes } from "./drawing";
import { WORD_BANK } from "../data/words";

// In-memory, authoritative state for each active draw_guess game, keyed by
// roomId. Mirrors the pattern in drawing.ts: the server owns the truth, clients
// render the snapshots it pushes. State is built on game start and torn down when
// the room empties (evictGarticGame). Nothing here is persisted — a game is
// ephemeral; only the room's roomType lives in Mongo.

type Phase = "lobby" | "drawing" | "reveal" | "results";

interface Player {
  id: string;
  username: string;
  score: number;
}

interface GarticGame {
  phase: Phase;
  round: number; // 1..totalRounds; each round is one drawer's turn
  totalRounds: number;
  drawTimeMs: number;
  turnOrder: string[]; // userIds, fixed at game start
  currentDrawerId: string | null;
  word: string | null; // secret; only sent to the drawer until reveal
  guessedThisRound: Set<string>;
  players: Map<string, Player>;
  deadline: number | null; // epoch ms when the current phase auto-advances
  timer: NodeJS.Timeout | null;
}

const games = new Map<string, GarticGame>();

const DEFAULT_DRAW_TIME_MS = 80_000;
const REVEAL_MS = 5_000;
const MIN_PLAYERS = 2;

// ---- helpers ---------------------------------------------------------------

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickWord(): string {
  return WORD_BANK[Math.floor(Math.random() * WORD_BANK.length)];
}

// Normalizes a word/guess for comparison: strips accents, trims, lowercases and
// collapses inner whitespace, so "Avião" / "aviao" / " aviao " all match.
function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritical marks
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function clearTimer(game: GarticGame) {
  if (game.timer) {
    clearTimeout(game.timer);
    game.timer = null;
  }
}

// Returns the unique connected users currently in a room, as { id, username }.
async function presentUsers(roomId: string): Promise<Player[]> {
  const sockets = await getIO().in(roomId).fetchSockets();
  const seen = new Map<string, Player>();
  for (const s of sockets) {
    const u = s.data?.user;
    if (u?.id && !seen.has(u.id)) {
      seen.set(u.id, { id: u.id, username: u.username, score: 0 });
    }
  }
  return [...seen.values()];
}

// Accessor used by the chat layer (Step 3) and tests to know the active drawer.
export function getCurrentDrawer(roomId: string): string | null {
  return games.get(roomId)?.currentDrawerId ?? null;
}

export function getGamePhase(roomId: string): Phase | null {
  return games.get(roomId)?.phase ?? null;
}

// ---- state broadcast -------------------------------------------------------

// Emits a per-socket snapshot: the secret word goes only to the current drawer
// (and to everyone during reveal/results); guessers get just its length.
async function emitGameState(roomId: string) {
  const game = games.get(roomId);
  if (!game) return;
  const io = getIO();

  const revealWord = game.phase === "reveal" || game.phase === "results";
  const base = {
    roomId,
    phase: game.phase,
    round: game.round,
    totalRounds: game.totalRounds,
    drawerId: game.currentDrawerId,
    drawerName: game.currentDrawerId
      ? game.players.get(game.currentDrawerId)?.username ?? null
      : null,
    deadline: game.deadline,
    wordLength: game.word ? game.word.length : null,
    guessed: [...game.guessedThisRound],
    players: [...game.players.values()]
      .map((p) => ({ id: p.id, username: p.username, score: p.score }))
      .sort((a, b) => b.score - a.score),
  };

  const sockets = await io.in(roomId).fetchSockets();
  for (const s of sockets) {
    const uid = s.data?.user?.id;
    const isDrawer = !!uid && uid === game.currentDrawerId;
    s.emit("gartic_state", {
      ...base,
      youAreDrawer: isDrawer,
      word: isDrawer || revealWord ? game.word : null,
    });
  }
}

// ---- game lifecycle --------------------------------------------------------

async function startRound(roomId: string, round: number) {
  const game = games.get(roomId);
  if (!game) return;

  const drawerId = game.turnOrder[round - 1];
  game.phase = "drawing";
  game.round = round;
  game.currentDrawerId = drawerId;
  game.word = pickWord();
  game.guessedThisRound = new Set();
  game.deadline = Date.now() + game.drawTimeMs;

  // Reset the board for the new drawer and lock drawing to them.
  await clearRoomDrawingShapes(roomId);
  getIO().to(roomId).emit("draw_clear", { roomId });
  await setGameDrawer(roomId, drawerId);

  clearTimer(game);
  game.timer = setTimeout(() => void endRound(roomId), game.drawTimeMs);

  await emitGameState(roomId);
}

async function endRound(roomId: string) {
  const game = games.get(roomId);
  if (!game) return;

  game.phase = "reveal";
  game.deadline = Date.now() + REVEAL_MS;
  // Nobody draws during the reveal pause.
  await setGameDrawer(roomId, null);

  getIO().to(roomId).emit("gartic_round_end", {
    roomId,
    round: game.round,
    word: game.word,
  });
  await emitGameState(roomId);

  clearTimer(game);
  game.timer = setTimeout(() => void advance(roomId), REVEAL_MS);
}

// Moves to the next drawer's round, or to the final results.
async function advance(roomId: string) {
  const game = games.get(roomId);
  if (!game) return;

  if (game.round < game.totalRounds) {
    await startRound(roomId, game.round + 1);
  } else {
    await finishGame(roomId);
  }
}

async function finishGame(roomId: string) {
  const game = games.get(roomId);
  if (!game) return;

  clearTimer(game);
  game.phase = "results";
  game.currentDrawerId = null;
  game.word = null;
  game.deadline = null;
  await setGameDrawer(roomId, null);

  getIO().to(roomId).emit("gartic_results", {
    roomId,
    players: [...game.players.values()]
      .map((p) => ({ id: p.id, username: p.username, score: p.score }))
      .sort((a, b) => b.score - a.score),
  });
  await emitGameState(roomId);
}

// Owner-triggered start (or restart from lobby/results). Validates the room type,
// requester, and player count; replies with an error event on the requesting
// socket if it can't begin.
async function beginGame(socket: Socket, roomId: string) {
  const user = socket.data.user as { id: string; username: string };

  if (!socket.rooms.has(roomId)) {
    return socket.emit("error", { message: "Você não está nesta sala." });
  }

  const room = await RoomModel.findById(roomId);
  if (!room) {
    return socket.emit("error", { message: "Sala não encontrada." });
  }
  if (room.roomType !== "draw_guess") {
    return socket.emit("error", { message: "Esta sala não é do tipo jogo." });
  }
  if (room.owner.toString() !== user.id) {
    return socket.emit("error", {
      message: "Apenas o dono da sala pode iniciar o jogo.",
    });
  }

  const existing = games.get(roomId);
  if (existing && (existing.phase === "drawing" || existing.phase === "reveal")) {
    return socket.emit("error", { message: "O jogo já está em andamento." });
  }

  const players = await presentUsers(roomId);
  if (players.length < MIN_PLAYERS) {
    return socket.emit("error", {
      message: `São necessários ao menos ${MIN_PLAYERS} jogadores.`,
    });
  }

  const turnOrder = shuffle(players.map((p) => p.id));
  const game: GarticGame = {
    phase: "lobby",
    round: 0,
    totalRounds: turnOrder.length, // one full cycle: everyone draws once
    drawTimeMs: DEFAULT_DRAW_TIME_MS,
    turnOrder,
    currentDrawerId: null,
    word: null,
    guessedThisRound: new Set(),
    players: new Map(players.map((p) => [p.id, p])),
    deadline: null,
    timer: null,
  };
  games.set(roomId, game);

  await startRound(roomId, 1);
}

// Called when a user leaves/disconnects from a room. If the active drawer leaves
// mid-round, end that round early; if the room drops below the minimum, finish.
export async function handlePlayerLeft(roomId: string, userId: string) {
  const game = games.get(roomId);
  if (!game) return;

  game.players.delete(userId);
  game.turnOrder = game.turnOrder.filter((id) => id !== userId);

  if (game.phase === "drawing" && game.currentDrawerId === userId) {
    await endRound(roomId);
    return;
  }

  const remaining = await presentUsers(roomId);
  if (remaining.length < MIN_PLAYERS && game.phase !== "results") {
    await finishGame(roomId);
  }
}

type ChatVerdict = "pass" | "drawer_blocked" | "correct" | "suppressed";

// Routes a plain chat message through guess-checking when a draw_guess round is
// live. Returns how the caller (the chat layer) should treat the message:
//   - "pass"          → not a game guess; broadcast as normal chat
//   - "drawer_blocked"→ the drawer may not chat during their round; reject
//   - "correct"       → first correct guess; consumed (don't broadcast the word)
//   - "suppressed"    → already-correct player repeating the word; drop silently
// In default rooms (or outside the drawing phase) it always returns "pass".
export async function handleChatMessage(
  roomId: string,
  userId: string,
  username: string,
  content: string
): Promise<ChatVerdict> {
  const game = games.get(roomId);
  if (!game || game.phase !== "drawing") return "pass";

  // The drawer can neither chat nor leak the word during their round.
  if (userId === game.currentDrawerId) return "drawer_blocked";

  const isCorrect =
    game.word != null && normalize(content) === normalize(game.word);

  // Players who already guessed can keep chatting, but a repeat of the word is
  // dropped so it doesn't spoil the answer for others still guessing.
  if (game.guessedThisRound.has(userId)) {
    return isCorrect ? "suppressed" : "pass";
  }

  if (!isCorrect) return "pass";

  // First correct guess from this player.
  game.guessedThisRound.add(userId);
  // Phase 4 will award points here based on remaining time.
  getIO().to(roomId).emit("gartic_correct", { roomId, userId, username });
  await emitGameState(roomId);

  // End the round early once every non-drawer player has guessed.
  const guessers = game.players.size - 1;
  if (guessers > 0 && game.guessedThisRound.size >= guessers) {
    await endRound(roomId);
  }
  return "correct";
}

// Drops a room's game state and its timer. Mirrors evictRoomDrawing; called when
// the room empties or is deleted. Also releases the drawing lock.
export async function evictGarticGame(roomId: string) {
  const game = games.get(roomId);
  if (!game) return;
  clearTimer(game);
  games.delete(roomId);
  await setGameDrawer(roomId, null);
}

// ---- socket wiring ---------------------------------------------------------

export function registerGarticHandlers(socket: Socket) {
  socket.on("gartic_start", async (roomId: string) => {
    try {
      await beginGame(socket, roomId);
    } catch {
      socket.emit("error", { message: "Erro ao iniciar o jogo." });
    }
  });

  // Late joiners / reconnects rehydrate from the authoritative snapshot (the
  // deadline is included so the countdown resyncs locally).
  socket.on("gartic_request_state", async (roomId: string) => {
    if (!socket.rooms.has(roomId)) return;
    if (!games.has(roomId)) return;
    await emitGameState(roomId);
  });
}
