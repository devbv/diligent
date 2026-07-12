# Procedural Geometry and Math API Guide

This guide defines the supported geometry boundary and the implementation
priority for OVERDARE procedural Luau helpers.

The roadmap is intentionally limited to geometry that can be represented with
the current procedural output contract:

- `Model`
- `Part` with `Shape = "Block"`
- `Part` with `Shape = "Ball"`
- `Part` with `Shape = "Cylinder"`

P0, P1, and the deterministic-random P2.1 APIs are implemented. Later roadmap
APIs are not available at runtime until they are added to
`GeometryPrimitives.lua` or `MathUtils.lua`. The current API tables below are
the source of truth for callable functions.

## Runtime boundary

| Concern | Source |
| --- | --- |
| Output types | `apps/overdare-ai-agent/sidecar/src/procedural/types.ts` |
| Runtime output validation | `apps/overdare-ai-agent/sidecar/src/procedural/runtime.ts` |
| Geometry helpers | `apps/overdare-ai-agent/sidecar/src/procedural/luau/dependencies/GeometryPrimitives.lua` |
| Math helpers | `apps/overdare-ai-agent/sidecar/src/procedural/luau/dependencies/MathUtils.lua` |
| Part serialization and approximation | `apps/overdare-ai-agent/sidecar/src/procedural/luau/ovdr-shim.lua` |
| Runtime limits | `apps/overdare-ai-agent/sidecar/src/procedural/limits.ts` |

The output schema does not currently support wedge parts, arbitrary meshes, or
boolean geometry. A helper must therefore produce either one supported `Part`
or a deterministic `Model` composed of supported parts.

## Accuracy classes

Every geometry helper belongs to one of these classes.

### Direct part

The requested geometry maps directly to one supported part shape. Examples:

- box or panel -> `Block`
- sphere or ellipsoid -> `Ball`
- cylinder or disc -> `Cylinder`

These helpers should be preferred because they have low node cost and predictable
collision behavior.

### Composite

The requested geometry is assembled from multiple supported parts. Examples:

- polyline -> one `Block` or `Cylinder` per segment
- arc or ring -> sampled points joined by polyline segments
- helix -> sampled points joined by polyline segments

Composite helpers must expose their sampling or segment count and must reject
invalid or unreasonably large counts before producing output.

### Approximation

The name describes geometry that cannot be represented exactly by the current
schema. The runtime produces a supported bounding or silhouette approximation.
Approximation helpers must be documented as approximations and must not be used
as the foundation for new exact-looking APIs.

## API design rules

1. Prefer shape or operation names over implementation names. Use `boxBetween`,
   not `strutFromTwoPoints`.
2. Keep math helpers pure when possible. `pointsOnCircle` returns points;
   `forEachPointOnCircle` is a convenience wrapper over that result.
3. Do not overload a function by inspecting argument types. Use separate names
   such as `cylinder` and `cylinderBetween`.
4. Use an `options` table for optional style, parenting, and Part properties.
   Keep required geometry arguments positional.
5. Make output deterministic. Random or noise APIs require an explicit seed.
6. Preserve renamed public APIs as compatibility aliases until an explicit
   breaking migration is approved.
7. Validate finite vectors, positive sizes, segment counts, and degenerate
   start/end pairs at the public API boundary.

Recommended options shape:

```lua
{
	color = Color3.fromRGB(255, 255, 255),
	material = "Plastic",
	parent = model,
	transparency = 0,
	canCollide = true,
}
```

## Current GeometryPrimitives API

| Function | Representation | Accuracy |
| --- | --- | --- |
| `model` | `Model` | direct |
| `sphere` | `Ball` with uniform size | direct |
| `block` | `Block` | direct |
| `cylinder` (center/height form) | `Cylinder` | direct |
| `cylinder` (two-point form) | oriented `Cylinder` | direct |
| `cylinderBetween` | oriented `Cylinder` | direct |
| `ellipsoid` | non-uniform `Ball` | direct, pending Studio visual verification |
| `panel` | thin `Block` | direct |
| `disc` | short `Cylinder` | direct |
| `boxBetween` | oriented `Block` | direct |
| `taperedCylinder` | cylinder using the largest supplied radius | approximation |
| `capsule` | ball or cylinder chosen from endpoint bounds | approximation |
| `regularPrism` | cylinder | approximation |
| `triangle` | oriented bounding block around three points | approximation |
| `quad` | oriented bounding block around four points | approximation |
| `polyline` | model containing one block or cylinder per non-degenerate segment | composite |
| `arc` | sampled arc joined by polyline segments | composite |
| `ring` | sampled circle joined by a closed polyline | composite |

