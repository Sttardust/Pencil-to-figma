import { describe, expect, it } from "vitest";
import { importPenDocument } from "@pen-fig/core";
import {
  sumExportPlanCounts,
  validateFigmaExportBatch,
} from "../src/figma/batch.js";
import type { FigmaReadResult } from "../src/figma/read.js";

function result(id: string, name: string, nodeCount = 1): FigmaReadResult {
  const document = importPenDocument(
    { id, type: "frame", name, children: [] },
    { documentId: "figma-file" },
  );
  return { document, nodeCount, fonts: [], assetData: {} };
}

describe("multi-screen Figma export", () => {
  it("accepts independent screens and combines their plan counts", () => {
    expect(() =>
      validateFigmaExportBatch([
        result("welcome", "Welcome"),
        result("profile", "Profile"),
      ]),
    ).not.toThrow();
    expect(
      sumExportPlanCounts([
        { assets: 2, inserts: 10, finalizes: 1 },
        { assets: 3, inserts: 12, finalizes: 1 },
      ]),
    ).toEqual({ assets: 5, inserts: 22, finalizes: 2 });
  });

  it("rejects copied bridge identities across selected screens", () => {
    expect(() =>
      validateFigmaExportBatch([
        result("same", "First copy"),
        result("same", "Second copy"),
      ]),
    ).toThrow("share copied bridge identities");
  });

  it("limits the total editable layer count", () => {
    expect(() =>
      validateFigmaExportBatch([
        result("first", "First", 3_000),
        result("second", "Second", 2_001),
      ]),
    ).toThrow("5,000 layers or fewer");
  });

  it("limits total image bytes across the batch", () => {
    const results = [
      result("first", "First"),
      result("second", "Second"),
      result("third", "Third"),
    ];
    for (const [resultIndex, item] of results.entries())
      for (let assetIndex = 0; assetIndex < 3; assetIndex += 1)
        item.assetData[`image-${resultIndex}-${assetIndex}`] = {
          base64: "",
          mimeType: "image/png",
          byteLength: 8 * 1024 * 1024,
        };

    expect(() => validateFigmaExportBatch(results)).toThrow("more than 64 MiB");
  });

  it("matches the companion's per-image size limit", () => {
    const screen = result("screen", "Photo screen");
    screen.assetData.image = {
      base64: "",
      mimeType: "image/png",
      byteLength: 10 * 1024 * 1024 + 1,
    };

    expect(() => validateFigmaExportBatch([screen])).toThrow(
      "image larger than 10 MiB",
    );
  });
});
