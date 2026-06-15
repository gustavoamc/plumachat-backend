import { Types } from "mongoose";

export interface Message {
  _id: string;
  userId?: Types.ObjectId; // absent for system messages
  roomId: Types.ObjectId;
  content: string;
  system?: boolean;
  timestamp: string;
}
