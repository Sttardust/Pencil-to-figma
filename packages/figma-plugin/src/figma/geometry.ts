import type {
  BridgeDocument,
  BridgeNode,
  TransferWarning,
} from "@pen-fig/bridge-schema";

const INDIVIDUAL_GEOMETRY_KINDS = new Set<BridgeNode["kind"]>([
  "frame",
  "group",
  "rectangle",
  "component",
  "instance",
  "path",
]);

const UNIFORM_CORNER_KINDS = new Set<BridgeNode["kind"]>([
  "ellipse",
  "polygon",
]);

export function normalizeGeometryForFigma(document: BridgeDocument): void {
  const normalize = (node: BridgeNode) => {
    normalizeStrokeWeights(node, document.warnings);
    normalizeCornerRadii(node, document.warnings);
    for (const child of node.children) normalize(child);
  };

  normalize(document.root);
  for (const component of document.components ?? []) normalize(component);
}

export function uniformValue(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function normalizeStrokeWeights(
  node: BridgeNode,
  warnings: TransferWarning[],
): void {
  const stroke = node.stroke;
  const weights = stroke?.weights;
  if (!stroke || !weights || INDIVIDUAL_GEOMETRY_KINDS.has(node.kind)) return;
  const values = [weights.top, weights.right, weights.bottom, weights.left];
  if (values.every((value) => value === values[0])) return;
  const flattened = uniformValue(values);
  stroke.weights = {
    top: flattened,
    right: flattened,
    bottom: flattened,
    left: flattened,
  };
  addWarning(warnings, {
    code: "PEN_STROKE_WEIGHTS_FLATTENED",
    nodeBridgeId: node.bridgeId,
    construct: "per-side stroke",
    action: "flatten",
    message: `Flattened per-side stroke on ${node.name} to ${flattened}px because Figma only supports a uniform stroke on this layer type`,
  });
}

function normalizeCornerRadii(
  node: BridgeNode,
  warnings: TransferWarning[],
): void {
  const radii = node.cornerRadii;
  if (!radii || INDIVIDUAL_GEOMETRY_KINDS.has(node.kind)) return;
  if (UNIFORM_CORNER_KINDS.has(node.kind)) {
    if (radii.every((value) => value === 0)) {
      delete node.cornerRadii;
      return;
    }
    if (radii.every((value) => value === radii[0])) return;
    const flattened = uniformValue(radii);
    node.cornerRadii = [flattened, flattened, flattened, flattened];
    addWarning(warnings, {
      code: "PEN_CORNER_RADII_FLATTENED",
      nodeBridgeId: node.bridgeId,
      construct: "nonuniform corner radii",
      action: "flatten",
      message: `Flattened nonuniform corner radii on ${node.name} to ${flattened}px because Figma only supports one radius on this layer type`,
    });
    return;
  }
  delete node.cornerRadii;
  addWarning(warnings, {
    code: "PEN_CORNER_RADII_SKIPPED",
    nodeBridgeId: node.bridgeId,
    construct: "corner radii",
    action: "skip",
    message: `Skipped corner radii on ${node.name} because this Figma layer type does not support them`,
  });
}

function addWarning(
  warnings: TransferWarning[],
  warning: TransferWarning,
): void {
  if (
    warnings.some(
      (candidate) =>
        candidate.code === warning.code &&
        candidate.nodeBridgeId === warning.nodeBridgeId,
    )
  )
    return;
  warnings.push(warning);
}
