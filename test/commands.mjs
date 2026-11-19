/**
 * Deny-guardrail tests for lib/commands.js. Command GRANTS live in
 * Antigravity's own permission engine now; the plugin only answers whether a
 * command line spells out a denied path, and only for requests that reach the
 * bridge.
 */
import assert from 'node:assert/strict'
import { DEFAULT_DENIED_COMMAND_PATHS, commandDenied, commandLineOf } from '../lib/commands.js'

const HOME = '/home/u'

// ── commandLineOf ────────────────────────────────────────────────────────────
assert.equal(commandLineOf(undefined), undefined)
assert.equal(commandLineOf(null), undefined)
assert.equal(commandLineOf({}), undefined)
assert.equal(commandLineOf({ rawInput: { CommandLine: 'cat a' } }), 'cat a')
assert.equal(commandLineOf({ rawInput: { commandLine: 'cat a' } }), 'cat a')
assert.equal(commandLineOf({ rawInput: { command: 'cat a' } }), 'cat a')
assert.equal(commandLineOf({ rawInput: { command: 42 } }), undefined)

// ── commandDenied: default deny list ─────────────────────────────────────────
assert.equal(commandDenied('cat ~/.ssh/id_rsa', undefined, HOME), '~/.ssh')
assert.equal(commandDenied('cat /home/u/.ssh/id_rsa', undefined, HOME), '~/.ssh')
assert.equal(commandDenied('aws --profile x s3 ls', undefined, HOME), undefined) // ~/.aws needs the path
assert.equal(commandDenied('cat ~/.aws/credentials', undefined, HOME), '~/.aws')
assert.equal(commandDenied('gpg --homedir ~/.gnupg x', undefined, HOME), '~/.gnupg')
assert.equal(commandDenied('kubectl --kubeconfig ~/.kube/config', undefined, HOME), '~/.kube')
assert.equal(commandDenied('git clone $(cat ~/.git-credentials)', undefined, HOME), '~/.git-credentials')
assert.equal(commandDenied('npm publish --userconfig ~/.npmrc', undefined, HOME), '~/.npmrc')
assert.equal(commandDenied('cat ~/.dsh/.env', undefined, HOME), '~/.dsh/.env')
assert.equal(commandDenied('cat ~/.gemini/antigravity-cli/settings.json', undefined, HOME), '~/.gemini/antigravity-cli/settings.json')
assert.equal(commandDenied('cat /etc/shadow', undefined, HOME), '/etc/shadow')
assert.equal(commandDenied('sudo cat /etc/sudoers', undefined, HOME), '/etc/sudoers')

// ── commandDenied: boundary awareness ────────────────────────────────────────
// A project file whose name contains a marker is NOT the marker path.
assert.equal(commandDenied('python3 src/.ssh-helper.ts', undefined, HOME), undefined)
assert.equal(commandDenied('ls ~/.sshx', undefined, HOME), undefined)
assert.equal(commandDenied('npm install ssh2', undefined, HOME), undefined)
// A separator must follow the marker: the directory itself matches.
assert.equal(commandDenied('ls ~/.ssh/', undefined, HOME), '~/.ssh')
assert.equal(commandDenied('ls ~/.ssh', undefined, HOME), '~/.ssh')

// ── commandDenied: config semantics ──────────────────────────────────────────
assert.equal(commandDenied('rm x', [], HOME), undefined)
assert.equal(commandDenied('rm /etc/shadow', ['/etc/shadow'], HOME), '/etc/shadow')
assert.equal(commandDenied('cat ~/.ssh/id_rsa', undefined, ''), '~/.ssh') // no HOME: the literal `~` form still matches
assert.equal(commandDenied('', undefined, HOME), undefined)
assert.equal(commandDenied(undefined, undefined, HOME), undefined)

// ── default list shape ───────────────────────────────────────────────────────
assert.ok(DEFAULT_DENIED_COMMAND_PATHS.includes('~/.ssh'))
assert.ok(DEFAULT_DENIED_COMMAND_PATHS.includes('/etc/shadow'))

console.log('commands: deny-guardrail cases pass')
