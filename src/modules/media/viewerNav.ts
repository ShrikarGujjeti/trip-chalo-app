/**
 * Pure helper for the viewer: which item to show after the open one disappears from the list
 * (removed by this user, or by a refresh). Returns the id now occupying the same position (the old
 * "next"), else the new last item, else null (nothing left: close the viewer).
 */
export function pickAfterRemoval(ids: readonly string[], removedIndex: number): string | null {
  if (ids.length === 0) return null;
  return ids[Math.min(Math.max(removedIndex, 0), ids.length - 1)];
}
