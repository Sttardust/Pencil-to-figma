import { BRIDGE_PROTOCOL_VERSION } from "@pen-fig/bridge-schema/version";

export interface CompanionCompatibility {
  compatible: boolean;
  version?: string;
}

export interface OperationErrorPresentation {
  title: string;
  message: string;
}

export function presentOperationError(
  message: string,
): OperationErrorPresentation {
  const pageLimit = /select no more than (\d+) pencil pages/i.exec(
    message,
  )?.[1];
  if (pageLimit)
    return {
      title: "Too many Pencil pages selected",
      message: `Select up to ${pageLimit} complete Pencil pages, then try again.`,
    };
  const normalized = message.toLowerCase();
  if (normalized.includes("appearance verification failed"))
    return {
      title: "The screen needs a visual review",
      message: `${message}. The transferred copy was not linked, so it cannot overwrite a trusted version. Review the visible differences and try again after correcting the source or bridge.`,
    };
  if (normalized.includes("figma verification failed"))
    return {
      title: "Figma changed part of the design",
      message:
        "The bridge checked the imported layers and found a visual or layout difference. No new sync baseline was saved. Open JSON details for the affected layer, then try again after updating the plugin or companion.",
    };
  if (normalized.includes("pencil verification failed"))
    return {
      title: "Pencil changed part of the design",
      message:
        "The bridge checked the transferred layers and found a visual or layout difference. No new sync baseline was saved. Open JSON details for the affected layer, then try again after updating the companion.",
    };
  if (normalized.includes("no top-level pencil pages"))
    return {
      title: "No complete Pencil pages selected",
      message:
        "Select one or more complete page frames in Pencil, then try again.",
    };
  if (normalized.includes("font"))
    return { title: "A font is unavailable", message };
  if (normalized.includes("asset") || normalized.includes("image"))
    return { title: "An image needs attention", message };
  if (normalized.includes("connection") || normalized.includes("timed out"))
    return { title: "Pencil could not be reached", message };
  return { title: "The transfer needs attention", message };
}

export function assessCompanionHealth(value: unknown): CompanionCompatibility {
  const health =
    value && typeof value === "object"
      ? (value as {
          ok?: unknown;
          protocol?: unknown;
          companionVersion?: unknown;
          capabilities?: unknown;
        })
      : undefined;
  const version =
    typeof health?.companionVersion === "string"
      ? health.companionVersion
      : undefined;
  const capabilities = Array.isArray(health?.capabilities)
    ? health.capabilities
    : [];
  return {
    compatible: Boolean(
      health?.ok === true &&
      health.protocol === BRIDGE_PROTOCOL_VERSION &&
      version &&
      capabilities.includes("native-approval") &&
      capabilities.includes("header-auth") &&
      capabilities.includes("restricted-origins") &&
      capabilities.includes("multi-screen-export") &&
      capabilities.includes("grouped-export-placement") &&
      capabilities.includes("typed-public-errors") &&
      capabilities.includes("pencil-selection") &&
      capabilities.includes("large-pencil-selection") &&
      capabilities.includes("operation-recovery") &&
      capabilities.includes("correct-gradient-direction") &&
      capabilities.includes("pencil-write-fidelity-verification") &&
      capabilities.includes("automatic-visual-comparison") &&
      capabilities.includes("automatic-transfer-visual-verification"),
    ),
    ...(version ? { version } : {}),
  };
}

export interface SyncPreviewLike {
  ok: boolean;
  message?: string;
  canApplyWithoutResolution?: boolean;
  baselineUpgradeRequired?: boolean;
  unsupportedReason?: string;
  actions?: {
    toPencil?: number;
    toFigma?: number;
    conflicts?: number;
    unmapped?: number;
  };
}

export interface SyncPresentation {
  title: string;
  summary: string;
  pencilChanges: number;
  figmaChanges: number;
  canApply: boolean;
  applyLabel?: string;
}

