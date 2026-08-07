import { z } from "zod";
import { finiteNumberSchema, pointSchema, rgbaSchema } from "./primitives.js";

export const blendModeSchema = z.enum([
  "normal",
  "darken",
  "multiply",
  "color-burn",
  "lighten",
  "screen",
  "color-dodge",
  "overlay",
  "soft-light",
  "hard-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
]);

const paintBase = {
  visible: z.boolean(),
  opacity: finiteNumberSchema.min(0).max(1),
  blendMode: blendModeSchema,
};

export const gradientStopSchema = z
  .object({ position: finiteNumberSchema.min(0).max(1), color: rgbaSchema })
  .strict();

export const paintSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("solid"), ...paintBase, color: rgbaSchema })
    .strict(),
  z
    .object({
      type: z.literal("gradient"),
      ...paintBase,
      gradientType: z.enum(["linear", "radial", "angular"]),
      stops: z.array(gradientStopSchema).min(2),
      transform: z.tuple([
        z.tuple([finiteNumberSchema, finiteNumberSchema, finiteNumberSchema]),
        z.tuple([finiteNumberSchema, finiteNumberSchema, finiteNumberSchema]),
      ]),
    })
    .strict(),
  z
    .object({
      type: z.literal("image"),
      ...paintBase,
      assetId: z.string().min(1),
      scaleMode: z.enum(["fill", "fit", "stretch", "tile"]),
    })
    .strict(),
]);

export const strokeSchema = z
  .object({
    paints: z.array(paintSchema),
    alignment: z.enum(["inside", "center", "outside"]),
    weights: z
      .object({
        top: finiteNumberSchema.nonnegative(),
        right: finiteNumberSchema.nonnegative(),
        bottom: finiteNumberSchema.nonnegative(),
        left: finiteNumberSchema.nonnegative(),
      })
      .strict(),
    cap: z.enum(["none", "round", "square"]),
    join: z.enum(["miter", "round", "bevel"]),
  })
  .strict();

export const effectSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.enum(["blur", "background-blur"]),
      visible: z.boolean(),
      radius: finiteNumberSchema.nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.enum(["drop-shadow", "inner-shadow"]),
      visible: z.boolean(),
      color: rgbaSchema,
      offset: pointSchema,
      radius: finiteNumberSchema.nonnegative(),
      spread: finiteNumberSchema,
      blendMode: blendModeSchema,
    })
    .strict(),
]);

export const textStyleSchema = z
  .object({
    family: z.string().min(1),
    style: z.string().min(1),
    weight: finiteNumberSchema.min(1).max(1000),
    size: finiteNumberSchema.positive(),
    lineHeight: z.discriminatedUnion("unit", [
      z.object({ unit: z.literal("auto") }).strict(),
      z
        .object({
          unit: z.literal("pixels"),
          value: finiteNumberSchema.nonnegative(),
        })
        .strict(),
      z
        .object({
          unit: z.literal("percent"),
          value: finiteNumberSchema.nonnegative(),
        })
        .strict(),
    ]),
    letterSpacing: finiteNumberSchema,
    horizontalAlign: z.enum(["left", "center", "right", "justify"]),
    verticalAlign: z.enum(["top", "center", "bottom"]),
    decoration: z.enum(["none", "underline", "strikethrough"]),
  })
  .strict();

export type Paint = z.infer<typeof paintSchema>;
export type Stroke = z.infer<typeof strokeSchema>;
export type Effect = z.infer<typeof effectSchema>;
export type TextStyle = z.infer<typeof textStyleSchema>;
