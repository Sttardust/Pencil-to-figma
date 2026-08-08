import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BridgeServer } from "../src/server.js";
import type { PenMcpClient } from "../src/pen/mcp-client.js";
import { importPenDocument } from "@pen-fig/core";
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
    const pen = {
      getAppState: async () => ({
        text: `- Currently active canvas editor: \`${penPath}\``,
      }),
      getNode: async () => ({
        id: "adoptedRoot",
        type: "frame",
        metadata: { type: "pen-fig-export", bridgeId: "pen:root" },
        children: [
          {
            id: "adoptedTitle",
            type: "text",
            metadata: { type: "pen-fig-bridge", bridgeId: "pen:title" },
          },
        ],
      }),
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
        { bridgeId: "pen:root", penNodeId: "adoptedRoot" },
        { bridgeId: "pen:title", penNodeId: "adoptedTitle" },
      ],
    });
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
