const form = required<HTMLFormElement>("pair-form");
const input = required<HTMLInputElement>("pair-code");
const statusBadge = required<HTMLElement>("status");
const detail = required<HTMLElement>("detail");
const actions = required<HTMLElement>("actions");
const output = required<HTMLElement>("output");
const screenList = required<HTMLElement>("screen-list");
const screenQuery = required<HTMLInputElement>("screen-query");
let token: string | undefined;
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
  setStatus("Reading Figma…", true);
  parent.postMessage({ pluginMessage: { type: "preview-figma-export" } }, "*");
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
    }
  }
};

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
