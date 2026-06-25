/**
 * Shared "Insert / Edit Link" dialog (spec Section 6). Edits a link's visible
 * **Text** and its **Address**. Used by the editor's right-click "Edit Link…"
 * ([EditorContextMenu]) and the toolbar's "Insert link" button ([EditorToolbar]),
 * so both entry points share one themed modal.
 */

import { useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import "./LinkDialog.css";

export function LinkDialog({
  title = "Link",
  initialHref,
  initialText,
  onSubmit,
  onCancel,
}: {
  /** Dialog title — e.g. "Insert Link" vs "Edit Link". */
  title?: string;
  initialHref: string;
  initialText: string;
  onSubmit: (href: string, text: string) => void;
  onCancel: () => void;
}) {
  const [href, setHref] = useState(initialHref);
  const [text, setText] = useState(initialText);
  const submit = () => onSubmit(href.trim(), text.trim());
  return (
    <Modal
      title={title}
      open
      onClose={onCancel}
      width={420}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button accent onClick={submit}>
            OK
          </Button>
        </>
      }
    >
      <div className="v-link-dialog">
        <label htmlFor="v-link-text">Text</label>
        <input
          id="v-link-text"
          type="text"
          value={text}
          autoFocus
          placeholder="Link text"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
        <label htmlFor="v-link-url">Address</label>
        <input
          id="v-link-url"
          type="text"
          value={href}
          placeholder="https://example.com"
          onChange={(e) => setHref(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
      </div>
    </Modal>
  );
}
