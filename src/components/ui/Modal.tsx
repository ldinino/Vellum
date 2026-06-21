import { ReactNode, useEffect } from "react";
import "./Modal.css";

interface ModalProps {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Footer buttons (OK / Cancel etc.). */
  footer?: ReactNode;
  width?: number;
}

/** Aero-glass dialog: glass frame, sheen highlight, inset content panel. */
export function Modal({ title, open, onClose, children, footer, width = 420 }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="v-modal__backdrop" onMouseDown={onClose}>
      <div
        className="v-modal"
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="v-modal__titlebar">
          <span className="v-modal__title">{title}</span>
          {/* The X glyph is a white CSS mask (Modal.css), not a raster icon. */}
          <button
            type="button"
            className="v-modal__close"
            aria-label="Close"
            onClick={onClose}
          />
        </div>
        <div className="v-modal__body">{children}</div>
        {footer && <div className="v-modal__footer">{footer}</div>}
      </div>
    </div>
  );
}
