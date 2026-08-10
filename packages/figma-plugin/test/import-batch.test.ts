import { describe, expect, it } from "vitest";
import { importPenDocument, type PenNode } from "@pen-fig/core";
import { validatePencilImportBatch } from "../src/figma/batch.js";

function document(id: string, name: string, children: PenNode[] = []) {
  return importPenDocument(
    { id, type: "frame", name, children },
    { documentId: "selected.pen" },
  );
}

describe("multi-page Pencil import", () => {
  it("accepts distinct pages and counts their editable nodes", () => {
    const summary = validatePencilImportBatch([
      document("welcome", "Welcome", [
        { id: "title", type: "text", content: "Welcome" },
      ]),
      document("profile", "Profile"),
    ]);

    expect(summary.documents).toHaveLength(2);
    expect(summary.nodeCount).toBe(3);
  });

  it("rejects a selection containing the same page twice", () => {
    expect(() =>
      validatePencilImportBatch([
        document("welcome", "Welcome"),
        document("welcome", "Welcome copy"),
      ]),
    ).toThrow("Select each page once");
  });

  it("limits a Pencil selection to twelve pages", () => {
    expect(() =>
      validatePencilImportBatch(
        Array.from({ length: 13 }, (_, index) =>
          document(`page-${index}`, `Page ${index + 1}`),
        ),
      ),
    ).toThrow("no more than 12 Pencil pages");
  });

  it("limits total ready image bytes across the batch", () => {
    const first = document("first", "First");
    const second = document("second", "Second");
    first.assets.push({
      status: "ready",
      id: "asset:first",
      kind: "image",
      mimeType: "image/png",
      sha256: "a".repeat(64),
      byteLength: 33 * 1024 * 1024,
    });
    second.assets.push({
      status: "ready",
      id: "asset:second",
      kind: "image",
      mimeType: "image/png",
      sha256: "b".repeat(64),
      byteLength: 32 * 1024 * 1024,
    });

    expect(() => validatePencilImportBatch([first, second])).toThrow(
      "more than 64 MiB",
    );
  });
});
