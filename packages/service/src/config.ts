import { access } from "node:fs/promises";
import { constants } from "node:fs";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 32145;

const PEN_MCP_CANDIDATES = [
  "/Applications/Pen.app/Contents/Resources/app.asar.unpacked/out/mcp-server-darwin-x64",
] as const;

export interface ServiceConfig {
  host: string;
  port: number;
  penMcpPath: string;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolvePenMcpPath(
  explicitPath = process.env.PEN_FIG_PEN_MCP_PATH,
): Promise<string> {
  if (explicitPath) {
    if (!(await isExecutable(explicitPath))) {
      throw new Error(
        `PEN_FIG_PEN_MCP_PATH is not executable: ${explicitPath}`,
      );
    }
    return explicitPath;
  }

  for (const candidate of PEN_MCP_CANDIDATES) {
    if (await isExecutable(candidate)) return candidate;
  }

  throw new Error(
    "Pen MCP executable was not found. Install Pen or set PEN_FIG_PEN_MCP_PATH.",
  );
}

export async function loadServiceConfig(): Promise<ServiceConfig> {
  const portValue = process.env.PEN_FIG_PORT;
  const port = portValue ? Number(portValue) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`Invalid PEN_FIG_PORT: ${portValue}`);
  }

  return {
    host: DEFAULT_HOST,
    port,
    penMcpPath: await resolvePenMcpPath(),
  };
}
