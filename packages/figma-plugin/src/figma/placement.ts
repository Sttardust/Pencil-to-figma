export interface CanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasPoint {
  x: number;
  y: number;
}

export function findCleanRightSidePosition(
  width: number,
  height: number,
  occupied: CanvasRect[],
  viewportCenter: CanvasPoint,
  gap = 120,
  preferredTop?: number,
): CanvasPoint {
  const y = preferredTop ?? viewportCenter.y - height / 2;
  if (!occupied.length)
    return {
      x: viewportCenter.x - width / 2,
      y,
    };
  return {
    x: Math.max(...occupied.map((bounds) => bounds.x + bounds.width)) + gap,
    y,
  };
}
