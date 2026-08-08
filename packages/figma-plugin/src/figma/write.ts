import {
  bridgeDocumentSchema,
  type BridgeDocument,
  type BridgeNode,
  type Paint,
} from "@pen-fig/bridge-schema";
import {
  authoredDocumentHashes,
  planPenToFigmaSync,
  type SyncPlan,
} from "@pen-fig/core";
import {
  AUTHORED_HASH_KEY,
  BRIDGE_ID_KEY,
  findMappedRoots,
  readMappedSubtree,
} from "./identity.js";

export interface WriteResult {
  rootId: string;
  nodeCount: number;
  operation: "created" | "unchanged" | "updated";
  operations?: SyncPlan["counts"];
  warnings: string[];
}

export interface PreviewResult {
  rootId?: string;
  nodeCount: number;
  operation: "created" | "unchanged" | "updated";
  operations: SyncPlan["counts"];
  warnings: string[];
}

export async function previewBridgeDocument(
  input: unknown,
): Promise<PreviewResult> {
  const document = bridgeDocumentSchema.parse(input);
  await figma.currentPage.loadAsync();
  const mappedRoots = findMappedRoots(
    figma.currentPage,
    document.root.bridgeId,
  );
  if (mappedRoots.length > 1)
    throw new Error(
      `Duplicate bridge identities require remapping: ${document.root.bridgeId} (${mappedRoots.map((root) => root.id).join(", ")})`,
    );
  const mappedRoot = mappedRoots[0];
  const plan = planPenToFigmaSync(
    document,
    mappedRoot ? readMappedSubtree(mappedRoot).records : [],
  );
  return {
    ...(mappedRoot ? { rootId: mappedRoot.id } : {}),
    nodeCount: plan.operations.length,
    operation: mappedRoot
      ? plan.operations.length
        ? "updated"
        : "unchanged"
      : "created",
    operations: plan.counts,
    warnings: document.warnings.map((warning) => warning.message),
  };
}

export async function writeBridgeDocument(
  input: unknown,
  assetData: Record<string, string> = {},
): Promise<WriteResult> {
  const document = bridgeDocumentSchema.parse(input);
  await figma.currentPage.loadAsync();
  const hashes = authoredDocumentHashes(document);
  const mappedRoots = findMappedRoots(
    figma.currentPage,
    document.root.bridgeId,
  );
  if (mappedRoots.length > 1)
    throw new Error(
      `Duplicate bridge identities require remapping: ${document.root.bridgeId} (${mappedRoots.map((root) => root.id).join(", ")})`,
    );
  const mappedRoot = mappedRoots[0];
  if (mappedRoot) {
    const mapped = readMappedSubtree(mappedRoot);
    const plan = planPenToFigmaSync(document, mapped.records);
    if (plan.operations.length === 0) {
      figma.currentPage.selection = [mappedRoot];
      figma.viewport.scrollAndZoomIntoView([mappedRoot]);
      return {
        rootId: mappedRoot.id,
        nodeCount: 0,
        operation: "unchanged",
        operations: plan.counts,
        warnings: document.warnings.map((warning) => warning.message),
      };
    }
    await preflightFonts(document);
    const context = prepareContext(document, assetData, hashes);
    for (const [bridgeId, node] of mapped.nodes)
      context.nodes.set(bridgeId, node);
    await prepareAssets(document, context);
    figma.commitUndo();
    try {
      await applySyncPlan(document, mappedRoot, plan, context);
      figma.commitUndo();
    } catch (error) {
      figma.triggerUndo();
      throw error;
    }
    const root = context.nodes.get(document.root.bridgeId);
    if (!root) throw new Error("Updated Figma root is missing");
    figma.currentPage.selection = [root];
    figma.viewport.scrollAndZoomIntoView([root]);
    return {
      rootId: root.id,
      nodeCount: plan.operations.length,
      operation: "updated",
      operations: plan.counts,
      warnings: [
        ...document.warnings.map((warning) => warning.message),
        ...context.warnings,
      ],
    };
  }
  await preflightFonts(document);
  const context = prepareContext(document, assetData, hashes);
  await prepareAssets(document, context);
  let root: SceneNode | undefined;
  try {
    root = await createNode(document.root, figma.currentPage, context);
    const center = figma.viewport.center;
    root.x = center.x - root.width / 2;
    root.y = center.y - root.height / 2;
    figma.currentPage.selection = [root];
    figma.viewport.scrollAndZoomIntoView([root]);
    return {
      rootId: root.id,
      nodeCount: context.nodeCount,
      operation: "created",
      warnings: [
        ...document.warnings.map((warning) => warning.message),
        ...context.warnings,
      ],
    };
  } catch (error) {
    root?.remove();
    throw error;
  }
}

