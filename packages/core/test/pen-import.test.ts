import { describe, expect, it } from "vitest";
import { importPenDocument, type PenNode } from "../src/index.js";

const signupFixture: PenNode = {
  type: "frame",
  id: "DEFFF",
  x: 34993,
  y: 15705,
  name: "Signup / Email",
  clip: true,
  width: 393,
  height: 844,
  fill: "#ffffffff",
  layout: "vertical",
  children: [
    {
      type: "text",
      id: "vpI7W",
      name: "Title",
      fill: "#161A19",
      textGrowth: "fixed-width",
      width: "fill_container",
      content: "What's your email address?",
      lineHeight: 1.2,
      textAlign: "center",
      fontFamily: "Inter",
      fontSize: 27,
      fontWeight: "700",
      letterSpacing: -0.5,
    },
  ],
};

describe("importPenDocument", () => {
  it("maps the real Signup root and text properties", () => {
    const document = importPenDocument(signupFixture, {
      documentId: "orchid.pen",
    });
    expect(document.root).toMatchObject({
      bridgeId: "pen:DEFFF",
      kind: "frame",
      clipsContent: true,
      width: { mode: "fixed", value: 393 },
      layout: { mode: "vertical" },
    });
    expect(document.root.children[0]).toMatchObject({
      kind: "text",
      width: { mode: "fill" },
      text: {
        characters: "What's your email address?",
        resize: "height",
        style: {
          family: "Inter",
          size: 27,
          weight: 700,
          lineHeight: { unit: "percent", value: 120 },
        },
      },
    });
  });

  it("converts four- and eight-digit hex colors", () => {
    const root: PenNode = { ...signupFixture, fill: "#1238", children: [] };
    const fill = importPenDocument(root, { documentId: "test.pen" }).root
      .fills?.[0];
    expect(fill).toMatchObject({
      type: "solid",
      color: { r: 0x11 / 255, g: 0x22 / 255, b: 0x33 / 255, a: 0x88 / 255 },
    });
  });

  it("fails on unknown node types", () => {
    expect(() =>
      importPenDocument(
        { id: "bad", type: "mystery" },
        { documentId: "test.pen" },
      ),
    ).toThrow("Unknown Pen node type 'mystery' on bad");
  });

  it("declares shader degradation instead of silently dropping it", () => {
    const root: PenNode = {
      ...signupFixture,
      fill: { type: "shader", url: "./effect.glsl" },
      children: [],
    };
    const document = importPenDocument(root, { documentId: "test.pen" });
    expect(document.warnings).toContainEqual(
      expect.objectContaining({
        nodeBridgeId: "pen:DEFFF",
        action: "rasterize",
      }),
    );
  });

  it("uses Stack Sans's family-specific SemiBold style name", () => {
    const root: PenNode = {
      id: "stack",
      type: "text",
      content: "Ledger",
      fontFamily: "Stack Sans Headline",
      fontWeight: 600,
    };
    const document = importPenDocument(root, { documentId: "test.pen" });
    expect(document.root.text?.style.style).toBe("SemiBold");
  });

  it("registers image and icon assets for the service to resolve", () => {
    const root: PenNode = {
      id: "assets",
      type: "frame",
      width: 100,
      height: 100,
      children: [
        {
          id: "photo",
          type: "rectangle",
          width: 40,
          height: 40,
          fill: { type: "image", url: "https://example.com/photo.jpg" },
        },
        {
          id: "search",
          type: "icon",
          library: "Material Symbols Rounded",
          icon: "search",
          width: 24,
          height: 24,
        },
      ],
    };
    const document = importPenDocument(root, { documentId: "test.pen" });

    expect(document.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "pending", kind: "image" }),
        expect.objectContaining({ status: "pending", kind: "svg" }),
      ]),
    );
    expect(document.root.children[0]?.fills?.[0]).toMatchObject({
      type: "image",
    });
    expect(document.root.children[1]?.icon).toEqual({
      assetId: "pen-icon:search",
    });
  });

  it("keeps unspecified frames freeform and preserves absolute children", () => {
    const root: PenNode = {
      id: "freeform",
      type: "frame",
      width: 393,
      height: 844,
      children: [
        {
          id: "button",
          type: "rectangle",
          x: 18,
          y: 760,
          width: "fill_container",
          height: 48,
          layoutPosition: "absolute",
        },
      ],
    };
    const document = importPenDocument(root, { documentId: "test.pen" });

    expect(document.root.layout?.mode).toBe("none");
    expect(document.root.children[0]).toMatchObject({
      layoutPosition: "absolute",
      bounds: { x: 18, y: 760 },
      width: { mode: "fill" },
    });
  });

  it("uses Pencil's implicit horizontal flow for unpositioned children", () => {
    const root: PenNode = {
      id: "row",
      type: "frame",
      width: 100,
      height: 40,
      children: [
        { id: "left", type: "rectangle", width: 20, height: 20 },
        { id: "right", type: "rectangle", width: 20, height: 20 },
      ],
    };

    const document = importPenDocument(root, { documentId: "test.pen" });
    expect(document.root.layout?.mode).toBe("horizontal");
  });

  it("restores bridge identities from managed Pencil export metadata", () => {
    const document = importPenDocument(
      {
        id: "nativeRoot",
        type: "frame",
        metadata: { type: "pen-fig-export", bridgeId: "pen:originalRoot" },
        children: [
          {
            id: "nativeChild",
            type: "rectangle",
            metadata: {
              type: "pen-fig-bridge",
              bridgeId: "pen:originalChild",
            },
          },
        ],
      },
      { documentId: "test.pen", useBridgeMetadata: true },
    );

    expect(document.root.bridgeId).toBe("pen:originalRoot");
    expect(document.root.source.nodeId).toBe("nativeRoot");
    expect(document.root.children[0]?.bridgeId).toBe("pen:originalChild");
    expect(document.root.children[0]?.source.nodeId).toBe("nativeChild");
  });

  it("links refs to reusable frames by native identity, never by name", () => {
    const document = importPenDocument(
      {
        id: "root",
        type: "frame",
        name: "Component fixture",
        children: [
          {
            id: "instance",
            type: "ref",
            name: "Primary button",
            ref: "nativeComponent",
            descendants: { label: { content: "Continue" } },
            children: [
              { id: "derivedLabel", type: "text", content: "Continue" },
            ],
          },
          {
            id: "nativeComponent",
            type: "frame",
            name: "A completely different name",
            reusable: true,
            metadata: {
              type: "pen-fig-bridge",
              bridgeId: "figma:component:button",
            },
            children: [
              { id: "componentLabel", type: "text", content: "Button" },
            ],
          },
        ],
      },
      { documentId: "test.pen", useBridgeMetadata: true },
    );

    expect(document.root.children[0]).toMatchObject({
      kind: "instance",
      instance: {
        componentBridgeId: "figma:component:button",
        overrides: { label: { content: "Continue" } },
      },
      children: [],
    });
    expect(document.root.children[1]).toMatchObject({
      bridgeId: "figma:component:button",
      kind: "component",
      component: { key: "nativeComponent" },
    });
    expect(document.warnings).toContainEqual(
      expect.objectContaining({
        code: "PEN_INSTANCE_OVERRIDES",
        action: "skip",
      }),
    );
  });
});
