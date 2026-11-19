import assert from 'node:assert/strict'
import { askDisposition, isMcpCall } from '../lib/policy.js'

// File effects follow the parent Session's DSH sandbox mode.
assert.equal(askDisposition('edit', 'workspace-write'), 'allow')
assert.equal(askDisposition('edit', 'danger-full-access'), 'allow')
assert.equal(askDisposition('delete', 'workspace-write'), 'allow')
assert.equal(askDisposition('move', 'workspace-write'), 'allow')

// read-only denies every file effect, including a bare metadata kind.
assert.equal(askDisposition('edit', 'read-only'), 'deny')
assert.equal(askDisposition('other', 'read-only'), 'deny')

// Shell commands are not path-bounded: always the human bridge, in every mode.
assert.equal(askDisposition('execute', 'workspace-write'), 'ask')
assert.equal(askDisposition('execute', 'danger-full-access'), 'ask')
assert.equal(askDisposition('execute', 'read-only'), 'ask')

// An unresolvable mode falls back to asking; it never becomes a silent grant.
assert.equal(askDisposition('edit', undefined), 'ask')
assert.equal(askDisposition('execute', undefined), 'ask')

// MCP tool calls outrank the kind/mode axes and follow the plugin policy.
assert.equal(askDisposition('execute', 'workspace-write', 'allow'), 'allow')
assert.equal(askDisposition('execute', 'read-only', 'allow'), 'allow')
assert.equal(askDisposition('execute', 'workspace-write', 'ask'), 'ask')
assert.equal(askDisposition('execute', 'workspace-write', 'deny'), 'deny')
assert.equal(askDisposition('edit', undefined, 'deny'), 'deny')

// MCP classification: programmatic name (agy) or title prefix (older builds).
assert.equal(isMcpCall({ name: 'call_mcp_tool', title: 'MCP Tool list_pages', kind: 'execute' }), true)
assert.equal(isMcpCall({ title: 'MCP Tool navigate', kind: 'execute' }), true)
assert.equal(isMcpCall({ name: 'run_command', title: 'ls -la', kind: 'execute' }), false)
assert.equal(isMcpCall({ name: 'read_file', title: 'File a.txt', kind: 'read' }), false)
assert.equal(isMcpCall(undefined), false)
assert.equal(isMcpCall(null), false)

console.log('policy: all 21 cases pass')