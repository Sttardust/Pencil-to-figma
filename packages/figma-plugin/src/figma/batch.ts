import { authoredDocumentHashes } from "@pen-fig/core";
import type { FigmaReadResult } from "./read.js";

export interface ExportPlanCounts {
  assets: number;
  inserts: number;
  finalizes: number;
}

export function validateFigmaExportBatch(results: FigmaReadResult[]): void {
  const totalNodes = results.reduce(
    (total, result) => total + result.nodeCount,
    0,
  );
  if (totalNodes > 5_000)
    throw new Error(
      `The selected screens contain ${totalNodes} editable layers. Send a smaller batch of 5,000 layers or fewer.`,
    );

  let totalAssetBytes = 0;
  for (const result of results) {
    let screenAssetBytes = 0;
    for (const asset of Object.values(result.assetData)) {
      if (asset.byteLength > 10 * 1024 * 1024)
        throw new Error(
          `“${result.document.root.name}” contains an image larger than 10 MiB. Compress that image before sending it.`,
        );
      screenAssetBytes += asset.byteLength;
    }
    if (screenAssetBytes > 32 * 1024 * 1024)
      throw new Error(
        `“${result.document.root.name}” contains more than 32 MiB of images. Compress its images before sending it.`,
      );
    totalAssetBytes += screenAssetBytes;
  }
  if (totalAssetBytes > 64 * 1024 * 1024)
    throw new Error(
      "The selected screens contain more than 64 MiB of images. Send fewer screens at once.",
    );

  const bridgeOwner = new Map<string, string>();
  for (const result of results) {
    const name = result.document.root.name;
    for (const bridgeId of Object.keys(
      authoredDocumentHashes(result.document),
    )) {
      const owner = bridgeOwner.get(bridgeId);
      if (owner)
        throw new Error(
          `“${owner}” and “${name}” share copied bridge identities. Export them separately or recreate one copy before linking them.`,
        );
      bridgeOwner.set(bridgeId, name);
    }
  }
}

export function sumExportPlanCounts(
  counts: ExportPlanCounts[],
): ExportPlanCounts {
  return counts.reduce(
    (total, current) => ({
      assets: total.assets + current.assets,
      inserts: total.inserts + current.inserts,
      finalizes: total.finalizes + current.finalizes,
    }),
    { assets: 0, inserts: 0, finalizes: 0 },
  );
}
