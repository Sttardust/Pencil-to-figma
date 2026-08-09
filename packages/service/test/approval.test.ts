import { describe, expect, it } from "vitest";
import { MacOSApprovalProvider } from "../src/approval.js";

describe("macOS local approval", () => {
  it("returns the user's native approval decision", async () => {
    const approved = new MacOSApprovalProvider({
      platform: "darwin",
      prompt: async () => true,
    });
    const denied = new MacOSApprovalProvider({
      platform: "darwin",
      prompt: async () => false,
    });

    await expect(approved.requestApproval()).resolves.toBe("approved");
    await expect(denied.requestApproval()).resolves.toBe("denied");
  });

  it("rejects a second request while the native prompt is open", async () => {
    let finishPrompt: ((approved: boolean) => void) | undefined;
    const provider = new MacOSApprovalProvider({
      platform: "darwin",
      prompt: () =>
        new Promise<boolean>((resolve) => {
          finishPrompt = resolve;
        }),
    });

    const first = provider.requestApproval();
    await expect(provider.requestApproval()).resolves.toBe("busy");
    finishPrompt?.(true);
    await expect(first).resolves.toBe("approved");
  });

  it("reports native approval as unavailable outside macOS", async () => {
    const provider = new MacOSApprovalProvider({
      platform: "linux",
      prompt: async () => true,
    });

    await expect(provider.requestApproval()).resolves.toBe("unavailable");
  });
});
