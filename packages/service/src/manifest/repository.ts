import { open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import {
  bridgeManifestSchema,
  canonicalStringify,
  type BridgeManifest,
} from "@pen-fig/bridge-schema";

export class ManifestRepository {
  async read(manifestPath: string): Promise<BridgeManifest | undefined> {
    try {
      return bridgeManifestSchema.parse(
        JSON.parse(await readFile(manifestPath, "utf8")),
      );
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async writeAtomic(
    manifestPath: string,
    manifest: BridgeManifest,
  ): Promise<void> {
    const validated = bridgeManifestSchema.parse(manifest);
    const temporaryPath = `${manifestPath}.tmp-${process.pid}-${Date.now()}`;
    const contents = `${canonicalStringify(validated)}\n`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, manifestPath);
      const directory = await open(path.dirname(manifestPath), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
