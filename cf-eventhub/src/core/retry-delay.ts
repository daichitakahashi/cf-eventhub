import type { ConstantRetryDelay, ExponentialRetryDelay } from "./hub/routing";

/** Calculate next retry delay based on the strategy. */
export function nextDelay({
  attempts,
  retryDelay,
}: {
  attempts: number;
  retryDelay?: ConstantRetryDelay | ExponentialRetryDelay;
}): number | undefined {
  if (!retryDelay) {
    return undefined;
  }
  if (retryDelay.type === "exponential") {
    return exponentialBackoff(retryDelay.base, retryDelay.max, attempts);
  }
  return retryDelay.interval;
}

function randomBetween(min: number, max: number) {
  return Math.random() * (max - min) + min;
}

function decorrelatedJitter(base: number, max: number, prev: number) {
  return Math.floor(Math.min(max, randomBetween(base, prev * 3))); // decorrelated jitter
}

function exponentialBackoff(base: number, max: number, attempts: number) {
  let delay = base;
  for (let i = 0; i < attempts; i++) {
    delay = decorrelatedJitter(base, max, delay);
  }
  return delay;
}
