import { z } from "zod";

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("pair"),
    protocol: z.literal(1),
    code: z.string().length(6),
  }),
  z.object({
    type: z.literal("hello"),
    protocol: z.literal(1),
    token: z.string().uuid(),
  }),
  z.object({
    type: z.literal("pen-state"),
    requestId: z.string().min(1).max(100),
  }),
  z.object({
    type: z.literal("list-pen-screens"),
    requestId: z.string().min(1).max(100),
  }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

export type ServerMessage =
  | { type: "paired"; protocol: 1; token: string }
  | { type: "ready"; protocol: 1; penState: string }
  | { type: "pen-state"; requestId: string; text: string }
  | { type: "pen-screens"; requestId: string; text: string }
  | { type: "failed"; requestId?: string; code: string; message: string };
