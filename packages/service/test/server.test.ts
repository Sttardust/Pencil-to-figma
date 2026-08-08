import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BridgeServer } from "../src/server.js";
import type { PenMcpClient } from "../src/pen/mcp-client.js";
import { importPenDocument, type PenNode } from "@pen-fig/core";
import type { BridgeDocument } from "@pen-fig/bridge-schema";

const servers: BridgeServer[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("BridgeServer", () => {
  it("pairs and reads Pen screens over loopback HTTP", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pen-fig-server-"));
    temporaryDirectories.push(directory);
    const penPath = path.join(directory, "test.pen");
    const pen = {
      getAppState: async () => ({
        text: `- Currently active canvas editor: \`${penPath}\``,
      }),
      listRootFrames: async () => "abc | Screen",
      searchRootFrames: async () => "abc | Screen",
      getNode: async () => ({
        id: "abc",
        type: "frame",
        name: "Screen",
        width: 393,
        height: 844,
        children: [],
      }),
    } as PenMcpClient;
    const server = new BridgeServer({ host: "127.0.0.1", port: 0, pen });
    servers.push(server);
    const port = await server.start();
    const origin = `http://localhost:${port}`;
    const pairResponse = await fetch(`${origin}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "pair",
        protocol: 1,
        code: server.pairingCode,
      }),
    });
    const paired = await pairResponse.json();
    expect(pairResponse.status).toBe(200);
    const token = encodeURIComponent(String(paired.token));
    const hello = await fetch(`${origin}/hello?token=${token}`, {
      method: "POST",
    });
    expect(await hello.json()).toMatchObject({ type: "ready", protocol: 1 });
    const screens = await fetch(`${origin}/pen/screens?token=${token}`);
    expect(await screens.json()).toMatchObject({
      type: "pen-screens",
      text: "abc | Screen",
    });
    const search = await fetch(
      `${origin}/pen/screen-search?query=Screen&token=${token}`,
    );
    expect(await search.json()).toMatchObject({
      type: "pen-screens",
      requestId: "search",
      text: "abc | Screen",
    });
    const node = await fetch(`${origin}/pen/nodes/abc?token=${token}`);
    const transferred = await node.json();
    expect(transferred).toMatchObject({
      type: "pen-document",
      transferId: expect.any(String),
      document: { root: { bridgeId: "pen:abc", name: "Screen" } },
    });
    const completed = await fetch(`${origin}/sync/complete?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        transferId: transferred.transferId,
        mappings: [{ bridgeId: "pen:abc", figmaNodeId: "1:2" }],
      }),
    });
    expect(await completed.json()).toMatchObject({
      type: "sync-committed",
      revision: 0,
      mappingCount: 1,
      manifestPath: path.join(directory, "test.pen-fig.json"),
    });
    expect(
      JSON.parse(
        await readFile(path.join(directory, "test.pen-fig.json"), "utf8"),
      ),
    ).toMatchObject({
      version: 1,
      revision: 0,
      mappings: [{ bridgeId: "pen:abc", figmaNodeId: "1:2" }],
    });
  });

  it("pairs, authenticates, and reports Pen readiness", async () => {
    const pen = {
      getAppState: async () => ({
        text: "- Currently active canvas editor: `/tmp/test.pen`",
      }),
      listRootFrames: async () => "abc | Screen",
    } as PenMcpClient;
    const server = new BridgeServer({ host: "127.0.0.1", port: 0, pen });
    servers.push(server);
    const port = await server.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    await onceOpen(socket);

    socket.send(
      JSON.stringify({ type: "pair", protocol: 1, code: server.pairingCode }),
    );
    const paired = await onceMessage(socket);
    expect(paired.type).toBe("paired");

    socket.send(
      JSON.stringify({ type: "hello", protocol: 1, token: paired.token }),
    );
    const ready = await onceMessage(socket);
    expect(ready).toEqual({
      type: "ready",
      protocol: 1,
      penState: "- Currently active canvas editor: `/tmp/test.pen`",
    });
    socket.close();
  });

  it("adopts an existing Pencil copy and commits its Figma baseline", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pen-fig-adopt-"));
    temporaryDirectories.push(directory);
    const penPath = path.join(directory, "test.pen");
    const adoptedRoot: PenNode = {
      id: "adoptedRoot",
      type: "frame",
      metadata: { type: "pen-fig-export", bridgeId: "pen:root" },
      children: [
        {
          id: "adoptedTitle",
          type: "text",
          content: "Hello",
          metadata: { type: "pen-fig-bridge", bridgeId: "pen:title" },
        },
      ],
    };
    let executeWriteCount = 0;
    const pen = {
      getAppState: async () => ({
        text: `- Currently active canvas editor: \`${penPath}\``,
      }),
      getNode: async () => structuredClone(adoptedRoot),
      executeWrite: async (input: string) => {
        executeWriteCount += 1;
        const content = /"content":"([^"]+)"/.exec(input)?.[1];
        if (content) adoptedRoot.children![0]!.content = content;
        return "OK\n\n## Print output\nUPDATED | pen:title | adoptedTitle";
      },
    } as PenMcpClient;
    const server = new BridgeServer({ host: "127.0.0.1", port: 0, pen });
    servers.push(server);
    const port = await server.start();
    const origin = `http://localhost:${port}`;
    const paired = await fetch(`${origin}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "pair",
        protocol: 1,
        code: server.pairingCode,
      }),
    }).then((response) => response.json());
    const token = encodeURIComponent(String(paired.token));
    await fetch(`${origin}/hello?token=${token}`, { method: "POST" });

    const response = await fetch(
      `${origin}/figma/export/adopt?token=${token}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          document: figmaExportDocument(),
          penRootId: "adoptedRoot",
        }),
      },
    );
    const adopted = await response.json();

    expect(response.status).toBe(200);
    expect(adopted).toMatchObject({
      type: "figma-export-adopted",
      ok: true,
      rootId: "adoptedRoot",
      nodeCount: 2,
      manifest: { revision: 0, mappingCount: 2 },
    });
    expect(
      JSON.parse(
        await readFile(path.join(directory, "test.pen-fig.json"), "utf8"),
      ),
    ).toMatchObject({
      figmaDocumentId: "figma-file",
      revision: 0,
      mappings: [
        {
          bridgeId: "pen:root",
          penNodeId: "adoptedRoot",
          penBaselineHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          figmaBaselineHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        {
          bridgeId: "pen:title",
          penNodeId: "adoptedTitle",
          penBaselineHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          figmaBaselineHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      ],
    });

    const previewResponse = await fetch(
      `${origin}/figma/sync/preview?token=${token}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document: figmaExportDocument() }),
      },
    );
    expect(previewResponse.status).toBe(200);
    expect(await previewResponse.json()).toMatchObject({
      type: "figma-sync-preview",
      ok: true,
      manifestRevision: 0,
      counts: { unchanged: 2, conflicted: 0 },
      actions: { toPencil: 0, toFigma: 0, conflicts: 0, unmapped: 0 },
      canApplyWithoutResolution: true,
      baselineUpgradeRequired: false,
    });

    const editedDocument = figmaExportDocument();
    editedDocument.root.children[0]!.text!.characters = "Updated in Figma";
    const changedPreview = await fetch(
      `${origin}/figma/sync/preview?token=${token}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document: editedDocument }),
      },
    );
    expect(await changedPreview.json()).toMatchObject({
      counts: { "figma-only": 1, conflicted: 0 },
      actions: { toPencil: 1, toFigma: 0 },
    });

    const applyResponse = await fetch(
      `${origin}/figma/sync/apply?token=${token}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document: editedDocument, assetData: {} }),
      },
    );
    expect(applyResponse.status).toBe(200);
    expect(await applyResponse.json()).toMatchObject({
      type: "figma-sync-result",
      ok: true,
      operation: "updated-pen",
      updatedNodeCount: 1,
      updatedBridgeIds: ["pen:title"],
      manifest: { revision: 1, mappingCount: 2 },
    });
    expect(adoptedRoot.children?.[0]?.content).toBe("Updated in Figma");
    expect(executeWriteCount).toBe(1);

    adoptedRoot.children![0]!.content = "Pencil conflict";
    const conflictDocument = figmaExportDocument();
    conflictDocument.root.children[0]!.text!.characters = "Figma conflict";
    const conflictPreview = await fetch(
      `${origin}/figma/sync/preview?token=${token}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document: conflictDocument }),
      },
    );
    expect(await conflictPreview.json()).toMatchObject({
      counts: { conflicted: 1 },
      actions: { conflicts: 1 },
      conflictRoots: [{ bridgeId: "pen:title" }],
      canApplyWithoutResolution: false,
    });
    expect(executeWriteCount).toBe(1);

    const keepFigmaResponse = await fetch(
      `${origin}/figma/sync/resolve?token=${token}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          document: conflictDocument,
          assetData: {},
          direction: "figma",
          bridgeId: "pen:title",
        }),
      },
    );
    const keepFigmaResult = await keepFigmaResponse.json();
    expect(keepFigmaResult).toMatchObject({
      type: "figma-sync-result",
      ok: true,
      operation: "resolved-keep-figma",
      resolvedBridgeId: "pen:title",
      updatedNodeCount: 1,
      manifest: { revision: 2, mappingCount: 2 },
    });
    expect(keepFigmaResponse.status).toBe(200);
    expect(adoptedRoot.children?.[0]?.content).toBe("Figma conflict");
    expect(executeWriteCount).toBe(2);

    adoptedRoot.children![0]!.content = "Pencil wins";
    const losingFigmaDocument = figmaExportDocument();
    losingFigmaDocument.root.children[0]!.text!.characters = "Figma loses";
    const prepareKeepPencil = await fetch(
      `${origin}/figma/sync/resolve?token=${token}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          document: losingFigmaDocument,
          assetData: {},
          direction: "pen",
          bridgeId: "pen:title",
        }),
      },
    );
    expect(prepareKeepPencil.status).toBe(200);
    const prepared = await prepareKeepPencil.json();
    expect(prepared).toMatchObject({
      type: "figma-sync-resolution-prepared",
      ok: true,
      direction: "pen",
      resolutionId: expect.any(String),
      bridgeIds: ["pen:title"],
      document: {
        root: {
          children: [{ text: { characters: "Pencil wins" } }],
        },
      },
    });
    expect(executeWriteCount).toBe(2);

    const resolvedFigmaDocument = figmaExportDocument();
    resolvedFigmaDocument.root.children[0]!.text!.characters = "Pencil wins";
    const completeKeepPencil = await fetch(
      `${origin}/figma/sync/resolve/complete?token=${token}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resolutionId: prepared.resolutionId,
          document: resolvedFigmaDocument,
        }),
      },
    );
    expect(completeKeepPencil.status).toBe(200);
    expect(await completeKeepPencil.json()).toMatchObject({
      type: "figma-sync-result",
      ok: true,
      operation: "resolved-keep-pen",
      resolvedBridgeId: "pen:title",
      updatedNodeCount: 1,
      manifest: { revision: 3, mappingCount: 2 },
    });
    expect(executeWriteCount).toBe(2);

    adoptedRoot.children![0]!.content = "Pencil-only update";
    const preparePencilUpdate = await fetch(
      `${origin}/figma/sync/apply?token=${token}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          document: resolvedFigmaDocument,
          assetData: {},
        }),
      },
    );
    expect(preparePencilUpdate.status).toBe(200);
    const preparedUpdate = await preparePencilUpdate.json();
    expect(preparedUpdate).toMatchObject({
      type: "figma-sync-resolution-prepared",
      ok: true,
      operation: "updated-figma",
      direction: "pen",
      resolutionId: expect.any(String),
      bridgeIds: ["pen:title"],
      document: {
        root: {
          children: [{ text: { characters: "Pencil-only update" } }],
        },
      },
    });
    expect(executeWriteCount).toBe(2);

    const updatedFigmaDocument = figmaExportDocument();
    updatedFigmaDocument.root.children[0]!.text!.characters =
      "Pencil-only update";
    const completePencilUpdate = await fetch(
      `${origin}/figma/sync/resolve/complete?token=${token}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resolutionId: preparedUpdate.resolutionId,
          document: updatedFigmaDocument,
        }),
      },
    );
    expect(completePencilUpdate.status).toBe(200);
    expect(await completePencilUpdate.json()).toMatchObject({
      type: "figma-sync-result",
      ok: true,
      operation: "updated-figma",
      updatedNodeCount: 1,
      updatedBridgeIds: ["pen:title"],
      manifest: { revision: 4, mappingCount: 2 },
    });
    expect(executeWriteCount).toBe(2);
  });

  it("rejects requests before authentication", async () => {
    const pen = {} as PenMcpClient;
    const server = new BridgeServer({ host: "127.0.0.1", port: 0, pen });
    servers.push(server);
    const port = await server.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    await onceOpen(socket);
    socket.send(JSON.stringify({ type: "list-pen-screens", requestId: "1" }));
    expect(await onceMessage(socket)).toMatchObject({
      type: "failed",
      code: "AUTH_REQUIRED",
    });
    socket.close();
  });
});

function onceOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => socket.once("open", () => resolve()));
}

function onceMessage(socket: WebSocket): Promise<Record<string, any>> {
  return new Promise((resolve) =>
    socket.once("message", (data) => resolve(JSON.parse(data.toString()))),
  );
}

function figmaExportDocument(): BridgeDocument {
  const document = importPenDocument(
    {
      id: "root",
      type: "frame",
      name: "Screen",
      width: 393,
      height: 844,
      children: [{ id: "title", type: "text", content: "Hello", fontSize: 20 }],
    },
    { documentId: "/tmp/test.pen" },
  );
  document.source = { app: "figma", documentId: "figma-file" };
  const visit = (node: BridgeDocument["root"]) => {
    node.source = {
      app: "figma",
      documentId: "figma-file",
      nodeId: node.bridgeId === "pen:root" ? "figma-root" : "figma-title",
    };
    for (const child of node.children) visit(child);
  };
  visit(document.root);
  return document;
}
