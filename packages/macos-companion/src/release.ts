import { COMPANION_VERSION } from "@pen-fig/bridge-schema/version";

export { COMPANION_VERSION };
export const COMPANION_BUILD = "16";
export const NODE_VERSION = "24.19.0";

export type MacArchitecture = "x64" | "arm64";

export interface NodeRuntimeRelease {
  architecture: MacArchitecture;
  archiveName: string;
  sha256: string;
  url: string;
}

const NODE_SHA256: Record<MacArchitecture, string> = {
  x64: "d1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316",
  arm64: "8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d",
};

export function nodeRuntimeRelease(
  architecture: MacArchitecture,
): NodeRuntimeRelease {
  const archiveName = `node-v${NODE_VERSION}-darwin-${architecture}.tar.gz`;
  return {
    architecture,
    archiveName,
    sha256: NODE_SHA256[architecture],
    url: `https://nodejs.org/dist/v${NODE_VERSION}/${archiveName}`,
  };
}

export function parseArchitectures(
  value: string | undefined,
): MacArchitecture[] {
  if (!value) {
    if (process.arch === "x64" || process.arch === "arm64") {
      return [process.arch];
    }
    throw new Error(`Unsupported macOS build architecture: ${process.arch}`);
  }
  if (value === "all") return ["x64", "arm64"];
  if (value === "x64" || value === "arm64") return [value];
  throw new Error("Use --arch=x64, --arch=arm64, or --arch=all.");
}
