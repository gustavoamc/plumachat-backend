import { Types } from "mongoose";

export interface InviteKey {
  _id: string;
  // Random, non-guessable code redeemed during registration.
  code: string;
  used: boolean;
  usedBy?: Types.ObjectId | null;
  usedAt?: string | Date | null;
  // After this moment the key can no longer be redeemed.
  expiresAt: string | Date;
  // Admin/root user who generated the key.
  createdBy: Types.ObjectId;
  // Optional free-text label so admins can track what a key was meant for.
  note?: string;
  createdAt: string | Date;
  updatedAt?: string | Date;
}
