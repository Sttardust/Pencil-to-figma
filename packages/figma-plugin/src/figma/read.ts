import {
  bridgeDocumentSchema,
  type BridgeAsset,
  type BridgeDocument,
  type BridgeNode,
  type BridgeVariable,
  type Effect,
  type Paint,
  type TransferWarning,
} from "@pen-fig/bridge-schema";
import {
  BRIDGE_ID_KEY,
  BRIDGE_KIND_KEY,
  INSTANCE_OVERRIDE_MAP_KEY,
  SVG_ASSET_KEY,
  VARIABLE_ID_KEY,
  VARIABLE_MODE_MAP_KEY,
} from "./identity.js";
import { fromFigmaLayoutPositioning } from "./layout-position.js";
import { longestTextSegment } from "./text.js";

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

interface NativeVariableReadContext {
  bridgeIdByFigmaId: ReadonlyMap<string, string>;
  variablesByBridgeId: ReadonlyMap<string, BridgeVariable>;
}

export const MAX_FIGMA_EXPORT_SCREENS = 12;

export async function readSelectedFigmaDocument(
  options: { collectAssetData?: boolean } = {},
): Promise<FigmaReadResult> {
  await figma.currentPage.loadAsync();
  const selected = resolveFigmaExportRoot(figma.currentPage.selection);
  return readFigmaDocument(selected, options, await readNativeVariables());
}

export async function readSelectedFigmaDocuments(
  options: { collectAssetData?: boolean } = {},
): Promise<FigmaReadResult[]> {
  await figma.currentPage.loadAsync();
  const selected = resolveFigmaExportRoots(figma.currentPage.selection);
  if (selected.length > MAX_FIGMA_EXPORT_SCREENS)
    throw new Error(
      `Select no more than ${MAX_FIGMA_EXPORT_SCREENS} Figma screens at once`,
    );
  const nativeVariables = await readNativeVariables();
  const results: FigmaReadResult[] = [];
  for (const root of selected)
    results.push(await readFigmaDocument(root, options, nativeVariables));
  return results;
}

async function readFigmaDocument(
  selected: FrameNode | ComponentNode,
  options: { collectAssetData?: boolean },
  nativeVariables: NativeVariableReadContext,
): Promise<FigmaReadResult> {
  const documentId = figma.fileKey ?? "figma-local";
  const assets: BridgeAsset[] = [];
  const warnings: TransferWarning[] = [];
  const fonts = new Set<string>();
  const dependencies = await loadComponentDependencies(selected);
  let nodeCount = 0;
  const root = readNode(
    selected,
    documentId,
    assets,
    warnings,
    fonts,
    dependencies.instanceComponents,
    nativeVariables,
    () => {
      nodeCount += 1;
    },
  );
  const selectedNodeIds = collectSceneNodeIds(selected);
  const components = dependencies.components
    .filter((component) => !selectedNodeIds.has(component.id))
    .map((component) =>
      readNode(
        component,
        documentId,
        assets,
        warnings,
        fonts,
        dependencies.instanceComponents,
        nativeVariables,
        () => {
          nodeCount += 1;
        },
      ),
    );
  removeDerivedInstanceChildren(root, components);
  nodeCount =
    countBridgeNodes(root) +
    components.reduce(
      (total, component) => total + countBridgeNodes(component),
      0,
    );
  const referencedVariableIds = collectReferencedVariableIds(root, components);
  const document = bridgeDocumentSchema.parse({
    version: 1,
    source: { app: "figma", documentId },
    root,
    ...(components.length ? { components } : {}),
    assets,
    variables: [...referencedVariableIds]
      .map((bridgeId) => nativeVariables.variablesByBridgeId.get(bridgeId))
      .filter((variable): variable is BridgeVariable => Boolean(variable)),
    warnings,
  });
  return {
    document,
    nodeCount,
    fonts: [...fonts].sort(),
    assetData:
      options.collectAssetData === false
        ? {}
        : await collectAssetData(document.assets),
  };
}

export function resolveFigmaExportRoot(
  selection: readonly SceneNode[],
): FrameNode | ComponentNode {
  const roots = resolveFigmaExportRoots(selection);
  if (roots.length !== 1)
    throw new Error(
      "Select one Figma screen for comparison. Multi-screen selection is available when sending copies to Pencil.",
    );
  return roots[0]!;
}

