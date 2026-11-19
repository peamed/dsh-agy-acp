/**
 * End-to-end regression for the 503 retry misjudgement: drive the real `agy acp`
 * through the plugin's own apply() with permission allow, and assert that a run
 * which retried still settles `completed` with a clean answer.
 *
 * Usage: node probe-retry-e2e.mjs [attempts]
 * The probe retries the whole run until it observes at least one retry notice
 * (agy's 503 is intermittent), up to `attempts` runs (default 4).
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config } from '../lib/index.js'

const maxRuns = Number(process.argv[2] ?? 4)
const cwd = mkdtempSync(join(tmpdir(), 'agy-retry-probe-'))
const task = 'Reply with exactly: RETRY-PROBE-OK'

/** One full plugin-driven run; resolves with its outcome and job output. */
async function runOnce() {
  const output = []
  let outcome
  const defs = new Map()

  const fakeCtx = {
    subprocess: {
      spawn: spec => {
        const child = nodeSpawn(spec.argv[0], spec.argv.slice(1), {
          cwd: spec.cwd,
          stdio: ['pipe', 'pipe', 'inherit'],
          env: { ...process.env, ...(spec.env ?? {}) },
        })
        return {
          stdin: child.stdin,
          stdout: child.stdout,
          stderr: child.stderr,
          done: new Promise(resolve => child.on('exit', code => resolve({ exitCode: code }))),
          terminate: () => child.kill('SIGTERM'),
          waitForExit: () => new Promise(resolve => child.on('exit', () => resolve())),
        }
      },
    },
    jobs: {
      start: spec => {
        const hooks = spec.run({
          append: text => { output.push(text) },
          updateProgress: () => {},
        })
        hooks.done.then(
          o => { outcome = o },
          e => { outcome = { status: 'error', detail: String(e) } },
        )
        return `job-retry-${Date.now()}`
      },
    },
    tools: { register: def => { defs.set(def.name, def) } },
    workingDirectory: { ensure: async () => cwd },
    systemPrompt: { section() {}, getSectionOrder: () => 100 },
    get: () => undefined,
  }

  apply(fakeCtx, Config({ command: 'agy', args: ['acp'], isolation: 'off', permission: 'allow', env: {} }))
  const agy = defs.get('agy')
  if (agy === undefined) throw new Error('agy tool not registered')

  await agy.execute({ task }, { agent: undefined, signal: new AbortController().signal })
  while (outcome === undefined) await new Promise(resolve => setTimeout(resolve, 500))
  return { outcome, text: output.join('') }
}

let sawRetry = false
let failures = 0
for (let run = 1; run <= maxRuns; run += 1) {
  const { outcome, text } = await runOnce()
  const attempts = [...text.matchAll(/\[agy:retry\] attempt (\d+)/g)].map(m => Number(m[1]))
  // The answer channel, with our own retry lines removed: a leaked banner here
  // is exactly the bug this probe guards against.
  const answerChannel = text.replace(/\[agy:retry\][^\n]*\n/g, '')
  const leaked = /No capacity available|API error \(attempt \d+\)/.test(answerChannel)
  console.log(`[probe] run ${run}: outcome=${JSON.stringify(outcome)} retries=${JSON.stringify(attempts)} leaked=${leaked}`)
  if (attempts.length > 0) sawRetry = true
  if (outcome.status !== 'completed') {
    failures += 1
    console.log('---- output ----')
    console.log(text.trim())
  }
  if (leaked) failures += 1
  if (sawRetry && failures === 0) break
}

console.log(`[probe] sawRetry=${sawRetry} failures=${failures}`)
if (!sawRetry) console.log('[probe] NOTE: no 503 observed in these runs (upstream was healthy); the completion path still passed')
const ok = failures === 0
console.log(ok ? '[probe] PASS' : '[probe] FAIL')
process.exit(ok ? 0 : 1)
