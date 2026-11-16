/**
 * Standalone smoke test: drive `agy acp` over the Agent Client Protocol
 * exactly like the plugin does (without DSH). Verifies SDK exports, the
 * initialize → session/new → session/prompt flow, agy's auth state, and that
 * session/update notifications (the "process") actually stream.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import {
  client as createAcpClientApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk'

const command = process.env.AGY ?? 'agy'
const promptText = process.env.SMOKE_PROMPT ?? 'Reply with exactly: OK'

const child = nodeSpawn(command, ['acp'], {
  cwd: process.cwd(),
  stdio: ['pipe', 'pipe', 'inherit'],
})
child.on('error', error => {
  console.error('[smoke] spawn failed:', error.message)
  process.exit(1)
})

let updates = 0
const clientApp = createAcpClientApp({ name: 'dsh-agy-acp-smoke' })
  .onNotification(methods.client.session.update, ({ params }) => {
    updates += 1
    const update = params.update
    if (update.sessionUpdate === 'agent_message_chunk') {
      process.stdout.write(`[update #${updates}] chunk: ${JSON.stringify(update.content?.text ?? '')}\n`)
    } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      process.stdout.write(`[update #${updates}] ${update.sessionUpdate}: ${update.title} (${update.kind ?? '?'}, ${update.status ?? '?'})\n`)
    } else if (update.sessionUpdate === 'plan') {
      process.stdout.write(`[update #${updates}] plan: ${JSON.stringify(update.entries?.map(e => e.content))}\n`)
    } else {
      process.stdout.write(`[update #${updates}] ${update.sessionUpdate}\n`)
    }
    return Promise.resolve()
  })
  .onRequest(methods.client.session.requestPermission, ({ params }) => {
    console.log('[smoke] permission request → denying (smoke default)')
    const deny = params.options?.find(o => o.kind === 'reject_once' || o.kind === 'reject_always')
    if (deny !== undefined) return Promise.resolve({ outcome: { outcome: 'selected', optionId: deny.optionId } })
    return Promise.resolve({ outcome: { outcome: 'cancelled' } })
  })

const connection = clientApp.connect(ndJsonStream(
  Writable.toWeb(child.stdin),
  Readable.toWeb(child.stdout),
))
const agent = connection.agent

const timeout = setTimeout(() => {
  console.error('[smoke] TIMEOUT after 150s')
  child.kill('SIGKILL')
  process.exit(2)
}, 150_000)

try {
  const init = await agent.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
  })
  console.log('[smoke] initialize ok; agent protocol:', JSON.stringify(init.protocolVersion))

  const session = await agent.request(methods.agent.session.new, {
    cwd: process.cwd(),
    mcpServers: [],
  })
  console.log('[smoke] session/new ok:', session.sessionId)

  const response = await agent.request(methods.agent.session.prompt, {
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: promptText }],
  })
  console.log(`[smoke] prompt done; stopReason = ${response.stopReason}; received ${updates} session/update notifications`)
  console.log('[smoke] SUCCESS')
} catch (error) {
  console.error('[smoke] FAILED:', error?.message ?? error)
  process.exitCode = 3
} finally {
  clearTimeout(timeout)
  try { child.stdin.end() } catch {}
  setTimeout(() => { try { child.kill('SIGKILL') } catch {} ; process.exit(process.exitCode ?? 0) }, 3000).unref?.()
}
