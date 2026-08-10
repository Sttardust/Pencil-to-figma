import { describe, expect, it } from "vitest";
import type { BridgeDocument, BridgeManifest } from "@pen-fig/bridge-schema";
import { authoredDocumentHashes, importPenDocument } from "@pen-fig/core";
import {
  buildFigmaExportManifest,
  collectMappedPenBridgeMappings,
  collectPenBridgeMappings,
} from "../src/manifest/figma-export.js";

describe("Figma export manifests", () => {
  it("builds a new baseline from Figma hashes and adopted Pencil IDs", () => {
    const document = figmaDocument();
    const previous: BridgeManifest = {
      version: 1,
      penDocumentId: "/tmp/orchid.pen",
      figmaDocumentId: "old-figma",
      revision: 4,
      updatedAt: "2026-08-01T00:00:00.000Z",
      mappings: [
        {
          bridgeId: "pen:root",
          penNodeId: "old-root",
          figmaNodeId: "old-figma-root",
          baselineHash: "a".repeat(64),
        },
      ],
    };
    const penMappings = collectPenBridgeMappings({
      id: "new-root",
      type: "frame",
      metadata: { type: "pen-fig-export", bridgeId: "pen:root" },
      children: [
        {
          id: "new-title",
          type: "text",
          metadata: { type: "pen-fig-bridge", bridgeId: "pen:title" },
        },
      ],
    });

    const manifest = buildFigmaExportManifest(
      document,
      penMappings,
      "/tmp/orchid.pen",
      {
        previous,
        penDocument: document,
        updatedAt: new Date("2026-08-08T12:00:00.000Z"),
      },
    );
    const hashes = authoredDocumentHashes(document);

    expect(manifest).toMatchObject({
      version: 1,
      revision: 5,
      penDocumentId: "/tmp/orchid.pen",
      figmaDocumentId: "figma-file",
      updatedAt: "2026-08-08T12:00:00.000Z",
      mappings: [
        {
          bridgeId: "pen:root",
          penNodeId: "new-root",
          figmaNodeId: "figma-root",
          baselineHash: hashes["pen:root"],
          penBaselineHash: hashes["pen:root"],
          figmaBaselineHash: hashes["pen:root"],
        },
        {
          bridgeId: "pen:title",
          penNodeId: "new-title",
          figmaNodeId: "figma-title",
          baselineHash: hashes["pen:title"],
          penBaselineHash: hashes["pen:title"],
          figmaBaselineHash: hashes["pen:title"],
        },
      ],
    });
  });

  it("rejects incomplete, unexpected, and duplicate Pencil mappings", () => {
    const document = figmaDocument();
    expect(() =>
      buildFigmaExportManifest(
        document,
        [{ bridgeId: "pen:root", penNodeId: "root" }],
        "/tmp/orchid.pen",
      ),
    ).toThrow("mapping count does not match");
    expect(() =>
      buildFigmaExportManifest(
        document,
        [
          { bridgeId: "pen:root", penNodeId: "root" },
          { bridgeId: "pen:unexpected", penNodeId: "other" },
        ],
        "/tmp/orchid.pen",
      ),
    ).toThrow("unexpected identity pen:unexpected");
    expect(() =>
      collectPenBridgeMappings({
        id: "root",
        type: "frame",
        metadata: { type: "bridge", bridgeId: "pen:same" },
        children: [
          {
            id: "child",
            type: "rectangle",
            metadata: { type: "bridge", bridgeId: "pen:same" },
          },
        ],
      }),
    ).toThrow("Duplicate Pencil bridge identity pen:same");
  });

  it("preserves mappings for other exported screens", () => {
    const previous: BridgeManifest = {
      version: 1,
      penDocumentId: "/tmp/orchid.pen",
      figmaDocumentId: "figma-file",
      revision: 2,
      updatedAt: "2026-08-01T00:00:00.000Z",
      mappings: [
        {
          bridgeId: "figma:other-root",
          rootBridgeId: "figma:other-root",
          penNodeId: "pen-other-root",
          figmaNodeId: "other-root",
          baselineHash: "a".repeat(64),
        },
      ],
    };
    const document = figmaDocument();
    const manifest = buildFigmaExportManifest(
      document,
      [
        { bridgeId: "pen:root", penNodeId: "new-root" },
        { bridgeId: "pen:title", penNodeId: "new-title" },
      ],
      "/tmp/orchid.pen",
      { previous, penDocument: document },
    );

    expect(manifest.mappings.map((mapping) => mapping.bridgeId)).toEqual([
      "figma:other-root",
      "pen:root",
      "pen:title",
    ]);
    expect(manifest.mappings.slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bridgeId: "pen:root",
          rootBridgeId: "pen:root",
        }),
        expect.objectContaining({
          bridgeId: "pen:title",
          rootBridgeId: "pen:root",
        }),
      ]),
    );
  });

  it("replaces a legacy single-screen manifest during migration", () => {
    const document = figmaDocument();
    const manifest = buildFigmaExportManifest(
      document,
      [
        { bridgeId: "pen:root", penNodeId: "new-root" },
        { bridgeId: "pen:title", penNodeId: "new-title" },
      ],
      "/tmp/orchid.pen",
      {
        previous: {
          version: 1,
          penDocumentId: "/tmp/orchid.pen",
          revision: 8,
          updatedAt: "2026-08-01T00:00:00.000Z",
          mappings: [
            {
              bridgeId: "pen:legacy",
              penNodeId: "legacy",
              baselineHash: "b".repeat(64),
            },
          ],
        },
        penDocument: document,
      },
    );

    expect(manifest.mappings.map((mapping) => mapping.bridgeId)).toEqual([
      "pen:root",
      "pen:title",
    ]);
  });

  it("resolves native Pencil identities from an existing sidecar mapping", () => {
    expect(
      collectMappedPenBridgeMappings(
        {
          id: "native-root",
          type: "frame",
          children: [{ id: "native-title", type: "text" }],
        },
        [
          { bridgeId: "pen:root", penNodeId: "native-root" },
          { bridgeId: "pen:title", penNodeId: "native-title" },
        ],
      ),
    ).toEqual([
      { bridgeId: "pen:root", penNodeId: "native-root" },
      { bridgeId: "pen:title", penNodeId: "native-title" },
    ]);
  });
});

function figmaDocument(): BridgeDocument {
  const document = importPenDocument(
    {
      id: "root",
      type: "frame",
      name: "Screen",
      width: 393,
      height: 844,
      children: [
        {
          id: "title",
          type: "text",
          content: "Hello",
          fontFamily: "Inter",
          fontSize: 24,
        },
      ],
    },
    { documentId: "/tmp/orchid.pen" },
  );
  document.source = { app: "figma", documentId: "figma-file" };
  visit(document.root, (node) => {
    node.source = {
      app: "figma",
      documentId: "figma-file",
      nodeId: node.bridgeId === "pen:root" ? "figma-root" : "figma-title",
    };
  });
  return document;
}

function visit(
  node: BridgeDocument["root"],
  callback: (node: BridgeDocument["root"]) => void,
): void {
  callback(node);
  for (const child of node.children) visit(child, callback);
}
