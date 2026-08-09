import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

const credentialSchema = z.object({
  version: z.literal(1),
  reconnectToken: z.string().uuid(),
});

export function defaultCredentialPath(): string {
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "Pencil Figma Bridge",
    "credentials.json",
  );
}

export async function loadOrCreateReconnectToken(
  credentialPath = defaultCredentialPath(),
): Promise<string> {
  try {
    const parsed = credentialSchema.parse(
      JSON.parse(await readFile(credentialPath, "utf8")),
    );
    return parsed.reconnectToken;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  const reconnectToken = randomUUID();
  await mkdir(path.dirname(credentialPath), { recursive: true, mode: 0o700 });
  try {
    await writeFile(
      credentialPath,
      `${JSON.stringify({ version: 1, reconnectToken }, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    return reconnectToken;
  } catch (error) {
    if (!isExistingFile(error)) throw error;
    const parsed = credentialSchema.parse(
      JSON.parse(await readFile(credentialPath, "utf8")),
    );
    return parsed.reconnectToken;
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT",
  );
}

function isExistingFile(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "EEXIST",
  );
}
