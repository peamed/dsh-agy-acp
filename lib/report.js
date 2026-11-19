/**
 * Outcome vocabulary for runs that end without any answer text.
 *
 * agy can end a turn with `end_turn` and nothing streamed: the model stops after
 * a denied tool call, or a message injected mid-run ends the current turn and
 * starts a fresh one. Either way a *completed* job would hand the parent a
 * silent success, which is what makes "no feedback" look like a finished task.
 */

/**
 * The failure detail for an empty run.
 * @param injected - whether a message was delivered to this run while in flight.
 * @returns a stable, greppable detail.
 */
export function emptyRunDetail(injected) {
  return injected ? 'injected-message-ended-turn' : 'no-answer-text'
}
