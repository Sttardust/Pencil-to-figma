import { createServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import {
  bridgeDocumentSchema,
  type BridgeDocument,
  type BridgeManifest,
} from "@pen-fig/bridge-schema";
import {
  clientMessageSchema,
  type ClientMessage,
  type ServerMessage,
} from "./protocol.js";
import { SessionManager } from "./session.js";
import type { PenMcpClient } from "./pen/mcp-client.js";
import {
  authoredDocumentHashes,
  classifyThreeWayDiff,
  importPenDocument,
  snapshotBridgeDocument,
} from "@pen-fig/core";
import { resolveAssets } from "./assets/resolve.js";
import { ManifestRepository } from "./manifest/repository.js";
import { writeFigmaCopyToPen } from "./export/pen-writer.js";
import { writeFigmaUpdatesToPen } from "./export/pen-updater.js";
import {
  buildFigmaExportManifest,
  collectPenBridgeMappings,
  type PenBridgeMapping,
} from "./manifest/figma-export.js";

export interface BridgeServerOptions {
  host: string;
  port: number;
  pen: PenMcpClient;
  sessions?: SessionManager;
}

export class BridgeServer {
  readonly #http: HttpServer;
  readonly #ws: WebSocketServer;
  readonly #pen: PenMcpClient;
  readonly #sessions: SessionManager;
  readonly #host: string;
  readonly #port: number;
  readonly #manifests = new ManifestRepository();
  readonly #transfers = new Map<
    string,
    { document: BridgeDocument; penPath: string; createdAt: number }
  >();
  #activePenPath: string | undefined;

  constructor(options: BridgeServerOptions) {
    this.#host = options.host;
    this.#port = options.port;
    this.#pen = options.pen;
    this.#sessions = options.sessions ?? new SessionManager();
    this.#http = createServer((request, response) => {
      void this.#handleHttp(request, response);
    });
    this.#ws = new WebSocketServer({
      server: this.#http,
      maxPayload: 1024 * 1024,
    });
    this.#ws.on("connection", (socket) => this.#onConnection(socket));
  }

  get pairingCode(): string {
    return this.#sessions.pairingCode;
  }

  async start(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.#http.once("error", reject);
      this.#http.listen(this.#port, this.#host, () => resolve());
    });
    const address = this.#http.address();
    if (!address || typeof address === "string")
      throw new Error("Bridge address unavailable");
    return address.port;
  }

  async close(): Promise<void> {
    for (const client of this.#ws.clients)
      client.close(1001, "Service stopping");
    await new Promise<void>((resolve, reject) =>
      this.#ws.close((error) => (error ? reject(error) : resolve())),
    );
    await new Promise<void>((resolve, reject) =>
      this.#http.close((error) => (error ? reject(error) : resolve())),
    );
  }

  #onConnection(socket: WebSocket): void {
    let authenticated = false;
    socket.on("message", async (data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        send(socket, {
          type: "failed",
          code: "SCHEMA_JSON",
          message: "Invalid JSON",
        });
        return;
      }

      const parsed = clientMessageSchema.safeParse(raw);
      if (!parsed.success) {
        send(socket, {
          type: "failed",
          code: "SCHEMA_MESSAGE",
          message: parsed.error.message,
        });
        return;
      }

      const message = parsed.data;
      if (message.type === "pair") {
        const token = this.#sessions.pair(message.code.toUpperCase());
        if (!token) {
          send(socket, {
            type: "failed",
            code: "AUTH_PAIRING",
            message: "Invalid or expired pairing code",
          });
          return;
        }
        send(socket, { type: "paired", protocol: 1, token });
        return;
      }

      if (message.type === "hello") {
        authenticated = this.#sessions.authenticate(message.token);
        if (!authenticated) {
          send(socket, {
            type: "failed",
            code: "AUTH_TOKEN",
            message: "Invalid session token",
          });
          return;
        }
        try {
          const state = await this.#pen.getAppState();
          this.#activePenPath = extractActivePenPath(state.text);
          send(socket, {
            type: "ready",
            protocol: 1,
            penState: summarizeState(state.text),
          });
        } catch (error) {
          send(socket, {
            type: "failed",
            code: "CONNECTION_PEN",
            message: publicMessage(error),
          });
        }
        return;
      }

      if (!authenticated) {
        send(socket, {
          type: "failed",
          code: "AUTH_REQUIRED",
          message: "Pair and authenticate first",
        });
        return;
      }

      await this.#handleAuthenticated(socket, message);
    });
  }

  async #handleHttp(
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ): Promise<void> {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader(
      "access-control-allow-headers",
      "content-type, x-pen-fig-token",
    );
    response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    if (request.method === "GET" && request.url === "/health") {
      json(response, 200, { ok: true, protocol: 1 });
      return;
    }

    try {
      if (request.method === "POST" && request.url === "/pair") {
        const parsed = clientMessageSchema.safeParse(
          await readJsonBody(request),
        );
        if (!parsed.success || parsed.data.type !== "pair") {
          json(response, 400, {
            type: "failed",
            code: "SCHEMA_MESSAGE",
            message: "Expected a valid pair message",
          });
          return;
        }
        const token = this.#sessions.pair(parsed.data.code.toUpperCase());
        if (!token) {
          json(response, 401, {
            type: "failed",
            code: "AUTH_PAIRING",
            message: "Invalid or expired pairing code",
          });
          return;
        }
        json(response, 200, { type: "paired", protocol: 1, token });
        return;
      }

      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      const tokenHeader = request.headers["x-pen-fig-token"];
      const headerToken = Array.isArray(tokenHeader)
        ? (tokenHeader[0] ?? "")
        : (tokenHeader ?? "");
      const token = requestUrl.searchParams.get("token") ?? headerToken;
      if (!this.#sessions.authenticate(token)) {
        json(response, 401, {
          type: "failed",
          code: "AUTH_REQUIRED",
          message: "Pair and authenticate first",
        });
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/hello") {
        const state = await this.#pen.getAppState();
        this.#activePenPath = extractActivePenPath(state.text);
        json(response, 200, {
          type: "ready",
          protocol: 1,
          penState: summarizeState(state.text),
        });
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/pen/screens") {
        const text = await this.#pen.listRootFrames(200);
        json(response, 200, { type: "pen-screens", requestId: "http", text });
        return;
      }
      if (
        request.method === "GET" &&
        requestUrl.pathname === "/pen/screen-search"
      ) {
        const query = requestUrl.searchParams.get("query") ?? "";
        const text = await this.#pen.searchRootFrames(query);
        json(response, 200, { type: "pen-screens", requestId: "search", text });
        return;
      }
      const nodeMatch =
        request.method === "GET"
          ? /^\/pen\/nodes\/([A-Za-z0-9]+)$/.exec(requestUrl.pathname)
          : undefined;
      if (nodeMatch?.[1]) {
        const penPath = await this.#requireActivePenPath();
        const node = await this.#pen.getNode(nodeMatch[1]);
        const document = importPenDocument(node, { documentId: penPath });
        const resolved = await resolveAssets(document);
        const transferId = randomUUID();
        this.#pruneTransfers();
        this.#transfers.set(transferId, {
          document: resolved.document,
          penPath,
          createdAt: Date.now(),
        });
        json(response, 200, {
          type: "pen-document",
          transferId,
          ...resolved,
        });
        return;
      }
      if (
        request.method === "POST" &&
        requestUrl.pathname === "/sync/complete"
      ) {
        const completion = syncCompletionSchema.parse(
          await readJsonBody(request),
        );
        const transfer = this.#transfers.get(completion.transferId);
        if (!transfer)
          throw new Error("Transfer expired; read the Pen screen again");
        const expectedHashes = authoredDocumentHashes(transfer.document);
        const returned = new Map(
          completion.mappings.map((mapping) => [mapping.bridgeId, mapping]),
        );
        if (
          returned.size !== completion.mappings.length ||
          returned.size !== Object.keys(expectedHashes).length
        )
          throw new Error("Figma mapping count does not match the transfer");
        const mappings: BridgeManifest["mappings"] = [];
        visitBridgeNodes(transfer.document.root, (node) => {
          const mapping = returned.get(node.bridgeId);
          if (!mapping)
            throw new Error(`Figma mapping missing ${node.bridgeId}`);
          mappings.push({
            bridgeId: node.bridgeId,
            penNodeId: node.source.nodeId,
            figmaNodeId: mapping.figmaNodeId,
            baselineHash: expectedHashes[node.bridgeId]!,
          });
        });
        const manifestPath = sidecarPath(transfer.penPath);
        const previous = await this.#manifests.read(manifestPath);
        await this.#manifests.writeAtomic(manifestPath, {
          version: 1,
          penDocumentId: transfer.penPath,
          ...(completion.figmaDocumentId
            ? { figmaDocumentId: completion.figmaDocumentId }
            : {}),
          revision: (previous?.revision ?? -1) + 1,
          updatedAt: new Date().toISOString(),
          mappings,
        });
        this.#transfers.delete(completion.transferId);
        json(response, 200, {
          type: "sync-committed",
          revision: (previous?.revision ?? -1) + 1,
          mappingCount: mappings.length,
          manifestPath,
        });
        return;
      }
      if (
        request.method === "POST" &&
        requestUrl.pathname === "/figma/export"
      ) {
        const exportRequest = figmaExportRequestSchema.parse(
          await readJsonBody(request, 50 * 1024 * 1024),
        );
        const penPath = await this.#requireActivePenPath();
        const result = await writeFigmaCopyToPen(
          exportRequest.document,
          exportRequest.assetData,
          penPath,
          this.#pen,
        );
        const { mappings, ...summary } = result;
        const writtenRoot = await this.#pen.getNode(result.rootId);
        const penDocument = importPenDocument(writtenRoot, {
          documentId: penPath,
          useBridgeMetadata: true,
        });
        const manifest = await this.#commitFigmaExportManifest(
          exportRequest.document,
          mappings,
          penPath,
          penDocument,
        );
        json(response, 200, {
          type: "figma-export-result",
          ok: true,
          operation: "created-copy",
          ...summary,
          manifest,
        });
        return;
      }
      if (
        request.method === "POST" &&
        requestUrl.pathname === "/figma/export/adopt"
      ) {
        const adoptRequest = figmaAdoptRequestSchema.parse(
          await readJsonBody(request, 5 * 1024 * 1024),
        );
        const penPath = await this.#requireActivePenPath();
        const root = await this.#pen.getNode(adoptRequest.penRootId);
        if (root.metadata?.bridgeId !== adoptRequest.document.root.bridgeId)
          throw new Error(
            `Pencil root ${root.id} does not match ${adoptRequest.document.root.bridgeId}`,
          );
        const mappings = collectPenBridgeMappings(root);
        const penDocument = importPenDocument(root, {
          documentId: penPath,
          useBridgeMetadata: true,
        });
        const manifest = await this.#commitFigmaExportManifest(
          adoptRequest.document,
          mappings,
          penPath,
          penDocument,
        );
        json(response, 200, {
          type: "figma-export-adopted",
          ok: true,
          operation: "adopted-copy",
          rootId: root.id,
          nodeCount: mappings.length,
          manifest,
        });
        return;
      }
      if (
        request.method === "POST" &&
        requestUrl.pathname === "/figma/sync/preview"
      ) {
        const syncRequest = figmaSyncRequestSchema.parse(
          await readJsonBody(request, 5 * 1024 * 1024),
        );
        const penPath = await this.#requireActivePenPath();
        const manifestPath = sidecarPath(penPath);
        const manifest = await this.#manifests.read(manifestPath);
        if (!manifest) throw new Error("No sync manifest exists for this file");
        if (manifest.penDocumentId !== penPath)
          throw new Error("Sync manifest belongs to a different Pencil file");
        const rootMapping = manifest.mappings.find(
          (mapping) => mapping.bridgeId === syncRequest.document.root.bridgeId,
        );
        if (!rootMapping?.penNodeId || !rootMapping.figmaNodeId)
          throw new Error("The selected Figma root is not fully mapped");
        if (rootMapping.figmaNodeId !== syncRequest.document.root.source.nodeId)
          throw new Error(
            `Figma root mapping points to ${rootMapping.figmaNodeId}, not ${syncRequest.document.root.source.nodeId}`,
          );
        const penRoot = await this.#pen.getNode(rootMapping.penNodeId);
        const penDocument = importPenDocument(penRoot, {
          documentId: penPath,
          useBridgeMetadata: true,
        });
        if (penDocument.root.bridgeId !== syncRequest.document.root.bridgeId)
          throw new Error("Mapped Pencil root bridge identity does not match");
        const penSnapshots = snapshotBridgeDocument(penDocument);
        const figmaSnapshots = snapshotBridgeDocument(syncRequest.document);
        const relevantBridgeIds = new Set([
          ...penSnapshots.map((snapshot) => snapshot.bridgeId),
          ...figmaSnapshots.map((snapshot) => snapshot.bridgeId),
        ]);
        const baseline = manifest.mappings.filter((mapping) =>
          relevantBridgeIds.has(mapping.bridgeId),
        );
        const diff = classifyThreeWayDiff(
          baseline,
          penSnapshots,
          figmaSnapshots,
        );
        json(response, 200, {
          type: "figma-sync-preview",
          ok: true,
          manifestRevision: manifest.revision,
          root: {
            bridgeId: syncRequest.document.root.bridgeId,
            penNodeId: rootMapping.penNodeId,
            figmaNodeId: rootMapping.figmaNodeId,
          },
          counts: diff.counts,
          actions: countSyncDirections(diff.entries),
          conflictRoots: diff.conflictRoots.map((entry) => ({
            bridgeId: entry.bridgeId,
            reason: entry.reason,
          })),
          canApplyWithoutResolution: diff.canApplyWithoutResolution,
          baselineUpgradeRequired: baseline.some(
            (mapping) => !mapping.penBaselineHash || !mapping.figmaBaselineHash,
          ),
          changes: diff.entries
            .filter((entry) => entry.classification !== "unchanged")
            .slice(0, 200)
            .map((entry) => ({
              bridgeId: entry.bridgeId,
              classification: entry.classification,
              side: entry.side,
              reason: entry.reason,
            })),
        });
        return;
      }
      if (
        request.method === "POST" &&
        requestUrl.pathname === "/figma/sync/apply"
      ) {
        const syncRequest = figmaExportRequestSchema.parse(
          await readJsonBody(request, 50 * 1024 * 1024),
        );
        const penPath = await this.#requireActivePenPath();
        const manifestPath = sidecarPath(penPath);
        const manifest = await this.#manifests.read(manifestPath);
        if (!manifest) throw new Error("No sync manifest exists for this file");
        if (manifest.penDocumentId !== penPath)
          throw new Error("Sync manifest belongs to a different Pencil file");
        const rootMapping = manifest.mappings.find(
          (mapping) => mapping.bridgeId === syncRequest.document.root.bridgeId,
        );
        if (!rootMapping?.penNodeId || !rootMapping.figmaNodeId)
          throw new Error("The selected Figma root is not fully mapped");
        if (rootMapping.figmaNodeId !== syncRequest.document.root.source.nodeId)
          throw new Error("The selected Figma root does not own this mapping");
        const penRoot = await this.#pen.getNode(rootMapping.penNodeId);
        const penDocument = importPenDocument(penRoot, {
          documentId: penPath,
          useBridgeMetadata: true,
        });
        if (penDocument.root.bridgeId !== syncRequest.document.root.bridgeId)
          throw new Error("Mapped Pencil root bridge identity does not match");
        const penSnapshots = snapshotBridgeDocument(penDocument);
        const figmaSnapshots = snapshotBridgeDocument(syncRequest.document);
        const relevantBridgeIds = new Set([
          ...penSnapshots.map((snapshot) => snapshot.bridgeId),
          ...figmaSnapshots.map((snapshot) => snapshot.bridgeId),
        ]);
        const baseline = manifest.mappings.filter((mapping) =>
          relevantBridgeIds.has(mapping.bridgeId),
        );
        if (
          baseline.some(
            (mapping) => !mapping.penBaselineHash || !mapping.figmaBaselineHash,
          )
        )
          throw new Error(
            "Adopt this Pencil root again to upgrade its baseline",
          );
        const diff = classifyThreeWayDiff(
          baseline,
          penSnapshots,
          figmaSnapshots,
        );
        const actions = countSyncDirections(diff.entries);
        if (actions.conflicts || actions.unmapped)
          throw new Error(
            "Sync has conflicts or unmapped nodes; no writes applied",
          );
        if (actions.toFigma)
          throw new Error(
            "Pencil also has changes; apply or resolve those before writing Pencil",
          );
        const unsupportedStructural = diff.entries.filter(
          (entry) =>
            entry.classification === "added" ||
            entry.classification === "deleted",
        );
        if (unsupportedStructural.length)
          throw new Error(
            `Structural sync is not enabled yet: ${unsupportedStructural[0]!.bridgeId}`,
          );
        const changedBridgeIds = diff.entries
          .filter((entry) => entry.classification === "figma-only")
          .map((entry) => entry.bridgeId);
        if (actions.toPencil !== changedBridgeIds.length)
          throw new Error("Sync contains unsupported Pencil operations");
        if (!changedBridgeIds.length) {
          json(response, 200, {
            type: "figma-sync-result",
            ok: true,
            operation: "unchanged",
            updatedNodeCount: 0,
            manifestRevision: manifest.revision,
          });
          return;
        }
        const penMappings: PenBridgeMapping[] = baseline.map((mapping) => {
          if (!mapping.penNodeId)
            throw new Error(`Pencil mapping missing ${mapping.bridgeId}`);
          return {
            bridgeId: mapping.bridgeId,
            penNodeId: mapping.penNodeId,
          };
        });
        const update = await writeFigmaUpdatesToPen(
          syncRequest.document,
          changedBridgeIds,
          penMappings,
          penRoot,
          syncRequest.assetData,
          penPath,
          this.#pen,
        );
        const verifiedRoot = await this.#pen.getNode(rootMapping.penNodeId);
        const verifiedMappings = collectPenBridgeMappings(verifiedRoot);
        if (verifiedMappings.length !== figmaSnapshots.length)
          throw new Error("Pencil verification found a mapping count mismatch");
        const verifiedPenDocument = importPenDocument(verifiedRoot, {
          documentId: penPath,
          useBridgeMetadata: true,
        });
        const committed = await this.#commitFigmaExportManifest(
          syncRequest.document,
          verifiedMappings,
          penPath,
          verifiedPenDocument,
        );
        json(response, 200, {
          type: "figma-sync-result",
          ok: true,
          operation: "updated-pen",
          updatedNodeCount: update.updatedNodeCount,
          updatedBridgeIds: update.updatedBridgeIds,
          manifest: committed,
        });
        return;
      }
      json(response, 404, {
        type: "failed",
        code: "NOT_FOUND",
        message: "Not found",
      });
    } catch (error) {
      const message = publicMessage(error);
      json(response, message === "Request body too large" ? 413 : 500, {
        type: "failed",
        code: "CONNECTION_PEN",
        message,
      });
    }
  }

  async #requireActivePenPath(): Promise<string> {
    if (this.#activePenPath) return this.#activePenPath;
    const state = await this.#pen.getAppState();
    const penPath = extractActivePenPath(state.text);
    if (!penPath)
      throw new Error("Pencil did not report an active .pen document");
    this.#activePenPath = penPath;
    return penPath;
  }

  async #commitFigmaExportManifest(
    document: BridgeDocument,
    mappings: PenBridgeMapping[],
    penPath: string,
    penDocument: BridgeDocument,
  ): Promise<{
    revision: number;
    mappingCount: number;
    manifestPath: string;
  }> {
    const manifestPath = sidecarPath(penPath);
    const previous = await this.#manifests.read(manifestPath);
    const manifest = buildFigmaExportManifest(document, mappings, penPath, {
      previous,
      penDocument,
    });
    await this.#manifests.writeAtomic(manifestPath, manifest);
    return {
      revision: manifest.revision,
      mappingCount: manifest.mappings.length,
      manifestPath,
    };
  }

  #pruneTransfers(): void {
    const cutoff = Date.now() - 15 * 60_000;
    for (const [id, transfer] of this.#transfers)
      if (transfer.createdAt < cutoff) this.#transfers.delete(id);
  }

  async #handleAuthenticated(
    socket: WebSocket,
    message: ClientMessage,
  ): Promise<void> {
    try {
      if (message.type === "pen-state") {
        const state = await this.#pen.getAppState();
        send(socket, {
          type: "pen-state",
          requestId: message.requestId,
          text: state.text,
        });
      } else if (message.type === "list-pen-screens") {
        const text = await this.#pen.listRootFrames();
        send(socket, {
          type: "pen-screens",
          requestId: message.requestId,
          text,
        });
      }
    } catch (error) {
      const failure: ServerMessage = {
        type: "failed",
        code: "CONNECTION_PEN",
        message: publicMessage(error),
        ...(message.type === "pen-state" || message.type === "list-pen-screens"
          ? { requestId: message.requestId }
          : {}),
      };
      send(socket, failure);
    }
  }
}

