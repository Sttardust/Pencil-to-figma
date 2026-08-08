import {
  bridgeDocumentSchema,
  type BridgeAsset,
  type BridgeDocument,
  type BridgeNode,
  type Effect,
  type Paint,
  type TransferWarning,
} from "@pen-fig/bridge-schema";
import {
  BRIDGE_ID_KEY,
  BRIDGE_KIND_KEY,
  INSTANCE_OVERRIDE_MAP_KEY,
  SVG_ASSET_KEY,
} from "./identity.js";

export interface FigmaReadResult {
  document: BridgeDocument;
  nodeCount: number;
  fonts: string[];
  assetData: Record<string, FigmaAssetData>;
}

export interface FigmaAssetData {
  base64: string;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  byteLength: number;
}

export async function readSelectedFigmaDocument(): Promise<FigmaReadResult> {
  await figma.currentPage.loadAsync();
  const selection = figma.currentPage.selection;
  if (selection.length !== 1)
    throw new Error("Select exactly one Figma frame or component");
  const selected = selection[0]!;
  if (selected.type !== "FRAME" && selected.type !== "COMPONENT")
    throw new Error("The selected root must be a Figma frame or component");

  const documentId = figma.fileKey ?? "figma-local";
  const assets: BridgeAsset[] = [];
  const warnings: TransferWarning[] = [];
  const fonts = new Set<string>();
  const instanceComponents = await loadInstanceComponents(selected);
  let nodeCount = 0;
  const root = readNode(
    selected,
    documentId,
    assets,
    warnings,
    fonts,
    instanceComponents,
    () => {
      nodeCount += 1;
    },
  );
  removeDerivedInstanceChildren(root);
  nodeCount = countBridgeNodes(root);
  const document = bridgeDocumentSchema.parse({
    version: 1,
    source: { app: "figma", documentId },
    root,
    assets,
    variables: [],
    warnings,
  });
  return {
    document,
    nodeCount,
    fonts: [...fonts].sort(),
    assetData: await collectAssetData(document.assets),
  };
}

async function loadInstanceComponents(
  root: SceneNode,
): Promise<Map<string, ComponentNode | null>> {
  const instances: InstanceNode[] = [];
  if (root.type === "INSTANCE") instances.push(root);
  if ("findAll" in root)
    instances.push(
      ...root
        .findAll((node) => node.type === "INSTANCE")
        .filter((node): node is InstanceNode => node.type === "INSTANCE"),
    );
  const components = new Map<string, ComponentNode | null>();
  await Promise.all(
    instances.map(async (instance) => {
      components.set(instance.id, await instance.getMainComponentAsync());
    }),
  );
  return components;
}

async function collectAssetData(
  assets: BridgeAsset[],
): Promise<Record<string, FigmaAssetData>> {
  const entries = await Promise.all(
    assets.map(async (asset): Promise<[string, FigmaAssetData]> => {
      const sourceUri = asset.sourceUri;
      if (!sourceUri)
        throw new Error(`Figma asset ${asset.id} has no source URI`);
      let bytes: Uint8Array;
      let mimeType: FigmaAssetData["mimeType"];
      if (sourceUri.startsWith("figma-image://")) {
        const imageHash = sourceUri.slice("figma-image://".length);
        const image = figma.getImageByHash(imageHash);
        if (!image) throw new Error(`Figma image ${imageHash} is unavailable`);
        bytes = await image.getBytesAsync();
        mimeType = detectImageMime(bytes);
      } else if (sourceUri.startsWith("figma-svg://")) {
        const nodeId = sourceUri.slice("figma-svg://".length);
        const node = await figma.getNodeByIdAsync(nodeId);
        if (!node || node.type === "DOCUMENT" || node.type === "PAGE")
          throw new Error(`Figma SVG wrapper ${nodeId} is unavailable`);
        bytes = await node.exportAsync({
          format: "PNG",
          constraint: { type: "SCALE", value: 2 },
        });
        mimeType = "image/png";
      } else {
        throw new Error(`Unsupported Figma asset URI ${sourceUri}`);
      }
      return [
        asset.id,
        {
          base64: figma.base64Encode(bytes),
          mimeType,
          byteLength: bytes.byteLength,
        },
      ];
    }),
  );
  return Object.fromEntries(entries);
}

