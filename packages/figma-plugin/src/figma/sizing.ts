export type LayoutAxis = "horizontal" | "vertical";

export interface AutoLayoutSiblingBounds {
  width: number;
  height: number;
}

export interface AutoLayoutFillContext {
  layoutMode: "HORIZONTAL" | "VERTICAL";
  width: number;
  height: number;
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
  itemSpacing: number;
  flowSiblings: AutoLayoutSiblingBounds[];
}

/**
 * Gives a fill-sized node a useful concrete size before Figma performs its
 * auto-layout pass. This is especially important for fixed-width text: if it
 * starts at 1px wide, Figma can calculate an enormous text height and retain a
 * bad vertical position even after the width changes to FILL.
 */
export function autoLayoutFillFallback(
  axis: LayoutAxis,
  context: AutoLayoutFillContext,
): number {
  const parentPrimaryAxis =
    context.layoutMode === "HORIZONTAL" ? "horizontal" : "vertical";
  const innerSize =
    axis === "horizontal"
      ? context.width - context.paddingLeft - context.paddingRight
      : context.height - context.paddingTop - context.paddingBottom;

  if (axis !== parentPrimaryAxis) return Math.max(1, innerSize);

  const occupied = context.flowSiblings.reduce(
    (total, sibling) =>
      total + (axis === "horizontal" ? sibling.width : sibling.height),
    0,
  );
  const gaps = context.flowSiblings.length * context.itemSpacing;
  return Math.max(1, innerSize - occupied - gaps);
}
