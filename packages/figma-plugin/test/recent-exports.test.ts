import { describe, expect, it } from "vitest";
import {
  mergeRecentPencilExports,
  parseRecentPencilExports,
  type RecentPencilExport,
} from "../src/ui/recent-exports.js";

function entry(id: string): RecentPencilExport {
  return {
    name: `Screen ${id}`,
    penRootId: id,
    x: 100,
    y: 200,
    exportedAt: "2026-08-10T00:00:00.000Z",
  };
}

describe("recent Pencil exports", () => {
  it("rejects malformed stored records", () => {
    expect(
      parseRecentPencilExports([
        entry("valid1"),
        { ...entry("invalid-id"), penRootId: "not valid" },
        { ...entry("bad-position"), x: Number.NaN },
      ]),
    ).toEqual([entry("valid1")]);
  });

  it("puts completed exports first and removes duplicate IDs", () => {
    expect(
      mergeRecentPencilExports(
        [entry("older"), entry("same")],
        [entry("same"), entry("newer")],
      ).map((item) => item.penRootId),
    ).toEqual(["same", "newer", "older"]);
  });

  it("keeps at most twenty destinations", () => {
    const merged = mergeRecentPencilExports(
      Array.from({ length: 20 }, (_, index) => entry(`old${index}`)),
      [entry("new")],
    );
    expect(merged).toHaveLength(20);
    expect(merged[0]?.penRootId).toBe("new");
  });
});
