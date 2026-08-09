import {
  previewBridgeDocument,
  writeBridgeDocument,
  writeBridgeNodeUpdates,
} from "./figma/write.js";
import {
  readSelectedFigmaDocument,
  type FigmaReadResult,
} from "./figma/read.js";
import { authoredDocumentHashes, planFigmaToPenCreate } from "@pen-fig/core";

let pendingFigmaExport: FigmaReadResult | undefined;

figma.showUI(__html__, { width: 400, height: 700, themeColors: true });

figma.ui.onmessage = async (message: {
  type: string;
  token?: unknown;
  penRootId?: unknown;
  direction?: unknown;
  bridgeId?: unknown;
}) => {
  if (message.type === "selection-summary") {
    await figma.currentPage.loadAsync();
    figma.ui.postMessage({
      type: "selection-summary",
      nodes: figma.currentPage.selection.map((node) => ({
        id: node.id,
        name: node.name,
        nodeType: node.type,
      })),
    });
  }

  if (message.type === "reversible-write-test") {
    const rectangle = figma.createRectangle();
    rectangle.name = "Pencil Bridge Transport Test";
    rectangle.resize(16, 16);
    const id = rectangle.id;
    rectangle.remove();
    figma.ui.postMessage({ type: "write-test-result", ok: true, id });
  }

  if (message.type === "preview-figma-export") {
    try {
      const result = await readSelectedFigmaDocument();
      pendingFigmaExport = result;
      figma.ui.postMessage({
        type: "figma-export-preview",
        ok: true,
        root: {
          bridgeId: result.document.root.bridgeId,
          name: result.document.root.name,
          kind: result.document.root.kind,
        },
        nodeCount: result.nodeCount,
        fonts: result.fonts,
        assets: {
          total: result.document.assets.length,
          images: result.document.assets.filter(
            (asset) => asset.kind === "image",
          ).length,
          svg: result.document.assets.filter((asset) => asset.kind === "svg")
            .length,
        },
        warnings: result.document.warnings.map((warning) => ({
          code: warning.code,
          action: warning.action,
          message: warning.message,
        })),
      });
    } catch (error) {
      pendingFigmaExport = undefined;
      figma.ui.postMessage({
        type: "figma-export-preview",
        ok: false,
        message: error instanceof Error ? error.message : "Figma read failed",
      });
    }
  }

  if (message.type === "plan-figma-export") {
    try {
      if (!pendingFigmaExport)
        throw new Error("Preview the selected Figma frame first");
      const plan = planFigmaToPenCreate(pendingFigmaExport.document);
      figma.ui.postMessage({
        type: "figma-export-plan",
        ok: true,
        mode: plan.mode,
        rootBridgeId: plan.rootBridgeId,
        counts: plan.counts,
        chunks: plan.chunks.map((chunk) => ({
          index: chunk.index,
          operations: chunk.operations.length,
          estimatedBytes: chunk.estimatedBytes,
        })),
        warnings: plan.warnings.map((warning) => ({
          code: warning.code,
          action: warning.action,
          message: warning.message,
        })),
      });
    } catch (error) {
      figma.ui.postMessage({
        type: "figma-export-plan",
        ok: false,
        message:
          error instanceof Error ? error.message : "Export planning failed",
      });
    }
  }

  if (message.type === "execute-figma-export") {
    try {
      if (!pendingFigmaExport)
        throw new Error("Preview the selected Figma frame first");
      if (typeof message.token !== "string" || !message.token)
        throw new Error("Pair and authenticate first");
      const response = await fetch(
        `http://localhost:32145/figma/export?token=${encodeURIComponent(message.token)}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-pen-fig-token": message.token,
          },
          body: JSON.stringify({
            document: pendingFigmaExport.document,
            assetData: pendingFigmaExport.assetData,
          }),
        },
      );
      const result = (await response.json()) as Record<string, unknown>;
      if (!response.ok)
        throw new Error(
          typeof result.message === "string"
            ? result.message
            : `Bridge error ${response.status}`,
        );
      figma.ui.postMessage(result);
    } catch (error) {
      figma.ui.postMessage({
        type: "figma-export-result",
        ok: false,
        message:
          error instanceof Error ? error.message : "Pencil export failed",
      });
    }
  }

  if (message.type === "adopt-figma-export") {
    try {
      if (!pendingFigmaExport)
        throw new Error("Preview the selected Figma frame first");
      if (typeof message.token !== "string" || !message.token)
        throw new Error("Pair and authenticate first");
      if (
        typeof message.penRootId !== "string" ||
        !/^[A-Za-z0-9]+$/.test(message.penRootId)
      )
        throw new Error("Enter a valid Pencil root ID");
      const response = await fetch(
        `http://localhost:32145/figma/export/adopt?token=${encodeURIComponent(message.token)}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-pen-fig-token": message.token,
          },
          body: JSON.stringify({
            document: pendingFigmaExport.document,
            penRootId: message.penRootId,
          }),
        },
      );
      const result = (await response.json()) as Record<string, unknown>;
      if (!response.ok)
        throw new Error(
          typeof result.message === "string"
            ? result.message
            : `Bridge error ${response.status}`,
        );
      figma.ui.postMessage(result);
    } catch (error) {
      figma.ui.postMessage({
        type: "figma-export-adopted",
        ok: false,
        message:
          error instanceof Error ? error.message : "Pencil adoption failed",
      });
    }
  }

  if (message.type === "preview-mapped-sync") {
    try {
      if (typeof message.token !== "string" || !message.token)
        throw new Error("Pair and authenticate first");
      const selectedFigma = await readSelectedFigmaDocument();
      pendingFigmaExport = selectedFigma;
      const response = await fetch(
        `http://localhost:32145/figma/sync/preview?token=${encodeURIComponent(message.token)}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-pen-fig-token": message.token,
          },
          body: JSON.stringify({ document: selectedFigma.document }),
        },
      );
      const result = (await response.json()) as Record<string, unknown>;
      if (!response.ok)
        throw new Error(
          typeof result.message === "string"
            ? result.message
            : `Bridge error ${response.status}`,
        );
      figma.ui.postMessage(result);
    } catch (error) {
      figma.ui.postMessage({
        type: "figma-sync-preview",
        ok: false,
        message: error instanceof Error ? error.message : "Sync preview failed",
      });
    }
  }

  if (message.type === "apply-mapped-sync") {
    try {
      if (!pendingFigmaExport) throw new Error("Preview mapped sync first");
      if (typeof message.token !== "string" || !message.token)
        throw new Error("Pair and authenticate first");
      const response = await fetch(
        `http://localhost:32145/figma/sync/apply?token=${encodeURIComponent(message.token)}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-pen-fig-token": message.token,
          },
          body: JSON.stringify({
            document: pendingFigmaExport.document,
            assetData: pendingFigmaExport.assetData,
          }),
        },
      );
      const result = (await response.json()) as Record<string, unknown>;
      if (!response.ok)
        throw new Error(
          typeof result.message === "string"
            ? result.message
            : `Bridge error ${response.status}`,
        );
      figma.ui.postMessage(
        result.type === "figma-sync-resolution-prepared"
          ? await completePreparedFigmaUpdate(result, message.token)
          : result,
      );
    } catch (error) {
      figma.ui.postMessage({
        type: "figma-sync-result",
        ok: false,
        message: error instanceof Error ? error.message : "Sync apply failed",
      });
    }
  }

  if (message.type === "resolve-mapped-sync") {
    try {
      if (!pendingFigmaExport) throw new Error("Preview mapped sync first");
      if (typeof message.token !== "string" || !message.token)
        throw new Error("Pair and authenticate first");
      if (message.direction !== "pen" && message.direction !== "figma")
        throw new Error("Choose Pencil or Figma as the conflict winner");
      if (typeof message.bridgeId !== "string" || !message.bridgeId)
        throw new Error("Choose a mapped conflict root");
      const response = await fetch(
        `http://localhost:32145/figma/sync/resolve?token=${encodeURIComponent(message.token)}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-pen-fig-token": message.token,
          },
          body: JSON.stringify({
            document: pendingFigmaExport.document,
            assetData: pendingFigmaExport.assetData,
            direction: message.direction,
            bridgeId: message.bridgeId,
          }),
        },
      );
      const prepared = (await response.json()) as Record<string, unknown>;
      if (!response.ok)
        throw new Error(
          typeof prepared.message === "string"
            ? prepared.message
            : `Bridge error ${response.status}`,
        );
      if (prepared.type !== "figma-sync-resolution-prepared") {
        figma.ui.postMessage(prepared);
        return;
      }
      figma.ui.postMessage(
        await completePreparedFigmaUpdate(prepared, message.token),
      );
    } catch (error) {
      figma.ui.postMessage({
        type: "figma-sync-result",
        ok: false,
        message:
          error instanceof Error ? error.message : "Conflict resolution failed",
      });
    }
  }

  if (message.type === "apply-document" && "document" in message) {
    try {
      const result = await writeBridgeDocument(
        message.document,
        "assetData" in message &&
          message.assetData &&
          typeof message.assetData === "object"
          ? (message.assetData as Record<string, string>)
          : {},
      );
      const verified = await readSelectedFigmaDocument({
        collectAssetData: false,
      });
      const figmaBaselineHashes = verifiedFigmaBaselineHashes(
        result.mappings,
        verified,
      );
      figma.ui.postMessage({
        type: "import-result",
        ok: true,
        ...result,
        figmaBaselineHashes,
        ...(figma.fileKey ? { figmaDocumentId: figma.fileKey } : {}),
      });
    } catch (error) {
      figma.ui.postMessage({
        type: "import-result",
        ok: false,
        message: error instanceof Error ? error.message : "Figma import failed",
      });
    }
  }

  if (message.type === "preview-document" && "document" in message) {
    try {
      const result = await previewBridgeDocument(message.document);
      figma.ui.postMessage({ type: "import-preview", ok: true, ...result });
    } catch (error) {
      figma.ui.postMessage({
        type: "import-preview",
        ok: false,
        message: error instanceof Error ? error.message : "Preview failed",
      });
    }
  }
};

function verifiedFigmaBaselineHashes(
  mappings: Array<{ bridgeId: string; figmaNodeId: string }>,
  verified: FigmaReadResult,
): Record<string, string> {
  const hashes = authoredDocumentHashes(verified.document);
  const expectedBridgeIds = new Set(
    mappings.map((mapping) => mapping.bridgeId),
  );
  const missing = [...expectedBridgeIds].filter(
    (bridgeId) => !Object.hasOwn(hashes, bridgeId),
  );
  const unexpected = Object.keys(hashes).filter(
    (bridgeId) => !expectedBridgeIds.has(bridgeId),
  );
  if (missing.length || unexpected.length)
    throw new Error(
      `Figma read-back identity mismatch (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"})`,
    );
  return hashes;
}

async function completePreparedFigmaUpdate(
  prepared: Record<string, unknown>,
  token: string,
): Promise<Record<string, unknown>> {
  if (
    typeof prepared.resolutionId !== "string" ||
    !Array.isArray(prepared.bridgeIds) ||
    !prepared.bridgeIds.every((bridgeId) => typeof bridgeId === "string") ||
    !prepared.document ||
    typeof prepared.document !== "object"
  )
    throw new Error("Bridge returned an invalid Figma update");
  const assetData =
    prepared.assetData && typeof prepared.assetData === "object"
      ? (prepared.assetData as Record<string, string>)
      : {};
  if (prepared.structural === true)
    await writeBridgeDocument(prepared.document, assetData);
  else
    await writeBridgeNodeUpdates(
      prepared.document,
      prepared.bridgeIds as string[],
      assetData,
    );
  const verified = await readSelectedFigmaDocument();
  const response = await fetch(
    `http://localhost:32145/figma/sync/resolve/complete?token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pen-fig-token": token,
      },
      body: JSON.stringify({
        resolutionId: prepared.resolutionId,
        document: verified.document,
      }),
    },
  );
  const completed = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    figma.triggerUndo();
    throw new Error(
      typeof completed.message === "string"
        ? completed.message
        : `Bridge error ${response.status}`,
    );
  }
  pendingFigmaExport = verified;
  return completed;
}