const syncCompletionSchema = z
  .object({
    transferId: z.string().uuid(),
    figmaDocumentId: z.string().min(1).max(500).optional(),
    mappings: z
      .array(
        z
          .object({
            bridgeId: z.string().min(1).max(200),
            figmaNodeId: z.string().min(1).max(200),
          })
          .strict(),
      )
      .min(1)
      .max(5000),
  })
  .strict();

const figmaExportRequestSchema = z
  .object({
    document: bridgeDocumentSchema,
    assetData: z.record(
      z.string().min(1).max(500),
      z
        .object({
          base64: z.string().max(14 * 1024 * 1024),
          mimeType: z.enum([
            "image/png",
            "image/jpeg",
            "image/gif",
            "image/webp",
          ]),
          byteLength: z
            .number()
            .int()
            .nonnegative()
            .max(10 * 1024 * 1024),
        })
        .strict(),
    ),
  })
  .strict();

const figmaAdoptRequestSchema = z
  .object({
    document: bridgeDocumentSchema,
    penRootId: z.string().regex(/^[A-Za-z0-9]+$/),
  })
  .strict();

const figmaSyncRequestSchema = z
  .object({ document: bridgeDocumentSchema })
  .strict();

function countSyncDirections(
  entries: ReturnType<typeof classifyThreeWayDiff>["entries"],
): { toPencil: number; toFigma: number; conflicts: number; unmapped: number } {
  const counts = { toPencil: 0, toFigma: 0, conflicts: 0, unmapped: 0 };
  for (const entry of entries) {
    if (entry.classification === "figma-only") counts.toPencil += 1;
    else if (entry.classification === "pen-only") counts.toFigma += 1;
    else if (entry.classification === "conflicted") counts.conflicts += 1;
    else if (entry.classification === "unmapped") counts.unmapped += 1;
    else if (entry.classification === "added") {
      if (entry.side === "figma") counts.toPencil += 1;
      else if (entry.side === "pen") counts.toFigma += 1;
    } else if (entry.classification === "deleted") {
      if (entry.side === "figma") counts.toPencil += 1;
      else if (entry.side === "pen") counts.toFigma += 1;
    }
  }
  return counts;
}

function extractActivePenPath(text: string): string | undefined {
  return /Currently active canvas editor:\s*`([^`]+\.pen)`/.exec(text)?.[1];
}

function sidecarPath(penPath: string): string {
  const extension = path.extname(penPath);
  return `${penPath.slice(0, -extension.length)}.pen-fig.json`;
}

function visitBridgeNodes(
  node: BridgeDocument["root"],
  callback: (node: BridgeDocument["root"]) => void,
): void {
  callback(node);
  for (const child of node.children) visitBridgeNodes(child, callback);
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify(message));
}

function publicMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown service error";
}

function summarizeState(text: string): string {
  return (
    text
      .split("\n")
      .find((line) => line.includes("Currently active canvas editor")) ??
    text.slice(0, 300)
  );
}

function json(
  response: import("node:http").ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function readJsonBody(
  request: import("node:http").IncomingMessage,
  maxBytes = 64 * 1024,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
