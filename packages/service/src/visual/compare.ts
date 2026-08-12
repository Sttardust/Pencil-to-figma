import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export interface VisualThresholds {
  pixelThreshold: number;
  maxMismatchRatio: number;
  maxMeanError: number;
}

export interface VisualComparisonReport {
  version: 1;
  width: number;
  height: number;
  totalPixels: number;
  mismatchedPixels: number;
  mismatchRatio: number;
  meanAbsoluteError: number;
  thresholds: VisualThresholds;
  passed: boolean;
}

export interface VisualComparison {
  report: VisualComparisonReport;
  diffPng: Buffer;
}

export const DEFAULT_VISUAL_THRESHOLDS: VisualThresholds = {
  pixelThreshold: 0.1,
  // Pencil and Figma rasterize text and small vectors differently. Keep a
  // narrow allowance for those edge pixels while the mean-error guard below
  // continues to catch broad color and layout changes.
  maxMismatchRatio: 0.025,
  maxMeanError: 0.02,
};

export class ImageDimensionMismatchError extends Error {
  constructor(
    readonly reference: { width: number; height: number },
    readonly candidate: { width: number; height: number },
  ) {
    super(
      `Rendered screen sizes differ: Pencil is ${reference.width}×${reference.height}, Figma is ${candidate.width}×${candidate.height}`,
    );
  }
}

export function comparePngBuffers(
  referenceBuffer: Buffer,
  candidateBuffer: Buffer,
  thresholds: VisualThresholds = DEFAULT_VISUAL_THRESHOLDS,
): VisualComparison {
  validateThresholds(thresholds);
  const reference = PNG.sync.read(referenceBuffer);
  const candidate = PNG.sync.read(candidateBuffer);
  if (
    reference.width !== candidate.width ||
    reference.height !== candidate.height
  )
    throw new ImageDimensionMismatchError(
      { width: reference.width, height: reference.height },
      { width: candidate.width, height: candidate.height },
    );

  const diff = new PNG({ width: reference.width, height: reference.height });
  const mismatchedPixels = pixelmatch(
    reference.data,
    candidate.data,
    diff.data,
    reference.width,
    reference.height,
    {
      threshold: thresholds.pixelThreshold,
      includeAA: false,
      alpha: 0.18,
      diffColor: [239, 68, 68],
      aaColor: [245, 158, 11],
    },
  );
  const totalPixels = reference.width * reference.height;
  const mismatchRatio = mismatchedPixels / totalPixels;
  const meanAbsoluteError = rgbaMeanAbsoluteError(
    reference.data,
    candidate.data,
  );
  const passed =
    mismatchRatio <= thresholds.maxMismatchRatio &&
    meanAbsoluteError <= thresholds.maxMeanError;

  return {
    report: {
      version: 1,
      width: reference.width,
      height: reference.height,
      totalPixels,
      mismatchedPixels,
      mismatchRatio,
      meanAbsoluteError,
      thresholds,
      passed,
    },
    diffPng: PNG.sync.write(diff),
  };
}

function rgbaMeanAbsoluteError(
  reference: Uint8Array,
  candidate: Uint8Array,
): number {
  let total = 0;
  for (let index = 0; index < reference.length; index += 1)
    total += Math.abs(reference[index]! - candidate[index]!);
  return total / (reference.length * 255);
}

function validateThresholds(thresholds: VisualThresholds): void {
  for (const [name, value] of Object.entries(thresholds))
    if (!Number.isFinite(value) || value < 0 || value > 1)
      throw new Error(`${name} must be between 0 and 1`);
}
