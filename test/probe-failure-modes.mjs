/**
 * The other half of the retry fix: a run that produced NO answer must still
 * settle as a retryable failure — the retry notices are its cause, not its
 * answer. Drives the plugin against a stub ACP child so no network is involved.
 *
 * Each case: [description, answer chunks, expected status, expected detail].
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config } from '../lib/index.js'

const cwd = mkdtempSync(join(tmpdir(), 'agy-fail-probe-'))

/** Write a stub ACP agent that streams exactly the given chunks, then end_turn. */
function writeStub(name, chunks) {
  const path = join(cwd, `${name}.mjs`)
  const body = `import { createInterface } from 'node:readline'
const CHUNKS = ${JSON.stringify(chunks)}
const write = o => process.stdout.write(JSON.stringify(o) + '\\n')
const rl = createInterface({ input: process.stdin, terminal: false })
rl.on('line', line => {
  if (!line.trim()) return
  let msg; try { msg = JSON.parse(line) } catch { return }
  if (msg.id === undefined) return
  if (msg.method === 'initialize') return write({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } })
  if (msg.method === 'session/new') return write({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'stub-1' } })
  if (msg.method === 'session/prompt') {
    for (const text of CHUNKS) {
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'stub-1', update: { sessionId: 'stub-1', sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } })
    }
    write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
    setTimeout(() => process.exit(0), 50)
  }
})
rl.on('close', () => process.exit(0))
`
  writeFileSync(path, body)
  return path
}

const notice = n => `\n⚠ API error (attempt ${n}): UNAVAILABLE (code 503): No capacity available for model gemini-3.8-flash-high on the server\n`

const cases = [
  ['notices only → retryable failure', [notice(1), notice(2), notice(3)], 'failed', 'retryable: backend-capacity'],
  ['location refusal as answer', ['⚠ FAILED_PRECONDITION (code 400): User location is not supported for the API use.'], 'failed', 'retryable: backend-unavailable'],
  ['quota refusal as answer', ['RESOURCE_EXHAUSTED: quota exceeded'], 'failed', 'retryable: backend-quota'],
  ['empty answer → no-answer-text', [], 'failed', 'no-answer-text'],
  ['notices then a real answer → completed', [notice(1), notice(2), '已完成'], 'completed', 'stop reason: end_turn (2 retry notices)'],
  ['answer mentioning the phrase → completed', ['日志里出现 API error (attempt 1) 之后恢复'], 'completed', 'stop reason: end_turn'],
]

let failures = 0
for (const [label, chunks, wantStatus, wantDetail] of cases) {
  const stub = writeStub(`stub-${Math.abs(label.length)}-${chunks.length}`, chunks)
  const output = []
  let outcome
  const defs = new Map()
  const fakeCtx = {
    subprocess: {
      spawn: spec => {
        const child = nodeSpawn(process.execPath, [stub], { cwd: spec.cwd, stdio: ['pipe', 'pipe', 'inherit'] })
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
        const hooks = spec.run({ append: t => { output.push(t) }, updateProgress: () => {} })
        hooks.done.then(o => { outcome = o }, e => { outcome = { status: 'error', detail: String(e) } })
        return 'job-fail-1'
      },
    },
    tools: { register: def => { defs.set(def.name, def) } },
    workingDirectory: { ensure: async () => cwd },
    systemPrompt: { section() {}, getSectionOrder: () => 100 },
    get: () => undefined,
  }
  apply(fakeCtx, Config({ command: 'stub', args: [], isolation: 'off', permission: 'allow', env: {} }))
  const agy = defs.get('agy')
  await agy.execute({ task: 'stub case' }, { agent: undefined, signal: new AbortController().signal })
  while (outcome === undefined) await new Promise(r => setTimeout(r, 50))

  const answerLeak = /\[agy:retry\][^\n]*\n/.test(output.join(''))
  const ok = outcome.status === wantStatus && outcome.detail === wantDetail
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}\n     => ${JSON.stringify(outcome)}${answerLeak ? ' (retry line rendered)' : ''}`)
}

console.log(failures === 0 ? '[probe] PASS' : `[probe] FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
