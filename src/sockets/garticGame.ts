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
  round: number; // 1-based count of turns played so far; each turn is one drawer
  totalRounds: number; // round + drawers still queued; shrinks if players leave
  drawTimeMs: number;
  queue: string[]; // userIds still waiting for their turn (excludes current drawer)
  currentDrawerId: string | null;
  word: string | null; // secret; only sent to the drawer until reveal
  guessedThisRound: Set<string>;
  players: Map<string, Player>; // players currently in the room
  departed: Map<string, number>; // scores of players who left, restored on rejoin
  deadline: number | null; // epoch ms when the current phase auto-advances
  timer: NodeJS.Timeout | null;
}

const games = new Map<string, GarticGame>();
// Rooms whose game is being started right now, so a double-click on "start"
// can't create two games (the second would orphan the first one's timer).
const starting = new Set<string>();

const DEFAULT_DRAW_TIME_MS = 80_000;
const REVEAL_MS = 5_000;
const MIN_PLAYERS = 2;

// Scoring. A correct guess is worth a flat BASE_POINTS plus a speed bonus that
// scales from SPEED_BONUS_MAX (guessed instantly) down to 0 (guessed at the
// buzzer). The drawer earns DRAWER_POINTS_PER_GUESSER for each player who gets
// it, so drawing well is rewarded.
const BASE_POINTS = 50;
const SPEED_BONUS_MAX = 100;
const DRAWER_POINTS_PER_GUESSER = 25;

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
// `excludeSocketId` omits a socket that is mid-disconnect but still in the room.
async function presentUsers(roomId: string, excludeSocketId?: string): Promise<Player[]> {
  const sockets = await getIO().in(roomId).fetchSockets();
  const seen = new Map<string, Player>();
  for (const s of sockets) {
    if (s.id === excludeSocketId) continue;
    const u = s.data?.user;
    if (u?.id && !seen.has(u.id)) {
      seen.set(u.id, { id: u.id, username: u.username, score: 0 });
    }
  }
  return [...seen.values()];
}

// Adds a user to the game's scoreboard if they aren't on it (late joiner or a
// returning player, whose previous score is restored). Returns the player.
function ensurePlayer(game: GarticGame, userId: string, username: string): Player {
  let player = game.players.get(userId);
  if (!player) {
    player = { id: userId, username, score: game.departed.get(userId) ?? 0 };
    game.departed.delete(userId);
    game.players.set(userId, player);
  }
  return player;
}

