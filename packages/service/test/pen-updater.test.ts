import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { importPenDocument, type PenNode } from "@pen-fig/core";
import {
  writeFigmaStructureToPen,
  writeFigmaUpdatesToPen,
} from "../src/export/pen-updater.js";
import type { PenMcpClient } from "../src/pen/mcp-client.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("writeFigmaUpdatesToPen", () => {
  it("updates existing properties in one atomic Pencil transaction", async () => {
    const directory = await temporaryDirectory();
    const calls: string[] = [];
    const pen = {
      executeWrite: async (input: string) => {
        calls.push(input);
        return "OK\n\n## Print output\nUPDATED | pen:title | nativeTitle";
      },
    } as unknown as PenMcpClient;

    const result = await writeFigmaUpdatesToPen(
      figmaDocument("After"),
      ["pen:title"],
      mappings(),
      currentPenRoot(),
      {},
      path.join(directory, "design.pen"),
      pen,
    );

    expect(result).toEqual({
      operation: "updated",
      updatedNodeCount: 1,
      updatedBridgeIds: ["pen:title"],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('Update("nativeTitle"');
    expect(calls[0]).toContain('"content":"After"');
    expect(calls[0]).not.toContain('"type":"text"');
  });

  it("updates native Pencil nodes using sidecar identities", async () => {
    const directory = await temporaryDirectory();
    const calls: string[] = [];
    const pen = {
      executeWrite: async (input: string) => {
        calls.push(input);
        return "OK\n\n## Print output\nUPDATED | pen:title | nativeTitle";
      },
    } as unknown as PenMcpClient;
    const nativeRoot = currentPenRoot();
    delete nativeRoot.metadata;
    delete nativeRoot.children![0]!.metadata;

    const result = await writeFigmaUpdatesToPen(
      figmaDocument("After"),
      ["pen:title"],
      mappings(),
      nativeRoot,
      {},
      path.join(directory, "design.pen"),
      pen,
    );

    expect(result.updatedBridgeIds).toEqual(["pen:title"]);
    expect(calls[0]).toContain('Update("nativeTitle"');
  });

  it("rejects structural and native-type changes before writing", async () => {
    const directory = await temporaryDirectory();
    let writes = 0;
    const pen = {
      executeWrite: async () => {
        writes += 1;
        return "";
      },
    } as unknown as PenMcpClient;
    const structurallyChanged = figmaDocument("After");
    structurallyChanged.root.children.push({
      ...structurallyChanged.root.children[0]!,
      bridgeId: "pen:added",
      name: "Added",
      source: {
        app: "figma",
        documentId: "figma-file",
        nodeId: "figma-added",
      },
    });
    await expect(
      writeFigmaUpdatesToPen(
        structurallyChanged,
        ["pen:title"],
        mappings(),
        currentPenRoot(),
        {},
        path.join(directory, "design.pen"),
        pen,
      ),
    ).rejects.toThrow("Structural sync requires create/delete support");

    const wrongType = currentPenRoot();
    wrongType.children![0]!.type = "rectangle";
    await expect(
      writeFigmaUpdatesToPen(
        figmaDocument("After"),
        ["pen:title"],
        mappings(),
        wrongType,
        {},
        path.join(directory, "design.pen"),
        pen,
      ),
    ).rejects.toThrow("node type change requires replacement");
    expect(writes).toBe(0);
  });

  it("creates a Figma-added layer in the mapped Pencil parent", async () => {
    const directory = await temporaryDirectory();
    const calls: string[] = [];
    const pen = {
      executeWrite: async (input: string) => {
        calls.push(input);
        return "OK\n\n## Print output\nMAP | figma:added | nativeAdded\nSTRUCTURE_UPDATED | pen:root";
      },
    } as unknown as PenMcpClient;
    const document = figmaDocument("Title");
    document.root.children.push({
      ...structuredClone(document.root.children[0]!),
      bridgeId: "figma:added",
      name: "Added",
      source: {
        app: "figma",
        documentId: "figma-file",
        nodeId: "figma-added",
      },
    });

    const result = await writeFigmaStructureToPen(
      document,
      ["pen:root", "figma:added"],
      mappings(),
      currentPenRoot(),
      {},
      path.join(directory, "design.pen"),
      pen,
    );

    expect(result.updatedNodeCount).toBe(2);
    expect(result.mappings).toEqual([
      ...mappings(),
      { bridgeId: "figma:added", penNodeId: "nativeAdded" },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('Insert("nativeRoot"');
    expect(calls[0]).toContain('"bridgeId":"figma:added"');
  });

  it("deletes a Figma-removed layer in the same Pencil transaction", async () => {
    const directory = await temporaryDirectory();
    const calls: string[] = [];
    const pen = {
      executeWrite: async (input: string) => {
        calls.push(input);
        return "OK\n\n## Print output\nSTRUCTURE_UPDATED | pen:root";
      },
    } as unknown as PenMcpClient;
    const document = figmaDocument("Title");
    document.root.children = [];

    const result = await writeFigmaStructureToPen(
      document,
      ["pen:root", "pen:title"],
      mappings(),
      currentPenRoot(),
      {},
      path.join(directory, "design.pen"),
      pen,
    );

    expect(result.mappings).toEqual([
      { bridgeId: "pen:root", penNodeId: "nativeRoot" },
    ]);
    expect(calls[0]).toContain('Delete("nativeTitle")');
  });

  it("reorders existing Pencil layers with Move", async () => {
    const directory = await temporaryDirectory();
    const calls: string[] = [];
    const pen = {
      executeWrite: async (input: string) => {
        calls.push(input);
        return "OK\n\n## Print output\nSTRUCTURE_UPDATED | pen:root";
      },
    } as unknown as PenMcpClient;
    const document = figmaDocument("Title");
    const subtitle = {
      ...structuredClone(document.root.children[0]!),
      bridgeId: "pen:subtitle",
      name: "Subtitle",
      source: {
        app: "figma" as const,
        documentId: "figma-file",
        nodeId: "figma-subtitle",
      },
    };
    document.root.children.push(subtitle);
    document.root.children.reverse();
    const root = currentPenRoot();
    root.children!.push({
      ...structuredClone(root.children![0]!),
      id: "nativeSubtitle",
      name: "Subtitle",
      metadata: { type: "pen-fig-bridge", bridgeId: "pen:subtitle" },
    });
    const currentMappings = [
      ...mappings(),
      { bridgeId: "pen:subtitle", penNodeId: "nativeSubtitle" },
    ];

    await writeFigmaStructureToPen(
      document,
      ["pen:root"],
      currentMappings,
      root,
      {},
      path.join(directory, "design.pen"),
      pen,
    );

    expect(calls[0]).toContain('Move("nativeSubtitle","nativeRoot",0)');
  });
});

function figmaDocument(content: string) {
  const document = importPenDocument(
    {
      id: "root",
      type: "frame",
      name: "Screen",
      width: 393,
      height: 844,
      layout: "none",
      children: [
        {
          id: "title",
          type: "text",
          name: "Title",
          content,
          x: 20,
          y: 20,
          width: 200,
          height: 30,
          textGrowth: "fixed-width-height",
          fontFamily: "Inter",
          fontStyle: "Regular",
          fontSize: 20,
        },
      ],
    },
    { documentId: "source.pen" },
  );
  document.source = { app: "figma", documentId: "figma-file" };
  document.root.source = {
    app: "figma",
    documentId: "figma-file",
    nodeId: "figma-root",
  };
  document.root.children[0]!.source = {
    app: "figma",
    documentId: "figma-file",
    nodeId: "figma-title",
  };
  return document;
}

function currentPenRoot(): PenNode {
  return {
    id: "nativeRoot",
    type: "frame",
    name: "Screen · Figma Copy",
    width: 393,
    height: 844,
    layout: "none",
    metadata: { type: "pen-fig-export", bridgeId: "pen:root" },
    children: [
      {
        id: "nativeTitle",
        type: "text",
        name: "Title",
        content: "Before",
        x: 20,
        y: 20,
        width: 200,
        height: 30,
        textGrowth: "fixed-width-height",
        fontFamily: "Inter",
        fontStyle: "Regular",
        fontSize: 20,
        metadata: { type: "pen-fig-bridge", bridgeId: "pen:title" },
      },
    ],
  };
}

function mappings() {
  return [
    { bridgeId: "pen:root", penNodeId: "nativeRoot" },
    { bridgeId: "pen:title", penNodeId: "nativeTitle" },
  ];
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pen-updater-"));
  temporaryDirectories.push(directory);
  return directory;
}
