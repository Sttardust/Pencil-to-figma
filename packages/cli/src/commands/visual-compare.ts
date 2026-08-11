import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  comparePngBuffers,
  DEFAULT_VISUAL_THRESHOLDS,
  ImageDimensionMismatchError,
  type VisualThresholds,
} from "@pen-fig/service/visual";

interface VisualCompareArguments {
  referencePath: string;
  candidatePath: string;
  diffPath: string;
  reportPath?: string;
  thresholds: VisualThresholds;
}

export async function runVisualCompare(args: string[]): Promise<number> {
  let options: VisualCompareArguments;
  try {
    options = parseVisualCompareArguments(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(visualCompareUsage());
    return 2;
  }

  try {
    const [reference, candidate] = await Promise.all([
      readFile(options.referencePath),
      readFile(options.candidatePath),
    ]);
    const comparison = comparePngBuffers(
      reference,
      candidate,
      options.thresholds,
    );
    await mkdir(path.dirname(options.diffPath), { recursive: true });
    await writeFile(options.diffPath, comparison.diffPng);
    const report = {
      ...comparison.report,
      referencePath: options.referencePath,
      candidatePath: options.candidatePath,
      diffPath: options.diffPath,
    };
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (options.reportPath) {
      await mkdir(path.dirname(options.reportPath), { recursive: true });
      await writeFile(options.reportPath, text, "utf8");
    }
    process.stdout.write(text);
    return report.passed ? 0 : 1;
  } catch (error) {
    const message =
      error instanceof ImageDimensionMismatchError
        ? error.message
        : `Visual comparison failed: ${error instanceof Error ? error.message : String(error)}`;
    console.error(message);
    return 2;
  }
}

export function parseVisualCompareArguments(
  args: string[],
): VisualCompareArguments {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const supported = new Set([
    "--diff",
    "--report",
    "--pixel-threshold",
    "--max-diff-ratio",
    "--max-mean-error",
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    if (!supported.has(argument)) throw new Error(`Unknown option ${argument}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`${argument} requires a value`);
    values.set(argument, value);
    index += 1;
  }

  if (positionals.length !== 2)
    throw new Error("Provide one reference PNG and one candidate PNG");
  if (positionals.some((value) => value.includes("/absolute/path/to/")))
    throw new Error(
      "Replace the example PNG paths with the actual exported file locations",
    );
  const candidatePath = positionals[1]!;
  return {
    referencePath: positionals[0]!,
    candidatePath,
    diffPath:
      values.get("--diff") ??
      path.join(
        path.dirname(candidatePath),
        `${path.basename(candidatePath, path.extname(candidatePath))}.diff.png`,
      ),
    ...(values.get("--report") ? { reportPath: values.get("--report")! } : {}),
    thresholds: {
      pixelThreshold: numberOption(
        values,
        "--pixel-threshold",
        DEFAULT_VISUAL_THRESHOLDS.pixelThreshold,
      ),
      maxMismatchRatio: numberOption(
        values,
        "--max-diff-ratio",
        DEFAULT_VISUAL_THRESHOLDS.maxMismatchRatio,
      ),
      maxMeanError: numberOption(
        values,
        "--max-mean-error",
        DEFAULT_VISUAL_THRESHOLDS.maxMeanError,
      ),
    },
  };
}

export function visualCompareUsage(): string {
  return [
    "Usage: pen-fig visual-compare <reference.png> <candidate.png> [options]",
    "",
    "Options:",
    "  --diff <path>             Highlighted PNG output",
    "  --report <path>           JSON report output",
    "  --pixel-threshold <0..1>  Per-pixel sensitivity (default 0.1)",
    "  --max-diff-ratio <0..1>   Allowed mismatched pixels (default 0.02)",
    "  --max-mean-error <0..1>   Allowed mean color error (default 0.015)",
  ].join("\n");
}

function numberOption(
  values: ReadonlyMap<string, string>,
  name: string,
  fallback: number,
): number {
  const raw = values.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw new Error(`${name} must be between 0 and 1`);
  return value;
}