export function resolveFigmaExportRoots(
  selection: readonly SceneNode[],
): Array<FrameNode | ComponentNode> {
  if (!selection.length)
    throw new Error("Select a Figma screen, or any layer inside it");

  const roots = new Map<string, FrameNode | ComponentNode>();
  for (const node of selection) {
    if (node.type === "SECTION") {
      collectExportRootsFromContainer(node, roots);
      if (!roots.size)
        throw new Error(`“${node.name}” does not contain any Figma screens`);
      continue;
    }
    let current: BaseNode | null = node;
    let root: FrameNode | ComponentNode | undefined;
    while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
      if (current.type === "FRAME" || current.type === "COMPONENT")
        root = current;
      current = current.parent;
    }
    if (!root)
      throw new Error(
        `“${node.name}” is not inside a Figma frame. Select the full screen instead.`,
      );
    roots.set(root.id, root);
  }

  return [...roots.values()];
}

function collectExportRootsFromContainer(
  container: ChildrenMixin,
  roots: Map<string, FrameNode | ComponentNode>,
): void {
  for (const child of container.children) {
    if (child.type === "FRAME" || child.type === "COMPONENT") {
      roots.set(child.id, child);
      continue;
    }
    if ("children" in child) collectExportRootsFromContainer(child, roots);
  }
}

async function readNativeVariables(): Promise<NativeVariableReadContext> {
  const [variables, collections] = await Promise.all([
    figma.variables.getLocalVariablesAsync(),
    figma.variables.getLocalVariableCollectionsAsync(),
  ]);
  const collectionsById = new Map(
    collections.map((collection) => [collection.id, collection]),
  );
  const bridgeIdByFigmaId = new Map<string, string>();
  const variablesByBridgeId = new Map<string, BridgeVariable>();
  for (const variable of variables) {
    const type = fromFigmaVariableType(variable.resolvedType);
    const collection = collectionsById.get(variable.variableCollectionId);
    if (!type || !collection) continue;
    const bridgeId =
      variable.getPluginData(VARIABLE_ID_KEY) || `figma-var:${variable.id}`;
    const modeRecords = readVariableModeRecords(collection);
    const values: BridgeVariable["values"] = [];
    for (const mode of collection.modes) {
      const value = toBridgeVariableValue(
        variable.valuesByMode[mode.modeId],
        type,
      );
      if (value === undefined) continue;
      values.push({
        mode: modeRecords.get(mode.modeId) ?? { figma: mode.name },
        value,
      });
    }
    if (!values.length) continue;
    bridgeIdByFigmaId.set(variable.id, bridgeId);
    variablesByBridgeId.set(bridgeId, {
      id: bridgeId,
      name: variable.name,
      type,
      values,
    });
  }
  return { bridgeIdByFigmaId, variablesByBridgeId };
}

function readVariableModeRecords(
  collection: VariableCollection,
): Map<string, Record<string, string>> {
  const result = new Map<string, Record<string, string>>();
  try {
    const stored = JSON.parse(
      collection.getPluginData(VARIABLE_MODE_MAP_KEY) || "{}",
    ) as Record<string, string>;
    for (const [signature, modeId] of Object.entries(stored)) {
      const mode = JSON.parse(signature) as unknown;
      if (isStringRecord(mode)) result.set(modeId, mode);
    }
  } catch {
    // Unmanaged collections fall back to their visible Figma mode names.
  }
  if (collection.modes.length === 1 && !result.size)
    result.set(collection.modes[0]!.modeId, {});
  return result;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every(
      (entry) => typeof entry === "string",
    )
  );
}

function fromFigmaVariableType(
  type: VariableResolvedDataType,
): BridgeVariable["type"] | undefined {
  return type === "BOOLEAN"
    ? "boolean"
    : type === "COLOR"
      ? "color"
      : type === "FLOAT"
        ? "number"
        : type === "STRING"
          ? "string"
          : undefined;
}

