---
name: overdare-camera-templates
description: When handling camera-related requests, first assess camera template fit. If confirmation questions are needed, always use user_confirmed_spec. Present the optimal template asset ID with selection rationale and alternatives.
---

# OVERDARE Camera Template Skill

## Purpose
- Rather than writing new camera implementation code, quickly match verified camera template assets to the request's intent.
- Analyze genre/viewpoint/control intent from the user's prompt and present a primary template plus alternatives.

## Template Asset List (Fixed)

| Controller | Description | Asset ID |
| --- | --- | --- |
| `TopViewCameraController` | Top-view camera | `ovdrassetid://36834100` |
| `BirdViewCameraController` | Bird's-eye-view camera | `ovdrassetid://36835100` |
| `QuarterViewCameraController` | Quarter-view camera | `ovdrassetid://36836100` |
| `FPSCameraController` | FPS camera | `ovdrassetid://36925100` |
| `TPSCameraController` | TPS camera | `ovdrassetid://36838100` |
| `TPSShoulderViewCameraController` | TPS shoulder-view camera | `ovdrassetid://36839100` |
| `3DPlatformerCameraController` | 3D platformer camera (camera rotates with character movement direction) | `ovdrassetid://36840100` |
| `SideViewCameraController` | Side-view camera | `ovdrassetid://36841100` |
| `LockOnCameraController` | Lock-on camera (focus on a designated target) | `ovdrassetid://36841200` |

## Input Interpretation Rules
When receiving a camera-related request, interpret it in the following order.

1. Extract game genre / play feel
- Examples: roguelike, action RPG, shooter, platformer, side-scroller (or 2D platformer).

2. Extract viewpoint keywords
- Top-view / high-angle / quarter-view / first-person / third-person / shoulder / side-scroll / lock-on.

3. Extract control intent
- Aim-centric, character tracking, smooth follow, target lock, **movement-direction-linked (camera rotation)** vs **fixed left-right progression (side-scroll / side-view)**.

4. Extract mandatory constraints
- Mobile, motion-sickness minimization, fast response, field-of-view clarity, UI collision avoidance.

5. Rate template fit
- Classify fit into three tiers: `High` / `Medium` / `Low`.

## Question Rules
- Spec confirmation questions must always use `user_confirmed_spec`.
- Do not request confirmation via free-form descriptive questions.
- Limit questions to 1–2 at most, asking only what is needed for viewpoint/control decisions.
- **`LockOnCameraController` mandatory rules** (applies to recommendations, confirmations, and primary picks):
  - Always confirm the lock-on target (`TargetInstance`: boss / nearest enemy / aim target / designated object, etc.) via `user_confirmed_spec`.
  - If the request requires lock-on, place candidates other than `LockOnCameraController` only as alternatives.
  - Do not finalize the recommendation if `TargetInstance` is undetermined.

## Selection Rules
- Always select exactly one primary template.
- Present at most two second-choice alternatives.
- If only one template is clearly rated `High`, finalize as a single recommendation.
- If two or more are `High`, or all are `Medium`, present in "recommendation + alternatives" form.
- If the request explicitly mentions lock-on / target focus, prioritize `LockOnCameraController`.
- If the request explicitly mentions first-person / gun-aim-centric, prioritize `FPSCameraController`.
- If the request explicitly mentions shoulder shot / right shoulder / close third-person aim, prioritize `TPSShoulderViewCameraController`.
- **`3DPlatformerCameraController` vs `SideViewCameraController` branching** (both are easily confused with platformers):
  - If the camera **rotates with character movement direction**, or forward-direction tracking is core → prioritize `3DPlatformerCameraController`.
  - If it is **side-view / side-scroll** based with a fixed camera axis and **left-right (X-axis) progression only** in 2.5D → prioritize `SideViewCameraController`.
  - If only "platformer" is given and the above criteria are mixed, confirm exactly one of movement-direction rotation vs side-scroll fixed via `user_confirmed_spec`.

## CamScripts-Based Features / Parameters / Fit / Misfit by Template
Top-view, bird's-eye, and quarter-view share the same Scriptable CONFIG structure. Units are cm.

- `TopViewCameraController` (`ovdrassetid://36834100`)
  - Key features: Fixed top-view based on `CameraType.Scriptable`, optional `SmoothFollow`.
  - Key parameters: `PitchDegrees` (default 68; higher = more vertical top-view view) · `Distance` (default 1400; larger = wider map view, smaller character) · `YawDegrees` (default 0; horizontal viewing direction) · `FieldOfView` · `TargetOffset` (lower Y = character closer to screen center) · `SmoothFollow` + `FollowSpeed` (when true, smooth tracking; higher = faster response).
  - Good fit: Top-down combat, strategy/roguelike, minimap-style battlefield awareness.
  - Poor fit: Precision aiming (FPS/TPS), immersive action with rear character tracking.

