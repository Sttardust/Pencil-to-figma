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
  BRIDGE_KIND_KEY,
  INSTANCE_OVERRIDE_MAP_KEY,
  SVG_ASSET_KEY,
  findMappedRoots,
  readMappedSubtree,
} from "./identity.js";
import { directFontCandidates, fontKey } from "./fonts.js";

const WRITE_SCHEMA_VERSION = "2";

export interface WriteResult {
  rootId: string;
  nodeCount: number;
  operation: "created" | "unchanged" | "updated";
  operations?: SyncPlan["counts"];
  mappings: Array<{ bridgeId: string; figmaNodeId: string }>;
  figmaBaselineHashes: Record<string, string>;
  warnings: string[];
}

export interface PreviewResult {
  rootId?: string;
  nodeCount: number;
  operation: "created" | "unchanged" | "updated";
  operations: SyncPlan["counts"];
  warnings: string[];
}

export interface NodeUpdateResult {
  rootId: string;
  updatedNodeCount: number;
  updatedBridgeIds: string[];
}

export async function previewBridgeDocument(
  input: unknown,
): Promise<PreviewResult> {
  const document = bridgeDocumentSchema.parse(input);
  await figma.currentPage.loadAsync();
  const fontWarnings = await preflightFonts(document);
  const mappedRoots = findMappedRoots(
    figma.currentPage,
    document.root.bridgeId,
  );
  if (mappedRoots.length > 1)
    throw new Error(
      `Duplicate bridge identities require remapping: ${document.root.bridgeId} (${mappedRoots.map((root) => root.id).join(", ")})`,
    );
  const mappedRoot = mappedRoots[0];
  const mapped = mappedRoot ? readMappedSubtree(mappedRoot) : undefined;
  const plan = planPenToFigmaSync(
    document,
    mapped ? recordsForWriter(document, mapped) : [],
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
    warnings: [
      ...document.warnings.map((warning) => warning.message),
      ...fontWarnings,
    ],
  };
}

export async function writeBridgeDocument(
  input: unknown,
  assetData: Record<string, string> = {},
): Promise<WriteResult> {
  const document = bridgeDocumentSchema.parse(input);
  await figma.currentPage.loadAsync();
  const fontWarnings = await preflightFonts(document);
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
    const plan = planPenToFigmaSync(
      document,
      recordsForWriter(document, mapped),
    );
    if (plan.operations.length === 0) {
      figma.currentPage.selection = [mappedRoot];
      figma.viewport.scrollAndZoomIntoView([mappedRoot]);
      return {
        rootId: mappedRoot.id,
        nodeCount: 0,
        operation: "unchanged",
        operations: plan.counts,
        mappings: mappingsFromNodes(mapped.nodes, rootBridgeIds(document)),
        figmaBaselineHashes: hashes,
        warnings: [
          ...document.warnings.map((warning) => warning.message),
          ...fontWarnings,
        ],
      };
    }
    const context = prepareContext(document, assetData, hashes);
    context.warnings.push(...fontWarnings);
    for (const [bridgeId, node] of mapped.nodes)
      context.nodes.set(bridgeId, node);
    await prepareAssets(document, context);
    figma.commitUndo();
    try {
      prepareLocalComponents(document, context);
      await materializeComponentDependencies(document, context);
      await applySyncPlan(document, mappedRoot, plan, context);
      discardUnusedPreparedComponents(context);
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
      mappings: mappingsFromNodes(context.nodes, rootBridgeIds(document)),
      figmaBaselineHashes: hashes,
      warnings: [
        ...document.warnings.map((warning) => warning.message),
        ...context.warnings,
      ],
    };
  }
  const context = prepareContext(document, assetData, hashes);
  context.warnings.push(...fontWarnings);
  await prepareAssets(document, context);
  let root: SceneNode | undefined;
  try {
    prepareLocalComponents(document, context);
    await materializeComponentDependencies(document, context);
    root = await createNode(document.root, figma.currentPage, context);
    discardUnusedPreparedComponents(context);
    const center = figma.viewport.center;
    root.x = center.x - root.width / 2;
    root.y = center.y - root.height / 2;
    figma.currentPage.selection = [root];
    figma.viewport.scrollAndZoomIntoView([root]);
    return {
      rootId: root.id,
      nodeCount: rootBridgeIds(document).size,
      operation: "created",
      mappings: mappingsFromNodes(context.nodes, rootBridgeIds(document)),
      figmaBaselineHashes: hashes,
      warnings: [
        ...document.warnings.map((warning) => warning.message),
        ...context.warnings,
      ],
    };
  } catch (error) {
    root?.remove();
    removeCreatedComponents(context);
    throw error;
  }
}

