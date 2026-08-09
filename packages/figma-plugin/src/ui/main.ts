const form = required<HTMLFormElement>("pair-form");
const input = required<HTMLInputElement>("pair-code");
const statusBadge = required<HTMLElement>("status");
const detail = required<HTMLElement>("detail");
const actions = required<HTMLElement>("actions");
const output = required<HTMLElement>("output");
const screenList = required<HTMLElement>("screen-list");
const screenQuery = required<HTMLInputElement>("screen-query");
const exportCopy = required<HTMLButtonElement>("export-copy");
const adoptRootId = required<HTMLInputElement>("adopt-root-id");
const adoptCopy = required<HTMLButtonElement>("adopt-copy");
const previewSync = required<HTMLButtonElement>("preview-sync");
const applySync = required<HTMLButtonElement>("apply-sync");
const conflictPanel = required<HTMLElement>("conflict-panel");
const conflictSummary = required<HTMLElement>("conflict-summary");
const keepPencil = required<HTMLButtonElement>("keep-pencil");
const keepFigma = required<HTMLButtonElement>("keep-figma");
const cancelConflict = required<HTMLButtonElement>("cancel-conflict");
let token: string | undefined;
let pendingExportPlan: any;
let pendingSyncPreview: any;
let pendingConflict: any;
let pendingImport:
  | {
      document: any;
      assetData: Record<string, string>;
      transferId: string;
    }
  | undefined;

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void connect(input.value.trim().toUpperCase());
});

required("screens").addEventListener("click", () => {
  void request("/pen/screens", { method: "GET" })
    .then((message) => renderScreens(message.text))
    .catch(showError);
});
required("search-screens").addEventListener("click", () => {
  const query = screenQuery.value.trim();
  if (!query) return;
  const directId = /^id:([A-Za-z0-9]+)$/i.exec(query)?.[1];
  if (directId) {
    void importScreen(directId);
    return;
  }
  void request(`/pen/screen-search?query=${encodeURIComponent(query)}`, {
    method: "GET",
  })
    .then((message) => renderScreens(message.text))
    .catch(showError);
});
required("selection").addEventListener("click", () =>
  parent.postMessage({ pluginMessage: { type: "selection-summary" } }, "*"),
);
required("preview-export").addEventListener("click", () => {
  pendingExportPlan = undefined;
  exportCopy.disabled = true;
  adoptCopy.disabled = true;
  applySync.disabled = true;
  pendingSyncPreview = undefined;
  hideConflict();
  setStatus("Reading Figma…", true);
  parent.postMessage({ pluginMessage: { type: "preview-figma-export" } }, "*");
});
required("plan-export").addEventListener("click", () => {
  setStatus("Planning Pencil export…", true);
  parent.postMessage({ pluginMessage: { type: "plan-figma-export" } }, "*");
});
exportCopy.addEventListener("click", () => {
  if (!pendingExportPlan || !token) return;
  const counts = pendingExportPlan.counts;
  const warningCount = pendingExportPlan.warnings?.length ?? 0;
  const confirmed = confirm(
    `Create a new Pencil copy with ${counts.inserts} editable nodes and ${counts.assets} assets?\n\nThis will run ${pendingExportPlan.chunks.length} validated chunks.${warningCount ? `\n\n${warningCount} conversion warnings are listed in the plan.` : ""}`,
  );
  if (!confirmed) return;
  exportCopy.disabled = true;
  setStatus("Writing Pencil copy…", true);
  parent.postMessage(
    {
      pluginMessage: {
        type: "execute-figma-export",
        token,
      },
    },
    "*",
  );
});
adoptCopy.addEventListener("click", () => {
  const penRootId = adoptRootId.value.trim();
  if (!token || !/^[A-Za-z0-9]+$/.test(penRootId)) {
    detail.textContent = "Enter a valid existing Pencil root ID.";
    return;
  }
  if (
    !confirm(
      `Adopt Pencil root ${penRootId} as the synchronized counterpart of this Figma frame?\n\nNo design nodes will be changed. The sidecar mapping and baseline will be updated atomically.`,
    )
  )
    return;
  adoptCopy.disabled = true;
  setStatus("Adopting Pencil copy…", true);
  parent.postMessage(
    {
      pluginMessage: {
        type: "adopt-figma-export",
        token,
        penRootId,
      },
    },
    "*",
  );
});
previewSync.addEventListener("click", () => {
  if (!token) return;
  setStatus("Comparing both editors…", true);
  parent.postMessage(
    { pluginMessage: { type: "preview-mapped-sync", token } },
    "*",
  );
});
applySync.addEventListener("click", () => {
  if (!token || !pendingSyncPreview) return;
  const toPencil = pendingSyncPreview.actions.toPencil;
  const toFigma = pendingSyncPreview.actions.toFigma;
  const count = toPencil || toFigma;
  const source = toPencil ? "Figma" : "Pencil";
  const target = toPencil ? "Pencil" : "Figma";
  if (
    !confirm(
      `Apply ${count} ${source}-only node update${count === 1 ? "" : "s"} to ${target}?\n\nThe updates run in one atomic, undoable ${target} transaction.`,
    )
  )
    return;
  applySync.disabled = true;
  setStatus(`Updating ${target}…`, true);
  parent.postMessage(
    { pluginMessage: { type: "apply-mapped-sync", token } },
    "*",
  );
});
keepPencil.addEventListener("click", () => resolveConflict("pen"));
keepFigma.addEventListener("click", () => resolveConflict("figma"));
cancelConflict.addEventListener("click", () => {
  hideConflict();
  pendingSyncPreview = undefined;
  applySync.disabled = true;
  setStatus("Conflict cancelled", true);
  detail.textContent =
    "No writes were made. Preview mapped sync again when you are ready.";
  output.textContent = JSON.stringify(
    {
      type: "figma-sync-result",
      ok: true,
      operation: "cancelled",
      writes: 0,
    },
    null,
    2,
  );
});
required("write-test").addEventListener("click", () =>
  parent.postMessage({ pluginMessage: { type: "reversible-write-test" } }, "*"),
);

