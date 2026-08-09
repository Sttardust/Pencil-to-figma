import { execFile } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { renderLaunchAgent } from "../packages/service/src/macos-launch-agent.js";

const run = promisify(execFile);
const action = process.argv[2];
const label = "com.sttardust.pencil-figma-bridge";
const repositoryPath = path.resolve(import.meta.dirname, "..");
const launchAgentsPath = path.join(os.homedir(), "Library", "LaunchAgents");
const plistPath = path.join(launchAgentsPath, `${label}.plist`);
const logsPath = path.join(
  os.homedir(),
  "Library",
  "Logs",
  "Pencil Figma Bridge",
);
const domain = `gui/${process.getuid?.() ?? 501}`;
const serviceTarget = `${domain}/${label}`;

if (process.platform !== "darwin")
  throw new Error(
    "The background bridge installer currently supports macOS only.",
  );

if (action === "install") await install();
else if (action === "uninstall") await uninstall();
else throw new Error("Use 'install' or 'uninstall'.");

async function install(): Promise<void> {
  const tsxCliPath = path.join(
    repositoryPath,
    "node_modules",
    "tsx",
    "dist",
    "cli.mjs",
  );
  const serviceEntryPath = path.join(
    repositoryPath,
    "packages",
    "service",
    "src",
    "main.ts",
  );
  await Promise.all([access(tsxCliPath), access(serviceEntryPath)]);
  await mkdir(launchAgentsPath, { recursive: true });
  await mkdir(logsPath, { recursive: true });
  await bootout();
  const plist = renderLaunchAgent({
    label,
    repositoryPath,
    nodePath: process.execPath,
    tsxCliPath,
    serviceEntryPath,
    stdoutPath: path.join(logsPath, "service.log"),
    stderrPath: path.join(logsPath, "service-error.log"),
  });
  await writeFile(plistPath, plist, { encoding: "utf8", mode: 0o600 });
  await bootstrap();
  await run("launchctl", ["kickstart", "-k", serviceTarget]);
  await waitForBridge();
  console.log("Pencil ↔ Figma background bridge installed and started.");
  console.log(`Logs: ${logsPath}`);
}

async function uninstall(): Promise<void> {
  await bootout();
  await rm(plistPath, { force: true });
  console.log("Pencil ↔ Figma background bridge removed.");
}

async function bootout(): Promise<void> {
  try {
    await run("launchctl", ["bootout", serviceTarget]);
  } catch {
    // It is safe to continue when the service is not installed or loaded.
  }
}

async function bootstrap(): Promise<void> {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await run("launchctl", ["bootstrap", domain, plistPath]);
      return;
    } catch (error) {
      if (!isLaunchdBusy(error) || attempt === 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
}

function isLaunchdBusy(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && error.code === 5,
  );
}

async function waitForBridge(): Promise<void> {
  const healthUrl = "http://127.0.0.1:32145/health";
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(750),
      });
      if (response.ok) return;
    } catch {
      // launchd may need a few seconds to start Node and the TypeScript loader.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `The background bridge did not become ready. Check ${path.join(logsPath, "service-error.log")}.`,
  );
}
