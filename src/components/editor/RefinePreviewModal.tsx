/**
 * Refine preview dialog (spec Section 9, Phase 8 — revised UX). Instead of inline
 * accept/reject, a Refine op opens this modal: a spinner while the local model
 * runs (the wait can be long and the model gives no token-level progress), then
 * the finished result for review with **Keep** / **Cancel** — inspired by
 * Outlook's draft-with-AI preview. The model's reasoning is stripped in the
 * backend; only the transformed text reaches here.
 *
 * NOTE: the spinner is a placeholder ([refine-spinner.svg]). To drop in a Win98
 * hourglass, replace that import with an **animated GIF** (or APNG) — animated
 * cursor formats (.ani/.cur) do not render in an <img>. ~36px, transparent bg.
 */

import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { renderMarkdown } from "../../lib/refine-markdown";
import spinner from "../../assets/refine-spinner.svg";
import "./RefinePreviewModal.css";

export interface RefinePreviewState {
  status: "loading" | "done" | "error";
  /** Transformed text (status "done"); may be Markdown. */
  text?: string;
  /** Error message (status "error"). */
  error?: string;
  /** Template name, shown in the title/subhead. */
  templateName: string;
}

export function RefinePreviewModal({
  state,
  cpuOnly,
  onKeep,
  onCancel,
}: {
  state: RefinePreviewState | null;
  /** Show the "may be slow" note while loading on CPU-only machines. */
  cpuOnly: boolean;
  onKeep: () => void;
  onCancel: () => void;
}) {
  if (!state) return null;

  const footer =
    state.status === "done" ? (
      <>
        <Button onClick={onCancel}>Cancel</Button>
        <Button accent onClick={onKeep}>
          Keep
        </Button>
      </>
    ) : state.status === "error" ? (
      <Button onClick={onCancel}>Close</Button>
    ) : (
      <Button onClick={onCancel}>Cancel</Button>
    );

  return (
    <Modal title={`Refine — ${state.templateName}`} open onClose={onCancel} width={560} footer={footer}>
      <div className="v-refprev">
        {state.status === "loading" && (
          <div className="v-refprev__loading">
            <img className="v-refprev__spinner" src={spinner} alt="" aria-hidden="true" />
            <p className="v-refprev__status">Refining your text…</p>
            {cpuOnly && (
              <p className="v-refprev__note">
                This machine has no GPU acceleration — this can take 30–90 seconds.
              </p>
            )}
          </div>
        )}

        {state.status === "done" && (
          <div
            className="v-refprev__result v-prose"
            // markdown-it runs with html:false, so this is markdown-generated
            // tags only (no raw HTML injection) — same content "Keep" inserts.
            dangerouslySetInnerHTML={{ __html: renderMarkdown(state.text ?? "") }}
          />
        )}

        {state.status === "error" && <p className="v-refprev__error">{state.error}</p>}
      </div>
    </Modal>
  );
}
