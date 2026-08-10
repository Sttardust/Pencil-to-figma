import {
  assessCompanionHealth,
  editableNodeSummary,
  friendlyWarning,
  presentSync,
  technicalJson,
} from "./presentation.js";
import { copyText } from "./clipboard.js";

const form = required<HTMLFormElement>("pair-form");
const pairInput = required<HTMLInputElement>("pair-code");
const statusBadge = required<HTMLElement>("status");
const connection = required<HTMLElement>("connection");
const connectionHelp = required<HTMLElement>("connection-help");
const connectionTitle = required<HTMLElement>("connection-title");
const workspace = required<HTMLElement>("workspace");
const detail = required<HTMLElement>("detail");
const output = required<HTMLElement>("output");
const screenList = required<HTMLElement>("screen-list");
const screenQuery = required<HTMLInputElement>("screen-query");
const importReview = required<HTMLElement>("import-review");
const importReviewTitle = required<HTMLElement>("import-review-title");
const importReviewSummary = required<HTMLElement>("import-review-summary");
const importWarnings = required<HTMLElement>("import-warnings");
const confirmImport = required<HTMLButtonElement>("confirm-import");
const prepareExport = required<HTMLButtonElement>("prepare-export");
const exportReview = required<HTMLElement>("export-review");
const exportReviewTitle = required<HTMLElement>("export-review-title");
const exportReviewSummary = required<HTMLElement>("export-review-summary");
const exportWarnings = required<HTMLElement>("export-warnings");
const confirmExport = required<HTMLButtonElement>("confirm-export");
const adoptRootId = required<HTMLInputElement>("adopt-root-id");
const adoptCopy = required<HTMLButtonElement>("adopt-copy");
const compareSync = required<HTMLButtonElement>("compare-sync");
const syncReview = required<HTMLElement>("sync-review");
const syncReviewTitle = required<HTMLElement>("sync-review-title");
const syncReviewSummary = required<HTMLElement>("sync-review-summary");
const comparison = required<HTMLElement>("comparison");
const pencilChangeCount = required<HTMLElement>("pencil-change-count");
const figmaChangeCount = required<HTMLElement>("figma-change-count");
const applySync = required<HTMLButtonElement>("apply-sync");
const conflictPanel = required<HTMLElement>("conflict-panel");
const conflictSummary = required<HTMLElement>("conflict-summary");
const keepPencil = required<HTMLButtonElement>("keep-pencil");
const keepFigma = required<HTMLButtonElement>("keep-figma");
const cancelConflict = required<HTMLButtonElement>("cancel-conflict");
const copyJson = required<HTMLButtonElement>("copy-json");
const technicalDetails = required<HTMLElement>("technical-details");
const advancedDialog = required<HTMLElement>("advanced-dialog");
const utilityBackdrop = required<HTMLElement>("utility-backdrop");
const moreMenuButton = required<HTMLButtonElement>("more-menu-button");
const moreMenuPopover = required<HTMLElement>("more-menu-popover");
const openAdvanced = required<HTMLButtonElement>("open-advanced");
const openJson = required<HTMLButtonElement>("open-json");
const retryConnection = required<HTMLButtonElement>("retry-connection");
const authorizeConnection = required<HTMLButtonElement>("authorize-connection");
const manualPairing = required<HTMLDetailsElement>("manual-pairing");
const downloadCompanion = required<HTMLButtonElement>("download-companion");
const recentExportsPanel = required<HTMLElement>("recent-exports");
const recentExportList = required<HTMLElement>("recent-export-list");
const copyExportIds = required<HTMLButtonElement>("copy-export-ids");
const clearRecentExports = required<HTMLButtonElement>("clear-recent-exports");

let token: string | undefined;
let savedReconnectToken: string | undefined;
let reconciliationRequired = false;
let pendingExportPreview: any;
let pendingExportPlan: any;
let pendingSyncPreview: any;
let pendingConflict: any;
let recentPencilExports: any[] = [];
let pendingImport:
  | {
      document: any;
      assetData: Record<string, string>;
      transferId: string;
    }
  | undefined;

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void connect(pairInput.value.trim().toUpperCase());
});

retryConnection.addEventListener("click", () => {
  if (savedReconnectToken) void reconnect(savedReconnectToken);
  else void requestApproval();
});

authorizeConnection.addEventListener("click", () => void requestApproval());
downloadCompanion.addEventListener("click", () => {
  parent.postMessage(
    { pluginMessage: { type: "open-companion-download" } },
    "*",
  );
});

required("screens").addEventListener("click", () => void loadScreens());
required("selected-screens").addEventListener(
  "click",
  () => void loadSelectedScreens(),
);
required("search-screens").addEventListener(
  "click",
  () => void searchScreens(),
);
screenQuery.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void searchScreens();
  }
});