Compatibility aliases currently include:

- `strutFromTwoPoints` -> `boxBetween`
- `triangularPrismFromThreePoints` -> `triangle`
- `quadFromFourPoints` -> `quad`

## Current MathUtils API

| Function | Purpose |
| --- | --- |
| `lerp` | interpolate a number |
| `lerpVector3` | interpolate a `Vector3` |
| `lerpColor` | interpolate a `Color3` |
| `pointOnCubicBezier` | evaluate one cubic Bezier point |
| `pointOnQuadraticBezier` | evaluate one quadratic Bezier point |
| `pointsOnCubicBezier` | sample a cubic Bezier curve |
| `polarToCartesian` | calculate a point in the `XY`, `XZ`, or `YZ` plane |
| `deriveSeed` | derive a deterministic integer seed for a named scope |
| `random` | create an independent deterministic random stream |
| `pointsOnLine` | return evenly spaced line points, including both endpoints |
| `pointsOnCircle` | return evenly spaced points without duplicating the first point |
| `pointsOnArc` | return arc points in radians, including both endpoints |
| `pointsOnEllipse` | return evenly spaced ellipse points |
| `pointsOnGrid` | return grid points with the column index changing fastest |
| `pointsOnHelix` | return helix points centered along an arbitrary axis |
| `segmentsFromPoints` | return named `startPoint`/`endPoint` segment records |
| `frameBetween` | orient a local axis along a segment at its midpoint |
| `frameFromNormal` | orient local Y to a surface normal at a position |
| `rotateAroundAxis` | rotate a point around an arbitrary axis in radians |
| `mirrorPoint` | reflect a point across a plane |
| `transformPoints` | transform local points through a `CFrame` |
| `projectOnPlane` | remove a vector's component along a plane normal |
| `forEachPointOnLine` | invoke a callback for evenly spaced line points |
| `forEachPointOnCircle` | invoke a callback for evenly spaced circle points |
| `forEachSegmentOnCircle` | invoke a callback for each closed circle segment |

The older Bezier and array-oriented names remain compatibility aliases. New
scripts should use the names in this table.

## Prioritized roadmap

### P0.1: Pure point generation (implemented)

Add pure functions before adding more callback or compound helpers.

```lua
MU.pointsOnLine(startPoint, endPoint, count)
MU.pointsOnCircle(center, radius, count, axis)
MU.pointsOnArc(center, radius, startAngle, endAngle, count, axis)
MU.pointsOnEllipse(center, radiusX, radiusY, count, axis)
MU.segmentsFromPoints(points, closed)
```

Current behavior:

- return new arrays without creating instances
- use radians for angles
- include both endpoints for line and arc sampling
- avoid duplicating the first point at the end of a closed circle
- define `count` consistently as the number of returned points
- reject counts below the minimum required by the operation
- support arbitrary finite axes for circle and arc sampling
- accept at most 20,000 returned points per call
- require integer counts: line/arc use a minimum of 2, circle/ellipse use 3
- require positive radii and finite, non-zero axes
- reject identical line endpoints, zero-span arcs, and degenerate segments

`segmentsFromPoints` returns records shaped as
`{ startPoint = points[i], endPoint = points[i + 1] }`. With `closed = true`,
it adds the final-to-first segment and requires at least three points; open input
requires at least two points.

Existing `forEachPointOnLine`, `forEachPointOnCircle`, and
`forEachSegmentOnCircle` should become wrappers over these pure functions.

### P0.2: Orientation and transforms (implemented)

```lua
MU.frameBetween(startPoint, endPoint, localAxis, up)
MU.frameFromNormal(position, normal, up)
MU.rotateAroundAxis(point, pivot, axis, angle)
MU.mirrorPoint(point, planePoint, planeNormal)
MU.transformPoints(points, cframe)
MU.projectOnPlane(vector, normal)
```

`frameBetween` is the shared orientation primitive for `boxBetween`,
`cylinderBetween`, and all segment-based compound geometry. The implementation
should consolidate the private X-axis and Y-axis alignment logic currently held
by the shim.