export function presentSync(message: SyncPreviewLike): SyncPresentation {
  if (!message.ok)
    return {
      title: "Comparison failed",
      summary: message.message ?? "The two versions could not be compared.",
      pencilChanges: 0,
      figmaChanges: 0,
      canApply: false,
    };

  const toPencil = Number(message.actions?.toPencil ?? 0);
  const toFigma = Number(message.actions?.toFigma ?? 0);
  const conflicts = Number(message.actions?.conflicts ?? 0);
  const unmapped = Number(message.actions?.unmapped ?? 0);
  const canApply = Boolean(
    message.canApplyWithoutResolution &&
    !message.baselineUpgradeRequired &&
    conflicts === 0 &&
    unmapped === 0 &&
    ((toPencil > 0 && toFigma === 0) || (toFigma > 0 && toPencil === 0)),
  );

  if (message.baselineUpgradeRequired)
    return {
      title: "This link needs to be refreshed",
      summary: "Open Advanced options and link the existing Pencil copy again.",
      pencilChanges: toFigma,
      figmaChanges: toPencil,
      canApply: false,
    };
  if (message.unsupportedReason)
    return {
      title: "These changes need attention",
      summary: message.unsupportedReason,
      pencilChanges: toFigma,
      figmaChanges: toPencil,
      canApply: false,
    };
  if (conflicts > 0)
    return {
      title: "Changed in both apps",
      summary: `${conflicts} area${conflicts === 1 ? " was" : "s were"} edited in both Pencil and Figma. Choose which version to keep below.`,
      pencilChanges: toFigma,
      figmaChanges: toPencil,
      canApply: false,
    };
  if (toPencil === 0 && toFigma === 0)
    return {
      title: "Everything matches",
      summary: "Pencil and Figma already contain the same editable design.",
      pencilChanges: 0,
      figmaChanges: 0,
      canApply: false,
    };
  if (toPencil > 0 && toFigma === 0)
    return {
      title: "Figma has newer changes",
      summary: `${toPencil} changed layer${toPencil === 1 ? " is" : "s are"} ready to send to Pencil.`,
      pencilChanges: 0,
      figmaChanges: toPencil,
      canApply,
      applyLabel: "Update Pencil",
    };
  if (toFigma > 0 && toPencil === 0)
    return {
      title: "Pencil has newer changes",
      summary: `${toFigma} changed layer${toFigma === 1 ? " is" : "s are"} ready to send to Figma.`,
      pencilChanges: toFigma,
      figmaChanges: 0,
      canApply,
      applyLabel: "Update Figma",
    };
  return {
    title: "Changes found in both apps",
    summary: "Review the technical details before choosing what to update.",
    pencilChanges: toFigma,
    figmaChanges: toPencil,
    canApply: false,
  };
}

export function editableNodeSummary(count: number): string {
  return `${count} editable layer${count === 1 ? "" : "s"}`;
}

export function friendlyWarning(warning: unknown): string {
  const record =
    warning && typeof warning === "object"
      ? (warning as { code?: unknown; message?: unknown })
      : undefined;
  const value = `${String(record?.code ?? "")} ${String(
    record?.message ?? warning ?? "",
  )}`.toLowerCase();
  if (value.includes("font"))
    return "A missing font will use the closest available font.";
  if (value.includes("svg") || value.includes("icon"))
    return "Some icons will be copied as images to preserve their appearance.";
  if (
    value.includes("image") ||
    value.includes("crop") ||
    value.includes("tile")
  )
    return "Some image sizing may be simplified in the destination app.";
  if (value.includes("mixed_text") || value.includes("style range"))
    return "Text containing several styles will use its main style.";
  if (value.includes("variable") || value.includes("binding"))
    return "Some reusable style settings will be copied as regular values.";
  if (value.includes("instance") || value.includes("component"))
    return "Some component settings will be copied as editable layers.";
  return "Some design details may be simplified during transfer.";
}

export function technicalJson(value: unknown): string {
  return JSON.stringify(
    value,
    (key, entry) =>
      ["token", "sessionToken", "reconnectToken"].includes(key)
        ? "[redacted]"
        : key.toLowerCase().endsWith("base64")
          ? "[image data omitted]"
          : entry,
    2,
  );
}
