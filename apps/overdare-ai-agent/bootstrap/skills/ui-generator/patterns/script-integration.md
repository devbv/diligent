# Pattern: UI Script Integration

Use this pattern when UI needs behavior, such as button clicks, animation feedback, visibility toggles, or client-side display updates.

## Core Rule

GUI input, camera work, and player-local UI behavior must run in a `LocalScript`.

Server gameplay validation should run in a server `Script`.

Do not design UI interactions around keyboard input. For mobile-first games, gameplay actions should be available through on-screen touch buttons.

## Attach to the Existing Owner First

Before adding a script, find the controller/server script that already owns the screen or flow you are touching (browse the hierarchy and read the relevant `LocalScript`/`Script`). Add or update UI under the existing screen root and let that owner drive it — extend the owner rather than dropping in a second script that competes for the same state. This keeps one source of truth for a HUD or panel and avoids the "two scripts fighting over the same label" failures. Preserve the owner's existing responsibilities; only add what the request needs.

## Common Locations

Good locations for UI `LocalScript`:

- `StarterPlayer > StarterPlayerScripts`
- Directly under a `ScreenGui` when the behavior belongs only to that GUI
- Under a specific UI object only when the hierarchy is stable and simple

Good locations for server `Script`:

- `ServerScriptService`

Good locations for shared `ModuleScript`:

- `ReplicatedStorage`

## Button Activation Pattern

Use `Activated` for `TextButton` and `ImageButton`.

Use stable button names and predictable hierarchy before writing scripts. If the UI is imported from worldAsset, inspect and rename important buttons before connecting behavior.

When a button needs an action function, animation feedback, or dynamic content updates, the script should first import or reference the actual runtime GUI from `PlayerGui` using `WaitForChild` along the hierarchy.

Do not assume the Studio `StarterGui` object itself is the runtime UI. Use the copied `PlayerGui` hierarchy.

```lua
local Players = game:GetService("Players")

local localPlayer = Players.LocalPlayer
local playerGui = localPlayer:WaitForChild("PlayerGui")

local screenGui = playerGui:WaitForChild("ScreenGui")
local button = screenGui:WaitForChild("Button")

local function OnButtonActivated(): ()
	print("button activated")
end

button.Activated:Connect(OnButtonActivated)
```

## Hierarchical GUI Reference Pattern

Use this pattern when a script needs to access a specific imported UI asset or deeply nested GUI element.

Example:

```lua
local Players = game:GetService("Players")

local localPlayer: Player = Players.LocalPlayer
local playerGui = localPlayer:WaitForChild("PlayerGui")

local basketballIconPack = playerGui:WaitForChild("BasketballIconPack")
local basketballFrame = basketballIconPack:WaitForChild("BasketballFrame")
local actionFrame = basketballFrame:WaitForChild("ActionFrame")
local shotButton = actionFrame:WaitForChild("ShotButton")

local function OnShotButtonActivated(): ()
	print("shot")
end

shotButton.Activated:Connect(OnShotButtonActivated)
```

Use this same pattern for dynamic UI updates, such as changing:

- button images
- text labels
- score values
- timer values
- health bar fill sizes
- popup visibility
- quick slot icons

Keep hierarchy names stable so scripts can reliably find UI elements.

## PlayerGui Rule

UI placed in `StarterGui` is copied to each player's `PlayerGui` at runtime.

Therefore, Studio placement should normally happen under `StarterGui`, but runtime scripts should usually read the copied UI under `PlayerGui`.

Therefore runtime UI scripts should usually read from:

```lua
local playerGui = Players.LocalPlayer:WaitForChild("PlayerGui")
```

not directly from `StarterGui`.

## Validation

After adding or editing scripts:

1. Run `validatelua` on changed scripts.
2. If temporary logs are added, explain how to test them.
3. Remove or minimize temporary logs after the user confirms the behavior.

## Common Visual Feedback

Simple feedback can include:

- Button grows briefly
- Button shifts slightly
- Button changes image or color
- Popup opens or closes
- Text updates

Prefer simple, visible feedback first before adding complex gameplay logic.

For touch buttons, visual feedback is especially important because mobile players need immediate confirmation that the tap was received.

## Tool Workflow

When adding or changing UI scripts:

1. Confirm the target UI hierarchy with `studiorpc_level_browse` or `studiorpc_instance_read`.
2. Use `studiorpc_script_add` for new `LocalScript` behavior or `studiorpc_script_edit` for existing behavior.
3. Keep dependencies listed at the top of the script when requiring modules.
4. Validate changed scripts with `validatelua`.
5. If play testing is needed, use temporary `print()` logs sparingly and remove or minimize them after confirmation.

