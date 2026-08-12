import type {
  BridgeAsset,
  BridgeDocument,
  BridgeNode,
  Paint,
  TransferWarning,
} from "@pen-fig/bridge-schema";
import { bridgeDocumentSchema } from "@pen-fig/bridge-schema";
import type {
  PenNode,
  PenSize,
  PenVariableDefinition,
  PenVariableDefinitions,
} from "../pen-types.js";

export interface PenImportOptions {
  documentId: string;
  useBridgeMetadata?: boolean;
  components?: PenNode[];
  variables?: PenVariableDefinitions;
}

export function importPenDocument(
  root: PenNode,
  options: PenImportOptions,
): BridgeDocument {
  const warnings: TransferWarning[] = [];
  const assets: BridgeAsset[] = [];
  const componentNodes = options.components ?? [];
  const variables = options.variables ?? {};
  const componentBridgeIds = collectComponentBridgeIds(
    [root, ...componentNodes],
    options,
  );
  const nodeBridgeIds = collectNodeBridgeIds(
    [root, ...componentNodes],
    options,
  );
  const componentDefinitions = collectComponentDefinitions([
    root,
    ...componentNodes,
  ]);
  const importedRoot = importNode(
    root,
    options,
    warnings,
    assets,
    componentBridgeIds,
    nodeBridgeIds,
    componentDefinitions,
    variables,
  );
  removeDerivedInstanceChildren(
    importedRoot,
    new Set(componentBridgeIds.values()),
  );
  const components = componentNodes.map((component) =>
    importNode(
      component,
      options,
      warnings,
      assets,
      componentBridgeIds,
      nodeBridgeIds,
      componentDefinitions,
      variables,
    ),
  );
  for (const component of components)
    removeDerivedInstanceChildren(
      component,
      new Set(componentBridgeIds.values()),
    );
  const document: BridgeDocument = {
    version: 1,
    source: { app: "pen", documentId: options.documentId },
    root: importedRoot,
    ...(components.length ? { components } : {}),
    assets,
    variables: importPenVariables(variables),
    warnings,
  };
  return bridgeDocumentSchema.parse(document);
}

