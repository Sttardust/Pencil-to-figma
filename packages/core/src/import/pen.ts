import type {
  BridgeAsset,
  BridgeDocument,
  BridgeNode,
  Paint,
  TransferWarning,
} from "@pen-fig/bridge-schema";
import { bridgeDocumentSchema } from "@pen-fig/bridge-schema";
import type { PenNode, PenSize } from "../pen-types.js";

export interface PenImportOptions {
  documentId: string;
}

export function importPenDocument(
  root: PenNode,
  options: PenImportOptions,
): BridgeDocument {
  const warnings: TransferWarning[] = [];
  const assets: BridgeAsset[] = [];
  const document: BridgeDocument = {
    version: 1,
    source: { app: "pen", documentId: options.documentId },
    root: importNode(root, options.documentId, warnings, assets),
    assets,
    variables: [],
    warnings,
  };
  return bridgeDocumentSchema.parse(document);
}

function importNode(
  node: PenNode,
  documentId: string,
  warnings: TransferWarning[],
  assets: BridgeAsset[],
): BridgeNode {
  if (!node.id || !node.type) throw new Error("Pen node is missing id or type");
  const bridgeId = `pen:${node.id}`;
  const kind = mapKind(node, bridgeId, warnings);
  const width = mapSizing(node.width);
  const height = mapSizing(node.height);
  const children =
    node.enabled === false
      ? []
      : (node.children ?? [])
          .filter((child) => child.enabled !== false)
          .map((child) => importNode(child, documentId, warnings, assets));

  const result: BridgeNode = {
    bridgeId,
    kind,
    name: node.name ?? `${node.type} ${node.id}`,
    source: { app: "pen", documentId, nodeId: node.id },
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
  const fills = mapPaintList(node.fill, bridgeId, warnings, assets);
  if (fills.length) result.fills = fills;
  const cornerRadii = mapCornerRadius(node.cornerRadius);
  if (cornerRadii) result.cornerRadii = cornerRadii;
  if (node.stroke !== undefined && node.strokeWidth !== undefined) {
    result.stroke = {
      paints: mapPaintList(node.stroke, bridgeId, warnings, assets),
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
  const effects = mapEffects(node.effect, bridgeId, warnings);
  if (effects.length) result.effects = effects;

  if (kind === "text") {
    const weight = numericWeight(node.fontWeight);
    result.text = {
      characters: node.content ?? "",
      resize:
        node.textGrowth === "fixed-width-height"
          ? "fixed"
          : node.textGrowth === "fixed-width"
            ? "height"
            : "auto",
      style: {
        family: node.fontFamily ?? "Inter",
        style: node.fontStyle || weightName(weight, node.fontFamily),
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
    result.instance = {
      componentBridgeId: `pen:${node.ref ?? "unknown"}`,
      overrides: node.descendants ?? {},
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
  return result;
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

function mapSizing(value: PenSize | undefined): BridgeNode["width"] {
  if (typeof value === "number")
    return { mode: "fixed", value: Math.max(0, value) };
  if (typeof value === "string") {
    const fallback = /\(([-\d.]+)\)/.exec(value)?.[1];
    if (value.startsWith("fill_container"))
      return fallback
        ? { mode: "fill", fallback: Number(fallback) }
        : { mode: "fill" };
    if (value.startsWith("fit_content"))
      return fallback
        ? { mode: "hug", fallback: Number(fallback) }
        : { mode: "hug" };
  }
  return { mode: "hug", fallback: 0 };
}

function fixedValue(sizing: BridgeNode["width"]): number {
  return sizing.mode === "fixed" ? sizing.value : (sizing.fallback ?? 0);
}

function mapLayout(node: PenNode): NonNullable<BridgeNode["layout"]> {
  const [top, right, bottom, left] = expandPadding(node.padding);
  return {
    mode: node.layout ?? "none",
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
): Paint[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).flatMap((paint) =>
    mapPaint(paint, bridgeId, warnings, assets),
  );
}

function mapPaint(
  value: unknown,
  bridgeId: string,
  warnings: TransferWarning[],
  assets: BridgeAsset[],
): Paint[] {
  if (typeof value === "string")
    return [
      {
        type: "solid",
        visible: true,
        opacity: 1,
        blendMode: "normal",
        color: parseHex(value),
      },
    ];
  if (!value || typeof value !== "object") return [];
  const paint = value as Record<string, unknown>;
  if (paint.enabled === false) return [];
  if (paint.type === "color" && typeof paint.color === "string") {
    return [
      {
        type: "solid",
        visible: true,
        opacity: 1,
        blendMode: "normal",
        color: parseHex(paint.color),
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
        blendMode: "normal",
        gradientType:
          paint.gradientType === "radial" || paint.gradientType === "angular"
            ? paint.gradientType
            : "linear",
        stops: colors.map((entry) => {
          const stop = entry as { color: string; position: number };
          return { color: parseHex(stop.color), position: stop.position };
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
    return [
      {
        type: "image",
        visible: true,
        opacity: typeof paint.opacity === "number" ? paint.opacity : 1,
        blendMode: "normal",
        assetId,
        scaleMode:
          paint.mode === "fit"
            ? "fit"
            : paint.mode === "stretch"
              ? "stretch"
              : "fill",
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

function parseHex(input: string): {
  r: number;
  g: number;
  b: number;
  a: number;
} {
  if (input.startsWith("$"))
    throw new Error(`Unresolved Pen color variable '${input}'`);
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
  const radians = ((rotation - 90) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [
    [cos, -sin, 0.5 - 0.5 * cos + 0.5 * sin],
    [sin, cos, 0.5 - 0.5 * sin - 0.5 * cos],
  ];
}

function mapCornerRadius(
  value: PenNode["cornerRadius"],
): [number, number, number, number] | undefined {
  if (typeof value === "number") return [value, value, value, value];
  return value;
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
        color: parseHex(effect.color ?? "#00000040"),
        offset: effect.offset ?? { x: 0, y: 0 },
        radius: effect.blur ?? 0,
        spread: effect.spread ?? 0,
        blendMode: "normal" as const,
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
