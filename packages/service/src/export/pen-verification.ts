import type { BridgeDocument, BridgeNode, Paint } from "@pen-fig/bridge-schema";

const GEOMETRY_EPSILON = 0.5;
const PAINT_EPSILON = 1 / 255 + 1e-6;
const ANGLE_EPSILON = 0.01;

export function verifyPencilWriteFidelity(
  expected: BridgeDocument,
  actual: BridgeDocument,
  bridgeIds?: readonly string[],
): void {
  const expectedNodes = collectNodes(expected.root);
  const actualNodes = collectNodes(actual.root);
  const selected = bridgeIds ?? [...expectedNodes.keys()];
  const issues: string[] = [];

  for (const bridgeId of selected) {
    const source = expectedNodes.get(bridgeId);
    const received = actualNodes.get(bridgeId);
    if (!source) continue;
    if (!received) {
      issues.push(`${source.name}: layer is missing`);
      continue;
    }
    if (received.layoutPosition !== source.layoutPosition)
      issues.push(
        `${source.name}: expected ${source.layoutPosition} positioning, received ${received.layoutPosition}`,
      );
    verifyDimensions(source, received, issues);
    verifyGradients(source, received, issues);
  }

  if (issues.length)
    throw new Error(
      `Pencil verification failed: ${issues.slice(0, 4).join("; ")}${issues.length > 4 ? `; and ${issues.length - 4} more` : ""}`,
    );
}

function verifyDimensions(
  expected: BridgeNode,
  actual: BridgeNode,
  issues: string[],
): void {
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
    if (!sameDirection(paint.transform, received.transform))
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

function sameDirection(
  left: [[number, number, number], [number, number, number]],
  right: [[number, number, number], [number, number, number]],
): boolean {
  const leftAngle = Math.atan2(left[1][0], left[0][0]);
  const rightAngle = Math.atan2(right[1][0], right[0][0]);
  const difference = Math.atan2(
    Math.sin(leftAngle - rightAngle),
    Math.cos(leftAngle - rightAngle),
  );
  return Math.abs(difference) <= ANGLE_EPSILON;
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