confirmImport.addEventListener("click", () => {
  if (!pendingImport) return;
  confirmImport.disabled = true;
  setStatus("Sending to Figma…", "working");
  setActivity("Creating the editable Figma design…");
  parent.postMessage(
    {
      pluginMessage: {
        type: "apply-document",
        document: pendingImport.document,
        assetData: pendingImport.assetData,
      },
    },
    "*",
  );
});

required("cancel-import").addEventListener("click", () => {
  pendingImport = undefined;
  importReview.hidden = true;
  setStatus("Connected", "success");
  setActivity("Transfer cancelled. No Figma layers were changed.");
});

prepareExport.addEventListener("click", () => {
  pendingExportPreview = undefined;
  pendingExportPlan = undefined;
  exportReview.hidden = true;
  adoptCopy.disabled = true;
  prepareExport.disabled = true;
  setStatus("Reviewing selection…", "working");
  setActivity(
    "Reading the selected Figma screens and checking their contents…",
  );
  parent.postMessage({ pluginMessage: { type: "preview-figma-export" } }, "*");
});

confirmExport.addEventListener("click", () => {
  if (!pendingExportPlan || !token) return;
  confirmExport.disabled = true;
  setStatus("Sending to Pencil…", "working");
  const screenCount = Number(pendingExportPlan.screenCount ?? 1);
  setActivity(
    screenCount === 1
      ? "Creating a new editable copy in open canvas space…"
      : `Creating ${screenCount} editable copies in open canvas space…`,
  );
  parent.postMessage(
    { pluginMessage: { type: "execute-figma-export", token } },
    "*",
  );
});

required("cancel-export").addEventListener("click", () => {
  pendingExportPlan = undefined;
  exportReview.hidden = true;
  setStatus("Connected", "success");
  setActivity("Transfer cancelled. No Pencil layers were changed.");
});

adoptCopy.addEventListener("click", () => {
  const penRootId = adoptRootId.value.trim();
  if (!token || !/^[A-Za-z0-9]+$/.test(penRootId)) {
    setActivity("Enter the Pencil page ID you want to link.");
    return;
  }
  adoptCopy.disabled = true;
  setStatus("Linking copy…", "working");
  setActivity(
    "Saving the relationship between the selected Figma frame and Pencil copy…",
  );
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

compareSync.addEventListener("click", () => {
  if (!token) return;
  compareSync.disabled = true;
  syncReview.hidden = true;
  hideConflict();
  setStatus("Comparing…", "working");
  setActivity(
    "Comparing the selected Figma frame with its linked Pencil design…",
  );
  parent.postMessage(
    { pluginMessage: { type: "preview-mapped-sync", token } },
    "*",
  );
});

applySync.addEventListener("click", () => {
  if (!token || !pendingSyncPreview) return;
  applySync.disabled = true;
  const target = Number(pendingSyncPreview.actions?.toPencil ?? 0)
    ? "Pencil"
    : "Figma";
  setStatus(`Updating ${target}…`, "working");
  setActivity(
    `Applying the reviewed changes to ${target} in one undoable update…`,
  );
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
  applySync.hidden = true;
  setStatus("Connected", "success");
  setActivity("No changes were made. You can compare again when ready.");
  setTechnical({
    type: "figma-sync-result",
    ok: true,
    operation: "cancelled",
    writes: 0,
  });
});

required("selection").addEventListener("click", () =>
  parent.postMessage({ pluginMessage: { type: "selection-summary" } }, "*"),
);
required("write-test").addEventListener("click", () =>
  parent.postMessage({ pluginMessage: { type: "reversible-write-test" } }, "*"),
);
required("forget-connection").addEventListener("click", () => {
  token = undefined;
  savedReconnectToken = undefined;
  parent.postMessage(
    { pluginMessage: { type: "clear-saved-connection" } },
    "*",
  );
  workspace.hidden = true;
  connection.hidden = false;
  showAuthorizationReady("The saved connection was removed.");
  setStatus("Not connected", "neutral");
  closeUtilityPanel();
});

moreMenuButton.addEventListener("click", (event) => {
  event.stopPropagation();
  setMoreMenuOpen(moreMenuPopover.hidden);
});
moreMenuPopover.addEventListener("click", (event) => event.stopPropagation());
openAdvanced.addEventListener("click", () => openUtilityPanel("advanced"));
openJson.addEventListener("click", () => openUtilityPanel("json"));
for (const button of document.querySelectorAll<HTMLButtonElement>(
  ".close-utility",
))
  button.addEventListener("click", closeUtilityPanel);
utilityBackdrop.addEventListener("click", (event) => {
  if (event.target === utilityBackdrop) closeUtilityPanel();
});
document.addEventListener("click", () => setMoreMenuOpen(false));
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!utilityBackdrop.hidden) closeUtilityPanel();
  else setMoreMenuOpen(false);
});

