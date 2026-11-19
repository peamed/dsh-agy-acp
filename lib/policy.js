/**
 * The ask-policy decision tables for one Antigravity permission request.
 *
 * Two independent axes decide:
 *
 * - **MCP tool calls** (`call_mcp_tool`, surfaced as `kind: execute`) are not
 *   file effects and are not shell commands: they invoke a configured MCP
 *   server. They follow the plugin's own `mcpTools` policy, so a deployment can
 *   keep them on (`allow`), route them to the human (`ask`), or refuse them
 *   (`deny`) without touching agy's own settings.
 * - **Everything else** follows the PARENT Session's DSH sandbox mode exactly
 *   as it would decide for the parent's own file tools: `workspace-write` and
 *   `danger-full-access` grant the file effect, `read-only` denies it. Command
 *   execution always defers to the human approval bridge, because a command is
 *   not path-bounded and the plugin cannot verify what it will touch. An
 *   unresolvable mode also defers: a missing service must never become a silent
 *   grant.
 *
 * @param kind - the ACP tool kind (`read`, `edit`, `delete`, `move`,
 *   `execute`, …); every kind but `execute` is treated as a file effect.
 * @param mode - the resolved sandbox mode, or `undefined` when the composition
 *   exposes no `sandboxPolicy` service.
 * @param mcpPolicy - the plugin's `mcpTools` policy when the request is an MCP
 *   tool call, else `undefined`; it outranks the kind and mode axes.
 * @returns how the request is settled: `allow` or `deny` by policy, else `ask`.
 */
export function askDisposition(kind, mode, mcpPolicy) {
  if (mcpPolicy !== undefined) {
    if (mcpPolicy === 'allow') return 'allow'
    if (mcpPolicy === 'deny') return 'deny'
    return 'ask'
  }
  if (kind === 'execute') return 'ask'
  if (mode === undefined) return 'ask'
  return mode === 'read-only' ? 'deny' : 'allow'
}

/**
 * Whether one ACP tool call is an MCP server tool invocation.
 *
 * agy reports it as its built-in `call_mcp_tool` with the server and tool in
 * `rawInput`, and titles it `MCP Tool <name>`. Matching on either keeps older
 * builds (title only) and newer ones (programmatic name) classified the same.
 *
 * @param toolCall - the ACP `toolCall` of a permission request, if any.
 * @returns whether the call invokes an MCP server tool.
 */
export function isMcpCall(toolCall) {
  if (toolCall === undefined || toolCall === null) return false
  if (toolCall.name === 'call_mcp_tool') return true
  return typeof toolCall.title === 'string' && toolCall.title.startsWith('MCP Tool ')
}