- `BirdViewCameraController` (`ovdrassetid://36835100`)
  - Key features: Higher altitude / wider field than top-view family; maintains aerial viewpoint via Scriptable.
  - Key parameters: `Distance` (default 1600; farther and wider than top-view) · `PitchDegrees` (default 45; diagonal aerial view) · `YawDegrees` · `FieldOfView` · `TargetOffset` · `SmoothFollow` + `FollowSpeed`.
  - Good fit: Large-map exploration, monitoring many objects, battlefield tactical judgment.
  - Poor fit: Close-action readability, character emotion / impact-focused presentation.

- `QuarterViewCameraController` (`ovdrassetid://36836100`)
  - Key features: Fixed diagonal (quarter) viewpoint tracking; lower pitch than top-view for balanced character/terrain exposure.
  - Key parameters: `PitchDegrees` (default 45; lower = more diagonal/character close-up, higher = closer to top-view) · `Distance` (default 1400) · `YawDegrees` (default 40; diagonal framing) · `FieldOfView` (wider = more peripheral awareness, narrower = combat focus) · `TargetOffset` · `SmoothFollow` + `FollowSpeed` (combat responsiveness vs smoothness tradeoff).
  - Good fit: Action RPG, hack-and-slash, isometric combat flow.
  - Poor fit: Full first-person aiming, fixed-axis side-scroll progression.

- `FPSCameraController` (`ovdrassetid://36925100`)
  - Key features: `CameraType.Custom`, viewpoint fixed via `CameraOffset`, includes restore logic when character is removed.
  - Key parameters: `FieldOfView` (default 90; wider = more peripheral awareness, narrower = aim focus) · `CameraOffset` (Y = eye height, negative Z = hides character body / stronger first-person feel) · `ZoomDistance` + `LockZoomDistance` (fixed zoom; smaller value = closer to first-person).
  - Good fit: First-person shooting, aim precision priority, immersive viewpoint.
  - Poor fit: Games that must always show character appearance, boss lock-on-centric combat.

- `TPSCameraController` (`ovdrassetid://36838100`)
  - Key features: Third-person via `CameraOffset`, `CameraRelativeRotation` + `CharacterTurnRate`, fixed zoom to maintain aim framing.
  - Key parameters: `FieldOfView` · `ShoulderSide` (1 = right / -1 = left shoulder) · `ShoulderOffsetX` / `CameraHeightY` / `CameraBackOffsetZ` (shoulder, height, rear distance; larger = smaller character and longer-range view) · `ZoomDistance` (default 480; smaller = closer, larger = farther) · `CameraRelativeRotation` + `CharacterTurnRate` (-1 = instant rotation, follows aim direction) · `InstantCameraResponse` (when false, delayed tracking).
  - Good fit: Standard third-person shooting, balanced movement/shooting, fast-response combat.
  - Poor fit: Strict top-view/side-view, combat where target-lock is core.

- `TPSShoulderViewCameraController` (`ovdrassetid://36839100`)
  - Key features: Same family as TPS but emphasizes shoulder shot via narrow shoulder offset and close zoom.
  - Key parameters: Same structure as TPS. Differentiators — `ShoulderOffsetX` (default 40; smaller = closer to center) · `ZoomDistance` (default 300; closer than TPS) · `CameraHeightY` (default 85). Remaining `ShoulderSide` / `FieldOfView` / `CameraRelativeRotation` / `CharacterTurnRate` are the same.
  - Good fit: Over-the-shoulder aiming, mid-close range shooting, TPS with strong character presence.
  - Poor fit: Long-range battlefield awareness focus, fully centered viewpoint requirements.

- `3DPlatformerCameraController` (`ovdrassetid://36840100`)
  - Key features: `CameraType.Scriptable`, movement-direction-based rotation via smoothed character `LookVector`.
  - Key parameters: `CameraDistance` (default 520; smaller = character close-up) · `CameraHeightY` (default 230; higher = more overhead look-down) · `FieldOfView` (default 76) · `LookAheadDistance` (default 260; larger = more forward lead, smaller = more character-centered) · `HorizontalOffsetX` / `VerticalFramingOffsetY` (character position on screen; negative Y = character toward top of screen, better leg visibility) · `LookAtHeightY` (gaze height / horizon) · `SmoothingSpeed` (default 6; higher = faster tracking, lower = smoother platformer feel).
  - Good fit: 3D jump action, **camera rotation aligned with character movement direction**, forward-direction tracking during free 3D movement, Mario/Kirby-style forward progression.
  - Poor fit: **Fixed-axis side-view/side-scroll**, left-right scroll-only 2.5D, fixed-viewpoint combat, precision-aim shooting, lock-on-centric combat (`SideViewCameraController` candidate).

