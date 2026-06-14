// A single freehand stroke on the shared room canvas.
// `points` are flat [x0, y0, x1, y1, ...] pairs in the board's logical coordinate
// space; `x`/`y` are the stroke's drag offset (0,0 until it is moved).
export interface DrawShape {
  id: string;
  points: number[];
  x: number;
  y: number;
  stroke: string;
  strokeWidth: number;
}
