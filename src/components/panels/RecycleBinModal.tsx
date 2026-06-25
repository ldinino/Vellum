import { useEffect } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { useVellum } from "../../state/vellum";
import type { RecycleItem } from "../../data/types";
import "./RecycleBinModal.css";

/** Fugue glyph per item kind. */
const KIND_ICON: Record<RecycleItem["kind"], string> = {
  notebook: "book",
  section: "folder",
  page: "document",
  attachment: "paper-clip",
};

const KIND_LABEL: Record<RecycleItem["kind"], string> = {
  notebook: "Notebook",
  section: "Section",
  page: "Page",
  attachment: "Attachment",
};

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

/** Where an item lived, always rooted at its notebook. */
function breadcrumb(item: RecycleItem): string {
  if (item.kind === "notebook") return "Notebook";
  if (item.kind === "section") return item.notebookName;
  // page / attachment: notebook › section [/ page]
  return item.parent ? `${item.notebookName} › ${item.parent}` : item.notebookName;
}

interface RecycleBinModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * The global Recycle Bin (spec Section 5.1): soft-deleted notebooks, sections,
 * pages, and attachments from every notebook, each restorable or purgeable.
 * Deletes are silent (recoverable); only permanent removal here confirms.
 */
export function RecycleBinModal({ open, onClose }: RecycleBinModalProps) {
  const { recycleBin, actions } = useVellum();

  // Refresh from the backend each time the bin is opened.
  useEffect(() => {
    if (open) actions.loadRecycleBin();
  }, [open, actions]);

  const empty = recycleBin.length === 0;

  async function confirmPurge(item: RecycleItem) {
    const what =
      item.kind === "notebook"
        ? `notebook "${item.name}" and everything in it`
        : item.kind === "section"
          ? `section "${item.name}" and all its pages`
          : `${KIND_LABEL[item.kind].toLowerCase()} "${item.name}"`;
    const ok = await ask(`Permanently delete ${what}? This cannot be undone.`, {
      title: "Delete Permanently",
      kind: "warning",
    });
    if (ok) actions.purgeItem(item);
  }

  async function confirmEmpty() {
    const ok = await ask(
      `Permanently delete all ${recycleBin.length} item(s) in the Recycle Bin? This cannot be undone.`,
      { title: "Empty Recycle Bin", kind: "warning" },
    );
    if (ok) actions.emptyRecycleBin();
  }

  return (
    <Modal
      title="Recycle Bin"
      open={open}
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button icon="cross" onClick={confirmEmpty} disabled={empty}>
            Empty Recycle Bin
          </Button>
          <Button accent onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <div className="v-recyclebin">
        {empty ? (
          <div className="v-recyclebin__empty">
            <Icon name="bin-metal" />
            <p>The Recycle Bin is empty.</p>
            <p className="v-recyclebin__hint">
              Deleted notebooks, sections, pages, and attachments appear here and
              can be restored.
            </p>
          </div>
        ) : (
          <ul className="v-recyclebin__list">
            {recycleBin.map((item) => (
              <li key={`${item.kind}:${item.id}`} className="v-recyclebin__item">
                <Icon name={KIND_ICON[item.kind]} className="v-recyclebin__icon" />
                <div className="v-recyclebin__info">
                  <div className="v-recyclebin__name" title={item.name}>
                    {item.name}
                  </div>
                  <div className="v-recyclebin__meta">
                    <span className="v-recyclebin__kind">{KIND_LABEL[item.kind]}</span>
                    <span className="v-recyclebin__sep">·</span>
                    <span className="v-recyclebin__crumb" title={breadcrumb(item)}>
                      {breadcrumb(item)}
                    </span>
                    {item.size != null && (
                      <>
                        <span className="v-recyclebin__sep">·</span>
                        <span>{formatSize(item.size)}</span>
                      </>
                    )}
                    {formatWhen(item.deletedAt) && (
                      <>
                        <span className="v-recyclebin__sep">·</span>
                        <span title="Deleted">{formatWhen(item.deletedAt)}</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="v-recyclebin__actions">
                  <Button
                    icon="arrow-circle-225-left"
                    onClick={() => actions.restoreItem(item)}
                  >
                    Restore
                  </Button>
                  <Button icon="cross-small" onClick={() => confirmPurge(item)}>
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
