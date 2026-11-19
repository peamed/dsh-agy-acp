/**
 * End-to-end: drive the REAL plugin (apply()) against the REAL agy, with model
 * and thought level set, and verify the job output's [agy:config] line matches
 * what was asked. Also covers the rejection path and the "no config" path.
 *
 * Usage: node test/probe-config-e2e.mjs
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config } from '../lib/index.js'

const cwd = mkdtempSync(join(tmpdir(), 'agy-cfg-probe-'))

/** One run through the plugin; resolves with outcome and captured job output. */
async function runOnce({ cfgModel = '', cfgLevel = '', cfgMode = '', args = {} }) {
  const output = []
  let outcome
  const defs = new Map()
  const fakeCtx = {
    subprocess: {
      spawn: spec => {
        const child = nodeSpawn(spec.argv[0], spec.argv.slice(1), {
          cwd: spec.cwd, stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, ...(spec.env ?? {}) },
        })
        return {
          stdin: child.stdin, stdout: child.stdout, stderr: child.stderr,
          done: new Promise(r => child.on('exit', code => r({ exitCode: code }))),
          terminate: () => child.kill('SIGTERM'),
          waitForExit: () => new Promise(r => child.on('exit', () => r())),
        }
      },
    },
    jobs: {
      start: spec => {
        const hooks = spec.run({ append: t => output.push(t), updateProgress: () => {} })
        hooks.done.then(o => { outcome = o }, e => { outcome = { status: 'error', detail: String(e?.message ?? e) } })
        return `job-cfg-${Date.now()}`
      },
    },
    tools: { register: def => defs.set(def.name, def) },
    workingDirectory: { ensure: async () => cwd },
    systemPrompt: { section() {}, getSectionOrder: () => 100 },
    get: () => undefined,
  }
  apply(fakeCtx, Config({
    command: 'agy', args: ['acp'], isolation: 'off', permission: 'allow', env: {},
    model: cfgModel, thoughtLevel: cfgLevel, mode: cfgMode,
  }))
  const agy = defs.get('agy')
  let result, thrown
  try {
    result = await agy.execute({ task: 'Reply with exactly: CFG-OK', ...args }, {
      agent: undefined, signal: new AbortController().signal,
    })
  } catch (error) {
    thrown = String(error?.message ?? error)
  }
  while (outcome === undefined && thrown === undefined) await new Promise(r => setTimeout(r, 200))
  return { result, thrown, outcome, text: output.join('') }
}

const cases = [
  ['plugin default: model + high', { cfgModel: 'gemini-3.8-flash', cfgLevel: 'high' },
    o => o.outcome?.status === 'completed' && /\[agy:config\] model=gemini-3\.8-flash thinking=high/.test(o.text)],
  ['per-call override beats plugin default', { cfgModel: 'gemini-3.8-flash', cfgLevel: 'high', args: { thought_level: 'low' } },
    o => o.outcome?.status === 'completed' && /thinking=low/.test(o.text)],
  ['mode only', { cfgMode: 'plan' },
    o => o.outcome?.status === 'completed' && /\[agy:config\] .*mode=plan/.test(o.text)],
  // A rejected value settles the JOB as failed (the plugin's contract is that a
  // failed run reports through the outcome, not by throwing at the caller), and
  // the detail must name the offered models so the request is fixable.
  ['unknown model is rejected loudly', { args: { model: 'no-such-model' } },
    o => o.outcome?.status === 'failed'
      && /agy session config rejected: Model "no-such-model" is not offered/.test(o.outcome.detail)
      && /gemini-3\.8-flash \(Gemini 3\.8 Flash\)/.test(o.outcome.detail)
      // The misleading "is agy installed and signed in" hint must NOT appear:
      // nothing is wrong with the child, the request is wrong.
      && !/installed and signed in/.test(o.outcome.detail)],
  ['level on a thinking-less model is skipped, not fatal', { cfgModel: 'claude-sonnet-4-6', cfgLevel: 'high' },
    o => o.outcome?.status === 'completed' && /not applied \(the selected model exposes no thought_level\)/.test(o.text)],
  ['no config requested: unchanged path', {},
    o => o.outcome?.status === 'completed' && !/\[agy:config\]/.test(o.text)],
]

let failures = 0
for (const [label, opts, check] of cases) {
  const o = await runOnce(opts)
  const ok = check(o)
  if (!ok) {
    failures += 1
    console.log(`FAIL ${label}`)
    console.log('  thrown:', o.thrown)
    console.log('  outcome:', JSON.stringify(o.outcome))
    console.log('  config lines:', (o.text.match(/\[agy:config\][^\n]*/g) ?? []).join(' | '))
  } else {
    console.log(`ok   ${label}`)
    const lines = o.text.match(/\[agy:config\][^\n]*/g) ?? []
    if (lines.length > 0) console.log(`     ${lines.join(' | ')}`)
  }
}
console.log(failures === 0 ? '[probe] PASS' : `[probe] FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
