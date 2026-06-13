import { Icon } from "../ui/Icon";
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
  onOpen?: (id: string) => void;
  onContextMenu?: (id: string, e: React.MouseEvent) => void;
}

/** Email-style attachment strip pinned above the page (spec Section 12). */
export function AttachmentBar({ attachments, onOpen, onContextMenu }: AttachmentBarProps) {
  if (attachments.length === 0) return null;
  return (
    <div className="v-attachbar">
      <span className="v-attachbar__label">
        <Icon name="paper-clip" />
      </span>
      {attachments.map((a) => (
        <button
          key={a.id}
          type="button"
          className="v-attachbar__chip"
          title={`${a.filename} (${a.size})`}
          onClick={() => onOpen?.(a.id)}
          onContextMenu={(e) => onContextMenu?.(a.id, e)}
        >
          <Icon name={a.icon ?? "document"} />
          <span className="v-attachbar__name">{a.filename}</span>
          <span className="v-attachbar__size">{a.size}</span>
        </button>
      ))}
    </div>
  );
}
