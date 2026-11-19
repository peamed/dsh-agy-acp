/**
 * One-command test entry for dsh-agy-acp.
 *
 * Three tiers, because the files under test/ are not alike:
 *
 *   unit  — pure functions and stub-driven settlement logic. Fast, offline,
 *           deterministic; every one must pass before anything ships.
 *   e2e   — drives the REAL plugin against the REAL `agy` binary. Needs a
 *           signed-in account and network, takes minutes, and a 503 from the
 *           model backend can appear (the probes tolerate it). These are the
 *           only checks that can catch a broken tool schema or a non-lossless
 *           tool result, both of which unit tests cannot see.
 *   probes — one-off investigations (which model a command runs on, whether a
 *           rule file is injected, sandbox behaviour). They encode a question
 *           that has already been answered, so they are listed, never run by
 *           default.
 *
 * Usage:
 *   node test/all.mjs             unit only
 *   node test/all.mjs --e2e       unit + end-to-end (real agy)
 *   node test/all.mjs --list      show every tier and exit
 *   node test/all.mjs --only=backend,session-config
 */
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** Fast, offline, deterministic: pure units and stub-driven settlement cases. */
const UNIT = [
  'backend.mjs',
  'commands.mjs',
  'drain.mjs',
  'policy.mjs',
  'report.mjs',
  'session-config.mjs',
  // Stub-driven, no network: settlement semantics across all answer shapes.
  'probe-failure-modes.mjs',
]

/**
 * Real `agy` runs. `timeoutMs` bounds each file so a hung child cannot stall
 * the suite; the e2e probes are slower than anything in the unit tier.
 */
const E2E = [
  { file: 'probe-config-e2e.mjs', timeoutMs: 900_000 },
  { file: 'probe-retry-e2e.mjs', timeoutMs: 900_000 },
]

/**
 * One-off investigations: already answered, kept for reference. Listed so they
 * stay discoverable, never executed by this runner.
 */
const PROBES = [
  'probe-cmd-allow.mjs',
  'probe-config-options.mjs',
  'probe-context.mjs',
  'probe-drain-timing.mjs',
  'probe-fs.mjs',
  'probe-heartbeat.mjs',
  'probe-inflight-answer.mjs',
  'probe-inflight.mjs',
  'probe-mcp-permission.mjs',
  'probe-nobwrap.mjs',
  'probe-resume.mjs',
  'probe-sandbox.mjs',
  'probe-settings.mjs',
  'smoke.mjs',
  'stub-agy-silent.mjs',
  'task-prefix.mjs',
]

const argv = new Set(process.argv.slice(2))
const only = process.argv.slice(2).find(arg => arg.startsWith('--only='))?.slice('--only='.length)

if (argv.has('--list')) {
  console.log('unit  (always run):', UNIT.join(', '))
  console.log('e2e   (--e2e)     :', E2E.map(e => `${e.file} (≤${e.timeoutMs / 1000}s)`).join(', '))
  console.log('probes (never run):', PROBES.join(', '))
  process.exit(0)
}

/**
 * Run one test file to completion.
 * @param file - a file under test/.
 * @param timeoutMs - how long to wait before the child is killed.
 * @returns `{ ok, ms, output }`.
 */
function runOne(file, timeoutMs) {
  return new Promise(resolve => {
    const started = Date.now()
    const child = spawn(process.execPath, [join(here, file)], {
      cwd: join(here, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let settled = false
    const finish = (ok, note) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok, ms: Date.now() - started, output: note === undefined ? output : `${output}\n${note}` })
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(false, `\n[timeout] killed after ${timeoutMs}ms`)
    }, timeoutMs)
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('error', error => finish(false, `\n[spawn error] ${error.message}`))
    child.on('close', code => finish(code === 0, code === 0 ? undefined : `\n[exit ${code}]`))
  })
}

/** Print the last meaningful line of a test's output. */
function summaryLine(output) {
  const lines = output.split('\n').map(line => line.trim()).filter(Boolean)
  // Stubs write goroutine noise to stderr; the assertion line comes last.
  const useful = lines.filter(line => !/^[IEW]\d{4} /.test(line))
  return (useful.at(-1) ?? '(no output)').slice(0, 160)
}

const suites = [{ title: 'unit', files: UNIT.map(file => ({ file, timeoutMs: 120_000 })) }]
if (argv.has('--e2e')) suites.push({ title: 'e2e (real agy)', files: E2E })

if (only !== undefined) {
  const wanted = new Set(only.split(',').map(name => name.trim()))
  for (const suite of suites) suite.files = suite.files.filter(entry => wanted.has(entry.file.replace(/\.mjs$/, '')))
}

const failures = []
for (const suite of suites) {
  if (suite.files.length === 0) continue
  console.log(`\n=== ${suite.title} ===`)
  for (const entry of suite.files) {
    process.stdout.write(`  ${entry.file} … `)
    const result = await runOne(entry.file, entry.timeoutMs)
    const seconds = (result.ms / 1000).toFixed(1)
    if (result.ok) {
      console.log(`ok (${seconds}s) — ${summaryLine(result.output)}`)
    } else {
      console.log(`FAIL (${seconds}s)`)
      console.log(result.output.split('\n').slice(-25).map(line => `      ${line}`).join('\n'))
      failures.push(entry.file)
    }
  }
}

if (failures.length === 0) {
  console.log(`\nall suites passed${argv.has('--e2e') ? '' : ' (unit only; add --e2e for real agy)'}`)
  process.exit(0)
}
console.log(`\n${failures.length} failed: ${failures.join(', ')}`)
process.exit(1)
