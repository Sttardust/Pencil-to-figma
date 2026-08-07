import { describe, expect, it } from "vitest";
import type { BridgeDocument } from "@pen-fig/bridge-schema";
import { resolveAssets } from "../src/assets/resolve.js";

function documentWithIcons(): BridgeDocument {
  return {
    version: 1,
    source: { app: "pen", documentId: "test.pen" },
    root: {
      bridgeId: "pen:root",
      source: { app: "pen", documentId: "test.pen", nodeId: "root" },
      kind: "frame",
      name: "Icons",
      visible: true,
      opacity: 1,
      rotation: 0,
      locked: false,
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      width: { mode: "fixed", value: 100 },
      height: { mode: "fixed", value: 100 },
      children: [],
    },
    assets: [
      {
        status: "pending",
        id: "asset:signal",
        kind: "svg",
        sourceUri: "icon://lucide/signal",
      },
      {
        status: "pending",
        id: "asset:search",
        kind: "svg",
        sourceUri: "icon://Material%20Symbols%20Rounded/search",
      },
    ],
    variables: [],
    warnings: [],
  };
}

describe("resolveAssets", () => {
  it("packages Lucide and Material Symbols icons as ready SVG assets", async () => {
    const result = await resolveAssets(documentWithIcons());

    expect(result.document.assets).toHaveLength(2);
    expect(result.document.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "ready",
          id: "asset:signal",
          kind: "svg",
          mimeType: "image/svg+xml",
        }),
        expect.objectContaining({
          status: "ready",
          id: "asset:search",
          kind: "svg",
          mimeType: "image/svg+xml",
        }),
      ]),
    );
    expect(result.assetData["asset:signal"]).toContain("<svg");
    expect(result.assetData["asset:search"]).toContain("<svg");
  });
});
