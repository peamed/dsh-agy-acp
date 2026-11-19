/**
 * `composeTask` + default `taskPrefix` tests.
 *
 * The prefix is ON by default (it frames every delegated run), so the default
 * config must produce a prefixed prompt, while an explicit '' must restore
 * strict verbatim pass-through. Both paths are asserted here.
 */
import assert from 'node:assert/strict'
import { composeTask, Config } from '../lib/index.js'

// ── default config: prefix ON ───────────────────────────────────────────────
const defaultPrefix = Config({}).taskPrefix
assert.equal(typeof defaultPrefix, 'string')
assert.ok(defaultPrefix.trim().length > 0, 'taskPrefix default is non-empty (framing on)')
assert.match(defaultPrefix, /file tools/i, 'default names the built-in file tools')
assert.match(defaultPrefix, /no approval/i, 'default states the zero-approval fact')
assert.ok(!defaultPrefix.includes('\n'), 'default is a single line (composeTask adds the blank line)')

// The default actually frames a task, keeping the task body intact.
const task = 'line one\n\nline three\n  indented'
const framed = composeTask(defaultPrefix, task)
assert.ok(framed.startsWith(defaultPrefix), 'default prefix is prepended')
assert.ok(framed.endsWith(task), 'task body is preserved verbatim at the tail')
assert.equal(framed, `${defaultPrefix}\n\n${task}`, 'joined by exactly one blank line')

// ── explicit '': strict pass-through ────────────────────────────────────────
assert.equal(Config({ taskPrefix: '' }).taskPrefix, '', 'an explicit empty string disables framing')
assert.equal(composeTask('', task), task)
assert.equal(composeTask('', 'do the thing'), 'do the thing')
assert.equal(composeTask(undefined, task), task)
assert.equal(composeTask('   \n\t ', task), task, 'whitespace-only prefix is still pass-through')

// ── custom prefix ───────────────────────────────────────────────────────────
const custom = 'Custom framing.'
assert.equal(Config({ taskPrefix: custom }).taskPrefix, custom)
assert.equal(composeTask(custom, 'do the thing'), `${custom}\n\ndo the thing`)
assert.equal(composeTask(`  ${custom}\n`, 'do the thing'), `${custom}\n\ndo the thing`)

// ── idempotence: a task already framed is not framed twice ──────────────────
assert.equal(composeTask(custom, `${custom}\n\ndo the thing`), `${custom}\n\ndo the thing`)
assert.equal(composeTask(defaultPrefix, `${defaultPrefix}\n\ndo the thing`), `${defaultPrefix}\n\ndo the thing`)

// ── degenerate inputs ───────────────────────────────────────────────────────
assert.equal(composeTask(custom, ''), custom)
assert.equal(composeTask('', ''), '')
assert.equal(composeTask(custom, undefined), custom)
assert.equal(composeTask('', undefined), undefined)

// ── Config still validates the other fields with the new default ────────────
const cfg = Config({ permission: 'allow' })
assert.equal(cfg.permission, 'allow')
assert.equal(cfg.isolation, 'agy-sandbox')
assert.ok(Array.isArray(cfg.deniedCommandPaths))
assert.equal(cfg.taskPrefix, defaultPrefix)

console.log('task-prefix: all cases pass (default ON, empty string = pass-through)')