copyJson.addEventListener("click", () => void copyTechnicalJson());
copyExportIds.addEventListener("click", () => void copyRecentExportIds());
clearRecentExports.addEventListener("click", () => {
  parent.postMessage({ pluginMessage: { type: "clear-recent-exports" } }, "*");
});

window.onmessage = (event) => {
  const message = event.data.pluginMessage;
  if (!message) return;
  setTechnical(message);

  if (message.type === "saved-connection") {
    const credentials = message.credentials;
    if (
      credentials &&
      typeof credentials.reconnectToken === "string" &&
      typeof credentials.sessionToken === "string"
    ) {
      savedReconnectToken = credentials.reconnectToken;
      void reconnect(credentials.reconnectToken);
    } else void requestApproval();
    return;
  }

  if (message.type === "selection-summary") {
    const count = Array.isArray(message.nodes) ? message.nodes.length : 0;
    setActivity(
      count === 1
        ? `Selected “${message.nodes[0]?.name ?? "Untitled"}”.`
        : `${count} Figma layers are selected. They can belong to one or more screens.`,
    );
  }

  if (message.type === "write-test-result") {
    setStatus(
      message.ok ? "Write access works" : "Write test failed",
      message.ok ? "success" : "error",
    );
    setActivity(
      message.ok
        ? "Figma write access is working. The temporary test layer was removed."
        : "Figma did not allow the reversible write test.",
    );
  }

  if (message.type === "recent-pencil-exports")
    renderRecentPencilExports(message.exports);

  if (message.type === "import-preview") handleImportPreview(message);
  if (message.type === "import-result") handleImportResult(message);
  if (message.type === "figma-export-preview")
    handleFigmaExportPreview(message);
  if (message.type === "figma-export-plan") handleFigmaExportPlan(message);
  if (message.type === "figma-export-progress")
    handleFigmaExportProgress(message);
  if (message.type === "figma-export-result") handleFigmaExportResult(message);
  if (message.type === "figma-export-adopted") handleAdoptResult(message);
  if (message.type === "figma-sync-preview") handleSyncPreview(message);
  if (message.type === "figma-sync-result") handleSyncResult(message);
};

function handleImportPreview(message: any): void {
  if (!message.ok) {
    pendingImport = undefined;
    confirmImport.disabled = false;
    importReview.hidden = true;
    showOperationError(
      message.message ?? "This Pencil screen could not be reviewed.",
    );
    return;
  }
  const counts = message.operations ?? {};
  importReviewTitle.textContent =
    message.operation === "created"
      ? "Ready to create a Figma copy"
      : message.operation === "unchanged"
        ? "This screen is already in Figma"
        : "Ready to update the Figma copy";
  importReviewSummary.textContent =
    message.operation === "created"
      ? `${editableNodeSummary(Number(counts.create ?? message.nodeCount ?? 0))} will be created in open canvas space.`
      : message.operation === "unchanged"
        ? "No design changes were found. Continue to select and refresh its saved link."
        : `${message.nodeCount} change${message.nodeCount === 1 ? "" : "s"} will be applied to the existing Figma copy.`;
  renderWarnings(importWarnings, message.warnings);
  confirmImport.textContent =
    message.operation === "unchanged" ? "Open existing copy" : "Send to Figma";
  confirmImport.disabled = false;
  importReview.hidden = false;
  setStatus("Ready to send", "success");
  setActivity("Review the summary, then send when you are ready.");
}

function handleImportResult(message: any): void {
  confirmImport.disabled = false;
  if (!message.ok) {
    showOperationError(
      message.message ?? "The Pencil screen could not be sent to Figma.",
    );
    return;
  }
  const completedImport = pendingImport;
  pendingImport = undefined;
  importReview.hidden = true;
  if (!completedImport) {
    setStatus("Sent, but not linked", "error");
    setActivity(
      "The Figma copy was created, but its sync link could not be saved.",
    );
    return;
  }
  setStatus("Saving link…", "working");
  setActivity("The Figma design is ready. Saving its Pencil connection…");
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
      setTechnical({ ...message, manifest: committed });
      setStatus("Sent to Figma", "success");
      const mappedCount = Array.isArray(message.mappings)
        ? message.mappings.length
        : Number(message.nodeCount ?? 0);
      setActivity(
        `${editableNodeSummary(mappedCount)} are ready in Figma and linked for future comparisons.`,
      );
    })
    .catch((error) => {
      setStatus("Sent, but link failed", "error");
      setActivity(errorMessage(error, "The sync link could not be saved."));
    });
}

