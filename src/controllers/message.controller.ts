import { Request, Response } from "express";
import { getUserByToken } from "../helpers/getUserByToken";
import { RoomModel } from "../models/room.model";
import { MessageModel } from "../models/message.model";

// GET /room/:id/messages?limit=50&before=<ISO timestamp>
export const getRoomMessages = async (req: Request, res: Response) => {
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

    const isParticipant = room.participants.some(
      (participant) => participant.toString() === user.id
    );
    if (!isParticipant) {
      return res
        .status(403)
        .json({ message: "Você não tem permissão para ver esta sala." });
    }

    const limitParam = parseInt(req.query.limit as string, 10);
    const limit = Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(limitParam, 100)
      : 50;

    const query: any = { roomId: id };
    if (req.query.before) {
      query.timestamp = { $lt: new Date(req.query.before as string) };
    }

    const messages = await MessageModel.find(query)
      .sort({ timestamp: -1 })
      .limit(limit)
      .populate("userId", "username");

    return res.status(200).json(messages.reverse());
  } catch (error) {
    return res.status(500).json({ message: "Erro ao buscar mensagens." });
  }
};