interface WriteContext {
  nodes: Map<string, SceneNode>;
  images: Map<string, string>;
  assetData: Record<string, string>;
  nodeCount: number;
  warnings: string[];
  hashes: Record<string, string>;
}

function prepareContext(
  _document: BridgeDocument,
  assetData: Record<string, string>,
  hashes: Record<string, string>,
): WriteContext {
  return {
    nodes: new Map(),
    images: new Map(),
    assetData,
    nodeCount: 0,
    warnings: [],
    hashes,
  };
}

async function prepareAssets(
  document: BridgeDocument,
  context: WriteContext,
): Promise<void> {
  for (const asset of document.assets) {
    if (asset.status !== "ready" || asset.kind !== "image") continue;
    const encoded = context.assetData[asset.id];
    if (!encoded) throw new Error(`Image data missing for ${asset.id}`);
    context.images.set(
      asset.id,
      figma.createImage(figma.base64Decode(encoded)).hash,
    );
  }
}

async function preflightFonts(document: BridgeDocument): Promise<void> {
  const fonts = new Map<string, FontName>();
  visit(document.root, (node) => {
    if (node.text) {
      const font = {
        family: node.text.style.family,
        style: node.text.style.style,
      };
      fonts.set(`${font.family}\0${font.style}`, font);
    }
  });
  const failures: string[] = [];
  await Promise.all(
    [...fonts.values()].map(async (font) => {
      try {
        await figma.loadFontAsync(font);
      } catch {
        failures.push(`${font.family} ${font.style}`);
      }
    }),
  );
  if (failures.length)
    throw new Error(`Missing Figma fonts: ${failures.sort().join(", ")}`);
}

async function createNode(
  source: BridgeNode,
  parent: BaseNode & ChildrenMixin,
  context: WriteContext,
): Promise<SceneNode> {
  const node = createNodeShallow(source, parent, context);
  if ("children" in node) {
    for (const child of source.children) await createNode(child, node, context);
  }
  applySizingMode(node, source, parent);
  return node;
}

function createNodeShallow(
  source: BridgeNode,
  parent: BaseNode & ChildrenMixin,
  context: WriteContext,
): SceneNode {
  const node = createNativeNode(source, context);
  parent.appendChild(node);
  context.nodes.set(source.bridgeId, node);
  context.nodeCount += 1;
  applyNodeProperties(node, source, parent, context);
  return node;
}

function applyNodeProperties(
  node: SceneNode,
  source: BridgeNode,
  parent: BaseNode & ChildrenMixin,
  context: WriteContext,
): void {
  assertCompatibleNode(node, source);
  node.name = source.name;
  node.visible = source.visible;
  if ("opacity" in node) node.opacity = source.opacity;
  node.locked = source.locked;
  if ("rotation" in node) node.rotation = source.rotation;
  node.setPluginData(BRIDGE_ID_KEY, source.bridgeId);
  node.setPluginData(AUTHORED_HASH_KEY, context.hashes[source.bridgeId] ?? "");
  node.setPluginData("penFigSchema", "1");
  applyLayoutPosition(node, source, parent);
  applySize(node, source);
  node.x = source.bounds.x;
  node.y = source.bounds.y;
  applyGeometry(node, source, context);
  if (node.type === "FRAME" || node.type === "COMPONENT")
    applyLayout(node, source);
  applySizingMode(node, source, parent);
}

function assertCompatibleNode(node: SceneNode, source: BridgeNode): void {
  const expected = source.icon
    ? "FRAME"
    : source.kind === "frame" || source.kind === "group"
      ? "FRAME"
      : source.kind === "component"
        ? "COMPONENT"
        : source.kind === "rectangle"
          ? "RECTANGLE"
          : source.kind === "ellipse"
            ? "ELLIPSE"
            : source.kind === "polygon"
              ? "POLYGON"
              : source.kind === "text"
                ? "TEXT"
                : source.kind === "instance"
                  ? "INSTANCE"
                  : undefined;
  if (expected && node.type !== expected)
    throw new Error(
      `Node type change requires replacement: ${source.bridgeId} (${node.type} → ${expected})`,
    );
}

