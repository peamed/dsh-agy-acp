import assert from 'node:assert/strict'
import { emptyRunDetail } from '../lib/report.js'

// A message injected into a running session ends that turn with no text; the
// follow-up turn is what was killed. The two cases stay distinguishable.
assert.equal(emptyRunDetail(true), 'injected-message-ended-turn')
assert.equal(emptyRunDetail(false), 'no-answer-text')

console.log('report: all 2 cases pass')
