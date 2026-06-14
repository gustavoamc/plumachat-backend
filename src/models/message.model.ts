import mongoose, { Document, Schema } from "mongoose";
import { Message } from "../../shared/types/message";

export interface MessageDocument extends Omit<Message, "_id" | "timestamp">, Document {}

const MessageSchema = new Schema<MessageDocument>(
  {
    userId:   { type: Schema.Types.ObjectId, ref: "User", required: true },
    roomId:   { type: Schema.Types.ObjectId, ref: "Room", required: true },
    content:  { type: String, required: true },
  },
  { timestamps: { createdAt: "timestamp" } }
);

export const MessageModel = mongoose.model<MessageDocument>("Message", MessageSchema);