export async function writeBridgeNodeUpdates(
  input: unknown,
  bridgeIds: string[],
  assetData: Record<string, string> = {},
): Promise<NodeUpdateResult> {
  const document = bridgeDocumentSchema.parse(input);
  if (!bridgeIds.length || bridgeIds.length > 40)
    throw new Error("Conflict resolution must update 1–40 mapped nodes");
  await figma.currentPage.loadAsync();
  const mappedRoots = findMappedRoots(
    figma.currentPage,
    document.root.bridgeId,
  );
  if (mappedRoots.length !== 1)
    throw new Error(
      `Conflict resolution requires exactly one mapped root for ${document.root.bridgeId}`,
    );
  const root = mappedRoots[0]!;
  const mapped = readMappedSubtree(root);
  const sources = new Map<string, BridgeNode>();
  visit(document.root, (node) => sources.set(node.bridgeId, node));
  const uniqueBridgeIds = [...new Set(bridgeIds)];
  for (const bridgeId of uniqueBridgeIds)
    if (!sources.has(bridgeId) || !mapped.nodes.has(bridgeId))
      throw new Error(`Conflict mapping missing ${bridgeId}`);
  await preflightFonts(document);
  const hashes = authoredDocumentHashes(document);
  const context = prepareContext(document, assetData, hashes);
  for (const [bridgeId, node] of mapped.nodes)
    context.nodes.set(bridgeId, node);
  await prepareAssets(document, context);
  figma.commitUndo();
  try {
    for (const bridgeId of uniqueBridgeIds) {
      const source = sources.get(bridgeId)!;
      const node = mapped.nodes.get(bridgeId)!;
      const parent = node.parent;
      if (!parent || !("children" in parent))
        throw new Error(`Conflict parent missing ${bridgeId}`);
      applyNodeProperties(node, source, parent, context);
    }
    figma.currentPage.selection = [root];
    figma.commitUndo();
  } catch (error) {
    figma.triggerUndo();
    throw error;
  }
  return {
    rootId: root.id,
    updatedNodeCount: uniqueBridgeIds.length,
    updatedBridgeIds: uniqueBridgeIds,
  };
}

function mappingsFromNodes(
  nodes: Map<string, SceneNode>,
  includedBridgeIds?: ReadonlySet<string>,
): Array<{ bridgeId: string; figmaNodeId: string }> {
  return [...nodes]
    .filter(
      ([bridgeId]) => !includedBridgeIds || includedBridgeIds.has(bridgeId),
    )
    .map(([bridgeId, node]) => ({
      bridgeId,
      figmaNodeId: node.id,
    }));
}

function rootBridgeIds(document: BridgeDocument): Set<string> {
  const bridgeIds = new Set<string>();
  visit(document.root, (node) => bridgeIds.add(node.bridgeId));
  return bridgeIds;
}