function importNode(
  node: PenNode,
  options: PenImportOptions,
  warnings: TransferWarning[],
  assets: BridgeAsset[],
  componentBridgeIds: ReadonlyMap<string, string>,
  nodeBridgeIds: ReadonlyMap<string, string>,
  componentDefinitions: ReadonlyMap<string, PenNode>,
  variables: PenVariableDefinitions,
): BridgeNode {
  if (!node.id || !node.type) throw new Error("Pen node is missing id or type");
  const bridgeId = bridgeIdForPenNode(node, options);
  const kind = mapKind(node, bridgeId, warnings);
  const referencedComponent = node.ref
    ? componentDefinitions.get(node.ref)
    : undefined;
  const width = mapSizing(
    node.width ?? referencedComponent?.width,
    node.resolvedBounds?.width,
  );
  const height = mapSizing(
    node.height ?? referencedComponent?.height,
    node.resolvedBounds?.height,
  );
  const children =
    node.enabled === false
      ? []
      : (node.children ?? [])
          .filter((child) => child.enabled !== false)
          .map((child) =>
            importNode(
              child,
              options,
              warnings,
              assets,
              componentBridgeIds,
              nodeBridgeIds,
              componentDefinitions,
              variables,
            ),
          );

  const result: BridgeNode = {
    bridgeId,
    kind,
    name: node.name ?? `${node.type} ${node.id}`,
    source: { app: "pen", documentId: options.documentId, nodeId: node.id },
    bounds: {
      x: node.x ?? 0,
      y: node.y ?? 0,
      width: fixedValue(width),
      height: fixedValue(height),
    },
    width,
    height,
    rotation: -(node.rotation ?? 0),
    visible: node.enabled !== false,
    opacity: node.opacity ?? 1,
    locked: false,
    layoutPosition: node.layoutPosition ?? "auto",
    children,
  };

  if (kind === "frame" || kind === "component" || kind === "instance") {
    result.clipsContent = node.clip ?? false;
    result.layout = mapLayout(node);
  }
  const fills = mapPaintList(
    node.fill,
    bridgeId,
    warnings,
    assets,
    variables,
    "fill",
  );
  if (fills.length) result.fills = fills;
  const cornerRadii = mapCornerRadius(
    node.cornerRadius,
    variables,
    warnings,
    bridgeId,
  );
  if (cornerRadii) result.cornerRadii = cornerRadii;
  if (node.stroke !== undefined && node.strokeWidth !== undefined) {
    result.stroke = {
      paints: mapPaintList(
        node.stroke,
        bridgeId,
        warnings,
        assets,
        variables,
        "stroke",
      ),
      alignment: mapEnum(
        node.strokeAlignment,
        { inner: "inside", center: "center", outer: "outside" },
        "inside",
      ),
      weights: mapStrokeWeights(node.strokeWidth),
      cap: mapEnum(
        node.strokeLinecap,
        { butt: "none", round: "round", square: "square" },
        "none",
      ),
      join: node.strokeLinejoin ?? "miter",
    };
  }
  const effects = mapEffects(node.effect, bridgeId, warnings, variables);
  if (effects.length) result.effects = effects;

  if (kind === "text") {
    const weight = numericWeight(node.fontWeight);
    const family = resolveStringVariable(
      node.fontFamily ?? "Inter",
      variables,
      warnings,
      bridgeId,
      "font family",
      false,
    );
    result.text = {
      characters: node.content ?? "",
      resize:
        node.textGrowth === "fixed-width-height"
          ? "fixed"
          : node.textGrowth === "fixed-width"
            ? "height"
            : "auto",
      style: {
        family,
        style: node.fontStyle || weightName(weight, family),
        weight,
        size: node.fontSize ?? 12,
        lineHeight:
          node.lineHeight === undefined
            ? { unit: "auto" }
            : { unit: "percent", value: node.lineHeight * 100 },
        letterSpacing: node.letterSpacing ?? 0,
        horizontalAlign: node.textAlign ?? "left",
        verticalAlign:
          node.textAlignVertical === "middle"
            ? "center"
            : (node.textAlignVertical ?? "top"),
        decoration: node.strikethrough
          ? "strikethrough"
          : node.underline
            ? "underline"
            : "none",
      },
    };
  } else if (kind === "path") {
    if (!node.geometry)
      throw new Error(`Path node ${node.id} is missing geometry`);
    result.path = {
      data: node.geometry,
      windingRule: node.fillRule ?? "nonzero",
      viewBox: node.viewBox ?? [0, 0, fixedValue(width), fixedValue(height)],
    };
  } else if (kind === "polygon") {
    result.polygonSides = Math.max(3, Math.round(node.polygonCount ?? 3));
  } else if (kind === "component") {
    result.component = { key: node.id };
  } else if (kind === "instance") {
    const ref = node.ref ?? "unknown";
    result.instance = {
      componentBridgeId: componentBridgeIds.get(ref) ?? `pen:${ref}`,
      overrides: Object.fromEntries(
        Object.entries(node.descendants ?? {}).map(([nodeId, value]) => [
          nodeBridgeIds.get(nodeId) ?? `pen:${nodeId}`,
          value,
        ]),
      ),
    };
  } else if (node.type === "icon" && node.icon) {
    const assetId = `pen-icon:${node.id}`;
    assets.push({
      status: "pending",
      id: assetId,
      kind: "svg",
      sourceUri: `icon://${encodeURIComponent(node.library ?? "lucide")}/${encodeURIComponent(node.icon)}`,
    });
    result.icon = { assetId };
  }
  const variableBindings = directVariableBindings(node, variables);
  if (variableBindings) result.variableBindings = variableBindings;
  return result;
}

