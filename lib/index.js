/**
 * dsh-agy-acp v4 — Google Antigravity (`agy acp`) as an observable background
 * job (pure job mode, with all session-governance enhancements).
 *
 * Registers the `agy` tool. Each call starts a background job that spawns
 * `agy acp` through the subprocess seam, drives the Agent Client Protocol
 * (initialize → session/new → session/prompt), and streams every session
 * update (answer chunks, tool calls, plans, permission decisions) into the
 * job's output ring. The parent watches live progress with `job_output`,
 * receives an in-session completion notice, cancels with `job_kill`, and
 * bounds runs with `timeout_ms`.
 *
 * Session governance:
 * - `permission: 'ask'` bridges the child's ACP permission requests into the
 *   parent session's approval waterfall — the session policy and the user
 *   decide; paths outside the project are denied outright; a closed parent
 *   turn or missing answerer fails closed.
 * - `isolation: 'agy-sandbox'` (default) runs the child with agy's own
 *   `--sandbox`; `bwrap` wraps the whole process tree in a bubblewrap mount
 *   namespace (root read-only, project cwd writable, /tmp isolated) but
 *   disables agy's shell channel; `off` spawns unconfined.
 *
 * Named exports only (a default export would hide loader metadata).
 */

import { existsSync, realpathSync } from 'node:fs'
import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream'
import { isAbsolute, join, resolve, sep } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools'
import {
  client as createAcpClientApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk'
import { askDisposition, isMcpCall } from './policy.js'
import { keepDraining } from './drain.js'
import { ReplyStream, backendFailure, backendRefusal, noticeLog } from './backend.js'
import {
  MODES, THINKING_LEVELS, THOUGHT_OPTION, describeSessionConfig, planSessionConfig, resolveDeferred,
} from './session-config.js'
import { emptyRunDetail } from './report.js'
import { DEFAULT_DENIED_COMMAND_PATHS, commandDenied, commandLineOf } from './commands.js'

export const name = 'agy-acp'
export const inject = ['tools', 'jobs', 'subprocess', 'workingDirectory', 'systemPrompt']

/** Longest Node.js timer delay; timeouts and graces are clamped to it. */
const MAX_TIMER_MS = 2_147_483_647

/**
 * Silence (ms) that ends the post-settle drain. The model pauses between tool
 * calls while thinking, and those pauses routinely exceed a few seconds, so a
 * shorter window tears the child down in the middle of its own work.
 */
const SEND_QUIET_MS = 20_000

/**
 * Child silence (ms) after which the producer appends one liveness line to the
 * job ring. agy can think or run one long tool call for minutes without any
 * stream update, and a quiet ring reads as a hung run — to the model polling
 * `job_output` (which then answers "(no new output)") and to the human watching
 * the session-header row. The heartbeat makes the silence visibly bounded.
 */
const HEARTBEAT_AFTER_MS = 120_000

/** Minimum spacing (ms) between two heartbeat lines while the child stays silent. */
const HEARTBEAT_EVERY_MS = 120_000

/** Check cadence (ms) of the heartbeat watchdog. */
const HEARTBEAT_CHECK_MS = 15_000

/**
 * Default `taskPrefix`: the framing every delegated run starts with.
 *
 * It states only what was measured — in-project file operations need no
 * approval, shell commands may pause — and asks for the built-in tools without
 * asserting they will be used. A local subagent reads it best when the original
 * task follows on its own line, which {@link composeTask} preserves.
 */
const DEFAULT_TASK_PREFIX = [
  'Work with your built-in file tools (read_file, write_file, list_directory, search)',
  'instead of shell commands wherever they can do the job.',
  'In-project file operations need no approval, but a shell command may pause for',
  'interactive approval that a background run cannot answer, so prefer the file',
  'tools and keep shell commands to the minimum the task actually requires.',
].join(' ')

/**
 * Sessions with a run in flight, keyed by ACP session id.
 *
 * `agy_send` consults this map to decide HOW to deliver a message: a session
 * that is still running takes the message on its live connection (the agent
 * folds it into the current turn), while a settled one needs a resume job. The
 * entry dies with the run, so the map never outlives a child process.
 */
const liveSessions = new Map()

/**
 * Bounded memory of the cwd each live Antigravity session was opened in.
 *
 * `session/resume` requires the same `cwd` the session was created with; a
 * mismatch would attach a conversation whose files resolve elsewhere. The
 * plugin remembers recent sessions so `agy_send` can refuse a mismatched
 * cwd outright, and forgets them so memory does not grow with the job count.
 * Lost entries (host restart) are not an error: agy itself rejects a session it
 * no longer holds, and the run falls back to a fresh session.
 */
const SESSION_MEMORY = 256
const sessionCwds = new Map()

/**
 * Record (or refresh) the cwd of one Antigravity session, oldest first.
 */
function rememberSession(sessionId, cwd) {
  if (sessionId === undefined) return
  sessionCwds.delete(sessionId)
  sessionCwds.set(sessionId, cwd)
  while (sessionCwds.size > SESSION_MEMORY) {
    sessionCwds.delete(sessionCwds.keys().next().value)
  }
}

/** The remembered cwd of one Antigravity session, or `undefined` when unknown. */
function sessionCwd(sessionId) {
  return sessionCwds.get(sessionId)
}

export const Config = z.object({
  /** Executable spawned for each run (the child ACP agent). */
  command: z.string().default('agy'),
  /** Arguments passed to `command` before the isolation layer. */
  args: z.array(z.string()).default(['acp']),
  /**
   * How the child's permission requests are decided: `ask` (default) bridges
   * them into the parent session's approval waterfall — the session policy
   * and the user decide; paths outside the project are denied without asking;
   * a closed parent turn or missing answerer fails closed; `allow` approves
   * via the first allow option; `reject` declines every prompt.
   */
  permission: z.union(['ask', 'allow', 'reject']).default('ask'),
  /**
   * Process isolation: `agy-sandbox` (default) passes agy's own `--sandbox`
   * (terminal restrictions) and relies on agy's tightened permission rules;
   * `bwrap` wraps the whole process tree in a bubblewrap mount namespace
   * (root read-only, project cwd writable, /tmp isolated) but disables agy's
   * shell channel (run_command) due to its read-only root; `off` spawns
   * unconfined.
   */
  isolation: z.union(['bwrap', 'agy-sandbox', 'off']).default('agy-sandbox'),
  /**
   * Settlement for MCP server tool calls (`call_mcp_tool`): `allow` (default)
   * grants them without a human, `ask` routes them into the session approval
   * flow, `deny` refuses them. MCP calls are neither file effects nor shell
   * commands, so they are governed here rather than by the sandbox mode.
   */
  mcpTools: z.union(['allow', 'ask', 'deny']).default('allow'),
  /**
   * Session model, applied through ACP `session/set_config_option` after the
   * handshake. Empty (default) leaves agy's own `settings.json` model in force.
   * Use the BASE id the agent advertises on the `model` option
   * (`gemini-3.8-flash`), not the suffixed `...-high` form from
   * `models.availableModels`; the level belongs in `thoughtLevel`.
   */
  model: z.string().default(''),
  /**
   * Thinking level (`low` / `medium` / `high`, or `extra` / `max` where the
   * account offers them). Empty leaves the model's default. A model without a
   * thinking concept exposes no `thought_level` option, and asking for a level
   * there is reported as a caller error instead of being ignored.
   */
  thoughtLevel: z.string().default(''),
  /**
   * Execution mode (`default` / `accept-edits` / `auto` / `plan`), applied
   * through ACP `session/set_mode`. Empty leaves agy's own mode in force.
   */
  mode: z.string().default(''),
  /**
   * Extra child environment entries merged over the subprocess seam's
   * credential-scrubbed parent env (e.g. `GEMINI_API_KEY`).
   */
  env: z.dict(z.string()).default({}),
  /** Max wait (ms) for a session approval before the request is denied. */
  askTimeoutMs: z.number().default(600_000),
  /**
   * Hard cap (ms) on how long the child stays alive after the original prompt
   * settles when a message was injected with `agy_send`. agy folds the message
   * into the running turn and answers it late, after `end_turn`; closing the
   * connection first would destroy that answer. The cap is a ceiling, not a
   * fixed wait: the drain ends early once the stream goes quiet.
   */
  sendDrainMs: z.number().default(120_000),
  /**
   * Text prepended to the first prompt of every NEW or resumed session.
   *
   * On by default, because the framing it carries is what keeps a delegated run
   * from stalling: Antigravity auto-approves in-project file operations, while a
   * shell command may pause on an interactive approval that a background job
   * cannot answer. The default states exactly that, without claiming more than
   * the plugin can guarantee (the prefix is an INSTRUCTION, not enforcement —
   * agy's own permission engine still decides).
   *
   * Set it to '' for strict pass-through: the plugin then sends `task` verbatim
   * and rewrites nothing. Any other string replaces the default text.
   *
   * Only new/resumed sessions get the prefix; a message injected into a LIVE
   * session (`agy_send` on a running job) is delivered untouched, because the
   * conversation already carries the framing from its first task.
   */
  taskPrefix: z.string().default(DEFAULT_TASK_PREFIX),
  /**
   * Paths a command may never mention, whatever the ask/allow policy says.
   * Denial outranks every grant below. Boundary-aware, so a project file like
   * `src/.ssh-helper.ts` is not mistaken for `~/.ssh`. Command GRANTS belong to
   * Antigravity's own permission engine (`permissions.allow/deny` in
   * ~/.gemini/antigravity-cli/settings.json, per-project rules via
   * `/permissions`); this list only stops credential paths at the bridge.
   */
  deniedCommandPaths: z.array(z.string()).default([...DEFAULT_DENIED_COMMAND_PATHS]),
  /**
   * Minimum grace (ms) after the original prompt settles before a quiet stream
   * counts as finished. The late answer takes a moment to start, so quitting on
   * silence too early would truncate it.
   */
  sendDrainMinMs: z.number().default(15_000),
  /** stdin-EOF quiesce window (ms) before teardown escalates to termination. */
  disposeEofGraceMs: z.number().default(6_000),
  /** Termination grace (ms) handed to the subprocess seam. */
  disposeGraceMs: z.number().default(3_000),
})

/** First line of a multi-line string. */
function firstLine(text) {
  const index = text.indexOf('\n')
  return index === -1 ? text : text.slice(0, index)
}

/** Single-line bounded copy for labels, markers, and diagnostics. */
function bounded(text, max = 120) {
  const oneLine = String(text).replace(/[\r\n]+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

/**
 * The prompt handed to a NEW Antigravity session: `prefix` followed by `task`.
 *
 * A blank prefix returns the task UNCHANGED (the default pass-through), so the
 * plugin never rewrites what the caller wrote unless they asked it to. The two
 * are joined by a blank line so the task keeps its own first-line shape, and a
 * prefix already present at the head is not added twice.
 *
 * @param prefix - the configured `taskPrefix` (may be empty).
 * @param task - the caller's task, passed verbatim.
 * @returns the text to send as the session's first prompt.
 */
export function composeTask(prefix, task) {
  if (typeof prefix !== 'string') return task
  const head = prefix.trim()
  if (head.length === 0) return task
  if (typeof task !== 'string' || task.length === 0) return head
  if (task.startsWith(head)) return task
  return `${head}\n\n${task}`
}

/** Resolve after `ms` with `value`. */
function delay(ms, value) {
  return new Promise(resolve => { setTimeout(() => resolve(value), Math.min(ms, MAX_TIMER_MS)) })
}

/** A cancel-shaped error (callers translate it into a `killed` outcome). */
function abortError(reason) {
  const error = new Error(reason ?? 'cancelled')
  error.cancelled = true
  return error
}

/**
 * Whether `path` stays inside `cwd`, resolved through symbolic links.
 * A plain normalize() prefix check is insufficient: a symlink inside the
 * project pointing at e.g. ~/.ssh would pass a textual check and leak
 * out-of-project access. Resolve both sides to their physical paths first.
 */
function withinRoot(path, cwd) {
  const absolute = isAbsolute(path) ? path : join(cwd, path)
  const physicalRoot = resolve(realpathSync(cwd))
  let physicalPath
  try {
    // The target may not exist yet (a write about to happen): resolve the
    // deepest existing ancestor and append the missing suffix.
    let candidate = resolve(absolute)
    const suffix = []
    while (!existsSync(candidate) && candidate !== resolve(sep)) {
      suffix.unshift(candidate.slice(candidate.lastIndexOf(sep) + 1))
      candidate = candidate.slice(0, candidate.lastIndexOf(sep)) || sep
    }
    physicalPath = join(realpathSync(candidate), ...suffix)
  } catch {
    return false
  }
  return physicalPath === physicalRoot || physicalPath.startsWith(physicalRoot + sep)
}

/**
 * Cooperative teardown for one child: stdin EOF (the child's flush window),
 * then the seam's terminate escalation. Single-flight per child handle.
 */
function disposeChild(child, eofGraceMs) {
  child.disposePromise ??= (async () => {
    try { child.stdin?.end() } catch { /* already gone */ }
    const exited = await Promise.race([
      child.done.then(() => true, () => true),
      delay(eofGraceMs, false),
    ])
    if (!exited) {
      try { child.terminate() } catch { /* already gone */ }
      await child.waitForExit().catch(() => { /* observed via done */ })
    }
  })()
  return child.disposePromise
}

/** Map an ACP stop reason onto the job outcome vocabulary. */
function acpStopReason(reason) {
  switch (reason) {
    case 'end_turn': return 'completed'
    case 'max_tokens': return 'max-tokens'
    case 'refusal': return 'refusal'
    case 'cancelled': return 'aborted'
    default: return 'error'
  }
}

/**
 * The options array with the `mode` option rewritten.
 *
 * `session/set_mode` replies with `{}` rather than the updated session state,
 * so the previous options would keep advertising the OLD mode.
 * @param configOptions - the last known options.
 * @param modeId - the mode that was just applied.
 * @returns a copy carrying the new current value.
 */
function withMode(configOptions, modeId) {
  if (!Array.isArray(configOptions)) return configOptions
  return configOptions.map(option => (option?.id === 'mode' ? { ...option, currentValue: modeId } : option))
}

/**
 * A session option the caller asked for that agy cannot honour.
 *
 * Distinct from a startup failure on purpose: nothing is wrong with the child
 * process, the request is wrong, and the message says which values are valid.
 */
class SessionConfigError extends Error {
  /** @param message - caller-actionable text naming the offered values. */
  constructor(message) {
    super(message)
    this.name = 'SessionConfigError'
  }
}

/**
 * The requested session config, flattened for the `agy` tool's result.
 *
 * Only what the caller ASKED for: the authoritative echo (what agy actually
 * applied) arrives in the job output as `[agy:config] model=... thinking=...`,
 * because it is only known once the handshake completes.
 * @param requested - `{ model?, thoughtLevel?, mode? }` or `undefined`.
 * @returns fields to spread into the result (empty when nothing was asked).
 */
function sessionConfigSummary(requested) {
  if (requested === undefined) return {}
  // Only defined entries: the tool result must be lossless JSON, and `undefined`
  // values (a level set without a model, say) make it unrepresentable.
  const present = {}
  for (const [key, value] of Object.entries(requested)) {
    if (value !== undefined && value !== null && value !== '') present[key] = value
  }
  return Object.keys(present).length > 0 ? { session_config: present } : {}
}

/** A trimmed string, or `undefined` for empty/absent input. */
function nonEmpty(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * Merge plugin defaults with per-call overrides.
 *
 * Returns `undefined` when nothing was requested, so a run whose config is
 * untouched takes exactly the handshake path it took before this feature
 * existed (no extra ACP round trips).
 * @param cfg - the resolved plugin config.
 * @param args - the tool arguments (`model` / `thought_level` / `mode`).
 * @returns `{ model?, thoughtLevel?, mode? }` or `undefined`.
 */
function resolveSessionConfig(cfg, args) {
  const model = nonEmpty(args?.model) ?? nonEmpty(cfg.model)
  const thoughtLevel = nonEmpty(args?.thought_level) ?? nonEmpty(cfg.thoughtLevel)
  const mode = nonEmpty(args?.mode) ?? nonEmpty(cfg.mode)
  if (model === undefined && thoughtLevel === undefined && mode === undefined) return undefined
  return { model, thoughtLevel, mode }
}

/** Build the spawn argv for the chosen isolation layer. */
function buildArgv(cfg, cwd) {
  if (cfg.isolation === 'bwrap' && existsSync('/usr/bin/bwrap')) {
    return [
      '/usr/bin/bwrap',
      '--ro-bind', '/', '/',
      '--bind', cwd, cwd,
      '--dev-bind', '/dev', '/dev',
      '--proc', '/proc',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      cfg.command, ...cfg.args,
    ]
  }
  if (cfg.isolation === 'bwrap') {
    // bwrap missing: fall back to agy's own sandbox flag (weaker), reported by the caller.
    return [cfg.command, ...cfg.args, '--sandbox']
  }
  if (cfg.isolation === 'agy-sandbox') {
    return [cfg.command, ...cfg.args, '--sandbox']
  }
  return [cfg.command, ...cfg.args]
}

/**
 * Drive one ACP session inside a background job: spawn the child, perform the
 * ACP handshake, mirror every update into the job output ring, decide
 * permission requests per policy, and settle with the child's stop reason.
 * @param handle - the job's producer handle (append / updateProgress).
 * @param opts - resolved config plus task, cwd, timeoutMs, agent, spawn fn.
 * @param controller - job-owned cancellation (job_kill, owner disposal, timeout).
 * @returns the terminal JobOutcome for the registry.
 */
async function driveSession(handle, opts, controller) {
  const {
    command, args, env, cwd, task, timeoutMs, permission, askTimeoutMs,
    disposeEofGraceMs, disposeGraceMs, spawn, parentAgent, approvalOf, policyOf, mcpTools, deniedCommandPaths, sendDrainMs, sendDrainMinMs,
    resumeSessionId, jobRef, sessionConfig,
  } = opts
  const signal = controller.signal

  const argv = buildArgv(opts, cwd)
  let child
  try {
    child = spawn({
      argv,
      cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: disposeGraceMs,
      env,
    })
  } catch (error) {
    throw new Error(`failed to spawn ${command}: ${bounded(error?.message ?? error, 200)}`)
  }
  const isolationNote = argv[0] === '/usr/bin/bwrap'
    ? 'bwrap (root read-only; only the project directory writable)'
    : opts.isolation === 'off' ? 'none' : 'agy --sandbox + tightened agy permission rules'
  handle.append(`[agy] starting (cwd: ${cwd}; isolation: ${isolationNote})\n`)

  // Child stderr rides its own job channel; the job render shows it as [stderr].
  child.stderr?.on('data', chunk => {
    const text = chunk.toString('utf8')
    if (text.length > 0) handle.append(text, { channel: 'stderr' })
  })

  // Structured process facts for failure classification.
  let processOutcome
  let processFailure
  const processDone = child.done.then(
    outcome => { processOutcome = outcome; return outcome },
    error => { processFailure = error; throw error },
  )
  processDone.catch(() => { /* observed via races below; never unhandled */ })
  const exitNote = () => processOutcome !== undefined
    && processOutcome.exitCode !== null
    && processOutcome.exitCode !== undefined
    ? ` (exit code: ${processOutcome.exitCode})`
    : ''

  // ── Permission decision bridge ───────────────────────────────────────────
  /**
   * The parent Session's resolved DSH sandbox mode (`read-only`,
   * `workspace-write`, `danger-full-access`), or `undefined` when the
   * composition has no `sandboxPolicy` service or the read throws. Undefined
   * falls back to a human decision, never to a silent grant.
   */
  const sandboxMode = () => {
    try {
      const service = policyOf()
      if (service === undefined) return undefined
      const resolved = service.resolve({ session: parentAgent?.session })
      return typeof resolved?.mode === 'string' ? resolved.mode : undefined
    } catch {
      return undefined
    }
  }

  const decidePermission = async (params) => {
    const kind = params.toolCall?.kind ?? 'other'
    const what = bounded(params.toolCall?.title ?? kind, 100)
    const options = params.options ?? []
    const allowOption = options.find(option => option.kind === 'allow_once' || option.kind === 'allow_always')
    const rejectOption = options.find(option => option.kind === 'reject_once' || option.kind === 'reject_always')
    const deny = (why) => {
      handle.append(`\n[agy:permission] ${what} → denied (${why})\n`)
      return rejectOption !== undefined
        ? { outcome: { outcome: 'selected', optionId: rejectOption.optionId } }
        : { outcome: { outcome: 'cancelled' } }
    }
    const grant = (why) => {
      handle.append(`\n[agy:permission] ${what} → allowed (${why})\n`)
      return allowOption !== undefined
        ? { outcome: { outcome: 'selected', optionId: allowOption.optionId } }
        : deny('no allow option offered')
    }

    // Denial outranks every grant below, including `permission: allow`.
    const commandLine = commandLineOf(params.toolCall)
    if (commandLine !== undefined) {
      const blocked = commandDenied(commandLine, deniedCommandPaths, process.env.HOME ?? '')
      if (blocked !== undefined) return deny(`denied path: ${blocked}`)
    }

    if (permission === 'reject') return deny('policy: reject')
    if (permission === 'allow') return grant('policy: allow')

    // policy 'ask': hard project boundary first — outside paths never reach a human.
    const locations = (params.toolCall?.locations ?? []).map(entry => entry?.path).filter(Boolean)
    const outside = locations.filter(path => !withinRoot(path, cwd))
    if (outside.length > 0) {
      return deny(`outside project: ${bounded(outside.join(', '), 80)}`)
    }

    // Ask-policy gate: MCP server tools follow the plugin's own `mcpTools` policy;
    // everything else follows the PARENT Session's DSH sandbox mode exactly as it
    // would decide for the parent's own file tools. Command execution, an
    // `ask`-policy MCP call, and a mode we cannot resolve still reach a human.
    const isMcp = isMcpCall(params.toolCall)
    const mode = sandboxMode()
    let disposition = askDisposition(kind, mode, isMcp ? mcpTools : undefined)
    if (disposition === 'deny') return deny(`policy: ${isMcp ? `mcp ${mcpTools}` : 'read-only'}`)
    if (disposition === 'allow') return grant(`policy: ${isMcp ? `mcp ${mcpTools}` : mode}`)

    // Command grants live in Antigravity's own permission engine; whatever
    // still reaches the bridge defers to the human approval waterfall.

    const approver = approvalOf()
    if (approver === undefined) return deny('no approval service in composition')

    const askSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.min(askTimeoutMs, MAX_TIMER_MS))])
    try {
      const outcome = await approver.request({
        agent: parentAgent,
        toolName: `agy:${kind}`,
        reason: bounded(`Antigravity asks: ${what}`, 200),
        displayReason: { en: `Antigravity (${bounded(firstLine(task), 60)}): ${what}` },
        signal: askSignal,
      })
      if (outcome === 'allowed-once') return grant('session approval')
      return deny(`session decision: ${outcome}`)
    } catch (error) {
      // Outside an open parent turn the service refuses to ask: fail closed.
      return deny(bounded(error?.message ?? 'approval unavailable', 100))
    }
  }

  // ── ACP client: mirror everything ────────────────────────────────────────
  // Answer length counts only the ANSWER: agy streams its own retry notices
  // through the same channel, and counting them made a run that retried twice
  // look like a 250+ character reply — which disarmed the refusal classifier.
  let finalTextLength = 0
  /** Bounded prefix of the answer, enough to recognize an upstream refusal. */
  let headText = ''
  /** Retry notices seen in this reply (bounded), for the failure detail. */
  const notices = noticeLog()
  /** Routes answer text vs retry notices; flushes before settlement. */
  const reply = new ReplyStream({
    onAnswer: text => {
      finalTextLength += text.length
      if (headText.length < 400) headText += text.slice(0, 400 - headText.length)
      handle.append(text)
      lastProgress = 'answering'
    },
    onNotice: notice => {
      notices.add(notice.message)
      // Progress, not content: keep it on its own line, out of the answer.
      handle.append(`\n[agy:retry] attempt ${notice.attempt}: ${bounded(notice.message, 160)}\n`)
      lastProgress = bounded(`retrying (attempt ${notice.attempt})`, 80)
      handle.updateProgress(lastProgress)
    },
  })

  const clientApp = createAcpClientApp({ name: 'dsh-agy-acp' })
    .onNotification(methods.client.session.update, ({ params }) => {
      lastStreamAt = Date.now()
      const update = params.update
      switch (update.sessionUpdate) {
        case 'agent_message_chunk': {
          const block = update.content
          if (block?.type === 'text' && block.text.length > 0) reply.push(block.text)
          break
        }
        case 'tool_call': {
          handle.append(`\n[agy:tool] ${bounded(update.title ?? 'tool call')} (${update.kind ?? 'other'}, ${update.status ?? 'pending'})\n`)
          lastProgress = bounded(`${update.kind ?? 'tool'}: ${update.title ?? ''}`, 80)
          handle.updateProgress(lastProgress)
          break
        }
        case 'tool_call_update': {
          if (update.status === 'completed' || update.status === 'failed') {
            handle.append(`\n[agy:tool] ${bounded(update.title ?? 'tool call')} → ${update.status}\n`)
          } else {
            lastProgress = bounded(`${update.title ?? 'tool'} (${update.status ?? 'running'})`, 80)
            handle.updateProgress(lastProgress)
          }
          break
        }
        case 'plan': {
          const entries = Array.isArray(update.entries) ? update.entries : []
          const summary = bounded(entries.map(entry => entry?.content ?? '').filter(Boolean).join(' → '), 200)
          if (summary.length > 0) handle.append(`\n[agy:plan] ${summary}\n`)
          break
        }
        default:
          // Other trace updates (thoughts, mode changes, …) stay unrendered.
          break
      }
      return Promise.resolve()
    })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      return decidePermission(params).then(answer => answer)
    })

  const connection = clientApp.connect(ndJsonStream(
    NodeWritable.toWeb(child.stdin),
    NodeReadable.toWeb(child.stdout),
  ))
  const agent = connection.agent

  let sessionId
  /** Last time the child sent any session update; the drain quits on silence. */
  let lastStreamAt = Date.now()
  /** Last human-readable progress fact, surfaced by the silence heartbeat. */
  let lastProgress = 'starting'
  /** True once any message was handed to the live connection. */
  let sendsQueued = 0
  /**
   * Hand one extra user message to the live session.
   *
   * Measured behaviour: agy folds the message into the running turn as a new
   * user input and keeps working, but it never sends a response for the
   * injected request itself — the answer arrives LATE, after the original
   * prompt already reported `end_turn`. So the request's promise is not
   * awaited for correctness; it only rejects when the connection closes at
   * teardown, which is expected. {@link drainSends} keeps the child alive long
   * enough for that late answer to stream in.
   *
   * Returns whether the message reached the connection.
   */
  const sendLive = (text) => {
    if (sessionId === undefined || signal.aborted) return false
    let request
    try {
      request = agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text }],
      })
    } catch (error) {
      handle.append(`\n[agy:send] delivery failed (${bounded(error?.message ?? error, 160)})\n`)
      return false
    }
    handle.append(`\n[agy:send] queued: ${bounded(firstLine(text), 120)}\n`)
    sendsQueued += 1
    void Promise.resolve(request).then(
      response => {
        handle.append(`\n[agy:send] answered separately (stop reason: ${response?.stopReason ?? 'unknown'})\n`)
      },
      error => {
        // The connection closing at teardown is the normal end of an injected
        // request; only an unexpected refusal is worth reporting.
        const message = bounded(error?.message ?? error, 160)
        if (/connection closed/i.test(message)) {
          handle.append('\n[agy:send] folded in (no separate response)\n')
        } else {
          handle.append(`\n[agy:send] delivery failed (${message})\n`)
        }
      },
    )
    return true
  }
  /**
   * Keep the child alive after the original prompt settles, so the answer to a
   * folded-in message can still stream.
   *
   * A fixed wait would either truncate a long answer or waste time on a short
   * one, so the drain is quiescence-based: it never quits before
   * `sendDrainMinMs` (the late answer needs a moment to start), then stops once
   * the stream has been silent for `SEND_QUIET_MS`, and always respects
   * `sendDrainMs` as a ceiling plus job cancellation.
   */
  const drainSends = async () => {
    // A run that never injected a message pays nothing: this is the only place
    // the drain can delay teardown, and it is skipped outright.
    if (sendsQueued === 0 || signal.aborted) return
    const drainStart = Date.now()
    while (keepDraining(Date.now() - drainStart, Date.now() - lastStreamAt, {
      minMs: sendDrainMinMs,
      quietMs: SEND_QUIET_MS,
      maxMs: sendDrainMs,
      aborted: signal.aborted,
    })) {
      await delay(500, undefined)
    }
  }
  const onAbort = () => {
    // Best-effort cooperative cancel; process teardown stays authoritative.
    if (sessionId !== undefined) {
      try { void agent.notify(methods.agent.session.cancel, { sessionId }).catch(() => { /* child gone */ }) } catch { /* child gone */ }
    }
  }
  signal.addEventListener('abort', onAbort, { once: true })

  let timer
  let heartbeat
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => controller.abort(`timed out after ${timeoutMs}ms`), Math.min(timeoutMs, MAX_TIMER_MS))
  }

  try {
    // Handshake: initialize → session/new (or session/resume for a follow-up).
    // Failure owns the still-private process.
    try {
      await agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
      let session
      let resumed = false
      /** Session state echoed by the last handshake/apply response. */
      let echoed
      if (resumeSessionId !== undefined) {
        try {
          // The response carries no session id: we asked to resume this one.
          echoed = await agent.request(methods.agent.session.resume, { sessionId: resumeSessionId, cwd, mcpServers: [] })
          sessionId = resumeSessionId
          resumed = true
        } catch (error) {
          if (signal.aborted) throw abortError(signal.reason)
          // A conversation can be gone (agy pruned it, or it never existed).
          // Falling back keeps the task runnable; the output says so.
          handle.append(`\n[agy] resume failed (${bounded(error?.message ?? error, 120)}); starting a new session\n`)
        }
      }
      if (!resumed) {
        session = await agent.request(methods.agent.session.new, { cwd, mcpServers: [] })
        sessionId = session.sessionId
        echoed = session
      }
      // Model / thinking level / mode: agy advertises these as session options,
      // and nothing applies them unless the client asks. A rejected value is a
      // hard failure rather than a silent downgrade, so a caller who asked for
      // a model never gets the default without being told.
      if (sessionConfig !== undefined) {
        const plan = planSessionConfig(echoed?.configOptions, echoed?.modes, sessionConfig)
        if (plan.error !== undefined) throw new SessionConfigError(plan.error)
        /** Options echoed by the most recent apply response, for deferral. */
        let liveOptions = echoed?.configOptions
        /** Mode this run set; `set_mode` sends no echo worth reading. */
        let appliedMode
        const notes = [...plan.skipped]
        let pending = plan.calls
        for (const call of pending) {
          if (call.deferred === true && call.configId === THOUGHT_OPTION) {
            // The model switch may have removed the level picker entirely: the
            // options from THAT response decide, not the ones we started with.
            const resolved = resolveDeferred([call], liveOptions)
            if (resolved.error !== undefined) throw new SessionConfigError(resolved.error)
            notes.push(...resolved.skipped)
            if (resolved.calls.length === 0) continue
          }
          const response = call.kind === 'mode'
            ? await agent.request(methods.agent.session.setMode, { sessionId, modeId: call.modeId })
            : await agent.request(methods.agent.session.setConfigOption, {
                sessionId, configId: call.configId, value: call.value,
              })
          if (response?.configOptions !== undefined) {
            liveOptions = response.configOptions
          } else if (call.kind === 'mode' && response?.modes?.currentModeId !== undefined) {
            // `session/set_mode` answers with an empty object (measured), so the
            // old options must not be reused as if they reflected the new mode.
            liveOptions = withMode(liveOptions, response.modes.currentModeId)
          }
          if (call.kind === 'mode') appliedMode = call.modeId
        }
        for (const note of notes) handle.append(`\n[agy:config] ${note}\n`)
        // The echo is the only trustworthy state: `models.currentModelId`
        // goes undefined after a config change (measured).
        const state = describeSessionConfig(liveOptions, {
          ...plan.applied,
          // Our own successful set_mode outranks a stale echo.
          mode: appliedMode ?? plan.applied.mode,
        })
        handle.append(`[agy:config] ${state}\n`)
        lastProgress = `config: ${state}`
        handle.updateProgress(bounded(lastProgress, 80))
      }
      rememberSession(sessionId, cwd)
      // A live entry makes `agy_send` inject into this run instead of starting a
      // resume job; it is dropped the moment the run settles.
      liveSessions.set(sessionId, { jobId: jobRef.id, cwd, send: sendLive })
      handle.append(`\n[agy] session ${resumed ? 'resumed' : 'ready'} (session: ${sessionId}, cwd: ${cwd})\n`)
      handle.updateProgress(resumed ? 'session resumed' : 'session ready')
      // Liveness heartbeat: agy can think or run one long tool call for minutes
      // with no stream update, and a quiet job ring reads as a hung run — to the
      // model polling `job_output` (which answers "(no new output)") and to the
      // human watching the session-header row. Append one line at most once per
      // HEARTBEAT_EVERY_MS of child silence, so silence stays visibly bounded.
      let lastHeartbeatAt = Date.now()
      heartbeat = setInterval(() => {
        const quiet = Date.now() - lastStreamAt
        if (quiet < HEARTBEAT_AFTER_MS || Date.now() - lastHeartbeatAt < HEARTBEAT_EVERY_MS) return
        lastHeartbeatAt = Date.now()
        const seconds = Math.round(quiet / 1000)
        handle.append(`\n[agy] alive: no child update for ${seconds}s (thinking or one long tool call); last progress: ${lastProgress}\n`)
        handle.updateProgress(bounded(`agy working — last update ${seconds}s ago`, 80))
      }, HEARTBEAT_CHECK_MS)
      heartbeat.unref?.()
    } catch (error) {
      if (signal.aborted) throw abortError(signal.reason)
      await disposeChild(child, disposeEofGraceMs)
      throw new Error(
        // A rejected session config is a CALLER error, not a broken child: say so,
        // or the operator wastes time reinstalling and re-logging-in agy.
        error instanceof SessionConfigError
          ? `agy session config rejected: ${bounded(error.message, 400)}`
          : `ACP startup failed${exitNote()}: ${bounded(error?.message ?? error, 300)}. `
            + `Check that ${command} is installed and signed in `
            + `(run it once interactively, or set credentials via the plugin env config).`,
      )
    }

    // One task per session; the child's stop reason decides the outcome.
    let stopReason
    try {
      const response = await Promise.race([
        agent.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: task }],
        }),
        abortReject(signal),
      ])
      stopReason = response.stopReason
    } catch (error) {
      if (signal.aborted) {
        handle.append(`\n[agy] cancelled${signal.reason ? ` (${bounded(signal.reason, 100)})` : ''}\n`)
        await disposeChild(child, disposeEofGraceMs)
        throw abortError(signal.reason)
      }
      await Promise.race([processDone.catch(() => {}), delay(disposeGraceMs, undefined)])
      await disposeChild(child, disposeEofGraceMs)
      throw new Error(`ACP prompt failed${exitNote()}: ${bounded(error?.message ?? error, 300)}`)
    }

    // A message injected as the turn ends becomes the merged answer: let it
    // land before the finished line and the teardown.
    await drainSends()
    // A reply need not end with a newline: emit the tail before judging it.
    reply.flush()

    const recovered = notices.messages()
    // agy retries a transient upstream failure in-process and streams one notice
    // per attempt. When the answer still arrived, the run SUCCEEDED — the
    // notices were progress, and the CLI hides them the same way. Only a run
    // that produced no answer is a refusal, and then the notices say why.
    const refusal = finalTextLength > 0
      ? backendFailure(headText, finalTextLength)
      : backendRefusal(recovered.join(' '))
    if (refusal !== undefined && stopReason === 'end_turn') {
      const why = finalTextLength > 0 ? firstLine(headText) : recovered.at(-1) ?? 'no answer text'
      handle.append(`\n[agy] failed: retryable ${refusal.code} (${bounded(why, 160)})\n`)
      handle.append(`[agy] hint: retry the same task; if it repeats, check the Antigravity proxy exit node or quota\n`)
      await disposeChild(child, disposeEofGraceMs)
      return { status: 'failed', detail: `retryable: ${refusal.code}` }
    }

    // A run that ends with no text at all is not a success: the parent would see a
    // silent "completed" job. Report it as a failure with a greppable cause.
    if (stopReason === 'end_turn' && finalTextLength === 0) {
      const detail = emptyRunDetail(sendsQueued > 0)
      handle.append(`\n[agy] failed: ${detail} — the run ended without any answer text\n`)
      if (sendsQueued > 0) {
        handle.append('[agy] hint: a message sent while the run was in flight ends the current turn; the follow-up work was cut off here. Send the next message with agy_send on the same session, or wait for settlement before sending.\n')
      }
      await disposeChild(child, disposeEofGraceMs)
      return { status: 'failed', detail }
    }

    const retryNote = recovered.length > 0
      ? `; ${recovered.length} retry notice${recovered.length === 1 ? '' : 's'} recovered`
      : ''
    handle.append(`\n[agy] finished (stop reason: ${stopReason}; ${finalTextLength} chars of answer streamed above${retryNote})\n`)
    await disposeChild(child, disposeEofGraceMs)

    if (stopReason === 'end_turn') {
      const detail = recovered.length > 0
        ? `stop reason: end_turn (${recovered.length} retry notice${recovered.length === 1 ? '' : 's'})`
        : 'stop reason: end_turn'
      return { status: 'completed', detail }
    }
    if (stopReason === 'cancelled') return { status: 'killed', detail: 'stop reason: cancelled' }
    return { status: 'failed', detail: `stop reason: ${stopReason}` }
  } finally {
    clearTimeout(timer)
    if (heartbeat !== undefined) clearInterval(heartbeat)
    signal.removeEventListener('abort', onAbort)
    // Only retire this run's own entry: a resume job may already have replaced it.
    const live = sessionId === undefined ? undefined : liveSessions.get(sessionId)
    if (live !== undefined && live.jobId === jobRef.id) liveSessions.delete(sessionId)
  }
}