function recordsForWriter(
  document: BridgeDocument,
  mapped: ReturnType<typeof readMappedSubtree>,
): ReturnType<typeof readMappedSubtree>["records"] {
  const instanceIds = new Set<string>();
  visit(document.root, (node) => {
    if (node.kind === "instance") instanceIds.add(node.bridgeId);
  });
  return mapped.records.map((record) => {
    const node = mapped.nodes.get(record.bridgeId);
    return instanceIds.has(record.bridgeId) &&
      node?.getPluginData("penFigSchema") !== WRITE_SCHEMA_VERSION
      ? { ...record, authoredHash: "" }
      : record;
  });
}

interface WriteContext {
  nodes: Map<string, SceneNode>;
  images: Map<string, string>;
  assetData: Record<string, string>;
  nodeCount: number;
  warnings: string[];
  hashes: Record<string, string>;
  preparedComponents: Map<string, ComponentNode>;
  createdComponents: Set<ComponentNode>;
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
    preparedComponents: new Map(),
    createdComponents: new Set(),
  };
}

function prepareLocalComponents(
  document: BridgeDocument,
  context: WriteContext,
): void {
  const prepare = (source: BridgeNode) => {
    if (source.kind !== "component" || context.nodes.has(source.bridgeId))
      return;
    const existing = findMappedRoots(figma.currentPage, source.bridgeId).filter(
      (node): node is ComponentNode => node.type === "COMPONENT",
    );
    if (existing.length > 1)
      throw new Error(
        `Duplicate component identity ${source.bridgeId}: ${existing.map((node) => node.id).join(", ")}`,
      );
    if (existing[0]) {
      context.nodes.set(source.bridgeId, existing[0]);
      return;
    }
    const component = figma.createComponent();
    context.nodes.set(source.bridgeId, component);
    context.preparedComponents.set(source.bridgeId, component);
    context.createdComponents.add(component);
  };
  for (const component of document.components ?? []) visit(component, prepare);
  visit(document.root, prepare);
}

async function materializeComponentDependencies(
  document: BridgeDocument,
  context: WriteContext,
): Promise<void> {
  for (const source of document.components ?? []) {
    const existing = context.nodes.get(source.bridgeId);
    if (existing && !context.preparedComponents.has(source.bridgeId)) {
      if (existing.type !== "COMPONENT")
        throw new Error(
          `Component mapping is not a component: ${source.bridgeId}`,
        );
      const parent = existing.parent;
      if (!parent || !("children" in parent))
        throw new Error(`Component parent is missing: ${source.bridgeId}`);
      applyNodeProperties(existing, source, parent, context);
      continue;
    }
    await createNode(source, figma.currentPage, context);
  }
}

function removePreparedComponents(context: WriteContext): void {
  for (const component of context.preparedComponents.values()) {
    if (component.parent) component.remove();
    context.createdComponents.delete(component);
  }
  context.preparedComponents.clear();
}

function removeCreatedComponents(context: WriteContext): void {
  for (const component of context.createdComponents)
    if (component.parent) component.remove();
  context.createdComponents.clear();
  context.preparedComponents.clear();
}

