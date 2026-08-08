import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import lucide from "@iconify-json/lucide/icons.json" with { type: "json" };
import materialSymbols from "@iconify-json/material-symbols/icons.json" with { type: "json" };
import phosphor from "@iconify-json/ph/icons.json" with { type: "json" };
import { getIconData, iconToSVG } from "@iconify/utils";
import {
  bridgeDocumentSchema,
  type BridgeDocument,
} from "@pen-fig/bridge-schema";

const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

export interface ResolvedAssets {
  document: BridgeDocument;
  assetData: Record<string, string>;
}

export async function resolveAssets(
  document: BridgeDocument,
): Promise<ResolvedAssets> {
  const assetData: Record<string, string> = {};
  const resolvedEntries = await Promise.all(
    document.assets.map(async (asset) => {
      if (asset.status === "ready") {
        return { asset };
      }
      const resolved =
        asset.kind === "svg"
          ? resolveIcon(asset.sourceUri)
          : await resolveBinary(asset.sourceUri, document.source.documentId);
      const data =
        asset.kind === "svg"
          ? new TextDecoder().decode(resolved.bytes)
          : bytesToBase64(resolved.bytes);
      return {
        asset: {
          status: "ready" as const,
          id: asset.id,
          kind: asset.kind,
          mimeType: resolved.mimeType,
          sha256: createHash("sha256").update(resolved.bytes).digest("hex"),
          byteLength: resolved.bytes.byteLength,
          sourceUri: asset.sourceUri,
        },
        data,
      };
    }),
  );
  const totalBytes = resolvedEntries.reduce(
    (total, entry) =>
      total + (entry.asset.status === "ready" ? entry.asset.byteLength : 0),
    0,
  );
  if (totalBytes > MAX_TOTAL_BYTES)
    throw new Error("Transfer assets exceed the 25 MiB limit");
  for (const entry of resolvedEntries) {
    if (entry.data !== undefined) assetData[entry.asset.id] = entry.data;
  }
  const assets = resolvedEntries.map((entry) => entry.asset);
  return {
    document: bridgeDocumentSchema.parse({ ...document, assets }),
    assetData,
  };
}

function resolveIcon(sourceUri: string): {
  bytes: Uint8Array;
  mimeType: string;
} {
  const url = new URL(sourceUri);
  const library = decodeURIComponent(url.hostname);
  const sourceName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const name = sourceName.replaceAll("_", "-");
  const collection =
    library === "lucide"
      ? lucide
      : library.toLowerCase() === "phosphor"
        ? phosphor
        : library === "Material Symbols Rounded"
          ? materialSymbols
          : undefined;
  const iconName =
    library === "Material Symbols Rounded" ? `${name}-rounded` : name;
  const icon = collection ? getIconData(collection, iconName) : undefined;
  if (!icon) throw new Error(`Icon not found: ${library}/${sourceName}`);
  const rendered = iconToSVG(icon, { height: "24", width: "24" });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" ${attributes(rendered.attributes)}>${rendered.body}</svg>`;
  return { bytes: new TextEncoder().encode(svg), mimeType: "image/svg+xml" };
}

async function resolveBinary(
  sourceUri: string,
  documentId: string,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  if (/^https?:\/\//.test(sourceUri)) {
    const response = await fetch(sourceUri, {
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok)
      throw new Error(
        `Asset request failed (${response.status}): ${sourceUri}`,
      );
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_ASSET_BYTES)
      throw new Error(`Asset exceeds 10 MiB: ${sourceUri}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_ASSET_BYTES)
      throw new Error(`Asset exceeds 10 MiB: ${sourceUri}`);
    return {
      bytes,
      mimeType:
        response.headers.get("content-type")?.split(";")[0] ??
        "application/octet-stream",
    };
  }
  const filePath = path.resolve(path.dirname(documentId), sourceUri);
  const bytes = new Uint8Array(await readFile(filePath));
  if (bytes.byteLength > MAX_ASSET_BYTES)
    throw new Error(`Asset exceeds 10 MiB: ${filePath}`);
  return { bytes, mimeType: mimeFromPath(filePath) };
}

function attributes(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key}="${value}"`)
    .join(" ");
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function mimeFromPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
}
