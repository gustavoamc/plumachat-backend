import { Request, Response, NextFunction } from "express";
import { getUserByToken } from "../helpers/getUserByToken";
import { isBanActive } from "../helpers/banStatus";

/**
 * Middleware to check user status and authorization
 * @param allowedRoles Array of roles permitted to access the route
 * @returns Express middleware function that validates user token, ban status, and role
 * @throws {401} If no token or invalid token is provided
 * @throws {403} If user is banned or lacks required role permissions
 * @throws {404} If user is not found
 */
export function checkStatus(allowedRoles: ("user" | "admin" | "root")[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {

      const user = await getUserByToken(req);

      if (!user) {
        return res.status(404).json({ message: "Usuário/Token não encontrado." });
      }

    //TODO Attach user to request - for future use - pass user to other middlewares and controllers so as to not query the database again
    //   req.user = user as unknown as User; //OR body.user = user;

      // Verify ban status
      if (await isBanActive(user)) {
        return res.status(403).json({ message: "Usuário banido. Motivo: " + user.banReason });
      }

      // Verify role
      if (!allowedRoles.includes(user.role)) {
        return res.status(403).json({ message: "Acesso negado." });
      }

      next();
    } catch (error: any) {
      if (error.name === "TokenExpiredError"){
        return res.status(401).json({message: "Token expirado."})
      }
      return res.status(401).json({ message: "Token inválido." });
    }
  };
}
