// Compute a new id ordering when `dragged` is dropped onto `target`.
// The dragged id is removed and reinserted next to the target — immediately
// before it by default, or after it when `placeAfter` is set (lets a drop on the
// lower half of a row, including past the last item, land where it's shown).
export function reorderByDrop(
  ids: string[],
  dragged: string,
  target: string,
  placeAfter = false,
): string[] {
  if (dragged === target) return ids;
  const without = ids.filter((id) => id !== dragged);
  const targetIdx = without.indexOf(target);
  if (targetIdx === -1) return ids;
  without.splice(placeAfter ? targetIdx + 1 : targetIdx, 0, dragged);
  return without;
}

// Every in-app list-reorder drag (pages, sections, notebooks) carries this custom
// MIME type so non-list drop zones (the editor body + its wrapper, the attachment
// bar) can recognize and reject it — reordering is confined to its own list. OS
// file drags (types "Files") are unaffected, so dropping images/attachments still
// works everywhere it did.
export const REORDER_DRAG_TYPE = "application/x-vellum-reorder";

/** True while an in-app list-reorder drag is in flight (vs. a file/text drag). */
export function isReorderDrag(dt: DataTransfer | null): boolean {
  return !!dt && dt.types.includes(REORDER_DRAG_TYPE);
}
