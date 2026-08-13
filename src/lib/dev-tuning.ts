/**
 * Debug-only interval overrides for the two-process rig
 * (docs/satchels-and-sync.md 5.6).
 *
 * The handoff intervals are minutes long by design, which makes every
 * observation of them cost minutes. This lets the rig shorten them without
 * touching the shipped constants: the defaults still live where they always
 * did, and this only ever *reads* them.
 *
 * It cannot affect a shipped build. `import.meta.env.DEV` is a compile-time
 * constant that Vite replaces with `false` in a production build, so the whole
 * body below is eliminated and the caller is left with the shipped default.
 */
export function devIntervalMs(name: string, shipped: number): number {
  if (!import.meta.env.DEV) return shipped;
  const raw = (import.meta.env as unknown as Record<string, string | undefined>)[name];
  const ms = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : shipped;
}