window.onmessage = (event) => {
  const message = event.data.pluginMessage;
  if (message) {
    output.textContent = JSON.stringify(message, null, 2);
    if (message.type === "import-result") {
      if (!message.ok) {
        setStatus("Import failed", false);
        detail.textContent = message.message;
      } else {
        const completedImport = pendingImport;
        pendingImport = undefined;
        if (!completedImport) {
          setStatus("Imported — mapping not saved", false);
          return;
        }
        setStatus("Saving mapping…", true);
        void request("/sync/complete", {
          method: "POST",
          body: JSON.stringify({
            transferId: completedImport.transferId,
            mappings: message.mappings,
            ...(message.figmaBaselineHashes &&
            typeof message.figmaBaselineHashes === "object"
              ? { figmaBaselineHashes: message.figmaBaselineHashes }
              : {}),
            ...(message.figmaDocumentId
              ? { figmaDocumentId: message.figmaDocumentId }
              : {}),
          }),
        })
          .then((committed) => {
            output.textContent = JSON.stringify(
              { ...message, manifest: committed },
              null,
              2,
            );
            setStatus("Imported and mapped", true);
            previewSync.disabled = false;
          })
          .catch((error) => {
            setStatus("Imported — mapping save failed", false);
            detail.textContent =
              error instanceof Error ? error.message : "Mapping save failed";
          });
      }
    }
    if (message.type === "import-preview") {
      if (!message.ok) {
        setStatus("Preview failed", false);
        detail.textContent = message.message;
        return;
      }
      const pending = pendingImport;
      if (!pending) return;
      const counts = message.operations;
      const summary =
        message.operation === "created"
          ? `Create ${counts.create} editable nodes?`
          : message.operation === "unchanged"
            ? "No authored changes were found. Select the existing import?"
            : `Apply ${message.nodeCount} operations to the existing import?\n\nCreate: ${counts.create}\nUpdate: ${counts.update}\nMove/reorder: ${counts.move}\nDelete: ${counts.delete}`;
      const warningText = message.warnings.length
        ? `\n\nWarnings:\n${message.warnings.map((warning: string) => `• ${warning}`).join("\n")}`
        : "";
      if (!confirm(`${summary}${warningText}`)) {
        pendingImport = undefined;
        setStatus("Connected — cancelled", true);
        return;
      }
      setStatus("Writing Figma…", true);
      parent.postMessage(
        {
          pluginMessage: {
            type: "apply-document",
            document: pending.document,
            assetData: pending.assetData,
          },
        },
        "*",
      );
    }
    if (message.type === "figma-export-preview") {
      setStatus(
        message.ok ? "Export preview ready" : "Export preview failed",
        message.ok,
      );
      if (!message.ok) detail.textContent = message.message;
      adoptCopy.disabled = !message.ok;
    }
    if (message.type === "figma-export-plan") {
      setStatus(
        message.ok ? "Pencil export plan ready" : "Export planning failed",
        message.ok,
      );
      if (!message.ok) {
        pendingExportPlan = undefined;
        exportCopy.disabled = true;
        detail.textContent = message.message;
      } else {
        pendingExportPlan = message;
        exportCopy.disabled = false;
      }
    }
    if (message.type === "figma-export-result") {
      setStatus(
        message.ok ? "Pencil copy created" : "Pencil export failed",
        message.ok,
      );
      exportCopy.disabled = !pendingExportPlan;
      if (!message.ok) detail.textContent = message.message;
      else
        detail.textContent = `Created and mapped ${message.nodeCount} editable nodes in Pencil as ${message.rootId}.`;
    }
    if (message.type === "figma-export-adopted") {
      setStatus(
        message.ok ? "Pencil copy adopted" : "Pencil adoption failed",
        message.ok,
      );
      adoptCopy.disabled = false;
      if (!message.ok) detail.textContent = message.message;
      else {
        detail.textContent = `Mapped ${message.nodeCount} nodes from Pencil root ${message.rootId} at manifest revision ${message.manifest.revision}.`;
        previewSync.disabled = false;
      }
    }
    if (message.type === "figma-sync-preview") {
      setStatus(
        message.ok
          ? message.canApplyWithoutResolution
            ? "Sync preview ready"
            : "Sync needs attention"
          : "Sync preview failed",
        Boolean(message.ok),
      );
      pendingSyncPreview = message.ok ? message : undefined;
      const conflicts = message.ok ? (message.conflictRoots ?? []) : [];
      pendingConflict = conflicts[0];
      conflictPanel.hidden = !pendingConflict;
      if (pendingConflict) {
        conflictSummary.textContent = `${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"} found. Resolve ${pendingConflict.bridgeId} by choosing which editor wins. The other editor will be updated atomically.`;
      }
      if (message.actions.toPencil > 0 && message.actions.toFigma === 0)
        applySync.textContent = "Apply Figma changes to Pencil…";
      else if (message.actions.toFigma > 0 && message.actions.toPencil === 0)
        applySync.textContent = "Apply Pencil changes to Figma…";
      else applySync.textContent = "Apply mapped changes…";
      applySync.disabled = !canApplySyncPreview(message);
      if (!message.ok) detail.textContent = message.message;
      else if (message.baselineUpgradeRequired)
        detail.textContent =
          "This mapping predates dual baselines. Adopt the same Pencil root once more, then preview again.";
      else if (message.unsupportedReason)
        detail.textContent = message.unsupportedReason;
      else
        detail.textContent = `To Pencil: ${message.actions.toPencil}. To Figma: ${message.actions.toFigma}. Conflicts: ${message.actions.conflicts}.`;
    }
    if (message.type === "figma-sync-result") {
      setStatus(
        message.ok
          ? message.operation === "unchanged"
            ? "Already synchronized"
            : message.operation === "resolved-keep-pen"
              ? "Kept Pencil version"
              : message.operation === "resolved-keep-figma"
                ? "Kept Figma version"
                : message.operation === "updated-figma"
                  ? "Figma updated"
                  : "Pencil updated"
          : "Sync apply failed",
        message.ok,
      );
      if (!message.ok) {
        detail.textContent = message.message;
        keepPencil.disabled = false;
        keepFigma.disabled = false;
        cancelConflict.disabled = false;
        applySync.disabled = !canApplySyncPreview(pendingSyncPreview);
      } else {
        pendingSyncPreview = undefined;
        applySync.disabled = true;
        hideConflict();
        detail.textContent =
          message.operation === "unchanged"
            ? "No Pencil updates were required."
            : `${message.operation === "resolved-keep-pen" || message.operation === "updated-figma" ? "Updated Figma from Pencil" : "Updated Pencil from Figma"} for ${message.updatedNodeCount} node${message.updatedNodeCount === 1 ? "" : "s"}; manifest revision ${message.manifest.revision}.`;
      }
    }
  }
};

