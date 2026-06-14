import { useState } from "react";
import { Icon } from "../ui/Icon";
import { ContextMenu } from "../ui/ContextMenu";
import "./AttachmentBar.css";

export interface AttachmentItem {
  id: string;
  filename: string;
  /** Human-readable size, e.g. "1.2 MB". */
  size: string;
  /** Fugue icon name by file type; defaults to a generic document. */
  icon?: string;
}

interface AttachmentBarProps {
  attachments: AttachmentItem[];
  onOpen: (id: string) => void;
  onRemove: (id: string) => void;
  /** Files dropped onto the bar — attach all of them. */
  onAttachFiles: (files: FileList) => void;
}

/**
 * Email-style attachment strip pinned above the page (spec Section 12). Always
 * shown so it's a stable drop target; when empty it invites a drag.
 */
export function AttachmentBar({ attachments, onOpen, onRemove, onAttachFiles }: AttachmentBarProps) {
  const [dragOver, setDragOver] = useState(false);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  const classes = ["v-attachbar"];
  if (dragOver) classes.push("v-attachbar--dragover");
  if (attachments.length === 0) classes.push("v-attachbar--empty");

  return (
    <div
      className={classes.join(" ")}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragOver(false);
        if (e.dataTransfer.files.length) onAttachFiles(e.dataTransfer.files);
      }}
    >
      <span className="v-attachbar__label">
        <Icon name="paper-clip" />
      </span>
      {attachments.length === 0 ? (
        <span className="v-attachbar__hint">Drag files here to attach</span>
      ) : (
        attachments.map((a) => (
          <button
            key={a.id}
            type="button"
            className="v-attachbar__chip"
            title={`${a.filename} (${a.size})`}
            onClick={() => onOpen(a.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ id: a.id, x: e.clientX, y: e.clientY });
            }}
          >
            <Icon name={a.icon ?? "document"} />
            <span className="v-attachbar__name">{a.filename}</span>
            <span className="v-attachbar__size">{a.size}</span>
          </button>
        ))
      )}

      {menu && (
        <ContextMenu
          items={[
            { label: "Open", icon: "blue-folder", onSelect: () => onOpen(menu.id) },
            {
              label: "Remove",
              icon: "cross-small",
              danger: true,
              onSelect: () => onRemove(menu.id),
            },
          ]}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
