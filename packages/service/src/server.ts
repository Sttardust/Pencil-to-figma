import { createServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import {
  BRIDGE_PROTOCOL_VERSION,
  COMPANION_CAPABILITIES,
  COMPANION_VERSION,
  bridgeDocumentSchema,
  type BridgeDocument,
  type BridgeManifest,
} from "@pen-fig/bridge-schema";
import {
  authorizationRequestSchema,
  clientMessageSchema,
  type ClientMessage,
  type ServerMessage,
} from "./protocol.js";
import {
  MacOSApprovalProvider,
  type LocalApprovalProvider,
} from "./approval.js";
import { SessionManager } from "./session.js";
import type { PenMcpClient } from "./pen/mcp-client.js";
import { readPenVariables } from "./pen/variables.js";
import {
  authoredDocumentHashes,
  classifyThreeWayDiff,
  importPenDocument,
  snapshotBridgeDocument,
  type PenNode,
} from "@pen-fig/core";
import { resolveAssets } from "./assets/resolve.js";
import { ManifestRepository } from "./manifest/repository.js";
import { writeFigmaCopyToPen } from "./export/pen-writer.js";
import { verifyPencilWriteFidelity } from "./export/pen-verification.js";
import {
  writeFigmaStructureToPen,
  writeFigmaUpdatesToPen,
} from "./export/pen-updater.js";
import {
  buildFigmaExportManifest,
  collectMappedPenBridgeMappings,
  collectPenBridgeMappings,
  type PenBridgeMapping,
} from "./manifest/figma-export.js";
import { toPublicBridgeError } from "./public-error.js";
import type { OperationJournal } from "./operation-journal.js";
import { comparePngBuffers } from "./visual/compare.js";

export interface BridgeServerOptions {
  host: string;
  port: number;
  pen: PenMcpClient;
  sessions?: SessionManager;
  approval?: LocalApprovalProvider;
  journal?: OperationJournal;
}

export class BridgeServer {
  readonly #http: HttpServer;
  readonly #ws: WebSocketServer;
  readonly #pen: PenMcpClient;
  readonly #sessions: SessionManager;
  readonly #approval: LocalApprovalProvider;
  readonly #journal: OperationJournal | undefined;
  readonly #host: string;
  readonly #port: number;
  readonly #manifests = new ManifestRepository();
  readonly #transfers = new Map<
    string,
    { document: BridgeDocument; penPath: string; createdAt: number }
  >();
  readonly #resolutions = new Map<
    string,
    {
      penPath: string;
      rootBridgeId: string;
      penRootId: string;
      bridgeIds: string[];
      requiredFigmaChangeIds: string[];
      initialFigmaHashes: Record<string, string>;
      preparedPenHashes: Record<string, string>;
      structural: boolean;
      manifestRevision: number;
      operation: "updated-figma" | "resolved-keep-pen";
      resolvedBridgeId?: string;
      createdAt: number;
    }
  >();
  #activePenPath: string | undefined;

  constructor(options: BridgeServerOptions) {
    this.#host = options.host;
    this.#port = options.port;
    this.#pen = options.pen;
    this.#sessions = options.sessions ?? new SessionManager();
    this.#approval = options.approval ?? new MacOSApprovalProvider();
    this.#journal = options.journal;
    this.#http = createServer((request, response) => {
      void this.#handleHttp(request, response);
    });
    this.#ws = new WebSocketServer({
      server: this.#http,
      maxPayload: 1024 * 1024,
    });
    this.#ws.on("connection", (socket, request) => {
      if (!isAllowedBrowserOrigin(firstHeader(request.headers.origin))) {
        socket.close(1008, "Figma origin required");
        return;
      }
      this.#onConnection(socket);
    });
  }

  get pairingCode(): string {
    return this.#sessions.pairingCode;
  }

  async start(): Promise<number> {
    await this.#journal?.recoverInterrupted();
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
          phase: "validation",
          retrySafe: false,
        });
        return;
      }

      const parsed = clientMessageSchema.safeParse(raw);
      if (!parsed.success) {
        send(socket, {
          type: "failed",
          code: "SCHEMA_MESSAGE",
          message: "The bridge received an invalid message.",
          phase: "validation",
          retrySafe: false,
        });
        return;
      }

      const message = parsed.data;
      if (message.type === "pair") {
        const credentials = this.#sessions.pair(message.code.toUpperCase());
        if (!credentials) {
          send(socket, {
            type: "failed",
            code: "AUTH_PAIRING",
            message: "Invalid or expired pairing code",
            phase: "connection",
            retrySafe: true,
          });
          return;
        }
        send(socket, { type: "paired", protocol: 1, ...credentials });
        return;
      }

      if (message.type === "reconnect") {
        const credentials = this.#sessions.reconnect(message.reconnectToken);
        if (!credentials) {
          send(socket, {
            type: "failed",
            code: "AUTH_RECONNECT",
            message: "Saved connection is no longer valid",
            phase: "connection",
            retrySafe: true,
          });
          return;
        }
        send(socket, { type: "reconnected", protocol: 1, ...credentials });
        return;
      }

      if (message.type === "hello") {
        authenticated = this.#sessions.authenticate(message.token);
        if (!authenticated) {
          send(socket, {
            type: "failed",
            code: "AUTH_TOKEN",
            message: "Invalid session token",
            phase: "connection",
            retrySafe: true,
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
          const failure = toPublicBridgeError(error);
          send(socket, {
            type: "failed",
            code: failure.code,
            message: failure.message,
            phase: failure.phase,
            retrySafe: failure.retrySafe,
          });
        }
        return;
      }

      if (!authenticated) {
        send(socket, {
          type: "failed",
          code: "AUTH_REQUIRED",
          message: "Pair and authenticate first",
          phase: "connection",
          retrySafe: true,
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
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    const origin = firstHeader(request.headers.origin);
    if (!isAllowedBrowserOrigin(origin)) {
      json(response, 403, {
        type: "failed",
        code: "ORIGIN_FORBIDDEN",
        message: "This local bridge accepts browser requests only from Figma",
        phase: "connection",
        retrySafe: false,
      });
      return;
    }
    applyCorsHeaders(response, origin);
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    if (requestUrl.searchParams.has("token")) {
      json(response, 400, {
        type: "failed",
        code: "AUTH_TOKEN_URL_FORBIDDEN",
        message: "Send the session token in the x-pen-fig-token header",
        phase: "connection",
        retrySafe: false,
      });
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/health") {
      json(response, 200, {
        ok: true,
        protocol: BRIDGE_PROTOCOL_VERSION,
        companionVersion: COMPANION_VERSION,
        capabilities: COMPANION_CAPABILITIES,
        platform: process.platform,
        architecture: process.arch,
        reconciliationRequired: this.#journal?.reconciliationRequired ?? false,
      });
      return;
    }

    try {
      if (request.method === "POST" && requestUrl.pathname === "/authorize") {
        const parsed = authorizationRequestSchema.safeParse(
          await readJsonBody(request),
        );
        if (!parsed.success) {
          json(response, 400, {
            type: "failed",
            code: "SCHEMA_MESSAGE",
            message: "Expected a valid local authorization request",
            phase: "validation",
            retrySafe: false,
          });
          return;
        }
        const decision = await this.#approval.requestApproval();
        if (decision === "busy") {
          json(response, 409, {
            type: "failed",
            code: "AUTH_APPROVAL_BUSY",
            message: "A connection approval is already waiting on this Mac",
            phase: "connection",
            retrySafe: true,
          });
          return;
        }
        if (decision === "rate-limited") {
          json(response, 429, {
            type: "failed",
            code: "AUTH_APPROVAL_RATE_LIMITED",
            message: "Wait a moment before requesting another approval",
            phase: "connection",
            retrySafe: true,
          });
          return;
        }
        if (decision === "unavailable") {
          json(response, 501, {
            type: "failed",
            code: "AUTH_APPROVAL_UNAVAILABLE",
            message: "Native connection approval is unavailable",
            phase: "connection",
            retrySafe: false,
          });
          return;
        }
        if (decision === "denied") {
          json(response, 403, {
            type: "failed",
            code: "AUTH_APPROVAL_DENIED",
            message: "Connection was not allowed on this Mac",
            phase: "connection",
            retrySafe: true,
          });
          return;
        }
        json(response, 200, {
          type: "approved",
          protocol: 1,
          ...this.#sessions.approve(),
        });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/pair") {
        const parsed = clientMessageSchema.safeParse(
          await readJsonBody(request),
        );
        if (!parsed.success || parsed.data.type !== "pair") {
          json(response, 400, {
            type: "failed",
            code: "SCHEMA_MESSAGE",
            message: "Expected a valid pair message",
            phase: "validation",
            retrySafe: false,
          });
          return;
        }
        const credentials = this.#sessions.pair(parsed.data.code.toUpperCase());
        if (!credentials) {
          json(response, 401, {
            type: "failed",
            code: "AUTH_PAIRING",
            message: "Invalid or expired pairing code",
            phase: "connection",
            retrySafe: true,
          });
          return;
        }
        json(response, 200, {
          type: "paired",
          protocol: 1,
          ...credentials,
        });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/reconnect") {
        const parsed = clientMessageSchema.safeParse(
          await readJsonBody(request),
        );
        if (!parsed.success || parsed.data.type !== "reconnect") {
          json(response, 400, {
            type: "failed",
            code: "SCHEMA_MESSAGE",
            message: "Expected a valid reconnect message",
            phase: "validation",
            retrySafe: false,
          });
          return;
        }
        const credentials = this.#sessions.reconnect(
          parsed.data.reconnectToken,
        );
        if (!credentials) {
          json(response, 401, {
            type: "failed",
            code: "AUTH_RECONNECT",
            message: "Saved connection is no longer valid",
            phase: "connection",
            retrySafe: true,
          });
          return;
        }
        json(response, 200, {
          type: "reconnected",
          protocol: 1,
          ...credentials,
        });
        return;
      }

      const tokenHeader = request.headers["x-pen-fig-token"];
      const headerToken = Array.isArray(tokenHeader)
        ? (tokenHeader[0] ?? "")
        : (tokenHeader ?? "");
      if (!this.#sessions.authenticate(headerToken)) {
        json(response, 401, {
          type: "failed",
          code: "AUTH_REQUIRED",
          message: "Pair and authenticate first",
          phase: "connection",
          retrySafe: true,
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
        requestUrl.pathname === "/pen/selection"
      ) {
        const text = await this.#pen.listSelectedRootFrames(50);
        json(response, 200, {
          type: "pen-screens",
          requestId: "selection",
          text,
        });
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
        const document = await this.#importPenDocumentWithComponents(
          node,
          penPath,
        );
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
        requestUrl.pathname === "/visual/compare"
      ) {
        const comparisonRequest = visualComparisonRequestSchema.parse(
          await readJsonBody(request, 24 * 1024 * 1024),
        );
        const penPath = await this.#requireActivePenPath();
        const manifest = await this.#manifests.read(sidecarPath(penPath));
        if (!manifest)
          throw new Error(
            "This screen is not linked yet. Send it once before comparing its appearance.",
          );
        const rootMapping = manifest.mappings.find(
          (mapping) =>
            mapping.bridgeId === comparisonRequest.rootBridgeId &&
            mapping.penNodeId,
        );
        if (!rootMapping?.penNodeId)
          throw new Error(
            "The selected Figma screen has no linked Pencil page to compare.",
          );
        const figmaPng = Buffer.from(
          comparisonRequest.figmaPngBase64,
          "base64",
        );
        if (!figmaPng.length || figmaPng.byteLength > 16 * 1024 * 1024)
          throw new Error(
            "The Figma comparison image must be 16 MB or smaller",
          );
        const pencilPng = await this.#pen.exportNodePng(
          penPath,
          rootMapping.penNodeId,
          2,
        );
        const comparison = comparePngBuffers(pencilPng, figmaPng);
        json(response, 200, {
          type: "visual-comparison-result",
          ok: true,
          rootBridgeId: comparisonRequest.rootBridgeId,
          penRootId: rootMapping.penNodeId,
          matchPercent: (1 - comparison.report.mismatchRatio) * 100,
          report: comparison.report,
          diffPngBase64: comparison.diffPng.toString("base64"),
        });
        return;
      }
      if (
        request.method === "POST" &&
        requestUrl.pathname === "/sync/complete"
      ) {
        const completion = syncCompletionSchema.parse(
          await readJsonBody(request, 24 * 1024 * 1024),
        );
        const transfer = this.#transfers.get(completion.transferId);
        if (!transfer)
          throw new Error("Transfer expired; read the Pen screen again");
        const expectedHashes = authoredDocumentHashes(transfer.document);
        const figmaBaselineHashes = completion.figmaBaselineHashes;
        if (
          figmaBaselineHashes &&
          (Object.keys(figmaBaselineHashes).length !==
            Object.keys(expectedHashes).length ||
            Object.keys(figmaBaselineHashes).some(
              (bridgeId) => !expectedHashes[bridgeId],
            ))
        )
          throw new Error("Figma baseline hashes do not match the transfer");
        const returned = new Map(
          completion.mappings.map((mapping) => [mapping.bridgeId, mapping]),
        );
        if (
          returned.size !== completion.mappings.length ||
          returned.size !== Object.keys(expectedHashes).length
        )
          throw new Error("Figma mapping count does not match the transfer");
        const visualComparison = completion.figmaPngBase64
          ? await compareTransferredAppearance(
              this.#pen,
              transfer.penPath,
              transfer.document.root.source.nodeId,
              completion.figmaPngBase64,
            )
          : undefined;
        if (visualComparison && !visualComparison.report.passed)
          throw new Error(
            appearanceVerificationMessage(
              transfer.document.root.name,
              visualComparison.matchPercent,
            ),
          );
        const mappings: BridgeManifest["mappings"] = [];
        visitBridgeNodes(transfer.document.root, (node) => {
          const mapping = returned.get(node.bridgeId);
          if (!mapping)
            throw new Error(`Figma mapping missing ${node.bridgeId}`);
          mappings.push({
            bridgeId: node.bridgeId,
            rootBridgeId: transfer.document.root.bridgeId,
            penNodeId: node.source.nodeId,
            figmaNodeId: mapping.figmaNodeId,
            baselineHash: expectedHashes[node.bridgeId]!,
            ...(figmaBaselineHashes
              ? {
                  penBaselineHash: expectedHashes[node.bridgeId]!,
                  figmaBaselineHash: figmaBaselineHashes[node.bridgeId]!,
                }
              : {}),
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
          mappings: [
            ...(previous?.mappings.filter(
              (mapping) =>
                Boolean(mapping.rootBridgeId) &&
                mapping.rootBridgeId !== transfer.document.root.bridgeId,
            ) ?? []),
            ...mappings,
          ],
        });
        this.#transfers.delete(completion.transferId);
        json(response, 200, {
          type: "sync-committed",
          revision: (previous?.revision ?? -1) + 1,
          mappingCount: mappings.length,
          manifestPath,
          ...(visualComparison ? { visualComparison } : {}),
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
        const journalId = await this.#journal?.begin("figma-export", [
          exportRequest.document.root.bridgeId,
        ]);
        try {
          const result = await writeFigmaCopyToPen(
            exportRequest.document,
            exportRequest.assetData,
            penPath,
            this.#pen,
            {
              ...(exportRequest.placementAnchorId
                ? { placementAnchorId: exportRequest.placementAnchorId }
                : {}),
            },
          );
          if (journalId)
            await this.#journal
              ?.setPhase(journalId, "verifying")
              .catch(() => undefined);
          const { mappings, ...summary } = result;
          const rootBridgeIds = new Set<string>();
          visitBridgeNodes(exportRequest.document.root, (node) =>
            rootBridgeIds.add(node.bridgeId),
          );
          const syncMappings = mappings.filter((mapping) =>
            rootBridgeIds.has(mapping.bridgeId),
          );
          let manifest: {
            revision: number;
            mappingCount: number;
            manifestPath: string;
          };
          let visualComparison:
            | Awaited<ReturnType<typeof compareTransferredAppearance>>
            | undefined;
          try {
            const writtenRoot = await this.#pen.getNode(result.rootId);
            const penDocument = await this.#importPenDocumentWithComponents(
              writtenRoot,
              penPath,
              true,
              mappings,
            );
            verifyPencilWriteFidelity(exportRequest.document, penDocument);
            visualComparison = exportRequest.figmaPngBase64
              ? await compareTransferredAppearance(
                  this.#pen,
                  penPath,
                  result.rootId,
                  exportRequest.figmaPngBase64,
                )
              : undefined;
            if (visualComparison && !visualComparison.report.passed)
              throw new Error(
                appearanceVerificationMessage(
                  exportRequest.document.root.name,
                  visualComparison.matchPercent,
                ),
              );
            if (journalId)
              await this.#journal
                ?.setPhase(journalId, "committing")
                .catch(() => undefined);
            manifest = await this.#commitFigmaExportManifest(
              exportRequest.document,
              syncMappings,
              penPath,
              penDocument,
            );
          } catch (error) {
            const componentRootIds = (exportRequest.document.components ?? [])
              .map(
                (component) =>
                  mappings.find(
                    (mapping) => mapping.bridgeId === component.bridgeId,
                  )?.penNodeId,
              )
              .filter((nodeId): nodeId is string => Boolean(nodeId));
            const artifactIds = [
              ...new Set([result.rootId, ...componentRootIds]),
            ];
            let rollback = `Rolled back ${artifactIds.length} unverified Pencil root${artifactIds.length === 1 ? "" : "s"}`;
            try {
              await this.#pen.executeWrite(
                artifactIds
                  .map((nodeId) => `Delete(${JSON.stringify(nodeId)})`)
                  .join(";"),
                30_000,
              );
            } catch {
              rollback = `Could not roll back ${artifactIds.length} unverified Pencil root${artifactIds.length === 1 ? "" : "s"}`;
            }
            const message =
              error instanceof Error ? error.message : "Unknown error";
            throw new Error(`${message}. ${rollback}`);
          }
          if (journalId)
            await this.#journal?.complete(journalId).catch(() => undefined);
          json(response, 200, {
            type: "figma-export-result",
            ok: true,
            operation: "created-copy",
            ...summary,
            manifest,
            ...(visualComparison ? { visualComparison } : {}),
          });
        } catch (error) {
          if (journalId)
            await this.#journal
              ?.fail(journalId, toPublicBridgeError(error).code)
              .catch(() => undefined);
          throw error;
        }
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
        const penDocument = await this.#importPenDocumentWithComponents(
          root,
          penPath,
          true,
        );
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
        const penMappings = manifest.mappings.map((mapping) => {
          if (!mapping.penNodeId)
            throw new Error(`Pencil mapping missing ${mapping.bridgeId}`);
          return {
            bridgeId: mapping.bridgeId,
            penNodeId: mapping.penNodeId,
          };
        });
        const penRoot = await this.#pen.getNode(rootMapping.penNodeId);
        const penDocument = await this.#importPenDocumentWithComponents(
          penRoot,
          penPath,
          true,
          penMappings,
        );
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
        const actions = countSyncDirections(diff.entries);
        const structural = hasStructuralDifference(diff.entries);
        await this.#journal?.acknowledgeReconciliation().catch(() => undefined);
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
          actions,
          structural,
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
        const state = await this.#readMappedSyncState(
          syncRequest.document,
          penPath,
        );
        if (
          state.baseline.some(
            (mapping) => !mapping.penBaselineHash || !mapping.figmaBaselineHash,
          )
        )
          throw new Error(
            "Adopt this Pencil root again to upgrade its baseline",
          );
        const actions = countSyncDirections(state.diff.entries);
        if (actions.conflicts || actions.unmapped)
          throw new Error(
            "Sync has conflicts or unmapped nodes; no writes applied",
          );
        if (actions.toPencil && actions.toFigma)
          throw new Error(
            "Both editors have independent changes; apply one direction at a time",
          );
        const structural = hasStructuralDifference(state.diff.entries);
        const changedFigmaBridgeIds = state.diff.entries
          .filter(
            (entry) =>
              entry.classification === "pen-only" ||
              ((entry.classification === "added" ||
                entry.classification === "deleted") &&
                entry.side === "pen"),
          )
          .map((entry) => entry.bridgeId);
        if (actions.toFigma !== changedFigmaBridgeIds.length)
          throw new Error("Sync contains unsupported Figma operations");
        if (changedFigmaBridgeIds.length > 40)
          throw new Error(
            `Pencil update has ${changedFigmaBridgeIds.length} nodes; the atomic limit is 40`,
          );
        if (changedFigmaBridgeIds.length) {
          const resolved = await resolveAssets(state.penDocument);
          const resolutionId = randomUUID();
          this.#pruneTransfers();
          this.#resolutions.set(resolutionId, {
            penPath,
            rootBridgeId: syncRequest.document.root.bridgeId,
            penRootId: state.rootMapping.penNodeId,
            bridgeIds: changedFigmaBridgeIds,
            requiredFigmaChangeIds: changedFigmaBridgeIds,
            initialFigmaHashes: authoredDocumentHashes(syncRequest.document),
            preparedPenHashes: authoredDocumentHashes(state.penDocument),
            structural,
            manifestRevision: state.manifest.revision,
            operation: "updated-figma",
            createdAt: Date.now(),
          });
          json(response, 200, {
            type: "figma-sync-resolution-prepared",
            ok: true,
            direction: "pen",
            operation: "updated-figma",
            structural,
            resolutionId,
            bridgeIds: changedFigmaBridgeIds,
            document: resolved.document,
            assetData: resolved.assetData,
          });
          return;
        }

        const changedPenBridgeIds = state.diff.entries
          .filter(
            (entry) =>
              entry.classification === "figma-only" ||
              ((entry.classification === "added" ||
                entry.classification === "deleted") &&
                entry.side === "figma"),
          )
          .map((entry) => entry.bridgeId);
        if (actions.toPencil !== changedPenBridgeIds.length)
          throw new Error("Sync contains unsupported Pencil operations");
        if (!changedPenBridgeIds.length) {
          json(response, 200, {
            type: "figma-sync-result",
            ok: true,
            operation: "unchanged",
            updatedNodeCount: 0,
            manifestRevision: state.manifest.revision,
          });
          return;
        }
        const penMappings: PenBridgeMapping[] = state.baseline.map(
          (mapping) => {
            if (!mapping.penNodeId)
              throw new Error(`Pencil mapping missing ${mapping.bridgeId}`);
            return {
              bridgeId: mapping.bridgeId,
              penNodeId: mapping.penNodeId,
            };
          },
        );
        const structuralUpdate = structural
          ? await writeFigmaStructureToPen(
              syncRequest.document,
              changedPenBridgeIds,
              penMappings,
              state.penRoot,
              state.penDocument,
              syncRequest.assetData,
              penPath,
              this.#pen,
            )
          : undefined;
        const update =
          structuralUpdate ??
          (await writeFigmaUpdatesToPen(
            syncRequest.document,
            changedPenBridgeIds,
            penMappings,
            state.penRoot,
            state.penDocument,
            syncRequest.assetData,
            penPath,
            this.#pen,
          ));
        const verifiedRoot = await this.#pen.getNode(
          state.rootMapping.penNodeId,
        );
        const verifiedMappings = collectMappedPenBridgeMappings(
          verifiedRoot,
          structuralUpdate?.mappings ?? penMappings,
        );
        if (
          verifiedMappings.length !==
          (structuralUpdate?.mappings.length ?? state.baseline.length)
        )
          throw new Error("Pencil verification found a mapping count mismatch");
        const verifiedPenDocument = await this.#importPenDocumentWithComponents(
          verifiedRoot,
          penPath,
          true,
          verifiedMappings,
        );
        const existingPenHashes = authoredDocumentHashes(state.penDocument);
        verifyPencilWriteFidelity(
          syncRequest.document,
          verifiedPenDocument,
          structural
            ? changedPenBridgeIds.filter(
                (bridgeId) => !existingPenHashes[bridgeId],
              )
            : changedPenBridgeIds,
        );
        const committed = structural
          ? await this.#commitFigmaExportManifest(
              syncRequest.document,
              verifiedMappings,
              penPath,
              verifiedPenDocument,
            )
          : await this.#commitPartialFigmaExportManifest(
              syncRequest.document,
              verifiedMappings,
              penPath,
              verifiedPenDocument,
              state.manifest,
              changedPenBridgeIds,
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
      if (
        request.method === "POST" &&
        requestUrl.pathname === "/figma/sync/resolve"
      ) {
        const resolutionRequest = figmaResolutionRequestSchema.parse(
          await readJsonBody(request, 50 * 1024 * 1024),
        );
        const penPath = await this.#requireActivePenPath();
        const state = await this.#readMappedSyncState(
          resolutionRequest.document,
          penPath,
        );
        if (
          state.baseline.some(
            (mapping) => !mapping.penBaselineHash || !mapping.figmaBaselineHash,
          )
        )
          throw new Error(
            "Adopt this Pencil root again to upgrade its baseline",
          );
        const conflict = state.diff.conflictRoots.find(
          (entry) => entry.bridgeId === resolutionRequest.bridgeId,
        );
        if (!conflict)
          throw new Error(
            `Conflict root ${resolutionRequest.bridgeId} is no longer current`,
          );
        let bridgeIds = diffSubtreeIds(
          state.diff.entries,
          resolutionRequest.bridgeId,
        );
        let subtree = new Set(bridgeIds);
        let subtreeEntries = state.diff.entries.filter((entry) =>
          subtree.has(entry.bridgeId),
        );
        const unsupportedStructural = subtreeEntries.filter(
          (entry) => entry.classification === "unmapped",
        );
        if (unsupportedStructural.length)
          throw new Error(
            `Unmapped conflict resolution is not enabled yet: ${unsupportedStructural[0]!.bridgeId}`,
          );
        const structural = hasStructuralDifference(subtreeEntries);
        if (structural) {
          bridgeIds = includeDiffAncestors(state.diff.entries, bridgeIds);
          subtree = new Set(bridgeIds);
          subtreeEntries = state.diff.entries.filter((entry) =>
            subtree.has(entry.bridgeId),
          );
        }
        const outsideChange = state.diff.entries.find(
          (entry) =>
            !subtree.has(entry.bridgeId) &&
            entry.classification !== "unchanged",
        );
        if (structural && outsideChange)
          throw new Error(
            `Resolve structural conflict ${resolutionRequest.bridgeId} separately from ${outsideChange.bridgeId}`,
          );
        if (bridgeIds.length > 40)
          throw new Error(
            `Conflict subtree has ${bridgeIds.length} nodes; the atomic limit is 40`,
          );
        const requiredChangeIds = state.diff.entries
          .filter(
            (entry) =>
              subtree.has(entry.bridgeId) &&
              entry.classification !== "unchanged",
          )
          .map((entry) => entry.bridgeId);

        if (resolutionRequest.direction === "figma") {
          const initialPenHashes = authoredDocumentHashes(state.penDocument);
          const penMappings = state.baseline.map((mapping) => {
            if (!mapping.penNodeId)
              throw new Error(`Pencil mapping missing ${mapping.bridgeId}`);
            return {
              bridgeId: mapping.bridgeId,
              penNodeId: mapping.penNodeId,
            };
          });
          const structuralUpdate = structural
            ? await writeFigmaStructureToPen(
                resolutionRequest.document,
                bridgeIds,
                penMappings,
                state.penRoot,
                state.penDocument,
                resolutionRequest.assetData,
                penPath,
                this.#pen,
                { scopeBridgeIds: subtree },
              )
            : undefined;
          const update =
            structuralUpdate ??
            (await writeFigmaUpdatesToPen(
              resolutionRequest.document,
              bridgeIds,
              penMappings,
              state.penRoot,
              state.penDocument,
              resolutionRequest.assetData,
              penPath,
              this.#pen,
            ));
          const verifiedRoot = await this.#pen.getNode(
            state.rootMapping.penNodeId,
          );
          const verifiedMappings = collectMappedPenBridgeMappings(
            verifiedRoot,
            structuralUpdate?.mappings ?? penMappings,
          );
          const verifiedPenDocument =
            await this.#importPenDocumentWithComponents(
              verifiedRoot,
              penPath,
              true,
              verifiedMappings,
            );
          verifyPencilWriteFidelity(
            resolutionRequest.document,
            verifiedPenDocument,
            structural
              ? bridgeIds.filter((bridgeId) => !initialPenHashes[bridgeId])
              : bridgeIds,
          );
          const verifiedHashes = authoredDocumentHashes(verifiedPenDocument);
          if (structural)
            assertMatchingStructure(
              verifiedPenDocument,
              resolutionRequest.document,
              bridgeIds,
            );
          for (const bridgeId of requiredChangeIds)
            if (verifiedHashes[bridgeId] === initialPenHashes[bridgeId])
              throw new Error(
                `Pencil verification found no resolved change for ${bridgeId}`,
              );
          const manifest = structural
            ? await this.#commitStructuralFigmaExportManifest(
                resolutionRequest.document,
                verifiedMappings,
                penPath,
                verifiedPenDocument,
                state.manifest,
                bridgeIds,
              )
            : await this.#commitPartialFigmaExportManifest(
                resolutionRequest.document,
                verifiedMappings,
                penPath,
                verifiedPenDocument,
                state.manifest,
                bridgeIds,
              );
          json(response, 200, {
            type: "figma-sync-result",
            ok: true,
            operation: "resolved-keep-figma",
            resolvedBridgeId: resolutionRequest.bridgeId,
            updatedNodeCount: update.updatedNodeCount,
            manifest,
          });
          return;
        }

        const resolved = await resolveAssets(state.penDocument);
        const resolutionId = randomUUID();
        this.#pruneTransfers();
        this.#resolutions.set(resolutionId, {
          penPath,
          rootBridgeId: resolutionRequest.document.root.bridgeId,
          penRootId: state.rootMapping.penNodeId,
          bridgeIds,
          requiredFigmaChangeIds: requiredChangeIds,
          initialFigmaHashes: authoredDocumentHashes(
            resolutionRequest.document,
          ),
          preparedPenHashes: authoredDocumentHashes(state.penDocument),
          structural,
          manifestRevision: state.manifest.revision,
          operation: "resolved-keep-pen",
          resolvedBridgeId: resolutionRequest.bridgeId,
          createdAt: Date.now(),
        });
        json(response, 200, {
          type: "figma-sync-resolution-prepared",
          ok: true,
          direction: "pen",
          structural,
          resolutionId,
          bridgeIds,
          document: resolved.document,
          assetData: resolved.assetData,
        });
        return;
      }
      if (
        request.method === "POST" &&
        requestUrl.pathname === "/figma/sync/resolve/complete"
      ) {
        const completion = figmaResolutionCompletionSchema.parse(
          await readJsonBody(request, 5 * 1024 * 1024),
        );
        const pending = this.#resolutions.get(completion.resolutionId);
        if (!pending) throw new Error("Pending Figma update expired");
        const penPath = await this.#requireActivePenPath();
        if (penPath !== pending.penPath)
          throw new Error("Conflict resolution belongs to another Pencil file");
        if (completion.document.root.bridgeId !== pending.rootBridgeId)
          throw new Error("Resolved Figma root identity does not match");
        const currentManifest = await this.#manifests.read(
          sidecarPath(penPath),
        );
        if (!currentManifest)
          throw new Error("Sync manifest disappeared during resolution");
        if (currentManifest.revision !== pending.manifestRevision)
          throw new Error("Sync manifest changed during conflict resolution");
        const rootMapping = currentManifest.mappings.find(
          (mapping) => mapping.bridgeId === pending.rootBridgeId,
        );
        if (
          !rootMapping?.figmaNodeId ||
          rootMapping.figmaNodeId !== completion.document.root.source.nodeId
        )
          throw new Error("Resolved Figma root mapping does not match");
        const penRoot = await this.#pen.getNode(pending.penRootId);
        const currentMappings = currentManifest.mappings.map((mapping) => {
          if (!mapping.penNodeId)
            throw new Error(`Pencil mapping missing ${mapping.bridgeId}`);
          return {
            bridgeId: mapping.bridgeId,
            penNodeId: mapping.penNodeId,
          };
        });
        const penDocument = await this.#importPenDocumentWithComponents(
          penRoot,
          penPath,
          true,
          currentMappings,
        );
        const penMappings = pending.structural
          ? collectPenDocumentMappings(penDocument)
          : collectMappedPenBridgeMappings(penRoot, currentMappings);
        const penHashes = authoredDocumentHashes(penDocument);
        const figmaHashes = authoredDocumentHashes(completion.document);
        const resolutionIds = new Set(pending.bridgeIds);
        const changedPen = Object.entries(pending.preparedPenHashes).find(
          ([bridgeId, hash]) => penHashes[bridgeId] !== hash,
        );
        if (changedPen)
          throw new Error(`Pencil changed during resolution: ${changedPen[0]}`);
        const outsideFigmaChange = Object.entries(
          pending.initialFigmaHashes,
        ).find(
          ([bridgeId, hash]) =>
            !resolutionIds.has(bridgeId) && figmaHashes[bridgeId] !== hash,
        );
        if (outsideFigmaChange)
          throw new Error(
            `Another Figma change appeared during resolution: ${outsideFigmaChange[0]}`,
          );
        const missingFigmaChange = pending.requiredFigmaChangeIds.find(
          (bridgeId) =>
            figmaHashes[bridgeId] === pending.initialFigmaHashes[bridgeId],
        );
        if (missingFigmaChange)
          throw new Error(
            `Figma verification found no resolved change for ${missingFigmaChange}`,
          );
        const manifest = pending.structural
          ? await this.#commitStructuralFigmaExportManifest(
              completion.document,
              penMappings,
              penPath,
              penDocument,
              currentManifest,
              pending.bridgeIds,
            )
          : await this.#commitPartialFigmaExportManifest(
              completion.document,
              penMappings,
              penPath,
              penDocument,
              currentManifest,
              pending.bridgeIds,
            );
        this.#resolutions.delete(completion.resolutionId);
        json(response, 200, {
          type: "figma-sync-result",
          ok: true,
          operation: pending.operation,
          ...(pending.resolvedBridgeId
            ? { resolvedBridgeId: pending.resolvedBridgeId }
            : { updatedBridgeIds: pending.bridgeIds }),
          updatedNodeCount: pending.bridgeIds.length,
          manifest,
        });
        return;
      }
      json(response, 404, {
        type: "failed",
        code: "NOT_FOUND",
        message: "Not found",
        phase: "validation",
        retrySafe: false,
      });
    } catch (error) {
      const failure = toPublicBridgeError(error);
      json(response, failure.httpStatus, {
        type: "failed",
        code: failure.code,
        message: failure.message,
        phase: failure.phase,
        retrySafe: failure.retrySafe,
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

  async #importPenDocumentWithComponents(
    root: PenNode,
    penPath: string,
    useBridgeMetadata = false,
    mappings: PenBridgeMapping[] = [],
  ): Promise<BridgeDocument> {
    const bridgeIdByPenNodeId = new Map(
      mappings.map((mapping) => [mapping.penNodeId, mapping.bridgeId]),
    );
    applyPenBridgeMappings(root, bridgeIdByPenNodeId);
    const knownComponentIds = collectReusablePenIds(root);
    const queued = collectPenComponentRefs(root).filter(
      (ref) => !knownComponentIds.has(ref),
    );
    const visited = new Set<string>();
    const components: PenNode[] = [];
    while (queued.length) {
      const ref = queued.shift()!;
      if (visited.has(ref) || knownComponentIds.has(ref)) continue;
      visited.add(ref);
      if (components.length >= 100)
        throw new Error("Pencil component dependency limit exceeded (100)");
      const component = await this.#pen.getNode(ref);
      applyPenBridgeMappings(component, bridgeIdByPenNodeId);
      if (component.type !== "frame" || !component.reusable)
        throw new Error(`Pencil ref ${ref} is not a reusable frame`);
      components.push(component);
      knownComponentIds.add(component.id);
      for (const nestedRef of collectPenComponentRefs(component))
        if (!visited.has(nestedRef) && !knownComponentIds.has(nestedRef))
          queued.push(nestedRef);
    }
    return importPenDocument(root, {
      documentId: penPath,
      useBridgeMetadata,
      components,
      variables: await readPenVariables(penPath),
    });
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

  async #commitPartialFigmaExportManifest(
    document: BridgeDocument,
    mappings: PenBridgeMapping[],
    penPath: string,
    penDocument: BridgeDocument,
    previous: BridgeManifest,
    bridgeIds: string[],
  ): Promise<{
    revision: number;
    mappingCount: number;
    manifestPath: string;
  }> {
    const selected = new Set(bridgeIds);
    const figmaHashes = authoredDocumentHashes(document);
    const penHashes = authoredDocumentHashes(penDocument);
    const penNodeIds = new Map(
      mappings.map((mapping) => [mapping.bridgeId, mapping.penNodeId]),
    );
    const figmaNodeIds = new Map<string, string>();
    visitBridgeNodes(document.root, (node) => {
      figmaNodeIds.set(node.bridgeId, node.source.nodeId);
    });
    for (const bridgeId of selected)
      if (
        !previous.mappings.some((mapping) => mapping.bridgeId === bridgeId) ||
        !figmaHashes[bridgeId] ||
        !penHashes[bridgeId] ||
        !penNodeIds.has(bridgeId) ||
        !figmaNodeIds.has(bridgeId)
      )
        throw new Error(`Conflict mapping is incomplete for ${bridgeId}`);
    const manifest: BridgeManifest = {
      ...previous,
      revision: previous.revision + 1,
      updatedAt: new Date().toISOString(),
      mappings: previous.mappings.map((mapping) => {
        if (selected.has(mapping.bridgeId))
          return {
            ...mapping,
            rootBridgeId: document.root.bridgeId,
            penNodeId: penNodeIds.get(mapping.bridgeId),
            figmaNodeId: figmaNodeIds.get(mapping.bridgeId),
            baselineHash: figmaHashes[mapping.bridgeId]!,
            penBaselineHash: penHashes[mapping.bridgeId],
            figmaBaselineHash: figmaHashes[mapping.bridgeId],
          };
        return figmaHashes[mapping.bridgeId]
          ? { ...mapping, rootBridgeId: document.root.bridgeId }
          : mapping;
      }),
    };
    const manifestPath = sidecarPath(penPath);
    await this.#manifests.writeAtomic(manifestPath, manifest);
    return {
      revision: manifest.revision,
      mappingCount: manifest.mappings.length,
      manifestPath,
    };
  }

  async #commitStructuralFigmaExportManifest(
    document: BridgeDocument,
    mappings: PenBridgeMapping[],
    penPath: string,
    penDocument: BridgeDocument,
    previous: BridgeManifest,
    bridgeIds: string[],
  ): Promise<{
    revision: number;
    mappingCount: number;
    manifestPath: string;
  }> {
    const selected = new Set(bridgeIds);
    const candidate = buildFigmaExportManifest(document, mappings, penPath, {
      previous,
      penDocument,
    });
    const previousByBridgeId = new Map(
      previous.mappings.map((mapping) => [mapping.bridgeId, mapping]),
    );
    for (const mapping of previous.mappings)
      if (
        !selected.has(mapping.bridgeId) &&
        !candidate.mappings.some(
          (candidateMapping) => candidateMapping.bridgeId === mapping.bridgeId,
        )
      )
        throw new Error(
          `Structural resolution unexpectedly removed ${mapping.bridgeId}`,
        );
    const manifest: BridgeManifest = {
      ...candidate,
      mappings: candidate.mappings.map((mapping) => {
        if (selected.has(mapping.bridgeId)) return mapping;
        const preserved = previousByBridgeId.get(mapping.bridgeId);
        if (!preserved)
          throw new Error(
            `Structural resolution unexpectedly added ${mapping.bridgeId}`,
          );
        return preserved;
      }),
    };
    const manifestPath = sidecarPath(penPath);
    await this.#manifests.writeAtomic(manifestPath, manifest);
    return {
      revision: manifest.revision,
      mappingCount: manifest.mappings.length,
      manifestPath,
    };
  }

  async #readMappedSyncState(document: BridgeDocument, penPath: string) {
    const manifest = await this.#manifests.read(sidecarPath(penPath));
    if (!manifest) throw new Error("No sync manifest exists for this file");
    if (manifest.penDocumentId !== penPath)
      throw new Error("Sync manifest belongs to a different Pencil file");
    const rootMapping = manifest.mappings.find(
      (mapping) => mapping.bridgeId === document.root.bridgeId,
    );
    if (!rootMapping?.penNodeId || !rootMapping.figmaNodeId)
      throw new Error("The selected Figma root is not fully mapped");
    if (rootMapping.figmaNodeId !== document.root.source.nodeId)
      throw new Error("The selected Figma root does not own this mapping");
    const penMappings = manifest.mappings.map((mapping) => {
      if (!mapping.penNodeId)
        throw new Error(`Pencil mapping missing ${mapping.bridgeId}`);
      return {
        bridgeId: mapping.bridgeId,
        penNodeId: mapping.penNodeId,
      };
    });
    const penRoot = await this.#pen.getNode(rootMapping.penNodeId);
    const penDocument = await this.#importPenDocumentWithComponents(
      penRoot,
      penPath,
      true,
      penMappings,
    );
    if (penDocument.root.bridgeId !== document.root.bridgeId)
      throw new Error("Mapped Pencil root bridge identity does not match");
    const penSnapshots = snapshotBridgeDocument(penDocument);
    const figmaSnapshots = snapshotBridgeDocument(document);
    const relevantBridgeIds = new Set([
      ...penSnapshots.map((snapshot) => snapshot.bridgeId),
      ...figmaSnapshots.map((snapshot) => snapshot.bridgeId),
    ]);
    const baseline = manifest.mappings.filter((mapping) =>
      relevantBridgeIds.has(mapping.bridgeId),
    );
    const diff = classifyThreeWayDiff(baseline, penSnapshots, figmaSnapshots);
    return {
      manifest,
      rootMapping: {
        ...rootMapping,
        penNodeId: rootMapping.penNodeId,
        figmaNodeId: rootMapping.figmaNodeId,
      },
      penRoot,
      penDocument,
      baseline,
      diff,
    };
  }

  #pruneTransfers(): void {
    const cutoff = Date.now() - 15 * 60_000;
    for (const [id, transfer] of this.#transfers)
      if (transfer.createdAt < cutoff) this.#transfers.delete(id);
    for (const [id, resolution] of this.#resolutions)
      if (resolution.createdAt < cutoff) this.#resolutions.delete(id);
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
      const publicError = toPublicBridgeError(error);
      const failure: ServerMessage = {
        type: "failed",
        code: publicError.code,
        message: publicError.message,
        phase: publicError.phase,
        retrySafe: publicError.retrySafe,
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
    figmaPngBase64: z
      .string()
      .min(1)
      .max(22 * 1024 * 1024)
      .optional(),
    figmaBaselineHashes: z
      .record(z.string().min(1).max(200), z.string().regex(/^[a-f0-9]{64}$/))
      .optional(),
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

const visualComparisonRequestSchema = z
  .object({
    rootBridgeId: z.string().min(1).max(200),
    figmaPngBase64: z
      .string()
      .min(1)
      .max(22 * 1024 * 1024),
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
    placementAnchorId: z
      .string()
      .regex(/^[A-Za-z0-9]+$/)
      .optional(),
    figmaPngBase64: z
      .string()
      .min(1)
      .max(22 * 1024 * 1024)
      .optional(),
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

const figmaResolutionRequestSchema = figmaExportRequestSchema
  .extend({
    direction: z.enum(["pen", "figma"]),
    bridgeId: z.string().min(1).max(200),
  })
  .strict();

const figmaResolutionCompletionSchema = z
  .object({
    resolutionId: z.string().uuid(),
    document: bridgeDocumentSchema,
  })
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

function hasStructuralDifference(
  entries: ReturnType<typeof classifyThreeWayDiff>["entries"],
): boolean {
  return entries.some((entry) => {
    if (entry.classification === "added") return true;
    if (entry.classification === "deleted") return entry.side !== "both";
    if (entry.reason === "delete-vs-edit") return true;
    return Boolean(
      entry.pen &&
      entry.figma &&
      (entry.pen.parentBridgeId !== entry.figma.parentBridgeId ||
        entry.pen.index !== entry.figma.index),
    );
  });
}

function assertMatchingStructure(
  penDocument: BridgeDocument,
  figmaDocument: BridgeDocument,
  bridgeIds: string[],
): void {
  const pen = new Map(
    snapshotBridgeDocument(penDocument).map((entry) => [entry.bridgeId, entry]),
  );
  const figma = new Map(
    snapshotBridgeDocument(figmaDocument).map((entry) => [
      entry.bridgeId,
      entry,
    ]),
  );
  for (const bridgeId of bridgeIds) {
    const left = pen.get(bridgeId);
    const right = figma.get(bridgeId);
    if (
      Boolean(left) !== Boolean(right) ||
      (left &&
        right &&
        (left.parentBridgeId !== right.parentBridgeId ||
          left.index !== right.index))
    )
      throw new Error(`Pencil structural verification differs for ${bridgeId}`);
  }
}

function collectPenDocumentMappings(
  document: BridgeDocument,
): PenBridgeMapping[] {
  const mappings: PenBridgeMapping[] = [];
  visitBridgeNodes(document.root, (node) => {
    if (node.source.app !== "pen")
      throw new Error(`Bridge node ${node.bridgeId} has no Pencil source`);
    mappings.push({ bridgeId: node.bridgeId, penNodeId: node.source.nodeId });
  });
  return mappings;
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

export function collectPenComponentRefs(root: PenNode): string[] {
  const refs = new Set<string>();
  const visit = (node: PenNode) => {
    if (node.type === "ref" && node.ref) {
      refs.add(node.ref);
      // Pencil includes derived instance descendants as nested ref nodes.
      // Their targets are children of this component, not reusable component
      // roots, so they must not be loaded as separate dependencies.
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return [...refs];
}

function collectReusablePenIds(root: PenNode): Set<string> {
  const ids = new Set<string>();
  const visit = (node: PenNode) => {
    if (node.type === "frame" && node.reusable) ids.add(node.id);
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return ids;
}

function applyPenBridgeMappings(
  root: PenNode,
  bridgeIdByPenNodeId: ReadonlyMap<string, string>,
): void {
  const visit = (node: PenNode) => {
    const bridgeId = bridgeIdByPenNodeId.get(node.id);
    if (bridgeId)
      node.metadata = node.metadata
        ? { ...node.metadata, bridgeId }
        : { type: "pen-fig-bridge", bridgeId };
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
}

function diffSubtreeIds(
  entries: ReturnType<typeof classifyThreeWayDiff>["entries"],
  bridgeId: string,
): string[] {
  const byBridgeId = new Map(entries.map((entry) => [entry.bridgeId, entry]));
  const root = byBridgeId.get(bridgeId);
  if (!root) throw new Error(`Conflict node ${bridgeId} is missing`);
  const included = new Set([bridgeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries) {
      if (included.has(entry.bridgeId)) continue;
      const penParent = entry.pen?.parentBridgeId;
      const figmaParent = entry.figma?.parentBridgeId;
      if (
        (penParent && included.has(penParent)) ||
        (figmaParent && included.has(figmaParent))
      ) {
        included.add(entry.bridgeId);
        changed = true;
      }
    }
  }
  return entries
    .filter((entry) => included.has(entry.bridgeId))
    .map((entry) => entry.bridgeId);
}

function includeDiffAncestors(
  entries: ReturnType<typeof classifyThreeWayDiff>["entries"],
  bridgeIds: string[],
): string[] {
  const byBridgeId = new Map(entries.map((entry) => [entry.bridgeId, entry]));
  const included = new Set(bridgeIds);
  const ancestorQueue = bridgeIds.flatMap((bridgeId) => {
    const entry = byBridgeId.get(bridgeId);
    return [entry?.pen?.parentBridgeId, entry?.figma?.parentBridgeId];
  });
  while (ancestorQueue.length) {
    const parentBridgeId = ancestorQueue.shift();
    if (!parentBridgeId || included.has(parentBridgeId)) continue;
    included.add(parentBridgeId);
    const parent = byBridgeId.get(parentBridgeId);
    if (parent) {
      ancestorQueue.push(
        parent.pen?.parentBridgeId,
        parent.figma?.parentBridgeId,
      );
    }
  }
  return entries
    .filter((entry) => included.has(entry.bridgeId))
    .map((entry) => entry.bridgeId);
}

async function compareTransferredAppearance(
  pen: PenMcpClient,
  penPath: string,
  penRootId: string,
  figmaPngBase64: string,
): Promise<{
  matchPercent: number;
  report: ReturnType<typeof comparePngBuffers>["report"];
}> {
  const figmaPng = Buffer.from(figmaPngBase64, "base64");
  if (!figmaPng.length || figmaPng.byteLength > 16 * 1024 * 1024)
    throw new Error("The Figma comparison image must be 16 MB or smaller");
  const pencilPng = await pen.exportNodePng(penPath, penRootId, 2);
  const comparison = comparePngBuffers(pencilPng, figmaPng);
  return {
    matchPercent: (1 - comparison.report.mismatchRatio) * 100,
    report: comparison.report,
  };
}

function appearanceVerificationMessage(
  screenName: string,
  matchPercent: number,
): string {
  return `Appearance verification failed for “${screenName}” at ${matchPercent.toFixed(1)}% match. No sync link was saved`;
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify(message));
}

function summarizeState(text: string): string {
  return (
    text
      .split("\n")
      .find((line) => line.includes("Currently active canvas editor")) ??
    text.slice(0, 300)
  );
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isAllowedBrowserOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === "null") return true;
  try {
    const parsed = new URL(origin);
    return (
      parsed.protocol === "https:" &&
      (parsed.hostname === "figma.com" ||
        parsed.hostname.endsWith(".figma.com"))
    );
  } catch {
    return false;
  }
}

function applyCorsHeaders(
  response: import("node:http").ServerResponse,
  origin: string | undefined,
): void {
  if (origin !== undefined) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "Origin");
  }
  response.setHeader(
    "access-control-allow-headers",
    "content-type, x-pen-fig-token",
  );
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
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
