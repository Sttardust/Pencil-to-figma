import { ZodError } from "zod";

export type PublicErrorPhase =
  | "connection"
  | "validation"
  | "fonts"
  | "assets"
  | "comparison"
  | "write"
  | "verification"
  | "persistence";

export interface PublicBridgeError {
  code: string;
  message: string;
  phase: PublicErrorPhase;
  retrySafe: boolean;
  httpStatus: number;
}

export function toPublicBridgeError(error: unknown): PublicBridgeError {
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    const location = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
    return {
      code: "SCHEMA_MESSAGE",
      message: `The transfer data is invalid${location}.`,
      phase: "validation",
      retrySafe: false,
      httpStatus: 400,
    };
  }

  if (error instanceof SyntaxError)
    return {
      code: "SCHEMA_JSON",
      message: "The bridge received invalid JSON.",
      phase: "validation",
      retrySafe: false,
      httpStatus: 400,
    };

  const message = sanitizedMessage(error);
  const normalized = message.toLowerCase();

  if (normalized.includes("request body too large"))
    return failure(
      "SCHEMA_PAYLOAD_LIMIT",
      "The transfer is too large for the local bridge.",
      "validation",
      false,
      413,
    );
  if (
    normalized.includes("select no more than") ||
    normalized.includes("select fewer pencil") ||
    normalized.includes("select fewer layers")
  )
    return failure("SCHEMA_SELECTION_LIMIT", message, "validation", true, 422);
  if (
    normalized.includes("limit exceeded") ||
    normalized.includes("atomic limit") ||
    normalized.includes("too many")
  )
    return failure("SCHEMA_OPERATION_LIMIT", message, "validation", false, 422);
  if (
    normalized.includes("mcp") ||
    normalized.includes("pencil did not report") ||
    normalized.includes("active .pen document") ||
    normalized.includes("request timed out") ||
    normalized.includes("connection")
  )
    return failure("CONNECTION_PEN", message, "connection", true, 503);
  if (normalized.includes("font"))
    return failure("FONT_UNAVAILABLE", message, "fonts", false, 422);
  if (
    normalized.includes("asset") ||
    normalized.includes("image format") ||
    normalized.includes("base64")
  )
    return failure("ASSET_INVALID", message, "assets", false, 422);
  if (
    normalized.includes("conflict") ||
    normalized.includes("changed during") ||
    normalized.includes("another figma change") ||
    normalized.includes("no longer current") ||
    normalized.includes("both editors") ||
    normalized.includes("apply one direction") ||
    normalized.includes("resolve structural")
  )
    return failure("CONFLICT_STALE", message, "comparison", true, 409);
  if (normalized.includes("expired"))
    return failure("MAPPING_EXPIRED", message, "comparison", true, 409);
  if (
    normalized.includes("verification") ||
    normalized.includes("does not match") ||
    normalized.includes("mismatch") ||
    normalized.includes("differs")
  )
    return failure("WRITE_VERIFICATION", message, "verification", true, 409);
  if (
    normalized.includes("mapping") ||
    normalized.includes("mapped") ||
    normalized.includes("bridge identity") ||
    normalized.includes("baseline") ||
    normalized.includes("adopt this pencil root")
  )
    return failure("MAPPING_STALE", message, "comparison", true, 409);
  if (normalized.includes("manifest") || normalized.includes("journal"))
    return failure("MANIFEST_INVALID", message, "persistence", true, 409);

  return failure("WRITE_FAILED", message, "write", false, 500);
}

function failure(
  code: string,
  message: string,
  phase: PublicErrorPhase,
  retrySafe: boolean,
  httpStatus: number,
): PublicBridgeError {
  return { code, message, phase, retrySafe, httpStatus };
}

function sanitizedMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "Unknown service error";
  return message.replace(
    /(?:\/Users\/[^/\s]+|\/private\/var\/[^/\s]+|\/tmp)\/[^\s`"']+/g,
    "[local path]",
  );
}
