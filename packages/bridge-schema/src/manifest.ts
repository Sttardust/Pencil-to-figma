import { z } from "zod";
import { bridgeIdSchema } from "./primitives.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const manifestMappingSchema = z
  .object({
    bridgeId: bridgeIdSchema,
    penNodeId: z.string().min(1).optional(),
    figmaNodeId: z.string().min(1).optional(),
    baselineHash: sha256Schema,
  })
  .strict()
  .refine((mapping) => mapping.penNodeId || mapping.figmaNodeId, {
    message: "A mapping requires at least one application node ID",
  });

export const bridgeManifestSchema = z
  .object({
    version: z.literal(1),
    penDocumentId: z.string().min(1),
    figmaDocumentId: z.string().min(1).optional(),
    revision: z.number().int().nonnegative(),
    updatedAt: z.string().datetime({ offset: true }),
    mappings: z.array(manifestMappingSchema),
  })
  .strict()
  .superRefine((manifest, context) => {
    const seen = new Set<string>();
    manifest.mappings.forEach((mapping, index) => {
      if (seen.has(mapping.bridgeId))
        context.addIssue({
          code: "custom",
          path: ["mappings", index, "bridgeId"],
          message: `Duplicate bridge ID ${mapping.bridgeId}`,
        });
      seen.add(mapping.bridgeId);
    });
  });

export type BridgeManifest = z.infer<typeof bridgeManifestSchema>;
export type ManifestMapping = z.infer<typeof manifestMappingSchema>;
