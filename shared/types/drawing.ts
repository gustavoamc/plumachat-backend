// Shapes on the shared room canvas. Every shape is a discriminated union member
// keyed by `type`. Common to all: `id`, the drag offset `x`/`y`, and an optional
// `rotation` (degrees). Coordinates are in the board's logical pixel space.
//
// Back-compat: the original board only stored freehand strokes with no `type`
// field. A persisted shape with no `type` is treated as a `'line'`.

export interface BaseShape {
  id: string;
  x: number;
  y: number;
  rotation?: number;
}

// Freehand stroke. `points` are flat [x0,y0,x1,y1,...] pairs.
export interface LineShape extends BaseShape {
  type: "line";
  points: number[];
  stroke: string;
  strokeWidth: number;
}

export interface RectShape extends BaseShape {
  type: "rect";
  width: number;
  height: number;
  stroke: string;
  strokeWidth: number;
  fill?: string;
}

export interface EllipseShape extends BaseShape {
  type: "ellipse";
  radiusX: number;
  radiusY: number;
  stroke: string;
  strokeWidth: number;
  fill?: string;
}

// Straight line / arrow. `points` are [x1,y1,x2,y2] relative to `x`/`y`.
export interface ArrowShape extends BaseShape {
  type: "arrow";
  points: number[];
  stroke: string;
  strokeWidth: number;
  arrow: boolean; // draw an arrowhead at the end point
}

export interface TextShape extends BaseShape {
  type: "text";
  text: string;
  fontSize: number;
  fill: string;
  width?: number; // wrap width; undefined = auto
}

// A placed image. `src` is a path we issued (`/uploads/<roomId>/<file>`), never a
// data URL — the snapshot stays small and the bytes live on disk.
export interface ImageShape extends BaseShape {
  type: "image";
  src: string;
  width: number;
  height: number;
}

export type DrawShape =
  | LineShape
  | RectShape
  | EllipseShape
  | ArrowShape
  | TextShape
  | ImageShape;

export type ShapeType = DrawShape["type"];
