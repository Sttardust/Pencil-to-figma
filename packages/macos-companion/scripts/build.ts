import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import {
  COMPANION_BUILD,
  COMPANION_VERSION,
  nodeRuntimeRelease,
  parseArchitectures,
  type MacArchitecture,
} from "../src/release.js";

const run = promisify(execFile);
const repositoryPath = path.resolve(import.meta.dirname, "../../..");
const packagePath = path.resolve(import.meta.dirname, "..");
const outputRoot = path.join(repositoryPath, "dist", "macos");
const cachePath = path.join(outputRoot, ".cache");
const architectureArgument = process.argv
  .find((argument) => argument.startsWith("--arch="))
  ?.slice("--arch=".length);
const architectures = parseArchitectures(architectureArgument);
const signingIdentity = process.env.APPLE_SIGN_IDENTITY?.trim() || "-";
const notaryProfile = process.env.APPLE_NOTARY_PROFILE?.trim();

if (process.platform !== "darwin") {
  throw new Error("The macOS companion can only be built on macOS.");
}

await mkdir(cachePath, { recursive: true });
for (const architecture of architectures) await buildApp(architecture);

async function buildApp(architecture: MacArchitecture): Promise<void> {
  const targetPath = path.join(outputRoot, architecture);
  const appPath = path.join(targetPath, "Pencil Figma Bridge.app");
  const contentsPath = path.join(appPath, "Contents");
  const macOSPath = path.join(contentsPath, "MacOS");
  const resourcesPath = path.join(contentsPath, "Resources");
  const runtimePath = path.join(resourcesPath, "runtime");
  const servicePath = path.join(resourcesPath, "service");
  const launcherPath = path.join(macOSPath, "Pencil Figma Bridge");
  const nodePath = path.join(runtimePath, "node");
  const serviceEntryPath = path.join(servicePath, "main.mjs");

  await rm(targetPath, { recursive: true, force: true });
  await Promise.all([
    mkdir(macOSPath, { recursive: true }),
    mkdir(runtimePath, { recursive: true }),
    mkdir(servicePath, { recursive: true }),
  ]);

  await Promise.all([
    bundleService(serviceEntryPath),
    compileLauncher(architecture, launcherPath),
    installNodeRuntime(architecture, nodePath),
    writeFile(path.join(contentsPath, "Info.plist"), infoPlist(architecture)),
    writeFile(path.join(contentsPath, "PkgInfo"), "APPL????"),
  ]);

  await signBundle(appPath, launcherPath, nodePath);
  await run("codesign", ["--verify", "--deep", "--strict", appPath]);
  const archivePath = path.join(
    targetPath,
    `Pencil-Figma-Bridge-${COMPANION_VERSION}-macOS-${architecture}.zip`,
  );
  await run("ditto", ["-c", "-k", "--keepParent", appPath, archivePath]);
  if (notaryProfile) {
    if (signingIdentity === "-") {
      throw new Error(
        "APPLE_NOTARY_PROFILE requires an APPLE_SIGN_IDENTITY release signature.",
      );
    }
    await run("xcrun", [
      "notarytool",
      "submit",
      archivePath,
      "--keychain-profile",
      notaryProfile,
      "--wait",
    ]);
    await run("xcrun", ["stapler", "staple", appPath]);
    await rm(archivePath, { force: true });
    await run("ditto", ["-c", "-k", "--keepParent", appPath, archivePath]);
  }
  const archiveChecksum = sha256(await readFile(archivePath));
  await writeFile(
    `${archivePath}.sha256`,
    `${archiveChecksum}  ${path.basename(archivePath)}\n`,
  );
  console.log(`Built ${appPath}`);
  console.log(`Archive ${archivePath}`);
  console.log(`SHA-256 ${archiveChecksum}`);
}

async function bundleService(outfile: string): Promise<void> {
  await build({
    entryPoints: [
      path.join(repositoryPath, "packages", "service", "src", "main.ts"),
    ],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    sourcemap: false,
    minify: false,
    logLevel: "warning",
    banner: {
      js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
    },
  });
}

async function compileLauncher(
  architecture: MacArchitecture,
  outfile: string,
): Promise<void> {
  const target = `${architecture === "x64" ? "x86_64" : "arm64"}-apple-macos12.0`;
  await run("xcrun", [
    "swiftc",
    path.join(packagePath, "native", "main.swift"),
    "-parse-as-library",
    "-O",
    "-target",
    target,
    "-framework",
    "AppKit",
    "-o",
    outfile,
  ]);
}

async function installNodeRuntime(
  architecture: MacArchitecture,
  destination: string,
): Promise<void> {
  const release = nodeRuntimeRelease(architecture);
  const archivePath = path.join(cachePath, release.archiveName);
  let archive: Buffer | undefined;
  try {
    archive = await readFile(archivePath);
  } catch {
    // The verified download below will populate the build cache.
  }
  if (!archive || sha256(archive) !== release.sha256) {
    const response = await fetch(release.url);
    if (!response.ok) {
      throw new Error(
        `Could not download ${release.url}: HTTP ${response.status}`,
      );
    }
    archive = Buffer.from(await response.arrayBuffer());
    if (sha256(archive) !== release.sha256) {
      throw new Error(`Checksum mismatch for ${release.archiveName}`);
    }
    await writeFile(archivePath, archive);
  }

  const temporaryPath = await mkdtemp(
    path.join(os.tmpdir(), "pencil-figma-node-"),
  );
  try {
    await run("tar", ["-xzf", archivePath, "-C", temporaryPath]);
    const extractedNode = path.join(
      temporaryPath,
      release.archiveName.replace(".tar.gz", ""),
      "bin",
      "node",
    );
    await copyFile(extractedNode, destination);
    await chmod(destination, 0o755);
  } finally {
    await rm(temporaryPath, { recursive: true, force: true });
  }
}

async function signBundle(
  appPath: string,
  launcherPath: string,
  nodePath: string,
): Promise<void> {
  const signedRelease = signingIdentity !== "-";
  const common = ["--force", "--sign", signingIdentity];
  if (signedRelease) common.push("--options", "runtime", "--timestamp");
  await run("codesign", [...common, nodePath]);
  await run("codesign", [...common, launcherPath]);
  await run("codesign", [...common, appPath]);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function infoPlist(architecture: MacArchitecture): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>Pencil Figma Bridge</string>
  <key>CFBundleExecutable</key>
  <string>Pencil Figma Bridge</string>
  <key>CFBundleIdentifier</key>
  <string>com.sttardust.PencilFigmaBridge</string>
  <key>CFBundleName</key>
  <string>Pencil Figma Bridge</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${COMPANION_VERSION}</string>
  <key>CFBundleVersion</key>
  <string>${COMPANION_BUILD}</string>
  <key>LSArchitecturePriority</key>
  <array>
    <string>${architecture === "x64" ? "x86_64" : "arm64"}</string>
  </array>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;
}
