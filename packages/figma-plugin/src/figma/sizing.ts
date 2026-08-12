import type { BridgeNode } from "@pen-fig/bridge-schema";

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

export function mustPreserveHugFallback(
  source: BridgeNode,
  axis: LayoutAxis,
  documentRootBridgeId?: string,
): boolean {
  const sizing = axis === "horizontal" ? source.width : source.height;
  if (
    sizing.mode !== "hug" ||
    sizing.fallback === undefined ||
    sizing.fallback <= 0
  )
    return false;
  if (source.source.app === "pen" && sizing.resolved === true) return true;
  if (!source.layout || source.layout.mode === "none") return false;
  // A top-level Pencil page can omit its authored height and let Pencil's
  // layout engine resolve the canvas size. The service records that resolved
  // size as the hug fallback. Letting Figma recompute the root as HUG can
  // produce a different height when fonts or nested layout metrics differ,
  // so keep the resolved screen bounds fixed while retaining the authored
  // hug identity in plugin data for round trips.
  if (
    source.source.app === "pen" &&
    source.bridgeId === documentRootBridgeId
  )
    return true;
  return source.children.some((child) => {
    if (child.layoutPosition === "absolute") return false;
    const childSizing = axis === "horizontal" ? child.width : child.height;
    return childSizing.mode === "fill";
  });
}
