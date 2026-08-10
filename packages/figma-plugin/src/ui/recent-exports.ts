export interface RecentPencilExport {
  name: string;
  penRootId: string;
  x: number;
  y: number;
  exportedAt: string;
}

export function parseRecentPencilExports(value: unknown): RecentPencilExport[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecentPencilExport).slice(0, 20);
}

export function mergeRecentPencilExports(
  existing: RecentPencilExport[],
  completed: RecentPencilExport[],
): RecentPencilExport[] {
  const completedIds = new Set(completed.map((entry) => entry.penRootId));
  return [
    ...completed,
    ...existing.filter((entry) => !completedIds.has(entry.penRootId)),
  ].slice(0, 20);
}

function isRecentPencilExport(value: unknown): value is RecentPencilExport {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.name === "string" &&
    typeof entry.penRootId === "string" &&
    /^[A-Za-z0-9]+$/.test(entry.penRootId) &&
    typeof entry.x === "number" &&
    Number.isFinite(entry.x) &&
    typeof entry.y === "number" &&
    Number.isFinite(entry.y) &&
    typeof entry.exportedAt === "string"
  );
}