function detectImageMime(bytes: Uint8Array): FigmaAssetData["mimeType"] {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8)
    return "image/jpeg";
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46
  )
    return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  throw new Error("Figma returned an unsupported image format");
}

function readNode(
  node: SceneNode,
  documentId: string,
  assets: BridgeAsset[],
  warnings: TransferWarning[],
  fonts: Set<string>,
  instanceComponents: ReadonlyMap<string, ComponentNode | null>,
  counted: () => void,
): BridgeNode {
  counted();
  const bridgeId = node.getPluginData(BRIDGE_ID_KEY) || `figma:${node.id}`;
  const generatedSvgWrapper = isGeneratedSvgWrapper(node);
  const storedKind = node.getPluginData(BRIDGE_KIND_KEY);
  const result: BridgeNode = {
    bridgeId,
    kind: generatedSvgWrapper
      ? "frame"
      : isBridgeKind(storedKind)
        ? storedKind
        : mapKind(node),
    name: node.name,
    source: { app: "figma", documentId, nodeId: node.id },
    bounds: { x: node.x, y: node.y, width: node.width, height: node.height },
    width: mapSizing(node, "horizontal"),
    height: mapSizing(node, "vertical"),
    rotation: "rotation" in node ? node.rotation : 0,
    visible: node.visible,
    opacity: "opacity" in node ? node.opacity : 1,
    locked: node.locked,
    layoutPosition:
      "layoutPosition" in node && node.layoutPosition === "ABSOLUTE"
        ? "absolute"
        : "auto",
    children: [],
  };
  if ("children" in node && !generatedSvgWrapper && node.type !== "INSTANCE") {
    for (const child of node.children) {
      if (!isSupportedSceneNode(child)) {
        warnings.push(
          warning(
            bridgeId,
            child.type.toLowerCase(),
            "skip",
            `Skipped unsupported Figma node ${child.name} (${child.type})`,
          ),
        );
        continue;
      }
      result.children.push(
        readNode(
          child,
          documentId,
          assets,
          warnings,
          fonts,
          instanceComponents,
          counted,
        ),
      );
    }
  }
  if (generatedSvgWrapper) {
    const assetId = node.getPluginData(SVG_ASSET_KEY) || `figma-svg:${node.id}`;
    if (!assets.some((asset) => asset.id === assetId))
      assets.push({
        status: "pending",
        id: assetId,
        kind: "svg",
        sourceUri: `figma-svg://${node.id}`,
      });
    result.icon = { assetId };
  }

  if (node.type === "FRAME" || node.type === "COMPONENT") {
    result.clipsContent = node.clipsContent;
    result.layout = mapLayout(node);
  }
  const fills =
    node.type === "INSTANCE"
      ? []
      : readPaints(node, bridgeId, assets, warnings);
  if (fills.length) result.fills = fills;
  const stroke =
    node.type === "INSTANCE"
      ? undefined
      : readStroke(node, bridgeId, assets, warnings);
  if (stroke) result.stroke = stroke;
  const effects =
    node.type === "INSTANCE" ? [] : readEffects(node, bridgeId, warnings);
  if (effects.length) result.effects = effects;
  const radii = node.type === "INSTANCE" ? undefined : readCornerRadii(node);
  if (radii) result.cornerRadii = radii;

  if (node.type === "TEXT") {
    if (
      node.fontName === figma.mixed ||
      node.fontSize === figma.mixed ||
      node.lineHeight === figma.mixed ||
      node.letterSpacing === figma.mixed ||
      node.textDecoration === figma.mixed
    )
      throw new Error(`Mixed text styling is not supported yet: ${node.name}`);
    fonts.add(`${node.fontName.family} ${node.fontName.style}`);
    result.text = {
      characters: node.characters,
      resize:
        node.textAutoResize === "WIDTH_AND_HEIGHT"
          ? "auto"
          : node.textAutoResize === "HEIGHT"
            ? "height"
            : "fixed",
      style: {
        family: node.fontName.family,
        style: node.fontName.style,
        weight: weightFromStyle(node.fontName.style),
        size: node.fontSize,
        lineHeight:
          node.lineHeight.unit === "AUTO"
            ? { unit: "auto" }
            : {
                unit: node.lineHeight.unit === "PIXELS" ? "pixels" : "percent",
                value: node.lineHeight.value,
              },
        letterSpacing:
          node.letterSpacing.unit === "PIXELS"
            ? node.letterSpacing.value
            : (node.letterSpacing.value / 100) * node.fontSize,
        horizontalAlign: node.textAlignHorizontal.toLowerCase() as
          "left" | "center" | "right" | "justify",
        verticalAlign: node.textAlignVertical.toLowerCase() as
          "top" | "center" | "bottom",
        decoration:
          node.textDecoration === "UNDERLINE"
            ? "underline"
            : node.textDecoration === "STRIKETHROUGH"
              ? "strikethrough"
              : "none",
      },
    };
  } else if (node.type === "VECTOR") {
    const paths = node.vectorPaths;
    if (!paths.length) throw new Error(`Vector has no path data: ${node.name}`);
    if (paths.length > 1)
      warnings.push(
        warning(
          bridgeId,
          "multiple vector paths",
          "flatten",
          `Using the first of ${paths.length} vector paths on ${node.name}`,
        ),
      );
    result.path = {
      data: paths[0]!.data,
      windingRule: paths[0]!.windingRule === "EVENODD" ? "evenodd" : "nonzero",
      viewBox: [0, 0, node.width, node.height],
    };
  } else if (node.type === "POLYGON") {
    result.polygonSides = node.pointCount;
  } else if (node.type === "COMPONENT") {
    result.component = { key: node.key || node.id };
  } else if (node.type === "INSTANCE") {
    const component = instanceComponents.get(node.id);
    result.instance = {
      componentBridgeId:
        component?.getPluginData(BRIDGE_ID_KEY) ||
        `figma:${component?.id ?? "unresolved"}`,
      overrides: readInstanceOverrides(node, bridgeId, warnings),
    };
  }
  return result;
}