// True once every player other than the drawer has guessed this round.
function everyoneGuessed(game: GarticGame): boolean {
  const guessers = [...game.players.keys()].filter((id) => id !== game.currentDrawerId);
  return guessers.length > 0 && guessers.every((id) => game.guessedThisRound.has(id));
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

// Starts the next queued drawer's turn, skipping anyone who has left. Finishes
// the game when the queue is exhausted.
async function startNextTurn(roomId: string) {
  const game = games.get(roomId);
  if (!game) return;

  game.queue = game.queue.filter((id) => game.players.has(id));
  const drawerId = game.queue.shift();
  if (!drawerId) {
    await finishGame(roomId);
    return;
  }

  game.phase = "drawing";
  game.round += 1;
  game.totalRounds = game.round + game.queue.length;
  game.currentDrawerId = drawerId;
  game.word = pickWord();
  game.guessedThisRound = new Set();
  game.deadline = Date.now() + game.drawTimeMs;

  clearTimer(game);
  game.timer = setTimeout(() => void endRound(roomId), game.drawTimeMs);

  // Reset the board for the new drawer and lock drawing to them.
  await clearRoomDrawingShapes(roomId);
  getIO().to(roomId).emit("draw_clear", { roomId });
  await setGameDrawer(roomId, drawerId);

  await emitGameState(roomId);
}

async function endRound(roomId: string) {
  const game = games.get(roomId);
  // Guard against double entry (timer firing while the last correct guess or
  // the drawer leaving also ends the round).
  if (!game || game.phase !== "drawing") return;

  clearTimer(game);
  game.phase = "reveal";
  game.deadline = Date.now() + REVEAL_MS;
  game.timer = setTimeout(() => void advance(roomId), REVEAL_MS);

  // Nobody draws during the reveal pause.
  await setGameDrawer(roomId, null);

  getIO().to(roomId).emit("gartic_round_end", {
    roomId,
    round: game.round,
    word: game.word,
  });
  await emitGameState(roomId);
}

// Moves to the next drawer's round, or to the final results.
async function advance(roomId: string) {
  const game = games.get(roomId);
  if (!game || game.phase !== "reveal") return;
  await startNextTurn(roomId);
}

async function finishGame(roomId: string) {
  const game = games.get(roomId);
  if (!game || game.phase === "results") return;

  clearTimer(game);
  game.phase = "results";
  game.currentDrawerId = null;
  game.word = null;
  game.deadline = null;
  game.queue = [];
  game.totalRounds = game.round;
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
  if (
    starting.has(roomId) ||
    (existing && (existing.phase === "drawing" || existing.phase === "reveal"))
  ) {
    return socket.emit("error", { message: "O jogo já está em andamento." });
  }

  starting.add(roomId);
  try {
    const players = await presentUsers(roomId);
    if (players.length < MIN_PLAYERS) {
      return socket.emit("error", {
        message: `São necessários ao menos ${MIN_PLAYERS} jogadores.`,
      });
    }

    if (existing) clearTimer(existing);

    const queue = shuffle(players.map((p) => p.id));
    const game: GarticGame = {
      phase: "lobby",
      round: 0,
      totalRounds: queue.length, // one full cycle: everyone draws once
      drawTimeMs: DEFAULT_DRAW_TIME_MS,
      queue,
      currentDrawerId: null,
      word: null,
      guessedThisRound: new Set(),
      players: new Map(players.map((p) => [p.id, p])),
      departed: new Map(),
      deadline: null,
      timer: null,
    };
    games.set(roomId, game);

    await startNextTurn(roomId);
  } finally {
    starting.delete(roomId);
  }
}

// Called when a user joins a room's socket channel. During an active game the
// late joiner goes on the scoreboard (they can guess, but don't get a turn).
export async function handlePlayerJoined(roomId: string, userId: string, username: string) {
  const game = games.get(roomId);
  if (!game || (game.phase !== "drawing" && game.phase !== "reveal")) return;
  ensurePlayer(game, userId, username);
  await emitGameState(roomId);
}

// Called when a user leaves/disconnects from a room. If the active drawer leaves
// mid-round, end that round early; if the room drops below the minimum, finish.
// `excludeSocketId` is the socket that is mid-disconnect (still counted as in
// the room by socket.io at that point).
export async function handlePlayerLeft(
  roomId: string,
  userId: string,
  excludeSocketId?: string
) {
  const game = games.get(roomId);
  if (!game || game.phase === "results") return;

  const present = await presentUsers(roomId, excludeSocketId);
  // Still connected from another tab/device: they haven't really left.
  if (present.some((p) => p.id === userId)) return;

  const player = game.players.get(userId);
  if (player) game.departed.set(userId, player.score);
  game.players.delete(userId);
  game.guessedThisRound.delete(userId);
  game.queue = game.queue.filter((id) => id !== userId);
  game.totalRounds = game.round + game.queue.length;

  if (present.length < MIN_PLAYERS) {
    await finishGame(roomId);
    return;
  }

  if (game.phase === "drawing") {
    // The drawer left, or the only players still guessing just left.
    if (game.currentDrawerId === userId || everyoneGuessed(game)) {
      await endRound(roomId);
      return;
    }
  }

  await emitGameState(roomId);
}

// Whether a draw_guess round is currently being played in the room.
export function isRoundLive(roomId: string): boolean {
  return games.get(roomId)?.phase === "drawing";
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

  // First correct guess from this player. Late joiners are put on the
  // scoreboard so their guess counts like everyone else's.
  const guesser = ensurePlayer(game, userId, username);
  game.guessedThisRound.add(userId);

  // Award the guesser: flat base + a speed bonus proportional to time left.
  const remaining = Math.max(0, (game.deadline ?? Date.now()) - Date.now());
  const speedBonus = Math.round((SPEED_BONUS_MAX * remaining) / game.drawTimeMs);
  const points = BASE_POINTS + speedBonus;
  guesser.score += points;

  // Reward the drawer for each player who guesses their drawing.
  const drawer = game.currentDrawerId
    ? game.players.get(game.currentDrawerId)
    : undefined;
  if (drawer) drawer.score += DRAWER_POINTS_PER_GUESSER;

  getIO().to(roomId).emit("gartic_correct", { roomId, userId, username, points });

  // End the round early once every non-drawer player has guessed.
  if (everyoneGuessed(game)) {
    await endRound(roomId);
  } else {
    await emitGameState(roomId);
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
    try {
      if (!socket.rooms.has(roomId)) return;
      if (!games.has(roomId)) return;
      await emitGameState(roomId);
    } catch (err) {
      console.error("Erro ao enviar estado do jogo:", err);
    }
  });
}
