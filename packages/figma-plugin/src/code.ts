import { previewBridgeDocument, writeBridgeDocument } from "./figma/write.js";
import {
  readSelectedFigmaDocument,
  type FigmaReadResult,
} from "./figma/read.js";
import { planFigmaToPenCreate } from "@pen-fig/core";

let pendingFigmaExport: FigmaReadResult | undefined;

figma.showUI(__html__, { width: 360, height: 520, themeColors: true });

figma.ui.onmessage = async (message: { type: string }) => {
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
      figma.ui.postMessage({
        type: "import-result",
        ok: true,
        ...result,
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