function toBridgeVariableValue(
  value: VariableValue | undefined,
  type: BridgeVariable["type"],
): BridgeVariable["values"][number]["value"] | undefined {
  if (type === "boolean") return typeof value === "boolean" ? value : undefined;
  if (type === "number") return typeof value === "number" ? value : undefined;
  if (type === "string") return typeof value === "string" ? value : undefined;
  if (
    value &&
    typeof value === "object" &&
    "r" in value &&
    "g" in value &&
    "b" in value
  ) {
    const color = value as RGB | RGBA;
    return {
      r: color.r,
      g: color.g,
      b: color.b,
      a: "a" in color ? color.a : 1,
    };
  }
  return undefined;
}

async function loadComponentDependencies(root: SceneNode): Promise<{
  instanceComponents: Map<string, ComponentNode | null>;
  components: ComponentNode[];
}> {
  const instanceComponents = new Map<string, ComponentNode | null>();
  const components: ComponentNode[] = [];
  const queued: SceneNode[] = [root];
  const visitedComponentIds = new Set<string>();
  while (queued.length) {
    const owner = queued.shift()!;
    const instances = collectInstances(owner).filter(
      (instance) => !instanceComponents.has(instance.id),
    );
    await Promise.all(
      instances.map(async (instance) => {
        const component = await instance.getMainComponentAsync();
        instanceComponents.set(instance.id, component);
        if (component && !visitedComponentIds.has(component.id)) {
          visitedComponentIds.add(component.id);
          components.push(component);
          queued.push(component);
        }
      }),
    );
  }
  const orderedComponents: ComponentNode[] = [];
  const orderedIds = new Set<string>();
  const visiting = new Set<string>();
  const order = (component: ComponentNode) => {
    if (orderedIds.has(component.id) || visiting.has(component.id)) return;
    visiting.add(component.id);
    for (const instance of collectInstances(component)) {
      const dependency = instanceComponents.get(instance.id);
      if (dependency) order(dependency);
    }
    visiting.delete(component.id);
    orderedIds.add(component.id);
    orderedComponents.push(component);
  };
  for (const component of components) order(component);
  return { instanceComponents, components: orderedComponents };
}

function collectInstances(root: SceneNode): InstanceNode[] {
  const instances: InstanceNode[] = root.type === "INSTANCE" ? [root] : [];
  if ("findAll" in root)
    instances.push(
      ...root
        .findAll((node) => node.type === "INSTANCE")
        .filter((node): node is InstanceNode => node.type === "INSTANCE"),
    );
  return instances;
}

