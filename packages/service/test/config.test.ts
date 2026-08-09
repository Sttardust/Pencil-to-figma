import path from "node:path";
import { describe, expect, it } from "vitest";
import { penMcpCandidates } from "../src/config.js";

describe("macOS Pencil MCP discovery", () => {
  it("prefers the Apple-silicon executable on arm64 Macs", () => {
    const candidates = penMcpCandidates({
      architecture: "arm64",
      homeDirectory: "/Users/example",
    });

    expect(candidates[0]).toBe(
      "/Applications/Pen.app/Contents/Resources/app.asar.unpacked/out/mcp-server-darwin-arm64",
    );
    expect(candidates).toContain(
      "/Applications/Pen.app/Contents/Resources/app.asar.unpacked/out/mcp-server-darwin-x64",
    );
  });

  it("prefers the Intel executable on x64 Macs", () => {
    const candidates = penMcpCandidates({
      architecture: "x64",
      homeDirectory: "/Users/example",
    });

    expect(candidates[0]).toBe(
      "/Applications/Pen.app/Contents/Resources/app.asar.unpacked/out/mcp-server-darwin-x64",
    );
  });

  it("also searches user applications and the alternate bundle name", () => {
    const candidates = penMcpCandidates({
      architecture: "arm64",
      homeDirectory: "/Users/example",
    });

    expect(candidates).toContain(
      path.join(
        "/Users/example",
        "Applications",
        "Pencil.app",
        "Contents",
        "Resources",
        "app.asar.unpacked",
        "out",
        "mcp-server-darwin-arm64",
      ),
    );
  });
});
