/**
 * One-off probe: does agy acp honor the global permissions.allow
 * (`command(ls)` in ~/.gemini/antigravity-cli/settings.json) WITHOUT sending a
 * session/request_permission to the client — as the official ACP doc says?
 *
 * Task: run `ls -la` once, reply DONE. Logs every permission request. If a
 * request fires for a globally allowed command, the engine ignores global
 * rules in acp mode (the 2026-11-16 note); if none fires, rules apply (docs).
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

const cwd = mkdtempSync(join(tmpdir(), 'agy-cmd-ask-probe-'))
console.log('[probe] cwd:', cwd)
// Optional argv[2]: the command for the agent to run (default `ls -la`).
const command = process.argv[2] ?? 'ls -la'
console.log('[probe] command under test:', command)

const child = nodeSpawn('agy', ['acp', '--sandbox'], { cwd, stdio: ['pipe', 'pipe', 'inherit'] })
child.on('error', error => { console.error('[probe] spawn failed:', error.message); process.exit(1) })

let chunks = []
const asks = []
const app = createAcpClientApp({ name: 'dsh-agy-cmd-ask-probe' })
  .onNotification(methods.client.session.update, ({ params }) => {
    const u = params.update
    if (u.sessionUpdate === 'agent_message_chunk') chunks.push(u.content?.text ?? '')
    else if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
      console.log('[tool]', u.sessionUpdate, JSON.stringify(u.title ?? ''), u.status ?? '')
    }
    return Promise.resolve()
  })
  .onRequest(methods.client.session.requestPermission, ({ params }) => {
    const what = params.toolCall?.title ?? params.toolCall?.kind ?? '?'
    asks.push(what)
    console.log('[permission-REQUEST]', JSON.stringify(what), 'kind:', params.toolCall?.kind)
    const allow = (params.options ?? []).find(o => o.kind === 'allow_once' || o.kind === 'allow_always')
    return Promise.resolve(allow !== undefined
      ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
      : { outcome: { outcome: 'cancelled' } })
  })

const connection = app.connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)))
const agent = connection.agent
const timeout = setTimeout(() => { console.error('[probe] TIMEOUT'); child.kill('SIGKILL'); process.exit(2) }, 180_000)

try {
  await agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
  const session = await agent.request(methods.agent.session.new, { cwd, mcpServers: [] })
  console.log('[probe] session:', session.sessionId)
  const response = await agent.request(methods.agent.session.prompt, {
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: `运行一次 shell 命令 \`${command}\`（就这一条命令），然后只回复 DONE。` }],
  })
  console.log('[probe] stopReason:', response?.stopReason)
  console.log('[probe] answer:', chunks.join('').trim().slice(0, 200))
  console.log('[probe] permission requests:', asks.length, asks.length > 0 ? JSON.stringify(asks) : '(none — global allow honored)')
  const askedForUnderTest = asks.length > 0
  console.log(askedForUnderTest ? '[probe] RESULT: permission request fired (command not auto-allowed)' : '[probe] RESULT: no request — command auto-allowed by global rules')
} finally {
  clearTimeout(timeout)
  try { child.stdin.end() } catch { /* gone */ }
  child.kill('SIGTERM')
}
