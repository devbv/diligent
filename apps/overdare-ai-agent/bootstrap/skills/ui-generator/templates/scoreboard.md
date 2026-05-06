# Template: Scoreboard / Timer

Use for score, timer, round, quarter, shot clock, wave, or match state displays.

## Recommended Approach

Direct GUI creation is usually best because scoreboards need predictable text labels for script updates.

## Common Hierarchy

```text
GameHUDRoot
 └─ ScoreboardPanel
     ├─ HomeScoreLabel
     ├─ TimerLabel
     └─ AwayScoreLabel
```

Optional:

```text
GameHUDRoot
 ├─ ShotClockPanel
 │   └─ ShotClockLabel
 └─ RoundPanel
     └─ RoundLabel
```

## Placement

- Top center.
- Avoid the top-left system menu.
- Use `AnchorPoint.X = 0.5`.
- Use `Position.X.Scale = 0.5`.
- A good reference is `Position = (0.5, 0)`, `AnchorPoint = (0.5, 0)`, with about `18px` Y offset.
- Avoid making the panel so tall that it covers the central play view.

## Size

- Panel width: usually Offset 360-520px.
- Panel height: usually Offset 60-90px.
- Timer or central number text: 28px or larger.

## Text

- Use high contrast.
- Keep labels short.
- Use absolute TextSize.
- Add a darker translucent backing panel when the world background makes text hard to read.

## ZIndex

- Panel: 20
- Text labels: 21

## Behavior

When scripted later:

- Update text labels from a `LocalScript` or client event.
- Server should own authoritative score state.
- Client UI should display received state.

