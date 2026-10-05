import { Request, Response } from "express";
import { getUserByToken } from "../helpers/getUserByToken";
import { UserModel } from "../models/user.model";

/**
 * Promotes a user to admin role by a root user
 * @param {Request} req - Express request object containing the user ID to promote
 * @param {Response} res - Express response object for sending back the result
 * @returns {Promise<void>} Sends a JSON response with the promotion status
 * @throws {Error} Handles potential errors during the promotion process
 */
export const promoteAdmin = async (req: Request, res: Response) => {
    try {
        const { userId } = req.params;
        const rootUser = await getUserByToken(req);

        if (!rootUser || rootUser.role !== "root") {
            return res.status(403).json({ message: "Acesso negado!" });
        }

        const user = await UserModel.findById(userId);

        if (!user) {
            return res.status(404).json({ message: "Usuário não encontrado." });
        }

        if (user.role === "admin") {
            return res.status(400).json({ message: "Usuário já é um administrador." });
        }

        user.role = "admin";
        await user.save();

        return res.status(200).json({ message: "Usuário promovido a administrador." });
    } catch (err) {
        return res.status(500).json({ message: "Erro ao promover o usuário." });
    }
}

/**
 * Demotes an admin user to a regular user role by a root user
 * @param {Request} req - Express request object containing the user ID to demote
 * @param {Response} res - Express response object for sending back the result
 * @returns {Promise<void>} Sends a JSON response with the demotion status
 * @throws {Error} Handles potential errors during the demotion process
 */
export const demoteAdmin = async (req: Request, res: Response) => {
    try {
        const { userId } = req.params;
        const rootUser = await getUserByToken(req);

        if (!rootUser || rootUser.role !== "root") {
            return res.status(403).json({ message: "Acesso negado!" });
        }

        const user = await UserModel.findById(userId);

        if (!user) {
            return res.status(404).json({ message: "Usuário não encontrado." });
        }

        if (user.role !== "admin") {
            return res.status(400).json({ message: "Usuário não é um administrador." });
        }

        user.role = "user";
        await user.save();

        return res.status(200).json({ message: "Usuário rebaixado de administrador." });
    } catch (err) {
        return res.status(500).json({ message: "Erro ao rebaixar o usuário." });
    }
}

/**
 * Bans a user by setting their banned status and related details
 * 
 * @param {Request} req - The HTTP request object containing user ID and ban details
 * @param {Response} res - The HTTP response object for sending back the result
 * @returns {Response} A JSON response indicating the success or failure of the ban operation
 * 
 * @throws {Error} Throws an error if there are issues during the banning process
 * 
 * @description
 * - Validates the requesting user's permissions
 * - Prevents banning root users or users with the same role
 * - Sets user's banned status, reason, and ban duration
 */
export const banUser = async (req: Request, res: Response) => {
    try {
        const { userId } = req.params;
        const reqUser = await getUserByToken(req); 
        const { banReason, banUntil } = req.body;

        const userToBan = await UserModel.findById(userId);

        if (!userToBan) {
            return res.status(404).json({ message: "Usuário não encontrado." });
        }

        // stops user from banning root, itself or same role.
        if (userToBan.role === "root" || (userToBan.role === reqUser?.role)) {
            return res.status(400).json({ message: "Não foi possível banir esse usuário." });
        }

        console.log(banReason, banUntil);
        userToBan.isBanned = true;
        userToBan.banReason = banReason;
        userToBan.banUntil = banUntil;

        await userToBan.save();

        return res.status(200).json({ message: "Usuário banido com sucesso." });

    } catch (error) {
        return res.status(500).json({ message: "Erro ao banir o usuário." });
    }
}

/**
 * Unbans a user by resetting their banned status and related details
 * 
 * @param {Request} req - The HTTP request object containing user ID
 * @param {Response} res - The HTTP response object for sending back the result
 * @returns {Response} A JSON response indicating the success or failure of the unban operation
 * 
 * @throws {Error} Throws an error if there are issues during the unbanning process
 * 
 * @description
 * - Validates the requesting user's permissions
 * - Prevents unbanning users with the same role
 * - Checks if the user is currently banned
 * - Resets user's banned status, reason, and ban duration
 */
export const unbanUser = async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const reqUser = await getUserByToken(req);

    const userToUnban = await UserModel.findById(userId);

    if (!userToUnban) {
      return res.status(404).json({ message: "Usuário não encontrado." });
    }

    // stops user from unbanning itself or same role.
    if (userToUnban.role === reqUser?.role) {
      return res.status(400).json({ message: "Não foi possível desbanir esse usuário." });
    }

    if (!userToUnban.isBanned) {
      return res.status(400).json({ message: "Esse usuário não está banido." });
    }

    userToUnban.isBanned = false;
    userToUnban.banReason = "";
    userToUnban.banUntil = "";

    await userToUnban.save();

    return res.status(200).json({ message: "Usuário desbanido com sucesso." });

  } catch (error) {
    return res.status(500).json({ message: "Erro ao desbanir o usuário." });
  }
};

/**
 * Retrieves all standard users from the database
 * 
 * @param {Request} req - The HTTP request object
 * @param {Response} res - The HTTP response object for sending back the result
 * @returns {Response} A JSON response containing an array of standard users or an error message
 * 
 * @throws {Error} Throws an error if there are issues retrieving standard users
 * 
 * @description
 * - Validates the requesting user's authentication
 * - Fetches all users with role set to "user"
 * - Returns the list of standard users or an error status
 */
export const getAllUsers = async (req: Request, res: Response) => {
    try {
        const { role, isBanned } = req.query;
        const reqUser = await getUserByToken(req);

        if (!reqUser) {
            return res.status(404).json({ message: "Acesso negado!" });
        }

        const filter: any = {
            role: { $ne: "root" }// to not include root in the list
        };

        if (role && typeof role === "string") {
            filter.role = { 
                $in: role.split(','), //"user,admin" -> ['user','admin'] - (if 'root' is sent, a error will be thrown)
                $nin: 'root'
            };
        }

        if (typeof isBanned !== "undefined") {
            filter.isBanned = isBanned === "true";// query string comes as string
        }

        const users = await UserModel.find(filter);

        return res.status(200).json(users);
    } catch (error) {
        return res.status(500).json({ message: "Erro ao buscar usuários." });
    }
}

//TODO: website and system "patch notes" routes