async function applySyncPlan(
  document: BridgeDocument,
  root: SceneNode,
  plan: SyncPlan,
  context: WriteContext,
): Promise<void> {
  const sources = new Map<string, BridgeNode>();
  visit(document.root, (node) => sources.set(node.bridgeId, node));

  for (const operation of plan.operations) {
    if (operation.type !== "create") continue;
    const source = sources.get(operation.bridgeId);
    if (!source)
      throw new Error(`Create source missing: ${operation.bridgeId}`);
    const parent = operation.parentBridgeId
      ? context.nodes.get(operation.parentBridgeId)
      : figma.currentPage;
    if (!parent || !("children" in parent))
      throw new Error(`Create parent missing: ${operation.parentBridgeId}`);
    const node = createNodeShallow(source, parent, context);
    parent.insertChild(
      Math.min(operation.index, parent.children.length - 1),
      node,
    );
  }

  for (const operation of plan.operations) {
    if (operation.type !== "update") continue;
    const source = sources.get(operation.bridgeId);
    const node = context.nodes.get(operation.bridgeId);
    if (!source || !node)
      throw new Error(`Update mapping missing: ${operation.bridgeId}`);
    const parent = node.parent;
    if (!parent || !("children" in parent))
      throw new Error(`Update parent missing: ${operation.bridgeId}`);
    applyNodeProperties(node, source, parent, context);
  }

  for (const operation of plan.operations) {
    if (operation.type !== "move") continue;
    const node = context.nodes.get(operation.bridgeId);
    const parent = operation.parentBridgeId
      ? context.nodes.get(operation.parentBridgeId)
      : figma.currentPage;
    if (!node || !parent || !("children" in parent))
      throw new Error(`Move mapping missing: ${operation.bridgeId}`);
    parent.insertChild(Math.min(operation.index, parent.children.length), node);
  }

  for (const operation of plan.operations) {
    if (operation.type !== "delete") continue;
    const node = context.nodes.get(operation.bridgeId);
    if (!node) continue;
    node.remove();
    context.nodes.delete(operation.bridgeId);
  }

  for (const [bridgeId, node] of context.nodes)
    node.setPluginData(AUTHORED_HASH_KEY, context.hashes[bridgeId] ?? "");
  context.nodes.set(document.root.bridgeId, root);
}

function createNativeNode(
  source: BridgeNode,
  context: WriteContext,
): SceneNode {
  if (source.icon) {
    const svg = context.assetData[source.icon.assetId];
    if (!svg) throw new Error(`SVG data missing for ${source.icon.assetId}`);
    return figma.createNodeFromSvg(svg);
  }
  switch (source.kind) {
    case "frame":
    case "group":
      return figma.createFrame();
    case "component":
      return figma.createComponent();
    case "rectangle":
      return figma.createRectangle();
    case "ellipse":
      return figma.createEllipse();
    case "polygon": {
      const polygon = figma.createPolygon();
      polygon.pointCount = source.polygonSides ?? 3;
      return polygon;
    }
    case "text":
      return figma.createText();
    case "path": {
      const path = source.path;
      if (!path) throw new Error(`Path data missing for ${source.bridgeId}`);
      const [x, y, width, height] = path.viewBox;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${width} ${height}"><path d="${escapeXml(path.data)}" fill="black" fill-rule="${path.windingRule}"/></svg>`;
      return figma.createNodeFromSvg(svg);
    }
    case "instance": {
      const component = source.instance
        ? context.nodes.get(source.instance.componentBridgeId)
        : undefined;
      if (component?.type === "COMPONENT") return component.createInstance();
      context.warnings.push(`Flattened unresolved instance ${source.name}`);
      return figma.createFrame();
    }
  }
}

function applySize(node: SceneNode, source: BridgeNode): void {
  if (!("resize" in node)) return;
  const width =
    source.width.mode === "fixed"
      ? source.width.value
      : source.bounds.width || source.width.fallback || 1;
  const height =
    source.height.mode === "fixed"
      ? source.height.value
      : source.bounds.height || source.height.fallback || 1;
  node.resize(Math.max(0.01, width), Math.max(0.01, height));
}

