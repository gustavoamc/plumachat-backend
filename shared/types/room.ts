import { Types } from "mongoose";

export interface Room {
  _id: string;
  name: string;
  isPrivate: boolean;
  owner: Types.ObjectId;
  participants: Types.ObjectId[]; // ou string[], se preferir serialização
  // Beta: when true, only the room owner may draw on the shared canvas. Off by default.
  drawingOwnerOnly: boolean;
  // Owner-defined logical size of the shared canvas, in pixels. Shared by all
  // clients; smaller screens scroll the board rather than rescaling it.
  canvasWidth: number;
  canvasHeight: number;
  createdAt: string | Date;
  updatedAt?: string | Date;
}
