/**
 * No-bwrap probe: with tightened agy settings (allowNonWorkspaceAccess false,
 * no always-proceed) + --sandbox, does agy PROMPT for file writes to
 * non-temp outside paths (e.g. /home/peam/...)? Requests are auto-denied.
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

const cwd = mkdtempSync(join(tmpdir(), 'agy-nobwrap-probe-'))
console.log('[probe] cwd:', cwd)

const child = nodeSpawn('agy', ['acp', '--sandbox'], { cwd, stdio: ['pipe', 'pipe', 'inherit'] })
child.on('error', e => { console.error('[probe] spawn failed:', e.message); process.exit(1) })

let permissionRequests = 0
const clientApp = createAcpClientApp({ name: 'dsh-agy-acp-probe' })
  .onNotification(methods.client.session.update, ({ params }) => {
    const u = params.update
    if (u.sessionUpdate === 'agent_message_chunk') process.stdout.write(`[chunk] ${JSON.stringify(u.content?.text ?? '')}\n`)
    else if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') console.log(`[update] ${u.sessionUpdate}: ${u.title} (${u.kind ?? '?'}, ${u.status ?? '?'})`)
    else console.log(`[update] ${u.sessionUpdate}`)
    return Promise.resolve()
  })
  .onRequest(methods.client.session.requestPermission, ({ params }) => {
    permissionRequests += 1
    console.log(`[probe] >>> PERMISSION #${permissionRequests}: ${params.toolCall?.title} (kind: ${params.toolCall?.kind}) locations: ${JSON.stringify(params.toolCall?.locations?.map(l => l?.path) ?? [])} options: ${JSON.stringify(params.options?.map(o => o.kind))}`)
    const deny = (params.options ?? []).find(o => o.kind === 'reject_once' || o.kind === 'reject_always')
    if (deny) return Promise.resolve({ outcome: { outcome: 'selected', optionId: deny.optionId } })
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
    prompt: [{ type: 'text', text: '依次做三件事并逐条如实报告：1) 在当前目录创建 inside.txt 内容 OK；2) 在 /home/peam/agy-outside-probe.txt 写入 OUTSIDE（这个路径在工作区外、非临时目录）；3) 运行命令 echo nobwrap-check。每步被拒绝也要如实报告。' }],
  })
  console.log(`[probe] prompt done; stopReason=${response.stopReason}; total permission requests: ${permissionRequests}`)
} catch (error) {
  console.error('[probe] FAILED:', error?.message ?? error)
} finally {
  clearTimeout(timeout)
  try { child.stdin.end() } catch {}
  setTimeout(() => { try { child.kill('SIGKILL') } catch {}; process.exit(0) }, 3000).unref?.()
}
