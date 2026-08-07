import { z } from "zod";
import { bridgeNodeSchema } from "./node.js";
import {
  bridgeIdSchema,
  finiteNumberSchema,
  sourceRefSchema,
} from "./primitives.js";
import { rgbaSchema } from "./primitives.js";

export const warningSchema = z
  .object({
    code: z.string().min(1),
    nodeBridgeId: bridgeIdSchema,
    construct: z.string().min(1),
    action: z.enum(["rasterize", "flatten", "split", "skip"]),
    message: z.string().min(1),
  })
  .strict();

export const assetSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("pending"),
      id: bridgeIdSchema,
      kind: z.enum(["image", "svg", "rasterized"]),
      sourceUri: z.string().min(1),
    })
    .strict(),
  z
    .object({
      status: z.literal("ready"),
      id: bridgeIdSchema,
      kind: z.enum(["image", "svg", "rasterized"]),
      mimeType: z.string().min(1),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      byteLength: z.number().int().nonnegative(),
      sourceUri: z.string().optional(),
    })
    .strict(),
]);

const variableValueSchema = z.union([
  z.boolean(),
  finiteNumberSchema,
  z.string(),
  rgbaSchema,
]);

export const variableSchema = z
  .object({
    id: bridgeIdSchema,
    name: z.string().min(1),
    type: z.enum(["boolean", "number", "string", "color"]),
    values: z.array(
      z
        .object({
          mode: z.record(z.string(), z.string()),
          value: variableValueSchema,
        })
        .strict(),
    ),
  })
  .strict();

export const bridgeDocumentSchema = z
  .object({
    version: z.literal(1),
    source: sourceRefSchema.omit({ nodeId: true }),
    root: bridgeNodeSchema,
    assets: z.array(assetSchema),
    variables: z.array(variableSchema),
    warnings: z.array(warningSchema),
  })
  .strict();

export type BridgeDocument = z.infer<typeof bridgeDocumentSchema>;
export type BridgeAsset = z.infer<typeof assetSchema>;
export type BridgeVariable = z.infer<typeof variableSchema>;
export type TransferWarning = z.infer<typeof warningSchema>;