function readInstanceOverrides(
  node: InstanceNode,
  bridgeId: string,
  warnings: TransferWarning[],
): Record<string, unknown> {
  const stored = node.getPluginData(INSTANCE_OVERRIDE_MAP_KEY);
  if (!stored)
    return Object.fromEntries(
      Object.entries(node.componentProperties).map(([name, property]) => [
        name,
        property.value,
      ]),
    );
  try {
    const mapping = JSON.parse(stored) as Record<
      string,
      { bridgeId?: unknown; property?: unknown }
    >;
    const overrides: Record<string, unknown> = {};
    for (const [propertyName, target] of Object.entries(mapping)) {
      const property = node.componentProperties[propertyName];
      if (
        typeof target.bridgeId !== "string" ||
        target.property !== "content" ||
        !property ||
        typeof property.value !== "string"
      )
        continue;
      overrides[target.bridgeId] = { content: property.value };
    }
    return overrides;
  } catch {
    warnings.push(
      warning(
        bridgeId,
        "instance override metadata",
        "skip",
        `Ignored invalid instance override metadata on ${node.name}`,
      ),
    );
    return {};
  }
}

function removeDerivedInstanceChildren(root: BridgeNode): void {
  const componentBridgeIds = new Set<string>();
  const collect = (node: BridgeNode) => {
    if (node.kind === "component") componentBridgeIds.add(node.bridgeId);
    for (const child of node.children) collect(child);
  };
  collect(root);
  const normalize = (node: BridgeNode) => {
    if (
      node.kind === "instance" &&
      node.instance &&
      componentBridgeIds.has(node.instance.componentBridgeId)
    ) {
      node.children = [];
      return;
    }
    for (const child of node.children) normalize(child);
  };
  normalize(root);
}

function countBridgeNodes(node: BridgeNode): number {
  return (
    1 +
    node.children.reduce((total, child) => total + countBridgeNodes(child), 0)
  );
}

function mapKind(node: SceneNode): BridgeNode["kind"] {
  switch (node.type) {
    case "FRAME":
      return "frame";
    case "GROUP":
      return "group";
    case "COMPONENT":
      return "component";
    case "INSTANCE":
      return "instance";
    case "RECTANGLE":
      return "rectangle";
    case "ELLIPSE":
      return "ellipse";
    case "POLYGON":
      return "polygon";
    case "VECTOR":
      return "path";
    case "TEXT":
      return "text";
    default:
      throw new Error(`Unsupported Figma node type ${node.type}: ${node.name}`);
  }
}

function isSupportedSceneNode(node: SceneNode): boolean {
  return [
    "FRAME",
    "GROUP",
    "COMPONENT",
    "INSTANCE",
    "RECTANGLE",
    "ELLIPSE",
    "POLYGON",
    "VECTOR",
    "TEXT",
  ].includes(node.type);
}

