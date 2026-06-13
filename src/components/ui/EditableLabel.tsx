import { useEffect, useRef, useState } from "react";

interface EditableLabelProps {
  value: string;
  editing: boolean;
  onCommit: (next: string) => void;
  onCancel: () => void;
  className?: string;
  placeholder?: string;
}

/**
 * Renders text, or an inline input while `editing`. Enter commits, Escape
 * cancels, blur commits. The parent owns the `editing` flag (set it from a
 * Rename action or F2).
 */
export function EditableLabel({
  value,
  editing,
  onCommit,
  onCancel,
  className,
  placeholder,
}: EditableLabelProps) {
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(value);
      // Focus + select on the next frame so the input exists.
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing, value]);

  if (!editing) {
    return <span className={className}>{value || placeholder}</span>;
  }

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) onCommit(trimmed);
    else onCancel();
  };

  return (
    <input
      ref={inputRef}
      className={`v-editable-input ${className ?? ""}`}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // Keep Enter/Escape/arrows from reaching list keyboard handlers.
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={commit}
    />
  );
}
