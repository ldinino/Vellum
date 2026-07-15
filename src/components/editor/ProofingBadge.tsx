/**
 * Ambient proofing badge (execution-plan #5). Appears in the top toolbar only
 * when a scope has quieted grammar or spelling for the open page — so a page
 * with no underlines never looks like the checker is broken. It's a plain
 * one-click button: clicking turns all proofreading back on for THIS page
 * (overriding its section/notebook), without touching any other page.
 */

import { ToolbarButton } from "../ui/Toolbar";
import { useVellum } from "../../state/vellum";

export function ProofingBadge() {
  const { proofing, selectedNotebookId, selectedPageId, actions } = useVellum();

  if (!selectedPageId || !selectedNotebookId || !proofing.suppressed) return null;

  return (
    <div className="v-proofbadge">
      <ToolbarButton
        icon="spell-check"
        caption="Proofread this page"
        label="Proofreading is off for this page. Click to turn it on."
        className="v-proofbadge__button"
        onClick={() =>
          void actions.setPageProofing(selectedNotebookId, selectedPageId, true, true)
        }
      />
    </div>
  );
}
