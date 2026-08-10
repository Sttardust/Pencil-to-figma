import { describe, expect, it } from "vitest";
import { selectedNodeIdsFromAppState } from "../src/pen/mcp-client.js";

describe("Pencil selection parsing", () => {
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
});
