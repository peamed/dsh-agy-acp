/**
 * In-flight injection probe: while a `session/prompt` is still running, can the
 * client send ANOTHER prompt with extra information, and does the agent take it?
 *
 * Timeline: prompt A asks agy to run `sleep 8`; three seconds later prompt B
 * injects a passphrase; after A settles, prompt C asks for the passphrase back.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import {
  client as createAcpClientApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk'

const cwd = mkdtempSync(join(tmpdir(), 'agy-inflight-probe-'))
console.log('[probe] cwd:', cwd)

const child = nodeSpawn('agy', ['acp', '--sandbox'], { cwd, stdio: ['pipe', 'pipe', 'inherit'] })
child.on('error', error => { console.error('[probe] spawn failed:', error.message); process.exit(1) })

let chunks = []
const app = createAcpClientApp({ name: 'dsh-agy-acp-inflight-probe' })
  .onNotification(methods.client.session.update, ({ params }) => {
    const u = params.update
    if (u.sessionUpdate === 'agent_message_chunk') {
      chunks.push(u.content?.text ?? '')
    } else if (u.sessionUpdate === 'tool_call') {
      console.log('[tool]', u.title, `(${u.kind ?? '?'})`)
    }
    return Promise.resolve()
  })
  .onRequest(methods.client.session.requestPermission, ({ params }) => {
    console.log('[permission]', params.toolCall?.title, `(kind: ${params.toolCall?.kind})`)
    const allow = (params.options ?? []).find(o => o.kind === 'allow_once' || o.kind === 'allow_always')
    return Promise.resolve(allow !== undefined
      ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
      : { outcome: { outcome: 'cancelled' } })
  })

const connection = app.connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)))
const agent = connection.agent
const timeout = setTimeout(() => { console.error('[probe] TIMEOUT'); child.kill('SIGKILL'); process.exit(2) }, 200_000)
const take = () => { const t = chunks.join(''); chunks = []; return t.trim() }

try {
  await agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
  const session = await agent.request(methods.agent.session.new, { cwd, mcpServers: [] })
  const sessionId = session.sessionId
  console.log('[probe] sessionId:', sessionId)

  // ── Prompt A: a task that takes a while ───────────────────────────────────
  const a = agent.request(methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: 'text', text: 'Run the shell command "sleep 8" exactly once, then reply DONE-A.' }],
  }).then(
    r => ({ ok: true, stopReason: r.stopReason }),
    e => ({ ok: false, error: e?.message ?? String(e) }),
  )

  // ── Prompt B: injected while A is still running ───────────────────────────
  await new Promise(r => setTimeout(r, 3000))
  console.log('[probe] A still running?', 'yes (3s elapsed) — sending prompt B now')
  const b = agent.request(methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: 'text', text: 'New information while you work: the passphrase is TEAL-88. Acknowledge it briefly.' }],
  }).then(
    r => ({ ok: true, stopReason: r.stopReason }),
    e => ({ ok: false, error: e?.message ?? String(e) }),
  )

  console.log('[probe] A result:', JSON.stringify(await a))
  console.log('[probe] A text  :', JSON.stringify(take()))
  console.log('[probe] B result:', JSON.stringify(await b))
  try { console.log('[probe] B text  :', JSON.stringify(take())) } catch {}

  // ── Prompt C: did the injected information survive? ───────────────────────
  const c = await agent.request(methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: 'text', text: 'What passphrase was sent while you were working? Reply with the passphrase alone.' }],
  })
  const answerC = take()
  console.log('[probe] C stopReason:', c.stopReason, '| C text:', JSON.stringify(answerC))
  console.log('[probe] VERDICT:', answerC.includes('TEAL-88')
    ? 'MID-RUN INJECTION WORKS'
    : 'MID-RUN INFORMATION WAS NOT RETAINED')
} catch (error) {
  console.error('[probe] failed:', error?.message ?? error)
} finally {
  clearTimeout(timeout)
  try { child.stdin.end() } catch {}
  setTimeout(() => { child.kill('SIGKILL'); process.exit(0) }, 2_000)
}