import { useState } from "react";
import { reorderByDrop, REORDER_DRAG_TYPE } from "./dnd";

type Axis = "vertical" | "horizontal";

interface DropTarget {
  id: string;
  /** Drop on the far edge of the target (bottom for vertical, right for
   *  horizontal) rather than the near edge. */
  after: boolean;
  group: string | null;
}

interface Options {
  /** vertical = insertion line spans the row at its top/bottom; horizontal =
   *  a vertical line at a tab's left/right. Drives the pointer axis + edge math. */
  axis: Axis;
  /** Ordered ids for the reorder scope of `group` (the dragged item's
   *  `data-dnd-group`; null when the list isn't grouped). */
  idsOf: (group: string | null) => string[];
  /** Commit the new order for a group. */
  onReorder: (orderedIds: string[], group: string | null) => void;
  /** BEM-ish base for the insertion-line class, e.g. "v-pagelist__item" yields
   *  "v-pagelist__item--drop-before" / "--drop-after". */
  dropClassBase: string;
}

/**
 * Shared list-reorder drag-and-drop, distilled from the page-strip work:
 *  - effectAllowed/dropEffect pinned to "move" and preventDefault on BOTH
 *    dragEnter and dragOver, so the cursor never flickers (incl. when crossing
 *    into a new item — preventing only dragOver leaves a per-item no-drop blink).
 *  - All tracking on the CONTAINER (one continuous drop zone, no gap dead spots);
 *    the target item + edge are derived from the pointer vs each item's rect.
 *  - An insertion line on the target edge, hidden on the dragged item and on
 *    no-op positions.
 *  - The drag carries REORDER_DRAG_TYPE so non-list zones (editor, attachment
 *    bar) can reject it.
 *
 * Items must carry `data-dnd-id` (and `data-dnd-group` when grouped). Handlers
 * are exposed individually so several instances can share one container (e.g.
 * notebooks + sections in the nav tree): each only acts on its own drag.
 */
export function useReorderDrag({ axis, idsOf, onReorder, dropClassBase }: Options) {
  const [dragging, setDragging] = useState<{ id: string; group: string | null } | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  const reset = () => {
    setDragging(null);
    setDropTarget(null);
  };

  const onItemDragStart = (
    e: React.DragEvent<HTMLElement>,
    id: string,
    group: string | null = null,
  ) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(REORDER_DRAG_TYPE, id);
    setDragging({ id, group });
  };

  // Serves both dragEnter and dragOver. Bails for any drag that isn't this list's
  // own (so multiple hooks can share a container).
  const onContainerDragOver = (e: React.DragEvent<HTMLElement>) => {
    if (!dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const horizontal = axis === "horizontal";
    const items = Array.from(
      e.currentTarget.querySelectorAll<HTMLElement>("[data-dnd-id]"),
    ).filter((el) => (el.dataset.dndGroup ?? null) === dragging.group);
    if (items.length === 0) {
      setDropTarget(null);
      return;
    }
    const pos = horizontal ? e.clientX : e.clientY;
    // Nearest item to the pointer (snapping through gaps and past the ends).
    let target = items[0];
    for (const el of items) {
      const r = el.getBoundingClientRect();
      if (pos >= (horizontal ? r.left : r.top)) target = el;
      else break;
    }
    const r = target.getBoundingClientRect();
    const mid = horizontal ? r.left + r.width / 2 : r.top + r.height / 2;
    setDropTarget({ id: target.dataset.dndId ?? "", after: pos > mid, group: dragging.group });
  };

  const onContainerDrop = (e: React.DragEvent<HTMLElement>) => {
    if (!dragging) return;
    e.preventDefault();
    if (dropTarget) {
      const ids = idsOf(dropTarget.group);
      const order = reorderByDrop(ids, dragging.id, dropTarget.id, dropTarget.after);
      // Skip the commit when the drop wouldn't change anything.
      if (order.join("\u0000") !== ids.join("\u0000")) onReorder(order, dropTarget.group);
    }
    reset();
  };

  const onContainerDragLeave = (e: React.DragEvent<HTMLElement>) => {
    if (!dragging) return;
    // Hide the indicator only when the drag leaves the container outright (not
    // when moving between items inside it).
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(null);
  };

  // The insertion-line class for an item, or "" — hidden on the dragged item
  // itself and wherever the drop would be a no-op (right where it already sits).
  const dropClass = (id: string): string => {
    if (!dropTarget || dropTarget.id !== id || !dragging || dragging.id === id) return "";
    const ids = idsOf(dropTarget.group);
    const dragIndex = ids.indexOf(dragging.id);
    const targetIndex = ids.indexOf(id);
    if (!dropTarget.after && targetIndex === dragIndex + 1) return "";
    if (dropTarget.after && targetIndex === dragIndex - 1) return "";
    return `${dropClassBase}--drop-${dropTarget.after ? "after" : "before"}`;
  };

  return {
    /** Id of the item currently being dragged (for the `--dragging` class). */
    draggingId: dragging?.id ?? null,
    onItemDragStart,
    onItemDragEnd: reset,
    onContainerDragOver,
    onContainerDrop,
    onContainerDragLeave,
    dropClass,
  };
}
