import assert from 'node:assert/strict'
import {
  THINKING_LEVELS,
  describeSessionConfig,
  findOption,
  optionValues,
  planSessionConfig,
  resolveDeferred,
} from '../lib/session-config.js'

// The shape agy 1.5.10 actually returns from session/new (captured live).
const geminiOptions = [
  {
    id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gemini-3.8-flash',
    options: [
      { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
      { value: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
      { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
    ],
  },
  {
    id: 'thought_level', name: 'Thinking Level', category: 'thought_level', type: 'select',
    currentValue: 'high',
    options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }],
  },
]
const modes = {
  currentModeId: 'default',
  availableModes: [{ id: 'default' }, { id: 'accept-edits' }, { id: 'auto' }, { id: 'plan' }],
}

// A model without a thinking concept drops the option entirely (measured:
// claude-sonnet-4-6 leaves only `model`).
const claudeOptions = [{ ...geminiOptions[0], currentValue: 'claude-sonnet-4-6' }]

// ── lookups ─────────────────────────────────────────────────────────────────
assert.equal(findOption(geminiOptions, 'model')?.currentValue, 'gemini-3.8-flash')
assert.equal(findOption(geminiOptions, 'thought_level')?.currentValue, 'high')
assert.equal(findOption(geminiOptions, 'nope'), undefined)
assert.equal(findOption(undefined, 'model'), undefined)
assert.deepEqual(optionValues(geminiOptions, 'thought_level'), ['low', 'medium', 'high'])
assert.deepEqual(optionValues(claudeOptions, 'thought_level'), [])

// ── nothing requested ───────────────────────────────────────────────────────
// The pre-feature path must stay byte-identical: no requests at all.
assert.deepEqual(planSessionConfig(geminiOptions, modes, {}), { calls: [], applied: {}, skipped: [], error: undefined })
assert.deepEqual(planSessionConfig(geminiOptions, modes, undefined), { calls: [], applied: {}, skipped: [], error: undefined })
// Blank strings mean "leave agy's setting alone", not "send an empty value".
assert.deepEqual(planSessionConfig(geminiOptions, modes, { model: '', thoughtLevel: '  ', mode: '' }).calls, [])

// ── the happy path ──────────────────────────────────────────────────────────
const full = planSessionConfig(geminiOptions, modes, { model: 'gemini-3.8-flash', thoughtLevel: 'medium', mode: 'auto' })
assert.equal(full.error, undefined)
assert.deepEqual(full.applied, { model: 'gemini-3.8-flash', thoughtLevel: 'medium', mode: 'auto' })
// The level is DEFERRED when the same run also switches the model: the model
// switch's own response decides whether a thought_level picker still exists.
assert.deepEqual(full.calls, [
  { kind: 'config', configId: 'model', value: 'gemini-3.8-flash' },
  { kind: 'config', configId: 'thought_level', value: 'medium', deferred: true },
  { kind: 'mode', modeId: 'auto' },
])
// A level on its own is not deferred: there is no model switch to wait for.
assert.deepEqual(
  planSessionConfig(geminiOptions, modes, { thoughtLevel: 'low' }).calls,
  [{ kind: 'config', configId: 'thought_level', value: 'low', deferred: false }],
)

// Case is normalized for the level: agy's values are lowercase ids.
assert.equal(planSessionConfig(geminiOptions, modes, { thoughtLevel: 'HIGH' }).applied.thoughtLevel, 'high')

// ── rejection is loud, never a silent downgrade ─────────────────────────────
const badModel = planSessionConfig(geminiOptions, modes, { model: 'nonsense-model' })
assert.match(badModel.error, /not offered/, 'an unknown model must fail the run')
assert.match(badModel.error, /gemini-3\.8-flash/, 'the error must list what IS offered')
// Measured: agy says `Unknown model ID: nonsense-model`; naming the alternatives
// is what turns that into a fixable message.
assert.match(badModel.error, /Claude Sonnet 4\.6/, 'offered names are included, not just ids')

const badLevel = planSessionConfig(geminiOptions, modes, { thoughtLevel: 'max' })
assert.match(badLevel.error, /not offered for this model/, 'an unavailable level is a caller error')
assert.match(badLevel.error, /low, medium, high/)

const badMode = planSessionConfig(geminiOptions, modes, { mode: 'yolo' })
assert.match(badMode.error, /Mode "yolo" is not offered/)
assert.match(badMode.error, /accept-edits/)

// ── a model without a thinking concept ──────────────────────────────────────
// Measured: `thought_level` is present on Gemini and ABSENT once Claude is
// selected, and the setter rejects a level that model does not offer. So the
// deferred call must be re-checked against the model switch's response.
const deferred = planSessionConfig(geminiOptions, modes, { model: 'claude-sonnet-4-6', thoughtLevel: 'high' })
assert.equal(deferred.error, undefined)
const resolved = resolveDeferred(deferred.calls, claudeOptions)
assert.equal(resolved.error, undefined)
assert.deepEqual(resolved.calls, [{ kind: 'config', configId: 'model', value: 'claude-sonnet-4-6' }])
assert.match(resolved.skipped[0], /no thought_level/)
// Against Gemini's options the same deferred call survives untouched.
assert.deepEqual(resolveDeferred(deferred.calls, geminiOptions).calls.length, 2)
// A level that the model switch left unrecognised is a loud error.
const wrongLevel = [{ kind: 'config', configId: 'thought_level', value: 'max', deferred: true }]
assert.match(resolveDeferred(wrongLevel, geminiOptions).error, /not offered for the selected model/)
// Selecting the model itself still works on that same session.
assert.deepEqual(
  planSessionConfig(claudeOptions, modes, { model: 'claude-sonnet-4-6' }).calls,
  [{ kind: 'config', configId: 'model', value: 'claude-sonnet-4-6' }],
)

// ── an older agent that advertises nothing ──────────────────────────────────
// Tolerated (skipped with a reason) rather than failed: older agy has no pickers.
const bare = planSessionConfig(undefined, undefined, { model: 'gemini-3.8-flash', mode: 'plan' })
assert.equal(bare.error, undefined)
assert.equal(bare.calls.length, 0)
assert.equal(bare.skipped.length, 2)
assert.match(bare.skipped[0], /advertises no model option/)
assert.match(bare.skipped[1], /advertises no modes/)
// A level with no model picker at all is skipped too, never sent.
const bareLevel = planSessionConfig(undefined, modes, { thoughtLevel: 'high' })
assert.equal(bareLevel.calls.length, 0)
assert.match(bareLevel.skipped[0], /exposes no thought_level/)

// ── describing the effective state ──────────────────────────────────────────
// The echo from set_config_option wins over what was requested.
assert.equal(
  describeSessionConfig([{ id: 'model', currentValue: 'claude-sonnet-4-6' }], { model: 'gemini-3.8-flash', mode: 'auto' }),
  'model=claude-sonnet-4-6 mode=auto',
)
// With no echo at all, the model may fall back to what was asked, but the LEVEL
// must not: an unapplied level reported as in-effect is the exact lie this
// feature exists to prevent (seen when a model exposes no thought_level).
assert.equal(describeSessionConfig(undefined, { model: 'gemini-3.8-flash', thoughtLevel: 'low' }), 'model=gemini-3.8-flash')
assert.equal(
  describeSessionConfig([{ id: 'model', currentValue: 'claude-sonnet-4-6' }], { model: 'claude-sonnet-4-6', thoughtLevel: 'high' }),
  'model=claude-sonnet-4-6',
  'a skipped level must never appear as if it applied',
)
// The APPLIED mode wins over a stale echo: `session/set_mode` answers `{}`, so
// the options copy still carries the previous mode.
assert.equal(
  describeSessionConfig([{ id: 'mode', currentValue: 'default' }], { mode: 'plan' }),
  'mode=plan',
  'a just-applied mode must not be reported from a stale options echo',
)
// A mode the run never set is not reported at all, even though options carry one.
assert.equal(describeSessionConfig([{ id: 'mode', currentValue: 'default' }], {}), 'model=agy default')
// Nothing requested and nothing echoed.
assert.equal(describeSessionConfig(undefined, undefined), 'model=agy default')

// The documented levels stay in one place for the tool enum.
assert.deepEqual(THINKING_LEVELS, ['low', 'medium', 'high', 'extra', 'max'])

console.log('session-config: all 37 cases pass')
