import assert from 'node:assert/strict'
import {
  ReplyStream,
  backendFailure,
  backendRefusal,
  noticeLog,
  retryNoticeOf,
} from '../lib/backend.js'

// ── the observed refusal ────────────────────────────────────────────────────
// The backend rejects the request's geolocation, agy streams it as ordinary
// answer text, then reports end_turn.
assert.deepEqual(
  backendFailure('⚠ FAILED_PRECONDITION (code 400): User location is not supported for the API use.'),
  { code: 'backend-unavailable', retryable: true },
)

// Each pattern stands alone: agy's text varies across versions and locales.
assert.equal(backendFailure('FAILED_PRECONDITION')?.code, 'backend-unavailable')
assert.equal(backendFailure('User location is not supported')?.code, 'backend-unavailable')
assert.equal(backendFailure('the model returned UNAVAILABLE')?.code, 'backend-unavailable')
assert.equal(backendFailure('RESOURCE_EXHAUSTED: quota')?.code, 'backend-quota')

// A real answer never matches, including one that merely mentions an error.
assert.equal(backendFailure('已读取四个文件，要点如下……'), undefined)
// A long answer that merely mentions the phrase is not a refusal: the whole
// reply must be short, which is what an upstream rejection looks like.
assert.equal(
  backendFailure('I fixed the FAILED_PRECONDITION handling in the code', 900),
  undefined,
)
assert.deepEqual(backendFailure('FAILED_PRECONDITION', 83), { code: 'backend-unavailable', retryable: true })
assert.equal(backendFailure(''), undefined)
assert.equal(backendFailure(undefined), undefined)
assert.equal(backendFailure(null), undefined)

// ── the 503 capacity retry notice ───────────────────────────────────────────
const notice = attempt =>
  `\n⚠ API error (attempt ${attempt}): UNAVAILABLE (code 503): No capacity available for model gemini-3.8-flash-high on the server\n`

// The capacity refusal names its real cause, so the detail tells an operator to
// wait instead of rewriting the task.
assert.equal(backendRefusal('UNAVAILABLE (code 503): No capacity available for model x')?.code, 'backend-capacity')
assert.equal(backendRefusal('RESOURCE_EXHAUSTED')?.code, 'backend-quota')
assert.equal(backendRefusal('')?.code, undefined)

// A notice is recognized as progress, whatever the attempt number.
assert.deepEqual(retryNoticeOf('⚠ API error (attempt 5): UNAVAILABLE (code 503): No capacity available'), {
  attempt: 5,
  message: 'UNAVAILABLE (code 503): No capacity available',
})
// Marks vary; agy has used the bare form too.
assert.equal(retryNoticeOf('API error (attempt 1): UNAVAILABLE')?.attempt, 1)
// A line that merely QUOTES the notice is answer text: only the leading glyph
// form counts, so a real answer about this failure survives.
assert.equal(retryNoticeOf('The log said API error (attempt 1): UNAVAILABLE'), undefined)
assert.equal(retryNoticeOf('- ⚠ API error (attempt 1): UNAVAILABLE'), undefined)
assert.equal(retryNoticeOf('ordinary answer'), undefined)

// ── the splitter ────────────────────────────────────────────────────────────
/** Drive a ReplyStream over the given chunks. @returns answer text and notices. */
function split(chunks) {
  let answer = ''
  const seen = []
  const stream = new ReplyStream({ onAnswer: text => { answer += text }, onNotice: n => seen.push(n) })
  for (const chunk of chunks) stream.push(chunk)
  stream.flush()
  return { answer, seen }
}

// THE REGRESSION: five retries then a real answer is a SUCCESS, and the notices
// must not land in the answer (they used to push it past the 250-char gate).
const recovered = split([notice(1), notice(2), notice(3), notice(4), notice(5), 'OK'])
assert.equal(recovered.answer, 'OK')
assert.equal(recovered.seen.length, 5)
assert.equal(recovered.seen.at(-1).attempt, 5)
assert.equal(backendFailure(recovered.answer, recovered.answer.length), undefined)

// Markdown formatting survives: blank lines inside an answer are kept, and the
// newline agy puts before a notice is not left behind as padding.
assert.equal(
  split([notice(1), '## 结论\n\n第一段\n\n第二段\n']).answer,
  '## 结论\n\n第一段\n\n第二段\n',
)
assert.equal(split(['a\n\nb']).answer, 'a\n\nb')
assert.equal(split([notice(1), notice(2)]).answer, '')

// A notice split across chunks is still a notice; a partial line that cannot be
// one streams immediately instead of waiting for a newline.
assert.equal(split([notice(1).slice(0, 40), notice(1).slice(40), 'answer']).answer, 'answer')
// A notice truncated by teardown still reads as a notice at flush: the prefix is
// proof enough, and it must not be counted as answer text.
const truncated = split([notice(1).slice(0, 40)])
assert.equal(truncated.answer, '')
assert.equal(truncated.seen.length, 1)
assert.equal(split(['tail without newline']).answer, 'tail without newline')

// Answer text that mentions the phrase mid-line is untouched.
const quoted = '日志里出现 API error (attempt 1) 之后恢复\n'
assert.equal(split([quoted]).answer, quoted)
assert.equal(split([quoted]).seen.length, 0)

// ── the notice log is bounded ───────────────────────────────────────────────
const log = noticeLog()
for (let i = 1; i <= 12; i += 1) log.add(`notice ${i}`)
const kept = log.messages()
assert.equal(kept.length, 8)
assert.equal(kept.at(-1), 'notice 12')
assert.equal(kept[0], 'notice 5')

console.log('backend: all 33 cases pass')
