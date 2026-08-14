# Play-test input

This guide describes the play-test (PIE) input tools that exist in the repository today.

## What they are for

While OVERDARE Studio runs a play test, these tools let the agent play the game — press keys, click, and
walk the character — instead of asking the user to do it by hand and report back.

## Tools

| Tool | Purpose |
|------|---------|
| `studiorpc_game_pie_status` | Whether a play test runs, its `pieSessionId`, and which clients accept input |
| `studiorpc_game_input_inject` | Play an ordered batch of key / pointer events into the running play test |
| `studiorpc_game_character_move_to` | Walk the character to a world position using its navigation |
| `studiorpc_game_character_move_status` | Outcome of a `move_to` request |

They live in `apps/overdare-ai-agent/sidecar/src/tools/studiorpc/tools/pie-input/` and are registered by the
Studio RPC provider, so they reach the product agent, the TUI, the MCP router, and `overdare-ai-agent:tools`
through the same registry as every other Studio tool.

## Studio contract

The tools call the Studio RPC methods `game.pie.status`, `game.input.inject`, `game.input.releaseAll`,
`game.character.moveTo`, and `game.character.moveStatus`. Studio compiles them into the standalone Sandbox
target only (`WITH_MCP_PIE_INPUT`), so an editor-target Studio answers method-not-found.

Studio enforces, and the tools pre-check:

- keys `W A S D Q E R SpaceBar LeftShift LeftControl`, pointer buttons `left` / `right`
- at most 64 events and 10s of total `wait` per batch
- every key and button pressed down must be released inside the same batch
- `pointerMove` positions are viewport-normalized `0..1`; `mouseDelta` axes are bounded by ±4096 and need a
  captured mouse

## Target resolution

`pieSessionId` and `clientId` are optional. Omitted, the tool reads `game.pie.status` and takes the live
session and its first injectable client, so a single tool call is enough to send input. An explicitly passed
id is checked against that snapshot, which turns a stale id into a message naming the live session instead of
a bare Studio error code.

## Connection scope

Studio scopes held input and a running sequence to the TCP connection that sent them, and `rpc.ts` opens a
connection per call. A batch therefore has to be self-contained — which is also what Studio's validator
demands — and a dropped call releases whatever it held.

Studio releases held input on sequence end, connection close (`MCPService` subscribes `OnConnectionClosed`
to `ReleaseAllForConnection`), PIE end, and observed physical input. `game.input.releaseAll` exists as an RPC
but is deliberately **not** exposed as a tool: it only cancels a sequence owned by the calling connection, and
a fresh per-call connection never owns one. `studiorpc_game_stop` is the escape hatch.

## Waiting

`game.input.inject` answers only once the batch has played out, so the tool raises the RPC timeout by the
batch's own wait time. `studiorpc_game_character_move_to` polls `game.character.moveStatus` until the move
reaches a terminal status (`reached`, `interrupted`, `timedOut`, `superseded`, `cancelled`, `failed`,
`pieEnded`) and reports how long it waited; `wait: false` returns the `requestId` immediately instead.