function collectComponentBridgeIds(
  roots: PenNode[],
  options: PenImportOptions,
): Map<string, string> {
  const componentBridgeIds = new Map<string, string>();
  const visit = (node: PenNode) => {
    if (node.reusable && node.type === "frame")
      componentBridgeIds.set(node.id, bridgeIdForPenNode(node, options));
    for (const child of node.children ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  return componentBridgeIds;
}

function collectNodeBridgeIds(
  roots: PenNode[],
  options: PenImportOptions,
): Map<string, string> {
  const nodeBridgeIds = new Map<string, string>();
  const visit = (node: PenNode) => {
    nodeBridgeIds.set(node.id, bridgeIdForPenNode(node, options));
    for (const child of node.children ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  return nodeBridgeIds;
}

function collectComponentDefinitions(roots: PenNode[]): Map<string, PenNode> {
  const definitions = new Map<string, PenNode>();
  const visit = (node: PenNode) => {
    if (node.type === "frame" && node.reusable) definitions.set(node.id, node);
    for (const child of node.children ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  return definitions;
}

function bridgeIdForPenNode(node: PenNode, options: PenImportOptions): string {
  const metadataBridgeId = node.metadata?.bridgeId;
  return options.useBridgeMetadata &&
    typeof metadataBridgeId === "string" &&
    metadataBridgeId
    ? metadataBridgeId
    : `pen:${node.id}`;
}

function removeDerivedInstanceChildren(
  node: BridgeNode,
  localComponentBridgeIds: ReadonlySet<string>,
): void {
  if (
    node.kind === "instance" &&
    node.instance &&
    localComponentBridgeIds.has(node.instance.componentBridgeId)
  ) {
    node.children = [];
    return;
  }
  for (const child of node.children)
    removeDerivedInstanceChildren(child, localComponentBridgeIds);
}

function mapKind(
  node: PenNode,
  bridgeId: string,
  warnings: TransferWarning[],
): BridgeNode["kind"] {
  if (node.reusable && node.type === "frame") return "component";
  switch (node.type) {
    case "frame":
      return "frame";
    case "group":
      return "group";
    case "rectangle":
      return "rectangle";
    case "ellipse":
      return "ellipse";
    case "polygon":
      return "polygon";
    case "path":
      return "path";
    case "text":
    case "note":
    case "prompt":
    case "context":
      return "text";
    case "ref":
      return "instance";
    case "icon":
      return "frame";
    case "script":
      warnings.push(
        warning(
          bridgeId,
          "script",
          "rasterize",
          "Script output must be rasterized",
        ),
      );
      return "frame";
    default:
      throw new Error(`Unknown Pen node type '${node.type}' on ${node.id}`);
  }
}

function mapSizing(
  value: PenSize | undefined,
  resolvedValue?: number,
): BridgeNode["width"] {
  const resolvedFallback =
    resolvedValue !== undefined &&
    Number.isFinite(resolvedValue) &&
    resolvedValue >= 0
      ? resolvedValue
      : undefined;
  if (typeof value === "number")
    return { mode: "fixed", value: Math.max(0, value) };
  if (typeof value === "string") {
    const fallback = /\(([-\d.]+)\)/.exec(value)?.[1];
    if (value.startsWith("fill_container"))
      return fallback
        ? { mode: "fill", fallback: Number(fallback) }
        : resolvedFallback !== undefined
          ? { mode: "fill", fallback: resolvedFallback }
          : { mode: "fill" };
    if (value.startsWith("fit_content"))
      return fallback
        ? { mode: "hug", fallback: Number(fallback) }
        : resolvedFallback !== undefined
          ? { mode: "hug", fallback: resolvedFallback }
          : { mode: "hug" };
  }
  return { mode: "hug", fallback: resolvedFallback ?? 0 };
}

function fixedValue(sizing: BridgeNode["width"]): number {
  return sizing.mode === "fixed" ? sizing.value : (sizing.fallback ?? 0);
}

function mapLayout(node: PenNode): NonNullable<BridgeNode["layout"]> {
  const [top, right, bottom, left] = expandPadding(node.padding);
  return {
    mode: node.layout ?? inferImplicitLayout(node),
    gap: node.gap ?? 0,
    padding: { top, right, bottom, left },
    primaryAlign: mapEnum(
      node.justifyContent,
      {
        start: "start",
        center: "center",
        end: "end",
        space_between: "space-between",
        space_around: "space-around",
      },
      "start",
    ),
    counterAlign: node.alignItems ?? "start",
    includeStroke: node.layoutIncludeStroke ?? false,
  };
}

function inferImplicitLayout(node: PenNode): "none" | "horizontal" {
  const hasPositionedChild = (node.children ?? []).some(
    (child) =>
      child.layoutPosition === "absolute" ||
      (child.x ?? 0) !== 0 ||
      (child.y ?? 0) !== 0,
  );
  return hasPositionedChild ? "none" : "horizontal";
}

function expandPadding(
  value: PenNode["padding"],
): [number, number, number, number] {
  if (typeof value === "number") return [value, value, value, value];
  if (value?.length === 2) return [value[0], value[1], value[0], value[1]];
  return value ?? [0, 0, 0, 0];
}

function mapPaintList(
  value: unknown,
  bridgeId: string,
  warnings: TransferWarning[],
  assets: BridgeAsset[],
  variables: PenVariableDefinitions,
  property: "fill" | "stroke",
): Paint[] {
  if (value === undefined) return [];
  const paints = Array.isArray(value) ? value : [value];
  return paints.flatMap((paint) =>
    mapPaint(
      paint,
      bridgeId,
      warnings,
      assets,
      variables,
      property,
      paints.length === 1,
    ),
  );
}

function mapPaint(
  value: unknown,
  bridgeId: string,
  warnings: TransferWarning[],
  assets: BridgeAsset[],
  variables: PenVariableDefinitions,
  property: "fill" | "stroke",
  preserveDirectVariable: boolean,
): Paint[] {
  if (typeof value === "string") {
    const color = parseHex(
      resolveColorVariable(
        value,
        variables,
        warnings,
        bridgeId,
        property,
        !preserveDirectVariable,
      ),
    );
    return [
      {
        type: "solid",
        visible: true,
        opacity: color.a,
        blendMode: "normal",
        color: { ...color, a: 1 },
      },
    ];
  }
  if (!value || typeof value !== "object") return [];
  const paint = value as Record<string, unknown>;
  if (paint.enabled === false) return [];
  if (paint.type === "color" && typeof paint.color === "string") {
    const color = parseHex(
      resolveColorVariable(
        paint.color,
        variables,
        warnings,
        bridgeId,
        property,
        !preserveDirectVariable,
      ),
    );
    const authoredOpacity =
      typeof paint.opacity === "number" ? paint.opacity : 1;
    return [
      {
        type: "solid",
        visible: true,
        opacity: authoredOpacity * color.a,
        blendMode: mapPenBlendMode(
          paint.blendMode,
          bridgeId,
          `${property} paint`,
          warnings,
        ),
        color: { ...color, a: 1 },
      },
    ];
  }
  if (paint.type === "gradient") {
    const colors = Array.isArray(paint.colors) ? paint.colors : [];
    return [
      {
        type: "gradient",
        visible: true,
        opacity: typeof paint.opacity === "number" ? paint.opacity : 1,
        blendMode: mapPenBlendMode(
          paint.blendMode,
          bridgeId,
          `${property} gradient`,
          warnings,
        ),
        gradientType:
          paint.gradientType === "radial" || paint.gradientType === "angular"
            ? paint.gradientType
            : "linear",
        stops: colors.map((entry) => {
          const stop = entry as { color: string; position: number };
          return {
            color: parseHex(
              resolveColorVariable(
                stop.color,
                variables,
                warnings,
                bridgeId,
                "gradient stop",
              ),
            ),
            position: stop.position,
          };
        }),
        transform: gradientTransform(
          typeof paint.rotation === "number" ? paint.rotation : 0,
        ),
      },
    ];
  }
  if (paint.type === "image") {
    if (typeof paint.url !== "string")
      throw new Error(`Image fill on ${bridgeId} is missing a URL`);
    const assetId = `pen-image:${bridgeId}:${assets.length}`;
    assets.push({
      status: "pending",
      id: assetId,
      kind: "image",
      sourceUri: paint.url,
    });
    const scaleMode =
      paint.mode === "fit" ||
      paint.mode === "stretch" ||
      paint.mode === "crop" ||
      paint.mode === "tile"
        ? paint.mode
        : "fill";
    if (scaleMode === "stretch")
      warnings.push(
        warning(
          bridgeId,
          "image stretch mode",
          "flatten",
          "Pencil stretch image mode will use Figma Fill because Figma has no stretch mode",
        ),
      );
    const transform = readPaintTransform(
      paint.imageTransform ?? paint.transform,
    );
    return [
      {
        type: "image",
        visible: true,
        opacity: typeof paint.opacity === "number" ? paint.opacity : 1,
        blendMode: mapPenBlendMode(
          paint.blendMode,
          bridgeId,
          `${property} image`,
          warnings,
        ),
        assetId,
        scaleMode,
        ...(transform ? { transform } : {}),
        ...(typeof paint.scalingFactor === "number"
          ? { scalingFactor: paint.scalingFactor }
          : {}),
        ...(typeof paint.rotation === "number"
          ? { rotation: paint.rotation }
          : {}),
      },
    ];
  }
  if (paint.type === "shader" || paint.type === "mesh_gradient") {
    warnings.push(
      warning(
        bridgeId,
        `${String(paint.type)} fill`,
        "rasterize",
        "Unsupported Pen fill requires rasterization",
      ),
    );
    return [];
  }
  throw new Error(`Unknown Pen paint on ${bridgeId}`);
}

function mapPenBlendMode(
  value: unknown,
  bridgeId: string,
  construct: string,
  warnings: TransferWarning[],
): Paint["blendMode"] {
  if (value === undefined) return "normal";
  const normalized = String(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
  const supported: Paint["blendMode"][] = [
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
  ];
  if (supported.includes(normalized as Paint["blendMode"]))
    return normalized as Paint["blendMode"];
  warnings.push(
    warning(
      bridgeId,
      `${construct} blend mode`,
      "flatten",
      `Unsupported Pencil blend mode ${String(value)} will use Normal`,
    ),
  );
  return "normal";
}

function readPaintTransform(
  value: unknown,
): [[number, number, number], [number, number, number]] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const rows = value as unknown[];
  if (
    !rows.every(
      (row) =>
        Array.isArray(row) &&
        row.length === 3 &&
        row.every(
          (entry) => typeof entry === "number" && Number.isFinite(entry),
        ),
    )
  )
    return undefined;
  return value as [[number, number, number], [number, number, number]];
}

function importPenVariables(
  definitions: PenVariableDefinitions,
): BridgeDocument["variables"] {
  return Object.entries(definitions)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, definition]) => ({
      id: `pen-var:${name}`,
      name,
      type: definition.type,
      values: [
        {
          mode: {},
          value:
            definition.type === "color"
              ? parseHex(
                  String(resolveVariableValue(name, "color", definitions, [])),
                )
              : resolveVariableValue(name, definition.type, definitions, []),
        },
      ],
    }));
}

function resolveColorVariable(
  input: string,
  definitions: PenVariableDefinitions,
  warnings: TransferWarning[],
  bridgeId: string,
  property: string,
  recordInlining = true,
): string {
  if (!input.startsWith("$")) return input;
  const name = input.slice(1);
  if (recordInlining)
    recordVariableInlining(warnings, bridgeId, name, property);
  return String(resolveVariableValue(name, "color", definitions, []));
}

function resolveStringVariable(
  input: string,
  definitions: PenVariableDefinitions,
  warnings: TransferWarning[],
  bridgeId: string,
  property: string,
  recordInlining = true,
): string {
  if (!input.startsWith("$")) return input;
  const name = input.slice(1);
  if (recordInlining)
    recordVariableInlining(warnings, bridgeId, name, property);
  return String(resolveVariableValue(name, "string", definitions, []));
}

function resolveNumberVariable(
  input: string,
  definitions: PenVariableDefinitions,
  warnings: TransferWarning[],
  bridgeId: string,
  property: string,
  recordInlining = true,
): number {
  if (!input.startsWith("$")) {
    const value = Number(input);
    if (!Number.isFinite(value))
      throw new Error(`Invalid Pen number '${input}'`);
    return value;
  }
  const name = input.slice(1);
  if (recordInlining)
    recordVariableInlining(warnings, bridgeId, name, property);
  return Number(resolveVariableValue(name, "number", definitions, []));
}

function resolveVariableValue(
  name: string,
  expectedType: PenVariableDefinition["type"],
  definitions: PenVariableDefinitions,
  stack: string[],
): boolean | number | string {
  if (stack.includes(name))
    throw new Error(
      `Cyclic Pen variable reference: ${[...stack, name].join(" → ")}`,
    );
  const definition = definitions[name];
  if (!definition) throw new Error(`Unknown Pen variable '$${name}'`);
  if (definition.type !== expectedType)
    throw new Error(
      `Pen variable '$${name}' is ${definition.type}, expected ${expectedType}`,
    );
  if (typeof definition.value === "string" && definition.value.startsWith("$"))
    return resolveVariableValue(
      definition.value.slice(1),
      expectedType,
      definitions,
      [...stack, name],
    );
  if (expectedType === "number" && typeof definition.value !== "number")
    throw new Error(`Pen variable '$${name}' must contain a number`);
  if (expectedType === "boolean" && typeof definition.value !== "boolean")
    throw new Error(`Pen variable '$${name}' must contain a boolean`);
  if (
    (expectedType === "string" || expectedType === "color") &&
    typeof definition.value !== "string"
  )
    throw new Error(`Pen variable '$${name}' must contain a string`);
  return definition.value;
}

function recordVariableInlining(
  warnings: TransferWarning[],
  bridgeId: string,
  name: string,
  property: string,
): void {
  const message = `Inlined Pencil variable $${name} for ${property}`;
  if (
    warnings.some(
      (entry) =>
        entry.code === "PEN_VARIABLE_INLINED" && entry.message === message,
    )
  )
    return;
  warnings.push(warning(bridgeId, "variable inlined", "flatten", message));
}

function parseHex(input: string): {
  r: number;
  g: number;
  b: number;
  a: number;
} {
  let hex = input.replace(/^#/, "");
  if (hex.length === 3 || hex.length === 4)
    hex = hex
      .split("")
      .map((part) => part + part)
      .join("");
  if (hex.length === 6) hex += "ff";
  if (!/^[0-9a-f]{8}$/i.test(hex))
    throw new Error(`Invalid Pen color '${input}'`);
  return {
    r: parseInt(hex.slice(0, 2), 16) / 255,
    g: parseInt(hex.slice(2, 4), 16) / 255,
    b: parseInt(hex.slice(4, 6), 16) / 255,
    a: parseInt(hex.slice(6, 8), 16) / 255,
  };
}

function gradientTransform(
  rotation: number,
): [[number, number, number], [number, number, number]] {
  // Pencil and Figma measure a linear gradient's zero axis in opposite
  // vertical directions. The quarter-turn offset keeps Pencil's stop order
  // intact while matching the direction users see on the canvas.
  const radians = ((rotation + 90) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [
    [cos, -sin, 0.5 - 0.5 * cos + 0.5 * sin],
    [sin, cos, 0.5 - 0.5 * sin - 0.5 * cos],
  ];
}

function mapCornerRadius(
  value: PenNode["cornerRadius"],
  variables: PenVariableDefinitions,
  warnings: TransferWarning[],
  bridgeId: string,
): [number, number, number, number] | undefined {
  if (typeof value === "number") return [value, value, value, value];
  if (typeof value === "string") {
    const resolved = resolveNumberVariable(
      value,
      variables,
      warnings,
      bridgeId,
      "corner radius",
      false,
    );
    return [resolved, resolved, resolved, resolved];
  }
  return value;
}

function directVariableBindings(
  node: PenNode,
  definitions: PenVariableDefinitions,
): BridgeNode["variableBindings"] | undefined {
  const bindings: NonNullable<BridgeNode["variableBindings"]> = {};
  const fill = directPaintVariableId(node.fill, "color", definitions);
  if (fill) bindings.fills = { "0": fill };
  const stroke = directPaintVariableId(node.stroke, "color", definitions);
  if (stroke) bindings.strokes = { "0": stroke };
  const fontFamily = directVariableId(node.fontFamily, "string", definitions);
  if (fontFamily) bindings.fontFamily = fontFamily;
  const cornerRadius = directVariableId(
    node.cornerRadius,
    "number",
    definitions,
  );
  if (cornerRadius) bindings.cornerRadius = cornerRadius;
  return Object.keys(bindings).length ? bindings : undefined;
}

function directPaintVariableId(
  value: unknown,
  expectedType: PenVariableDefinition["type"],
  definitions: PenVariableDefinitions,
): string | undefined {
  if (Array.isArray(value)) return undefined;
  if (typeof value === "string")
    return directVariableId(value, expectedType, definitions);
  if (!value || typeof value !== "object") return undefined;
  const paint = value as Record<string, unknown>;
  return paint.type === "color"
    ? directVariableId(paint.color, expectedType, definitions)
    : undefined;
}

function directVariableId(
  value: unknown,
  expectedType: PenVariableDefinition["type"],
  definitions: PenVariableDefinitions,
): string | undefined {
  if (typeof value !== "string" || !value.startsWith("$")) return undefined;
  const name = value.slice(1);
  const definition = definitions[name];
  if (!definition) throw new Error(`Unknown Pen variable '$${name}'`);
  if (definition.type !== expectedType)
    throw new Error(
      `Pen variable '$${name}' is ${definition.type}, expected ${expectedType}`,
    );
  return `pen-var:${name}`;
}

function mapStrokeWeights(value: NonNullable<PenNode["strokeWidth"]>): {
  top: number;
  right: number;
  bottom: number;
  left: number;
} {
  if (typeof value === "number")
    return { top: value, right: value, bottom: value, left: value };
  return {
    top: value.top ?? 0,
    right: value.right ?? 0,
    bottom: value.bottom ?? 0,
    left: value.left ?? 0,
  };
}

function mapEffects(
  value: unknown,
  bridgeId: string,
  warnings: TransferWarning[],
  variables: PenVariableDefinitions,
): NonNullable<BridgeNode["effects"]> {
  if (value === undefined) return [];
  const results: NonNullable<BridgeNode["effects"]> = [];
  for (const item of Array.isArray(value) ? value : [value]) {
    if (!item || typeof item !== "object") continue;
    const effect = item as Record<string, any>;
    if (effect.enabled === false) return [];
    if (effect.type === "blur" || effect.type === "background_blur") {
      results.push({
        type:
          effect.type === "blur"
            ? ("blur" as const)
            : ("background-blur" as const),
        visible: true,
        radius: effect.radius ?? 0,
      });
      continue;
    }
    if (effect.type === "shadow") {
      results.push({
        type:
          effect.shadowType === "inner"
            ? ("inner-shadow" as const)
            : ("drop-shadow" as const),
        visible: true,
        color: parseHex(
          resolveColorVariable(
            effect.color ?? "#00000040",
            variables,
            warnings,
            bridgeId,
            "effect color",
          ),
        ),
        offset: effect.offset ?? { x: 0, y: 0 },
        radius: effect.blur ?? 0,
        spread: effect.spread ?? 0,
        blendMode: mapPenBlendMode(
          effect.blendMode,
          bridgeId,
          "shadow",
          warnings,
        ),
      });
      continue;
    }
    warnings.push(
      warning(bridgeId, "effect", "skip", "Unsupported Pen effect"),
    );
  }
  return results;
}

function numericWeight(value: PenNode["fontWeight"]): number {
  if (typeof value === "number") return value;
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed;
  const normalized = value?.toLowerCase();
  return normalized === "bold"
    ? 700
    : normalized === "semibold"
      ? 600
      : normalized === "medium"
        ? 500
        : normalized === "light"
          ? 300
          : 400;
}

function weightName(weight: number, family?: string): string {
  return weight >= 700
    ? "Bold"
    : weight >= 600
      ? family?.startsWith("Stack Sans")
        ? "SemiBold"
        : "Semi Bold"
      : weight >= 500
        ? "Medium"
        : weight <= 300
          ? "Light"
          : "Regular";
}

function warning(
  nodeBridgeId: string,
  construct: string,
  action: TransferWarning["action"],
  message: string,
): TransferWarning {
  return {
    code: `PEN_${construct.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`,
    nodeBridgeId,
    construct,
    action,
    message,
  };
}

function mapEnum<T extends string, U extends string>(
  value: T | undefined,
  values: Record<T, U>,
  fallback: U,
): U {
  return value === undefined ? fallback : values[value];
}