/** Rejection on abort; never left with an unhandled rejection. */
function abortReject(signal) {
  const promise = new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error(signal.reason ?? 'cancelled')), { once: true })
  })
  promise.catch(() => { /* observed by the race; never unhandled */ })
  return promise
}

/**
 * JobHooks producer: owns cancellation, translates outcomes, and keeps the
 * original failure for host diagnostics.
 */
function runAgySession(handle, opts) {
  const controller = new AbortController()
  let failure
  const done = (async () => {
    try {
      return await driveSession(handle, opts, controller)
    } catch (error) {
      if (!controller.signal.aborted) failure = { error }
      if (controller.signal.aborted) {
        return { status: 'killed', detail: bounded(controller.signal.reason ?? 'cancelled', 100) }
      }
      return { status: 'failed', detail: bounded(error?.message ?? error, 300) }
    }
  })()
  return {
    cancel: reason => {
      if (!controller.signal.aborted) controller.abort(reason)
    },
    done,
    failure: () => failure,
  }
}

export function apply(ctx, config) {
  const cfg = config
  const spawn = spec => ctx.subprocess.spawn(spec)

  /**
   * Validate the arguments both tools share.
   * @param args - the tool arguments.
   * @throws `ToolArgsError` for an empty task or a non-positive timeout.
   */
  function checkArgs(args) {
    if (typeof args.task !== 'string' || args.task.trim().length === 0) {
      throw new ToolArgsError(['task must be a non-empty string'])
    }
    if (args.timeout_ms !== undefined && (!Number.isFinite(args.timeout_ms) || args.timeout_ms <= 0)) {
      throw new ToolArgsError(['timeout_ms must be a positive number of milliseconds'])
    }
  }

  /**
   * Start one Antigravity session job. `agy` creates the session; `agy_send`
   * resumes an earlier one when nothing is in flight. Everything else — job
   * bookkeeping, isolation, permission policy, cancellation, and the optional
   * deadline — is shared.
   *
   * The producer runs synchronously inside `jobs.start`, before the id is
   * returned, so the id travels through `jobRef` and is read only from the
   * handshake onward (after the producer's first awaits).
   * @param exec - the tool execution (agent, signal).
   * @param args - validated tool arguments (`task`, optional `timeout_ms`).
   * @param cwd - the working directory handed to the child.
   * @param resumeSessionId - an ACP session to resume, or `undefined` for a new one.
   * @returns the tool result: job id, cwd, permission, isolation.
   */
  function startJob(exec, args, cwd, resumeSessionId) {
    const jobRef = { id: undefined }
    /** Per-call config overrides merged over the plugin defaults (may be undefined). */
    const requested = resolveSessionConfig(cfg, args)
    // `taskPrefix` (default empty = verbatim pass-through) frames the FIRST
    // prompt of a new/resumed session. A message injected into a live session
    // never passes through here, so its text stays untouched.
    const task = composeTask(cfg.taskPrefix, args.task)
    const jobId = ctx.jobs.start({
      kind: 'agy',
      label: bounded(firstLine(args.task), 100),
      owner: exec.agent?.id,
      run: handle => runAgySession(handle, {
        jobRef,
        command: cfg.command,
        args: cfg.args,
        env: cfg.env,
        permission: cfg.permission,
        isolation: cfg.isolation,
        mcpTools: cfg.mcpTools,
        askTimeoutMs: cfg.askTimeoutMs,
        deniedCommandPaths: cfg.deniedCommandPaths,
        sendDrainMs: cfg.sendDrainMs,
        sendDrainMinMs: cfg.sendDrainMinMs,
        disposeEofGraceMs: cfg.disposeEofGraceMs,
        disposeGraceMs: cfg.disposeGraceMs,
        task,
        cwd,
        timeoutMs: args.timeout_ms,
        resumeSessionId,
        // Per-call values override the plugin defaults; blank entries mean
        // "leave agy's own setting alone", which is how they arrive here.
        sessionConfig: requested,
        parentAgent: exec.agent,
        spawn,
        approvalOf: () => ctx.get('approval'),
        policyOf: () => ctx.get('sandboxPolicy'),
      }),
    })
    jobRef.id = jobId
    return {
      job_id: jobId,
      cwd,
      permission: cfg.permission,
      isolation: cfg.isolation,
      ...sessionConfigSummary(requested),
    }
  }

  ctx.tools.register(defineTool({
    name: 'agy',
    description:
      'Run one self-contained task in Google Antigravity (agy, a Gemini-powered coding agent) '
      + 'inside the current working directory, as a background job with live progress. '
      + 'Returns a job id immediately: watch its tool calls and answer with job_output, expect an '
      + 'in-session completion notice, cancel with job_kill, bound it with timeout_ms. '
      + 'Antigravity sees none of this conversation — put everything the task needs into task.',
    parameters: {
      task: {
        type: 'string',
        required: true,
        description: 'Complete standalone instruction for Antigravity, including all context it needs (it does not see this conversation).',
      },
      timeout_ms: {
        type: 'number',
        description: 'Optional deadline in milliseconds; the session is cancelled when it elapses. Default: no deadline.',
      },
      model: {
        type: 'string',
        description: 'Optional model id for this run, overriding the plugin default. Use the base id the agent advertises '
          + `(e.g. "gemini-3.8-flash"); put the effort in thought_level. An id the account does not offer fails the run `
          + 'instead of silently falling back.',
      },
      thought_level: {
        type: 'string',
        enum: [...THINKING_LEVELS],
        description: `Optional thinking level for this run (${THINKING_LEVELS.join(' / ')}; the account may offer fewer). `
          + 'Requires a model with a thinking concept — models without one are reported, not silently ignored.',
      },
      mode: {
        type: 'string',
        enum: [...MODES],
        description: `Optional execution mode for this run (${MODES.join(' / ')}). `
          + 'Default lets agy decide; plan explores before editing; auto approves edits and safe commands.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          job_id: { type: 'string', required: true, description: 'Background job id for job_output / job_kill.' },
          cwd: { type: 'string', required: true, description: 'Working directory handed to the Antigravity session.' },
          permission: { type: 'string', required: true, enum: ['ask', 'allow', 'reject'], description: 'How its permission requests are decided.' },
          isolation: { type: 'string', required: true, enum: ['bwrap', 'agy-sandbox', 'off'], description: 'Process isolation layer applied to the child.' },
          session_config: {
            type: 'object',
            additionalProperties: false,
            description: 'Requested model / thinking level / mode; the applied values appear in the job output as [agy:config].',
            properties: {
              model: { type: 'string' },
              thoughtLevel: { type: 'string' },
              mode: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Antigravity session started as background job ${value.job_id} in ${value.cwd} `
          + `(permission: ${value.permission}; isolation: ${value.isolation}). `
          + `Watch progress with job_output (job_id: "${value.job_id}"); a completion notice arrives when it settles; cancel with job_kill. `
          + `Its session id appears in the job output as "[agy] session ... (session: <id>, cwd: ...)"; pass it to agy_send to add information, whether this run is still in flight or already finished.`,
      }],
    },
    presentCall: args => ({
      card: 'generic',
      title: `Delegate task to Antigravity: ${bounded(firstLine(args.task ?? ''), 80)}`,
      kind: 'execute',
      rawInput: bounded(args.task ?? '', 400),
    }),
    async execute(args, exec) {
      checkArgs(args)
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      return startJob(exec, args, cwd, undefined)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agy_send',
    description:
      'Send one more message to an Antigravity session, choosing the delivery path from its CURRENT state. '
      + 'If that session is still running, the message goes to the live child and the agent folds it into the '
      + 'current turn (no new job; the running job id comes back, and the answer is not attributed to this '
      + 'message — read the job output as one stream). If the session has settled, the plugin resumes it in a '
      + 'new child process as a fresh background job. Pass the session id printed as "session: <id>" in that '
      + 'job\'s output. Antigravity sees none of this DSH conversation — include any context the child needs.',
    parameters: {
      session_id: {
        type: 'string',
        required: true,
        description: 'ACP session id from an agy job output line: "[agy] session ... (session: <id>, cwd: ...)".',
      },
      message: {
        type: 'string',
        required: true,
        description: 'The message to deliver, including any context the child does not already have.',
      },
      timeout_ms: {
        type: 'number',
        description: 'Optional deadline for the WHOLE resumed run (ignored when the message goes to a live session, which keeps its own deadline). Default: no deadline.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', required: true, enum: ['injected', 'resumed'], description: 'injected = delivered to the running session; resumed = a new job resumed the session.' },
          job_id: { type: 'string', required: true, description: 'Background job id to read: the running job when injected, the new job when resumed.' },
          cwd: { type: 'string', required: true, description: 'Working directory handed to the Antigravity session.' },
          permission: { type: 'string', required: true, enum: ['ask', 'allow', 'reject'], description: 'How its permission requests are decided.' },
          isolation: { type: 'string', required: true, enum: ['bwrap', 'agy-sandbox', 'off'], description: 'Process isolation layer applied to the child.' },
          session_config: {
            type: 'object',
            additionalProperties: false,
            description: 'Requested model / thinking level / mode; the applied values appear in the job output as [agy:config].',
            properties: {
              model: { type: 'string' },
              thoughtLevel: { type: 'string' },
              mode: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.mode === 'injected'
          ? `Message delivered to the running Antigravity session (job ${value.job_id}); keep reading it with job_output.`
          : `Antigravity session resumed as background job ${value.job_id} in ${value.cwd} `
            + `(permission: ${value.permission}; isolation: ${value.isolation}). `
            + `Watch progress with job_output; a completion notice arrives when it settles; cancel with job_kill.`,
      }],
    },
    presentCall: args => ({
      card: 'generic',
      title: `Message Antigravity session ${bounded(args.session_id ?? '', 40)}: ${bounded(firstLine(args.message ?? ''), 60)}`,
      kind: 'execute',
      rawInput: bounded(args.message ?? '', 400),
    }),
    async execute(args, exec) {
      if (typeof args.session_id !== 'string' || args.session_id.trim().length === 0) {
        throw new ToolArgsError(['session_id must be a non-empty string'])
      }
      if (typeof args.message !== 'string' || args.message.trim().length === 0) {
        throw new ToolArgsError(['message must be a non-empty string'])
      }
      checkArgs({ task: args.message, timeout_ms: args.timeout_ms })
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      // A conversation resolves its files against the cwd it was opened with;
      // attaching it to a different one would silently mismatch paths.
      const known = sessionCwd(args.session_id)
      if (known !== undefined && known !== cwd) {
        throw new ToolArgsError([
          `session ${args.session_id} was opened in ${known}, not in this session's cwd (${cwd})`,
        ])
      }
      // Live session: the message joins the turn already in flight.
      const live = liveSessions.get(args.session_id)
      if (live !== undefined && live.send(args.message)) {
        return { mode: 'injected', job_id: live.jobId, cwd: live.cwd, permission: cfg.permission, isolation: cfg.isolation }
      }
      // Settled session (or a send that found the connection closed): resume it.
      const started = startJob(exec, { task: args.message, timeout_ms: args.timeout_ms }, cwd, args.session_id)
      return { mode: 'resumed', ...started }
    },
  }))

  let order = 100
  try { order = ctx.systemPrompt.getSectionOrder('TOOL_JOBS') } catch { /* fixed order */ }
  ctx.systemPrompt.section({
    name: 'tool:agy',
    order,
    text: 'Use the agy tool to delegate a self-contained task to Google Antigravity, a Gemini-powered coding agent that runs in the current working directory with its own tools and model. '
      + 'It starts a background job and returns a job id immediately: job_output streams its tool calls, plan, and answer live, a completion notice arrives in-session, job_kill cancels it, timeout_ms bounds it. '
      + 'OMIT timeout_ms on the agy call unless the task genuinely needs a deadline: it bounds the WHOLE run, so it also covers any human approval the run is waiting for, and a modest budget can expire while a legitimate approval is still pending. '
      + 'WAITING ON A LONG RUN IS NORMAL — agy can legitimately run 10-20+ minutes. When only the result remains, block with job_output(wait: true, timeout_ms: 600000) — the maximum wait — instead of short polls. '
      + 'A timed-out wait returns the new output plus a "running" status line and leaves the job alive; repeating the same wait verbatim is the correct, expected behavior, and a "repeating tool call" reminder while waiting does NOT mean the job is stuck. '
      + 'During child silence the job output shows an "[agy] alive: no child update for Ns" heartbeat line, so a quiet stretch is visible, not a hang. '
      + 'Treat a run as dead or astray only when the output shows a loop (repeated identical [agy:tool] lines without progress for many minutes) or it has clearly gone off-task; then job_kill it and finish yourself or continue with agy_send. '
      + 'IMPORTANT: put everything into task, because Antigravity sees none of this conversation. The plugin prepends its taskPrefix to the first prompt of every new or resumed session by default — a short standing instruction to prefer built-in file tools over shell commands, because in-project file operations need no approval while shell commands may pause on interactive approval that a background run cannot answer. That prefix is guidance, not enforcement: still state any task-specific tool preference in task itself. Set taskPrefix to \'\' in the plugin config for strict verbatim pass-through. '
      + 'Permissions are layered, and Antigravity\'s own engine is authoritative: it evaluates its global rules (~/.gemini/antigravity-cli/settings.json permissions) and any per-project rules (managed by /permissions in an interactive agy session) FIRST, so actions they already allow or deny never reach this plugin; workspace file effects are auto-allowed by Antigravity, and sandboxed commands run without prompting (toolPermission: proceed-in-sandbox). '
      + 'The bridge only sees what those rules leave uncovered, and then decides by the parent Session, not the user alone: in-project file effects follow the DSH sandbox mode (workspace-write and danger-full-access grant them, read-only denies them), MCP server tool calls follow the plugin mcpTools policy (allow by default), command executions that agy\'s own rules do not settle reach the session approval waterfall, and paths outside the project are denied outright. '
      + 'Retry notices are progress, not content: while agy retries a transient upstream failure (503 capacity, 429, mid-stream interruption) it streams one line per attempt, which this bridge routes to its own "[agy:retry] attempt N: ..." job line — the answer keeps only the model text. A run that retried and then answered SUCCEEDS (detail: "stop reason: end_turn (N retry notices)"), exactly as the CLI hides the same notices. '
      + 'Only a run that produced NO answer is a refusal: it settles failed with a detail starting "retryable:" (backend-capacity for "No capacity available", backend-unavailable for FAILED_PRECONDITION / "User location is not supported" / UNAVAILABLE, backend-quota for RESOURCE_EXHAUSTED). Retry such a task once; if the same marker repeats, report it to the user and point at the Antigravity proxy exit node or the account quota instead of retrying further. '
      + 'Antigravity sees none of this conversation, so compose task with all needed context. '
      + 'To add information to an existing Antigravity conversation, read its session id from the job output line "[agy] session ... (session: <id>, cwd: ...)" and call agy_send with that id plus the message. agy_send dispatches on the session state: a run still in flight takes the message on its live connection and folds it into the current turn — read that job output as one stream, since the answer is not attributed to your message — while a settled session is resumed in a fresh child process as a new job.',
  })
}
