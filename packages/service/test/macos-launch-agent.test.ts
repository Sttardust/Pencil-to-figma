import { describe, expect, it } from "vitest";
import { renderLaunchAgent } from "../src/macos-launch-agent.js";

describe("macOS background bridge configuration", () => {
  it("starts the loopback service at login and escapes paths", () => {
    const plist = renderLaunchAgent({
      label: "com.example.pen-fig",
      repositoryPath: "/tmp/Pencil & Figma",
      nodePath: "/usr/local/bin/node",
      tsxCliPath: "/tmp/node_modules/tsx/dist/cli.mjs",
      serviceEntryPath: "/tmp/packages/service/src/main.ts",
      stdoutPath: "/tmp/service.log",
      stderrPath: "/tmp/service-error.log",
    });

    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).toContain("/tmp/Pencil &amp; Figma");
    expect(plist).toContain("/usr/local/bin/node");
  });
});
