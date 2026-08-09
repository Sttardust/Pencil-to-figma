import { access } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 32145;

const PEN_APP_BUNDLES = ["Pen.app", "Pencil.app"] as const;
const PEN_MCP_DIRECTORY = path.join(
  "Contents",
  "Resources",
  "app.asar.unpacked",
  "out",
);

export interface ServiceConfig {
  host: string;
  port: number;
  penMcpPath: string;
  credentialPath?: string;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface PenMcpCandidateOptions {
  architecture?: NodeJS.Architecture;
  homeDirectory?: string;
}

/**
 * Return likely Pencil MCP executables in native-architecture order.
 *
 * Pencil publishes separate Intel and Apple-silicon macOS applications. We
 * still include the other architecture as a fallback because an Apple-silicon
 * Mac can intentionally run the Intel application through Rosetta.
 */
export function penMcpCandidates(
  options: PenMcpCandidateOptions = {},
): string[] {
  const architecture = options.architecture ?? process.arch;
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const architectureNames =
    architecture === "arm64"
      ? ["arm64", "universal", "x64"]
      : architecture === "x64"
        ? ["x64", "universal", "arm64"]
        : ["universal", "arm64", "x64"];
  const applicationRoots = [
    "/Applications",
    path.join(homeDirectory, "Applications"),
  ];

  return architectureNames.flatMap((architectureName) =>
    applicationRoots.flatMap((applicationRoot) =>
      PEN_APP_BUNDLES.map((bundleName) =>
        path.join(
          applicationRoot,
          bundleName,
          PEN_MCP_DIRECTORY,
          `mcp-server-darwin-${architectureName}`,
        ),
      ),
    ),
  );
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

  for (const candidate of penMcpCandidates()) {
    if (await isExecutable(candidate)) return candidate;
  }

  throw new Error(
    `Pencil MCP executable was not found for macOS ${process.arch}. Install Pencil in /Applications or ~/Applications, or set PEN_FIG_PEN_MCP_PATH.`,
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
    ...(process.env.PEN_FIG_CREDENTIAL_PATH
      ? { credentialPath: process.env.PEN_FIG_CREDENTIAL_PATH }
      : {}),
  };
}