function discardUnusedPreparedComponents(context: WriteContext): void {
  if (!context.preparedComponents.size) return;
  for (const [bridgeId] of context.preparedComponents)
    context.warnings.push(
      `COMPONENT_DEFINITION_SKIPPED: ${bridgeId} was nested inside a derived instance`,
    );
  removePreparedComponents(context);
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

async function preflightFonts(document: BridgeDocument): Promise<string[]> {
  const fonts = new Map<string, { font: FontName; nodes: BridgeNode[] }>();
  visit(document.root, (node) => {
    if (node.text) {
      const font = {
        family: node.text.style.family,
        style: node.text.style.style,
      };
      const key = fontKey(font);
      const entry = fonts.get(key) ?? { font, nodes: [] };
      entry.nodes.push(node);
      fonts.set(key, entry);
    }
  });
  for (const component of document.components ?? [])
    visit(component, (node) => {
      if (node.text) {
        const font = {
          family: node.text.style.family,
          style: node.text.style.style,
        };
        const key = fontKey(font);
        const entry = fonts.get(key) ?? { font, nodes: [] };
        entry.nodes.push(node);
        fonts.set(key, entry);
      }
    });
  if (!fonts.size) return [];
  const warnings: string[] = [];
  const loaded = new Set<string>();
  for (const { font, nodes } of fonts.values()) {
    let selected: FontName | undefined;
    for (const candidate of directFontCandidates(font)) {
      const key = fontKey(candidate);
      try {
        if (!loaded.has(key)) {
          await loadFontWithTimeout(candidate);
          loaded.add(key);
        }
        selected = candidate;
        break;
      } catch {
        // Try the next available face if Figma cannot materialize this one.
      }
    }
    if (!selected)
      throw new Error(
        `No loadable Figma font for ${font.family} ${font.style}`,
      );
    if (fontKey(selected) === fontKey(font)) continue;
    for (const node of nodes) {
      if (!node.text) continue;
      node.text.style.family = selected.family;
      node.text.style.style = selected.style;
    }
    warnings.push(
      `FONT_SUBSTITUTED: ${font.family} ${font.style} → ${selected.family} ${selected.style} (${nodes.length} text ${nodes.length === 1 ? "node" : "nodes"})`,
    );
  }
  return warnings;
}

async function loadFontWithTimeout(font: FontName): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      figma.loadFontAsync(font),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out loading ${font.family}`)),
          5_000,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function createNode(
  source: BridgeNode,
  parent: BaseNode & ChildrenMixin,
  context: WriteContext,
): Promise<SceneNode> {
  const node = createNodeShallow(source, parent, context);
  if ("children" in node && node.type !== "INSTANCE") {
    for (const child of source.children) await createNode(child, node, context);
  } else if (node.type === "INSTANCE" && source.children.length) {
    context.warnings.push(
      `INSTANCE_CHILDREN_DERIVED: ${source.name} uses its component's child structure`,
    );
  }
  applySizingMode(node, source, parent);
  return node;
}

function createNodeShallow(
  source: BridgeNode,
  parent: BaseNode & ChildrenMixin,
  context: WriteContext,
): SceneNode {
  const node =
    context.preparedComponents.get(source.bridgeId) ??
    createNativeNode(source, context);
  parent.appendChild(node);
  context.preparedComponents.delete(source.bridgeId);
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
  if (node.type === "INSTANCE" && source.source.app === "pen")
    node.removeOverrides();
  node.name = source.name;
  node.visible = source.visible;
  if ("opacity" in node) node.opacity = source.opacity;
  node.locked = source.locked;
  if ("rotation" in node) node.rotation = source.rotation;
  node.setPluginData(BRIDGE_ID_KEY, source.bridgeId);
  node.setPluginData(BRIDGE_KIND_KEY, source.kind);
  node.setPluginData(SVG_ASSET_KEY, source.icon?.assetId ?? "");
  node.setPluginData(AUTHORED_HASH_KEY, context.hashes[source.bridgeId] ?? "");
  node.setPluginData("penFigSchema", WRITE_SCHEMA_VERSION);
  applyLayoutPosition(node, source, parent);
  applySize(node, source);
  node.x = source.bounds.x;
  node.y = source.bounds.y;
  applyGeometry(node, source, context);
  if (node.type === "INSTANCE" && source.kind === "instance")
    applyInstanceOverrides(node, source, context);
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
                  ? node.type === "FRAME"
                    ? "FRAME"
                    : "INSTANCE"
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
      if (component?.type === "COMPONENT") {
        return component.createInstance();
      }
      context.warnings.push(
        `INSTANCE_COMPONENT_UNRESOLVED: Flattened ${source.name}`,
      );
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
  } else if (
    "fills" in node &&
    (source.fills !== undefined || node.type !== "INSTANCE")
  ) {
    node.fills = (source.fills ?? []).map((paint) =>
      toFigmaPaint(paint, context),
    );
  }
  if (
    "strokes" in node &&
    (source.stroke !== undefined || node.type !== "INSTANCE")
  ) {
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
  if (
    "effects" in node &&
    (source.effects !== undefined || node.type !== "INSTANCE")
  ) {
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
  } else if ("topLeftRadius" in node && node.type !== "INSTANCE") {
    node.topLeftRadius = 0;
    node.topRightRadius = 0;
    node.bottomRightRadius = 0;
    node.bottomLeftRadius = 0;
  }
  if (node.type === "TEXT" && source.text) applyText(node, source);
}

