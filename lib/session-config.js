/**
 * Session configuration passthrough: model, thinking level, and execution mode.
 *
 * `agy acp` advertises its two pickers on `session/new` (and on
 * `session/resume`) as `configOptions`:
 *
 *   { id: 'model',         category: 'model',        type: 'select', currentValue, options: [{ value, name }] }
 *   { id: 'thought_level', category: 'thought_level', type: 'select', currentValue, options: [...] }
 *
 * plus a separate `modes` block (default / accept-edits / auto / plan) applied
 * through `session/set_mode`.
 *
 * Two facts measured against agy 1.5.10 shape the code below:
 *
 * 1. The `model` option's values are BASE names (`gemini-3.8-flash`), while
 *    `models.availableModels` lists suffixed ids (`gemini-3.8-flash-high`).
 *    Sending `gemini-3.8-flash-medium` is accepted but leaves `config.model` at
 *    the base name and moves `thought_level` instead — the suffixed form is a
 *    combined selector, so a level must never be inferred from it silently.
 * 2. `models.currentModelId` becomes `undefined` after a config change, so the
 *    only trustworthy echo is `configOptions[].currentValue`.
 *
 * A model without a thinking concept (e.g. `claude-sonnet-4-6`) drops the
 * `thought_level` option entirely: asking for a level there is a caller error,
 * reported rather than silently ignored.
 */

/** Config ids agy uses for the options this plugin passes through. */
export const MODEL_OPTION = 'model'
export const THOUGHT_OPTION = 'thought_level'

/** Thinking levels agy documents (a given account may expose fewer). */
export const THINKING_LEVELS = ['low', 'medium', 'high', 'extra', 'max']

/** Execution modes agy's `modes` block advertises. */
export const MODES = ['default', 'accept-edits', 'auto', 'plan']

/**
 * Find one config option by id.
 * @param configOptions - the array from `session/new` / `session/resume`.
 * @param id - the option id (`model`, `thought_level`).
 * @returns the option, or `undefined` when the agent does not offer it.
 */
export function findOption(configOptions, id) {
  if (!Array.isArray(configOptions)) return undefined
  return configOptions.find(option => option?.id === id)
}

/**
 * Values one select option offers.
 * @param configOptions - the array from the session response.
 * @param id - the option id.
 * @returns the offered values, or an empty array when the option is absent.
 */
export function optionValues(configOptions, id) {
  const option = findOption(configOptions, id)
  if (!Array.isArray(option?.options)) return []
  return option.options.map(entry => entry?.value).filter(value => typeof value === 'string')
}

/**
 * Plan the `set_config_option` / `set_mode` calls for one run.
 *
 * Validation is deliberate instead of best-effort: a caller who asked for a
 * model that is not on the account's list must be told, not silently handed the
 * default — an unnoticed downgrade is exactly the bug this passthrough exists
 * to prevent. The only tolerant case is an agent that does not advertise an
 * option at all (an older agy), which is reported as `unsupported` rather than
 * failed.
 *
 * @param configOptions - options advertised by the session.
 * @param modes - the `modes` block advertised by the session.
 * @param wanted - `{ model?, thoughtLevel?, mode? }` from plugin config / tool args.
 * @returns `{ calls, applied, skipped, error }`:
 *   `calls` are the requests to send, `applied` the values actually in effect,
 *   `skipped` the human-readable reasons, `error` a fatal validation message.
 */
