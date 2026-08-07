import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bridgeDocumentSchema, canonicalStringify } from "../src/index.js";

const fixtureNames = [
  "signup-email",
  "c1-ledger",
  "introduction",
  "n3-atelier",
] as const;

describe("bridgeDocumentSchema", () => {
  for (const fixtureName of fixtureNames) {
    it(`validates the ${fixtureName} pilot fixture`, async () => {
      const fixture = await readFixture(fixtureName);
      const parsed = bridgeDocumentSchema.parse(fixture);
      expect(parsed.root.source.nodeId).toBeTypeOf("string");
      const canonical = canonicalStringify(parsed);
      expect(
        canonicalStringify(bridgeDocumentSchema.parse(JSON.parse(canonical))),
      ).toBe(canonical);
    });
  }

  it("rejects unknown properties with a path-specific issue", async () => {
    const fixture = (await readFixture("signup-email")) as Record<
      string,
      unknown
    >;
    fixture.unexpected = true;
    const result = bridgeDocumentSchema.safeParse(fixture);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual([]);
  });

  it("requires kind-specific text data", async () => {
    const fixture = await readFixture("signup-email");
    fixture.root.kind = "text";
    const result = bridgeDocumentSchema.safeParse(fixture);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ path: ["root", "text"] }),
      );
  });

  it("rejects unknown node kinds at the exact node path", async () => {
    const fixture = await readFixture("c1-ledger");
    fixture.root.kind = "canvas-widget";
    const result = bridgeDocumentSchema.safeParse(fixture);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues[0]?.path).toEqual(["root", "kind"]);
  });
});

describe("canonicalStringify", () => {
  it("is stable across object key order and repeated canonicalization", () => {
    const left = { z: -0, a: { y: 2, x: 1 }, list: [{ b: true, a: false }] };
    const right = { list: [{ a: false, b: true }], a: { x: 1, y: 2 }, z: 0 };
    const canonical = canonicalStringify(left);
    expect(canonical).toBe(canonicalStringify(right));
    expect(canonicalStringify(JSON.parse(canonical))).toBe(canonical);
  });
});

async function readFixture(name: (typeof fixtureNames)[number]): Promise<any> {
  const path = fileURLToPath(
    new URL(`../../../fixtures/bridge/${name}.json`, import.meta.url),
  );
  return JSON.parse(await readFile(path, "utf8"));
}
