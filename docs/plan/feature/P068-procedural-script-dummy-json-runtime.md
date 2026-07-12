---
id: P068
status: in-progress
created: 2026-06-02
---

# Procedural Script Dummy JSON Runtime

## Goal

Introduce an MVP Luau-based procedural script runtime that turns an OVERDARE-style procedural script plus parameters into deterministic dummy JSON. This proves the script-as-source-of-truth authoring model before integrating with StudioRPC tools, `json_apply`, `.ovdrjm` mutation, or full editor-side ProceduralModel lifecycle.

## Prerequisites

- Bun + TypeScript strict-mode sidecar infrastructure exists for OVERDARE-owned product code under `apps/overdare-ai-agent/sidecar` (D001).
- Zod is available for validating public inputs and parameter-shaped data (D012).
- A Luau-compatible executable must be available at runtime through `OVDR_LUAU_BIN`, `LUAU_BIN`, `luau`, or a later packaged sidecar binary. If no executable is available, the TypeScript wrapper must fail with a clear setup error.
- Product-owned OVERDARE tools and related implementation code should live in the sidecar rather than product-neutral runtime/web packages.

## Background

OVERDARE Studio control currently works well for direct geometric creation such as parts, mesh parts, blocks, balls, and cylinders. However, AI agents struggle with large structured outputs such as stadiums, colosseums, circular seating, fences along paths, repeated placement, and low-poly character props. The common failure mode is emitting hundreds of individually authored objects with no preserved concept of the rule that generated them.

The desired authoring model is closer to a procedural component: a script and its parameters are the source of truth, while generated objects are derived output. The user-provided LowPolyBunny example illustrates the intended script shape: an actual Luau module with an `OnGenerate(parameters, targetContainer)` function, dependencies such as `GeometryPrimitives`, and calls that look like `GP.model`, `GP.sphere`, `GP.taperedCylinder`, and related helper libraries.

For this MVP, the implementation does not need to mutate Studio, call `json_apply`, create real `.ovdrjm` nodes, or provide a full production sandbox. It does need to execute Luau through a subprocess runner, provide Luau-side `ovdr-shim` and dependency libraries, and produce a final dummy JSON artifact so that the data model, hierarchy semantics, dependency-library vocabulary, generation metadata, and deterministic serialization can be validated independently.

Important naming rule: the runtime must use OVERDARE naming. The compatibility layer is called `ovdr-shim`. The product/system terminology should be OVDR/OVERDARE throughout.

## Artifact

When complete, a test or standalone function can generate dummy JSON from a procedural script fixture:

```text
Input script:
  --!strict
  -- generationId: test-bunny-001
  local GP = require(script.Dependencies.GeometryPrimitives)
  local Bunny = {}
  Bunny.OnGenerate = function(parameters, targetContainer)
    local model = GP.model("Bunny", nil)
    GP.sphere("Body", Vector3.new(0, 2, 0), 2, Color3.fromRGB(245, 175, 185), "SmoothPlastic", model)
    model.Parent = targetContainer
  end
  return Bunny

Input parameters:
  { "Size": { "X": 10, "Y": 10, "Z": 10 }, "Attributes": {} }

Output:
  deterministic OVERDARE procedural dummy JSON containing generationId, script metadata,
  parameters, a root target container, a Bunny model, and a Body ball primitive.
```

## Scope

### What changes

| Area | What Changes |
|------|-------------|
| `apps/overdare-ai-agent/sidecar/src/procedural-model` | New TypeScript wrapper for invoking the Luau runner, validating inputs, and parsing dummy JSON output. |
| `apps/overdare-ai-agent/sidecar/src/procedural-model/luau` | New Luau runner, Luau `ovdr-shim`, and Luau dependency libraries that execute procedural scripts and emit dummy JSON. |
| `apps/overdare-ai-agent/sidecar/test/procedural-model` | New focused tests for metadata extraction, hierarchy construction, primitive emission, unsupported dependency failures, and determinism. |
| `docs/plan/feature` | This plan documents background, scope, and implementation sequence. |

### What does NOT change

- No StudioRPC tool integration in this MVP.
- No call to `action_sequencer_service.apply_json`.
- No `.ovdrjm` mutation or final Studio instance insertion.
- No editor inspector, generated-child visualization, undo/redo grouping, bake/detach, or save/load lifecycle.
- No TypeScript regex/script adapter pretending to execute Luau.
- No bundled Luau binary packaging in this first pass; runtime discovery is enough.
- No production-grade arbitrary user script sandbox in the first pass.
- No full CSG implementation.
- Use `ovdr-shim` terminology for the compatibility layer.
- No built-in `StairGenerator` registry as the source of truth. Stairs and similar structures belong in script libraries used by procedural scripts.

## File Manifest

### docs/plan/feature/

| File | Action | Description |
|------|--------|-------------|
| `P068-procedural-script-dummy-json-runtime.md` | CREATE | Plan for the MVP procedural script-to-dummy-JSON runtime. |

### apps/overdare-ai-agent/sidecar/src/procedural-model/

