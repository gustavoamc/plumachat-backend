import mongoose, { Schema, Document } from "mongoose";
import { Room } from "../../shared/types/room";

export interface RoomDocument extends Omit<Room, "_id" | "createdAt">, Document {}

const RoomSchema = new Schema<RoomDocument>(
  {
    name: { type: String, required: true, unique: true },
    isPrivate: { type: Boolean, required: true, default: true },
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    participants: [{ type: Schema.Types.ObjectId, ref: "User" }],
    drawingOwnerOnly: { type: Boolean, required: true, default: false },
    canvasWidth: { type: Number, required: true, default: 1280 },
    canvasHeight: { type: Number, required: true, default: 720 },
  },
  { timestamps: true }
);

export const RoomModel = mongoose.model<RoomDocument>("Room", RoomSchema);
