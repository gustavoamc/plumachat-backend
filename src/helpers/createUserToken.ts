import jwt from "jsonwebtoken";
import { Role } from "../../shared/types/user";

export const createUserToken = async (
  id: string,
  role: Role
): Promise<string> => {
  const token = jwt.sign({ 
      id: id,
      role: role
    },
    process.env.JWT_SECRET as string,
    { expiresIn: "7d" }
  );

  return token;
};
