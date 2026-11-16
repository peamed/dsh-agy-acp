/**
 * dsh-agy-acp v2 — Google Antigravity (`agy acp`) as a first-class subagent
 * provider with a live process mirror.
 *
 * Registers an out-of-process `SubagentProvider` named `agy` on the subagent
 * seam. Each delegation spawns `agy acp` through the subprocess seam, drives
 * the Agent Client Protocol (initialize → session/new → session/prompt), and
 * settles through the seam helpers exactly like the official ACP backend.
 *
 * The one behavioral difference — the reason this provider exists — is that
 * nothing is discarded: every `session/update` (answer chunks, tool calls,
 * plans, permission decisions) is mirrored into a background job owned by the
 * delegating parent session. The parent watches the run live with `job_list`
 * and `job_output`, receives the standard managed completion notice, and can
 * cancel through `interrupt_agent` (tree semantics) or `job_kill` (mirror).
 *
 * The mirror job adds no process, connection, or polling: it is a synchronous
 * in-memory ring write on the same event stream that already handles the
 * protocol traffic.
 *
 * Named exports only (a default export would hide loader metadata).
 */

import { randomUUID } from 'node:crypto'
import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream'
import z from '@deepseek-ai/schemastery'
import {
  AssistantOutputFold,
  SubagentRunId,
  assertUsableCwd,
  settleRunResult,
  subprocessRunHandle,
} from '@deepseek-ai/dsh-subagent'
import {
  client as createAcpClientApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk'

export const name = 'agy-acp'
export const inject = ['subagents', 'subprocess', 'jobs', 'systemPrompt']

/** Longest Node.js timer delay; graces are clamped to it. */
const MAX_TIMER_MS = 2_147_483_647

export const Config = z.object({
  /** Executable spawned for each run (the child ACP agent). */
  command: z.string().default('agy'),
  /** Arguments passed to `command`. */
  args: z.array(z.string()).default(['acp']),
  /**
   * Auto-answer policy for the child's permission prompts: `reject` declines
   * every prompt; `allow` approves via the first `allow_once`/`allow_always`
   * option. No prompt is surfaced to a human.
   */
  permission: z.union(['allow', 'reject']).default('reject'),
  /**
   * Extra child environment entries merged over the subprocess seam's
   * credential-scrubbed parent env (e.g. `GEMINI_API_KEY`).
   */
  env: z.dict(z.string()).default({}),
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

/** Resolve after `ms` with `value`. */
function delay(ms, value) {
  return new Promise(resolve => { setTimeout(() => resolve(value), Math.min(ms, MAX_TIMER_MS)) })
}

/** A cancel-shaped error (callers translate it into an `aborted` outcome). */
function abortError(reason) {
  const error = new Error(reason ?? 'cancelled')
  error.cancelled = true
  return error
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

/** Map an ACP stop reason onto the seam's stop-reason vocabulary. */
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
 * Start one managed Agy run: mirror job first, then spawn + handshake (a
 * failure here rejects `start()` before publication and settles the job as
 * failed), then publish the seam run handle whose result settles with the
 * child's stop reason.
 */
async function startAgyManagedRun(ctx, cfg, request) {
  if (request.signal.aborted) throw new Error('subagent request was aborted before the ACP child started')
  const cwd = assertUsableCwd('agy-acp', 'child cwd', request.cwd)
  const promptText = (request.prompt ?? [])
    .filter(block => block?.type === 'text')
    .map(block => block.text)
    .join('\n')

  // ── Cancellation and settlement state ────────────────────────────────────
  let cancelRequested = false
  let cancelReason
  let sessionId
  let diagnostic
  let settledResult
  const cancelSettled = Promise.withResolvers()
  const requestCancel = (reason) => {
    if (cancelRequested) return
    cancelRequested = true
    cancelReason = bounded(reason ?? 'cancelled', 100)
    if (sessionId !== undefined) {
      try { void agent.notify(methods.agent.session.cancel, { sessionId }).catch(() => { /* child gone */ }) } catch { /* child gone */ }
    }
    cancelSettled.resolve()
  }
  const onAbort = () => requestCancel(request.signal.reason ?? 'request aborted')
  request.signal.addEventListener('abort', onAbort, { once: true })

  // ── Mirror job (owned by the delegating parent session) ──────────────────
  const jobDone = Promise.withResolvers()
  let jobDoneSettled = false
  const finishJob = (outcome) => {
    if (jobDoneSettled) return
    jobDoneSettled = true
    jobDone.resolve(outcome)
  }
  const finishJobFromState = () => {
    // The seam's dispose() calls requestCancel() even on the normal completion
    // path, so the settled run result — not the cancel flag — is authoritative.
    if (settledResult !== undefined) {
      const stopReason = settledResult.stopReason
      if (stopReason === 'completed') finishJob({ status: 'completed', detail: 'stop reason: end_turn' })
      else if (stopReason === 'aborted') finishJob({ status: 'killed', detail: cancelReason ?? 'cancelled' })
      else finishJob({ status: 'failed', detail: `stop reason: ${stopReason}` })
      return
    }
    if (cancelRequested) {
      finishJob({ status: 'killed', detail: cancelReason ?? 'cancelled' })
      return
    }
    finishJob({ status: 'failed', detail: bounded(diagnostic ?? 'run ended without a settled result', 200) })
  }
  let mirror
  const jobId = ctx.jobs.start({
    kind: 'agy',
    label: bounded(firstLine(request.label ?? promptText ?? 'task'), 100),
    owner: request.parent.id,
    run: (handle) => {
      mirror = handle
      return { cancel: reason => requestCancel(reason ?? 'cancelled via job_kill'), done: jobDone.promise }
    },
  })
  void jobId

  // ── Spawn ────────────────────────────────────────────────────────────────
  let child
  try {
    child = ctx.subprocess.spawn({
      argv: [cfg.command, ...cfg.args],
      cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: cfg.disposeGraceMs,
      env: cfg.env,
    })
  } catch (error) {
    finishJob({ status: 'failed', detail: bounded(`failed to spawn ${cfg.command}: ${error?.message ?? error}`, 200) })
    throw new Error(`failed to spawn ${cfg.command}: ${bounded(error?.message ?? error, 200)}`)
  }
  mirror.append(`[agy] starting ${cfg.command} ${cfg.args.join(' ')} (cwd: ${cwd})\n`)
  child.stderr?.on('data', chunk => {
    const text = chunk.toString('utf8')
    if (text.length > 0) mirror.append(text, { channel: 'stderr' })
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

  // ── ACP client: fold the answer, mirror everything ───────────────────────
  const fold = new AssistantOutputFold()
  let finalTextLength = 0

  const clientApp = createAcpClientApp({ name: 'dsh-agy-acp' })
    .onNotification(methods.client.session.update, ({ params }) => {
      const update = params.update
      switch (update.sessionUpdate) {
        case 'agent_message_chunk': {
          const block = update.content
          if (block?.type === 'text' && block.text.length > 0) {
            finalTextLength += block.text.length
            fold.pushText(block.text)
            mirror.append(block.text)
          }
          break
        }
        case 'tool_call': {
          mirror.append(`\n[agy:tool] ${bounded(update.title ?? 'tool call')} (${update.kind ?? 'other'}, ${update.status ?? 'pending'})\n`)
          mirror.updateProgress(bounded(`${update.kind ?? 'tool'}: ${update.title ?? ''}`, 80))
          break
        }
        case 'tool_call_update': {
          if (update.status === 'completed' || update.status === 'failed') {
            mirror.append(`\n[agy:tool] ${bounded(update.title ?? 'tool call')} → ${update.status}\n`)
          } else {
            mirror.updateProgress(bounded(`${update.title ?? 'tool'} (${update.status ?? 'running'})`, 80))
          }
          break
        }
        case 'plan': {
          const entries = Array.isArray(update.entries) ? update.entries : []
          const summary = bounded(entries.map(entry => entry?.content ?? '').filter(Boolean).join(' → '), 200)
          if (summary.length > 0) mirror.append(`\n[agy:plan] ${summary}\n`)
          break
        }
        default:
          // Other trace updates (thoughts, mode changes, …) stay unrendered.
          break
      }
      return Promise.resolve()
    })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      const what = bounded(params.toolCall?.title ?? params.toolCall?.kind ?? 'request', 100)
      if (cfg.permission === 'allow') {
        const allow = (params.options ?? []).find(option => option.kind === 'allow_once' || option.kind === 'allow_always')
        if (allow !== undefined) {
          mirror.append(`\n[agy:permission] ${what} → allowed (policy: allow)\n`)
          return Promise.resolve({ outcome: { outcome: 'selected', optionId: allow.optionId } })
        }
      }
      mirror.append(`\n[agy:permission] ${what} → denied (policy: ${cfg.permission})\n`)
      return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    })

  const connection = clientApp.connect(ndJsonStream(
    NodeWritable.toWeb(child.stdin),
    NodeReadable.toWeb(child.stdout),
  ))
  const agent = connection.agent

  // ── Handshake: initialize → session/new (start() awaits this) ────────────
  try {
    await agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const session = await agent.request(methods.agent.session.new, { cwd, mcpServers: [] })
    sessionId = session.sessionId
    mirror.append(`\n[agy] session ready (cwd: ${cwd})\n`)
    mirror.updateProgress('session ready')
  } catch (error) {
    if (cancelRequested) {
      await disposeChild(child, cfg.disposeEofGraceMs).catch(() => {})
      finishJob({ status: 'killed', detail: cancelReason ?? 'cancelled' })
      throw abortError(cancelReason)
    }
    await disposeChild(child, cfg.disposeEofGraceMs).catch(() => {})
    const detail = bounded(`ACP startup failed${exitNote()}: ${error?.message ?? error}`, 300)
    finishJob({ status: 'failed', detail })
    throw new Error(
      `${detail}. Check that ${cfg.command} is installed and signed in `
      + `(run it once interactively, or set credentials via the plugin env config).`,
    )
  }

  // ── Prompt turn: settle through the seam (result never rejects) ──────────
  const result = settleRunResult({
    attempt: async () => {
      try {
        const promptResult = await Promise.race([
          agent.request(methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: 'text', text: promptText }],
          }),
          cancelSettled.promise.then(() => { throw abortError(cancelReason) }),
        ])
        const stopReason = acpStopReason(promptResult.stopReason)
        if (stopReason !== 'completed' && !cancelRequested) {
          diagnostic = `child finished with stop reason: ${promptResult.stopReason}`
        }
        const value = { output: fold.collect() ?? [], stopReason }
        settledResult = value
        return value
      } catch (error) {
        if (!cancelRequested) {
          await Promise.race([processDone.catch(() => {}), delay(cfg.disposeGraceMs, undefined)])
          diagnostic = bounded(`ACP prompt failed${exitNote()}: ${error?.message ?? error}`, 300)
        }
        throw processFailure ?? error
      }
    },
    collectOutput: () => fold.collect() ?? [],
    collectDiagnostic: () => diagnostic,
    cancelled: () => cancelRequested,
    onError: () => { /* diagnostics already captured; the seam flattens to stop reason */ },
    signal: request.signal,
    onAbort,
  })
  result.then(value => { settledResult = value }, () => { /* never rejects by contract */ })

  // ── Publish the seam run handle ──────────────────────────────────────────
  return subprocessRunHandle({
    id: SubagentRunId(randomUUID()),
    result,
    signal: request.signal,
    onAbort,
    requestCancel: () => requestCancel('cancelled'),
    teardown: async () => {
      try {
        await disposeChild(child, cfg.disposeEofGraceMs)
      } finally {
        if (settledResult !== undefined) {
          mirror.append(`\n[agy] finished (stop reason: ${settledResult.stopReason}; ${finalTextLength} chars of answer streamed above)\n`)
        } else if (cancelRequested) {
          mirror.append(`\n[agy] cancelled (${cancelReason ?? 'cancelled'})\n`)
        }
        finishJobFromState()
      }
    },
  })
}

/**
 * The subagent seam provider. Advertises no optional start-time capabilities —
 * an out-of-process child cannot honor agentPreset/agentOptions/outputSchema/
 * depth caps; the seam rejects requests needing them instead of omitting them.
 */
class AgyProvider {
  name = 'agy'
  capabilities = { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false }
  inheritsParentContext = false

  constructor(ctx, config) {
    this.ctx = ctx
    this.cfg = config
  }

  start(request) {
    return startAgyManagedRun(this.ctx, this.cfg, request)
  }
}

export function apply(ctx, config) {
  ctx.subagents.registerProvider(new AgyProvider(ctx, config))

  let order = 100
  try { order = ctx.systemPrompt.getSectionOrder('TOOL_JOBS') } catch { /* fixed order */ }
  ctx.systemPrompt.section({
    name: 'agy-mirror-observation',
    order,
    text: 'Use the agy delegation tool to hand a self-contained task to Google Antigravity, a Gemini-powered coding agent running as an out-of-process ACP subagent in the current working directory. '
      + 'The call returns the child name immediately; its live process (tool calls, plan, and answer stream) is mirrored to a background job of kind agy — find it with job_list and watch it with job_output. '
      + 'The managed completion notice carries the final answer; interrupt_agent cancels by child name and job_kill cancels the mirror. '
      + 'Antigravity sees none of this conversation, so compose task with all needed context. Its permission prompts are answered automatically by the configured policy.',
  })
}