function isGeneratedSvgWrapper(node: SceneNode): boolean {
  if (!("children" in node) || node.children.length === 0) return false;
  if (!node.getPluginData(BRIDGE_ID_KEY)) return false;
  return node.children.every(
    (child) => child.getPluginData(BRIDGE_ID_KEY) === "",
  );
}

function isBridgeKind(value: string): value is BridgeNode["kind"] {
  return [
    "frame",
    "group",
    "rectangle",
    "ellipse",
    "polygon",
    "path",
    "text",
    "component",
    "instance",
  ].includes(value);
}

function mapSizing(
  node: SceneNode,
  axis: "horizontal" | "vertical",
): BridgeNode["width"] {
  const property =
    axis === "horizontal" ? "layoutSizingHorizontal" : "layoutSizingVertical";
  const fallback = axis === "horizontal" ? node.width : node.height;
  if (property in node) {
    const value = (node as SceneNode & LayoutMixin)[property];
    if (value === "FILL") return { mode: "fill", fallback };
    if (value === "HUG") return { mode: "hug", fallback };
  }
  return { mode: "fixed", value: fallback };
}

function mapLayout(
  node: FrameNode | ComponentNode,
): NonNullable<BridgeNode["layout"]> {
  return {
    mode:
      node.layoutMode === "HORIZONTAL"
        ? "horizontal"
        : node.layoutMode === "VERTICAL"
          ? "vertical"
          : "none",
    gap: node.layoutMode === "NONE" ? 0 : node.itemSpacing,
    padding: {
      top: node.paddingTop,
      right: node.paddingRight,
      bottom: node.paddingBottom,
      left: node.paddingLeft,
    },
    primaryAlign:
      node.primaryAxisAlignItems === "CENTER"
        ? "center"
        : node.primaryAxisAlignItems === "MAX"
          ? "end"
          : node.primaryAxisAlignItems === "SPACE_BETWEEN"
            ? "space-between"
            : "start",
    counterAlign:
      node.counterAxisAlignItems === "CENTER"
        ? "center"
        : node.counterAxisAlignItems === "MAX"
          ? "end"
          : "start",
    includeStroke: node.strokesIncludedInLayout,
  };
}

function readPaints(
  node: SceneNode,
  bridgeId: string,
  assets: BridgeAsset[],
  warnings: TransferWarning[],
): Paint[] {
  if (!("fills" in node) || node.fills === figma.mixed) return [];
  return node.fills.flatMap((paint, index) =>
    mapPaint(paint, bridgeId, index, assets, warnings),
  );
}

function mapPaint(
  paint: PaintStyle["paints"][number],
  bridgeId: string,
  index: number,
  assets: BridgeAsset[],
  warnings: TransferWarning[],
): Paint[] {
  const opacity = paint.opacity ?? 1;
  if (paint.type === "SOLID")
    return [
      {
        type: "solid",
        visible: paint.visible !== false,
        opacity,
        blendMode: mapBlendMode(paint.blendMode),
        color: { ...paint.color, a: 1 },
      },
    ];
  if (
    paint.type === "GRADIENT_LINEAR" ||
    paint.type === "GRADIENT_RADIAL" ||
    paint.type === "GRADIENT_ANGULAR"
  )
    return [
      {
        type: "gradient",
        visible: paint.visible !== false,
        opacity,
        blendMode: mapBlendMode(paint.blendMode),
        gradientType:
          paint.type === "GRADIENT_RADIAL"
            ? "radial"
            : paint.type === "GRADIENT_ANGULAR"
              ? "angular"
              : "linear",
        stops: paint.gradientStops.map((stop) => ({
          position: stop.position,
          color: stop.color,
        })),
        transform: [
          [...paint.gradientTransform[0]],
          [...paint.gradientTransform[1]],
        ],
      },
    ];
  if (paint.type === "IMAGE" && paint.imageHash) {
    const assetId = `figma-image:${paint.imageHash}`;
    if (!assets.some((asset) => asset.id === assetId))
      assets.push({
        status: "pending",
        id: assetId,
        kind: "image",
        sourceUri: `figma-image://${paint.imageHash}`,
      });
    return [
      {
        type: "image",
        visible: paint.visible !== false,
        opacity,
        blendMode: mapBlendMode(paint.blendMode),
        assetId,
        scaleMode:
          paint.scaleMode === "FIT"
            ? "fit"
            : paint.scaleMode === "TILE"
              ? "tile"
              : "fill",
      },
    ];
  }
  warnings.push(
    warning(
      bridgeId,
      `${paint.type.toLowerCase()} paint`,
      "skip",
      `Unsupported Figma paint ${paint.type} at index ${index}`,
    ),
  );
  return [];
}

