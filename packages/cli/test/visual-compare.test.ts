import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import {
  comparePngBuffers,
  ImageDimensionMismatchError,
} from "../src/visual/compare.js";
import { parseVisualCompareArguments } from "../src/commands/visual-compare.js";

function png(
  width: number,
  height: number,
  color: [number, number, number, number],
): Buffer {
  const image = new PNG({ width, height });
  for (let offset = 0; offset < image.data.length; offset += 4) {
    image.data[offset] = color[0];
    image.data[offset + 1] = color[1];
    image.data[offset + 2] = color[2];
    image.data[offset + 3] = color[3];
  }
  return PNG.sync.write(image);
}

describe("visual PNG comparison", () => {
  it("passes identical renders", () => {
    const image = png(4, 4, [24, 30, 36, 255]);
    const comparison = comparePngBuffers(image, image);

    expect(comparison.report).toMatchObject({
      passed: true,
      mismatchedPixels: 0,
      mismatchRatio: 0,
      meanAbsoluteError: 0,
    });
    expect(() => PNG.sync.read(comparison.diffPng)).not.toThrow();
  });

  it("fails a broad low-contrast color shift through mean error", () => {
    const reference = png(10, 10, [100, 100, 100, 255]);
    const candidate = png(10, 10, [110, 110, 110, 255]);
    const comparison = comparePngBuffers(reference, candidate, {
      pixelThreshold: 0.1,
      maxMismatchRatio: 1,
      maxMeanError: 0.01,
    });

    expect(comparison.report.mismatchRatio).toBe(0);
    expect(comparison.report.meanAbsoluteError).toBeGreaterThan(0.01);
    expect(comparison.report.passed).toBe(false);
  });

  it("fails a localized high-contrast layout difference", () => {
    const reference = PNG.sync.read(png(10, 10, [255, 255, 255, 255]));
    const candidate = PNG.sync.read(png(10, 10, [255, 255, 255, 255]));
    for (let offset = 0; offset < 12 * 4; offset += 4) {
      candidate.data[offset] = 0;
      candidate.data[offset + 1] = 0;
      candidate.data[offset + 2] = 0;
    }
    const comparison = comparePngBuffers(
      PNG.sync.write(reference),
      PNG.sync.write(candidate),
      {
        pixelThreshold: 0.1,
        maxMismatchRatio: 0.05,
        maxMeanError: 1,
      },
    );

    expect(comparison.report.mismatchRatio).toBeCloseTo(0.12);
    expect(comparison.report.passed).toBe(false);
  });

  it("rejects different render dimensions", () => {
    expect(() =>
      comparePngBuffers(
        png(10, 10, [0, 0, 0, 255]),
        png(12, 10, [0, 0, 0, 255]),
      ),
    ).toThrow(ImageDimensionMismatchError);
  });

  it("parses paths and threshold overrides", () => {
    expect(
      parseVisualCompareArguments([
        "pencil.png",
        "figma.png",
        "--report",
        "artifacts/report.json",
        "--max-diff-ratio",
        "0.03",
      ]),
    ).toMatchObject({
      referencePath: "pencil.png",
      candidatePath: "figma.png",
      diffPath: "figma.diff.png",
      reportPath: "artifacts/report.json",
      thresholds: { maxMismatchRatio: 0.03 },
    });
  });
});
