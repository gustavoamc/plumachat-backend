import { Request, Response } from "express";
import { getUserByToken } from "../helpers/getUserByToken";
import { RoomModel } from "../models/room.model";
import { UserModel } from "../models/user.model";
import { MessageModel } from "../models/message.model";
import { getIO, emitSystemMessage } from "../sockets/setupSocket";
import { deleteRoomDrawing } from "../sockets/drawing";
import { evictGarticGame } from "../sockets/garticGame";
import { RoomType } from "../../shared/types/room";

// Room types a client is allowed to create. Kept in sync with the model enum
// and the shared RoomType union.
const ROOM_TYPES: RoomType[] = ["default", "draw_guess"];

export const createRoom = async (req: Request, res: Response) => {
  const user = await getUserByToken(req);
  if (!user) {
    return res.status(404).json({ message: "Usuário não encontrado!" });
  }

  const { name, isPrivate, roomType } = req.body;

  if (!name || typeof name !== "string" || name.trim() === "") {
    return res.status(400).json({ message: "Nome da sala é obrigatório." });
  }

  // roomType is optional; default to a classic chat-with-canvas room. Reject
  // anything not in the known set so the schema enum is never the first guard.
  const type: RoomType = roomType ?? "default";
  if (!ROOM_TYPES.includes(type)) {
    return res.status(400).json({ message: "Tipo de sala inválido." });
  }

  try {
    const newRoom = new RoomModel({
      name: name,
      owner: user._id,
      isPrivate: isPrivate,
      roomType: type,
      participants: [user._id],
    });

    await newRoom.save();

    return res
      .status(201)
      .json({ message: "Sala criada com sucesso!", room: newRoom });
  } catch (error) {
    return res.status(500).json({ message: "Erro ao criar sala." });
  }
};

export const getRooms = async (req: Request, res: Response) => {
  const user = await getUserByToken(req);
  if (!user) {
    return res.status(404).json({ message: "Usuário não encontrado!" });
  }

  try {
    const rooms = await RoomModel.find({ participants: user._id })
    return res.status(200).json(rooms);
  } catch (error) {
    return res.status(500).json({ message: "Erro ao buscar salas." });
  }
};

export const getRoom = async (req: Request, res: Response) => {
  const user = await getUserByToken(req);
  if (!user) {
    return res.status(404).json({ message: "Usuário não encontrado!" });
  }

  const { id } = req.params;

  if (!id) {
    return res.status(400).json({ message: "ID da sala é obrigatório." });
  }

  try {
    const room = await RoomModel.findById(id)
      .populate("owner", "username")
      .populate("participants", "username");
    if (!room) {
      return res.status(404).json({ message: "Sala não encontrada." });
    }

    const isParticipant = room.participants.some(
      (participant: any) => (participant._id ?? participant).toString() === user.id
    );
    if (!isParticipant) {
      return res
        .status(403)
        .json({ message: "Você não tem permissão para ver esta sala." });
    }

    return res.status(200).json(room);
  } catch (error) {
    return res.status(500).json({ message: "Erro ao buscar sala." });
  }
};

//TODO: only edits room name and privacy, still need to implement adding/removing participants.
export const editRoom = async (req: Request, res: Response) => {
  const user = await getUserByToken(req);
  if (!user) {
    return res.status(404).json({ message: "Usuário não encontrado!" });
  }

  const { id } = req.params;
  const { name, isPrivate } = req.body;

  if (!id) {
    return res.status(400).json({ message: "ID da sala é obrigatório." });
  }

  try {
    const room = await RoomModel.findById(id);
    if (!room) {
      return res.status(404).json({ message: "Sala não encontrada." });
    }

    if (room.owner.toString() !== user.id) {
      return res
        .status(403)
        .json({ message: "Você não tem permissão para editar esta sala." });
    }

    if (name && typeof name === "string" && name.trim() !== "") {
      room.name = name;
    }
    if (typeof isPrivate === "boolean") {
      room.isPrivate = isPrivate;
    }

    await room.save();
    return res.status(200).json({ message: "Sala editada com sucesso!", room });
  } catch (error) {
    return res.status(500).json({ message: "Erro ao editar sala." });
  }
};

