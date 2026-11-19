/**
 * Separate agy's own retry progress from its answer, and recognize a terminal
 * backend refusal that arrived as ordinary answer text.
 *
 * Two different things reach the answer channel, because an ACP agent has no
 * other way to report progress:
 *
 * 1. **Retry notices.** `agy` retries a transient upstream failure (503
 *    capacity, 429 rate limit, mid-stream interruption) in-process with
 *    exponential backoff, and streams one line per attempt:
 *    `⚠ API error (attempt 3): UNAVAILABLE (code 503): No capacity available …`.
 *    The run then usually still answers. In the CLI these lines stay in the log
 *    file and the terminal shows only the final text; over ACP they arrive as
 *    `agent_message_chunk`, so a naive bridge mistakes a *recovered* run for a
 *    failed one — and, when it retried for a while, for a long answer that
 *    merely mentions an error.
 * 2. **Terminal refusals.** A refusal that ends the turn carries no answer at
 *    all, so what is left after the notices are removed is empty (or a bare
 *    `FAILED_PRECONDITION` style line).
 *
 * So the classification is: strip notices, then judge the *answer* — never the
 * whole stream, and never its length alone.
 */

/**
 * Retry notices agy writes into the stream, most specific first.
 *
 * `No capacity available` is matched before the generic `UNAVAILABLE` because
 * the capacity refusal also carries the gRPC status name, and naming the real
 * cause is what tells an operator to retry later instead of changing the task.
 */
const BACKEND_FAILURES = [
  { code: 'backend-capacity', pattern: /No capacity available/i },
  { code: 'backend-unavailable', pattern: /FAILED_PRECONDITION/i },
  { code: 'backend-unavailable', pattern: /User location is not supported/i },
  { code: 'backend-unavailable', pattern: /\bUNAVAILABLE\b/ },
  { code: 'backend-quota', pattern: /RESOURCE_EXHAUSTED/i },
]

/**
 * A refusal without a retry notice is the whole reply, so it stays short. The
 * gate exists only for that shape: an answer that happens to mention an error
 * phrase is long, and a notice-led run is judged by its answer (which is empty
 * when the run really failed), not by the stream length.
 */
const MAX_REFUSAL_LENGTH = 250

/** Leading marks agy puts in front of a notice (`⚠ `, with or without VS16). */
const NOTICE_MARKS = /^[\s\u26a0\u2757\ufe0f]+/u

/** Text a notice line starts with, once its marks are stripped. */
const NOTICE_HEAD = 'API error (attempt '

/** How many notice messages one reply remembers for its failure detail. */
const NOTICE_MEMORY = 8

/**
 * Classify a text as a retryable upstream refusal, ignoring length.
 *
 * Used for the notice-only case, where several notices legitimately add up to
 * more than {@link MAX_REFUSAL_LENGTH}: no answer was produced, so any known
 * refusal pattern in what *was* produced is the cause.
 * @param text - refusal-shaped text (notice messages or a bare error line).
 * @returns `{ code, retryable }` when a known refusal matches, else `undefined`.
 */
export function backendRefusal(text) {
  if (typeof text !== 'string' || text.length === 0) return undefined
  for (const failure of BACKEND_FAILURES) {
    if (failure.pattern.test(text)) return { code: failure.code, retryable: true }
  }
  return undefined
}

/**
 * Classify a reply as a retryable upstream refusal.
 * @param text - the answer (notice lines already removed by the caller).
 * @param replyLength - the full answer length, so a long answer that merely
 *   mentions an error is not mistaken for a refusal.
 * @returns `{ code, retryable }` when the reply is a known refusal, else `undefined`.
 */
export function backendFailure(text, replyLength = text?.length) {
  if (typeof text !== 'string' || text.length === 0) return undefined
  if (!Number.isFinite(replyLength) || replyLength > MAX_REFUSAL_LENGTH) return undefined
  return backendRefusal(text)
}

/**
 * Recognize one complete stream line as a retry notice.
 *
 * A line that *quotes* the notice (`API error (attempt 1) is what the log
 * said`) is answer text: only a line whose whole prefix is the warning glyph
 * counts, which is how agy emits it.
 * @param line - one line, without its terminator.
 * @returns `{ attempt, message }` for a notice, else `undefined`.
 */
