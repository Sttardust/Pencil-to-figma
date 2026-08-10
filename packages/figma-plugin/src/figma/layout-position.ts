export function toFigmaLayoutPositioning(
  value: "auto" | "absolute" | undefined,
): "AUTO" | "ABSOLUTE" {
  return value === "absolute" ? "ABSOLUTE" : "AUTO";
}

export function fromFigmaLayoutPositioning(
  value: "AUTO" | "ABSOLUTE",
): "auto" | "absolute" {
  return value === "ABSOLUTE" ? "absolute" : "auto";
}
