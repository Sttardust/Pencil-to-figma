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
        : entry,
    2,
  );
}
