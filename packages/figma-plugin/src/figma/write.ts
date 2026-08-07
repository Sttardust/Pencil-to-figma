import {
  bridgeDocumentSchema,
  type BridgeDocument,
  type BridgeNode,
  type Paint,
} from "@pen-fig/bridge-schema";

export interface WriteResult {
  rootId: string;
  nodeCount: number;
  warnings: string[];
}

export async function writeBridgeDocument(
  input: unknown,
  assetData: Record<string, string> = {},
): Promise<WriteResult> {
  const document = bridgeDocumentSchema.parse(input);
  await preflightFonts(document);
  await figma.currentPage.loadAsync();
  const context: WriteContext = {
    nodes: new Map(),
    images: new Map(),
    assetData,
    nodeCount: 0,
    warnings: [],
  };
  for (const asset of document.assets) {
    if (asset.status === "ready" && asset.kind === "image") {
      const encoded = assetData[asset.id];
      if (!encoded) throw new Error(`Image data missing for ${asset.id}`);
      context.images.set(
        asset.id,
        figma.createImage(figma.base64Decode(encoded)).hash,
      );
    }
  }
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
  const node = createNativeNode(source, context);
  parent.appendChild(node);
  context.nodes.set(source.bridgeId, node);
  context.nodeCount += 1;
  node.name = source.name;
  node.visible = source.visible;
  if ("opacity" in node) node.opacity = source.opacity;
  node.locked = source.locked;
  if ("rotation" in node) node.rotation = source.rotation;
  node.setPluginData("penFigBridgeId", source.bridgeId);
  node.setPluginData("penFigSchema", "1");
  applyLayoutPosition(node, source, parent);
  applySize(node, source);
  node.x = source.bounds.x;
  node.y = source.bounds.y;
  applyGeometry(node, source, context);

  if ("children" in node) {
    if (node.type === "FRAME" || node.type === "COMPONENT")
      applyLayout(node, source);
    for (const child of source.children) await createNode(child, node, context);
  }
  applySizingMode(node, source, parent);
  return node;
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
  if ("clipsContent" in node && source.clipsContent !== undefined)
    node.clipsContent = source.clipsContent;
  if (source.icon) {
    const tint = source.fills?.find((paint) => paint.type === "solid");
    if (tint?.type === "solid") tintSvg(node, tint);
  } else if ("fills" in node && source.fills) {
    node.fills = source.fills.map((paint) => toFigmaPaint(paint, context));
  }
  if ("strokes" in node && source.stroke) {
    node.strokes = source.stroke.paints.map((paint) =>
      toFigmaPaint(paint, context),
    );
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
  if ("effects" in node && source.effects) {
    node.effects = source.effects.map((effect): Effect => {
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
  node.layoutSizingHorizontal =
    source.width.mode === "fill"
      ? "FILL"
      : source.width.mode === "hug"
        ? "HUG"
        : "FIXED";
  node.layoutSizingVertical =
    source.height.mode === "fill"
      ? "FILL"
      : source.height.mode === "hug"
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