`frameBetween` places the frame at the segment midpoint and maps `localAxis` to
`startPoint -> endPoint`. `frameFromNormal` places the frame at `position` and
maps local Y to `normal`. Both reject zero directions, zero local axes, and zero
up vectors. The requested up vector is projected onto the direction's plane. If
they are parallel, the implementation deterministically tries world Y, negative
world X, then world Z. The established Y-axis cylinder Euler convention is
preserved for compatibility.

`transformPoints` treats each input point as local to the supplied `CFrame` and
returns a new world-space array. `rotateAroundAxis` uses radians. Plane normals
and rotation axes must be finite and non-zero.

### P0.3: Direct-part geometry (implemented)

```lua
GP.cylinderBetween(name, startPoint, endPoint, radius, options)
GP.ellipsoid(name, centerOrCFrame, size, options)
GP.panel(name, centerOrCFrame, width, height, thickness, options)
GP.disc(name, centerOrCFrame, radius, thickness, options)
```

Representation:

- `cylinderBetween` -> oriented `Cylinder`
- `ellipsoid` -> `Ball` with non-uniform `Size`
- `panel` -> thin `Block`
- `disc` -> short `Cylinder`

The existing two-point `cylinder` form remains a compatibility path, while new
scripts use `cylinderBetween`. Non-uniform `Ball` behavior must be visually
verified in Studio before `ellipsoid` is classified as fully direct.

For `panel`, local X is width, local Y is height, and local Z is thickness. For
`disc`, local Y is thickness. New direct-part options support `color`,
`material`, `parent`, `transparency`, `canCollide`, `canQuery`, `canTouch`,
`castShadow`, `anchored`, and the other lower-camel-case Part overrides exposed
by the shim. Sizes and radii must be positive, and `cylinderBetween` rejects
coincident endpoints. Options are strictly validated before instance creation:
unknown keys, property-style casing such as `Parent`, invalid value types, and
out-of-range transparency or reflectance values cause an actionable error.

### P1.1: Polyline composition (implemented)

```lua
GP.polyline(name, points, thickness, options)
```

Recommended options:

```lua
{
	segmentShape = "Cylinder", -- "Cylinder" or "Block"
	closed = false,
	color = color,
	material = "Metal",
	parent = model,
}
```

The helper returns a `Model` containing one part per non-degenerate segment.
It uses `cylinderBetween` for cylinder segments and `boxBetween` for block
segments. Segment names must be deterministic and derived from the supplied root
name and one-based segment index.

Current behavior:

- `thickness` is the cylinder diameter or the square block cross-section size
- `segmentShape` defaults to `"Cylinder"`; `closed` defaults to `false`
- open input requires at least two points and closed input requires at least three
- finite coincident consecutive points are allowed and skipped explicitly
- emitted segments receive contiguous names `<name>_1`, `<name>_2`, and so on
- all direct-part style options are copied to every segment, while `parent`
  parents the returned model
- input accepts at most 20,000 points and output accepts at most 4,999 segment
  parts, so a standalone polyline model stays within the default 5,000-node
  runtime limit
- node cost is one `Model` plus one `Part` per non-degenerate segment

### P1.2: Arc and ring composition (implemented)

```lua
GP.arc(name, center, radius, startAngle, endAngle, options)
GP.ring(name, center, radius, options)
```

Both helpers are thin compositions:

- `arc` -> `pointsOnArc` + `polyline`
- `ring` -> `pointsOnCircle` + closed `polyline`

Options must include `segments`, `axis`, and the polyline style options. These
helpers must not claim to produce a continuous torus or curved mesh.

Current behavior:

- `options.thickness`, `options.segments`, and `options.axis` are required
- `segments` is the exact number of generated parts; arc accepts at least one
  and ring accepts at least three
- both reject more than 4,999 segments and sampling choices that would make any
  requested segment degenerate
- `axis` may be any finite, non-zero vector and angles use radians
- `segmentShape` defaults to `"Cylinder"` and may be `"Block"`
- `arc` is always open and `ring` is always closed
- node cost is one `Model` plus exactly `options.segments` parts
- the result is a sampled, faceted composition rather than a continuous torus
  or curved mesh

### P1.3: Repeated layouts (implemented)

```lua
MU.pointsOnGrid(origin, columns, rows, columnStep, rowStep)
MU.pointsOnHelix(center, radius, height, turns, count, axis)
```

These remain pure math functions. Scripts may feed their results into existing
primitives or `polyline`. A geometry-specific `grid` or `helix` wrapper should
only be added after repeated call sites demonstrate a stable need.

Current behavior:

