import { describe, expect, it } from "vitest";
import {
  assessCompanionHealth,
  editableNodeSummary,
  friendlyWarning,
  presentOperationError,
  presentSync,
  technicalJson,
} from "../src/ui/presentation.js";

describe("companion health presentation", () => {
  it("accepts a versioned companion with secure local transport", () => {
    expect(
      assessCompanionHealth({
        ok: true,
        protocol: 1,
        companionVersion: "0.1.9",
        capabilities: [
          "automatic-reconnect",
          "native-approval",
          "header-auth",
          "restricted-origins",
          "multi-screen-export",
          "grouped-export-placement",
          "typed-public-errors",
          "pencil-selection",
          "large-pencil-selection",
          "operation-recovery",
        ],
      }),
    ).toEqual({ compatible: true, version: "0.1.9" });
  });

  it("requires an update for legacy or incompatible health responses", () => {
    expect(assessCompanionHealth({ ok: true, protocol: 1 })).toEqual({
      compatible: false,
    });
    expect(
      assessCompanionHealth({
        ok: true,
        protocol: 2,
        companionVersion: "0.1.0",
        capabilities: ["native-approval"],
      }),
    ).toEqual({ compatible: false, version: "0.1.0" });
    expect(
      assessCompanionHealth({
        ok: true,
        protocol: 1,
        companionVersion: "0.1.2",
        capabilities: ["native-approval"],
      }),
    ).toEqual({ compatible: false, version: "0.1.2" });
  });
});

describe("plugin UI presentation", () => {
  it("turns a Pencil page limit into visible corrective guidance", () => {
    expect(
      presentOperationError("Select no more than 50 Pencil pages at once"),
    ).toEqual({
      title: "Too many Pencil pages selected",
      message: "Select up to 50 complete Pencil pages, then try again.",
    });
  });

  it("explains an unchanged comparison without developer terminology", () => {
    expect(
      presentSync({
        ok: true,
        canApplyWithoutResolution: true,
        actions: { toPencil: 0, toFigma: 0, conflicts: 0, unmapped: 0 },
      }),
    ).toMatchObject({
      title: "Everything matches",
      canApply: false,
    });
  });

  it("names the destination when Figma has newer changes", () => {
    expect(
      presentSync({
        ok: true,
        canApplyWithoutResolution: true,
        actions: { toPencil: 2, toFigma: 0, conflicts: 0, unmapped: 0 },
      }),
    ).toMatchObject({
      title: "Figma has newer changes",
      applyLabel: "Update Pencil",
      figmaChanges: 2,
      pencilChanges: 0,
      canApply: true,
    });
  });

  it("keeps the apply action disabled for conflicts", () => {
    expect(
      presentSync({
        ok: true,
        canApplyWithoutResolution: false,
        actions: { toPencil: 0, toFigma: 0, conflicts: 1, unmapped: 0 },
      }),
    ).toMatchObject({
      title: "Changed in both apps",
      canApply: false,
    });
  });

  it("formats editable layer counts", () => {
    expect(editableNodeSummary(1)).toBe("1 editable layer");
    expect(editableNodeSummary(24)).toBe("24 editable layers");
  });

  it("turns technical warnings into plain guidance", () => {
    expect(
      friendlyWarning({
        code: "FIGMA_SVG_RASTERIZED",
        message: "SVG wrapper Signal will use a rendered image in Pencil",
      }),
    ).toBe("Some icons will be copied as images to preserve their appearance.");
    expect(friendlyWarning("FONT_SUBSTITUTED: Fraunces → Georgia")).toBe(
      "A missing font will use the closest available font.",
    );
  });

  it("redacts saved credentials from optional JSON details", () => {
    const value = technicalJson({
      type: "reconnected",
      token: "session-secret",
      credentials: { reconnectToken: "reconnect-secret" },
    });

    expect(value).not.toContain("session-secret");
    expect(value).not.toContain("reconnect-secret");
    expect(value.match(/\[redacted\]/g)).toHaveLength(2);
  });
});
