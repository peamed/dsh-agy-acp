/**
 * Resume probe: can a SECOND `agy acp` process continue the conversation of a
 * session created by a FIRST process? `session/resume` is the mechanism a
 * follow-up channel would use without keeping the child alive.
 *
 * Run 1 creates a session and stores a passphrase. Run 2 resumes that session
 * id in a fresh process and asks for the passphrase back.
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

const cwd = mkdtempSync(join(tmpdir(), 'agy-resume-probe-'))
console.log('[probe] cwd:', cwd)

/** Spawn one process, hand `run` the agent, always tear the child down. */
async function withAgent(fn) {
  const child = nodeSpawn('agy', ['acp', '--sandbox'], { cwd, stdio: ['pipe', 'pipe', 'inherit'] })
  let text = ''
  const app = createAcpClientApp({ name: 'dsh-agy-acp-resume-probe' })
    .onNotification(methods.client.session.update, ({ params }) => {
      const u = params.update
      if (u.sessionUpdate === 'agent_message_chunk') text += u.content?.text ?? ''
      return Promise.resolve()
    })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      const allow = (params.options ?? []).find(o => o.kind === 'allow_once' || o.kind === 'allow_always')
      return Promise.resolve(allow !== undefined
        ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
        : { outcome: { outcome: 'cancelled' } })
    })
  const connection = app.connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)))
  try {
    await connection.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    return await fn(connection.agent, () => text)
  } finally {
    try { child.stdin.end() } catch {}
    setTimeout(() => child.kill('SIGKILL'), 1_500)
  }
}

const timeout = setTimeout(() => { console.error('[probe] TIMEOUT'); process.exit(2) }, 220_000)

try {
  // ── Run 1: create the session and store a fact ────────────────────────────
  const sessionId = await withAgent(async (agent, text) => {
    const s = await agent.request(methods.agent.session.new, { cwd, mcpServers: [] })
    await agent.request(methods.agent.session.prompt, {
      sessionId: s.sessionId,
      prompt: [{ type: 'text', text: 'Remember this passphrase: PLUM-42. Reply with exactly ACK.' }],
    })
    console.log('[run1] sessionId:', s.sessionId, '| reply:', JSON.stringify(text().trim()))
    return s.sessionId
  })

  // ── Run 2: resume it in a brand-new process ──────────────────────────────
  await withAgent(async (agent, text) => {
    let resumed = true
    try {
      await agent.request(methods.agent.session.resume, { sessionId, cwd, mcpServers: [] })
    } catch (error) {
      resumed = false
      console.log('[run2] resume failed:', error?.message ?? error)
      console.log('[run2] trying session/load instead')
      await agent.request(methods.agent.session.load, { sessionId, cwd, mcpServers: [] })
    }
    console.log('[run2] attached via', resumed ? 'session/resume' : 'session/load')
    await agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: 'text', text: 'What was the passphrase? Reply with the passphrase alone.' }],
    })
    const answer = text().trim()
    console.log('[run2] answer:', JSON.stringify(answer))
    console.log('[probe] VERDICT:', answer.includes('PLUM-42') ? 'RESUME WORKS (history preserved)' : 'RESUME DID NOT PRESERVE HISTORY')
  })
} catch (error) {
  console.error('[probe] failed:', error?.message ?? error)
} finally {
  clearTimeout(timeout)
  setTimeout(() => process.exit(0), 2_000)
}