function collectSceneNodeIds(root: SceneNode): Set<string> {
  const ids = new Set([root.id]);
  if ("findAll" in root)
    for (const node of root.findAll(() => true)) ids.add(node.id);
  return ids;
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
  nativeVariables: NativeVariableReadContext,
  counted: () => void,
): BridgeNode {
  counted();
  const bridgeId = node.getPluginData(BRIDGE_ID_KEY) || `figma:${node.id}`;
  const mixedText =
    node.type === "TEXT"
      ? readMixedTextFallback(node, bridgeId, warnings)
      : undefined;
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
      "layoutPositioning" in node
        ? fromFigmaLayoutPositioning(node.layoutPositioning)
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
          nativeVariables,
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
      : readPaints(node, bridgeId, assets, warnings, mixedText?.fills);
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
  const variableBindings = readVariableBindings(node, nativeVariables);
  if (variableBindings) result.variableBindings = variableBindings;

  if (node.type === "TEXT") {
    const fontName = mixedText?.fontName ?? node.fontName;
    const fontSize = mixedText?.fontSize ?? node.fontSize;
    const lineHeight = mixedText?.lineHeight ?? node.lineHeight;
    const letterSpacing = mixedText?.letterSpacing ?? node.letterSpacing;
    const textDecoration = mixedText?.textDecoration ?? node.textDecoration;
    if (
      fontName === figma.mixed ||
      fontSize === figma.mixed ||
      lineHeight === figma.mixed ||
      letterSpacing === figma.mixed ||
      textDecoration === figma.mixed
    )
      throw new Error(`Could not resolve mixed text styling: ${node.name}`);
    fonts.add(`${fontName.family} ${fontName.style}`);
    result.text = {
      characters: node.characters,
      resize:
        node.textAutoResize === "WIDTH_AND_HEIGHT"
          ? "auto"
          : node.textAutoResize === "HEIGHT"
            ? "height"
            : "fixed",
      style: {
        family: fontName.family,
        style: fontName.style,
        weight: weightFromStyle(fontName.style),
        size: fontSize,
        lineHeight:
          lineHeight.unit === "AUTO"
            ? { unit: "auto" }
            : {
                unit: lineHeight.unit === "PIXELS" ? "pixels" : "percent",
                value: lineHeight.value,
              },
        letterSpacing:
          letterSpacing.unit === "PIXELS"
            ? letterSpacing.value
            : (letterSpacing.value / 100) * fontSize,
        horizontalAlign: node.textAlignHorizontal.toLowerCase() as
          "left" | "center" | "right" | "justify",
        verticalAlign: node.textAlignVertical.toLowerCase() as
          "top" | "center" | "bottom",
        decoration:
          textDecoration === "UNDERLINE"
            ? "underline"
            : textDecoration === "STRIKETHROUGH"
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
      overrides: readInstanceOverrides(node, component, bridgeId, warnings),
    };
  }
  return result;
}

type MixedTextFallback = Pick<
  StyledTextSegment,
  | "fontName"
  | "fontSize"
  | "lineHeight"
  | "letterSpacing"
  | "textDecoration"
  | "fills"
>;

function readMixedTextFallback(
  node: TextNode,
  bridgeId: string,
  warnings: TransferWarning[],
): MixedTextFallback | undefined {
  const hasMixedStyle =
    node.fontName === figma.mixed ||
    node.fontSize === figma.mixed ||
    node.lineHeight === figma.mixed ||
    node.letterSpacing === figma.mixed ||
    node.textDecoration === figma.mixed ||
    node.fills === figma.mixed;
  if (!hasMixedStyle) return undefined;
  const segments = node.getStyledTextSegments([
    "fontName",
    "fontSize",
    "lineHeight",
    "letterSpacing",
    "textDecoration",
    "fills",
  ]);
  const selected = longestTextSegment(segments);
  if (!selected)
    throw new Error(
      `Mixed text layer has no readable style ranges: ${node.name}`,
    );
  warnings.push(
    warning(
      bridgeId,
      "mixed text styles",
      "flatten",
      `Flattened ${segments.length} style ranges on ${node.name} using the longest range`,
    ),
  );
  return selected;
}

function readVariableBindings(
  node: SceneNode,
  context: NativeVariableReadContext,
): BridgeNode["variableBindings"] | undefined {
  const result: NonNullable<BridgeNode["variableBindings"]> = {};
  if ("fills" in node && node.fills !== figma.mixed) {
    const fills: Record<string, string> = {};
    node.fills.forEach((paint, index) => {
      const bridgeId =
        paint.type === "SOLID" && paint.boundVariables?.color
          ? context.bridgeIdByFigmaId.get(paint.boundVariables.color.id)
          : undefined;
      if (bridgeId) fills[String(index)] = bridgeId;
    });
    if (Object.keys(fills).length) result.fills = fills;
  }
  if ("strokes" in node) {
    const strokes: Record<string, string> = {};
    node.strokes.forEach((paint, index) => {
      const bridgeId =
        paint.type === "SOLID" && paint.boundVariables?.color
          ? context.bridgeIdByFigmaId.get(paint.boundVariables.color.id)
          : undefined;
      if (bridgeId) strokes[String(index)] = bridgeId;
    });
    if (Object.keys(strokes).length) result.strokes = strokes;
  }
  if (node.type === "TEXT") {
    const fontFamilyId = firstAliasId(node.boundVariables?.fontFamily);
    const bridgeId = fontFamilyId
      ? context.bridgeIdByFigmaId.get(fontFamilyId)
      : undefined;
    if (bridgeId) result.fontFamily = bridgeId;
  }
  const cornerIds = [
    firstAliasId(node.boundVariables?.cornerRadius),
    firstAliasId(node.boundVariables?.topLeftRadius),
    firstAliasId(node.boundVariables?.topRightRadius),
    firstAliasId(node.boundVariables?.bottomRightRadius),
    firstAliasId(node.boundVariables?.bottomLeftRadius),
  ].filter((id): id is string => Boolean(id));
  if (cornerIds.length && cornerIds.every((id) => id === cornerIds[0])) {
    const bridgeId = context.bridgeIdByFigmaId.get(cornerIds[0]!);
    if (bridgeId) result.cornerRadius = bridgeId;
  }
  return Object.keys(result).length ? result : undefined;
}

function firstAliasId(
  value: VariableAlias | readonly VariableAlias[] | undefined,
): string | undefined {
  if (!value) return undefined;
  return "id" in value ? value.id : value[0]?.id;
}

function collectReferencedVariableIds(
  root: BridgeNode,
  components: BridgeNode[],
): Set<string> {
  const ids = new Set<string>();
  const collect = (node: BridgeNode) => {
    const bindings = node.variableBindings;
    for (const id of Object.values(bindings?.fills ?? {})) ids.add(id);
    for (const id of Object.values(bindings?.strokes ?? {})) ids.add(id);
    if (bindings?.fontFamily) ids.add(bindings.fontFamily);
    if (bindings?.cornerRadius) ids.add(bindings.cornerRadius);
    for (const child of node.children) collect(child);
  };
  collect(root);
  for (const component of components) collect(component);
  return ids;
}

function readInstanceOverrides(
  node: InstanceNode,
  component: ComponentNode | null | undefined,
  bridgeId: string,
  warnings: TransferWarning[],
): Record<string, unknown> {
  const stored = node.getPluginData(INSTANCE_OVERRIDE_MAP_KEY);
  if (!stored) {
    const overrides: Record<string, unknown> = {};
    for (const [propertyName, property] of Object.entries(
      node.componentProperties,
    )) {
      if (property.type !== "TEXT" || typeof property.value !== "string")
        continue;
      const target = component
        ? [component, ...component.findAll(() => true)].find(
            (candidate) =>
              candidate.type === "TEXT" &&
              candidate.componentPropertyReferences?.characters ===
                propertyName,
          )
        : undefined;
      if (!target) {
        warnings.push(
          warning(
            bridgeId,
            "instance text property",
            "skip",
            `Could not map Figma component property ${propertyName} on ${node.name}`,
          ),
        );
        continue;
      }
      const targetBridgeId =
        target.getPluginData(BRIDGE_ID_KEY) || `figma:${target.id}`;
      overrides[targetBridgeId] = { content: property.value };
    }
    return overrides;
  }
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

function removeDerivedInstanceChildren(
  root: BridgeNode,
  components: BridgeNode[] = [],
): void {
  const componentBridgeIds = new Set<string>();
  const collect = (node: BridgeNode) => {
    if (node.kind === "component") componentBridgeIds.add(node.bridgeId);
    for (const child of node.children) collect(child);
  };
  collect(root);
  for (const component of components) collect(component);
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
  for (const component of components) normalize(component);
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
  mixedTextFills?: ReadonlyArray<PaintStyle["paints"][number]>,
): Paint[] {
  if (!("fills" in node)) return [];
  const fills = node.fills === figma.mixed ? mixedTextFills : node.fills;
  if (!fills) return [];
  return fills.flatMap((paint, index) =>
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
            : paint.scaleMode === "CROP"
              ? "crop"
              : paint.scaleMode === "TILE"
                ? "tile"
                : "fill",
        ...(paint.scaleMode === "CROP" && paint.imageTransform
          ? {
              transform: [
                [...paint.imageTransform[0]],
                [...paint.imageTransform[1]],
              ],
            }
          : {}),
        ...(paint.scaleMode === "TILE" && paint.scalingFactor !== undefined
          ? { scalingFactor: paint.scalingFactor }
          : {}),
        ...(paint.rotation !== undefined && paint.rotation !== 0
          ? { rotation: paint.rotation }
          : {}),
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
  if ("topLeftRadius" in node)
    return [
      numeric(node.topLeftRadius),
      numeric(node.topRightRadius),
      numeric(node.bottomRightRadius),
      numeric(node.bottomLeftRadius),
    ];
  if ("cornerRadius" in node) {
    const radius = numeric(node.cornerRadius);
    if (radius === 0) return undefined;
    return [radius, radius, radius, radius];
  }
  return undefined;
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
    "linear-burn",
    "color-burn",
    "lighten",
    "screen",
    "linear-dodge",
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