function handleFigmaExportPreview(message: any): void {
  if (!message.ok) {
    prepareExport.disabled = false;
    pendingExportPreview = undefined;
    showOperationError(
      message.message ??
        "Select one or more Figma screens, or layers inside them, and try again.",
    );
    return;
  }
  pendingExportPreview = message;
  adoptCopy.disabled = Number(message.screenCount ?? 1) !== 1;
  setStatus("Preparing summary…", "working");
  setActivity(
    Number(message.screenCount ?? 1) === 1
      ? "The screen is readable. Checking the transfer size and warnings…"
      : `${message.screenCount} screens are readable. Checking the transfer size and warnings…`,
  );
  parent.postMessage({ pluginMessage: { type: "plan-figma-export" } }, "*");
}

function handleFigmaExportPlan(message: any): void {
  prepareExport.disabled = false;
  if (!message.ok) {
    pendingExportPlan = undefined;
    exportReview.hidden = true;
    showOperationError(
      message.message ?? "The Pencil transfer could not be prepared.",
    );
    return;
  }
  pendingExportPlan = message;
  const counts = message.counts ?? {};
  const screenCount = Number(message.screenCount ?? 1);
  const name = pendingExportPreview?.root?.name ?? "Selected frame";
  exportReviewTitle.textContent =
    screenCount === 1
      ? `Send “${name}” to Pencil?`
      : `Send ${screenCount} screens to Pencil?`;
  exportReviewSummary.textContent = `${editableNodeSummary(Number(counts.inserts ?? 0))} and ${Number(counts.assets ?? 0)} asset${Number(counts.assets ?? 0) === 1 ? "" : "s"} will be placed as ${screenCount === 1 ? "one copy" : `${screenCount} separate copies`} in open canvas space.`;
  renderWarnings(exportWarnings, message.warnings);
  confirmExport.textContent =
    screenCount === 1
      ? "Send copy to Pencil"
      : `Send ${screenCount} screens to Pencil`;
  confirmExport.disabled = false;
  exportReview.hidden = false;
  setStatus("Ready to send", "success");
  setActivity("Review the summary, then send when you are ready.");
}

function handleFigmaExportProgress(message: any): void {
  const total = Number(message.total ?? 1);
  const completed = Number(message.completed ?? 0);
  const currentName = String(message.currentName ?? "next screen");
  setStatus(`Sending ${completed + 1} of ${total}…`, "working");
  setActivity(`Creating “${currentName}” in Pencil…`);
}

function handleFigmaExportResult(message: any): void {
  confirmExport.disabled = false;
  if (!message.ok) {
    const completed = Number(message.completedScreenCount ?? 0);
    const total = Number(message.screenCount ?? 1);
    if (completed > 0) {
      exportReview.hidden = true;
      setStatus("Partly sent", "error");
      setActivity(
        `${completed} of ${total} screens were created safely. “${message.failedScreenName ?? "The next screen"}” could not be sent: ${message.message ?? "Unknown error"}`,
      );
      return;
    }
    showOperationError(
      message.message ??
        "The selected Figma screens could not be sent to Pencil.",
    );
    return;
  }
  exportReview.hidden = true;
  setStatus("Sent to Pencil", "success");
  const screenCount = Number(message.screenCount ?? 1);
  setActivity(
    screenCount === 1
      ? `${editableNodeSummary(Number(message.nodeCount ?? 0))} were created in Pencil. Its page name and ID are listed below.`
      : `${screenCount} screens with ${editableNodeSummary(Number(message.nodeCount ?? 0))} were created together in Pencil. Their page names and IDs are listed below.`,
  );
}

function renderRecentPencilExports(value: unknown): void {
  recentPencilExports = Array.isArray(value)
    ? value.filter(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          typeof entry.name === "string" &&
          typeof entry.penRootId === "string" &&
          typeof entry.x === "number" &&
          typeof entry.y === "number",
      )
    : [];
  recentExportList.replaceChildren();
  for (const entry of recentPencilExports) {
    const item = document.createElement("div");
    item.className = "recent-export-item";
    const name = document.createElement("span");
    name.className = "recent-export-name";
    name.textContent = entry.name;
    name.title = `${entry.name}, canvas ${Math.round(entry.x)}, ${Math.round(entry.y)}`;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "quiet recent-export-id";
    copy.textContent = entry.penRootId;
    copy.title = `Copy Pencil page ID ${entry.penRootId}`;
    copy.addEventListener(
      "click",
      () => void copyPencilPageId(entry.penRootId, entry.name),
    );
    item.append(name, copy);
    recentExportList.append(item);
  }
  recentExportsPanel.hidden = recentPencilExports.length === 0;
}

async function copyPencilPageId(id: string, name: string): Promise<void> {
  if (await copyText(id)) {
    setActivity(`Copied the Pencil page ID for “${name}”: ${id}`);
  } else {
    setActivity(`Pencil page ID for “${name}”: ${id}`);
  }
}

