/** Thrown when the wrapped work outlives its budget. */
export class TimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} did not settle within ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Bounds a promise that talks to something over a network.
 *
 * A readiness probe whose database call hangs is worse than one that reports
 * `down`: the monitor sees no answer at all, and the platform's own health check
 * times out instead of being told what is broken.
 */
export async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new TimeoutError(label, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
