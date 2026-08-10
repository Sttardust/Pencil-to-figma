import type { BridgeNode } from "@pen-fig/bridge-schema";

/**
 * Older writer builds could leave fill-sized flow content with stale Figma
 * auto-layout measurements when the same parent also contained an absolute
 * background. Rebuilding these roots once is safer than mutating the stale
 * tree in place.
 */
export function needsOverlayLayoutRebuild(root: BridgeNode): boolean {
  const primarySizing = (child: BridgeNode) =>
    root.layout?.mode === "horizontal" ? child.width : child.height;

  return Boolean(
    root.layout &&
    (root.layout.mode === "horizontal" || root.layout.mode === "vertical") &&
    root.children.some((child) => child.layoutPosition === "absolute") &&
    root.children.some(
      (child) =>
        child.layoutPosition !== "absolute" &&
        primarySizing(child).mode === "fill",
    ),
  );
}
