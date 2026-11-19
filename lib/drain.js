/**
 * Whether the post-settle drain should keep waiting for an answer that a
 * folded-in message produces after `end_turn`.
 *
 * Extracted from the job loop so the window can be tested without a child
 * process. A run that never injected anything must not reach this function at
 * all: the caller returns immediately when nothing was sent, which is why a
 * normal run pays no extra latency.
 *
 * @param elapsedMs - time since the original prompt settled.
 * @param sinceStreamMs - time since the child last sent any session update.
 * @param options - the window: `minMs` grace before silence counts, `quietMs`
 *   silence that ends the drain, `maxMs` ceiling, `aborted` cancellation.
 * @returns whether to keep the child alive for another tick.
 */
export function keepDraining(elapsedMs, sinceStreamMs, options) {
  const { minMs, quietMs, maxMs, aborted } = options
  if (aborted) return false
  if (elapsedMs >= maxMs) return false
  if (elapsedMs < minMs) return true
  return sinceStreamMs < quietMs
}