- `pointsOnGrid` treats `origin` as the first point and returns rows in order,
  with the column index changing fastest
- grid dimensions are positive integers, both step vectors must be finite and
  non-zero, and `columns * rows` must not exceed 20,000
- `pointsOnHelix` treats `center` as the midpoint of the helix height and
  includes the endpoints at `-height / 2` and `height / 2` along `axis`
- helix radius is positive; height and turns are finite and non-zero, with
  negative values supported to reverse their respective directions
- helix count is the number of returned points, with a minimum of two and a
  maximum of 20,000; its axis must be finite and non-zero

### P2.1: Deterministic random authoring (implemented)

```lua
MU.deriveSeed(seed, scope)
MU.random(seed)
```

`random` returns an independent stream with these methods:

```lua
local terrainRng = MU.random(MU.deriveSeed(seed, "terrain"))

terrainRng:nextNumber(minimum, maximum) -- half-open [minimum, maximum)
terrainRng:nextInteger(minimum, maximum) -- inclusive integer bounds
terrainRng:choice(items)
terrainRng:shuffle(items) -- returns a new array
```

Current behavior:

- every stream requires an explicit safe-integer seed and never reads or
  modifies the global `math.random` state
- the Park-Miller stream and seed-derivation algorithm are stable runtime
  contracts, so identical seeds and call order reproduce identical results
- `deriveSeed` requires a non-empty string scope; separate scopes such as
  `"terrain"`, `"props"`, and `"enemies"` isolate map-generation sequences
- `nextNumber` accepts finite bounds and returns a value in the half-open range
- `nextInteger` accepts inclusive safe-integer bounds and uses rejection
  sampling; a requested range may contain at most 2,147,483,646 values
- `choice` requires a non-empty dense array; `shuffle` accepts a dense array and
  returns a new Fisher-Yates-shuffled array without modifying its input
- choice and shuffle inputs accept at most 20,000 items
- streams are call-order-sensitive; derive separate scoped seeds when adding a
  random call in one map subsystem must not perturb another subsystem
- these helpers are deterministic authoring utilities, not cryptographic random
  generators

### P2.2: Numeric authoring helpers

```lua
MU.remap(value, fromMin, fromMax, toMin, toMax)
MU.smoothstep(edge0, edge1, value)
MU.average(points)
MU.bounds(points)
MU.clampLength(vector, maxLength)
```

These helpers reduce repeated sizing and normalization code but do not block the
P0 or P1 geometry work.

## Implementation order

1. [complete] `pointsOnLine`, `pointsOnCircle`, `pointsOnArc`, `pointsOnEllipse`
2. [complete] `segmentsFromPoints`
3. [complete] `frameBetween` and transform helpers
4. [complete] `cylinderBetween`, `ellipsoid`, `panel`, `disc`
5. [complete] `polyline`
6. [complete] `arc` and `ring`
7. [complete] grid and helix point generation
8. [complete] deterministic random authoring
9. numeric authoring helpers

This order keeps higher-level geometry dependent on tested pure math and one
shared orientation implementation.

## Deferred until the output schema expands

Do not prioritize exact APIs for:

- wedge or corner wedge
- cone or frustum
- pyramid
- torus or hollow cylinder
- arbitrary polygon faces
- exact triangular or quadrilateral prisms
- boolean union, subtraction, or intersection
- arbitrary procedural meshes

Existing approximation helpers may remain for compatibility, but documentation
and generated scripts must not present their output as exact geometry.

## Compatibility and migration

When introducing the roadmap APIs:

1. add the new canonical function
2. implement older behavior through the canonical function when semantics match
3. retain the old name as an alias
4. update examples and the procedural skill to use the canonical name
5. add a runtime test for both canonical behavior and alias presence
6. remove an alias only through an explicit breaking-change decision

Long positional signatures should migrate toward required geometry arguments
plus a final `options` table. Existing positional signatures remain supported
during the compatibility period.

## Acceptance checklist

Every new helper must satisfy the applicable checks:

- emits only `Model` and supported `Part` nodes
- emits only `Block`, `Ball`, or `Cylinder` shapes
- returns deterministic output for identical inputs
- rejects non-finite vectors and numbers
- handles or rejects degenerate geometry explicitly
- has predictable node cost documented for composite geometry
- stays within procedural node and output limits
- normalizes material values through the existing shim path
- includes runtime tests for representative axes and mirrored directions
- includes tests for minimum, normal, and rejected segment counts
- updates this guide and the procedural agent skill
