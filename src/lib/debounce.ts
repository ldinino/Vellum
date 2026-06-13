/**
 * Trailing debounce with a maxWait ceiling. A plain trailing debounce defers
 * forever during continuous typing; maxWait forces a call at least that often,
 * so auto-save still fires mid-burst. `flush` runs any pending call now (used
 * when switching pages so the outgoing page persists immediately).
 */
export interface Debouncer {
  schedule: (fn: () => void) => void;
  flush: () => void;
  cancel: () => void;
}

export function createDebouncer(wait: number, maxWait: number): Debouncer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstScheduledAt = 0;
  let pending: (() => void) | null = null;

  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    firstScheduledAt = 0;
  };

  const run = () => {
    const fn = pending;
    pending = null;
    clear();
    fn?.();
  };

  return {
    schedule(fn) {
      pending = fn;
      const now = Date.now();
      if (firstScheduledAt === 0) firstScheduledAt = now;
      if (timer) clearTimeout(timer);
      const sinceFirst = now - firstScheduledAt;
      const delay = Math.max(0, Math.min(wait, maxWait - sinceFirst));
      timer = setTimeout(run, delay);
    },
    flush() {
      if (pending) run();
    },
    cancel() {
      pending = null;
      clear();
    },
  };
}
