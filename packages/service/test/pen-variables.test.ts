import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readPenVariables } from "../src/pen/variables.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("readPenVariables", () => {
  it("reads validated document-level Pencil variables", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pen-vars-"));
    directories.push(directory);
    const penPath = path.join(directory, "fixture.pen");
    await writeFile(
      penPath,
      JSON.stringify({
        version: "2.15",
        children: [],
        variables: {
          ink: { type: "color", value: "#1F2D2A" },
          spacing: { type: "number", value: 16 },
          family: { type: "string", value: "Inter" },
          enabled: { type: "boolean", value: true },
        },
      }),
      "utf8",
    );

    await expect(readPenVariables(penPath)).resolves.toEqual({
      ink: { type: "color", value: "#1F2D2A" },
      spacing: { type: "number", value: 16 },
      family: { type: "string", value: "Inter" },
      enabled: { type: "boolean", value: true },
    });
  });

  it("returns no variables when an unsaved fixture file is absent", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "pen-vars-missing-"),
    );
    directories.push(directory);
    await expect(
      readPenVariables(path.join(directory, "missing.pen")),
    ).resolves.toEqual({});
  });
});
