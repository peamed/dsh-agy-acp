/**
 * Capture what `agy acp` advertises for session configuration: the initialize
 * response, the session/new result, and every session/update that carries
 * config options or model state. Answers "does the server expose model and
 * thinking level, and through which field".
 */
import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { client as createClient, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'

const child = spawn('agy', ['acp'], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'inherit'] })
const updates = []
const app = createClient({ name: 'probe-config' })
  .onNotification(methods.client.session.update, ({ params }) => {
    const u = params.update
    updates.push(u)
    return Promise.resolve()
  })
  .onRequest(methods.client.session.requestPermission, () => Promise.resolve({ outcome: { outcome: 'cancelled' } }))

const agent = app.connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))).agent
const init = await agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
console.log('=== initialize._meta ===')
console.log(JSON.stringify(init._meta ?? null, null, 2).slice(0, 2000))
console.log('=== agentCapabilities keys ===', Object.keys(init.agentCapabilities ?? {}))

const session = await agent.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] })
console.log('=== session/new keys ===', Object.keys(session))
console.log(JSON.stringify(session, null, 2).slice(0, 4000))

// Give the server a moment to push its initial updates (config options, commands).
await new Promise(r => setTimeout(r, 3000))
console.log('=== update kinds seen ===', [...new Set(updates.map(u => u.sessionUpdate))])
for (const u of updates) {
  if (u.sessionUpdate === 'available_commands_update' || u.sessionUpdate === 'usage_update') continue
  console.log('---', u.sessionUpdate, JSON.stringify(u).slice(0, 2500))
}
child.kill('SIGKILL')
process.exit(0)
