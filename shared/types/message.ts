import { Types } from "mongoose";

export interface Message {
  _id: string;
  userId: Types.ObjectId;
  roomId: Types.ObjectId;
  content: string;
  timestamp: string;
}