export const deleteRoom = async (req: Request, res: Response) => {
  const user = await getUserByToken(req);
  if (!user) {
    return res.status(404).json({ message: "Usuário não encontrado!" });
  }

  const { id } = req.params;

  if (!id) {
    return res.status(400).json({ message: "ID da sala é obrigatório." });
  }

  try {
    const room = await RoomModel.findById(id);
    if (!room) {
      return res.status(404).json({ message: "Sala não encontrada." });
    }

    if (user.role === "user" && room.owner.toString() !== user.id) {
      return res
        .status(403)
        .json({ message: "Você não tem permissão para deletar esta sala." });
    }

    await room.deleteOne();
    // Cascade: drop the room's chat history and shared canvas (DB + in-memory)
    // so deleting a room doesn't leave orphaned data behind.
    await Promise.all([
      MessageModel.deleteMany({ roomId: id }),
      deleteRoomDrawing(id),
      evictGarticGame(id),
    ]);
    return res.status(200).json({ message: "Sala deletada com sucesso!" });
  } catch (error) {
    return res.status(500).json({ message: "Erro ao deletar sala." });
  }
};

export const joinRoom = async (req: Request, res: Response) => {
  const user = await getUserByToken(req);
  if (!user) {
    return res.status(404).json({ message: "Usuário não encontrado!" });
  }

  const { id } = req.params;

  if (!id) {
    return res.status(400).json({ message: "ID da sala é obrigatório." });
  }

  try {
    const room = await RoomModel.findById(id);
    if (!room) {
      return res.status(404).json({ message: "Sala não encontrada." });
    }

    if (room.participants.includes(user._id)) {
      return res.status(400).json({ message: "Você já está nesta sala." });
    }

    room.participants.push(user._id);
    await room.save();

    return res
      .status(200)
      .json({ message: "Você entrou na sala com sucesso!", room });
  } catch (error) {
    return res.status(500).json({ message: "Erro ao entrar na sala." });
  }
};

export const leaveRoom = async (req: Request, res: Response) => {
  const user = await getUserByToken(req);
  if (!user) {
    return res.status(404).json({ message: "Usuário não encontrado!" });
  }

  const { id } = req.params;

  if (!id) {
    return res.status(400).json({ message: "ID da sala é obrigatório." });
  }

  try {
    const room = await RoomModel.findById(id);
    if (!room) {
      return res.status(404).json({ message: "Sala não encontrada." });
    }

    if (!room.participants.includes(user._id)) {
      return res.status(400).json({ message: "Você não está nesta sala." });
    }

    room.participants = room.participants.filter(
      (participant) => participant.toString() !== user.id
    );
    await room.save();

    emitSystemMessage(id, user.username, "saiu");

    return res.status(200).json({ message: "Você saiu da sala:", room });
  } catch (error) {
    return res.status(500).json({ message: "Erro ao sair da sala." });
  }
};

// Receives a single board image (validated/stored by the upload middleware) and
// returns the path the client should store in an 'image' shape. The path is
// relative (`/uploads/<roomId>/<file>`); the client resolves it against the API
// base URL. The room's images are removed when the room is deleted.
export const uploadRoomImage = (req: Request, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ message: "Nenhuma imagem válida enviada." });
  }
  const url = `/uploads/${req.params.id}/${req.file.filename}`;
  return res.status(201).json({ url });
};

//Removes a participant from a room. Only the room owner can do this.
export const removeParticipant = async (req: Request, res: Response) => {
  const user = await getUserByToken(req);

  if (!user) {
    return res.status(404).json({ message: "Usuário não encontrado!" });
  }

  const { id: roomId } = req.params;
  const { userId } = req.body;

  if (!roomId || !userId) {
    return res
      .status(400)
      .json({ message: "Sala e participante são obrigatórios." });
  }

  try {
    const room = await RoomModel.findById(roomId);
    if (!room) {
      return res.status(404).json({ message: "Sala não encontrada." });
    }

    if (room.owner.toString() !== user.id) {
      return res
        .status(403)
        .json({ message: "Apenas o dono da sala pode remover participantes." });
    }

    if (room.owner.toString() === userId) {
      return res
        .status(400)
        .json({ message: "Dono da sala não pode ser removido." });
    }

    room.participants = room.participants.filter(
      (participant) => participant.toString() !== userId
    );
    await room.save();

    // Notify clients in the room so the removed user is kicked out live
    try {
      getIO().to(roomId).emit("participant_removed", { roomId, userId });
      const removedUser = await UserModel.findById(userId);
      emitSystemMessage(roomId, removedUser?.username ?? "Usuário", "removido");
    } catch {
      // Socket layer unavailable; removal still succeeded
    }

    return res
      .status(200)
      .json({ message: "Participante removido com sucesso.", id: userId });
  } catch (error) {
    return res.status(500).json({ message: "Erro ao remover participante." });
  }
};
