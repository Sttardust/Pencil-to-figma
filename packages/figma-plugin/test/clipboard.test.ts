import { describe, expect, it, vi } from "vitest";
import { copyText, type ClipboardEnvironment } from "../src/ui/clipboard.js";

function environment(options: {
  legacyResult?: boolean;
  modernResult?: "resolve" | "reject";
}): {
  environment: ClipboardEnvironment;
  remove: ReturnType<typeof vi.fn>;
  writeText: ReturnType<typeof vi.fn>;
} {
  const remove = vi.fn();
  const writeText = vi.fn(() =>
    options.modernResult === "reject"
      ? Promise.reject(new Error("blocked"))
      : Promise.resolve(),
  );
  const textarea = {
    value: "",
    style: {
      position: "",
      left: "",
      top: "",
      opacity: "",
      pointerEvents: "",
    },
    setAttribute: vi.fn(),
    focus: vi.fn(),
    select: vi.fn(),
    remove,
  };

  return {
    environment: {
      document: {
        body: { appendChild: vi.fn() },
        createElement: vi.fn(() => textarea),
        execCommand: vi.fn(() => options.legacyResult ?? false),
      },
      navigator: { clipboard: { writeText } },
    },
    remove,
    writeText,
  };
}

describe("plugin clipboard", () => {
  it("uses the iframe-compatible selection copy first", async () => {
    const context = environment({ legacyResult: true });

    await expect(copyText("bridge JSON", context.environment)).resolves.toBe(
      true,
    );
    expect(context.writeText).not.toHaveBeenCalled();
    expect(context.remove).toHaveBeenCalledOnce();
  });

  it("falls back to the modern clipboard API", async () => {
    const context = environment({
      legacyResult: false,
      modernResult: "resolve",
    });

    await expect(copyText("page ID", context.environment)).resolves.toBe(true);
    expect(context.writeText).toHaveBeenCalledWith("page ID");
  });

  it("reports failure when Figma blocks both copy methods", async () => {
    const context = environment({
      legacyResult: false,
      modernResult: "reject",
    });

    await expect(copyText("details", context.environment)).resolves.toBe(false);
    expect(context.remove).toHaveBeenCalledOnce();
  });
});
