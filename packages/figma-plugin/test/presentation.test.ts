import { describe, expect, it } from "vitest";
import {
  editableNodeSummary,
  friendlyWarning,
  presentSync,
} from "../src/ui/presentation.js";

describe("plugin UI presentation", () => {
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
});
