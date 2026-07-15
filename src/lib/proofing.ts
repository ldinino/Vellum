/**
 * Pure resolution of scoped proofreading (execution-plan #5). Grammar and
 * spelling resolve independently, most-specific-wins: the open page's own
 * preference beats its section's, which beats its notebook's, defaulting to on
 * when every scope inherits. The global master toggle (Settings ▸ Proofing) is
 * a hard switch — when a category is off globally, no scope can turn it back on.
 */

/** A per-scope proofreading preference: true = on, false = off, null/undefined
 * = inherit from a broader scope (or the global default). */
export type ProofPref = boolean | null | undefined;

/** Resolve one category (grammar or spelling) for the open page. */
export function resolveProofing(
  globalOn: boolean,
  notebook: ProofPref,
  section: ProofPref,
  page: ProofPref,
): boolean {
  if (!globalOn) return false;
  for (const pref of [page, section, notebook]) {
    if (pref === true || pref === false) return pref;
  }
  return true;
}
