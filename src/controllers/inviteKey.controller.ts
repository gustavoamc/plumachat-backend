import { Request, Response } from "express";
import crypto from "crypto";
import { getUserByToken } from "../helpers/getUserByToken";
import { InviteKeyModel } from "../models/inviteKey.model";

// Default lifetime (in days) of a generated invite key when no expiry is given.
const DEFAULT_EXPIRY_DAYS = 30;
// Max keys an admin can mint in a single request, to avoid runaway batches.
const MAX_BATCH = 50;

/**
 * Generates a random, non-guessable invite code.
 * Uses crypto.randomBytes (not sequential/predictable) so brute force is unfeasible.
 * @returns {string} An uppercase, URL-safe code (e.g. "A1B2-C3D4-E5F6").
 */
function generateCode(): string {
  // 9 bytes -> 18 hex chars, grouped for readability.
  const raw = crypto.randomBytes(9).toString("hex").toUpperCase();
  return `${raw.slice(0, 6)}-${raw.slice(6, 12)}-${raw.slice(12, 18)}`;
}

/**
 * Creates one or more invite keys.
 * @route POST /invite
 * @param {Request} req - Express request; body may contain { amount, expiresInDays, note }
 * @param {Response} res - Express response object
 * @returns {Object} The created invite key(s)
 * @throws {Error} Returns 400 for validation errors, 500 for server errors
 */
export const createInviteKeys = async (req: Request, res: Response) => {
  try {
    const reqUser = await getUserByToken(req);
    if (!reqUser) {
      return res.status(404).json({ message: "Usuário/Token não encontrado." });
    }

    const { amount, expiresInDays, note } = req.body;

    const count = Number.isInteger(amount) && amount > 0 ? amount : 1;
    if (count > MAX_BATCH) {
      return res
        .status(400)
        .json({ message: `Máximo de ${MAX_BATCH} chaves por requisição.` });
    }

    const days =
      Number.isFinite(expiresInDays) && expiresInDays > 0
        ? expiresInDays
        : DEFAULT_EXPIRY_DAYS;
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    const docs = Array.from({ length: count }, () => ({
      code: generateCode(),
      expiresAt,
      createdBy: reqUser.id,
      note: typeof note === "string" ? note : undefined,
    }));

    const keys = await InviteKeyModel.insertMany(docs);

    return res.status(201).json({
      message:
        count === 1
          ? "Chave de convite criada com sucesso."
          : `${count} chaves de convite criadas com sucesso.`,
      keys,
    });
  } catch (err) {
    return res
      .status(500)
      .json({ message: "Erro ao criar chave(s) de convite.", error: err });
  }
};

/**
 * Lists invite keys, optionally filtered by usage status.
 * @route GET /invite
 * @param {Request} req - Express request; query param "used" ("true"/"false")
 * @param {Response} res - Express response object
 * @returns {Object[]} Array of invite keys (most recent first)
 * @throws {Error} Returns 500 for server errors
 */
export const getInviteKeys = async (req: Request, res: Response) => {
  try {
    const reqUser = await getUserByToken(req);
    if (!reqUser) {
      return res.status(404).json({ message: "Usuário/Token não encontrado." });
    }

    const { used } = req.query;
    const filter: any = {};
    if (typeof used !== "undefined") {
      filter.used = used === "true";
    }

    const keys = await InviteKeyModel.find(filter)
      .sort({ createdAt: -1 })
      .populate("usedBy", "username email")
      .populate("createdBy", "username email");

    return res.status(200).json(keys);
  } catch (err) {
    return res
      .status(500)
      .json({ message: "Erro ao buscar chaves de convite.", error: err });
  }
};

/**
 * Deletes an unused invite key. Used keys are kept for auditing.
 * @route DELETE /invite/:keyId
 * @param {Request} req - Express request with the key id in params
 * @param {Response} res - Express response object
 * @returns {Object} Status message
 * @throws {Error} Returns 400/404 for validation errors, 500 for server errors
 */
export const deleteInviteKey = async (req: Request, res: Response) => {
  try {
    const reqUser = await getUserByToken(req);
    if (!reqUser) {
      return res.status(404).json({ message: "Usuário/Token não encontrado." });
    }

    const { keyId } = req.params;
    const key = await InviteKeyModel.findById(keyId);

    if (!key) {
      return res.status(404).json({ message: "Chave não encontrada." });
    }

    if (key.used) {
      return res
        .status(400)
        .json({ message: "Chaves já utilizadas não podem ser removidas." });
    }

    await key.deleteOne();

    return res.status(200).json({ message: "Chave removida com sucesso." });
  } catch (err) {
    return res
      .status(500)
      .json({ message: "Erro ao remover chave de convite.", error: err });
  }
};
