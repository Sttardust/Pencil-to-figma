import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
        figmaBaselineHashes: { "pen:abc": "a".repeat(64) },
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
      mappings: [
        {
          bridgeId: "pen:abc",
          figmaNodeId: "1:2",
          penBaselineHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          figmaBaselineHash: "a".repeat(64),
        },
      ],
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

  it("bundles reusable Pencil components by ref identity", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "pen-fig-components-"),
    );
    temporaryDirectories.push(directory);
    const penPath = path.join(directory, "components.pen");
    await writeFile(
      penPath,
      JSON.stringify({
        version: "2.15",
        children: [],
        variables: {
          teal: { type: "color", value: "#2E4A44" },
          "font-body": { type: "string", value: "Inter" },
        },
      }),
      "utf8",
    );
    const requested: string[] = [];
    const pen = {
      getAppState: async () => ({
        text: `- Currently active canvas editor: \`${penPath}\``,
      }),
      getNode: async (nodeId: string): Promise<PenNode> => {
        requested.push(nodeId);
        if (nodeId === "screen")
          return {
            id: "screen",
            type: "frame",
            name: "Screen",
            children: [
              {
                id: "buttonInstance",
                type: "ref",
                name: "Button instance",
                ref: "buttonComponent",
              },
            ],
          };
        if (nodeId === "buttonComponent")
          return {
            id: "buttonComponent",
            type: "frame",
            name: "Button component",
            reusable: true,
            fill: "$teal",
            children: [
              {
                id: "buttonLabel",
                type: "text",
                content: "Continue",
                fontFamily: "$font-body",
              },
            ],
          };
        throw new Error(`Unexpected node ${nodeId}`);
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

    const response = await fetch(`${origin}/pen/nodes/screen?token=${token}`);
    expect(response.status).toBe(200);
    const transferred = await response.json();
    expect(transferred).toMatchObject({
      type: "pen-document",
      document: {
        root: {
          bridgeId: "pen:screen",
          children: [
            {
              kind: "instance",
              instance: { componentBridgeId: "pen:buttonComponent" },
            },
          ],
        },
        components: [
          {
            bridgeId: "pen:buttonComponent",
            kind: "component",
            fills: [
              {
                type: "solid",
                color: expect.objectContaining({ r: 46 / 255, g: 74 / 255 }),
              },
            ],
            children: [{ bridgeId: "pen:buttonLabel", kind: "text" }],
          },
        ],
        variables: expect.arrayContaining([
          expect.objectContaining({ id: "pen-var:teal", type: "color" }),
          expect.objectContaining({
            id: "pen-var:font-body",
            type: "string",
          }),
        ]),
      },
    });
    expect(requested).toEqual(["screen", "buttonComponent"]);
    const completed = await fetch(`${origin}/sync/complete?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        transferId: transferred.transferId,
        mappings: [
          { bridgeId: "pen:screen", figmaNodeId: "1:1" },
          { bridgeId: "pen:buttonInstance", figmaNodeId: "1:2" },
        ],
      }),
    });
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({
      type: "sync-committed",
      mappingCount: 2,
    });
  });

  it("adopts an existing Pencil copy and commits its Figma baseline", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pen-fig-adopt-"));
    temporaryDirectories.push(directory);
    const penPath = path.join(directory, "test.pen");
    await writeFile(
      penPath,
      JSON.stringify({
        version: "2.15",
        children: [],
        variables: { bg: { type: "color", value: "#F8F5EF" } },
      }),
      "utf8",
    );
    const adoptedRoot: PenNode = {
      id: "adoptedRoot",
      type: "frame",
      fill: "$bg",
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
        if (content && input.includes('Update("adoptedTitle"'))
          adoptedRoot.children![0]!.content = content;
        if (input.includes('"bridgeId":"figma:added"'))
          adoptedRoot.children!.push({
            id: "adoptedFigmaAdded",
            type: "text",
            name: "Added in Figma",
            content: "Added in Figma",
            metadata: { type: "pen-fig-bridge", bridgeId: "figma:added" },
          });
        return [
          "OK\n\n## Print output",
          "UPDATED | pen:title | adoptedTitle",
          ...(input.includes('"bridgeId":"figma:added"')
            ? ["MAP | figma:added | adoptedFigmaAdded"]
            : []),
          ...(input.includes("STRUCTURE_UPDATED")
            ? ["STRUCTURE_UPDATED | pen:root"]
            : []),
        ].join("\n");
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

    adoptedRoot.children!.push({
      id: "adoptedSubtitle",
      type: "text",
      content: "Added in Pencil",
      metadata: { type: "pen-fig-bridge", bridgeId: "pen:subtitle" },
    });
    const structuralPreview = await fetch(
      `${origin}/figma/sync/preview?token=${token}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document: updatedFigmaDocument }),
      },
    );
    expect(await structuralPreview.json()).toMatchObject({
      counts: { "pen-only": 1, added: 1 },
      actions: { toPencil: 0, toFigma: 2 },
      structural: true,
      canApplyWithoutResolution: true,
    });

    const prepareStructuralUpdate = await fetch(
      `${origin}/figma/sync/apply?token=${token}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          document: updatedFigmaDocument,
          assetData: {},
        }),
      },
    );
    expect(prepareStructuralUpdate.status).toBe(200);
    const preparedStructural = await prepareStructuralUpdate.json();
    expect(preparedStructural).toMatchObject({
      type: "figma-sync-resolution-prepared",
      operation: "updated-figma",
      direction: "pen",
      structural: true,
      bridgeIds: ["pen:root", "pen:subtitle"],
    });

    const structurallyUpdatedFigmaDocument =
      structuredClone(updatedFigmaDocument);
    const preparedSubtitle = (
      preparedStructural.document as BridgeDocument
    ).root.children.find((node) => node.bridgeId === "pen:subtitle")!;
    structurallyUpdatedFigmaDocument.root.children.push({
      ...structuredClone(preparedSubtitle),
      source: {
        app: "figma",
        documentId: "figma-file",
        nodeId: "figma-subtitle",
      },
    });
    const completeStructuralUpdate = await fetch(
      `${origin}/figma/sync/resolve/complete?token=${token}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resolutionId: preparedStructural.resolutionId,
          document: structurallyUpdatedFigmaDocument,
        }),
      },
    );
    const completedStructural = await completeStructuralUpdate.json();
    expect(completedStructural).toMatchObject({
      type: "figma-sync-result",
      ok: true,
      operation: "updated-figma",
      updatedNodeCount: 2,
      updatedBridgeIds: ["pen:root", "pen:subtitle"],
      manifest: { revision: 5, mappingCount: 3 },
    });
    expect(completeStructuralUpdate.status).toBe(200);

    adoptedRoot.children!.reverse();
    const prepareReorder = await fetch(
      `${origin}/figma/sync/apply?token=${token}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          document: structurallyUpdatedFigmaDocument,
          assetData: {},
        }),
      },
    ).then((response) => response.json());
    expect(prepareReorder).toMatchObject({
      type: "figma-sync-resolution-prepared",
      structural: true,
      bridgeIds: ["pen:root"],
    });
    const reorderedFigmaDocument = structuredClone(
      structurallyUpdatedFigmaDocument,
    );
    reorderedFigmaDocument.root.children.reverse();
    const completeReorder = await fetch(
      `${origin}/figma/sync/resolve/complete?token=${token}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resolutionId: prepareReorder.resolutionId,
          document: reorderedFigmaDocument,
        }),
      },
    );
    expect(completeReorder.status).toBe(200);
    expect(await completeReorder.json()).toMatchObject({
      operation: "updated-figma",
      updatedBridgeIds: ["pen:root"],
      manifest: { revision: 6, mappingCount: 3 },
    });

    adoptedRoot.children!.shift();
    const prepareDeletion = await fetch(
      `${origin}/figma/sync/apply?token=${token}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          document: reorderedFigmaDocument,
          assetData: {},
        }),
      },
    ).then((response) => response.json());
    expect(prepareDeletion).toMatchObject({
      type: "figma-sync-resolution-prepared",
      structural: true,
      bridgeIds: ["pen:root", "pen:subtitle"],
    });
    const deletedFigmaDocument = structuredClone(reorderedFigmaDocument);
    deletedFigmaDocument.root.children.shift();
    const completeDeletion = await fetch(
      `${origin}/figma/sync/resolve/complete?token=${token}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resolutionId: prepareDeletion.resolutionId,
          document: deletedFigmaDocument,
        }),
      },
    );
    expect(completeDeletion.status).toBe(200);
    expect(await completeDeletion.json()).toMatchObject({
      operation: "updated-figma",
      updatedBridgeIds: ["pen:root", "pen:subtitle"],
      manifest: { revision: 7, mappingCount: 2 },
    });
    expect(executeWriteCount).toBe(2);

    const figmaAddedDocument = structuredClone(deletedFigmaDocument);
    figmaAddedDocument.root.children.push({
      ...structuredClone(figmaAddedDocument.root.children[0]!),
      bridgeId: "figma:added",
      name: "Added in Figma",
      text: {
        ...structuredClone(figmaAddedDocument.root.children[0]!.text!),
        characters: "Added in Figma",
      },
      source: {
        app: "figma",
        documentId: "figma-file",
        nodeId: "figma-added",
      },
    });
    const figmaStructuralPreview = await fetch(
      `${origin}/figma/sync/preview?token=${token}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document: figmaAddedDocument }),
      },
    );
    expect(await figmaStructuralPreview.json()).toMatchObject({
      counts: { "figma-only": 1, added: 1 },
      actions: { toPencil: 2, toFigma: 0 },
      structural: true,
      canApplyWithoutResolution: true,
    });
    const applyFigmaStructure = await fetch(
      `${origin}/figma/sync/apply?token=${token}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          document: figmaAddedDocument,
          assetData: {},
        }),
      },
    );
    expect(applyFigmaStructure.status).toBe(200);
    expect(await applyFigmaStructure.json()).toMatchObject({
      type: "figma-sync-result",
      operation: "updated-pen",
      updatedBridgeIds: ["pen:root", "figma:added"],
      updatedNodeCount: 2,
      manifest: { revision: 8, mappingCount: 3 },
    });
    expect(adoptedRoot.children).toHaveLength(2);
    expect(executeWriteCount).toBe(3);
  });

  it("resolves reorder conflicts by keeping either editor", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "pen-fig-reorder-conflict-"),
    );
    temporaryDirectories.push(directory);
    const penPath = path.join(directory, "test.pen");
    await writeFile(
      penPath,
      JSON.stringify({ version: "2.15", children: [] }),
      "utf8",
    );
    const nodes: Record<string, PenNode> = {
      a: {
        id: "nativeA",
        type: "text",
        content: "A",
        metadata: { type: "pen-fig-bridge", bridgeId: "pen:a" },
      },
      b: {
        id: "nativeB",
        type: "text",
        content: "B",
        metadata: { type: "pen-fig-bridge", bridgeId: "pen:b" },
      },
      c: {
        id: "nativeC",
        type: "text",
        content: "C",
        metadata: { type: "pen-fig-bridge", bridgeId: "pen:c" },
      },
    };
    const penRoot: PenNode = {
      id: "nativeRoot",
      type: "frame",
      name: "Reorder conflict",
      metadata: { type: "pen-fig-export", bridgeId: "pen:root" },
      children: [nodes.a!, nodes.b!, nodes.c!],
    };
    const pen = {
      getAppState: async () => ({
        text: `- Currently active canvas editor: \`${penPath}\``,
      }),
      getNode: async () => structuredClone(penRoot),
      executeWrite: async (input: string) => {
        for (const match of input.matchAll(/Delete\("([^"]+)"\)/g)) {
          const index = penRoot.children!.findIndex(
            (child) => child.id === match[1],
          );
          if (index >= 0) penRoot.children!.splice(index, 1);
        }
        const createdA = input.includes('"bridgeId":"pen:a"');
        if (createdA) {
          nodes.a = {
            id: "nativeA2",
            type: "text",
            content: "A edited in Figma",
            metadata: { type: "pen-fig-bridge", bridgeId: "pen:a" },
          };
          penRoot.children!.push(nodes.a);
        }
        const moves = input.matchAll(
          /Move\((?:"([^"]+)"|(added_\d+)),"nativeRoot",(\d+)\)/g,
        );
        for (const match of moves) {
          const nativeId =
            match[1] ??
            (match[2]?.startsWith("added_") ? "nativeA2" : undefined);
          const oldIndex = penRoot.children!.findIndex(
            (child) => child.id === nativeId,
          );
          const [node] = penRoot.children!.splice(oldIndex, 1);
          penRoot.children!.splice(Number(match[3]), 0, node!);
        }
        return [
          "OK\n\n## Print output",
          ...(createdA ? ["MAP | pen:a | nativeA2"] : []),
          "STRUCTURE_UPDATED | pen:root",
        ].join("\n");
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

    const baseline = figmaReorderDocument(["a", "b", "c"]);
    const adopt = await fetch(`${origin}/figma/export/adopt?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ document: baseline, penRootId: "nativeRoot" }),
    });
    expect(adopt.status).toBe(200);

    penRoot.children = [nodes.b!, nodes.a!, nodes.c!];
    const figmaWins = figmaReorderDocument(["a", "c", "b"]);
    const preview = await fetch(`${origin}/figma/sync/preview?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ document: figmaWins }),
    }).then((response) => response.json());
    expect(preview).toMatchObject({
      counts: { conflicted: 1 },
      structural: true,
      conflictRoots: [{ bridgeId: "pen:root" }],
    });
    const keepFigma = await fetch(
      `${origin}/figma/sync/resolve?token=${token}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          document: figmaWins,
          assetData: {},
          direction: "figma",
          bridgeId: "pen:root",
        }),
      },
    );
    expect(keepFigma.status).toBe(200);
    expect(await keepFigma.json()).toMatchObject({
      operation: "resolved-keep-figma",
      resolvedBridgeId: "pen:root",
      manifest: { revision: 1, mappingCount: 4 },
    });
    expect(penRoot.children!.map((node) => node.content)).toEqual([
      "A",
      "C",
      "B",
    ]);

    penRoot.children = [nodes.c!, nodes.a!, nodes.b!];
    const changedFigma = figmaReorderDocument(["b", "a", "c"]);
    const prepareKeepPen = await fetch(
      `${origin}/figma/sync/resolve?token=${token}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          document: changedFigma,
          assetData: {},
          direction: "pen",
          bridgeId: "pen:root",
        }),
      },
    );
    expect(prepareKeepPen.status).toBe(200);
    const prepared = await prepareKeepPen.json();
    expect(prepared).toMatchObject({
      type: "figma-sync-resolution-prepared",
      structural: true,
      direction: "pen",
    });
    const completed = await fetch(
      `${origin}/figma/sync/resolve/complete?token=${token}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resolutionId: prepared.resolutionId,
          document: figmaReorderDocument(["c", "a", "b"]),
        }),
      },
    );
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({
      operation: "resolved-keep-pen",
      resolvedBridgeId: "pen:root",
      manifest: { revision: 2, mappingCount: 4 },
    });

    nodes.b!.content = "B edited in Pencil";
    const figmaDeletesB = figmaReorderDocument(["c", "a"]);
    const deleteConflictPreview = await fetch(
      `${origin}/figma/sync/preview?token=${token}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document: figmaDeletesB }),
      },
    ).then((response) => response.json());
    expect(deleteConflictPreview).toMatchObject({
      counts: { conflicted: 1 },
      structural: true,
      conflictRoots: [{ bridgeId: "pen:b", reason: "delete-vs-edit" }],
    });
    const prepareRestoreB = await fetch(
      `${origin}/figma/sync/resolve?token=${token}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          document: figmaDeletesB,
          assetData: {},
          direction: "pen",
          bridgeId: "pen:b",
        }),
      },
    );
    expect(prepareRestoreB.status).toBe(200);
    const restorePrepared = await prepareRestoreB.json();
    expect(restorePrepared).toMatchObject({
      type: "figma-sync-resolution-prepared",
      structural: true,
      direction: "pen",
    });
    const restoredB = figmaReorderDocument(["c", "a", "b"]);
    restoredB.root.children.find(
      (node) => node.bridgeId === "pen:b",
    )!.text!.characters = "B edited in Pencil";
    const restoreCompleted = await fetch(
      `${origin}/figma/sync/resolve/complete?token=${token}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resolutionId: restorePrepared.resolutionId,
          document: restoredB,
        }),
      },
    );
    expect(restoreCompleted.status).toBe(200);
    expect(await restoreCompleted.json()).toMatchObject({
      operation: "resolved-keep-pen",
      resolvedBridgeId: "pen:b",
      manifest: { revision: 3, mappingCount: 4 },
    });

    penRoot.children = [nodes.c!, nodes.b!];
    const figmaEditsA = structuredClone(restoredB);
    figmaEditsA.root.children.find(
      (node) => node.bridgeId === "pen:a",
    )!.text!.characters = "A edited in Figma";
    const recreatePreview = await fetch(
      `${origin}/figma/sync/preview?token=${token}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document: figmaEditsA }),
      },
    ).then((response) => response.json());
    expect(recreatePreview).toMatchObject({
      counts: { conflicted: 1 },
      structural: true,
      conflictRoots: [{ bridgeId: "pen:a", reason: "delete-vs-edit" }],
    });
    const recreateA = await fetch(
      `${origin}/figma/sync/resolve?token=${token}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          document: figmaEditsA,
          assetData: {},
          direction: "figma",
          bridgeId: "pen:a",
        }),
      },
    );
    expect(recreateA.status).toBe(200);
    expect(await recreateA.json()).toMatchObject({
      operation: "resolved-keep-figma",
      resolvedBridgeId: "pen:a",
      manifest: { revision: 4, mappingCount: 4 },
    });
    expect(penRoot.children!.map((node) => node.content)).toEqual([
      "C",
      "A edited in Figma",
      "B edited in Pencil",
    ]);
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
      fill: "#F8F5EF",
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

function figmaReorderDocument(order: string[]): BridgeDocument {
  const document = importPenDocument(
    {
      id: "root",
      type: "frame",
      name: "Reorder conflict",
      children: order.map((id) => ({
        id,
        type: "text",
        content: id.toUpperCase(),
      })),
    },
    { documentId: "/tmp/test.pen" },
  );
  document.source = { app: "figma", documentId: "figma-file" };
  const visit = (node: BridgeDocument["root"]) => {
    node.source = {
      app: "figma",
      documentId: "figma-file",
      nodeId: `figma-${node.bridgeId.slice(4)}`,
    };
    for (const child of node.children) visit(child);
  };
  visit(document.root);
  return document;
}
