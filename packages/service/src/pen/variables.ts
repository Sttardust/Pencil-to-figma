import { readFile, stat } from "node:fs/promises";
import type {
  PenVariableDefinition,
  PenVariableDefinitions,
} from "@pen-fig/core";

const MAX_PEN_FILE_BYTES = 50 * 1024 * 1024;
const MAX_VARIABLES = 1_000;

export async function readPenVariables(
  penPath: string,
): Promise<PenVariableDefinitions> {
  try {
    const file = await stat(penPath);
    if (file.size > MAX_PEN_FILE_BYTES)
      throw new Error("Pencil file exceeds the 50 MiB variable-read limit");
    const parsed = JSON.parse(await readFile(penPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object")
      throw new Error("Pencil file is not a JSON object");
    const raw = (parsed as Record<string, unknown>).variables;
    if (raw === undefined) return {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("Pencil variables must be an object");
    const entries = Object.entries(raw);
    if (entries.length > MAX_VARIABLES)
      throw new Error(`Pencil variable limit exceeded (${MAX_VARIABLES})`);
    const variables: PenVariableDefinitions = {};
    for (const [name, input] of entries) {
      if (!name || name.length > 200)
        throw new Error("Pencil variable names must be 1–200 characters");
      variables[name] = parseVariable(name, input);
    }
    return variables;
  } catch (error) {
    if (isMissing(error)) return {};
    throw error;
  }
}

function parseVariable(name: string, input: unknown): PenVariableDefinition {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error(`Pencil variable '$${name}' is invalid`);
  const candidate = input as Record<string, unknown>;
  const type = candidate.type;
  const value = candidate.value;
  if (
    type !== "boolean" &&
    type !== "number" &&
    type !== "string" &&
    type !== "color"
  )
    throw new Error(`Pencil variable '$${name}' has unsupported type`);
  if (
    typeof value !== "boolean" &&
    typeof value !== "number" &&
    typeof value !== "string"
  )
    throw new Error(`Pencil variable '$${name}' has an invalid value`);
  if (typeof value === "number" && !Number.isFinite(value))
    throw new Error(`Pencil variable '$${name}' must be finite`);
  return { type, value };
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
