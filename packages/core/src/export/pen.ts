import type {
  BridgeDocument,
  BridgeNode,
  Effect,
  Paint,
  TransferWarning,
} from "@pen-fig/bridge-schema";

export interface PenInsertOperation {
  type: "insert";
  bridgeId: string;
  parentBridgeId: string | undefined;
  payload: Record<string, unknown>;
}

export type PenWriteOperation =
  | {
      type: "prepare-asset";
      assetId: string;
      kind: "image" | "svg" | "rasterized";
    }
  | PenInsertOperation
  | { type: "finalize-root"; bridgeId: string };

export interface PenWriteChunk {
  index: number;
  estimatedBytes: number;
  operations: PenWriteOperation[];
}

export interface PenCreatePlan {
  mode: "create-copy";
  rootBridgeId: string;
  operations: PenWriteOperation[];
  chunks: PenWriteChunk[];
  counts: { assets: number; inserts: number; finalizes: number };
  warnings: TransferWarning[];
}

export interface PenPlanOptions {
  maxOperationsPerChunk?: number;
  maxBytesPerChunk?: number;
}

export function planFigmaToPenCreate(
  document: BridgeDocument,
  options: PenPlanOptions = {},
): PenCreatePlan {
  const warnings = [...document.warnings];
  const operations: PenWriteOperation[] = document.assets.map((asset) => ({
    type: "prepare-asset",
    assetId: asset.id,
    kind: asset.kind,
  }));
  visit(document.root, undefined, (node, parentBridgeId) => {
    operations.push({
      type: "insert",
      bridgeId: node.bridgeId,
      parentBridgeId,
      payload: toPenPayload(node, document, warnings),
    });
  });
  operations.push({ type: "finalize-root", bridgeId: document.root.bridgeId });
  return {
    mode: "create-copy",
    rootBridgeId: document.root.bridgeId,
    operations,
    chunks: chunkOperations(
      operations,
      options.maxOperationsPerChunk ?? 20,
      options.maxBytesPerChunk ?? 48 * 1024,
    ),
    counts: {
      assets: operations.filter(
        (operation) => operation.type === "prepare-asset",
      ).length,
      inserts: operations.filter((operation) => operation.type === "insert")
        .length,
      finalizes: 1,
    },
    warnings,
  };
}

function toPenPayload(
  node: BridgeNode,
  document: BridgeDocument,
  warnings: TransferWarning[],
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    type: penType(node),
    name: node.name,
    x: node.bounds.x,
    y: node.bounds.y,
    width: penSizing(node.width),
    height: penSizing(node.height),
    rotation: -node.rotation,
    opacity: node.opacity,
    enabled: node.visible,
    layoutPosition: node.layoutPosition ?? "auto",
    metadata: { type: "pen-fig-bridge", bridgeId: node.bridgeId },
  };
  if (node === document.root) payload.placeholder = true;
  if (node.kind === "component") payload.reusable = true;
  if (node.kind === "instance" && node.instance) {
    payload.ref = nativePenId(node.instance.componentBridgeId);
    payload.descendants = node.instance.overrides;
  }
  if (node.kind === "frame" || node.kind === "component") {
    payload.clip = node.clipsContent ?? false;
    if (node.layout) {
      payload.layout = node.layout.mode;
      payload.gap = node.layout.gap;
      payload.padding = [
        node.layout.padding.top,
        node.layout.padding.right,
        node.layout.padding.bottom,
        node.layout.padding.left,
      ];
      payload.justifyContent = node.layout.primaryAlign.replaceAll("-", "_");
      payload.alignItems = node.layout.counterAlign;
      payload.layoutIncludeStroke = node.layout.includeStroke;
    }
  }
  if (node.fills?.length)
    payload.fill = node.fills.map((paint) => penPaint(paint));
  if (node.stroke) {
    payload.stroke = node.stroke.paints.map((paint) => penPaint(paint));
    const weights = node.stroke.weights;
    payload.strokeWidth =
      weights.top === weights.right &&
      weights.top === weights.bottom &&
      weights.top === weights.left
        ? weights.top
        : weights;
    payload.strokeAlignment =
      node.stroke.alignment === "inside"
        ? "inner"
        : node.stroke.alignment === "outside"
          ? "outer"
          : "center";
    payload.strokeLinecap =
      node.stroke.cap === "none" ? "butt" : node.stroke.cap;
    payload.strokeLinejoin = node.stroke.join;
  }
  if (node.effects?.length) payload.effect = node.effects.map(penEffect);
  if (node.cornerRadii) payload.cornerRadius = node.cornerRadii;
  if (node.kind === "text" && node.text) {
    payload.content = node.text.characters;
    payload.textGrowth =
      node.text.resize === "auto"
        ? "auto"
        : node.text.resize === "height"
          ? "fixed-width"
          : "fixed-width-height";
    payload.fontFamily = node.text.style.family;
    payload.fontStyle = node.text.style.style;
    payload.fontWeight = node.text.style.weight;
    payload.fontSize = node.text.style.size;
    payload.lineHeight =
      node.text.style.lineHeight.unit === "auto"
        ? undefined
        : node.text.style.lineHeight.unit === "pixels"
          ? node.text.style.lineHeight.value / node.text.style.size
          : node.text.style.lineHeight.value / 100;
    payload.letterSpacing = node.text.style.letterSpacing;
    payload.textAlign = node.text.style.horizontalAlign;
    payload.textAlignVertical =
      node.text.style.verticalAlign === "center"
        ? "middle"
        : node.text.style.verticalAlign;
    payload.underline = node.text.style.decoration === "underline";
    payload.strikethrough = node.text.style.decoration === "strikethrough";
  }
  if (node.kind === "path" && node.path) {
    payload.geometry = node.path.data;
    payload.fillRule = node.path.windingRule;
    payload.viewBox = node.path.viewBox;
  }
  if (node.kind === "polygon") payload.polygonCount = node.polygonSides ?? 3;
  if (node.icon) {
    payload.type = "rectangle";
    payload.fill = [
      {
        type: "image",
        url: assetRelativePath(node.icon.assetId, "svg"),
        mode: "fit",
      },
    ];
    warnings.push({
      code: "FIGMA_SVG_RASTERIZED",
      nodeBridgeId: node.bridgeId,
      construct: "svg wrapper",
      action: "rasterize",
      message: `SVG wrapper ${node.name} will use a rendered image in Pencil`,
    });
  }
  return withoutUndefined(payload);
}

