/**
 * Does an injected message cost the run its final answer?
 *
 * Runs the same kind of task the plugin ran (read four docs, summarize), then
 * injects a follow-up mid-run. Unlike the plugin, this probe keeps the child
 * alive after the original prompt resolves, so an answer arriving later is
 * visible. That separates agy's own behaviour from the plugin's teardown.
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

const workdir = '/home/peam/open-projects/test'
const cwd = mkdtempSync(join(tmpdir(), 'agy-inflight2-probe-'))
console.log('[probe] cwd:', cwd, '| reads from:', workdir)

const child = nodeSpawn('agy', ['acp', '--sandbox'], { cwd, stdio: ['pipe', 'pipe', 'inherit'] })
child.on('error', error => { console.error('[probe] spawn failed:', error.message); process.exit(1) })

let text = ''
const app = createAcpClientApp({ name: 'dsh-agy-acp-inflight2-probe' })
  .onNotification(methods.client.session.update, ({ params }) => {
    const u = params.update
    if (u.sessionUpdate === 'agent_message_chunk') text += u.content?.text ?? ''
    else if (u.sessionUpdate === 'tool_call') console.log('[tool]', u.title)
    return Promise.resolve()
  })
  .onRequest(methods.client.session.requestPermission, ({ params }) => {
    const allow = (params.options ?? []).find(o => o.kind === 'allow_once' || o.kind === 'allow_always')
    return Promise.resolve(allow !== undefined
      ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
      : { outcome: { outcome: 'cancelled' } })
  })

const connection = app.connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)))
const agent = connection.agent
const guard = setTimeout(() => { console.error('[probe] TIMEOUT'); child.kill('SIGKILL'); process.exit(2) }, 220_000)

try {
  await agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
  const session = await agent.request(methods.agent.session.new, { cwd, mcpServers: [] })
  const sessionId = session.sessionId
  console.log('[probe] sessionId:', sessionId)

  const prompt = t => agent.request(methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: 'text', text: t }],
  })

  const task = '当前工作目录是 /home/peam/open-projects/test。逐个读取下面 4 个 Markdown 文件，'
    + '为每个文件写 2 句中文要点：AI漫剧内网创作平台_技术审核意见.md、AI漫剧平台_定价合理性专项审核.md、'
    + '高校AI漫剧内网创作平台建设方案及清单.md、.uefi-ref-README.md。只用 read_file，不要运行命令。'

  // Prompt A, with an injection 6 seconds in.
  const a = prompt(task).then(
    r => console.log('[probe] A settled:', r.stopReason, '| chars so far:', text.length),
    e => console.log('[probe] A failed:', e?.message ?? String(e)),
  )
  await new Promise(r => setTimeout(r, 6_000))

  console.log('[probe] injecting follow-up mid-run')
  const b = prompt('补充：汇总里额外注明每个文件的行数规模。').then(
    r => console.log('[probe] B settled:', r.stopReason),
    e => console.log('[probe] B failed:', e?.message ?? String(e)),
  )

  await a
  // Keep the child alive and watch for a late answer instead of tearing down.
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 5_000))
    if (text.length > 0) break
  }
  console.log('[probe] A text:', JSON.stringify(text.trim().slice(0, 700)))
  console.log('[probe] total chars:', text.length)
  console.log('[probe] VERDICT:', text.length > 0 ? 'ANSWER SURVIVED INJECTION' : 'NO ANSWER TEXT AT ALL')
} catch (error) {
  console.error('[probe] failed:', error?.message ?? error)
} finally {
  clearTimeout(guard)
  try { child.stdin.end() } catch {}
  setTimeout(() => { child.kill('SIGKILL'); process.exit(0) }, 2_000)
}