function applyGeometry(
  node: SceneNode,
  source: BridgeNode,
  context: WriteContext,
): void {
  if ("clipsContent" in node) node.clipsContent = source.clipsContent ?? false;
  if (source.icon) {
    const tint = source.fills?.find((paint) => paint.type === "solid");
    if (tint?.type === "solid") tintSvg(node, tint);
  } else if ("fills" in node) {
    node.fills = (source.fills ?? []).map((paint) =>
      toFigmaPaint(paint, context),
    );
  }
  if ("strokes" in node) {
    node.strokes = (source.stroke?.paints ?? []).map((paint) =>
      toFigmaPaint(paint, context),
    );
  }
  if ("strokes" in node && source.stroke) {
    node.strokeAlign =
      source.stroke.alignment === "outside"
        ? "OUTSIDE"
        : source.stroke.alignment === "center"
          ? "CENTER"
          : "INSIDE";
    const weights = source.stroke.weights;
    if (
      weights.top === weights.right &&
      weights.top === weights.bottom &&
      weights.top === weights.left
    ) {
      node.strokeWeight = weights.top;
    } else if ("strokeTopWeight" in node) {
      node.strokeTopWeight = weights.top;
      node.strokeRightWeight = weights.right;
      node.strokeBottomWeight = weights.bottom;
      node.strokeLeftWeight = weights.left;
    } else context.warnings.push(`Flattened per-side stroke on ${source.name}`);
  }
  if ("effects" in node) {
    node.effects = (source.effects ?? []).map((effect): Effect => {
      if (!("color" in effect)) {
        return {
          type: effect.type === "blur" ? "LAYER_BLUR" : "BACKGROUND_BLUR",
          visible: effect.visible,
          radius: effect.radius,
          blurType: "NORMAL",
        };
      }
      return {
        type: effect.type === "inner-shadow" ? "INNER_SHADOW" : "DROP_SHADOW",
        visible: effect.visible,
        color: effect.color,
        offset: effect.offset,
        radius: effect.radius,
        spread: effect.spread,
        blendMode: "NORMAL",
      };
    });
  }
  if (source.cornerRadii && "topLeftRadius" in node) {
    [
      node.topLeftRadius,
      node.topRightRadius,
      node.bottomRightRadius,
      node.bottomLeftRadius,
    ] = source.cornerRadii;
  } else if ("topLeftRadius" in node) {
    node.topLeftRadius = 0;
    node.topRightRadius = 0;
    node.bottomRightRadius = 0;
    node.bottomLeftRadius = 0;
  }
  if (node.type === "TEXT" && source.text) applyText(node, source);
}

function applyText(node: TextNode, source: BridgeNode): void {
  const text = source.text!;
  node.fontName = { family: text.style.family, style: text.style.style };
  node.fontSize = text.style.size;
  node.characters = text.characters;
  node.textAlignHorizontal =
    text.style.horizontalAlign.toUpperCase() as TextNode["textAlignHorizontal"];
  node.textAlignVertical =
    text.style.verticalAlign === "center"
      ? "CENTER"
      : (text.style.verticalAlign.toUpperCase() as TextNode["textAlignVertical"]);
  node.letterSpacing = { unit: "PIXELS", value: text.style.letterSpacing };
  node.lineHeight =
    text.style.lineHeight.unit === "auto"
      ? { unit: "AUTO" }
      : {
          unit: text.style.lineHeight.unit === "pixels" ? "PIXELS" : "PERCENT",
          value: text.style.lineHeight.value,
        };
  node.textDecoration =
    text.style.decoration === "underline"
      ? "UNDERLINE"
      : text.style.decoration === "strikethrough"
        ? "STRIKETHROUGH"
        : "NONE";
  node.textAutoResize =
    text.resize === "auto"
      ? "WIDTH_AND_HEIGHT"
      : text.resize === "height"
        ? "HEIGHT"
        : "NONE";
}

