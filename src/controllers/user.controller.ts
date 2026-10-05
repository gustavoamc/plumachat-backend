import { Request, Response } from "express";
import { getUserByToken } from "../helpers/getUserByToken";
import { UserModel } from "../models/user.model";
import bcrypt from "bcryptjs";
import verifyToken from "../helpers/verifyToken";

/**
 * Edit user profile information
 * @route PATCH /user/edit
 * @param {Request} req - Express request object containing user update details
 * @param {Response} res - Express response object
 * @returns {Object} Updated user profile or error message
 * @description Updates user profile with new username and email after token authentication
 */
export const editUser = async (req: Request, res: Response) => {
  const user = await getUserByToken(req); // get user from token, because "body" is the new user data

  if (!user) {
    return res.status(404).json({ message: "Usuário não encontrado!" });
  }

  const { username, email } = req.body;

  // Validate input fields
  if (!username || !email)
    return res.status(400).json({ message: "Todos os campos são obrigatórios." });

  if (user.email !== email) {
    const userExists = await UserModel.findOne({
      email,
      _id: { $ne: user._id },
    });
    if (userExists)
      return res.status(400).json({ message: "Email já em uso." });
  }

  if (user.username !== username) {
    const userExists = await UserModel.findOne({
      username,
      _id: { $ne: user._id },
    });
    if (userExists)
      return res.status(400).json({ message: "username já em uso." });
  }
  //TODO When mailer is ready move email to it's own route, for validation

  try {
    user.set({ username, email });
    await user.save();
    return res.status(200).json({ message: "Dados atualizados!" });
  } catch (error) {
    return res.status(500).json({ message: "Erro ao atualizar dados!" });
  }
};

//TODO Rename to "getOwnInfo", find a use for this function (add friend ?, in-room use ?), it retrives only own user data
/**
 * Retrieve user information in a secure manner
 * @route GET /user/
 * @param {Request} req - Express request object containing authentication token
 * @param {Response} res - Express response object
 * @returns {Object} User profile details including id, username, email, and role
 * @description Fetches authenticated user's profile information after token validation
 */
export const getUser = async (req: Request, res: Response) => {
  const user = await getUserByToken(req);
  if (!user) {
    return res.status(404).json({ message: "Usuário não encontrado!" });
  }

  const objUser = user.toObject();

  return res.status(200).json({
    user: {
      id: objUser._id,
      username: objUser.username,
      email: objUser.email,
      role: objUser.role,
    },
  });
};

/**
 * Change user's password after verifying current password
 * @route POST /user/change-password
 * @param {Request} req - Express request object containing authentication token and password details
 * @param {Response} res - Express response object
 * @returns {Object} Success or error message after password change attempt
 * @description Allows authenticated user to change their password by providing current and new password
 * Validates password length and uses different salt rounds based on user role
 */
export const changePassword = async (req: Request, res: Response) => {
  const decodedPayload = verifyToken(req);
  const { currentPassword, newPassword } = req.body;

  if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
    return res.status(400).json({ message: "Todos os campos são obrigatórios." });
  }

  try {
    const user = await UserModel.findById(decodedPayload?.id).select(
      "+password"
    );
    if (!user)
      return res.status(404).json({ message: "Usuário não encontrado" });

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    // 400, not 401: the client treats 401 as an expired session and logs out.
    if (!isMatch)
      return res.status(400).json({ message: "Senha atual incorreta" });

    // maintains password minnimum length
    if (newPassword.length < 8) {
      return res
        .status(400)
        .json({ message: "A nova senha deve ter pelo menos 8 caracteres" });
    }

    //if role isn't "user", use 12 as salt rounds
    user.password = await bcrypt.hash(
      newPassword,
      user.role === "user" ? 10 : 12
    );
    await user.save();

    return res.status(200).json({ message: "Senha alterada com sucesso" });
  } catch (error) {
    return res.status(500).json({ message: "Erro ao trocar senha", error });
  }
};

//TODO create delete user route (soft delete is still in question, but limit it to 30 days, like {softDelete: true, softDeleteTimeInDays: 30})