import { describe, expect, it } from "vitest";
import type { PenNode } from "@pen-fig/core";
import { collectPenComponentRefs } from "../src/server.js";

describe("Pencil component reference discovery", () => {
  it("does not treat derived instance children as reusable components", () => {
    const root: PenNode = {
      id: "root",
      type: "frame",
      children: [
        {
          id: "toggle-instance",
          type: "ref",
          ref: "Fukrg",
          children: [
            {
              id: "switch-child",
              type: "ref",
              ref: "lXJi9",
              children: [{ id: "knob-child", type: "ref", ref: "BgrSZ" }],
            },
          ],
        },
      ],
    };

    expect(collectPenComponentRefs(root)).toEqual(["Fukrg"]);
  });

  it("continues to find independent nested component instances", () => {
    const root: PenNode = {
      id: "root",
      type: "frame",
      children: [
        {
          id: "section",
          type: "frame",
          children: [
            { id: "first", type: "ref", ref: "component-a" },
            { id: "second", type: "ref", ref: "component-b" },
          ],
        },
      ],
    };

    expect(collectPenComponentRefs(root)).toEqual([
      "component-a",
      "component-b",
    ]);
  });
});