function penType(node: BridgeNode): string {
  switch (node.kind) {
    case "component":
      return "frame";
    case "instance":
      return "ref";
    default:
      return node.kind;
  }
}

function penSizing(sizing: BridgeNode["width"]): number | string {
  if (sizing.mode === "fixed") return sizing.value;
  const name = sizing.mode === "hug" ? "fit_content" : "fill_container";
  return sizing.fallback === undefined ? name : `${name}(${sizing.fallback})`;
}

function penPaint(paint: Paint): unknown {
  if (paint.type === "solid")
    return {
      type: "color",
      enabled: paint.visible,
      blendMode: penBlendMode(paint.blendMode),
      color: rgbaToHex({ ...paint.color, a: paint.color.a * paint.opacity }),
    };
  if (paint.type === "gradient")
    return {
      type: "gradient",
      enabled: paint.visible,
      blendMode: penBlendMode(paint.blendMode),
      gradientType: paint.gradientType,
      opacity: paint.opacity,
      rotation: gradientRotation(paint.transform),
      colors: paint.stops.map((stop) => ({
        color: rgbaToHex(stop.color),
        position: stop.position,
      })),
    };
  return {
    type: "image",
    enabled: paint.visible,
    blendMode: penBlendMode(paint.blendMode),
    opacity: paint.opacity,
    url: assetRelativePath(paint.assetId, "image"),
    mode:
      paint.scaleMode === "stretch"
        ? "stretch"
        : paint.scaleMode === "fit"
          ? "fit"
          : "fill",
  };
}

function penEffect(effect: Effect): Record<string, unknown> {
  if (!("color" in effect))
    return {
      type: effect.type === "background-blur" ? "background_blur" : "blur",
      enabled: effect.visible,
      radius: effect.radius,
    };
  return {
    type: "shadow",
    enabled: effect.visible,
    shadowType: effect.type === "inner-shadow" ? "inner" : "outer",
    offset: effect.offset,
    spread: effect.spread,
    blur: effect.radius,
    color: rgbaToHex(effect.color),
    blendMode: penBlendMode(effect.blendMode),
  };
}

function gradientRotation(
  transform: [[number, number, number], [number, number, number]],
): number {
  const radians = Math.atan2(transform[1][0], transform[0][0]);
  return ((radians * 180) / Math.PI + 90 + 360) % 360;
}

function rgbaToHex(color: {
  r: number;
  g: number;
  b: number;
  a: number;
}): string {
  return `#${[color.r, color.g, color.b, color.a]
    .map((channel) =>
      Math.round(Math.max(0, Math.min(1, channel)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function penBlendMode(value: Paint["blendMode"]): string {
  return value.replace(/-([a-z])/g, (_, letter: string) =>
    letter.toUpperCase(),
  );
}

function assetRelativePath(assetId: string, fallbackExtension: string): string {
  const safe = assetId.replace(/[^A-Za-z0-9._-]+/g, "-");
  return `./.pen-fig-assets/${safe}.${fallbackExtension === "svg" ? "png" : "bin"}`;
}

function nativePenId(bridgeId: string): string {
  return bridgeId.startsWith("pen:") ? bridgeId.slice(4) : bridgeId;
}

function visit(
  node: BridgeNode,
  parentBridgeId: string | undefined,
  callback: (node: BridgeNode, parentBridgeId: string | undefined) => void,
): void {
  callback(node, parentBridgeId);
  for (const child of node.children) visit(child, node.bridgeId, callback);
}

function chunkOperations(
  operations: PenWriteOperation[],
  maxOperations: number,
  maxBytes: number,
): PenWriteChunk[] {
  if (maxOperations < 1 || maxBytes < 256)
    throw new Error("Pen chunk limits are too small");
  const chunks: PenWriteChunk[] = [];
  let current: PenWriteOperation[] = [];
  let bytes = 0;
  for (const operation of operations) {
    const operationBytes = JSON.stringify(operation).length;
    if (operationBytes > maxBytes)
      throw new Error(`Pen operation exceeds ${maxBytes} bytes`);
    if (
      current.length &&
      (current.length >= maxOperations || bytes + operationBytes > maxBytes)
    ) {
      chunks.push({
        index: chunks.length,
        estimatedBytes: bytes,
        operations: current,
      });
      current = [];
      bytes = 0;
    }
    current.push(operation);
    bytes += operationBytes;
  }
  if (current.length)
    chunks.push({
      index: chunks.length,
      estimatedBytes: bytes,
      operations: current,
    });
  return chunks;
}

function withoutUndefined(
  input: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}
