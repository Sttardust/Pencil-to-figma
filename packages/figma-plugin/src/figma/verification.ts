import type { BridgeDocument, BridgeNode, Paint } from "@pen-fig/bridge-schema";
import { bridgeStackOrder } from "./stacking.js";

const GEOMETRY_EPSILON = 0.5;
const PAINT_EPSILON = 1 / 255 + 1e-6;

export function verifyFigmaWriteFidelity(
  source: BridgeDocument,
  actual: BridgeDocument,
): void {
  const actualNodes = collectNodes(actual.root);
  const issues: string[] = [];

  visit(source.root, (expected) => {
    const received = actualNodes.get(expected.bridgeId);
    if (!received) {
      issues.push(`${expected.name}: layer is missing`);
      return;
    }
    if (received.kind !== expected.kind)
      issues.push(
        `${expected.name}: expected ${expected.kind}, received ${received.kind}`,
      );
    if (received.layoutPosition !== expected.layoutPosition)
      issues.push(
        `${expected.name}: expected ${expected.layoutPosition} positioning, received ${received.layoutPosition}`,
      );
    verifyDimensions(expected, received, issues);
    verifyStacking(expected, received, issues);
    verifyGradients(expected, received, issues);
  });

  if (issues.length)
    throw new Error(
      `Figma verification failed: ${issues.slice(0, 4).join("; ")}${issues.length > 4 ? `; and ${issues.length - 4} more` : ""}`,
    );
}

function verifyDimensions(
  expected: BridgeNode,
  actual: BridgeNode,
  issues: string[],
): void {
  // Figma derives the bounds of createNodeFromSvg() wrappers from the SVG's
  // visible vector geometry. Those bounds can be tighter than Pencil's icon
  // box even when the rendered icon is correct (status icons are a common
  // example). The PNG appearance check that follows this structural check is
  // the reliable way to verify SVG size, so do not reject the transfer here.
  if (!expected.icon) {
    if (
      expected.width.mode === "fixed" &&
      !close(expected.width.value, actual.bounds.width, GEOMETRY_EPSILON)
    )
      issues.push(
        `${expected.name}: expected width ${expected.width.value}, received ${actual.bounds.width}`,
      );
    if (
      expected.height.mode === "fixed" &&
      !close(expected.height.value, actual.bounds.height, GEOMETRY_EPSILON)
    )
      issues.push(
        `${expected.name}: expected height ${expected.height.value}, received ${actual.bounds.height}`,
      );
  }
  if (expected.layoutPosition !== "absolute") return;
  if (!close(expected.bounds.x, actual.bounds.x, GEOMETRY_EPSILON))
    issues.push(
      `${expected.name}: expected x ${expected.bounds.x}, received ${actual.bounds.x}`,
    );
  if (!close(expected.bounds.y, actual.bounds.y, GEOMETRY_EPSILON))
    issues.push(
      `${expected.name}: expected y ${expected.bounds.y}, received ${actual.bounds.y}`,
    );
}

function verifyStacking(
  expected: BridgeNode,
  actual: BridgeNode,
  issues: string[],
): void {
  if (!expected.children.length) return;
  const expectedOrder = bridgeStackOrder(expected);
  const expectedIds = new Set(expectedOrder);
  const actualOrder = actual.children
    .map((child) => child.bridgeId)
    .filter((bridgeId) => expectedIds.has(bridgeId));
  if (
    expectedOrder.length !== actualOrder.length ||
    expectedOrder.some((bridgeId, index) => actualOrder[index] !== bridgeId)
  )
    issues.push(`${expected.name}: layer order was not preserved`);
}

function verifyGradients(
  expected: BridgeNode,
  actual: BridgeNode,
  issues: string[],
): void {
  const expectedGradients = gradients(expected.fills);
  const actualGradients = gradients(actual.fills);
  expectedGradients.forEach((paint, index) => {
    const received = actualGradients[index];
    if (!received) {
      issues.push(`${expected.name}: gradient fill is missing`);
      return;
    }
    if (received.gradientType !== paint.gradientType) {
      issues.push(`${expected.name}: gradient type changed`);
      return;
    }
    if (!sameTransform(paint.transform, received.transform))
      issues.push(`${expected.name}: gradient direction changed`);
    if (
      paint.stops.length !== received.stops.length ||
      paint.stops.some((stop, stopIndex) => {
        const actualStop = received.stops[stopIndex];
        return (
          !actualStop ||
          !close(stop.position, actualStop.position, PAINT_EPSILON) ||
          !sameColor(stop.color, actualStop.color)
        );
      })
    )
      issues.push(`${expected.name}: gradient colors or stops changed`);
  });
}

function gradients(
  paints: Paint[] | undefined,
): Array<Extract<Paint, { type: "gradient" }>> {
  return (paints ?? []).filter(
    (paint): paint is Extract<Paint, { type: "gradient" }> =>
      paint.type === "gradient",
  );
}

function sameTransform(
  left: [[number, number, number], [number, number, number]],
  right: [[number, number, number], [number, number, number]],
): boolean {
  return left.every((row, rowIndex) =>
    row.every((value, columnIndex) =>
      close(value, right[rowIndex]![columnIndex]!, PAINT_EPSILON),
    ),
  );
}

function sameColor(
  left: { r: number; g: number; b: number; a: number },
  right: { r: number; g: number; b: number; a: number },
): boolean {
  return (["r", "g", "b", "a"] as const).every((channel) =>
    close(left[channel], right[channel], PAINT_EPSILON),
  );
}

function close(left: number, right: number, epsilon: number): boolean {
  return Math.abs(left - right) <= epsilon;
}

function collectNodes(root: BridgeNode): Map<string, BridgeNode> {
  const nodes = new Map<string, BridgeNode>();
  visit(root, (node) => nodes.set(node.bridgeId, node));
  return nodes;
}

function visit(node: BridgeNode, callback: (node: BridgeNode) => void): void {
  callback(node);
  for (const child of node.children) visit(child, callback);
}
