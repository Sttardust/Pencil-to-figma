import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { PenNode } from "@pen-fig/core";

export interface PenAppStateSummary {
  text: string;
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

function extractText(result: CallToolResult): string {
  return result.content
    .filter(
      (item): item is Extract<typeof item, { type: "text" }> =>
        item.type === "text",
    )
    .map((item) => item.text)
    .join("\n");
}
