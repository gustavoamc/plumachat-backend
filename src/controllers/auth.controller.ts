import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { UserModel } from "../models/user.model";
import { InviteKeyModel } from "../models/inviteKey.model";
import { createUserToken } from "../helpers/createUserToken";

/**
 * Registers a new user in the system
 * @route POST /api/auth/register
 * @param {Request} req - Express request object containing user registration details
 * @param {Response} res - Express response object
 * @returns {Object} User registration response with token and user details
 * @throws {Error} Returns 400 status for validation errors, 500 for server errors
 */
export const registerUser = async (req: Request, res: Response) => {
  try {
    const { username, email, password, inviteCode } = req.body;

    if (!username || !email || !password || !inviteCode)
      return res
        .status(400)
        .json({ message: "Todos os campos são obrigatórios." });

    const userExists = await UserModel.findOne({ email });
    if (userExists)
      return res.status(400).json({ message: "Email já em uso." });

    if (password.length < 8)
      return res
        .status(400)
        .json({ message: "A senha deve ter no mínimo 8 caracteres." });

    // Atomically claim the invite key: the filter + update run as a single
    // operation, so two concurrent requests with the same code cannot both
    // succeed. A null result means the code is invalid, already used or expired.
    const key = await InviteKeyModel.findOneAndUpdate(
      { code: inviteCode, used: false, expiresAt: { $gt: new Date() } },
      { $set: { used: true, usedAt: new Date() } },
      { new: true }
    );
    if (!key) {
      return res
        .status(400)
        .json({ message: "Chave de convite inválida ou já utilizada." });
    }

    let user;
    try {
      const hashedPassword = await bcrypt.hash(password, 10);
      user = await UserModel.create({
        username,
        email,
        password: hashedPassword,
      });
    } catch (createErr) {
      // The key was burned before the account was created; release it so it
      // can be reused. Small window, easy to close.
      await InviteKeyModel.updateOne(
        { _id: key._id },
        { $set: { used: false, usedAt: null } }
      );
      throw createErr;
    }

    // Record who redeemed the key now that the account exists.
    await InviteKeyModel.updateOne(
      { _id: key._id },
      { $set: { usedBy: user.id } }
    );

    const token = await createUserToken(user.id, user.role);

    return res.status(200).json({
      message: "Conta iniciada com sucesso!",
      token,
      user: {
        _id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    return res.status(500).json({ message: "Erro ao registrar", error: err });
  }
};

/**
 * Authenticates a user by email and password
 * @route POST /api/auth/login
 * @param {Request} req - Express request object containing user login credentials
 * @param {Response} res - Express response object
 * @returns {Object} User login response with token and user details
 * @throws {Error} Returns 400 status for validation errors, 500 for server errors
 */
export const loginUser = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password)
      return res
        .status(400)
        .json({ message: "Todos os campos são obrigatórios." });

    const user = await UserModel.findOne({ email }).select("+password");
    if (!user)
      return res.status(400).json({ message: "Usuário não encontrado." });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: "Senha incorreta." });

    //NOTED BEHAVIOUR
    // console.log(user._id); new ObjectId("683b4408773b84b76fbeeb77") //literal
    // console.log(user.id); 683b4408773b84b76fbeeb77 //mongoose getter for user._id.toString()

    const token = await createUserToken(user.id, user.role);

    res.status(200).json({
      message: "Login efetuado com sucesso!",
      token,
      user: {
        _id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    return res.status(500).json({ message: "Erro ao logar", error: err });
  }
};