function applyLayout(
  node: FrameNode | ComponentNode,
  source: BridgeNode,
): void {
  const layout = source.layout;
  if (!layout || layout.mode === "none") {
    node.layoutMode = "NONE";
    return;
  }
  node.layoutMode = layout.mode === "horizontal" ? "HORIZONTAL" : "VERTICAL";
  const horizontal = layout.mode === "horizontal";
  const primarySizing = horizontal ? source.width : source.height;
  const counterSizing = horizontal ? source.height : source.width;
  node.primaryAxisSizingMode = primarySizing.mode === "hug" ? "AUTO" : "FIXED";
  node.counterAxisSizingMode = counterSizing.mode === "hug" ? "AUTO" : "FIXED";
  node.itemSpacing = layout.gap;
  node.paddingTop = layout.padding.top;
  node.paddingRight = layout.padding.right;
  node.paddingBottom = layout.padding.bottom;
  node.paddingLeft = layout.padding.left;
  node.primaryAxisAlignItems =
    layout.primaryAlign === "center"
      ? "CENTER"
      : layout.primaryAlign === "end"
        ? "MAX"
        : layout.primaryAlign === "space-between" ||
            layout.primaryAlign === "space-around"
          ? "SPACE_BETWEEN"
          : "MIN";
  node.counterAxisAlignItems =
    layout.counterAlign === "center"
      ? "CENTER"
      : layout.counterAlign === "end"
        ? "MAX"
        : "MIN";
}

function applySizingMode(
  node: SceneNode,
  source: BridgeNode,
  parent: BaseNode & ChildrenMixin,
): void {
  if (!("layoutSizingHorizontal" in node)) return;
  if (!("layoutMode" in parent) || parent.layoutMode === "NONE") return;
  if (source.layoutPosition === "absolute") return;
  const canHug =
    node.type === "TEXT" ||
    ("layoutMode" in node && node.layoutMode !== "NONE");
  node.layoutSizingHorizontal =
    source.width.mode === "fill"
      ? "FILL"
      : source.width.mode === "hug" && canHug
        ? "HUG"
        : "FIXED";
  node.layoutSizingVertical =
    source.height.mode === "fill"
      ? "FILL"
      : source.height.mode === "hug" && canHug
        ? "HUG"
        : "FIXED";
}

function applyLayoutPosition(
  node: SceneNode,
  source: BridgeNode,
  parent: BaseNode & ChildrenMixin,
): void {
  if (!("layoutPosition" in node)) return;
  if (!("layoutMode" in parent) || parent.layoutMode === "NONE") return;
  node.layoutPosition =
    source.layoutPosition === "absolute" ? "ABSOLUTE" : "AUTO";
}

function toFigmaPaint(
  paint: Paint,
  context: WriteContext,
): SolidPaint | GradientPaint | ImagePaint {
  if (paint.type === "solid") {
    return {
      type: "SOLID",
      visible: paint.visible,
      opacity: paint.opacity * paint.color.a,
      blendMode: "NORMAL",
      color: paint.color,
    };
  }
  if (paint.type === "gradient") {
    return {
      type:
        paint.gradientType === "radial"
          ? "GRADIENT_RADIAL"
          : paint.gradientType === "angular"
            ? "GRADIENT_ANGULAR"
            : "GRADIENT_LINEAR",
      visible: paint.visible,
      opacity: paint.opacity,
      blendMode: "NORMAL",
      gradientStops: paint.stops.map((stop) => ({
        position: stop.position,
        color: stop.color,
      })),
      gradientTransform: paint.transform,
    };
  }
  const imageHash = context.images.get(paint.assetId);
  if (!imageHash)
    throw new Error(`Image asset ${paint.assetId} has not been uploaded`);
  return {
    type: "IMAGE",
    visible: paint.visible,
    opacity: paint.opacity,
    blendMode: "NORMAL",
    imageHash,
    scaleMode:
      paint.scaleMode === "fit"
        ? "FIT"
        : paint.scaleMode === "stretch"
          ? "FILL"
          : paint.scaleMode === "tile"
            ? "TILE"
            : "FILL",
  };
}

function tintSvg(
  node: SceneNode,
  paint: Extract<Paint, { type: "solid" }>,
): void {
  if ("fills" in node && node.type !== "FRAME") {
    node.fills = [toSolidPaint(paint)];
  }
  if ("strokes" in node && node.strokes.length) {
    node.strokes = [toSolidPaint(paint)];
  }
  if ("children" in node) {
    for (const child of node.children) tintSvg(child, paint);
  }
}

function toSolidPaint(paint: Extract<Paint, { type: "solid" }>): SolidPaint {
  return {
    type: "SOLID",
    visible: paint.visible,
    opacity: paint.opacity * paint.color.a,
    blendMode: "NORMAL",
    color: paint.color,
  };
}

function visit(node: BridgeNode, callback: (node: BridgeNode) => void): void {
  callback(node);
  for (const child of node.children) visit(child, callback);
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
