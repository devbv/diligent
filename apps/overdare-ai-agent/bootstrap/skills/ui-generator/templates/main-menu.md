# Template: Main Menu / Lobby Menu

Use for title screens, start menus, lobby menus, team select entry panels, shop entry panels, settings panels, pause-style menus, or mode selection screens.

---

## Recommended Approach

Direct GUI creation is usually best for the structure because menus need predictable button names and clean hierarchy.

Use worldAsset UI panels, icons, or decorative frames when visual polish is more important than simple primitive shapes.

Hybrid is often best:

- Direct GUI root and button hierarchy.
- Imported panel or icon assets for style.

---

## Common Hierarchy

```text
MainMenuRoot
 ├─ BackgroundDimmer
 ├─ TitlePanel
 │   ├─ TitleLabel
 │   └─ SubtitleLabel
 └─ ButtonPanel
     ├─ PlayButton
     ├─ TeamSelectButton
     ├─ ShopButton
     └─ SettingsButton
```

Optional:

```text
MainMenuRoot
 ├─ LogoImage
 ├─ VersionLabel
 └─ FooterLabel
```

---

## Placement

Menus may use the center of the screen because they are intentional overlays, not persistent gameplay HUD.

Still avoid placing important buttons too close to the bottom-left joystick or bottom-right jump region if the menu is visible during gameplay.

Recommended layout:

- Root: full screen, `Size = (1, 0, 1, 0)`.
- Main content panel: center or center-right.
- Title: upper-middle or center-top inside the menu panel.
- Buttons: vertical stack below the title.

For a menu overlay, use ZIndex band `100-199`.

For an always-visible lobby HUD that does not block gameplay, use normal HUD band `0-99` instead.

---

## Size

Reference mobile landscape size is about `1386 x 640`.

Suggested sizes:

- Main panel width: 520-760px.
- Main panel height: 420-560px.
- Menu button width: 260-420px.
- Menu button height: 64-88px.
- Button spacing: 12-20px.

Use `UIListLayout` for a simple vertical button stack.

---

## Text

- Title: 36px-56px.
- Subtitle: 22px-28px.
- Button text: 24px-32px.
- Footer/version labels: 16px-20px.

Use short labels:

- `Play`
- `Team Select`
- `Shop`
- `Settings`
- `Back`

Avoid emoji and special Unicode symbols.

---

## Visual Rules

- Use a cohesive color palette.
- Use one strong accent color for primary actions such as `Play`.
- Use darker neutral panels behind text.
- Use enough transparency to show the game background if desired, but not so much that text becomes hard to read.
- Keep padding consistent between panel edges and children.

---

## ZIndex

Overlay menu:

- `MainMenuRoot`: 100
- `BackgroundDimmer`: 100
- `MainPanel`: 110
- Title/buttons/icons: 111+

Non-overlay lobby UI:

- Root/panels: 20-30
- Buttons/text: parent + 1

---

## Behavior

Use `LocalScript` for purely visual menu behavior:

- Show or hide menu.
- Open settings panel.
- Switch between menu pages.
- Button press visual feedback.

If a button starts gameplay, changes team, purchases an item, or affects saved data, the UI should send a request to server gameplay logic rather than directly trusting the client.

Use `Activated` for menu buttons.

