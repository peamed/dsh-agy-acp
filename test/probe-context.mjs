/**
 * Context probe: does `agy acp` receive a project rule file (AGENTS.md) from
 * the client, or discover it on its own?
 *
 * Creates a throwaway workspace whose only content is an AGENTS.md carrying a
 * unique marker, then asks about it. Three distinguishable outcomes:
 *   - the marker comes back with NO file tool call  -> context was INJECTED
 *   - the marker comes back after a read_file call  -> self-DISCOVERED
 *   - the marker never appears                      -> NOT provided at all
 * The initialize response is printed so the agent's advertised session
 * capabilities (e.g. `session.systemPrompt`) are visible.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import {
  client as createAcpClientApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk'

const MARKER = 'ZEBRA-731'
const cwd = mkdtempSync(join(tmpdir(), 'agy-context-probe-'))
writeFileSync(join(cwd, 'AGENTS.md'), [
  '# Project rules',
  '',
  'PROJECT RULE MARKER: ' + MARKER,
  'When asked about the project rule, reply with the marker alone.',
  '',
].join('\n'))
console.log('[probe] workspace:', cwd)

const child = nodeSpawn('agy', ['acp', '--sandbox'], { cwd, stdio: ['pipe', 'pipe', 'inherit'] })
child.on('error', error => { console.error('[probe] spawn failed:', error.message); process.exit(1) })

let answer = ''
const toolCalls = []
const clientApp = createAcpClientApp({ name: 'dsh-agy-acp-context-probe' })
  .onNotification(methods.client.session.update, ({ params }) => {
    const update = params.update
    if (update.sessionUpdate === 'agent_message_chunk') answer += update.content?.text ?? ''
    else if (update.sessionUpdate === 'tool_call') {
      toolCalls.push(update.title)
      console.log('[tool]', update.title, `(${update.kind ?? '?'})`)
    } else if (update.sessionUpdate === 'tool_call_update' && update.status === 'completed') {
      console.log('[tool:done]', update.title)
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

const connection = clientApp.connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)))
const agent = connection.agent
const timeout = setTimeout(() => {
  console.error('[probe] TIMEOUT')
  child.kill('SIGKILL')
  process.exit(2)
}, 150_000)

try {
  const init = await agent.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
  })
  console.log('[probe] agentCapabilities:', JSON.stringify(init.agentCapabilities ?? {}))
  console.log('[probe] authMethods:', JSON.stringify((init.authMethods ?? []).map(m => m.id)))

  const session = await agent.request(methods.agent.session.new, { cwd, mcpServers: [] })
  console.log('[probe] sessionId:', session.sessionId)

  const response = await agent.request(methods.agent.session.prompt, {
    sessionId: session.sessionId,
    prompt: [{
      type: 'text',
      text: 'This project has a rule file. What is the exact project rule marker? '
        + 'Reply with the marker alone if you already have it, otherwise read the rule file first.',
    }],
  })
  console.log('[probe] stopReason:', response.stopReason)
  console.log('[probe] tools used:', JSON.stringify(toolCalls))
  console.log('[probe] answer:', JSON.stringify(answer.trim()))
  const verdict = answer.includes(MARKER)
    ? toolCalls.some(t => /AGENTS\.md|read/i.test(String(t)))
      ? 'DISCOVERED (agent read the rule file itself)'
      : 'INJECTED (marker known without reading the file)'
    : 'NOT PROVIDED'
  console.log('[probe] VERDICT:', verdict)
} catch (error) {
  console.error('[probe] failed:', error?.message ?? error)
} finally {
  clearTimeout(timeout)
  try { child.stdin.end() } catch {}
  setTimeout(() => { child.kill('SIGKILL'); process.exit(0) }, 3_000)
}