import { Types } from "mongoose";

// What a room *is* — its static ruleset, fixed at creation. "default" is the
// classic chat-with-canvas room; "draw_guess" is the Gartic-style game mode.
// Future modes (e.g. a Stop/Stopots-style room) get added here.
export type RoomType = "default" | "draw_guess";

export interface Room {
  _id: string;
  name: string;
  isPrivate: boolean;
  // Static room ruleset. Set at creation, immutable afterwards.
  roomType: RoomType;
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
