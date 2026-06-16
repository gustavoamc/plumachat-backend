import { Request, Response, NextFunction } from "express";
import { promises as fsp } from "fs";
import crypto from "crypto";
import multer from "multer";
import { getUserByToken } from "../helpers/getUserByToken";
import { RoomModel } from "../models/room.model";
import {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  roomUploadDir,
} from "../config/uploads";

// Gate uploads the same way the socket layer gates drawing: the user must be a
// participant of the room, and if the board is in owner-only mode, only the
// owner may upload. Runs before multer so we never write a file we'd reject.
export async function canUploadToRoom(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await getUserByToken(req);
    if (!user) return res.status(404).json({ message: "Usuário não encontrado!" });

    const room = await RoomModel.findById(req.params.id);
    if (!room) return res.status(404).json({ message: "Sala não encontrada." });

    const isParticipant = room.participants.some(
      (p) => p.toString() === user.id
    );
    if (!isParticipant) {
      return res.status(403).json({ message: "Você não está nesta sala." });
    }
    if (room.drawingOwnerOnly && room.owner.toString() !== user.id) {
      return res.status(403).json({ message: "Apenas o dono pode desenhar nesta sala." });
    }
    next();
  } catch (err) {
    return res.status(401).json({ message: "Token inválido." });
  }
}

// Per-room disk storage: uploads/<roomId>/<random>.<ext>. A random filename
// avoids collisions and makes URLs hard to guess.
const storage = multer.diskStorage({
  destination: async (req, _file, cb) => {
    try {
      const dir = roomUploadDir(req.params.id);
      await fsp.mkdir(dir, { recursive: true });
      cb(null, dir);
    } catch (err) {
      cb(err as Error, "");
    }
  },
  filename: (_req, file, cb) => {
    const ext = ALLOWED_IMAGE_TYPES[file.mimetype] ?? "";
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`);
  },
});

const single = multer({
  storage,
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
  // Only accept the image MIME types we can serve; others are silently dropped
  // (req.file ends up undefined and the controller returns 400).
  fileFilter: (_req, file, cb) => cb(null, !!ALLOWED_IMAGE_TYPES[file.mimetype]),
}).single("image");

// Wraps multer so size/upload errors become clean 400/500 JSON responses.
export function uploadImage(req: Request, res: Response, next: NextFunction) {
  single(req, res, (err: any) => {
    if (err instanceof multer.MulterError) {
      const message =
        err.code === "LIMIT_FILE_SIZE"
          ? "Imagem muito grande (máx. 5MB)."
          : "Falha no upload da imagem.";
      return res.status(400).json({ message });
    }
    if (err) {
      return res.status(500).json({ message: "Erro ao enviar imagem." });
    }
    next();
  });
}
