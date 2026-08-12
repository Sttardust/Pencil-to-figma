import { describe, expect, it } from "vitest";
import { importPenDocument, planFigmaToPenCreate } from "../src/index.js";

function fixture() {
  const document = importPenDocument(
    {
      id: "root",
      type: "frame",
      name: "Export",
      width: 393,
      height: 844,
      layout: "vertical",
      gap: 12,
      padding: [10, 20, 30, 40],
      children: [
        {
          id: "title",
          type: "text",
          content: "Hello",
          fontFamily: "Inter",
          fontSize: 24,
          fontWeight: 700,
          width: "fill_container(323)",
        },
        {
          id: "row",
          type: "frame",
          children: [
            {
              id: "dot",
              type: "ellipse",
              width: 8,
              height: 8,
              fill: "#123456",
            },
          ],
        },
      ],
    },
    { documentId: "test.pen" },
  );
  document.source = { app: "figma", documentId: "figma-local" };
  return document;
}

describe("planFigmaToPenCreate", () => {
  it("plans assets, parent-first inserts, and root finalization", () => {
    const document = fixture();
    document.assets.push({
      status: "pending",
      id: "figma-image:abc",
      kind: "image",
      sourceUri: "figma-image://abc",
    });
    const plan = planFigmaToPenCreate(document, {
      maxOperationsPerChunk: 2,
      maxBytesPerChunk: 10_000,
    });

    expect(plan.mode).toBe("create-copy");
    expect(plan.counts).toEqual({ assets: 1, inserts: 4, finalizes: 1 });
    expect(plan.operations.map((operation) => operation.type)).toEqual([
      "prepare-asset",
      "insert",
      "insert",
      "insert",
      "insert",
      "finalize-root",
    ]);
    expect(
      plan.operations
        .filter((operation) => operation.type === "insert")
        .map((operation) => operation.bridgeId),
    ).toEqual(["pen:root", "pen:title", "pen:row", "pen:dot"]);
    expect(plan.chunks.every((chunk) => chunk.operations.length <= 2)).toBe(
      true,
    );
  });

  it("maps authored layout, sizing, and text properties", () => {
    const plan = planFigmaToPenCreate(fixture());
    const inserts = plan.operations.filter(
      (operation) => operation.type === "insert",
    );
    expect(inserts[0]?.payload).toMatchObject({
      type: "frame",
      placeholder: true,
      layout: "vertical",
      gap: 12,
      padding: [10, 20, 30, 40],
      width: 393,
      height: 844,
    });
    expect(inserts[1]?.payload).toMatchObject({
      type: "text",
      content: "Hello",
      width: "fill_container(323)",
      fontFamily: "Inter",
      fontSize: 24,
      fontWeight: 700,
    });
  });

  it("exports negative gaps, per-side strokes, and nonuniform radii", () => {
    const document = fixture();
    document.root.layout!.gap = -8;
    document.root.stroke = {
      paints: [],
      alignment: "inside",
      weights: { top: 1, right: 2, bottom: 3, left: 4 },
      cap: "none",
      join: "miter",
    };
    document.root.cornerRadii = [4, 8, 12, 16];

    const root = planFigmaToPenCreate(document).operations.find(
      (operation) => operation.type === "insert",
    );

    expect(root?.payload).toMatchObject({
      gap: -8,
      strokeWidth: { top: 1, right: 2, bottom: 3, left: 4 },
      cornerRadius: [4, 8, 12, 16],
    });
  });

  it("round-trips Pencil gradient rotation without reversing its stops", () => {
    const document = importPenDocument(
      {
        id: "scrim",
        type: "rectangle",
        width: 393,
        height: 500,
        fill: {
          type: "gradient",
          gradientType: "linear",
          rotation: 180,
          colors: [
            { color: "#1a151200", position: 0 },
            { color: "#1a1512ff", position: 0.72 },
          ],
        },
      },
      { documentId: "test.pen" },
    );
    document.source = { app: "figma", documentId: "figma-local" };

    const insert = planFigmaToPenCreate(document).operations.find(
      (operation) => operation.type === "insert",
    );

    expect(insert?.payload).toMatchObject({
      fill: [expect.objectContaining({ rotation: 180 })],
    });
  });

  it("preserves managed Pencil variable references in reverse payloads", () => {
    const document = importPenDocument(
      {
        id: "variable-root",
        type: "frame",
        fill: "$surface",
        cornerRadius: "$radius-card",
        children: [
          {
            id: "variable-label",
            type: "text",
            content: "Hello",
            fill: "$ink",
            fontFamily: "$font-body",
          },
        ],
      },
      {
        documentId: "test.pen",
        variables: {
          surface: { type: "color", value: "#ffffff" },
          ink: { type: "color", value: "#112233" },
          "radius-card": { type: "number", value: 16 },
          "font-body": { type: "string", value: "Inter" },
        },
      },
    );
    document.source = { app: "figma", documentId: "figma-local" };

    const inserts = planFigmaToPenCreate(document).operations.filter(
      (operation) => operation.type === "insert",
    );

    expect(inserts[0]?.payload).toMatchObject({
      fill: "$surface",
      cornerRadius: "$radius-card",
    });
    expect(inserts[1]?.payload).toMatchObject({
      fill: "$ink",
      fontFamily: "$font-body",
    });
  });

  it("plans external component definitions before their instances", () => {
    const document = fixture();
    document.components = [
      {
        ...structuredClone(document.root.children[1]!),
        bridgeId: "figma:component",
        kind: "component",
        name: "Button component",
        component: { key: "component-key" },
        children: [
          {
            ...structuredClone(document.root.children[0]!),
            bridgeId: "figma:component-label",
            name: "Label",
          },
        ],
      },
    ];
    document.root.children = [
      {
        ...structuredClone(document.root.children[1]!),
        bridgeId: "figma:instance",
        kind: "instance",
        name: "Button instance",
        instance: {
          componentBridgeId: "figma:component",
          overrides: {
            "figma:component-label": { content: "Continue" },
          },
        },
        children: [],
      },
    ];

    const plan = planFigmaToPenCreate(document);
    const inserts = plan.operations.filter(
      (
        operation,
      ): operation is Extract<
        (typeof plan.operations)[number],
        { type: "insert" }
      > => operation.type === "insert",
    );

    expect(inserts.map((operation) => operation.bridgeId)).toEqual([
      "figma:component",
      "figma:component-label",
      "pen:root",
      "figma:instance",
    ]);
    expect(inserts[3]!.payload).toMatchObject({
      type: "ref",
      ref: "figma:component",
      descendants: {
        "figma:component-label": { content: "Continue" },
      },
    });
    expect(plan.chunks).toHaveLength(2);
    expect(
      plan.chunks[0]!.operations.filter(
        (operation) => operation.type === "insert",
      ).map((operation) => operation.bridgeId),
    ).toEqual(["figma:component", "figma:component-label"]);
    expect(
      plan.chunks[1]!.operations.filter(
        (operation) => operation.type === "insert",
      ).map((operation) => operation.bridgeId),
    ).toEqual(["pen:root", "figma:instance"]);
  });

  it("declares SVG wrapper rasterization", () => {
    const document = fixture();
    const svgWrapper = document.root.children[1]!;
    svgWrapper.children = [];
    svgWrapper.icon = { assetId: "figma-svg:1:2" };
    document.assets.push({
      status: "pending",
      id: "figma-svg:1:2",
      kind: "svg",
      sourceUri: "figma-svg://1:2",
    });

    const plan = planFigmaToPenCreate(document);
    expect(plan.warnings).toContainEqual(
      expect.objectContaining({
        code: "FIGMA_SVG_RASTERIZED",
        action: "rasterize",
      }),
    );
    const icon = plan.operations.find(
      (operation) =>
        operation.type === "insert" && operation.bridgeId === "pen:row",
    );
    expect(icon?.type === "insert" ? icon.payload : undefined).toMatchObject({
      type: "rectangle",
      fill: [expect.objectContaining({ type: "image", mode: "fit" })],
    });
    expect(
      icon?.type === "insert" ? icon.payload : undefined,
    ).not.toHaveProperty("layout");
    expect(
      icon?.type === "insert" ? icon.payload : undefined,
    ).not.toHaveProperty("clip");
    expect(
      icon?.type === "insert" ? icon.payload : undefined,
    ).not.toHaveProperty("padding");
  });

  it("uses staged asset paths supplied by the writer", () => {
    const document = fixture();
    document.root.children[0]!.fills = [
      {
        type: "image",
        visible: true,
        opacity: 1,
        blendMode: "normal",
        assetId: "figma-image:abc",
        scaleMode: "fill",
      },
    ];
    document.assets.push({
      status: "pending",
      id: "figma-image:abc",
      kind: "image",
      sourceUri: "figma-image://abc",
    });

    const plan = planFigmaToPenCreate(document, {
      assetPaths: {
        "figma-image:abc": "./.pen-fig-assets/deadbeef.jpg",
      },
    });
    const title = plan.operations.find(
      (operation) =>
        operation.type === "insert" && operation.bridgeId === "pen:title",
    );
    expect(title?.type === "insert" ? title.payload : undefined).toMatchObject({
      fill: [
        expect.objectContaining({
          type: "image",
          url: "./.pen-fig-assets/deadbeef.jpg",
        }),
      ],
    });
  });

  it("preserves image blend modes and explicitly flattens crop for Pencil", () => {
    const document = fixture();
    document.root.children[0]!.fills = [
      {
        type: "image",
        visible: true,
        opacity: 0.75,
        blendMode: "screen",
        assetId: "figma-image:crop",
        scaleMode: "crop",
        transform: [
          [1, 0, 0.1],
          [0, 1, 0.2],
        ],
      },
    ];

    const plan = planFigmaToPenCreate(document);
    const title = plan.operations.find(
      (operation) =>
        operation.type === "insert" && operation.bridgeId === "pen:title",
    );
    expect(title?.type === "insert" ? title.payload : undefined).toMatchObject({
      fill: [
        expect.objectContaining({
          type: "image",
          mode: "fill",
          blendMode: "screen",
        }),
      ],
    });
    expect(plan.warnings).toContainEqual(
      expect.objectContaining({
        code: "FIGMA_IMAGE_SCALE_FLATTENED",
        action: "flatten",
      }),
    );
  });

  it("writes rasterized Figma icon instances as size-preserving image layers", () => {
    const document = fixture();
    const icon = document.root.children[0]!;
    icon.kind = "frame";
    delete icon.text;
    icon.bounds = { x: 0, y: 0, width: 24, height: 24 };
    icon.width = { mode: "fixed", value: 24 };
    icon.height = { mode: "fixed", value: 24 };
    icon.icon = { assetId: "figma-rasterized:icon" };
    document.assets.push({
      status: "pending",
      id: "figma-rasterized:icon",
      kind: "rasterized",
      sourceUri: "figma-rasterized://1:2",
    });

    const plan = planFigmaToPenCreate(document, {
      assetPaths: {
        "figma-rasterized:icon": "./.pen-fig-assets/icon.png",
      },
    });
    const insert = plan.operations.find(
      (operation) =>
        operation.type === "insert" && operation.bridgeId === "pen:title",
    );

    expect(
      insert?.type === "insert" ? insert.payload : undefined,
    ).toMatchObject({
      type: "rectangle",
      width: 24,
      height: 24,
      fill: [
        {
          type: "image",
          url: "./.pen-fig-assets/icon.png",
          mode: "fit",
        },
      ],
    });
    expect(plan.warnings).toContainEqual(
      expect.objectContaining({
        code: "FIGMA_ICON_INSTANCE_RASTERIZED",
        action: "rasterize",
      }),
    );
  });

  it("rejects an operation larger than the byte ceiling", () => {
    const document = fixture();
    document.root.children[0]!.text!.characters = "x".repeat(1000);
    expect(() =>
      planFigmaToPenCreate(document, {
        maxOperationsPerChunk: 20,
        maxBytesPerChunk: 256,
      }),
    ).toThrow("Pen operation exceeds 256 bytes");
  });
});
