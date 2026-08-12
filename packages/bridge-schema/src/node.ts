import { z } from "zod";
import {
  bridgeIdSchema,
  finiteNumberSchema,
  rectSchema,
  sourceRefSchema,
} from "./primitives.js";
import {
  effectSchema,
  paintSchema,
  strokeSchema,
  textStyleSchema,
} from "./style.js";

export const sizingSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("fixed"),
      value: finiteNumberSchema.nonnegative(),
    })
    .strict(),
  z
    .object({
      mode: z.enum(["hug", "fill"]),
      fallback: finiteNumberSchema.nonnegative().optional(),
      resolved: z.boolean().optional(),
    })
    .strict(),
]);

export const layoutSchema = z
  .object({
    mode: z.enum(["none", "horizontal", "vertical"]),
    gap: finiteNumberSchema,
    padding: z
      .object({
        top: finiteNumberSchema,
        right: finiteNumberSchema,
        bottom: finiteNumberSchema,
        left: finiteNumberSchema,
      })
      .strict(),
    primaryAlign: z.enum([
      "start",
      "center",
      "end",
      "space-between",
      "space-around",
    ]),
    counterAlign: z.enum(["start", "center", "end"]),
    includeStroke: z.boolean(),
  })
  .strict();

export const variableBindingsSchema = z
  .object({
    fills: z.record(z.string(), bridgeIdSchema).optional(),
    strokes: z.record(z.string(), bridgeIdSchema).optional(),
    fontFamily: bridgeIdSchema.optional(),
    cornerRadius: bridgeIdSchema.optional(),
  })
  .strict();

export interface BridgeNode {
  bridgeId: string;
  kind:
    | "frame"
    | "group"
    | "rectangle"
    | "ellipse"
    | "polygon"
    | "path"
    | "text"
    | "component"
    | "instance";
  name: string;
  source: z.infer<typeof sourceRefSchema>;
  bounds: z.infer<typeof rectSchema>;
  width: z.infer<typeof sizingSchema>;
  height: z.infer<typeof sizingSchema>;
  rotation: number;
  visible: boolean;
  opacity: number;
  locked: boolean;
  layoutPosition?: "auto" | "absolute" | undefined;
  clipsContent?: boolean | undefined;
  layout?: z.infer<typeof layoutSchema> | undefined;
  fills?: z.infer<typeof paintSchema>[] | undefined;
  stroke?: z.infer<typeof strokeSchema> | undefined;
  effects?: z.infer<typeof effectSchema>[] | undefined;
  cornerRadii?: [number, number, number, number] | undefined;
  text?:
    | {
        characters: string;
        resize: "auto" | "height" | "fixed";
        style: z.infer<typeof textStyleSchema>;
      }
    | undefined;
  path?:
    | {
        data: string;
        windingRule: "nonzero" | "evenodd";
        viewBox: [number, number, number, number];
      }
    | undefined;
  polygonSides?: number | undefined;
  component?: { key: string } | undefined;
  instance?:
    | { componentBridgeId: string; overrides: Record<string, unknown> }
    | undefined;
  icon?: { assetId: string } | undefined;
  variableBindings?: z.infer<typeof variableBindingsSchema> | undefined;
  children: BridgeNode[];
}

export const bridgeNodeSchema: z.ZodType<BridgeNode> = z.lazy(() =>
  z
    .object({
      bridgeId: bridgeIdSchema,
      kind: z.enum([
        "frame",
        "group",
        "rectangle",
        "ellipse",
        "polygon",
        "path",
        "text",
        "component",
        "instance",
      ]),
      name: z.string(),
      source: sourceRefSchema,
      bounds: rectSchema,
      width: sizingSchema,
      height: sizingSchema,
      rotation: finiteNumberSchema,
      visible: z.boolean(),
      opacity: finiteNumberSchema.min(0).max(1),
      locked: z.boolean(),
      layoutPosition: z.enum(["auto", "absolute"]).optional(),
      clipsContent: z.boolean().optional(),
      layout: layoutSchema.optional(),
      fills: z.array(paintSchema).optional(),
      stroke: strokeSchema.optional(),
      effects: z.array(effectSchema).optional(),
      cornerRadii: z
        .tuple([
          finiteNumberSchema,
          finiteNumberSchema,
          finiteNumberSchema,
          finiteNumberSchema,
        ])
        .optional(),
      text: z
        .object({
          characters: z.string(),
          resize: z.enum(["auto", "height", "fixed"]),
          style: textStyleSchema,
        })
        .strict()
        .optional(),
      path: z
        .object({
          data: z.string(),
          windingRule: z.enum(["nonzero", "evenodd"]),
          viewBox: z.tuple([
            finiteNumberSchema,
            finiteNumberSchema,
            finiteNumberSchema,
            finiteNumberSchema,
          ]),
        })
        .strict()
        .optional(),
      polygonSides: z.number().int().min(3).optional(),
      component: z
        .object({ key: z.string().min(1) })
        .strict()
        .optional(),
      instance: z
        .object({
          componentBridgeId: bridgeIdSchema,
          overrides: z.record(z.string(), z.unknown()),
        })
        .strict()
        .optional(),
      icon: z.object({ assetId: bridgeIdSchema }).strict().optional(),
      variableBindings: variableBindingsSchema.optional(),
      children: z.array(bridgeNodeSchema),
    })
    .strict()
    .superRefine((node, context) => {
      if (node.kind === "text" && !node.text)
        context.addIssue({
          code: "custom",
          path: ["text"],
          message: "Text nodes require text data",
        });
      if (node.kind === "path" && !node.path)
        context.addIssue({
          code: "custom",
          path: ["path"],
          message: "Path nodes require path data",
        });
      if (node.kind === "component" && !node.component)
        context.addIssue({
          code: "custom",
          path: ["component"],
          message: "Component nodes require component data",
        });
      if (node.kind === "instance" && !node.instance)
        context.addIssue({
          code: "custom",
          path: ["instance"],
          message: "Instance nodes require instance data",
        });
      if (
        !["frame", "group", "component", "instance"].includes(node.kind) &&
        node.children.length > 0
      ) {
        context.addIssue({
          code: "custom",
          path: ["children"],
          message: `${node.kind} nodes cannot have children`,
        });
      }
    }),
);
