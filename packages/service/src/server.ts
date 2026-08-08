import { createServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import type { BridgeDocument, BridgeManifest } from "@pen-fig/bridge-schema";
import {
  clientMessageSchema,
  type ClientMessage,
  type ServerMessage,
} from "./protocol.js";
import { SessionManager } from "./session.js";
import type { PenMcpClient } from "./pen/mcp-client.js";
import { authoredDocumentHashes, importPenDocument } from "@pen-fig/core";
import { resolveAssets } from "./assets/resolve.js";
import { ManifestRepository } from "./manifest/repository.js";

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
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
