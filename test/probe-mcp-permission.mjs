/**
 * MCP permission probe: what does agy put on the wire when it asks permission
 * for an MCP tool call? Prints the complete request so the plugin can classify
 * MCP calls precisely (title? `name`? rawInput?) instead of treating every
 * `execute` request as a shell command.
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

const cwd = mkdtempSync(join(tmpdir(), 'agy-mcp-probe-'))
console.log('[probe] cwd:', cwd)

const child = nodeSpawn('agy', ['acp', '--sandbox'], { cwd, stdio: ['pipe', 'pipe', 'inherit'] })
child.on('error', error => { console.error('[probe] spawn failed:', error.message); process.exit(1) })

const seen = []
const clientApp = createAcpClientApp({ name: 'dsh-agy-acp-mcp-probe' })
  .onNotification(methods.client.session.update, ({ params }) => {
    const u = params.update
    if (u.sessionUpdate === 'tool_call') {
      console.log('[tool_call] title=%j kind=%j name=%j rawInput=%j',
        u.title, u.kind, u.name, u.rawInput === undefined ? '(none)' : u.rawInput)
    }
    return Promise.resolve()
  })
  .onRequest(methods.client.session.requestPermission, ({ params }) => {
    seen.push(params)
    console.log('\n[PERMISSION REQUEST #%d]', seen.length)
    console.log(JSON.stringify(params, null, 2).slice(0, 2500))
    const allow = (params.options ?? []).find(o => o.kind === 'allow_once' || o.kind === 'allow_always')
    return Promise.resolve(allow !== undefined
      ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
      : { outcome: { outcome: 'cancelled' } })
  })

const connection = clientApp.connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)))
const agent = connection.agent
const timeout = setTimeout(() => { console.error('[probe] TIMEOUT'); child.kill('SIGKILL'); process.exit(2) }, 160_000)

try {
  await agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
  const session = await agent.request(methods.agent.session.new, { cwd, mcpServers: [] })
  const response = await agent.request(methods.agent.session.prompt, {
    sessionId: session.sessionId,
    prompt: [{
      type: 'text',
      text: 'Use the chrome MCP tool list_pages once to list open browser pages, then reply OK. Do not use any other tool.',
    }],
  })
  console.log('[probe] stopReason:', response.stopReason, '| permission requests:', seen.length)
} catch (error) {
  console.error('[probe] failed:', error?.message ?? error)
} finally {
  clearTimeout(timeout)
  try { child.stdin.end() } catch {}
  setTimeout(() => { child.kill('SIGKILL'); process.exit(0) }, 3_000)
}