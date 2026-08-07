import { z } from "zod";

export const bridgeIdSchema = z.string().min(1).max(200);
export const finiteNumberSchema = z.number().finite();

export const pointSchema = z
  .object({ x: finiteNumberSchema, y: finiteNumberSchema })
  .strict();

export const sizeSchema = z
  .object({
    width: finiteNumberSchema.nonnegative(),
    height: finiteNumberSchema.nonnegative(),
  })
  .strict();

export const rectSchema = pointSchema.extend(sizeSchema.shape).strict();

export const rgbaSchema = z
  .object({
    r: finiteNumberSchema.min(0).max(1),
    g: finiteNumberSchema.min(0).max(1),
    b: finiteNumberSchema.min(0).max(1),
    a: finiteNumberSchema.min(0).max(1),
  })
  .strict();

export const sourceRefSchema = z
  .object({
    app: z.enum(["pen", "figma"]),
    documentId: z.string().min(1),
    nodeId: z.string().min(1),
  })
  .strict();

export type Point = z.infer<typeof pointSchema>;
export type Size = z.infer<typeof sizeSchema>;
export type Rect = z.infer<typeof rectSchema>;
export type Rgba = z.infer<typeof rgbaSchema>;
export type SourceRef = z.infer<typeof sourceRefSchema>;
