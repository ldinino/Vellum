/**
 * Reading "another device has this Satchel" back out of a backend error.
 *
 * The backend builds the sentence once (`sync::IN_USE_PREFIX` in
 * src-tauri/src/sync/mod.rs) and every refusal — the opening pull and the push
 * alike — carries it. The window has to tell that refusal apart from any other
 * sync failure, so the prefix is a cross-language contract; this is the single
 * place the frontend knows about it.
 */

/** Must match `sync::IN_USE_PREFIX`. */
export const SATCHEL_IN_USE = "This Satchel is open on";

/** True when this error is another device holding the Satchel. */
export function isSatchelInUse(message: string): boolean {
  return message.includes(SATCHEL_IN_USE);
}

/**
 * The device named in a refusal, or null if the error is something else.
 *
 * The sentence is `<prefix> <device>. <consequence>`, so the name ends at the
 * first full stop. Windows computer names cannot contain one.
 */
export function heldDeviceFrom(message: string): string | null {
  const at = message.indexOf(SATCHEL_IN_USE);
  if (at < 0) return null;
  const rest = message.slice(at + SATCHEL_IN_USE.length).trimStart();
  const stop = rest.indexOf(".");
  const name = (stop < 0 ? rest : rest.slice(0, stop)).trim();
  return name.length > 0 ? name : null;
}
