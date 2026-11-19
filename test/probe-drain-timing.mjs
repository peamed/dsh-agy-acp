/**
 * Timing probe for the injection drain window.
 *
 * The original prompt settles with `end_turn` BEFORE the answer to a folded-in
 * message arrives. This measures how long that late answer keeps streaming, so
 * `sendDrainMs` can be chosen from data instead of a guess.
 *
 * Reports, in ms after the original prompt settled: first late chunk, last late
 * chunk, and the quiet gap that ended the measurement.
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

const ROUNDS = Number(process.env.ROUNDS ?? 2)
const QUIET_MS = 12_000
const HARD_CAP_MS = 150_000

const results = []

async function oneRound(round) {
  const cwd = mkdtempSync(join(tmpdir(), `agy-drain-timing-${round}-`))
  const child = nodeSpawn('agy', ['acp', '--sandbox'], { cwd, stdio: ['pipe', 'pipe', 'inherit'] })

  let text = ''
  let settledAt
  let firstChunkAt
  let lastChunkAt
  let lastActivityAt = Date.now()

  const app = createAcpClientApp({ name: 'dsh-agy-acp-drain-timing' })
    .onNotification(methods.client.session.update, ({ params }) => {
      const u = params.update
      if (u.sessionUpdate === 'agent_message_chunk') {
        text += u.content?.text ?? ''
        const now = Date.now()
        if (settledAt !== undefined && firstChunkAt === undefined) firstChunkAt = now
        if (settledAt !== undefined) lastChunkAt = now
        lastActivityAt = now
      }
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
  const guard = setTimeout(() => { child.kill('SIGKILL'); process.exit(2) }, 240_000)

  try {
    await agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const session = await agent.request(methods.agent.session.new, { cwd, mcpServers: [] })
    const prompt = t => agent.request(methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: t }],
    })

    const task = '当前工作目录是 /home/peam/open-projects/test。逐个读取下面 4 个 Markdown 文件，'
      + '为每个文件写 2 句中文要点：AI漫剧内网创作平台_技术审核意见.md、AI漫剧平台_定价合理性专项审核.md、'
      + '高校AI漫剧内网创作平台建设方案及清单.md、.uefi-ref-README.md。只用 read_file，不要运行命令。'

    const a = prompt(task).then(r => {
      settledAt = Date.now()
      lastActivityAt = settledAt
      console.log(`[round ${round}] A settled (${r.stopReason}) at +${settledAt - startedAt}ms; chunks so far: ${text.length}`)
    })
    const startedAt = Date.now()
    await new Promise(r => setTimeout(r, 6_000))
    void prompt('补充：汇总里额外注明每个文件的行数规模。').catch(() => {})

    await a
    // Watch until the stream has been quiet for QUIET_MS, or the hard cap.
    while (Date.now() - lastActivityAt < QUIET_MS && Date.now() - settledAt < HARD_CAP_MS) {
      await new Promise(r => setTimeout(r, 500))
    }

    const out = {
      round,
      chars: text.length,
      settleToFirstMs: firstChunkAt === undefined ? null : firstChunkAt - settledAt,
      settleToLastMs: lastChunkAt === undefined ? null : lastChunkAt - settledAt,
      quietGapMs: Date.now() - lastActivityAt,
    }
    results.push(out)
    console.log(`[round ${round}]`, JSON.stringify(out))
  } finally {
    clearTimeout(guard)
    try { child.stdin.end() } catch {}
    await new Promise(r => setTimeout(r, 1_000))
    child.kill('SIGKILL')
  }
}

// The agy backend intermittently rejects with a short FAILED_PRECONDITION text
// instead of answering; such a round is not a measurement.
const MIN_REAL_CHARS = 300
let valid = 0
let attempt = 0
while (valid < ROUNDS && attempt < 6) {
  attempt += 1
  const before = results.length
  await oneRound(attempt).catch(error => console.error(`[round ${attempt}] failed:`, error?.message ?? error))
  if (results.length > before && results.at(-1).chars >= MIN_REAL_CHARS) valid += 1
  else if (results.length > before) console.log(`[round ${attempt}] discarded: backend error text (${results.at(-1).chars} chars)`)
}
console.log('[summary]', JSON.stringify(results))
process.exit(0)