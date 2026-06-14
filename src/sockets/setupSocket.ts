import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import { UserModel } from "../models/user.model";
import { RoomModel } from "../models/room.model";
import { MessageModel } from "../models/message.model";

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

      (socket as any).user = {
        id: user.id,
        role: user.role,
        username: user.username,
      } as SocketUser;

      next();
    } catch (err) {
      return next(new Error("Token inválido"));
    }
  });

  // Handles global events
  io.on("connection", (socket) => {
    const socketUser = (socket as any).user as SocketUser;
    console.log(`Novo cliente conectado: ${socket.id} (${socketUser.username})`);

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
        console.log(`Usuário ${socketUser.username} entrou na sala ${roomId}`);
      } catch (err) {
        socket.emit("error", { message: "Erro ao entrar na sala." });
      }
    });

    // Leave a specific room (closed the chat view)
    socket.on("leave_room", (roomId: string) => {
      emitSystemMessage(roomId, socketUser.username, "desconectou");
      socket.leave(roomId);
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

        const newMessage = await MessageModel.create({
          userId: socketUser.id,
          roomId,
          content: content.trim(),
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
    socket.on("disconnecting", () => {
      for (const roomId of socket.rooms) {
        if (roomId !== socket.id) {
          emitSystemMessage(roomId, socketUser.username, "desconectou");
        }
      }
    });

    socket.on("disconnect", () => {
      console.log(`Cliente desconectado: ${socket.id} (${socketUser?.username})`);
    });
  });

  return io;
};

// Broadcasts a system notice (join/leave/disconnect/removal) to everyone in a room.
// Not persisted — these are ephemeral, runtime-only chat notices.
export const emitSystemMessage = (roomId: string, username: string, action: string) => {
  if (!io) return;
  io.to(roomId).emit("system_message", {
    _id: `sys-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    system: true,
    username,
    action,
    timestamp: new Date().toISOString(),
  });
};

export const getIO = (): Server => {
  if (!io) {
    throw new Error("Socket.IO não foi inicializado!");
  }
  return io;
};
