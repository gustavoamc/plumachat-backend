import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import { UserModel } from "../models/user.model";
import { RoomModel } from "../models/room.model";
import { MessageModel } from "../models/message.model";
import { registerDrawingHandlers, sendDrawState } from "./drawing";

let io: Server;

interface SocketUser {
  id: string;
  role: string;
  username: string;
}

export const initIO = (server: any) => {
  io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  // Middleware to authenticate the socket connection
  // This will check the JWT token sent by the client
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error("Token ausente"));
    }
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { id: string; role: string };

      const user = await UserModel.findById(decoded.id);
      if (!user) {
        return next(new Error("Usuário não encontrado"));
      }
      if (user.isBanned) {
        return next(new Error("Usuário banido"));
      }

      const socketUser: SocketUser = {
        id: user.id,
        role: user.role,
        username: user.username,
      };
      (socket as any).user = socketUser;
      // Also on socket.data so fetchSockets() can read it for presence
      socket.data.user = socketUser;

      next();
    } catch (err) {
      return next(new Error("Token inválido"));
    }
  });

  // Handles global events
  io.on("connection", (socket) => {
    const socketUser = (socket as any).user as SocketUser;
    console.log(`Novo cliente conectado: ${socket.id} (${socketUser.username})`);

    // Shared-canvas (draw_*) events live in their own module.
    registerDrawingHandlers(socket);

    // Join a specific room
    socket.on("join_room", async (roomId: string) => {
      try {
        const room = await RoomModel.findById(roomId);
        if (!room) {
          return socket.emit("error", { message: "Sala não encontrada." });
        }

        const isParticipant = room.participants.some(
          (participant) => participant.toString() === socketUser.id
        );
        if (!isParticipant) {
          return socket.emit("error", { message: "Você não tem permissão para entrar nesta sala." });
        }

        socket.join(roomId);
        emitSystemMessage(roomId, socketUser.username, "entrou");
        await emitPresence(roomId);
        // Send the current canvas snapshot to the joining client.
        await sendDrawState(socket, roomId);
        console.log(`Usuário ${socketUser.username} entrou na sala ${roomId}`);
      } catch (err) {
        socket.emit("error", { message: "Erro ao entrar na sala." });
      }
    });

    // Leave a specific room (closed the chat view)
    socket.on("leave_room", async (roomId: string) => {
      emitSystemMessage(roomId, socketUser.username, "desconectou");
      socket.leave(roomId);
      await emitPresence(roomId);
      console.log(`Usuário ${socketUser.username} saiu da sala ${roomId}`);
    });

    // send a message to a specific room
    socket.on("send_message", async ({ roomId, content }: { roomId: string; content: string }) => {
      try {
        if (!roomId || !content || typeof content !== "string" || !content.trim()) {
          return socket.emit("error", { message: "Mensagem inválida." });
        }

        if (!socket.rooms.has(roomId)) {
          return socket.emit("error", { message: "Você não está nesta sala." });
        }

        let finalContent = content.trim();

        // Slash commands are processed server-side
        if (finalContent.startsWith("/")) {
          const [command, ...args] = finalContent.slice(1).trim().split(/\s+/);
          const cmd = command.toLowerCase();

          if (cmd === "r" || cmd === "roll") {
            const notation = args[0] ?? "";
            const result = rollDice(notation);
            if (!result) {
              return socket.emit("error", {
                message: "Notação inválida. Ex: /r 2d6 ou /r 2d8+6 tiro",
              });
            }
            const label = args.slice(1).join(" ").trim();
            const labelPart = label
              ? ` "${label.charAt(0).toUpperCase()}${label.slice(1)}"`
              : "";
            const mod = result.modifier === 0
              ? ""
              : result.modifier > 0 ? ` +${result.modifier}` : ` ${result.modifier}`;
            finalContent = `🎲 Rolou${labelPart}: ${notation}: [${result.rolls.join(", ")}]${mod} = ${result.total}`;
          } else if (cmd === "sussurro" || cmd === "sussuro" || cmd === "w") {
            const targetUsername = args[0];
            const message = args.slice(1).join(" ").trim();
            if (!targetUsername || !message) {
              return socket.emit("error", { message: "Uso: /sussurro <usuário> <mensagem>" });
            }

            const sockets = await io.in(roomId).fetchSockets();
            const targets = sockets.filter(
              (s) => s.data?.user?.username?.toLowerCase() === targetUsername.toLowerCase()
            );
            if (targets.length === 0) {
              return socket.emit("error", { message: `"${targetUsername}" não está na sala.` });
            }

            const base = {
              _id: `whisper-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              userId: socketUser.id,
              username: socketUser.username,
              roomId,
              timestamp: new Date().toISOString(),
            };
            // Private and ephemeral: deliver only to the target(s) and the sender
            for (const t of targets) {
              t.emit("receive_message", {
                ...base,
                content: `🤫 (sussurro de ${socketUser.username}): ${message}`,
              });
            }
            socket.emit("receive_message", {
              ...base,
              content: `🤫 (sussurro para ${targetUsername}): ${message}`,
            });
            return;
          } else {
            return socket.emit("error", { message: `Comando desconhecido: /${command}` });
          }
        }

        const newMessage = await MessageModel.create({
          userId: socketUser.id,
          roomId,
          content: finalContent,
        });

        io.to(roomId).emit("receive_message", {
          _id: newMessage._id,
          userId: socketUser.id,
          username: socketUser.username,
          roomId,
          content: newMessage.content,
          timestamp: newMessage.get("timestamp"),
        });
      } catch (err) {
        socket.emit("error", { message: "Erro ao enviar mensagem." });
      }
    });

    // Fires before the socket leaves its rooms, so socket.rooms still has them
    socket.on("disconnecting", async () => {
      const rooms = [...socket.rooms].filter((roomId) => roomId !== socket.id);
      for (const roomId of rooms) {
        emitSystemMessage(roomId, socketUser.username, "desconectou");
        // Recompute presence excluding this disconnecting socket
        await emitPresence(roomId, socket.id);
      }
    });

    socket.on("disconnect", () => {
      console.log(`Cliente desconectado: ${socket.id} (${socketUser?.username})`);
    });
  });

  return io;
};

// Parses dice notation like "2d6" or "3d10+2" and rolls it. Returns null if invalid.
const rollDice = (notation: string) => {
  const match = notation.match(/^(\d+)d(\d+)([+-]\d+)?$/i);
  if (!match) return null;
  const count = parseInt(match[1], 10);
  const sides = parseInt(match[2], 10);
  const modifier = match[3] ? parseInt(match[3], 10) : 0;
  if (count < 1 || count > 100 || sides < 1 || sides > 1000) return null;

  const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
  const total = rolls.reduce((a, b) => a + b, 0) + modifier;
  return { rolls, modifier, total };
};

// Broadcasts the list of currently-connected user ids in a room.
// `excludeSocketId` omits a socket that is mid-disconnect but still in the room.
const emitPresence = async (roomId: string, excludeSocketId?: string) => {
  if (!io) return;
  const sockets = await io.in(roomId).fetchSockets();
  const onlineUserIds = [
    ...new Set(
      sockets
        .filter((s) => s.id !== excludeSocketId)
        .map((s) => s.data?.user?.id)
        .filter(Boolean)
    ),
  ];
  io.to(roomId).emit("presence", { roomId, onlineUserIds });
};

// Persists and broadcasts a system notice (join/leave/disconnect/removal) to a room.
// Stored as a message with no userId (authored by "system") and system: true.
export const emitSystemMessage = async (roomId: string, username: string, action: string) => {
  if (!io) return;
  try {
    const newMessage = await MessageModel.create({
      roomId,
      content: `${username} ${action}`,
      system: true,
    });
    io.to(roomId).emit("system_message", {
      _id: newMessage._id,
      system: true,
      content: newMessage.content,
      timestamp: newMessage.get("timestamp"),
    });
  } catch (err) {
    console.error("Erro ao salvar mensagem de sistema:", err);
  }
};

export const getIO = (): Server => {
  if (!io) {
    throw new Error("Socket.IO não foi inicializado!");
  }
  return io;
};
