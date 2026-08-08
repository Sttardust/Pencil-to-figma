import { describe, expect, it } from "vitest";
import { classifyIdentities } from "../src/figma/identity.js";

describe("classifyIdentities", () => {
  const hashes = { "pen:root": "root-hash", "pen:child": "child-hash" };

  it("classifies an unseen subtree as new", () => {
    expect(classifyIdentities(hashes, [])).toEqual({ status: "new" });
  });

  it("classifies complete matching identities as unchanged", () => {
    expect(
      classifyIdentities(hashes, [
        { bridgeId: "pen:root", authoredHash: "root-hash", nodeId: "1:1" },
        { bridgeId: "pen:child", authoredHash: "child-hash", nodeId: "1:2" },
      ]),
    ).toEqual({ status: "unchanged" });
  });

  it("reports changed and missing mapped nodes", () => {
    expect(
      classifyIdentities(hashes, [
        { bridgeId: "pen:root", authoredHash: "old-hash", nodeId: "1:1" },
      ]),
    ).toEqual({
      status: "changed",
      changedBridgeIds: ["pen:root"],
      missingBridgeIds: ["pen:child"],
    });
  });

  it("rejects duplicate bridge identities", () => {
    expect(() =>
      classifyIdentities(hashes, [
        { bridgeId: "pen:root", authoredHash: "root-hash", nodeId: "1:1" },
        { bridgeId: "pen:root", authoredHash: "root-hash", nodeId: "2:1" },
      ]),
    ).toThrow("Duplicate bridge identities require remapping");
  });
});
