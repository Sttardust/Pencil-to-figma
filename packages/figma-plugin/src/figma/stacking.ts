import type { BridgeNode } from "@pen-fig/bridge-schema";

const SIZE_EPSILON = 0.5;

/**
 * Pencil commonly models edge-to-edge imagery as an absolute child of an
 * auto-layout screen. In Figma, that child must be the bottommost layer so
 * flow content such as the status bar and copy remains visible above it.
 */
export function isFullCoverAbsoluteBackground(
  parent: BridgeNode,
  child: BridgeNode,
): boolean {
  return (
    child.layoutPosition === "absolute" &&
    Math.abs(child.bounds.x) <= SIZE_EPSILON &&
    Math.abs(child.bounds.y) <= SIZE_EPSILON &&
    Math.abs(child.bounds.width - parent.bounds.width) <= SIZE_EPSILON &&
    Math.abs(child.bounds.height - parent.bounds.height) <= SIZE_EPSILON
  );
}

export function bridgeStackOrder(parent: BridgeNode): string[] {
  const backgrounds: string[] = [];
  const foregrounds: string[] = [];

  for (const child of parent.children) {
    (isFullCoverAbsoluteBackground(parent, child)
      ? backgrounds
      : foregrounds
    ).push(child.bridgeId);
  }

  return [...backgrounds, ...foregrounds];
}
