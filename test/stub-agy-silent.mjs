/**
 * Minimal ACP agent stub for heartbeat probing: hand-rolled JSON-RPC over
 * stdio (no SDK dependency on the child side). Handshake, one session, then
 * the prompt goes SILENT for SILENCE_MS argv[2] (default 131s) — no session
 * updates at all — before streaming one text chunk and ending the turn.
 * Exits when stdin closes (teardown EOF).
 */
import { createInterface } from 'node:readline'

const silenceMs = Number(process.argv[2] ?? 131_000)
const PROTOCOL_VERSION = 1

const reply = (id, result) => write({ jsonrpc: '2.0', id, result })
const replyError = (id, message) => write({ jsonrpc: '2.0', id, error: { code: -32601, message } })
const notify = (method, params) => write({ jsonrpc: '2.0', method, params })
function write(obj) { process.stdout.write(`${JSON.stringify(obj)}\n`) }

const rl = createInterface({ input: process.stdin, terminal: false })
rl.on('line', line => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.id === undefined) return // notification (session/cancel etc.): ignore
  switch (msg.method) {
    case 'initialize':
      reply(msg.id, { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} })
      break
    case 'session/new':
      reply(msg.id, { sessionId: 'stub-silent-1' })
      break
    case 'session/prompt': {
      // The whole point: stay silent (no stream updates) past the heartbeat
      // threshold, then answer normally so the run still settles completed.
      setTimeout(() => {
        notify('session/update', {
          sessionId: 'stub-silent-1',
          update: {
            sessionId: 'stub-silent-1',
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'stub answer after silence' },
          },
        })
        reply(msg.id, { stopReason: 'end_turn' })
        process.exit(0)
      }, silenceMs)
      break
    }
    default:
      replyError(msg.id, `stub does not implement ${msg.method}`)
  }
})
rl.on('close', () => process.exit(0))
