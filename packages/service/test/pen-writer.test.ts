import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { importPenDocument } from "@pen-fig/core";
import type { PenMcpClient } from "../src/pen/mcp-client.js";
import { writeFigmaCopyToPen } from "../src/export/pen-writer.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("writeFigmaCopyToPen", () => {
  it("stages assets and creates a mapped Pencil copy", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pen-writer-"));
    temporaryDirectories.push(directory);
    const document = fixture();
    document.assets.push({
      status: "pending",
      id: "figma-image:one",
      kind: "image",
      sourceUri: "figma-image://one",
    });
    document.root.children[0]!.fills = [
      {
        type: "image",
        visible: true,
        opacity: 1,
        blendMode: "normal",
        assetId: "figma-image:one",
        scaleMode: "fill",
      },
    ];
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    let nextId = 1;
    const calls: string[] = [];
    let emptySpaceRequest:
      | { width: number; height: number; anchorId?: string; padding: number }
      | undefined;
    const pen = {
      getTopLevelBounds: async () => ({
        x: 100,
        y: 200,
        width: 393,
        height: 844,
      }),
      findEmptySpace: async (
        width: number,
        height: number,
        anchorId?: string,
        padding = 120,
      ) => {
        emptySpaceRequest = { width, height, anchorId, padding };
        return { x: 700, y: 200 };
      },
      executeWrite: async (input: string) => {
        calls.push(input);
        const lines: string[] = [];
        for (const match of input.matchAll(
          /Print\("MAP","\|","([^"]+)","\|",[A-Za-z0-9_]+\)/g,
        ))
          lines.push(`MAP | ${match[1]} | p${nextId++}`);
        return lines.join("\n");
      },
    } as unknown as PenMcpClient;

    const result = await writeFigmaCopyToPen(
      document,
      {
        "figma-image:one": {
          base64: png.toString("base64"),
          mimeType: "image/png",
          byteLength: png.byteLength,
        },
      },
      path.join(directory, "design.pen"),
      pen,
    );

    expect(result).toMatchObject({
      rootId: "p1",
      nodeCount: 2,
      assetCount: 1,
      mappings: [
        { bridgeId: "pen:root", penNodeId: "p1" },
        { bridgeId: "pen:card", penNodeId: "p2" },
      ],
    });
    expect(emptySpaceRequest).toEqual({
      width: 393,
      height: 844,
      anchorId: "root",
      padding: 120,
    });
    expect(calls.join("\n")).toContain('"x":700');
    expect(calls.join("\n")).toContain(".pen-fig-assets/");
    expect(await readdir(path.join(directory, ".pen-fig-assets"))).toHaveLength(
      1,
    );
  });

  it("deletes a discoverable partial root when a write fails", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pen-writer-"));
    temporaryDirectories.push(directory);
    const calls: string[] = [];
    const pen = {
      getTopLevelBounds: async () => undefined,
      findEmptySpace: async () => ({ x: 700, y: 200 }),
      findExportRoot: async () => "partial1",
      executeWrite: async (input: string) => {
        calls.push(input);
        if (!input.startsWith("Delete")) throw new Error("simulated failure");
        return "OK";
      },
    } as unknown as PenMcpClient;

    await expect(
      writeFigmaCopyToPen(
        fixture(),
        {},
        path.join(directory, "design.pen"),
        pen,
      ),
    ).rejects.toThrow("Rolled back 1 partial root");
    expect(calls.at(-1)).toBe('Delete("partial1")');
  });

  it("creates component dependencies before instances and maps overrides", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pen-writer-"));
    temporaryDirectories.push(directory);
    const document = fixture();
    const card = document.root.children[0]!;
    document.components = [
      {
        ...structuredClone(card),
        bridgeId: "figma:component",
        kind: "component",
        name: "Button",
        component: { key: "button-key" },
        children: [
          {
            ...structuredClone(card),
            bridgeId: "figma:component-label",
            kind: "text",
            name: "Label",
            text: {
              characters: "Button",
              resize: "auto",
              style: {
                family: "Inter",
                style: "Regular",
                weight: 400,
                size: 16,
                lineHeight: { unit: "auto" },
                letterSpacing: 0,
                horizontalAlign: "left",
                verticalAlign: "top",
                decoration: "none",
              },
            },
            children: [],
          },
        ],
      },
    ];
    document.root.children = [
      {
        ...structuredClone(card),
        bridgeId: "figma:instance",
        kind: "instance",
        name: "Button instance",
        instance: {
          componentBridgeId: "figma:component",
          overrides: {
            "figma:component-label": { content: "Continue" },
          },
        },
        children: [],
      },
    ];
    let nextId = 1;
    const calls: string[] = [];
    const pen = {
      getTopLevelBounds: async () => undefined,
      findEmptySpace: async (width: number, height: number) => {
        expect({ width, height }).toEqual({ width: 613, height: 844 });
        return { x: 700, y: 200 };
      },
      executeWrite: async (input: string) => {
        calls.push(input);
        const mappings = [
          ...input.matchAll(
            /Print\("MAP","\|","([^"]+)","\|",[A-Za-z0-9_]+\)/g,
          ),
        ];
        return mappings.length
          ? mappings
              .map((mapping) => `MAP | ${mapping[1]} | p${nextId++}`)
              .join("\n")
          : "OK";
      },
    } as unknown as PenMcpClient;

    const result = await writeFigmaCopyToPen(
      document,
      {},
      path.join(directory, "design.pen"),
      pen,
    );

    expect(result.rootId).toBe("p3");
    expect(result.mappings).toEqual([
      { bridgeId: "figma:component", penNodeId: "p1" },
      { bridgeId: "figma:component-label", penNodeId: "p2" },
      { bridgeId: "pen:root", penNodeId: "p3" },
      { bridgeId: "figma:instance", penNodeId: "p4" },
    ]);
    const script = calls.join("\n");
    expect(script).toContain('"reusable":true');
    expect(script).toContain('"ref":"p1"');
    expect(script).toContain('"descendants":{"p2":{"content":"Continue"}}');
  });
});

function fixture() {
  const document = importPenDocument(
    {
      id: "root",
      type: "frame",
      name: "Export",
      width: 393,
      height: 844,
      layout: "none",
      children: [
        {
          id: "card",
          type: "rectangle",
          x: 20,
          y: 20,
          width: 100,
          height: 100,
        },
      ],
    },
    { documentId: "test.pen" },
  );
  document.source = { app: "figma", documentId: "figma-local" };
  return document;
}
