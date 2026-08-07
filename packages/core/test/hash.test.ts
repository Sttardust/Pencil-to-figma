import { describe, expect, it } from "vitest";
import { authoredDocumentHashes, importPenDocument } from "../src/index.js";

describe("authoredDocumentHashes", () => {
  it("ignores computed fallback bounds for hug sizing", () => {
    const first = importPenDocument(
      { id: "text", type: "text", content: "Hello", width: "fit_content(20)" },
      { documentId: "test.pen" },
    );
    const second = structuredClone(first);
    second.root.bounds.width = 999;
    if (second.root.width.mode !== "fixed") second.root.width.fallback = 999;

    expect(authoredDocumentHashes(second)).toEqual(
      authoredDocumentHashes(first),
    );
  });

  it("changes when authored text or child order changes", () => {
    const document = importPenDocument(
      {
        id: "root",
        type: "frame",
        children: [
          { id: "one", type: "text", content: "One" },
          { id: "two", type: "text", content: "Two" },
        ],
      },
      { documentId: "test.pen" },
    );
    const baseline = authoredDocumentHashes(document);
    const edited = structuredClone(document);
    edited.root.children[0]!.text!.characters = "Changed";
    edited.root.children.reverse();
    const changed = authoredDocumentHashes(edited);

    expect(changed["pen:one"]).not.toBe(baseline["pen:one"]);
    expect(changed["pen:root"]).not.toBe(baseline["pen:root"]);
    expect(changed["pen:two"]).toBe(baseline["pen:two"]);
  });
});