export function retryNoticeOf(line) {
  if (typeof line !== 'string') return undefined
  const match = /API error \(attempt (\d+)\):\s*(.*)$/.exec(line)
  if (match === null) return undefined
  const prefix = line.slice(0, match.index).replace(NOTICE_MARKS, '')
  if (prefix.length > 0) return undefined
  return { attempt: Number(match[1]), message: match[2].trim() }
}

/**
 * Whether a partial line can still become a retry notice.
 *
 * The splitter holds a partial line only while this is true, so ordinary
 * answer text (which almost never starts with `API error (attempt `) keeps
 * streaming immediately instead of waiting for a newline that may not come.
 * @param buffer - text since the last newline.
 */
function noticePossible(buffer) {
  const head = buffer.replace(NOTICE_MARKS, '')
  if (head.length === 0) return true
  return NOTICE_HEAD.startsWith(head) || head.startsWith(NOTICE_HEAD)
}

/**
 * Split agy's stream into answer text and retry notices.
 *
 * Answer chunks arrive in arbitrary pieces (a whole line, half a line, several
 * lines, no newline at all), so the splitter buffers only as much as a notice
 * needs and forwards everything else at once.
 */
export class ReplyStream {
  /** @param handlers - `onAnswer(text)` and `onNotice({ attempt, message })`, both optional. */
  constructor(handlers = {}) {
    this.onAnswer = typeof handlers.onAnswer === 'function' ? handlers.onAnswer : () => {}
    this.onNotice = typeof handlers.onNotice === 'function' ? handlers.onNotice : () => {}
    this.buffer = ''
    /**
     * Blank lines directly before the current position. agy prefixes a notice
     * with `\n`, and those separators belong to the notice, not to the answer:
     * hold them until the next line decides whether they are paragraph breaks
     * in real text or padding around a notice.
     */
    this.blanks = ''
  }

  /**
   * Feed one stream chunk.
   * @param chunk - the text of one `agent_message_chunk`.
   */
  push(chunk) {
    if (typeof chunk !== 'string' || chunk.length === 0) return
    let rest = chunk
    for (;;) {
      const newline = rest.indexOf('\n')
      if (newline === -1) {
        this.buffer += rest
        // A partial line that cannot become a notice is answer text: forward it
        // now so the job output streams instead of stalling on a newline.
        if (!noticePossible(this.buffer)) {
          const text = this.#takeBlanks() + this.buffer
          this.buffer = ''
          this.onAnswer(text)
        }
        return
      }
      const line = this.buffer + rest.slice(0, newline)
      this.buffer = ''
      rest = rest.slice(newline + 1)
      this.#emitLine(line)
    }
  }

  /** Emit whatever is still buffered (a reply need not end with a newline). */
  flush() {
    const line = this.buffer
    this.buffer = ''
    if (line.length > 0) this.#emitLine(line, false)
    const blanks = this.#takeBlanks()
    if (blanks.length > 0) this.onAnswer(blanks)
  }

  /** @returns the held blank lines, forgetting them. */
  #takeBlanks() {
    const blanks = this.blanks
    this.blanks = ''
    return blanks
  }

  /**
   * Route one complete line.
   * @param line - the line without its terminator.
   * @param terminator - whether a newline followed it, so answer formatting survives.
   */
  #emitLine(line, terminator = true) {
    const notice = retryNoticeOf(line)
    if (notice !== undefined) {
      // The blanks agy put before the notice were notice padding, not text.
      this.blanks = ''
      this.onNotice(notice)
      return
    }
    if (line.trim().length === 0) {
      this.blanks += terminator ? `${line}\n` : line
      return
    }
    this.onAnswer(`${this.#takeBlanks()}${line}${terminator ? '\n' : ''}`)
  }
}

/** Bounded notice log of one reply: messages only, oldest dropped first. */
export function noticeLog() {
  const messages = []
  return {
    /**
     * Record one notice.
     * @param message - the notice's message text.
     */
    add(message) {
      messages.push(message)
      if (messages.length > NOTICE_MEMORY) messages.shift()
    },
    /** @returns the recorded messages, oldest first. */
    messages() { return [...messages] },
  }
}
