interface ClipboardDocument {
  body: {
    appendChild(node: ClipboardTextArea): unknown;
  };
  createElement(tagName: "textarea"): ClipboardTextArea;
  execCommand?(command: string): boolean;
}

interface ClipboardTextArea {
  value: string;
  style: {
    position: string;
    left: string;
    top: string;
    opacity: string;
    pointerEvents: string;
  };
  setAttribute(name: string, value: string): void;
  focus(): void;
  select(): void;
  remove(): void;
}

interface ClipboardNavigator {
  clipboard?: {
    writeText(value: string): Promise<void>;
  };
}

export interface ClipboardEnvironment {
  document: ClipboardDocument;
  navigator?: ClipboardNavigator;
}

export async function copyText(
  value: string,
  environment: ClipboardEnvironment = {
    document: document as unknown as ClipboardDocument,
    navigator: navigator as ClipboardNavigator,
  },
): Promise<boolean> {
  if (copyWithSelection(value, environment.document)) return true;

  try {
    const clipboard = environment.navigator?.clipboard;
    if (!clipboard) return false;
    await clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function copyWithSelection(
  value: string,
  clipboardDocument: ClipboardDocument,
): boolean {
  const textarea = clipboardDocument.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  clipboardDocument.body.appendChild(textarea);

  try {
    textarea.focus();
    textarea.select();
    return clipboardDocument.execCommand?.("copy") === true;
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}
