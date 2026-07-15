/**
 * Shared builder for the "Proofread" scope controls (execution-plan #5),
 * surfaced in Tools ▸ Proofread. Grammar and spelling toggle independently at
 * each scope (This Page / This Section / This Notebook); most-specific-wins, so
 * a page can turn a category back on over a section/notebook that turned it off.
 * Each checkbox shows the category's effective on/off at that scope, and
 * clicking sets an explicit pref there; a row disables (with a hint) when that
 * category's global master is off in Settings ▸ Proofing.
 */

import type { MenuItem } from "./ui/ContextMenu";
import type { ProofingScope, ProofingState, VellumActions } from "../state/vellum";

interface ProofreadMenuArgs {
  proofing: ProofingState;
  notebookId: string | null;
  sectionId: string | null;
  pageId: string | null;
  actions: Pick<
    VellumActions,
    "setPageProofing" | "setSectionProofing" | "setNotebookProofing"
  >;
}

export function buildProofreadMenu({
  proofing,
  notebookId,
  sectionId,
  pageId,
  actions,
}: ProofreadMenuArgs): MenuItem[] {
  const { globalGrammar, globalSpell } = proofing;

  // One scope's Grammar + Spelling toggles. Each flips its own category to the
  // opposite of the effective state at this scope and passes the other
  // category's current stored pref through unchanged.
  const scopeSub = (
    scope: ProofingScope,
    setPrefs: (g: boolean | null, s: boolean | null) => void,
  ): MenuItem[] => [
    {
      label: "Grammar",
      icon: "blog--pencil",
      checked: scope.grammarEffective,
      disabled: !globalGrammar,
      hint: globalGrammar ? undefined : "off in Settings",
      onSelect: () => setPrefs(!scope.grammarEffective, scope.spellPref),
    },
    {
      label: "Spelling",
      icon: "spell-check",
      checked: scope.spellEffective,
      disabled: !globalSpell,
      hint: globalSpell ? undefined : "off in Settings",
      onSelect: () => setPrefs(scope.grammarPref, !scope.spellEffective),
    },
  ];

  return [
    {
      label: "This Page",
      icon: "document",
      disabled: !proofing.page.available,
      submenu:
        proofing.page.available && notebookId && pageId
          ? scopeSub(proofing.page, (g, s) =>
              void actions.setPageProofing(notebookId, pageId, g, s),
            )
          : undefined,
    },
    {
      label: "This Section",
      icon: "folder",
      disabled: !proofing.section.available,
      submenu:
        proofing.section.available && notebookId && sectionId
          ? scopeSub(proofing.section, (g, s) =>
              void actions.setSectionProofing(notebookId, sectionId, g, s),
            )
          : undefined,
    },
    {
      label: "This Notebook",
      icon: "book",
      disabled: !proofing.notebook.available,
      submenu:
        proofing.notebook.available && notebookId
          ? scopeSub(proofing.notebook, (g, s) =>
              void actions.setNotebookProofing(notebookId, g, s),
            )
          : undefined,
    },
  ];
}