async function copyRecentExportIds(): Promise<void> {
  const value = recentPencilExports
    .map(
      (entry) =>
        `${entry.name} | ${entry.penRootId} | canvas ${Math.round(entry.x)}, ${Math.round(entry.y)}`,
    )
    .join("\n");
  if (await copyText(value)) {
    copyExportIds.textContent = "Copied";
    setTimeout(
      () => (copyExportIds.textContent = "Copy page names and IDs"),
      1_200,
    );
    setActivity("Copied the recent Pencil page names, IDs, and positions.");
  } else {
    setActivity("The page list could not be copied. Click an individual ID.");
  }
}

function handleAdoptResult(message: any): void {
  adoptCopy.disabled = false;
  if (!message.ok) {
    showOperationError(
      message.message ?? "The existing Pencil copy could not be linked.",
    );
    return;
  }
  setStatus("Copy linked", "success");
  setActivity(
    "The existing Pencil and Figma designs are now linked for comparison.",
  );
}

function handleSyncPreview(message: any): void {
  compareSync.disabled = false;
  if (message.ok) reconciliationRequired = false;
  pendingSyncPreview = message.ok ? message : undefined;
  const presented = presentSync(message);
  syncReviewTitle.textContent = presented.title;
  syncReviewSummary.textContent = presented.summary;
  pencilChangeCount.textContent = String(presented.pencilChanges);
  figmaChangeCount.textContent = String(presented.figmaChanges);
  comparison.hidden =
    presented.pencilChanges === 0 && presented.figmaChanges === 0;
  applySync.hidden = !presented.canApply;
  applySync.disabled = !presented.canApply;
  applySync.textContent = presented.applyLabel ?? "Apply changes";
  syncReview.hidden = false;

  const conflicts = message.ok ? (message.conflictRoots ?? []) : [];
  pendingConflict = conflicts[0];
  conflictPanel.hidden = !pendingConflict;
  if (pendingConflict)
    conflictSummary.textContent = `${conflicts.length} area${conflicts.length === 1 ? " was" : "s were"} changed in both apps. Choose the version that should replace the other one.`;

  setStatus(
    !message.ok
      ? "Comparison failed"
      : pendingConflict
        ? "Choose a version"
        : "Comparison ready",
    !message.ok ? "error" : pendingConflict ? "neutral" : "success",
  );
  setActivity(presented.summary);
}

function handleSyncResult(message: any): void {
  if (!message.ok) {
    showOperationError(
      message.message ?? "The reviewed changes could not be applied.",
    );
    if (pendingSyncPreview) {
      const presented = presentSync(pendingSyncPreview);
      applySync.hidden = !presented.canApply;
      applySync.disabled = !presented.canApply;
    }
    keepPencil.disabled = false;
    keepFigma.disabled = false;
    cancelConflict.disabled = false;
    return;
  }
  pendingSyncPreview = undefined;
  applySync.hidden = true;
  hideConflict();
  const destination =
    message.operation === "resolved-keep-pen" ||
    message.operation === "updated-figma"
      ? "Figma"
      : "Pencil";
  const unchanged = message.operation === "unchanged";
  syncReviewTitle.textContent = unchanged
    ? "Everything matches"
    : `${destination} updated`;
  syncReviewSummary.textContent = unchanged
    ? "Pencil and Figma already contain the same editable design."
    : `${message.updatedNodeCount} changed layer${message.updatedNodeCount === 1 ? " was" : "s were"} applied to ${destination}.`;
  syncReview.hidden = false;
  comparison.hidden = true;
  setStatus(
    unchanged ? "Already matched" : `${destination} updated`,
    "success",
  );
  setActivity(syncReviewSummary.textContent ?? "The designs are synchronized.");
}

async function loadScreens(): Promise<void> {
  setStatus("Loading screens…", "working");
  setActivity("Reading the available top-level Pencil screens…");
  try {
    const message = await request("/pen/screens", { method: "GET" });
    renderScreens(message.text);
    setStatus("Screens ready", "success");
  } catch (error) {
    showOperationError(
      errorMessage(error, "Pencil screens could not be loaded."),
    );
  }
}

async function loadSelectedScreens(): Promise<void> {
  setStatus("Reading Pencil selection…", "working");
  setActivity("Checking which top-level pages are selected in Pencil…");
  try {
    const message = await request("/pen/selection", { method: "GET" });
    const screens = parseScreens(message.text);
    if (screens.length === 1) {
      setActivity(`Found “${screens[0]!.name}”. Preparing it for Figma…`);
      await importScreen(screens[0]!.id);
      return;
    }
    renderScreens(message.text, "selection");
    setStatus(
      screens.length ? "Selection ready" : "Nothing selected",
      screens.length ? "success" : "neutral",
    );
  } catch (error) {
    showOperationError(
      errorMessage(error, "The Pencil selection could not be read."),
    );
  }
}

