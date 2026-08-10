import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { PenNode } from "@pen-fig/core";

export interface PenAppStateSummary {
  text: string;
}

export interface PenBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PenPosition {
  x: number;
  y: number;
}

export class PenMcpClient {
  readonly #executablePath: string;
  #client: Client | undefined;
  #transport: StdioClientTransport | undefined;

  constructor(executablePath: string) {
    this.#executablePath = executablePath;
  }

  async connect(): Promise<void> {
    if (this.#client && this.#transport) return;
    const client = new Client({ name: "pen-fig-bridge", version: "0.0.0" });
    const transport = new StdioClientTransport({
      command: this.#executablePath,
      args: ["--app", "desktop"],
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      this.#client = client;
      this.#transport = transport;
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
  }

  async getAppState(): Promise<PenAppStateSummary> {
    const result = await this.#callWithReconnect(
      "get_app_state",
      {
        include_schema: false,
        include_canvas_design: false,
        include_scripts_and_shaders: false,
        include_browser: false,
      },
      15_000,
    );
    return { text: extractText(result) };
  }

  async listRootFrames(limit = 20): Promise<string> {
    const result = await this.#callWithReconnect(
      "execute",
      {
        input: `let count=0; Get((n,c)=>{c.skipChildren();if(n.type==="frame"&&!n.reusable&&count<${Math.max(1, Math.min(limit, 100))}){Print(n.id,"|",n.name||"");count++}})`,
      },
      30_000,
    );
    return extractText(result);
  }

  async listSelectedRootFrames(limit = 50): Promise<string> {
    const selectedIds = selectedNodeIdsFromAppState(
      (await this.getAppState()).text,
    );
    if (!selectedIds.length) return "";
    if (selectedIds.length > 200)
      throw new Error("Select fewer Pencil layers before reading the pages");
    const selected = JSON.stringify(selectedIds);
    const result = await this.#callWithReconnect(
      "execute",
      {
        input: `const selected=new Set(${selected});let count=0;Get((n,c)=>{c.skipChildren();if(selected.has(n.id)&&n.type==="frame"&&!n.reusable&&count<${limit + 1}){Print(n.id,"|",n.name||"");count++}})`,
      },
      30_000,
    );
    const text = extractText(result);
    const pageCount = [...text.matchAll(/^[A-Za-z0-9]+\s+\|\s+.+$/gm)].length;
    if (pageCount > limit)
      throw new Error(`Select no more than ${limit} Pencil pages at once`);
    return text;
  }

