const form = required<HTMLFormElement>("pair-form");
const input = required<HTMLInputElement>("pair-code");
const statusBadge = required<HTMLElement>("status");
const detail = required<HTMLElement>("detail");
const actions = required<HTMLElement>("actions");
const output = required<HTMLElement>("output");
const screenList = required<HTMLElement>("screen-list");
const screenQuery = required<HTMLInputElement>("screen-query");
let token: string | undefined;

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
required("write-test").addEventListener("click", () =>
  parent.postMessage({ pluginMessage: { type: "reversible-write-test" } }, "*"),
);

window.onmessage = (event) => {
  const message = event.data.pluginMessage;
  if (message) {
    output.textContent = JSON.stringify(message, null, 2);
    if (message.type === "import-result") {
      setStatus(message.ok ? "Imported" : "Import failed", message.ok);
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
    const nodeCount = countNodes(document.root);
    const warningText = document.warnings.length
      ? `\n\nWarnings:\n${document.warnings.map((warning: any) => `• ${warning.message}`).join("\n")}`
      : "";
    if (
      !confirm(
        `Import “${document.root.name}” with ${nodeCount} editable nodes?${warningText}`,
      )
    ) {
      setStatus("Connected", true);
      return;
    }
    setStatus("Writing Figma…", true);
    parent.postMessage(
      {
        pluginMessage: {
          type: "apply-document",
          document,
          assetData: message.assetData ?? {},
        },
      },
      "*",
    );
  } catch (error) {
    showError(error);
  }
}

function countNodes(node: any): number {
  return (
    1 +
    (node.children ?? []).reduce(
      (total: number, child: any) => total + countNodes(child),
      0,
    )
  );
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
