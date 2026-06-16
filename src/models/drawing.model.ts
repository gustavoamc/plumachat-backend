import mongoose, { Schema, Document } from "mongoose";
import { DrawShape } from "../../shared/types/drawing";

// One document per room holding the persisted snapshot of its canvas shapes.
// The socket layer keeps the authoritative in-memory state and writes this
// snapshot back (debounced) so the board survives server restarts.
export interface DrawingDocument extends Document {
  roomId: mongoose.Types.ObjectId;
  shapes: DrawShape[];
}

// Shapes are a discriminated union with type-specific fields. Rather than model
// every variant, the subdocument schema declares the common fields and runs in
// `strict: false` mode so the type-specific fields (points, width, radiusX, src,
// text, …) persist as-is. Input is already validated/clamped in the socket layer
// (`sanitizeShape`), so the DB just stores the clean objects.
const ShapeSchema = new Schema(
  {
    id: { type: String, required: true },
    type: { type: String },
    x: { type: Number, default: 0 },
    y: { type: Number, default: 0 },
    rotation: { type: Number, default: 0 },
  },
  { _id: false, strict: false }
);

const DrawingSchema = new Schema<DrawingDocument>(
  {
    roomId: { type: Schema.Types.ObjectId, ref: "Room", required: true, unique: true },
    shapes: { type: [ShapeSchema], default: [] },
  },
  { timestamps: true }
);

export const DrawingModel = mongoose.model<DrawingDocument>("Drawing", DrawingSchema);
