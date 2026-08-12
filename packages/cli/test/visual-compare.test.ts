import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import {
  comparePngBuffers,
  comparePngBuffersWithDimensionTolerance,
  DEFAULT_VISUAL_THRESHOLDS,
  ImageDimensionMismatchError,
} from "@pen-fig/service/visual";
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
  it("explains that documentation paths are placeholders", () => {
    expect(() =>
      parseVisualCompareArguments([
        "/absolute/path/to/pencil.png",
        "/absolute/path/to/figma.png",
      ]),
    ).toThrow("Replace the example PNG paths");
  });

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

  it("allows a small cross-renderer edge difference by default", () => {
    const reference = PNG.sync.read(png(100, 100, [255, 255, 255, 255]));
    const candidate = PNG.sync.read(png(100, 100, [255, 255, 255, 255]));
    for (let pixel = 0; pixel < 220; pixel += 1) candidate.data[pixel * 4] = 0;
    const comparison = comparePngBuffers(
      PNG.sync.write(reference),
      PNG.sync.write(candidate),
    );

    expect(DEFAULT_VISUAL_THRESHOLDS.maxMismatchRatio).toBe(0.025);
    expect(comparison.report.mismatchRatio).toBeCloseTo(0.022);
    expect(DEFAULT_VISUAL_THRESHOLDS.maxMeanError).toBe(0.02);
    expect(comparison.report.meanAbsoluteError).toBeLessThan(0.02);
    expect(comparison.report.passed).toBe(true);
  });

  it("still rejects a broad color shift above the default mean limit", () => {
    const reference = png(100, 100, [100, 100, 100, 255]);
    const candidate = png(100, 100, [108, 108, 108, 255]);
    const comparison = comparePngBuffers(reference, candidate);

    expect(comparison.report.mismatchRatio).toBe(0);
    expect(comparison.report.meanAbsoluteError).toBeGreaterThan(0.02);
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

  it("compares a small renderer height drift using the shared frame area", () => {
    const reference = png(20, 100, [24, 30, 36, 255]);
    const candidate = png(20, 102, [24, 30, 36, 255]);
    const comparison = comparePngBuffersWithDimensionTolerance(
      reference,
      candidate,
    );

    expect(comparison.report.passed).toBe(true);
    expect(comparison.report.dimensionNormalization).toEqual({
      reference: { width: 20, height: 100 },
      candidate: { width: 20, height: 102 },
      compared: { width: 20, height: 100 },
    });
  });

  it("rejects a renderer dimension drift above the tolerance", () => {
    expect(() =>
      comparePngBuffersWithDimensionTolerance(
        png(20, 100, [24, 30, 36, 255]),
        png(20, 104, [24, 30, 36, 255]),
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
