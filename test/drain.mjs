import assert from 'node:assert/strict'
import { keepDraining } from '../lib/drain.js'

const window = { minMs: 15_000, quietMs: 5_000, maxMs: 120_000, aborted: false }
const keep = (elapsed, sinceStream, overrides = {}) =>
  keepDraining(elapsed, sinceStream, { ...window, ...overrides })

// The grace window always runs, even when the stream has been silent from the
// start: the late answer needs a moment to begin.
assert.equal(keep(0, 0), true)
assert.equal(keep(14_999, 60_000), true)

// After the grace, any recent activity keeps the drain alive...
assert.equal(keep(15_000, 0), true)
assert.equal(keep(15_000, 4_999), true)

// ...and silence ends it, so a short late answer costs the grace plus the quiet
// window instead of the full ceiling.
assert.equal(keep(15_000, 5_000), false)
assert.equal(keep(60_000, 30_000), false)

// The ceiling wins regardless of activity.
assert.equal(keep(120_000, 0), false)
assert.equal(keep(200_000, 100), false)

// Cancellation wins over everything.
assert.equal(keep(0, 0, { aborted: true }), false)

console.log('drain: all 9 cases pass')