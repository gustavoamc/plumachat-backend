import mongoose, { Schema, Document } from "mongoose";
import { DrawShape } from "../../shared/types/drawing";

// One document per room holding the persisted snapshot of its canvas strokes.
// The socket layer keeps the authoritative in-memory state and writes this
// snapshot back (debounced) so the board survives server restarts.
export interface DrawingDocument extends Document {
  roomId: mongoose.Types.ObjectId;
  shapes: DrawShape[];
}

const ShapeSchema = new Schema<DrawShape>(
  {
    id: { type: String, required: true },
    points: { type: [Number], default: [] },
    x: { type: Number, default: 0 },
    y: { type: Number, default: 0 },
    stroke: { type: String, default: "#000000" },
    strokeWidth: { type: Number, default: 3 },
  },
  { _id: false }
);

const DrawingSchema = new Schema<DrawingDocument>(
  {
    roomId: { type: Schema.Types.ObjectId, ref: "Room", required: true, unique: true },
    shapes: { type: [ShapeSchema], default: [] },
  },
  { timestamps: true }
);

export const DrawingModel = mongoose.model<DrawingDocument>("Drawing", DrawingSchema);