async function searchScreens(): Promise<void> {
  const query = screenQuery.value.trim();
  if (!query) {
    setActivity("Enter a screen name or browse all Pencil screens.");
    return;
  }
  const directId = /^id:([A-Za-z0-9]+)$/i.exec(query)?.[1];
  if (directId) {
    await importScreen(directId);
    return;
  }
  setStatus("Searching…", "working");
  try {
    const message = await request(
      `/pen/screen-search?query=${encodeURIComponent(query)}`,
      { method: "GET" },
    );
    renderScreens(message.text);
    setStatus("Search ready", "success");
  } catch (error) {
    showOperationError(errorMessage(error, "The Pencil search failed."));
  }
}

function renderScreens(
  text: string,
  source: "browse" | "selection" = "browse",
): void {
  screenList.replaceChildren();
  const screens = parseScreens(text);
  if (!screens.length) {
    const empty = document.createElement("p");
    empty.textContent =
      source === "selection"
        ? "No top-level Pencil pages are selected."
        : "No matching Pencil pages were found.";
    screenList.append(empty);
    setActivity(
      source === "selection"
        ? "In Pencil, select one or more complete page frames, then try again."
        : "No matching pages were found. Try a shorter name.",
    );
    return;
  }
  for (const screen of screens) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = screen.name;
    button.addEventListener("click", () => void importScreen(screen.id));
    screenList.append(button);
  }
  setActivity(
    source === "selection"
      ? `${screens.length} selected Pencil page${screens.length === 1 ? "" : "s"} found. Choose one to review.`
      : `${screens.length} Pencil page${screens.length === 1 ? "" : "s"} found. Choose one to review.`,
  );
}

function parseScreens(text: unknown): { id: string; name: string }[] {
  return String(text ?? "")
    .split("\n")
    .map((line) => /^([A-Za-z0-9]+)\s+\|\s+(.+?)\s*$/.exec(line))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => ({ id: match[1]!, name: match[2] ?? "Untitled" }));
}

async function importScreen(nodeId: string): Promise<void> {
  try {
    importReview.hidden = true;
    setStatus("Reviewing screen…", "working");
    setActivity(
      "Reading the Pencil screen and checking what Figma will create…",
    );
    const message = await request(`/pen/nodes/${nodeId}`, { method: "GET" });
    pendingImport = {
      document: message.document,
      assetData: message.assetData ?? {},
      transferId: message.transferId,
    };
    parent.postMessage(
      {
        pluginMessage: { type: "preview-document", document: message.document },
      },
      "*",
    );
  } catch (error) {
    pendingImport = undefined;
    showOperationError(
      errorMessage(error, "The Pencil screen could not be reviewed."),
    );
  }
}

async function connect(code: string): Promise<void> {
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    showConnectionError(
      "Enter the six-character code shown by the bridge service.",
      "manual",
    );
    return;
  }
  setStatus("Connecting…", "working");
  try {
    const paired = await request("/pair", {
      method: "POST",
      body: JSON.stringify({ type: "pair", protocol: 1, code }),
      authenticated: false,
    });
    await finishConnection(paired);
  } catch (error) {
    if (
      error instanceof BridgeRequestError &&
      error.code === "CONNECTION_PEN" &&
      savedReconnectToken
    ) {
      showConnectionError(
        "The bridge is running, but Pencil is not ready. Open Pencil and a .pen file, then try again.",
        "retry",
      );
      return;
    }
    showConnectionError(errorMessage(error, "Connection failed."), "manual");
  }
}

async function requestApproval(): Promise<void> {
  setStatus("Looking for Pencil Bridge…", "working");
  connection.hidden = false;
  workspace.hidden = true;
  authorizeConnection.hidden = true;
  retryConnection.hidden = true;
  downloadCompanion.hidden = true;
  manualPairing.hidden = true;
  connectionHelp.textContent = "Checking the companion app on this Mac…";
  try {
    await requireCompatibleCompanion();
    setStatus("Waiting for approval…", "working");
    connectionHelp.textContent =
      "Check the macOS message and choose Allow to connect this plugin.";
    const approved = await request("/authorize", {
      method: "POST",
      body: JSON.stringify({ type: "authorize", protocol: 1 }),
      authenticated: false,
    });
    await finishConnection(approved);
  } catch (error) {
    if (showCompanionProblem(error)) return;
    if (error instanceof BridgeRequestError) {
      if (error.code === "AUTH_APPROVAL_DENIED") {
        showConnectionError(
          "Connection was cancelled. Choose Connect to Pencil when you are ready.",
          "approve",
        );
        return;
      }
      if (error.code === "AUTH_APPROVAL_BUSY") {
        showConnectionError(
          "A macOS approval message is already open. Respond to it, then try again.",
          "approve",
        );
        return;
      }
      if (error.code === "AUTH_APPROVAL_RATE_LIMITED") {
        showConnectionError(
          "Please wait a few seconds, then choose Connect to Pencil again.",
          "approve",
        );
        return;
      }
      if (error.code === "AUTH_APPROVAL_UNAVAILABLE") {
        showConnectionError(
          "Automatic approval is unavailable in this development build. Use the fallback pairing code.",
          "manual",
        );
        return;
      }
      if (error.code === "CONNECTION_PEN") {
        showPencilNotReady();
        return;
      }
    }
    showCompanionProblem(new CompanionProblem("missing"));
  }
}