  async searchRootFrames(query: string, limit = 30): Promise<string> {
    const normalized = query.trim();
    if (!normalized || normalized.length > 100)
      throw new Error("Screen search must be 1–100 characters");
    const needle = JSON.stringify(normalized.toLowerCase());
    const result = await this.#callWithReconnect(
      "execute",
      {
        input: `let count=0;Get((n,c)=>{c.skipChildren();if(n.type==="frame"&&!n.reusable&&count<${Math.max(1, Math.min(limit, 100))}&&(n.name||"").toLowerCase().includes(${needle})){Print(n.id,"|",n.name||"");count++}})`,
      },
      30_000,
    );
    return extractText(result);
  }

  async getNode(nodeId: string): Promise<PenNode> {
    if (!/^[A-Za-z0-9]+$/.test(nodeId))
      throw new Error(`Invalid Pen node id '${nodeId}'`);
    const result = await this.#callWithReconnect(
      "execute",
      { input: `Print(Get("${nodeId}",{includePathGeometry:true}))` },
      60_000,
    );
    const text = extractText(result);
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start)
      throw new Error(`Pen node ${nodeId} returned no JSON`);
    const node = JSON.parse(text.slice(start, end + 1)) as PenNode;
    if (node.id !== nodeId)
      throw new Error(`Pen returned node ${node.id} for requested ${nodeId}`);
    return node;
  }

  async getTopLevelBounds(nodeId: string): Promise<PenBounds | undefined> {
    if (!/^[A-Za-z0-9]+$/.test(nodeId))
      throw new Error(`Invalid Pen node id '${nodeId}'`);
    const result = await this.#callWithReconnect(
      "execute",
      {
        input: `Get((n,c)=>{c.skipChildren();if(n.id===${JSON.stringify(nodeId)}){Print("BOUNDS","|",c.bounds.x,"|",c.bounds.y,"|",c.bounds.width,"|",c.bounds.height)}})`,
      },
      30_000,
    );
    const match =
      /BOUNDS\s*\|\s*(-?[\d.]+)\s*\|\s*(-?[\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/.exec(
        extractText(result),
      );
    if (!match) return undefined;
    const values = match.slice(1).map(Number);
    if (values.some((value) => !Number.isFinite(value))) return undefined;
    return {
      x: values[0]!,
      y: values[1]!,
      width: values[2]!,
      height: values[3]!,
    };
  }

  async findEmptySpace(
    width: number,
    height: number,
    anchorId?: string,
    padding = 120,
  ): Promise<PenPosition> {
    if (
      !Number.isFinite(width) ||
      width <= 0 ||
      !Number.isFinite(height) ||
      height <= 0 ||
      !Number.isFinite(padding) ||
      padding < 0
    )
      throw new Error("Invalid Pencil empty-space dimensions");
    if (anchorId && !/^[A-Za-z0-9]+$/.test(anchorId))
      throw new Error(`Invalid Pen node id '${anchorId}'`);
    const options = {
      width,
      height,
      direction: "right",
      padding,
      ...(anchorId ? { nodeId: anchorId } : {}),
    };
    const result = await this.#callWithReconnect(
      "execute",
      {
        input: `const p=FindEmptySpace(${JSON.stringify(options)});Print("EMPTY","|",p.x,"|",p.y)`,
      },
      30_000,
    );
    const match = /EMPTY\s*\|\s*(-?[\d.]+)\s*\|\s*(-?[\d.]+)/.exec(
      extractText(result),
    );
    if (!match) throw new Error("Pencil returned no empty-space position");
    const x = Number(match[1]);
    const y = Number(match[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y))
      throw new Error("Pencil returned an invalid empty-space position");
    return { x, y };
  }

  async findExportRoot(transferId: string): Promise<string | undefined> {
    const result = await this.#callWithReconnect(
      "execute",
      {
        input: `Get((n,c)=>{c.skipChildren();if(n.metadata?.type==="pen-fig-export"&&n.metadata?.transferId===${JSON.stringify(transferId)}){Print("EXPORT_ROOT","|",n.id)}})`,
      },
      30_000,
    );
    return /EXPORT_ROOT\s*\|\s*([A-Za-z0-9]+)/.exec(extractText(result))?.[1];
  }

  async executeWrite(input: string, timeout = 60_000): Promise<string> {
    try {
      await this.connect();
      const result = (await this.#client!.callTool(
        { name: "execute", arguments: { input } },
        undefined,
        { timeout },
      )) as CallToolResult;
      if (result.isError)
        throw new Error(extractText(result) || "Pen execute failed");
      return extractText(result);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    const transport = this.#transport;
    this.#client = undefined;
    this.#transport = undefined;
    await transport?.close().catch(() => undefined);
  }

  async #callWithReconnect(
    name: string,
    args: Record<string, unknown>,
    timeout: number,
  ): Promise<CallToolResult> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.connect();
        const result = (await this.#client!.callTool(
          { name, arguments: args },
          undefined,
          { timeout },
        )) as CallToolResult;
        if (result.isError)
          throw new Error(extractText(result) || `Pen ${name} failed`);
        return result;
      } catch (error) {
        lastError = error;
        await this.close();
      }
    }
    throw lastError;
  }
}

export function selectedNodeIdsFromAppState(text: string): string[] {
  const selection = /^-\s*Selected nodes:\s*(.*)$/im.exec(text)?.[1]?.trim();
  if (!selection || /no nodes are selected/i.test(selection)) return [];
  return [
    ...new Set(
      [...selection.matchAll(/`([A-Za-z0-9]+)`/g)].map((match) => match[1]!),
    ),
  ];
}

function extractText(result: CallToolResult): string {
  return result.content
    .filter(
      (item): item is Extract<typeof item, { type: "text" }> =>
        item.type === "text",
    )
    .map((item) => item.text)
    .join("\n");
}
