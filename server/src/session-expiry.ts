export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Node timers overflow when the delay exceeds the signed 32-bit millisecond limit. */
export function safeTimerDelay(remainingMs: number): number {
  if (!Number.isFinite(remainingMs)) return MAX_TIMER_DELAY_MS;
  return Math.min(Math.max(1, Math.ceil(remainingMs)), MAX_TIMER_DELAY_MS);
}

/** Re-checks long deadlines in safe-sized chunks and returns an idempotent cancel function. */
export function scheduleUntil(deadlineMs: number, callback: () => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  let cancelled = false;

  const check = () => {
    if (cancelled) return;
    if (!Number.isFinite(deadlineMs)) {
      callback();
      return;
    }

    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) {
      callback();
      return;
    }

    timer = setTimeout(check, safeTimerDelay(remaining));
    timer.unref?.();
  };

  check();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}