| File | Action | Description |
|------|--------|-------------|
| `types.ts` | CREATE | Shared dummy JSON, vector/color/CFrame, node, and generation input/output types. |
| `script-metadata.ts` | CREATE | Extract `generationId` and script/module name hints from script source. |
| `runtime.ts` | CREATE | Main `generateProceduralDummyJson` API that writes temp inputs, invokes Luau, and parses dummy JSON. |
| `index.ts` | CREATE | Public exports for the procedural model MVP. |

### apps/overdare-ai-agent/sidecar/src/procedural-model/luau/

| File | Action | Description |
|------|--------|-------------|
| `runner.lua` | CREATE | Luau entrypoint that loads input JSON, installs OVDR globals, executes user script, runs `OnGenerate`, and prints dummy JSON. |
| `json.lua` | CREATE | Small JSON encode/decode helper for runner input/output. |
| `ovdr-shim.lua` | CREATE | Luau-side OVERDARE shim for `Vector3`, `Color3`, `CFrame`, fake instances, parenting, descendants, and `IsA`. |
| `dependencies/GeometryPrimitives.lua` | CREATE | Luau `GeometryPrimitives` dependency with `model`, `sphere`, `block`, `cylinder`, and dummy complex primitive capture. |
| `dependencies/ConstructiveSolidGeometry.lua` | CREATE | Placeholder dependency module for MVP compatibility. |
| `dependencies/SmartObject.lua` | CREATE | Placeholder dependency module for MVP compatibility. |
| `dependencies/MathUtils.lua` | CREATE | Placeholder dependency module for MVP compatibility. |

### apps/overdare-ai-agent/sidecar/test/procedural-model/

| File | Action | Description |
|------|--------|-------------|
| `runtime.test.ts` | CREATE | Unit tests for generation metadata, hierarchy, primitive output, dependency errors, and determinism. |

## Implementation Tasks

### Task 1: Define dummy JSON and runtime types

**Files:** `apps/overdare-ai-agent/sidecar/src/procedural-model/types.ts`
**Decisions:** D001, D012

Define a stable JSON artifact that is intentionally not the final Studio JSON format. This prevents premature coupling to StudioRPC and makes the source-of-truth model testable.

```typescript
export interface ProceduralGenerationInput {
  scriptSource: string;
  parameters: ProceduralParameters;
  scriptName?: string;
}

export interface ProceduralParameters {
  Size: Vector3Json;
  Attributes?: Record<string, unknown>;
}

export interface ProceduralDummyJson {
  version: 1;
  kind: "overdare.procedural-dummy-json";
  generationId: string;
  scriptName: string;
  parameters: ProceduralParameters;
  root: ProceduralNode[];
}
```

**Verify:** TypeScript compiles and tests can import the types without type escapes.

### Task 2: Build the Luau `ovdr-shim` instance model

**Files:** `apps/overdare-ai-agent/sidecar/src/procedural-model/luau/ovdr-shim.lua`
**Decisions:** D001

Implement the minimal fake OVERDARE instance tree used by Luau scripts and dependencies. This should support the parenting semantics shown in the LowPolyBunny example without exposing arbitrary scene mutation.

```lua
local OvdrShim = {}

function OvdrShim.Vector3.new(x, y, z) end
function OvdrShim.Color3.fromRGB(r, g, b) end
function OvdrShim.CFrame.identity() end
function OvdrShim.createInstance(className, name) end
function OvdrShim.createTargetContainer() end

return OvdrShim
```

**Verify:** A Luau fixture can create a model, parent it to a target container, and serialize descendants in deterministic order.

### Task 3: Implement MVP dependency libraries

**Files:** `luau/dependencies/GeometryPrimitives.lua`, placeholder dependency Lua files
**Decisions:** D001

Implement `GeometryPrimitives` as the main script library. `Stair`, placement helpers, CSG, and other structures are future libraries, not top-level generator registries.

```lua
function GP.model(name, parent) end
function GP.sphere(name, center, radius, color, material, parent) end
function GP.block(name, center, size, color, material, parent) end
function GP.cylinder(name, center, height, radius, color, material, parent) end
function GP.taperedCylinder(name, ...) end
function GP.regularPrism(name, ...) end
function GP.pyramid(name, ...) end
function GP.quadFromFourPoints(name, ...) end
```

Complex primitives may serialize as dummy primitive nodes rather than exact meshes.

**Verify:** `GP.model`, `GP.sphere`, and one complex primitive produce nodes under the expected parent.

### Task 4: Add script metadata extraction

**Files:** `script-metadata.ts`
**Decisions:** D001

Extract `generationId` from the script comment format.

```typescript
export function extractProceduralScriptMetadata(scriptSource: string, fallbackName?: string): {
  generationId: string;
  scriptName: string;
};
```

For MVP, require a `-- generationId: ...` comment so output identity is deterministic. Later phases may generate and persist IDs.

**Verify:** Missing generation ID produces a clear error.

### Task 5: Implement TypeScript Luau subprocess wrapper

