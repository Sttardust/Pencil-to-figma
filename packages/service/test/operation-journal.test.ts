import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OperationJournal } from "../src/operation-journal.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("operation journal", () => {
  it("stores operation identity and phases without design content", async () => {
    const journalPath = await temporaryJournalPath();
    const journal = new OperationJournal(journalPath);
    const operationId = await journal.begin("figma-export", ["pen:root"]);
    await journal.setPhase(operationId, "verifying");
    await journal.setPhase(operationId, "committing");
    await journal.complete(operationId);

    expect(await journal.entries()).toMatchObject([
      {
        id: operationId,
        kind: "figma-export",
        bridgeIds: ["pen:root"],
        phase: "completed",
      },
    ]);
    const contents = await readFile(journalPath, "utf8");
    expect(contents).not.toContain("characters");
    expect((await stat(journalPath)).mode & 0o777).toBe(0o600);
  });

  it("marks an interrupted write failed after restart", async () => {
    const journalPath = await temporaryJournalPath();
    const first = new OperationJournal(journalPath);
    const operationId = await first.begin("sync-to-pencil", ["pen:title"]);
    await first.setPhase(operationId, "verifying");

    const restarted = new OperationJournal(journalPath);
    await expect(restarted.recoverInterrupted()).resolves.toBe(1);
    expect(restarted.reconciliationRequired).toBe(true);
    expect(await restarted.entries()).toMatchObject([
      {
        id: operationId,
        phase: "failed",
        failureCode: "INTERRUPTED",
      },
    ]);

    await restarted.acknowledgeReconciliation();
    expect(restarted.reconciliationRequired).toBe(false);
  });
});

async function temporaryJournalPath(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pen-fig-journal-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "nested", "operation-journal.json");
}
