import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BridgeManifest } from "@pen-fig/bridge-schema";
import { ManifestRepository } from "../src/manifest/repository.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ManifestRepository", () => {
  it("atomically writes and reads a canonical manifest", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "pen-fig-manifest-"),
    );
    temporaryDirectories.push(directory);
    const manifestPath = path.join(directory, "orchid.pen-fig.json");
    const repository = new ManifestRepository();
    const manifest: BridgeManifest = {
      version: 1,
      penDocumentId: "/design/orchid.pen",
      revision: 1,
      updatedAt: "2026-08-08T00:00:00.000Z",
      mappings: [
        {
          bridgeId: "pen:root",
          penNodeId: "root",
          figmaNodeId: "1:2",
          baselineHash: "b".repeat(64),
        },
      ],
    };

    await repository.writeAtomic(manifestPath, manifest);

    expect(await repository.read(manifestPath)).toEqual(manifest);
    expect((await readFile(manifestPath, "utf8")).endsWith("\n")).toBe(true);
    expect(await readdir(directory)).toEqual(["orchid.pen-fig.json"]);
  });

  it("returns undefined when no sidecar exists", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "pen-fig-manifest-"),
    );
    temporaryDirectories.push(directory);
    const repository = new ManifestRepository();
    expect(
      await repository.read(path.join(directory, "missing.json")),
    ).toBeUndefined();
  });
});