- `SideViewCameraController` (`ovdrassetid://36841100`)
  - Key features: Scriptable-based side-scroll, X-axis tracking + fixed Y/Z, optional delayed follow.
  - Key parameters: `SideDistanceZ` (default 1200; Z-axis camera distance / stage width feel) · `CameraHeightForViewAngleY` (default 220; actual camera height / side angle) · `LookTargetHeightOffsetY` (default 160; higher = sky / character placed lower on screen) · `SideSignZ` (1/-1; which side of stage to view from, +Z/-Z) · `FixedDepthZ` (fixed stage depth) · `FollowDelayEnabled` + `FollowSpeed` (delayed follow; higher = faster X-axis follow) · `FieldOfView`.
  - Good fit: **Fixed side-view/side-scroll viewpoint**, 2.5D side-scroll, left-right (X-axis) platform/action, lane-based presentation, fixed camera Y/Z axes.
  - Poor fit: **Camera rotation based on character movement direction**, free omnidirectional 3D exploration, chase-style TPS/FPS aiming (`3DPlatformerCameraController` candidate).

- `LockOnCameraController` (`ovdrassetid://36841200`)
  - Key features: Lock-on centered on `TargetInstance`, weighted gaze toward midpoint between player and target, smoothed follow. Default target is temporary `SpawnLocation` value.
  - Key parameters: `TargetInstance` (lock-on target object; see Question Rules) · `TargetFocusWeight` (default 0.55; higher = gaze toward target, lower = player-centered) · `CameraDistance` / `CameraHeightY` / `ShoulderOffsetX` (third-person distance, height, shoulder offset) · `LookAtHeightOffsetY` (gaze height) · `FollowSpeed` (default 3.5; lower = heavier lock-on, higher = faster rotation) · `FieldOfView` · `FallbackTargetDistance` (safe forward distance when target is invalid).
  - Good fit: Boss fights, soulslike, target-locked close combat.
  - Poor fit: Exploration games without targets, cases where free viewpoint switching matters in crowd combat.

## Fit / Misfit Judgment Rules (Mandatory)
- If the request strongly includes even one misfit condition for a template, cap that template's highest rating at `Medium`.
- Promote to priority candidate when 2+ fit conditions and 0 misfit conditions.
- If fit and misfit are mixed, confirm exactly one priority via `user_confirmed_spec`, then finalize.
- If "field-of-view clarity" and "precision aiming" appear together, compare one each from `FPS/TPS family` and `Top/Quarter family`.
- For "platformer" requests where **movement-direction camera rotation** and **fixed side-scroll** are both ambiguous, compare one each of `3DPlatformerCameraController` and `SideViewCameraController`, then confirm exactly one via `user_confirmed_spec`.

## Response Stages
Camera request handling is split into **template selection** and **final response** stages.

### Template Selection
- Responses where primary pick is not yet finalized or user confirmation is needed: recommendations, alternatives, `user_confirmed_spec` confirmation, etc.
- Write only `[Camera Analysis]` and `[Recommendation]`.

### Final Response
- Completion response with primary template finalized. Follow the full **Final Response Format** below.
- **Must include `[Key Parameters]` and `[Application Guide]`.**

## Parameter Description Rules (Final Response Only)
- Based on parameter definitions in the CamScripts section, explain **parameter name → what increasing/decreasing the value feels like**.
- Prioritize **3–5** parameters relevant to the request context (no full enumeration).
- For parameters with defaults, mention the default and suggest adjustment direction (increase/decrease) aligned with the request.
- Do not write generic advice like "adjust FOV/Distance" without parameter-specific explanation.

## Response Format

### Template Selection
```markdown
[Camera Analysis]
- Request intent: ...
- Key keywords: ...

[Recommendation]
- Primary: <asset name> (<asset ID>)
- Fit: High | Medium | Low
- Selection rationale: ...

- Secondary (optional): <asset name> (<asset ID>)
- Fit: High | Medium | Low
- Alternative rationale: ...
```

### Final Response
```markdown
[Camera Analysis]
- Request intent: ...
- Key keywords: ...

[Recommendation]
- Primary: <asset name> (<asset ID>)
- Fit: High | Medium | Low
- Selection rationale: ...

- Secondary (optional): <asset name> (<asset ID>)
- Fit: High | Medium | Low
- Alternative rationale: ...

[Key Parameters]
- `<parameter name>` (default: ...): increase → ... / decrease → ...
- `<parameter name>` (default: ...): increase → ... / decrease → ...
- (3–5 based on request context)

[Application Guide]
- Asset ID to apply: <asset ID>
- Parameters to adjust first: 1–2 from [Key Parameters] above
- Test checkpoints: character visibility, motion sickness, combat readability, control responsiveness
```

## Handling Ambiguous Requests
- If viewpoint information is missing, temporarily recommend `QuarterViewCameraController` as default and ask only 1–2 confirmation questions as needed.
- `user_confirmed_spec` spec item examples (do not send the sentences below verbatim to the user; compose them as spec options):
  - Viewpoint priority: aim precision (FPS/TPS) vs character/terrain visibility (quarter/top-view)
  - Platformer camera: camera rotation with movement direction (3D) vs fixed side-scroll side-view (2.5D)
  - Lock-on needed: automatic target lock required / not required

## Prohibited Actions
- Do not prioritize proposing to implement a camera system from scratch.
- Do not omit asset IDs.
- Do not list template names without recommendation rationale.
- Do not omit `[Key Parameters]` or `[Application Guide]` in the final response.
