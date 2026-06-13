// Compute a new id ordering when `dragged` is dropped onto `target`.
// The dragged id is removed and reinserted immediately before the target.
export function reorderByDrop(
  ids: string[],
  dragged: string,
  target: string,
): string[] {
  if (dragged === target) return ids;
  const without = ids.filter((id) => id !== dragged);
  const targetIdx = without.indexOf(target);
  if (targetIdx === -1) return ids;
  without.splice(targetIdx, 0, dragged);
  return without;
}
