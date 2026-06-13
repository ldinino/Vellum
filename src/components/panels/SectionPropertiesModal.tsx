import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { useVellum } from "../../state/vellum";
import { PALETTE } from "../../data/palette";
import "./SectionPropertiesModal.css";

interface Props {
  notebookId: string;
  sectionId: string;
  open: boolean;
  onClose: () => void;
}

/**
 * Section Properties (spec Section 5 / Phase 1). The page-template dropdown is
 * present but only offers "None" until the template library exists (Phase 6).
 */
export function SectionPropertiesModal({ notebookId, sectionId, open, onClose }: Props) {
  const { notebooks, actions } = useVellum();
  const section = notebooks
    .find((n) => n.id === notebookId)
    ?.sections?.find((s) => s.id === sectionId);

  const [name, setName] = useState("");
  const [color, setColor] = useState<string | null>(null);

  useEffect(() => {
    if (open && section) {
      setName(section.name);
      setColor(section.color);
    }
  }, [open, section]);

  if (!section) return null;

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    actions.updateSection(notebookId, sectionId, trimmed, color, section.pageTemplateId);
    onClose();
  };

  return (
    <Modal
      title="Section Properties"
      open={open}
      onClose={onClose}
      width={420}
      footer={
        <>
          <Button accent onClick={save}>
            OK
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <div className="v-secprops">
        <label className="v-secprops__field">
          <span>Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
            autoFocus
          />
        </label>

        <div className="v-secprops__field">
          <span>Color</span>
          <div className="v-secprops__swatches">
            {PALETTE.map((c) => (
              <button
                key={c.value}
                type="button"
                className={[
                  "v-secprops__swatch",
                  color === c.value ? "v-secprops__swatch--selected" : "",
                ].join(" ")}
                style={{ background: c.value }}
                title={c.name}
                aria-label={c.name}
                onClick={() => setColor(c.value)}
              />
            ))}
            <button
              type="button"
              className={[
                "v-secprops__swatch v-secprops__swatch--none",
                color === null ? "v-secprops__swatch--selected" : "",
              ].join(" ")}
              title="None"
              aria-label="No color"
              onClick={() => setColor(null)}
            />
          </div>
        </div>

        <label className="v-secprops__field">
          <span>New Page Template</span>
          <select value="none" disabled>
            <option value="none">None</option>
          </select>
          <small className="v-secprops__hint">
            Page templates arrive in a later phase.
          </small>
        </label>
      </div>
    </Modal>
  );
}
