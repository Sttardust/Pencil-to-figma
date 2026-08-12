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
        companionVersion: "0.1.15",
        capabilities: [
          "automatic-reconnect",
          "native-approval",
          "header-auth",
          "restricted-origins",
          "multi-screen-export",
          "grouped-export-placement",
          "typed-public-errors",
          "pencil-selection",
          "direct-pencil-selection",
          "instance-descendant-ref-filtering",
          "large-pencil-selection",
          "operation-recovery",
          "correct-gradient-direction",
          "pencil-write-fidelity-verification",
          "automatic-visual-comparison",
          "automatic-transfer-visual-verification",
        ],
      }),
    ).toEqual({ compatible: true, version: "0.1.15" });
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
    expect(
      assessCompanionHealth({
        ok: true,
        protocol: 1,
        companionVersion: "0.1.9",
        capabilities: [
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
    ).toEqual({ compatible: false, version: "0.1.9" });
  });
});

describe("operation error presentation", () => {
  it("explains a transfer appearance failure and protects the link", () => {
    expect(
      presentOperationError(
        "Appearance verification failed for “Home” at 91.2% match. No sync link was saved",
      ),
    ).toEqual({
      title: "The screen needs a visual review",
      message:
        "Appearance verification failed for “Home” at 91.2% match. No sync link was saved. The transferred copy was not linked, so it cannot overwrite a trusted version. Review the visible differences and try again after correcting the source or bridge.",
    });
  });

  it("explains a failed Figma read-back without developer language", () => {
    expect(
      presentOperationError(
        "Figma verification failed: Scrim: gradient direction changed",
      ),
    ).toEqual({
      title: "Figma changed part of the design",
      message:
        "The bridge checked the imported layers and found a visual or layout difference. No new sync baseline was saved. Open JSON details for the affected layer, then try again after updating the plugin or companion.",
    });
  });

  it("explains a failed Pencil read-back without developer language", () => {
    expect(
      presentOperationError(
        "Pencil verification failed: Scrim: gradient direction changed",
      ),
    ).toEqual({
      title: "Pencil changed part of the design",
      message:
        "The bridge checked the transferred layers and found a visual or layout difference. No new sync baseline was saved. Open JSON details for the affected layer, then try again after updating the companion.",
    });
  });

  it("keeps interrupted Pencil scripts out of the visible alert", () => {
    expect(
      presentOperationError(
        "MCP error -32603: Failure during operation execution: InternalError: interrupted at const selected=new Set(...) ",
      ),
    ).toEqual({
      title: "Pencil paused the page lookup",
      message:
        "The selected pages took too long to read. Nothing was changed. Try the selection again; if it repeats, select fewer pages at once.",
    });
  });

  it("explains stale nested Pencil component references", () => {
    expect(
      presentOperationError("Pencil ref lXJi9 is not a reusable frame"),
    ).toEqual({
      title: "A component link needs to be refreshed",
      message:
        "Pencil found an outdated nested component reference. Nothing was changed. Update the companion, then send the screen again.",
    });
  });

  it("names the affected frame while keeping its internal Pencil ID hidden", () => {
    const presented = presentOperationError(
      "Pencil ref lXJi9 is not a reusable frame",
      "Profile",
    );
    expect(presented).toEqual({
      title: "A component link needs to be refreshed in “Profile”",
      message:
        "Pencil found an outdated nested component reference. Nothing was changed. Update the companion, then send the screen again.",
    });
    expect(JSON.stringify(presented)).not.toContain("lXJi9");
  });

  it("replaces an unknown technical error with a named screen message", () => {
    expect(
      presentOperationError("Internal node 123:456 failed", "Profile"),
    ).toEqual({
      title: "“Profile” could not be transferred",
      message:
        "The bridge could not finish this screen. Open JSON details for the technical information, then try again.",
    });
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

  it("omits large rendered images from optional JSON details", () => {
    const value = technicalJson({
      type: "visual-comparison-result",
      diffPngBase64: "large-image-data",
    });

    expect(value).not.toContain("large-image-data");
    expect(value).toContain("[image data omitted]");
  });
});
