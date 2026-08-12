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
  assetPaths?: Readonly<Record<string, string>>;
}

export function planFigmaToPenCreate(
  document: BridgeDocument,
  options: PenPlanOptions = {},
): PenCreatePlan {
  const warnings = [...document.warnings];
  const assetOperations: PenWriteOperation[] = document.assets.map((asset) => ({
    type: "prepare-asset",
    assetId: asset.id,
    kind: asset.kind,
  }));
  const groups: PenWriteOperation[][] = [];
  for (const [index, component] of (document.components ?? []).entries()) {
    const componentOperations: PenWriteOperation[] = [];
    visit(component, undefined, (node, parentBridgeId) => {
      componentOperations.push({
        type: "insert",
        bridgeId: node.bridgeId,
        parentBridgeId,
        payload: toPenPayload(node, document, warnings, options.assetPaths),
      });
    });
    groups.push(
      index === 0
        ? [...assetOperations, ...componentOperations]
        : componentOperations,
    );
  }
  const rootOperations: PenWriteOperation[] = groups.length
    ? []
    : [...assetOperations];
  visit(document.root, undefined, (node, parentBridgeId) => {
    rootOperations.push({
      type: "insert",
      bridgeId: node.bridgeId,
      parentBridgeId,
      payload: toPenPayload(node, document, warnings, options.assetPaths),
    });
  });
  rootOperations.push({
    type: "finalize-root",
    bridgeId: document.root.bridgeId,
  });
  groups.push(rootOperations);
  const operations = groups.flat();
  const chunks = groups
    .flatMap((group) =>
      chunkOperations(
        group,
        options.maxOperationsPerChunk ?? 20,
        options.maxBytesPerChunk ?? 48 * 1024,
      ),
    )
    .map((chunk, index) => ({ ...chunk, index }));
  return {
    mode: "create-copy",
    rootBridgeId: document.root.bridgeId,
    operations,
    chunks,
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
  assetPaths: Readonly<Record<string, string>> | undefined,
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
    payload.ref = node.instance.componentBridgeId;
    payload.descendants = node.instance.overrides;
  }
  if (
    !node.icon &&
    (node.kind === "frame" ||
      node.kind === "component" ||
      (node.kind === "instance" && !node.instance))
  ) {
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
  if (node.fills?.length) {
    const fillVariable = directPenVariableReference(
      node.variableBindings?.fills?.["0"],
      document,
    );
    payload.fill =
      fillVariable && node.fills.length === 1 && node.fills[0]?.type === "solid"
        ? fillVariable
        : node.fills.map((paint) =>
            penPaint(paint, assetPaths, warnings, node),
          );
  }
  if (node.stroke) {
    const strokeVariable = directPenVariableReference(
      node.variableBindings?.strokes?.["0"],
      document,
    );
    payload.stroke =
      strokeVariable &&
      node.stroke.paints.length === 1 &&
      node.stroke.paints[0]?.type === "solid"
        ? strokeVariable
        : node.stroke.paints.map((paint) =>
            penPaint(paint, assetPaths, warnings, node),
          );
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
  if (node.cornerRadii)
    payload.cornerRadius =
      directPenVariableReference(
        node.variableBindings?.cornerRadius,
        document,
      ) ?? node.cornerRadii;
  if (node.kind === "text" && node.text) {
    payload.content = node.text.characters;
    payload.textGrowth =
      node.text.resize === "auto"
        ? "auto"
        : node.text.resize === "height"
          ? "fixed-width"
          : "fixed-width-height";
    payload.fontFamily =
      directPenVariableReference(node.variableBindings?.fontFamily, document) ??
      node.text.style.family;
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
    const asset = document.assets.find(
      (entry) => entry.id === node.icon?.assetId,
    );
    const rasterizedInstance = asset?.kind === "rasterized";
    payload.type = "rectangle";
    payload.fill = [
      {
        type: "image",
        url:
          assetPaths?.[node.icon.assetId] ??
          assetRelativePath(node.icon.assetId, "svg"),
        mode: "fit",
      },
    ];
    warnings.push({
      code: rasterizedInstance
        ? "FIGMA_ICON_INSTANCE_RASTERIZED"
        : "FIGMA_SVG_RASTERIZED",
      nodeBridgeId: node.bridgeId,
      construct: rasterizedInstance ? "icon component instance" : "svg wrapper",
      action: "rasterize",
      message: rasterizedInstance
        ? `Icon ${node.name} will use a rendered image in Pencil to preserve its Figma size and color`
        : `SVG wrapper ${node.name} will use a rendered image in Pencil`,
    });
  }
  return withoutUndefined(payload);
}

function directPenVariableReference(
  variableId: string | undefined,
  document: BridgeDocument,
): string | undefined {
  if (!variableId?.startsWith("pen-var:")) return undefined;
  const variable = document.variables.find((entry) => entry.id === variableId);
  return variable ? `$${variable.name}` : undefined;
}

function penType(node: BridgeNode): string {
  switch (node.kind) {
    case "component":
      return "frame";
    case "instance":
      return node.instance ? "ref" : "frame";
    default:
      return node.kind;
  }
}

function penSizing(sizing: BridgeNode["width"]): number | string {
  if (sizing.mode === "fixed") return sizing.value;
  const name = sizing.mode === "hug" ? "fit_content" : "fill_container";
  return sizing.fallback === undefined ? name : `${name}(${sizing.fallback})`;
}

function penPaint(
  paint: Paint,
  assetPaths: Readonly<Record<string, string>> | undefined,
  warnings: TransferWarning[],
  node: BridgeNode,
): unknown {
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
  const unsupportedScaleMode =
    paint.scaleMode === "crop" || paint.scaleMode === "tile";
  if (unsupportedScaleMode) {
    const message = `Figma ${paint.scaleMode} image mode on ${node.name} will use Pencil Fill`;
    if (!warnings.some((warning) => warning.message === message))
      warnings.push({
        code: "FIGMA_IMAGE_SCALE_FLATTENED",
        nodeBridgeId: node.bridgeId,
        construct: "image scale mode",
        action: "flatten",
        message,
      });
  }
  return {
    type: "image",
    enabled: paint.visible,
    blendMode: penBlendMode(paint.blendMode),
    opacity: paint.opacity,
    url:
      assetPaths?.[paint.assetId] ?? assetRelativePath(paint.assetId, "image"),
    mode: unsupportedScaleMode
      ? "fill"
      : paint.scaleMode === "stretch"
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
  return ((radians * 180) / Math.PI - 90 + 360) % 360;
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