function canApplySyncPreview(message: any): boolean {
  if (!message?.ok || message.baselineUpgradeRequired) return false;
  const toPencil = Number(message.actions?.toPencil ?? 0);
  const toFigma = Number(message.actions?.toFigma ?? 0);
  return Boolean(
    message.canApplyWithoutResolution &&
    ((toPencil > 0 && toFigma === 0) || (toFigma > 0 && toPencil === 0)) &&
    message.actions?.conflicts === 0 &&
    message.actions?.unmapped === 0,
  );
}

function resolveConflict(direction: "pen" | "figma"): void {
  if (!token || !pendingConflict) return;
  const winner = direction === "pen" ? "Pencil" : "Figma";
  if (
    !confirm(
      `Keep the ${winner} version for ${pendingConflict.bridgeId}?\n\nThe conflicting mapped subtree in the other editor will be updated in one undoable transaction.`,
    )
  )
    return;
  keepPencil.disabled = true;
  keepFigma.disabled = true;
  cancelConflict.disabled = true;
  setStatus(`Keeping ${winner}…`, true);
  parent.postMessage(
    {
      pluginMessage: {
        type: "resolve-mapped-sync",
        token,
        direction,
        bridgeId: pendingConflict.bridgeId,
      },
    },
    "*",
  );
}