async function reconnect(reconnectToken: string): Promise<void> {
  setStatus("Looking for Pencil Bridge…", "working");
  connection.hidden = false;
  workspace.hidden = true;
  authorizeConnection.hidden = true;
  manualPairing.hidden = true;
  retryConnection.hidden = true;
  downloadCompanion.hidden = true;
  connectionHelp.textContent = "Checking the companion app on this Mac…";
  try {
    await requireCompatibleCompanion();
    setStatus("Connecting…", "working");
    connectionHelp.textContent = "Reconnecting securely to Pencil Bridge…";
    const reconnected = await request("/reconnect", {
      method: "POST",
      body: JSON.stringify({
        type: "reconnect",
        protocol: 1,
        reconnectToken,
      }),
      authenticated: false,
    });
    await finishConnection(reconnected);
  } catch (error) {
    if (showCompanionProblem(error)) return;
    if (
      error instanceof BridgeRequestError &&
      error.code === "AUTH_RECONNECT"
    ) {
      savedReconnectToken = undefined;
      parent.postMessage(
        { pluginMessage: { type: "clear-saved-connection" } },
        "*",
      );
      void requestApproval();
      return;
    }
    if (
      error instanceof BridgeRequestError &&
      error.code === "CONNECTION_PEN"
    ) {
      showPencilNotReady();
      return;
    }
    showCompanionProblem(new CompanionProblem("missing"));
  }
}

async function requireCompatibleCompanion(): Promise<void> {
  let health: any;
  try {
    health = await request("/health", {
      method: "GET",
      authenticated: false,
    });
  } catch {
    throw new CompanionProblem("missing");
  }
  const compatibility = assessCompanionHealth(health);
  if (!compatibility.compatible)
    throw new CompanionProblem("update", compatibility.version);
  reconciliationRequired = health?.reconciliationRequired === true;
}

async function finishConnection(credentials: any): Promise<void> {
  if (
    typeof credentials.token !== "string" ||
    typeof credentials.reconnectToken !== "string"
  )
    throw new Error("The bridge returned invalid connection credentials.");
  token = credentials.token;
  savedReconnectToken = credentials.reconnectToken;
  parent.postMessage(
    {
      pluginMessage: {
        type: "save-connection",
        sessionToken: token,
        reconnectToken: savedReconnectToken,
      },
    },
    "*",
  );
  await request("/hello", { method: "POST" });
  connection.hidden = true;
  workspace.hidden = false;
  setStatus("Connected", "success");
  setActivity(
    reconciliationRequired
      ? "A previous transfer stopped unexpectedly. Compare its linked design before sending more changes."
      : "Pencil is ready. Choose what you want to move.",
  );
}

