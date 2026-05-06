# Template: Popup Dialog

Use for confirmation dialogs, alerts, rewards, tutorial messages, pause menus, or modal choices.

## Recommended Approach

- Use direct GUI creation for predictable behavior.
- Use worldAsset panels if visual style is important.
- Hybrid is often useful: direct modal structure + imported decorative panel.

## Common Hierarchy

```text
PopupRoot
 ├─ DimBackground
 └─ DialogPanel
     ├─ TitleLabel
     ├─ MessageLabel
     ├─ ConfirmButton
     └─ CancelButton
```

## Placement

- Center of screen.
- Use `AnchorPoint = 0.5, 0.5`.
- Use `Position = 0.5, 0, 0.5, 0`.
- Center placement is acceptable here because the dialog is an intentional overlay.
- If the dialog is shown during active gameplay, make sure it is clearly modal or does not block required controls unexpectedly.

## Size

- Dialog panel: Offset 500-760px wide, 260-420px high.
- Buttons: Offset 160-240px wide, 60-84px high.

## ZIndex

- Root overlay band: 100-199
- Dim background: 100
- Dialog panel: 110
- Text/buttons: 111+
- Keep the dim background and popup panel in the same overlay band so they are treated as one intentional overlay layer.

## Text

- Title: 30px+
- Message: 22px-26px
- Buttons: 24px+
- Use `TextWrapped` for message body.

## Behavior

- Visibility toggles should be client-side when purely visual.
- Confirm actions that affect gameplay should notify the server.
- Use `Activated` for confirm and cancel buttons.

