export function longestTextSegment<T extends { start: number; end: number }>(
  segments: readonly T[],
): T | undefined {
  let selected: T | undefined;
  let selectedLength = -1;
  for (const segment of segments) {
    const length = Math.max(0, segment.end - segment.start);
    if (length > selectedLength) {
      selected = segment;
      selectedLength = length;
    }
  }
  return selected;
}