function resolveConflict(direction: "pen" | "figma"): void {
  if (!token || !pendingConflict) return;
  const winner = direction === "pen" ? "Pencil" : "Figma";
  keepPencil.disabled = true;
  keepFigma.disabled = true;
  cancelConflict.disabled = true;
  setStatus(`Using ${winner}…`, "working");
  setActivity(`Updating the other app with the ${winner} version…`);
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

function renderWarnings(target: HTMLElement, warnings: unknown): void {
  target.replaceChildren();
  if (!Array.isArray(warnings)) return;
  const messages = [...new Set(warnings.map(friendlyWarning))];
  for (const message of messages) {
    const item = document.createElement("li");
    item.textContent = message;
    target.append(item);
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
  const response = await fetch(`http://localhost:32145${path}`, {
    method: options.method,
    headers,
    ...(options.body ? { body: options.body } : {}),
  });
  const message = await response.json();
  setTechnical(message);
  if (!response.ok)
    throw new BridgeRequestError(
      message.message ?? `Bridge error ${response.status}`,
      response.status,
      typeof message.code === "string" ? message.code : undefined,
      typeof message.phase === "string" ? message.phase : undefined,
      message.retrySafe === true,
    );
  return message;
}

function setTechnical(message: unknown): void {
  output.textContent = technicalJson(message);
}

async function copyTechnicalJson(): Promise<void> {
  const value = output.textContent ?? "";
  if (await copyText(value)) {
    copyJson.textContent = "Copied";
    setTimeout(() => (copyJson.textContent = "Copy JSON"), 1_200);
    setActivity("JSON copied to the clipboard.");
  } else {
    openUtilityPanel("json");
    selectTechnicalJson();
    setActivity("JSON is selected. Press ⌘C to copy it.");
  }
}

function setMoreMenuOpen(open: boolean): void {
  moreMenuPopover.hidden = !open;
  moreMenuButton.setAttribute("aria-expanded", String(open));
}

function openUtilityPanel(panel: "advanced" | "json"): void {
  setMoreMenuOpen(false);
  utilityBackdrop.hidden = false;
  advancedDialog.hidden = panel !== "advanced";
  technicalDetails.hidden = panel !== "json";
  const dialog = panel === "advanced" ? advancedDialog : technicalDetails;
  dialog.querySelector<HTMLButtonElement>(".close-utility")?.focus();
}

function closeUtilityPanel(): void {
  utilityBackdrop.hidden = true;
  advancedDialog.hidden = true;
  technicalDetails.hidden = true;
  moreMenuButton.focus();
}

function selectTechnicalJson(): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(output);
  selection.removeAllRanges();
  selection.addRange(range);
  output.focus();
}

function showConnectionError(
  message: string,
  action: "approve" | "retry" | "manual",
): void {
  token = undefined;
  connection.hidden = false;
  workspace.hidden = true;
  connectionTitle.textContent = "Connect to Pencil";
  setStatus("Not connected", "error");
  connectionHelp.textContent = message;
  authorizeConnection.hidden = action !== "approve";
  retryConnection.hidden = action !== "retry";
  retryConnection.textContent = "Try connecting again";
  downloadCompanion.hidden = true;
  manualPairing.hidden = action === "retry";
}

function showAuthorizationReady(message: string): void {
  connectionTitle.textContent = "Connect to Pencil";
  connectionHelp.textContent = message;
  authorizeConnection.hidden = false;
  retryConnection.hidden = true;
  retryConnection.textContent = "Try connecting again";
  downloadCompanion.hidden = true;
  manualPairing.hidden = false;
}

function showPencilNotReady(): void {
  token = undefined;
  connection.hidden = false;
  workspace.hidden = true;
  connectionTitle.textContent = "Open a Pencil design";
  connectionHelp.textContent =
    "Pencil Bridge is connected. Open Pencil and a .pen design, then check again.";
  setStatus("Waiting for Pencil", "neutral");
  authorizeConnection.hidden = true;
  retryConnection.hidden = false;
  retryConnection.textContent = "Check Pencil again";
  downloadCompanion.hidden = true;
  manualPairing.hidden = true;
}

function showCompanionProblem(error: unknown): boolean {
  if (!(error instanceof CompanionProblem)) return false;
  token = undefined;
  connection.hidden = false;
  workspace.hidden = true;
  connectionTitle.textContent =
    error.kind === "missing" ? "Install Pencil Bridge" : "Update Pencil Bridge";
  connectionHelp.textContent =
    error.kind === "missing"
      ? "Figma needs the small Pencil Bridge companion app to communicate with Pencil on this Mac."
      : `${error.version ? `Pencil Bridge ${error.version} is installed, but ` : ""}this plugin needs a newer companion app.`;
  setStatus("Setup needed", "neutral");
  authorizeConnection.hidden = true;
  retryConnection.hidden = false;
  retryConnection.textContent =
    error.kind === "missing" ? "I've installed it, check again" : "Check again";
  downloadCompanion.hidden = false;
  downloadCompanion.textContent =
    error.kind === "missing" ? "Download Pencil Bridge" : "Download update";
  manualPairing.hidden = true;
  return true;
}

function showOperationError(message: string): void {
  setStatus("Needs attention", "error");
  setActivity(message);
}

function setActivity(message: string): void {
  detail.textContent = message;
}

function setStatus(
  text: string,
  tone: "success" | "working" | "error" | "neutral",
): void {
  statusBadge.textContent = text;
  statusBadge.className = `badge ${tone}`;
}

function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  if (
    error instanceof BridgeRequestError &&
    error.retrySafe &&
    error.phase !== "connection"
  )
    return `${error.message} You can try this action again.`;
  return error.message;
}

class BridgeRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly phase?: string,
    readonly retrySafe = false,
  ) {
    super(message);
  }
}

class CompanionProblem extends Error {
  constructor(
    readonly kind: "missing" | "update",
    readonly version?: string,
  ) {
    super(
      kind === "missing"
        ? "Companion unavailable"
        : "Companion update required",
    );
  }
}

function required<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

export {};

parent.postMessage({ pluginMessage: { type: "load-saved-connection" } }, "*");
parent.postMessage({ pluginMessage: { type: "load-recent-exports" } }, "*");
