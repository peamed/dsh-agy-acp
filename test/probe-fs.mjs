/**
 * Capability probe: advertise fs + terminal client capabilities to `agy acp`
 * and watch which channel agy uses for a file-write task.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import {
  client as createAcpClientApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk'

const cwd = mkdtempSync(join(tmpdir(), 'agy-fs-probe-'))
console.log('[probe] cwd:', cwd)

const child = nodeSpawn('agy', ['acp'], { cwd, stdio: ['pipe', 'pipe', 'ignore'] })
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
    console.log('[probe] >>> session/request_permission:', params.toolCall?.title ?? params.toolCall?.kind, 'options:', JSON.stringify(params.options?.map(o => o.kind)))
    const allow = (params.options ?? []).find(o => o.kind === 'allow_once' || o.kind === 'allow_always')
    if (allow) return Promise.resolve({ outcome: { outcome: 'selected', optionId: allow.optionId } })
    return Promise.resolve({ outcome: { outcome: 'cancelled' } })
  })
  .onRequest(methods.client.fs.readTextFile, ({ params }) => {
    console.log('[probe] >>> CLIENT fs/read_text_file:', params.path, `(reason: ${params.reason ?? '-'})`)
    try {
      const content = readFileSync(params.path, 'utf8')
      return Promise.resolve({ content })
    } catch (error) {
      return Promise.resolve({ error: { message: String(error) } })
    }
  })
  .onRequest(methods.client.fs.writeTextFile, ({ params }) => {
    console.log('[probe] >>> CLIENT fs/write_text_file:', params.path, `${params.content?.length ?? 0} chars`)
    try {
      writeFileSync(params.path, params.content ?? '', 'utf8')
      return Promise.resolve({})
    } catch (error) {
      return Promise.resolve({ error: { message: String(error) } })
    }
  })
  .onRequest(methods.client.terminal.create, ({ params }) => {
    console.log('[probe] >>> CLIENT terminal/create:', JSON.stringify(params))
    return Promise.resolve({ error: { message: 'probe: terminal not implemented' } })
  })

const connection = clientApp.connect(ndJsonStream(
  Writable.toWeb(child.stdin),
  Readable.toWeb(child.stdout),
))
const agent = connection.agent

const timeout = setTimeout(() => { console.error('[probe] TIMEOUT'); child.kill('SIGKILL'); process.exit(2) }, 120_000)

try {
  await agent.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
  })
  console.log('[probe] initialized with fs+terminal capabilities advertised')
  const session = await agent.request(methods.agent.session.new, { cwd, mcpServers: [] })
  const response = await agent.request(methods.agent.session.prompt, {
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: '创建文件 hello.txt，内容为一行：HI-VIA-CLIENT。然后只回复：DONE' }],
  })
  console.log(`[probe] prompt done; stopReason=${response.stopReason}`)
  const { existsSync, readFileSync } = await import('node:fs')
  const made = join(cwd, 'hello.txt')
  console.log('[probe] hello.txt exists:', existsSync(made), existsSync(made) ? `content=${JSON.stringify(readFileSync(made, 'utf8'))}` : '')
} catch (error) {
  console.error('[probe] FAILED:', error?.message ?? error)
} finally {
  clearTimeout(timeout)
  try { child.stdin.end() } catch {}
  setTimeout(() => { try { child.kill('SIGKILL') } catch {}; process.exit(0) }, 3000).unref?.()
}
