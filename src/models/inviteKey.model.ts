import mongoose, { Schema, Document } from "mongoose";
import { InviteKey } from "../../shared/types/inviteKey";

export interface InviteKeyDocument
  extends Omit<InviteKey, "_id" | "createdAt">,
    Document {}

const InviteKeySchema = new Schema<InviteKeyDocument>(
  {
    code: { type: String, required: true, unique: true },
    used: { type: Boolean, required: true, default: false },
    usedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    usedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    note: { type: String },
  },
  { timestamps: true }
);

export const InviteKeyModel = mongoose.model<InviteKeyDocument>(
  "InviteKey",
  InviteKeySchema
);