export function planSessionConfig(configOptions, modes, wanted) {
  const model = nonEmpty(wanted?.model)
  const level = nonEmpty(wanted?.thoughtLevel)
  const mode = nonEmpty(wanted?.mode)
  if (model === undefined && level === undefined && mode === undefined) {
    return emptyPlan()
  }

  const calls = []
  const applied = {}
  const skipped = []

  // ── stage 1: the model ───────────────────────────────────────────────────
  // Validated against the options the session started with.
  if (model !== undefined) {
    const values = optionValues(configOptions, MODEL_OPTION)
    if (values.length === 0) {
      // An older agent, or a backend with no model picker: report, don't fail.
      skipped.push(`model "${model}" not applied (agent advertises no model option)`)
    } else if (!values.includes(model)) {
      return { ...emptyPlan(), error: unknownModel(model, values, configOptions) }
    } else {
      calls.push({ kind: 'config', configId: MODEL_OPTION, value: model })
      applied.model = model
    }
  }

  // ── stage 2: the thinking level ──────────────────────────────────────────
  // Order matters. Measured against agy 1.5.10: `thought_level` is offered on
  // Gemini and GONE once a model without a thinking concept is selected, and
  // the setter rejects a level the chosen model does not offer. A plan built
  // from the initial options would therefore send an invalid value whenever the
  // run also changes the model, so this call is marked `deferred`: the caller
  // re-reads the options from the model switch's response before sending it.
  if (level !== undefined) {
    const normalized = level.toLowerCase()
    const values = optionValues(configOptions, THOUGHT_OPTION)
    if (values.length === 0) {
      skipped.push(`thinking level "${level}" not applied (the selected model exposes no thought_level)`)
    } else if (!values.includes(normalized)) {
      return {
        ...emptyPlan(),
        error: `Thinking level "${level}" is not offered for this model; offered: ${values.join(', ')}`,
      }
    } else {
      calls.push({
        kind: 'config', configId: THOUGHT_OPTION, value: normalized,
        deferred: applied.model !== undefined,
      })
      applied.thoughtLevel = normalized
    }
  }

  // ── stage 3: the execution mode ──────────────────────────────────────────
  // Independent of the model, so it never needs re-checking.
  if (mode !== undefined) {
    const available = Array.isArray(modes?.availableModes) ? modes.availableModes.map(entry => entry?.id) : []
    if (available.length === 0) {
      skipped.push(`mode "${mode}" not applied (agent advertises no modes)`)
    } else if (!available.includes(mode)) {
      return { ...emptyPlan(), error: `Mode "${mode}" is not offered; offered: ${available.join(', ')}` }
    } else {
      calls.push({ kind: 'mode', modeId: mode })
      applied.mode = mode
    }
  }

  return { calls, applied, skipped, error: undefined }
}

/** A plan that does nothing. */
function emptyPlan() {
  return { calls: [], applied: {}, skipped: [], error: undefined }
}

/**
 * Re-check a deferred level against the options a model switch returned.
 *
 * @param calls - planned calls from {@link planSessionConfig}.
 * @param configOptions - options echoed by the model switch.
 * @returns `{ calls, skipped, error }`: the calls that survive, notes for the
 *   ones that do not, and a fatal error when the level is genuinely invalid.
 */
export function resolveDeferred(calls, configOptions) {
  const kept = []
  const skipped = []
  for (const call of calls) {
    if (call.deferred !== true) { kept.push(call); continue }
    const values = optionValues(configOptions, THOUGHT_OPTION)
    if (values.length === 0) {
      skipped.push(`thinking level "${call.value}" not applied (the selected model exposes no thought_level)`)
    } else if (!values.includes(call.value)) {
      return { calls: kept, skipped, error: `Thinking level "${call.value}" is not offered for the selected model; offered: ${values.join(', ')}` }
    } else {
      kept.push(call)
    }
  }
  return { calls: kept, skipped, error: undefined }
}

/**
 * The message for a model the agent does not offer, listing what it does.
 * @param model - the rejected request.
 * @param values - offered model values.
 * @param configOptions - the full options array, so names can be shown.
 * @returns a caller-actionable message.
 */
function unknownModel(model, values, configOptions) {
  const option = findOption(configOptions, MODEL_OPTION)
  const named = Array.isArray(option?.options)
    ? option.options.map(entry => (entry?.name ? `${entry.value} (${entry.name})` : entry?.value)).filter(Boolean)
    : values
  return `Model "${model}" is not offered for this account; offered: ${named.join(', ')}`
}

/** A trimmed string, or `undefined` for empty/absent input. */
function nonEmpty(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * The effective state to report in the job output, after the calls ran.
 * @param configOptions - options echoed by the last response (may be undefined).
 * @param fallback - the values this run asked for.
 * @returns a one-line, human-readable summary.
 */
export function describeSessionConfig(configOptions, fallback) {
  const model = findOption(configOptions, MODEL_OPTION)?.currentValue ?? fallback?.model
  // The level has NO fallback: when the selected model exposes no
  // thought_level, the requested level was skipped, and reporting it as if it
  // were in effect would be a lie of exactly the kind this feature exists to
  // prevent.
  const level = findOption(configOptions, THOUGHT_OPTION)?.currentValue
  // Mode: reported only when this run set it, and the APPLIED value wins.
  // `configOptions` carries the session's mode, but `session/set_mode` answers
  // with `{}` (measured), so that copy is stale after a successful set — the
  // caller passes the applied id through `fallback.mode` for exactly this.
  const mode = fallback?.mode !== undefined ? fallback.mode : undefined
  const parts = []
  if (model !== undefined) parts.push(`model=${model}`)
  if (level !== undefined) parts.push(`thinking=${level}`)
  if (mode !== undefined) parts.push(`mode=${mode}`)
  return parts.length > 0 ? parts.join(' ') : 'model=agy default'
}