function hideConflict(): void {
  pendingConflict = undefined;
  conflictPanel.hidden = true;
  keepPencil.disabled = false;
  keepFigma.disabled = false;
  cancelConflict.disabled = false;
}

function renderScreens(text: string): void {
  screenList.replaceChildren();
  const screens = text
    .split("\n")
    .map((line) => /^([A-Za-z0-9]+)\s+\|\s+(.+?)\s*$/.exec(line))
    .filter((match): match is RegExpExecArray => Boolean(match));
  for (const match of screens) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `${match[2] ?? "Untitled"} · ${match[1] ?? "?"}`;
    button.addEventListener("click", () => void importScreen(match[1]!));
    screenList.append(button);
  }
}

async function importScreen(nodeId: string): Promise<void> {
  try {
    setStatus("Reading Pen…", true);
    const message = await request(`/pen/nodes/${nodeId}`, { method: "GET" });
    const document = message.document;
    pendingImport = {
      document,
      assetData: message.assetData ?? {},
      transferId: message.transferId,
    };
    setStatus("Planning changes…", true);
    parent.postMessage(
      {
        pluginMessage: {
          type: "preview-document",
          document,
        },
      },
      "*",
    );
  } catch (error) {
    showError(error);
  }
}

async function connect(code: string): Promise<void> {
  setStatus("Connecting…", false);
  try {
    const paired = await request("/pair", {
      method: "POST",
      body: JSON.stringify({ type: "pair", protocol: 1, code }),
      authenticated: false,
    });
    token = paired.token;
    const ready = await request("/hello", { method: "POST" });
    setStatus("Connected", true);
    detail.textContent = ready.penState;
    actions.hidden = false;
    form.hidden = true;
    previewSync.disabled = false;
  } catch (error) {
    showError(error);
  }
}

async function request(
  path: string,
  options: { method: "GET" | "POST"; body?: string; authenticated?: boolean },
): Promise<any> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (options.authenticated !== false && token)
    headers["x-pen-fig-token"] = token;
  const url = new URL(`http://localhost:32145${path}`);
  if (options.authenticated !== false && token)
    url.searchParams.set("token", token);
  const response = await fetch(url.toString(), {
    method: options.method,
    headers,
    ...(options.body ? { body: options.body } : {}),
  });
  const message = await response.json();
  output.textContent = JSON.stringify(message, null, 2);
  if (!response.ok)
    throw new Error(message.message ?? `Bridge error ${response.status}`);
  return message;
}

function showError(error: unknown): void {
  setStatus("Disconnected", false);
  detail.textContent =
    error instanceof Error ? error.message : "Connection failed";
  actions.hidden = true;
  form.hidden = false;
}

function setStatus(text: string, connected: boolean): void {
  statusBadge.textContent = text;
  statusBadge.className = `badge ${connected ? "connected" : "disconnected"}`;
}

function required<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

export {};
