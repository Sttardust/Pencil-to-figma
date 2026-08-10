import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BridgeDocument } from "@pen-fig/bridge-schema";
import { planFigmaToPenCreate, type PenInsertOperation } from "@pen-fig/core";
import type { PenMcpClient } from "../pen/mcp-client.js";

const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 32 * 1024 * 1024;
const ROOT_GAP = 120;
const COMPONENT_GAP = 40;

export interface FigmaExportAssetData {
  base64: string;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  byteLength: number;
}

export interface PenExportResult {
  rootId: string;
  position: { x: number; y: number };
  nodeCount: number;
  chunkCount: number;
  assetCount: number;
  warnings: string[];
  mappings: Array<{ bridgeId: string; penNodeId: string }>;
}

export interface PenExportOptions {
  placementAnchorId?: string;
}

export async function writeFigmaCopyToPen(
  document: BridgeDocument,
  assetData: Record<string, FigmaExportAssetData>,
  penPath: string,
  pen: PenMcpClient,
  options: PenExportOptions = {},
): Promise<PenExportResult> {
  const transferId = randomUUID();
  const assetPaths = await stageFigmaAssets(document, assetData, penPath);
  const plan = planFigmaToPenCreate(document, { assetPaths });
  const nativeIds = new Map<string, string>();
  const sourceId = document.root.bridgeId.startsWith("pen:")
    ? document.root.bridgeId.slice(4)
    : undefined;
  const sourceBounds = sourceId
    ? await pen.getTopLevelBounds(sourceId)
    : undefined;
  const footprint = exportFootprint(document);
  const rootPosition = await pen.findEmptySpace(
    footprint.width,
    footprint.height,
    options.placementAnchorId ?? (sourceBounds ? sourceId : undefined),
    ROOT_GAP,
  );
  let rootId: string | undefined;
  const variablePrefix = `n${transferId.replaceAll("-", "").slice(0, 8)}`;

  try {
    for (const chunk of plan.chunks) {
      const inserts = chunk.operations.filter(
        (operation): operation is PenInsertOperation =>
          operation.type === "insert",
      );
      const shouldFinalize = chunk.operations.some(
        (operation) => operation.type === "finalize-root",
      );
      if (!inserts.length && !shouldFinalize) continue;

      const localVariables = new Map<string, string>();
      const statements: string[] = [];
      for (const [index, operation] of inserts.entries()) {
        const variable = `${variablePrefix}_${chunk.index}_${index}`;
        const payload = preparePayload(
          operation,
          document,
          transferId,
          rootPosition,
          nativeIds,
        );
        const parent = operation.parentBridgeId
          ? (localVariables.get(operation.parentBridgeId) ??
            quoteNativeId(nativeIds.get(operation.parentBridgeId)))
          : "document";
        statements.push(
          `let ${variable}=Insert(${parent},${JSON.stringify(payload)})`,
          `Print("MAP","|",${JSON.stringify(operation.bridgeId)},"|",${variable})`,
        );
        localVariables.set(operation.bridgeId, variable);
      }
      if (shouldFinalize) {
        const target =
          localVariables.get(plan.rootBridgeId) ??
          quoteNativeId(nativeIds.get(plan.rootBridgeId));
        statements.push(
          `Update(${target},{placeholder:false})`,
          `Print("FINALIZED","|",${target})`,
        );
      }

      const output = await pen.executeWrite(statements.join(";"), 90_000);
      for (const mapping of parseMappings(output))
        nativeIds.set(mapping.bridgeId, mapping.nativeId);
      for (const insert of inserts)
        if (!nativeIds.has(insert.bridgeId))
          throw new Error(`Pencil did not return an id for ${insert.bridgeId}`);
      rootId = nativeIds.get(plan.rootBridgeId) ?? rootId;
    }
  } catch (error) {
    const discoveredRoot =
      rootId ?? (await pen.findExportRoot(transferId).catch(() => undefined));
    const topLevelBridgeIds = plan.operations
      .filter(
        (operation): operation is PenInsertOperation =>
          operation.type === "insert" && !operation.parentBridgeId,
      )
      .map((operation) => operation.bridgeId);
    const rollbackIds = topLevelBridgeIds
      .map((bridgeId) => nativeIds.get(bridgeId))
      .filter((nodeId): nodeId is string => Boolean(nodeId));
    if (discoveredRoot && !rollbackIds.includes(discoveredRoot))
      rollbackIds.push(discoveredRoot);
    let rollback = "No partial Pencil root remained";
    if (rollbackIds.length) {
      try {
        await pen.executeWrite(
          rollbackIds
            .reverse()
            .map((nodeId) => `Delete(${JSON.stringify(nodeId)})`)
            .join(";"),
          30_000,
        );
        rollback = `Rolled back ${rollbackIds.length} partial root${rollbackIds.length === 1 ? "" : "s"}`;
      } catch {
        rollback = `Could not roll back ${rollbackIds.length} partial root${rollbackIds.length === 1 ? "" : "s"}`;
      }
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new Error(`${message}. ${rollback}`);
  }

  if (!rootId) throw new Error("Pencil export created no root node");
  return {
    rootId,
    position: rootPosition,
    nodeCount: plan.counts.inserts,
    chunkCount: plan.chunks.length,
    assetCount: plan.counts.assets,
    warnings: plan.warnings.map((warning) => warning.message),
    mappings: [...nativeIds].map(([bridgeId, penNodeId]) => ({
      bridgeId,
      penNodeId,
    })),
  };
}

function preparePayload(
  operation: PenInsertOperation,
  document: BridgeDocument,
  transferId: string,
  rootPosition: { x: number; y: number },
  nativeIds: Map<string, string>,
): Record<string, unknown> {
  const payload = { ...operation.payload };
  if (operation.bridgeId === document.root.bridgeId) {
    payload.x = rootPosition.x;
    payload.y = rootPosition.y;
    payload.name = `${document.root.name} · Figma Copy`;
    payload.metadata = {
      type: "pen-fig-export",
      bridgeId: operation.bridgeId,
      transferId,
    };
  } else {
    const componentIndex = (document.components ?? []).findIndex(
      (component) => component.bridgeId === operation.bridgeId,
    );
    if (componentIndex >= 0) {
      const component = document.components![componentIndex]!;
      payload.x = rootPosition.x + document.root.bounds.width + ROOT_GAP;
      payload.y =
        rootPosition.y +
        document
          .components!.slice(0, componentIndex)
          .reduce(
            (offset, item) => offset + item.bounds.height + COMPONENT_GAP,
            0,
          );
      payload.name = `${component.name} · Component`;
      payload.metadata = {
        type: "pen-fig-export-component",
        bridgeId: operation.bridgeId,
        transferId,
      };
    }
  }
  if (payload.type === "ref" && typeof payload.ref === "string") {
    const mapped = nativeIds.get(payload.ref);
    if (mapped) payload.ref = mapped;
    else if (payload.ref.startsWith("pen:")) payload.ref = payload.ref.slice(4);
    else if (payload.ref.startsWith("figma:"))
      throw new Error(`Unresolved Figma component ${payload.ref}`);
  }
  if (
    payload.descendants &&
    typeof payload.descendants === "object" &&
    !Array.isArray(payload.descendants)
  ) {
    payload.descendants = Object.fromEntries(
      Object.entries(payload.descendants).map(([bridgeId, override]) => {
        const mapped = nativeIds.get(bridgeId);
        if (!mapped && bridgeId.startsWith("figma:"))
          throw new Error(`Unresolved Figma component child ${bridgeId}`);
        return [mapped ?? bridgeId.replace(/^pen:/, ""), override];
      }),
    );
  }
  return payload;
}

function exportFootprint(document: BridgeDocument): {
  width: number;
  height: number;
} {
  const components = document.components ?? [];
  if (!components.length)
    return {
      width: document.root.bounds.width,
      height: document.root.bounds.height,
    };
  const componentWidth = Math.max(
    ...components.map((component) => component.bounds.width),
  );
  const componentHeight =
    components.reduce(
      (height, component) => height + component.bounds.height,
      0,
    ) +
    COMPONENT_GAP * Math.max(0, components.length - 1);
  return {
    width: document.root.bounds.width + ROOT_GAP + componentWidth,
    height: Math.max(document.root.bounds.height, componentHeight),
  };
}

function quoteNativeId(value: string | undefined): string {
  if (!value) throw new Error("Pencil parent mapping is missing");
  return JSON.stringify(value);
}

function parseMappings(
  output: string,
): Array<{ bridgeId: string; nativeId: string }> {
  const mappings: Array<{ bridgeId: string; nativeId: string }> = [];
  const pattern = /MAP\s*\|\s*([^|\r\n]+?)\s*\|\s*([A-Za-z0-9]+)/g;
  for (const match of output.matchAll(pattern))
    mappings.push({ bridgeId: match[1]!.trim(), nativeId: match[2]! });
  return mappings;
}

export async function stageFigmaAssets(
  document: BridgeDocument,
  assetData: Record<string, FigmaExportAssetData>,
  penPath: string,
): Promise<Record<string, string>> {
  if (path.extname(penPath) !== ".pen")
    throw new Error("The active Pencil document is not a .pen file");
  const directory = path.join(path.dirname(penPath), ".pen-fig-assets");
  const paths: Record<string, string> = {};
  let totalBytes = 0;
  if (document.assets.length) await mkdir(directory, { recursive: true });

  for (const asset of document.assets) {
    const encoded = assetData[asset.id];
    if (!encoded) throw new Error(`Figma asset data missing for ${asset.id}`);
    if (!isStrictBase64(encoded.base64))
      throw new Error(`Figma asset ${asset.id} is not valid base64`);
    const bytes = Buffer.from(encoded.base64, "base64");
    if (bytes.byteLength !== encoded.byteLength)
      throw new Error(`Figma asset ${asset.id} length does not match`);
    if (bytes.byteLength > MAX_ASSET_BYTES)
      throw new Error(`Figma asset ${asset.id} exceeds 10 MiB`);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TOTAL_ASSET_BYTES)
      throw new Error("Figma assets exceed the 32 MiB transfer limit");
    const detected = detectMime(bytes);
    if (detected !== encoded.mimeType)
      throw new Error(`Figma asset ${asset.id} MIME type does not match`);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const extension = extensionForMime(detected);
    const filename = `${digest.slice(0, 32)}.${extension}`;
    await writeAtomicIfNeeded(path.join(directory, filename), bytes);
    paths[asset.id] = `./.pen-fig-assets/${filename}`;
  }
  return paths;
}

async function writeAtomicIfNeeded(
  target: string,
  bytes: Buffer,
): Promise<void> {
  try {
    const existing = await readFile(target);
    if (existing.equals(bytes)) return;
    throw new Error(`Asset cache collision at ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function isStrictBase64(value: string): boolean {
  return value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

function detectMime(bytes: Buffer): FigmaExportAssetData["mimeType"] {
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
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  throw new Error("Figma returned an unsupported image format");
}

function extensionForMime(mimeType: FigmaExportAssetData["mimeType"]): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return "png";
  }
}
