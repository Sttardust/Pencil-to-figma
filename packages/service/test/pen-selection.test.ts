import { describe, expect, it } from "vitest";
import type { PenNode } from "@pen-fig/core";
import {
  attachResolvedBounds,
  parseResolvedBounds,
  resolvedBoundsLookupScripts,
  resolvedRootBoundsScript,
  selectedNodeIdsFromAppState,
  selectedRootFrameLookupScript,
} from "../src/pen/mcp-client.js";

describe("Pencil selection parsing", () => {
  it("attaches Pencil's resolved layout geometry to dynamic nodes", () => {
    const root: PenNode = {
      id: "screen",
      type: "frame",
      children: [{ id: "body", type: "frame" }],
    };
    const bounds = parseResolvedBounds(`
PEN_FIG_BOUNDS | screen | 100 | 200 | 393 | 875
PEN_FIG_BOUNDS | body | 0 | 110 | 393 | 673
`);

    attachResolvedBounds(root, bounds);

    expect(root.resolvedBounds).toEqual({
      x: 100,
      y: 200,
      width: 393,
      height: 875,
    });
    expect(root.children[0]?.resolvedBounds).toEqual({
      x: 0,
      y: 110,
      width: 393,
      height: 673,
    });
  });

  it("reads multiple selected node ids from app state", () => {
    expect(
      selectedNodeIdsFromAppState(`
- Currently active canvas editor: \`/design/orchid.pen\`
- Selected nodes: \`QMAml\` (frame): 01 · Invite, \`XW8AE\` (frame): 06 · About Her
- Top-level nodes: \`QMAml\` (frame): 01 · Invite
`),
    ).toEqual(["QMAml", "XW8AE"]);
  });

  it("returns an empty list when Pencil has no selection", () => {
    expect(
      selectedNodeIdsFromAppState("- Selected nodes: No nodes are selected"),
    ).toEqual([]);
  });

  it("does not mistake top-level nodes for selected nodes", () => {
    expect(
      selectedNodeIdsFromAppState(
        "- Top-level nodes: `QMAml` (frame): 01 · Invite",
      ),
    ).toEqual([]);
  });

  it("reads selected nodes directly without scanning the Pencil document", () => {
    const script = selectedRootFrameLookupScript(["mpCP3", "gpVUt"]);

    expect(script).toContain('let n0=Get("mpCP3")');
    expect(script).toContain('let n1=Get("gpVUt")');
    expect(script).not.toContain("Get((n,c)");
    expect(script).not.toContain("skipChildren");
  });

  it("measures only the selected page root before nested Pencil traversal", () => {
    const script = resolvedRootBoundsScript("mpCP3");

    expect(script).toContain('Get("mpCP3",(n,c)');
    expect(script).toContain("c.skipChildren()");
    expect(script).toContain("if(c.bounds)");
  });

  it("measures dynamic descendants directly in bounded batches", () => {
    const root: PenNode = {
      id: "screen",
      type: "frame",
      width: 393,
      children: [
        { id: "body", type: "frame", width: "fill_container" },
        { id: "title", type: "text", content: "Preferences" },
        { id: "photo", type: "rectangle", width: 393, height: 200 },
      ],
    };

    const scripts = resolvedBoundsLookupScripts(root, 1);

    expect(scripts).toHaveLength(2);
    expect(scripts[0]).toContain('Get("body",(n,c)');
    expect(scripts[1]).toContain('Get("title",(n,c)');
    expect(scripts.join(";")).not.toContain('Get("photo",(n,c)');
    expect(scripts.join(";")).not.toContain("Get((n,c)");
    expect(scripts.every((script) => script.includes("c.skipChildren()"))).toBe(
      true,
    );
  });

  it("rejects unsafe selected node ids", () => {
    expect(() => selectedRootFrameLookupScript(['bad"id'])).toThrow(
      "Invalid Pen node id",
    );
  });
});
