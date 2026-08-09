import { execFile } from "node:child_process";

export type ApprovalDecision =
  "approved" | "denied" | "busy" | "rate-limited" | "unavailable";

export interface LocalApprovalProvider {
  requestApproval(): Promise<ApprovalDecision>;
}

export interface MacOSApprovalProviderOptions {
  platform?: NodeJS.Platform;
  prompt?: () => Promise<boolean>;
  now?: () => number;
  cooldownMs?: number;
}

export class MacOSApprovalProvider implements LocalApprovalProvider {
  readonly #platform: NodeJS.Platform;
  readonly #prompt: () => Promise<boolean>;
  readonly #now: () => number;
  readonly #cooldownMs: number;
  #pending = false;
  #nextPromptAt = 0;

  constructor(options: MacOSApprovalProviderOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#prompt = options.prompt ?? showMacOSApproval;
    this.#now = options.now ?? Date.now;
    this.#cooldownMs = options.cooldownMs ?? 10_000;
  }

  async requestApproval(): Promise<ApprovalDecision> {
    if (this.#platform !== "darwin") return "unavailable";
    if (this.#pending) return "busy";
    if (this.#now() < this.#nextPromptAt) return "rate-limited";
    this.#pending = true;
    try {
      return (await this.#prompt()) ? "approved" : "denied";
    } finally {
      this.#pending = false;
      this.#nextPromptAt = this.#now() + this.#cooldownMs;
    }
  }
}

function showMacOSApproval(): Promise<boolean> {
  const message =
    "The Pencil ↔ Figma plugin is requesting access to the design open in Pencil. Allow only if you just opened the plugin in Figma.";
  const script = `display dialog ${appleScriptString(message)} with title "Pencil Figma Bridge" buttons {"Cancel", "Allow"} default button "Allow" cancel button "Cancel" with icon caution`;
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/osascript",
      ["-e", script],
      { timeout: 60_000 },
      (error) => resolve(!error),
    );
  });
}

function appleScriptString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
