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
| `studiorpc_game_ui_browse` | List the UI on screen with the rectangle each element occupies |
| `studiorpc_viewport_camera_read` | Where the camera on screen is, how much it covers, and what it is aimed at |

They live in `apps/overdare-ai-agent/sidecar/src/tools/studiorpc/tools/pie-input/` and `…/methods/`, and are
registered by the Studio RPC provider, so they reach the product agent, the TUI, the MCP router, and
`overdare-ai-agent:tools` through the same registry as every other Studio tool.

## Aiming without measuring a picture

`game.ui.browse` and `game.screenshot` report positions in the same viewport-normalized `0..1` space that
`pointerMove` consumes, so clicking a button is: browse, take the centre of its `rect`, move, press. Nothing
is read off an image, which matters because screenshots are resized on the way to the model — a normalized
rectangle survives that, an absolute pixel does not.

`rect` is computed from the element's authored `UDim2` against its parent's rectangle rather than read from
`AbsolutePosition`. Measured positions only exist for widgets Slate actually laid out: a hidden element keeps
a stale one and an off-screen element reports `0, 0`, which would put an off-screen button in the top-left
corner and send a click somewhere harmless-looking and wrong. The computed rect is right in both cases. The
exception is elements a `UIListLayout` or `UIGridLayout` positions, whose authored position the layout
overrides.

Check `onScreen` before clicking. It folds together the element's own `visible`, every ancestor's `visible`,
and whether the rect actually intersects the viewport — so `visible: true` with `onScreen: false` is a real
combination, meaning the element is switched on but its parent is off or it sits past the edge.

`includeGui` captures the UI the player is actually looking at. It used to capture the authored one:
`MLuaGUICaptureHelper` kept only ScreenGuis rooted at `StarterGui`, so the `PlayerGui` clone the game runs on
was skipped — UI a script built at runtime never appeared and a retitled label still showed its authored
text, while everything the scripts had not touched matched, which is what made it easy to miss. It now
captures the play test's own world and composites `PlayerGui` / `CoreGui`, falling back to `StarterGui` only
in the editor, where that *is* the screen being authored. Those roots are already laid out at the game
viewport's scale, so the capture renders them at that scale rather than the editor viewport's DPI — drawing
them at the wrong scale left the boxes right (they are relative) and the text, sized in pixels, spilling out
of them.

`viewport.camera.read` answers the questions a picture cannot. A perspective viewport keeps its field of view
fixed and zooms by moving the camera, so `focusDistance` — how far the screen centre is from the camera — is
the real zoom indicator, not `fieldOfView`; `orthoWidth` is filled in only for an orthographic viewport, where
it is the true magnification. `visibleExtentAtFocus` converts that into world units
(`width = 2 · d · tan(fov/2)`, `height = width / aspect`, 1 unit = 1 cm). `centerHit` names what is under the
crosshair. `source` says whether that camera is the editor viewport or the running play test — during a play
test the player camera is what fills the screen, and `game.screenshot` reports the same block for the shot it
just took, so the two never describe different moments.

`game.screenshot` also accepts `cameraPosition` + `lookAt` to aim one shot; the editor viewport returns to
where the user left it as soon as the capture ends, on every path including failure. It is rejected during a
play test, because moving the editor viewport would not change what the capture shows.

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
- `scroll` takes ±10 wheel notches at the current pointer position
- `textInput` takes up to 256 printable characters and goes to whatever holds keyboard focus, so Studio
  refuses it with `viewportNotFocused` rather than typing into one of its own panels. Note that the OVERDARE
  Lua API has no `TextBox`, so nothing scriptable receives characters yet — this exists for when one lands

`action: "press"` (with an optional `durationMs`) is a sidecar shorthand: Studio has no press action, so the
tool expands it to `down` / `wait` / `up` before sending. It is the shape to reach for — one authored event
instead of three, and no way to leave a key held past the end of the batch. Because the limits apply to what
actually reaches Studio, the 64-event cap is checked *after* expansion.

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

## Arriving is not touching

`move_to` reports `arrived` by measuring where the character actually stopped, because Studio returns
`reached` whenever path following succeeds — which a level with no navigation data does without the character
having moved at all. `arrived` is judged against `arrivalTolerance`, 150 units unless the caller says
otherwise, and the value used is echoed in the reply.

The default suits travel and is far too loose for contact. A trigger volume is often 40 units across, so a
move can be `arrived: true` and still nowhere near enough to touch anything, and an agent testing "does
walking into this coin collect it" gets a pass from a call that proves nothing. Pass an `arrivalTolerance`
about the size of the target when arrival is the thing under test.

Even a real overlap is not proof a trigger fired. `game.character.read`'s `standingOn` is a probe straight
down — `distance: 0` means resting on that surface, never that its `Touched` event ran. Only the game's own
state answers that.

## One name for one thing

Every tool that reports a GUID calls it `instanceGuid`; `instance.read` takes it as `guid`. An agent that
copied one into the other used to get a bare zod `invalid_type` naming a field it had never heard of, and had
to work out that two similarly-named tools take different identifiers. Both ends are now tolerant:
`instance.read` accepts `instanceGuid`, and `game.instance.read` accepts either `name` or `instanceGuid`.
Instances a script creates at run time have no GUID at all, so those are findable only by name — which is why
the live tool takes a name in the first place.

## Taking over: what interrupts an injected batch

Studio cancels a running batch when it sees the user take over, which is a **press** — a key, a mouse button,
a wheel notch — not a mouse *movement*. That distinction matters more than it looks: a cursor resting over the
Studio window emits move events continuously, and that is exactly the situation whenever a person is watching
the play test. Treating movement as a takeover made pointer injection unusable in the only case it is needed,
and it also broke clicking outright: with the move trigger in place a batch's press reached the button and
`SButton::OnMouseButtonUp` ran, but its click gate (`IsHovered()` / `HasMouseCapture()`) had already been
disturbed, so `UButton::OnClicked` never fired and the button's `Activated` never reached Lua.

Measured A/B on one binary, changing only whether `HandleMouseMoveEvent` triggers the interrupt:

| Mouse move triggers takeover | `OnButtonPressed` | `OnButtonReleased` | `OnButtonClicked` |
|---|---|---|---|
| yes | fires | fires | **never fires** |
| no | fires | fires | fires |

So `FPiePhysicalInputObserver` deliberately does not implement `HandleMouseMoveEvent`. Key down/up, mouse
button down/up, double-click and wheel all still cancel the batch, which is what "the user grabbed the
controls" actually looks like.
