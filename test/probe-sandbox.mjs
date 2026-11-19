/**
 * Sandbox probe: spawn `agy acp --sandbox` and ask it to (1) write inside the
 * workspace, (2) write outside it, (3) run a command. Observe what is blocked
 * and whether permission requests appear.
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

const cwd = mkdtempSync(join(tmpdir(), 'agy-sandbox-probe-'))
console.log('[probe] cwd:', cwd)

const child = nodeSpawn('agy', ['acp', '--sandbox'], { cwd, stdio: ['pipe', 'pipe', 'inherit'] })
child.on('error', e => { console.error('[probe] spawn failed:', e.message); process.exit(1) })

const clientApp = createAcpClientApp({ name: 'dsh-agy-acp-probe' })
  .onNotification(methods.client.session.update, ({ params }) => {
    const u = params.update
    if (u.sessionUpdate === 'agent_message_chunk') process.stdout.write(`[chunk] ${JSON.stringify(u.content?.text ?? '')}\n`)
    else if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') console.log(`[update] ${u.sessionUpdate}: ${u.title} (${u.kind ?? '?'}, ${u.status ?? '?'})`)
    else console.log(`[update] ${u.sessionUpdate}`)
    return Promise.resolve()
  })
  .onRequest(methods.client.session.requestPermission, ({ params }) => {
    console.log(`[probe] >>> PERMISSION REQUEST: ${params.toolCall?.title} (kind: ${params.toolCall?.kind}) options: ${JSON.stringify(params.options?.map(o => o.kind))}`)
    const allow = (params.options ?? []).find(o => o.kind === 'allow_once' || o.kind === 'allow_always')
    if (allow) return Promise.resolve({ outcome: { outcome: 'selected', optionId: allow.optionId } })
    return Promise.resolve({ outcome: { outcome: 'cancelled' } })
  })

const connection = clientApp.connect(ndJsonStream(
  Writable.toWeb(child.stdin),
  Readable.toWeb(child.stdout),
))
const agent = connection.agent

const timeout = setTimeout(() => { console.error('[probe] TIMEOUT'); child.kill('SIGKILL'); process.exit(2) }, 150_000)

try {
  await agent.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
  })
  const session = await agent.request(methods.agent.session.new, { cwd, mcpServers: [] })
  const response = await agent.request(methods.agent.session.prompt, {
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: '依次做三件事并逐条报告结果：1) 在当前目录创建 in-project.txt 内容 OK；2) 尝试在 /tmp/agy-sandbox-escape-test.txt 写入 ESCAPE（这个路径在项目外）；3) 运行命令 echo sandbox-check。如实报告每步成功或被拒绝。' }],
  })
  console.log(`[probe] prompt done; stopReason=${response.stopReason}`)
} catch (error) {
  console.error('[probe] FAILED:', error?.message ?? error)
} finally {
  clearTimeout(timeout)
  try { child.stdin.end() } catch {}
  setTimeout(() => { try { child.kill('SIGKILL') } catch {}; process.exit(0) }, 3000).unref?.()
}