function applyInstanceOverrides(
  instance: InstanceNode,
  source: BridgeNode,
  context: WriteContext,
): void {
  const overrides = source.instance?.overrides ?? {};
  if (source.source.app === "figma") {
    const properties = Object.fromEntries(
      Object.entries(overrides).filter(
        (entry): entry is [string, string | boolean] =>
          typeof entry[1] === "string" || typeof entry[1] === "boolean",
      ),
    );
    if (!Object.keys(properties).length) return;
    try {
      instance.setProperties(properties);
    } catch {
      context.warnings.push(
        `INSTANCE_OVERRIDES_SKIPPED: ${source.name} has incompatible component properties`,
      );
    }
    return;
  }

  const component = source.instance
    ? context.nodes.get(source.instance.componentBridgeId)
    : undefined;
  if (component?.type !== "COMPONENT") {
    if (Object.keys(overrides).length)
      context.warnings.push(
        `INSTANCE_OVERRIDES_SKIPPED: ${source.name} has no editable component definition`,
      );
    return;
  }

  const propertyValues: Record<string, string | boolean> = {};
  const propertyMap: Record<string, { bridgeId: string; property: "content" }> =
    {};
  for (const [bridgeId, rawOverride] of Object.entries(overrides)) {
    if (!rawOverride || typeof rawOverride !== "object") {
      context.warnings.push(
        `INSTANCE_OVERRIDE_UNSUPPORTED: ${source.name} has an invalid override for ${bridgeId}`,
      );
      continue;
    }
    const override = rawOverride as Record<string, unknown>;
    const target = component.findOne(
      (node) => node.getPluginData(BRIDGE_ID_KEY) === bridgeId,
    );
    if (!target) {
      context.warnings.push(
        `INSTANCE_OVERRIDE_TARGET_MISSING: ${source.name} cannot find ${bridgeId}`,
      );
      continue;
    }
    if (typeof override.content === "string" && target.type === "TEXT") {
      let propertyName = target.componentPropertyReferences?.characters;
      if (!propertyName) {
        propertyName = component.addComponentProperty(
          `Pen ${target.name}`.slice(0, 80),
          "TEXT",
          target.characters,
        );
        target.componentPropertyReferences = {
          ...(target.componentPropertyReferences ?? {}),
          characters: propertyName,
        };
      }
      propertyValues[propertyName] = override.content;
      propertyMap[propertyName] = { bridgeId, property: "content" };
    } else if (override.content !== undefined) {
      context.warnings.push(
        `INSTANCE_OVERRIDE_UNSUPPORTED: ${source.name} content override does not target text`,
      );
    }
    const unsupported = Object.keys(override).filter(
      (property) => property !== "content",
    );
    if (unsupported.length)
      context.warnings.push(
        `INSTANCE_OVERRIDE_UNSUPPORTED: ${source.name} skipped ${unsupported.join(", ")} on ${bridgeId}`,
      );
  }
  try {
    if (Object.keys(propertyValues).length)
      instance.setProperties(propertyValues);
    instance.setPluginData(
      INSTANCE_OVERRIDE_MAP_KEY,
      JSON.stringify(propertyMap),
    );
  } catch {
    context.warnings.push(
      `INSTANCE_OVERRIDES_SKIPPED: ${source.name} could not apply component properties`,
    );
  }
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