function readStroke(
  node: SceneNode,
  bridgeId: string,
  assets: BridgeAsset[],
  warnings: TransferWarning[],
): BridgeNode["stroke"] {
  if (!("strokes" in node) || !node.strokes.length) return undefined;
  const uniform =
    "strokeWeight" in node && node.strokeWeight !== figma.mixed
      ? node.strokeWeight
      : 0;
  return {
    paints: node.strokes.flatMap((paint, index) =>
      mapPaint(paint, bridgeId, index, assets, warnings),
    ),
    alignment:
      node.strokeAlign === "OUTSIDE"
        ? "outside"
        : node.strokeAlign === "CENTER"
          ? "center"
          : "inside",
    weights: {
      top: "strokeTopWeight" in node ? node.strokeTopWeight : uniform,
      right: "strokeRightWeight" in node ? node.strokeRightWeight : uniform,
      bottom: "strokeBottomWeight" in node ? node.strokeBottomWeight : uniform,
      left: "strokeLeftWeight" in node ? node.strokeLeftWeight : uniform,
    },
    cap: "none",
    join: "miter",
  };
}

function readEffects(
  node: SceneNode,
  bridgeId: string,
  warnings: TransferWarning[],
): Effect[] {
  if (!("effects" in node)) return [];
  const results: Effect[] = [];
  for (const effect of node.effects) {
    if (effect.type === "LAYER_BLUR" || effect.type === "BACKGROUND_BLUR")
      results.push({
        type:
          effect.type === "LAYER_BLUR"
            ? ("blur" as const)
            : ("background-blur" as const),
        visible: effect.visible,
        radius: effect.radius,
      });
    else if (effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW")
      results.push({
        type:
          effect.type === "DROP_SHADOW"
            ? ("drop-shadow" as const)
            : ("inner-shadow" as const),
        visible: effect.visible,
        color: effect.color,
        offset: effect.offset,
        radius: effect.radius,
        spread: effect.spread ?? 0,
        blendMode: mapBlendMode(effect.blendMode),
      });
    else
      warnings.push(
        warning(
          bridgeId,
          "effect",
          "skip",
          `Unsupported effect ${effect.type}`,
        ),
      );
  }
  return results;
}

function readCornerRadii(
  node: SceneNode,
): [number, number, number, number] | undefined {
  if (!("topLeftRadius" in node)) return undefined;
  return [
    numeric(node.topLeftRadius),
    numeric(node.topRightRadius),
    numeric(node.bottomRightRadius),
    numeric(node.bottomLeftRadius),
  ];
}

function numeric(value: number | PluginAPI["mixed"]): number {
  return value === figma.mixed ? 0 : value;
}

function mapBlendMode(value: BlendMode | undefined): Paint["blendMode"] {
  const normalized = (value ?? "NORMAL").toLowerCase().replaceAll("_", "-");
  return [
    "normal",
    "darken",
    "multiply",
    "color-burn",
    "lighten",
    "screen",
    "color-dodge",
    "overlay",
    "soft-light",
    "hard-light",
    "difference",
    "exclusion",
    "hue",
    "saturation",
    "color",
    "luminosity",
  ].includes(normalized)
    ? (normalized as Paint["blendMode"])
    : "normal";
}

function weightFromStyle(style: string): number {
  const normalized = style.toLowerCase();
  return normalized.includes("black")
    ? 900
    : normalized.includes("extra bold")
      ? 800
      : normalized.includes("bold")
        ? 700
        : normalized.includes("semi")
          ? 600
          : normalized.includes("medium")
            ? 500
            : normalized.includes("light")
              ? 300
              : normalized.includes("thin")
                ? 100
                : 400;
}

function warning(
  nodeBridgeId: string,
  construct: string,
  action: TransferWarning["action"],
  message: string,
): TransferWarning {
  return {
    code: `FIGMA_${construct.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`,
    nodeBridgeId,
    construct,
    action,
    message,
  };
}
