import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toPublicBridgeError } from "../src/public-error.js";

describe("public bridge errors", () => {
  it("reports invalid payloads without exposing schema contents", () => {
    const parsed = z.object({ count: z.number() }).safeParse({ count: "many" });
    if (parsed.success) throw new Error("Expected invalid fixture");

    expect(toPublicBridgeError(parsed.error)).toEqual({
      code: "SCHEMA_MESSAGE",
      message: "The transfer data is invalid at count.",
      phase: "validation",
      retrySafe: false,
      httpStatus: 400,
    });
  });

  it("distinguishes stale conflicts from Pencil connectivity", () => {
    expect(
      toPublicBridgeError(
        new Error("Another Figma change appeared during resolution: pen:abc"),
      ),
    ).toMatchObject({
      code: "CONFLICT_STALE",
      phase: "comparison",
      retrySafe: true,
      httpStatus: 409,
    });
  });

  it("marks verification failures as safely retryable", () => {
    expect(
      toPublicBridgeError(
        new Error("Pencil verification found a mapping count mismatch"),
      ),
    ).toMatchObject({
      code: "WRITE_VERIFICATION",
      phase: "verification",
      retrySafe: true,
    });
  });

  it("classifies large rendered-size differences as verification failures", () => {
    expect(
      toPublicBridgeError(
        new Error(
          "Rendered screen sizes differ: Pencil is 786×1750, Figma is 786×1900",
        ),
      ),
    ).toMatchObject({
      code: "WRITE_VERIFICATION",
      phase: "verification",
      retrySafe: true,
    });
  });

  it("reports selection limits before the write phase", () => {
    expect(
      toPublicBridgeError(
        new Error("Select no more than 50 Pencil pages at once"),
      ),
    ).toEqual({
      code: "SCHEMA_SELECTION_LIMIT",
      message: "Select no more than 50 Pencil pages at once",
      phase: "validation",
      retrySafe: true,
      httpStatus: 422,
    });
  });

  it("redacts local paths from responses", () => {
    const result = toPublicBridgeError(
      new Error(
        "Manifest /Users/semere/Workfiles/Private/orchid.pen-fig.json changed",
      ),
    );

    expect(result.code).toBe("MANIFEST_INVALID");
    expect(result.message).toContain("[local path]");
    expect(result.message).not.toContain("semere");
    expect(result.message).not.toContain("orchid");
  });

  it("does not tell users to retry an unknown write failure", () => {
    expect(
      toPublicBridgeError(new Error("Unexpected internal failure")),
    ).toEqual({
      code: "WRITE_FAILED",
      message: "Unexpected internal failure",
      phase: "write",
      retrySafe: false,
      httpStatus: 500,
    });
  });
});
