/**
 * When a device should hand the Satchel back (docs/satchels-and-sync.md 5.2).
 *
 * Kept apart from the session provider deliberately: this is the whole rule,
 * and the rule is the thing worth testing. The provider is only the wiring that
 * feeds it focus and input.
 */

/**
 * How long an unfocused window may sit with no input before it hands the
 * Satchel back.
 *
 * Short on purpose. Yielding too early costs one round trip on return, and the
 * optimistic re-acquire hides it — the window is typable throughout. Yielding
 * too late costs the arriving device a wait, which is the entire thing this
 * exists to remove. Expect this to be retuned.
 */
export const YIELD_IDLE_MS = 60 * 1000;

export interface Presence {
  /** Whether the Vellum window currently has focus. */
  focused: boolean;
  /** When this window last saw a keystroke or pointer movement, in ms. */
  lastInputAt: number;
}

/**
 * Milliseconds until this device should hand the Satchel back, or `null` if it
 * should not.
 *
 * A focused window never yields, however long it has been still: reading a long
 * page is using it. And an unfocused one does not yield at once either — that
 * would drop the Satchel every time you alt-tab to a browser. Both conditions
 * have to hold.
 */
export function msUntilYield(
  presence: Presence,
  now: number,
  idleMs: number = YIELD_IDLE_MS,
): number | null {
  if (presence.focused) return null;
  return Math.max(0, presence.lastInputAt + idleMs - now);
}

/** Whether the Satchel should be handed back right now. */
export function shouldYieldNow(
  presence: Presence,
  now: number,
  idleMs: number = YIELD_IDLE_MS,
): boolean {
  return msUntilYield(presence, now, idleMs) === 0;
}
