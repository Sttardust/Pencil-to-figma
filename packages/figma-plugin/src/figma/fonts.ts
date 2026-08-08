export interface FontDescriptor {
  family: string;
  style: string;
}

export function rankFontFallbacks<T extends FontDescriptor>(
  requested: FontDescriptor,
  available: readonly T[],
): T[] {
  const preferred = preferredFamilies(requested.family);
  return [...available]
    .filter(
      (candidate, index, values) =>
        values.findIndex((other) => fontKey(other) === fontKey(candidate)) ===
        index,
    )
    .sort((left, right) => {
      const scoreDifference =
        fontScore(requested, left, preferred) -
        fontScore(requested, right, preferred);
      return (
        scoreDifference ||
        left.family.localeCompare(right.family) ||
        left.style.localeCompare(right.style)
      );
    });
}

export function fontKey(font: FontDescriptor): string {
  return `${font.family.toLowerCase()}\0${font.style.toLowerCase()}`;
}

function fontScore(
  requested: FontDescriptor,
  candidate: FontDescriptor,
  preferred: string[],
): number {
  const requestedFamily = requested.family.toLowerCase();
  const candidateFamily = candidate.family.toLowerCase();
  const preferredIndex = preferred.findIndex(
    (family) => family.toLowerCase() === candidateFamily,
  );
  const familyScore =
    candidateFamily === requestedFamily
      ? 0
      : preferredIndex >= 0
        ? (preferredIndex + 1) * 1_000
        : 100_000;
  const italicScore =
    isItalic(requested.style) === isItalic(candidate.style) ? 0 : 500;
  const weightScore = Math.abs(
    fontWeight(requested.style) - fontWeight(candidate.style),
  );
  return familyScore + italicScore + weightScore;
}

function preferredFamilies(family: string): string[] {
  const normalized = family.toLowerCase();
  if (normalized === "fraunces") return ["Georgia", "Times New Roman", "Inter"];
  if (normalized.includes("sans")) return ["Inter", "Arial", "Helvetica"];
  return ["Inter", "Arial", "Helvetica", "Georgia", "Times New Roman"];
}

function isItalic(style: string): boolean {
  return /italic|oblique/i.test(style);
}

function fontWeight(style: string): number {
  const normalized = style.toLowerCase().replaceAll(/[\s_-]/g, "");
  if (normalized.includes("thin")) return 100;
  if (normalized.includes("extralight") || normalized.includes("ultralight"))
    return 200;
  if (normalized.includes("light")) return 300;
  if (normalized.includes("medium")) return 500;
  if (normalized.includes("semibold") || normalized.includes("demibold"))
    return 600;
  if (normalized.includes("extrabold") || normalized.includes("ultrabold"))
    return 800;
  if (normalized.includes("black") || normalized.includes("heavy")) return 900;
  if (normalized.includes("bold")) return 700;
  return 400;
}
