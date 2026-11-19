/**
 * Heartbeat probe: drive the real `driveSession` through a fake cordis context
 * and a stub ACP child that stays silent past HEARTBEAT_AFTER_MS (120s), then
 * answers normally. Asserts the job ring contains the `[agy] alive:` heartbeat
 * line and the run still settles completed (the heartbeat must not disturb the
 * empty-answer guard: the stub's one text chunk is the final answer).
 *
 * Wall time ≈ silenceMs + settle (~150s at the default 131s).
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, Config } from '../lib/index.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const stubPath = join(here, 'stub-agy-silent.mjs')
const silenceMs = Number(process.argv[2] ?? 131_000)
const cwd = mkdtempSync(join(tmpdir(), 'agy-heartbeat-probe-'))
console.log('[probe] cwd:', cwd, 'silence:', silenceMs, 'ms')

const output = []
let outcome
const defs = new Map()

const fakeCtx = {
  subprocess: {
    spawn: spec => {
      // Ignore the spec's argv (isolation off keeps it [command]); always run
      // the stub with the requested silence.
      const child = nodeSpawn(process.execPath, [stubPath, String(silenceMs)], {
        cwd: spec.cwd,
        stdio: ['pipe', 'pipe', 'inherit'],
      })
      child.on('error', error => { console.error('[probe] stub spawn failed:', error.message); process.exit(1) })
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
        append: (text) => { output.push(text) },
        updateProgress: () => { /* observed via output */ },
      })
      hooks.done.then(
        o => { outcome = o },
        e => { outcome = { status: 'error', detail: String(e) } },
      )
      return 'job-heartbeat-1'
    },
  },
  tools: { register: def => { defs.set(def.name, def) } },
  workingDirectory: { ensure: async () => cwd },
  systemPrompt: { section() { /* observed via defs */ }, getSectionOrder: () => 100 },
  get: () => undefined,
}

apply(fakeCtx, Config({
  command: 'stub-agy',
  args: [],
  isolation: 'off',
  permission: 'allow',
  env: {},
}))

const agy = defs.get('agy')
if (agy === undefined) { console.error('[probe] agy tool not registered'); process.exit(1) }

const watchdog = setTimeout(() => { console.error('[probe] TIMEOUT waiting for settle'); process.exit(2) }, silenceMs + 120_000)

const start = Date.now()
const result = await agy.execute({ task: 'heartbeat probe: answer only after the long silence' }, {
  agent: undefined,
  signal: new AbortController().signal,
})
while (outcome === undefined) await new Promise(r => setTimeout(r, 500))
clearTimeout(watchdog)

const text = output.join('')
const beats = [...text.matchAll(/\[agy\] alive: no child update for (\d+)s/g)].map(m => Number(m[1]))
const started = Date.now() - start
console.log('[probe] tool result:', JSON.stringify(result))
console.log('[probe] outcome:', JSON.stringify(outcome), `(${Math.round(started / 1000)}s wall)`)
console.log('[probe] heartbeat lines:', beats.length, beats.length > 0 ? `(first at ${beats[0]}s silence)` : '')
console.log('---- job output ----')
console.log(text.trim())

const ok = beats.length > 0 && outcome.status === 'completed'
console.log(ok ? '[probe] PASS' : '[probe] FAIL')
process.exit(ok ? 0 : 1)
