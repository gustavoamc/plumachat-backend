import { Types } from "mongoose";

export interface Log {
  _id: string;
  userId: Types.ObjectId;
  action: string;
  ip: string;
  createdAt: string | Date;
  updatedAt?: string | Date;
}
