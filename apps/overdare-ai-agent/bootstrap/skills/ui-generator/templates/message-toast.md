# Template: Message / Toast

Use for short feedback messages, alerts, objective updates, item pickup notices, or temporary status messages.

## Recommended Approach

Direct GUI creation is usually best.

## Common Hierarchy

```text
MessageRoot
 └─ ToastPanel
     └─ MessageLabel
```

Optional:

```text
ToastPanel
 ├─ IconImage
 └─ MessageLabel
```

## Placement

- Upper-middle for important messages.
- Center-lower safe area for lightweight feedback.
- Avoid default mobile control regions.
- Avoid leaving persistent messages in the exact center of the gameplay view.
- Short-lived center messages are acceptable when they are intentionally attention-grabbing.

## Size

- Toast width: Offset 400-760px.
- Toast height: Offset 60-100px.

## Text

- Main message: 24px+
- Use `TextWrapped` for longer messages.
- Keep message short whenever possible.

## ZIndex

- Above normal HUD but below modal dialogs when possible.
- Suggested: 60-90.
- Do not use the modal overlay band unless the toast intentionally blocks other UI.

## Behavior

- Usually shown/hidden from a `LocalScript`.
- Can later be animated with tweening.
- Keep messages short so they remain readable on mobile.

