import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

const operationPhaseSchema = z.enum([
  "writing",
  "verifying",
  "committing",
  "completed",
  "failed",
]);

const operationEntrySchema = z.object({
  id: z.string().uuid(),
  kind: z.string().min(1).max(80),
  bridgeIds: z.array(z.string().min(1).max(200)).max(200),
  phase: operationPhaseSchema,
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  failureCode: z.string().min(1).max(80).optional(),
});

const operationJournalSchema = z.object({
  version: z.literal(1),
  reconciliationRequired: z.boolean(),
  entries: z.array(operationEntrySchema).max(100),
});

export type OperationPhase = z.infer<typeof operationPhaseSchema>;
export type OperationEntry = z.infer<typeof operationEntrySchema>;

interface OperationJournalState {
  version: 1;
  reconciliationRequired: boolean;
  entries: OperationEntry[];
}

export function defaultOperationJournalPath(): string {
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "Pencil Figma Bridge",
    "operation-journal.json",
  );
}

export class OperationJournal {
  readonly #journalPath: string;
  #state: OperationJournalState | undefined;
  #queue: Promise<void> = Promise.resolve();

  constructor(journalPath = defaultOperationJournalPath()) {
    this.#journalPath = journalPath;
  }

  get reconciliationRequired(): boolean {
    return this.#state?.reconciliationRequired ?? false;
  }

  async recoverInterrupted(): Promise<number> {
    return this.#serialize(async () => {
      const state = await this.#load();
      const now = new Date().toISOString();
      let recovered = 0;
      for (const entry of state.entries) {
        if (!isActivePhase(entry.phase)) continue;
        entry.phase = "failed";
        entry.failureCode = "INTERRUPTED";
        entry.updatedAt = now;
        recovered += 1;
      }
      if (recovered) {
        state.reconciliationRequired = true;
        await this.#write(state);
      }
      return recovered;
    });
  }

  async begin(kind: string, bridgeIds: string[]): Promise<string> {
    return this.#serialize(async () => {
      const state = await this.#load();
      const now = new Date().toISOString();
      const entry = operationEntrySchema.parse({
        id: randomUUID(),
        kind,
        bridgeIds: [...new Set(bridgeIds)],
        phase: "writing",
        startedAt: now,
        updatedAt: now,
      });
      state.entries.push(entry);
      state.entries = state.entries.slice(-100);
      await this.#write(state);
      return entry.id;
    });
  }

  async setPhase(
    operationId: string,
    phase: "verifying" | "committing",
  ): Promise<void> {
    await this.#update(operationId, (entry) => {
      entry.phase = phase;
      delete entry.failureCode;
    });
  }

  async complete(operationId: string): Promise<void> {
    await this.#update(operationId, (entry) => {
      entry.phase = "completed";
      delete entry.failureCode;
    });
  }

  async fail(operationId: string, failureCode: string): Promise<void> {
    await this.#update(operationId, (entry) => {
      entry.phase = "failed";
      entry.failureCode = failureCode;
    });
  }

  async acknowledgeReconciliation(): Promise<void> {
    await this.#serialize(async () => {
      const state = await this.#load();
      if (!state.reconciliationRequired) return;
      state.reconciliationRequired = false;
      await this.#write(state);
    });
  }

  async entries(): Promise<OperationEntry[]> {
    return this.#serialize(async () =>
      structuredClone((await this.#load()).entries),
    );
  }

  async #update(
    operationId: string,
    update: (entry: OperationEntry) => void,
  ): Promise<void> {
    await this.#serialize(async () => {
      const state = await this.#load();
      const entry = state.entries.find(({ id }) => id === operationId);
      if (!entry) throw new Error("Operation journal entry is missing");
      update(entry);
      entry.updatedAt = new Date().toISOString();
      await this.#write(state);
    });
  }

  async #load(): Promise<OperationJournalState> {
    if (this.#state) return this.#state;
    try {
      this.#state = operationJournalSchema.parse(
        JSON.parse(await readFile(this.#journalPath, "utf8")),
      );
    } catch (error) {
      if (!isMissing(error)) throw error;
      this.#state = {
        version: 1,
        reconciliationRequired: false,
        entries: [],
      };
    }
    return this.#state;
  }

  async #write(state: OperationJournalState): Promise<void> {
    const validated = operationJournalSchema.parse(state);
    const directoryPath = path.dirname(this.#journalPath);
    const temporaryPath = `${this.#journalPath}.tmp-${process.pid}-${Date.now()}`;
    await mkdir(directoryPath, { recursive: true, mode: 0o700 });
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.#journalPath);
      const directory = await open(directoryPath, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      this.#state = validated;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function isActivePhase(phase: OperationPhase): boolean {
  return phase === "writing" || phase === "verifying" || phase === "committing";
}

function isMissing(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT",
  );
}
