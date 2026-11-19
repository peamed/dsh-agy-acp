/**
 * The command DENY guardrail for Antigravity `run_command` requests that reach
 * this plugin's bridge.
 *
 * Grants are NOT decided here. Per the official permission model
 * (https://antigravity.google/docs/permissions), Antigravity's own engine —
 * `permissions.allow/deny/ask` in ~/.gemini/antigravity-cli/settings.json plus
 * per-project rules managed by `/permissions` — evaluates first, and sandboxed
 * commands run without prompting (`toolPermission: proceed-in-sandbox`). The
 * plugin only sees what those rules leave uncovered, and for commands it defers
 * to the parent session's approval waterfall. What remains plugin-side is the
 * denial that outranks every other decision: a command line that spells out a
 * credentials or system path is refused before any ask.
 */

/**
 * The command line carried by an ACP `run_command` tool call.
 * @param toolCall - the ACP `toolCall` of a permission request, if any.
 * @returns the command line, or `undefined` when this is not a command call.
 */
export function commandLineOf(toolCall) {
  if (toolCall === undefined || toolCall === null) return undefined
  const raw = toolCall.rawInput
  if (raw === undefined || raw === null || typeof raw !== 'object') return undefined
  const line = raw.CommandLine ?? raw.commandLine ?? raw.command
  return typeof line === 'string' ? line : undefined
}

/**
 * Paths a command may never touch, whatever the ask/allow policy says.
 *
 * A denial only knows what the command line spells out, so this is a guard rail
 * rather than a proof: an obfuscated path (`$HOME/.s""sh`, a script that opens
 * the file itself) can still get through. It exists because deferring a command
 * to the human must not also mean offering the credentials directory — deny
 * outranks allow, exactly as the loader composes policies everywhere else.
 */
export const DEFAULT_DENIED_COMMAND_PATHS = Object.freeze([
  '~/.ssh', '~/.aws', '~/.gnupg', '~/.kube', '~/.git-credentials', '~/.npmrc',
  '~/.dsh/.env', '~/.gemini/antigravity-cli/settings.json',
  '/etc/shadow', '/etc/sudoers',
])

/** Escape a literal for use inside a RegExp. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Whether one command line mentions a denied path.
 *
 * Matching is boundary-aware so `src/.ssh-helper.ts` is not mistaken for
 * `~/.ssh`: the marker must end at a separator, not inside a longer name.
 * @param commandLine - the full command line reported by Antigravity.
 * @param denyPaths - configured paths, `~` meaning the invoking user's home.
 * @param home - the home directory used to expand `~`.
 * @returns the denied path that matched, else `undefined`.
 */
export function commandDenied(commandLine, denyPaths = DEFAULT_DENIED_COMMAND_PATHS, home = '') {
  if (typeof commandLine !== 'string' || commandLine.length === 0) return undefined
  for (const entry of denyPaths) {
    if (typeof entry !== 'string' || entry.length === 0) continue
    const trimmed = entry.replace(/\/+$/, '')
    const markers = trimmed.startsWith('~/') && home.length > 0
      ? [trimmed.replace('~', home), trimmed.slice(1)]
      : [trimmed]
    for (const marker of markers) {
      if (marker.length === 0) continue
      if (new RegExp(`${escapeRegExp(marker)}(?![\\w.-])`).test(commandLine)) return entry
    }
  }
  return undefined
}