**Files:** `runtime.ts`
**Decisions:** D001, D030

Implement the main generation API by writing temporary runner input, invoking a Luau executable, and parsing JSON emitted by the Luau runner. This must not parse or emulate Luau in TypeScript.

```typescript
export async function generateProceduralDummyJson(
  input: ProceduralGenerationInput,
): Promise<ProceduralDummyJson>;
```

The runtime should:

- discover the Luau executable from `OVDR_LUAU_BIN`, `LUAU_BIN`, then `luau`
- write `{ scriptSource, parameters, scriptName, generationId }` to a temporary JSON file
- run `runner.lua <input-json-path>`
- parse the final stdout JSON as `ProceduralDummyJson`
- surface stderr and missing executable errors clearly

**Verify:** A small bunny-like script fixture generates a model with two sphere parts.

### Task 6: Implement Luau runner and serializer

**Files:** `luau/runner.lua`, `luau/json.lua`, `luau/ovdr-shim.lua`
**Decisions:** D020

Serialize the Luau target container into `ProceduralDummyJson` with stable key order and child order. The output should include script metadata, parameters, and derived hierarchy.

```lua
local output = {
  version = 1,
  kind = "overdare.procedural-dummy-json",
  generationId = input.generationId,
  scriptName = input.scriptName,
  parameters = input.parameters,
  root = serializeChildren(targetContainer),
}
```

**Verify:** Same input produces deeply equal JSON on repeated runs.

### Task 7: Add tests

**Files:** `apps/overdare-ai-agent/sidecar/test/procedural-model/runtime.test.ts`
**Decisions:** D001

Cover the MVP behavior with focused tests:

1. Extracts `generationId` from script comments.
2. Generates model hierarchy from `GP.model` and `Parent` assignment.
3. Generates ball/block/cylinder primitive dummy JSON.
4. Captures unsupported complex primitives as dummy primitive nodes.
5. Fails clearly when the Luau executable is unavailable.
6. Produces deterministic JSON for the same script and parameters.

**Verify:** `bun test apps/overdare-ai-agent/sidecar/test/procedural-model/runtime.test.ts` passes.

## Acceptance Criteria

1. `generateProceduralDummyJson` exists as a product-sidecar API and returns `kind: "overdare.procedural-dummy-json"`.
2. Output includes `generationId`, `scriptName`, `parameters`, and generated `root` hierarchy.
3. `ovdr-shim` naming is used for the Luau compatibility layer.
4. Luau `GeometryPrimitives` supports `model`, `sphere`, `block`, and `cylinder` for MVP dummy JSON generation.
5. Unsupported complex primitives can be represented as dummy primitive nodes without failing generation.
6. The same input script and parameters produce the same JSON object.
7. The MVP has no StudioRPC, `json_apply`, or `.ovdrjm` dependency.
8. Focused sidecar procedural-model tests pass.

## Testing Strategy

| Category | What to Test | How |
|----------|--------------|-----|
| Unit | Metadata extraction | Direct tests for `extractProceduralScriptMetadata`. |
| Unit | TypeScript wrapper | Validate metadata extraction and missing Luau executable errors. |
| Integration | Luau runner | When `OVDR_LUAU_BIN` is available, execute fixture and assert serialized node shape. |
| Integration | Runtime determinism | Generate twice through Luau and compare deep equality. |
| Negative | Missing executable | Clear setup error when no Luau binary is discoverable. |

## Risk Areas

| Risk | Impact | Mitigation |
|------|--------|------------|
| Luau executable is missing in local or CI environments | Tests cannot execute scripts | Wrapper reports a clear setup error; integration tests can skip unless `OVDR_LUAU_BIN`/`LUAU_BIN`/`luau` is available until packaging is added. |
| Luau subprocess runner is not a production sandbox | Unsafe arbitrary script execution if exposed broadly | Keep this MVP as local generation infrastructure only; production sandbox/capabilities are later scope. |
| Dummy JSON becomes mistaken for final Studio JSON | Incorrect integration assumptions | Use `kind: "overdare.procedural-dummy-json"` and keep StudioRPC/json_apply out of scope. |
| Dependency libraries become top-level generators | Loses script-as-source-of-truth model | Keep `GeometryPrimitives`, future `Stair`, and placement utilities as libraries called by scripts. |
| Non-OVERDARE terminology leaks into product code | Product naming drift | Use `ovdr-shim` consistently and test/file review for naming. |
| Complex primitives cannot be represented accurately | MVP examples may look incomplete | Serialize them as typed dummy primitive nodes first; exact mesh/CSG generation is later scope. |

## Decisions Referenced

| ID | Summary | Where Used |
|----|---------|------------|
| D001 | Bun + TypeScript runtime | Sidecar procedural runtime implementation. |
| D012 | Zod schema system | Input/parameter validation where needed. |
| D020 | Tool/result metadata separation | Influences deterministic JSON artifact design, although this MVP is not a tool. |
| D030 | No OS-level sandboxing at MVP | Use subprocess isolation only for MVP and defer production sandbox policy. |
