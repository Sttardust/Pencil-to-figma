import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOrCreateReconnectToken } from "../src/credentials.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("persistent reconnect credentials", () => {
  it("creates one private token and reuses it after restart", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pen-fig-auth-"));
    temporaryDirectories.push(directory);
    const credentialPath = path.join(directory, "nested", "credentials.json");

    const first = await loadOrCreateReconnectToken(credentialPath);
    const second = await loadOrCreateReconnectToken(credentialPath);

    expect(second).toBe(first);
    expect(JSON.parse(await readFile(credentialPath, "utf8"))).toMatchObject({
      version: 1,
      reconnectToken: first,
    });
    expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
  });
});
