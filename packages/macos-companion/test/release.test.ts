import { describe, expect, it } from "vitest";
import {
  NODE_VERSION,
  nodeRuntimeRelease,
  parseArchitectures,
} from "../src/release.js";

describe("macOS companion releases", () => {
  it("pins verified Intel and Apple-silicon Node runtimes", () => {
    const intel = nodeRuntimeRelease("x64");
    const silicon = nodeRuntimeRelease("arm64");

    expect(intel.archiveName).toBe(`node-v${NODE_VERSION}-darwin-x64.tar.gz`);
    expect(silicon.archiveName).toBe(
      `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    );
    expect(intel.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(silicon.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("accepts individual and combined architecture builds", () => {
    expect(parseArchitectures("x64")).toEqual(["x64"]);
    expect(parseArchitectures("arm64")).toEqual(["arm64"]);
    expect(parseArchitectures("all")).toEqual(["x64", "arm64"]);
  });

  it("rejects unsupported architecture names", () => {
    expect(() => parseArchitectures("universal")).toThrow(
      "Use --arch=x64, --arch=arm64, or --arch=all.",
    );
  });
});
