// @summary Tests the Luau-backed OVERDARE procedural dummy JSON runtime.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateProceduralDummyJson, resolveLuauExecutable, runProceduralScript } from "../../src/procedural";
import { extractProceduralScriptMetadata } from "../../src/procedural/script-metadata";
import type {
  ProceduralGeneratedNode,
  ProceduralPartProperties,
  ProceduralSceneNode,
} from "../../src/procedural/types";

const sampleScript = `--!strict
-- generationId: test-bunny-001
local GP = require(script.Dependencies.GeometryPrimitives)

local Bunny = {}

Bunny.OnGenerate = function(parameters, targetContainer)
	local model = GP.model("Bunny", nil)
	GP.sphere("Body", Vector3.new(0, 2, 0), 2, Color3.fromRGB(245, 175, 185), "SmoothPlastic", model)
	GP.block("Pedestal", Vector3.new(0, 0, 0), Vector3.new(4, 1, 4), Color3.fromRGB(80, 80, 80), "Metal", model)
	GP.cylinder("Tail", Vector3.new(0, 2, 2), 1, 0.5, Color3.new(1, 1, 1), "SmoothPlastic", model)
	GP.taperedCylinder("DummyLeg", Vector3.new(0, 1, 0), Vector3.new(0, 0, 0), 1, 0.5, Color3.fromRGB(245, 175, 185), "SmoothPlastic", model)
	model.Parent = targetContainer
end

return Bunny
`;

const parameters = {
  Size: { X: 10, Y: 10, Z: 10 },
  Attributes: {},
};

const rabbitExampleScript = readFileSync(join(import.meta.dir, "../../src/procedural/examples/rabbit.lua"), "utf8");

const vectorShimScript = `--!strict
-- generationId: vector-shim-001
local GP = require(script.Dependencies.GeometryPrimitives)

local VectorShim = {}

VectorShim.OnGenerate = function(parameters, targetContainer)
	local model = GP.model("VectorShim", nil)
	local startPoint = Vector3.new(0, 0, 0)
	local endPoint = Vector3.new(3, 4, 0)
	local midpoint = startPoint:Lerp(endPoint, 0.5)
	local score = endPoint:Dot(Vector3.yAxis)
	local basis = CFrame.fromMatrix(midpoint, Vector3.xAxis, Vector3.yAxis)
	GP.block("BasisBlock", basis, Vector3.new(score, 1, 1), Color3.fromRGB(10, 20, 30), "Metal", model)
	GP.boxBetween("DiagonalStrut", startPoint, endPoint, 0.5, 1, Color3.fromRGB(30, 40, 50), "Metal", model)
	model.Parent = targetContainer
end

return VectorShim
`;

const quadPlaneScript = `--!strict
-- generationId: quad-plane-001
local GP = require(script.Dependencies.GeometryPrimitives)

local QuadPlane = {}

QuadPlane.OnGenerate = function(parameters, targetContainer)
	local model = GP.model("QuadPlane", nil)
	GP.quad("VerticalGateSide", Vector3.new(100, 0, 0), Vector3.new(500, 0, 0), Vector3.new(500, 300, 0), Vector3.new(100, 300, 0), 30, nil, Color3.fromRGB(220, 220, 220), "Rock", model)
	GP.quad("SlopedVerticalGateSide", Vector3.new(100, 120, 0), Vector3.new(500, 260, 0), Vector3.new(500, 350, 0), Vector3.new(100, 260, 0), 30, nil, Color3.fromRGB(220, 220, 220), "Rock", model)
	model.Parent = targetContainer
end

return QuadPlane
`;

const physicsPropertiesScript = `--!strict
-- generationId: physics-properties-001
local GP = require(script.Dependencies.GeometryPrimitives)

local PhysicsProperties = {}

PhysicsProperties.OnGenerate = function(parameters, targetContainer)
	local model = GP.model("PhysicsProperties", nil)
	local blocker = GP.block("DecorativeMarker", Vector3.new(0, 0, 0), Vector3.new(1, 1, 1), Color3.fromRGB(255, 0, 0), "Neon", model)
	blocker.CanCollide = false
	blocker.CanQuery = false
	blocker.CanTouch = false
	blocker.Transparency = 0.35

	local primitive = GP.cylinder("PrimitiveMarker", Vector3.new(0, 0, 0), Vector3.new(0, 2, 0), 0.5, Color3.fromRGB(0, 255, 0), "Neon", model)
	primitive.CanCollide = false
	primitive.CanQuery = false
	primitive.CanTouch = false
	primitive.CastShadow = false
	model.Parent = targetContainer
end

return PhysicsProperties
`;

const yAxisCylinderScript = `--!strict
-- generationId: y-axis-cylinder-001
local GP = require(script.Dependencies.GeometryPrimitives)

local YAxisCylinder = {}

YAxisCylinder.OnGenerate = function(parameters, targetContainer)
	local model = GP.model("YAxisCylinder", nil)
	GP.cylinder("RightRisingWhisker", Vector3.new(0, 0, 0), Vector3.new(10, 2, 0), 1, Color3.fromRGB(70, 70, 75), "Basic", model)
	GP.cylinder("LeftRisingWhisker", Vector3.new(0, 0, 0), Vector3.new(-10, 2, 0), 1, Color3.fromRGB(70, 70, 75), "Basic", model)
	GP.cylinder("ForwardCylinder", Vector3.new(0, 0, 0), Vector3.new(0, 0, 10), 1, Color3.fromRGB(70, 70, 75), "Basic", model)
	model.Parent = targetContainer
end

return YAxisCylinder
`;

const capsuleApproximationScript = `--!strict
-- generationId: capsule-approximation-001
local GP = require(script.Dependencies.GeometryPrimitives)

local CapsuleApproximation = {}

CapsuleApproximation.OnGenerate = function(parameters, targetContainer)
	local model = GP.model("CapsuleApproximation", nil)
	GP.capsule("EqualCapsule", Vector3.new(0, 0, 0), 2, Vector3.new(0, 10, 0), 2, Color3.fromRGB(200, 200, 200), "Fabric", model)
	GP.capsule("WideStartCapsule", Vector3.new(0, 0, 0), 3, Vector3.new(0, 10, 0), 1, Color3.fromRGB(200, 200, 200), "Fabric", model)
	GP.capsule("WideEndCapsule", Vector3.new(0, 0, 0), 1, Vector3.new(0, 10, 0), 3, Color3.fromRGB(200, 200, 200), "Fabric", model)
	model.Parent = targetContainer
end

return CapsuleApproximation
`;

const miniColosseumScript = `--!strict
-- generationId: mini-colosseum-001
local GP = require(script.Dependencies.GeometryPrimitives)

local MiniColosseum = {}

MiniColosseum.OnGenerate = function(parameters, targetContainer)
	local colosseum = GP.model("MiniColosseum", nil)
	colosseum.WorldPivot = CFrame.identity

	local wallGroup = GP.model("OuterWall", colosseum)
	local temp = GP.model("ScratchTemp", nil)
	local stoneColor = parameters.Attributes.StoneColor or Color3.fromRGB(205, 185, 155)
	local trimColor = parameters.Attributes.TrimColor or Color3.fromRGB(185, 165, 135)
	local wallThickness = parameters.Attributes.WallThickness or 3

	local a = parameters.Size.X / 2
	local b = parameters.Size.Z / 2
	local theta1 = 0
	local theta2 = math.pi / 4

	local function ellipse(theta, y)
		return Vector3.new(a * math.cos(theta), y, b * math.sin(theta))
	end

	local wallS = ellipse(theta1, parameters.Size.Y / 2)
	local wallE = ellipse(theta2, parameters.Size.Y / 2)
	-- OVERDARE has no CSG, so the wall is a solid segment (no carved arch).
	GP.boxBetween("WallSeg_0", wallS, wallE, wallThickness, parameters.Size.Y, stoneColor, "Sandstone", wallGroup)

	-- Scratch part built in a temp container and destroyed before serialization.
	local scratch = GP.block("Scratch_0", Vector3.new(0, 0, 0), Vector3.new(1, 1, 1), Color3.new(1, 0, 0), "Plastic", temp)
	scratch:Destroy()

	GP.cylinder("Column_0", ellipse(theta1, 0), ellipse(theta1, parameters.Size.Y), wallThickness * 0.6, trimColor, "Sandstone", wallGroup)
	GP.triangle("ArenaSand_0", Vector3.new(0, 0, 0), ellipse(theta1, 0), ellipse(theta2, 0), 1, Vector3.yAxis, stoneColor, "Sand", colosseum)
	GP.quad("Seat_0_1", ellipse(theta1, 1), ellipse(theta2, 1), ellipse(theta2, 2), ellipse(theta1, 2), 1, nil, stoneColor, "Sandstone", colosseum)

	temp:Destroy()
	colosseum.Parent = targetContainer
	for _, part in targetContainer:GetDescendants() do
		if part:IsA("BasePart") then
			part.CFrame -= Vector3.yAxis * parameters.Size.Y / 2
		end
	end
	for _, model in targetContainer:GetDescendants() do
		if model:IsA("Model") then
			model.WorldPivot -= Vector3.yAxis * parameters.Size.Y / 2
		end
	end
end

return MiniColosseum
`;

const mathUtilsScript = `--!strict
-- generationId: math-utils-001
local GP = require(script.Dependencies.GeometryPrimitives)
local MU = require(script.Dependencies.MathUtils)

local MathUtilsDemo = {}

MathUtilsDemo.OnGenerate = function(parameters, targetContainer)
	local model = GP.model("MathUtilsDemo", nil)
	if GP.strutFromTwoPoints ~= GP.boxBetween or GP.triangularPrismFromThreePoints ~= GP.triangle or GP.quadFromFourPoints ~= GP.quad then
		error("GeometryPrimitives compatibility aliases are missing")
	end
	if MU.bezier ~= MU.pointOnCubicBezier or MU.quadraticBezier ~= MU.pointOnQuadraticBezier or MU.sampleBezierPoints ~= MU.pointsOnCubicBezier or MU.linearArray ~= MU.forEachPointOnLine or MU.radialArray ~= MU.forEachPointOnCircle or MU.radialArrayConnected ~= MU.forEachSegmentOnCircle then
		error("MathUtils compatibility aliases are missing")
	end

	-- lerp (number), lerpVector3, and lerpColor (0-255 channels) all interoperate
	-- with the Vector3/Color3 globals and GP helpers.
	local mid = MU.lerpVector3(Vector3.new(0, 0, 0), Vector3.new(10, 20, 0), 0.5)
	local blended = MU.lerpColor(Color3.fromRGB(0, 0, 0), Color3.fromRGB(200, 100, 40), 0.5)
	GP.sphere("Mid", mid, MU.lerp(1, 5, 0.5), blended, "Plastic", model)

	-- The callback name makes it explicit that positions are visited, not returned.
	MU.forEachPointOnCircle(Vector3.new(0, 0, 0), 10, 4, Vector3.yAxis, function(pos, i)
		GP.sphere("Ring_" .. i, pos, 1, Color3.fromRGB(255, 255, 255), "Plastic", model)
	end)

	model.Parent = targetContainer
end

return MathUtilsDemo
`;

const p0GeometryMathScript = `--!strict
-- generationId: p0-geometry-math-001
local GP = require(script.Dependencies.GeometryPrimitives)
local MU = require(script.Dependencies.MathUtils)

local P0GeometryMath = {}

local function near(actual, expected)
	return math.abs(actual - expected) < 0.000001
end

local function assertVector(actual, expected, label)
	if not near(actual.X, expected.X) or not near(actual.Y, expected.Y) or not near(actual.Z, expected.Z) then
		error(label .. " did not match")
	end
end

local function assertRejects(callback, label)
	local ok = pcall(callback)
	if ok then
		error(label .. " should reject invalid input")
	end
end

P0GeometryMath.OnGenerate = function(parameters, targetContainer)
	local line = MU.pointsOnLine(Vector3.new(-2, 1, 3), Vector3.new(4, 7, 9), 4)
	if #line ~= 4 then error("pointsOnLine count mismatch") end
	assertVector(line[1], Vector3.new(-2, 1, 3), "line start")
	assertVector(line[4], Vector3.new(4, 7, 9), "line end")

	local arbitraryAxis = Vector3.new(1, 1, 0)
	local circle = MU.pointsOnCircle(Vector3.new(2, 3, 4), 5, 5, arbitraryAxis)
	if #circle ~= 5 then error("pointsOnCircle count mismatch") end
	for _, point in ipairs(circle) do
		local offset = point - Vector3.new(2, 3, 4)
		if not near(offset.Magnitude, 5) or not near(offset:Dot(arbitraryAxis.Unit), 0) then
			error("pointsOnCircle left its plane")
		end
	end
	if (circle[1] - circle[#circle]).Magnitude < 0.000001 then error("circle duplicated its first point") end

	local arc = MU.pointsOnArc(Vector3.zero, 2, 0, math.pi, 3, Vector3.yAxis)
	if #arc ~= 3 then error("pointsOnArc count mismatch") end
	assertVector(arc[1], Vector3.new(2, 0, 0), "arc start")
	assertVector(arc[3], Vector3.new(-2, 0, 0), "arc end")

	local ellipse = MU.pointsOnEllipse(Vector3.zero, 3, 2, 4, Vector3.zAxis)
	if #ellipse ~= 4 then error("pointsOnEllipse count mismatch") end
	for _, point in ipairs(ellipse) do
		if not near(point.Z, 0) then error("ellipse left its plane") end
	end

	local openSegments = MU.segmentsFromPoints(line, false)
	local closedSegments = MU.segmentsFromPoints(circle, true)
	if #openSegments ~= 3 or #closedSegments ~= 5 then error("segment count mismatch") end
	assertVector(openSegments[1].startPoint, line[1], "open segment start")
	assertVector(openSegments[1].endPoint, line[2], "open segment end")
	assertVector(closedSegments[5].endPoint, circle[1], "closed segment end")

	local frame = MU.frameBetween(Vector3.zero, Vector3.new(0, 0, 10), Vector3.xAxis, Vector3.zAxis)
	local transformed = MU.transformPoints({ Vector3.new(2, 0, 0) }, frame)
	assertVector(transformed[1], Vector3.new(0, 0, 7), "frameBetween/transformPoints")
	local normalFrame = MU.frameFromNormal(Vector3.new(1, 2, 3), Vector3.yAxis, Vector3.yAxis)
	assertVector(MU.transformPoints({ Vector3.new(0, 2, 0) }, normalFrame)[1], Vector3.new(1, 4, 3), "frameFromNormal fallback")
	assertVector(MU.rotateAroundAxis(Vector3.xAxis, Vector3.zero, Vector3.yAxis, math.pi / 2), Vector3.new(0, 0, -1), "rotateAroundAxis")
	assertVector(MU.mirrorPoint(Vector3.new(1, 2, 3), Vector3.zero, Vector3.yAxis), Vector3.new(1, -2, 3), "mirrorPoint")
	assertVector(MU.projectOnPlane(Vector3.new(1, 2, 3), Vector3.yAxis), Vector3.new(1, 0, 3), "projectOnPlane")

	assertRejects(function() MU.pointsOnLine(Vector3.zero, Vector3.xAxis, 1) end, "line count")
	assertRejects(function() MU.pointsOnLine(Vector3.zero, Vector3.xAxis, 2.5) end, "fractional count")
	assertRejects(function() MU.pointsOnCircle(Vector3.zero, 1, 20001, Vector3.yAxis) end, "excessive count")
	assertRejects(function() MU.pointsOnCircle(Vector3.zero, 1, 2, Vector3.yAxis) end, "circle count")
	assertRejects(function() MU.pointsOnArc(Vector3.zero, 1, 0, 1, 1, Vector3.yAxis) end, "arc count")
	assertRejects(function() MU.pointsOnEllipse(Vector3.zero, 1, 1, 2, Vector3.yAxis) end, "ellipse count")
	assertRejects(function() MU.pointsOnCircle(Vector3.zero, 1, 3, Vector3.zero) end, "zero axis")
	assertRejects(function() MU.pointsOnCircle(Vector3.zero, 1, 3, Vector3.new(math.huge, 0, 0)) end, "non-finite axis")
	assertRejects(function() MU.pointsOnLine(Vector3.zero, Vector3.zero, 2) end, "degenerate line")
	assertRejects(function() MU.pointsOnArc(Vector3.zero, 1, 1, 1, 2, Vector3.yAxis) end, "degenerate arc")
	assertRejects(function() MU.segmentsFromPoints({ Vector3.zero, Vector3.zero }, false) end, "degenerate segment")
	assertRejects(function() MU.frameBetween(Vector3.zero, Vector3.zero, Vector3.xAxis, Vector3.yAxis) end, "degenerate frame")
	assertRejects(function() GP.cylinderBetween("Bad", Vector3.zero, Vector3.zero, 1, nil) end, "degenerate cylinder")
	assertRejects(function() GP.disc("Bad", Vector3.zero, 0, 1, nil) end, "zero-radius disc")
	assertRejects(function() GP.ellipsoid("Bad", Vector3.zero, Vector3.new(1, -1, 1), nil) end, "negative ellipsoid size")

	local model = GP.model("P0Geometry", nil)
	GP.cylinderBetween("DirectedCylinder", Vector3.new(0, 0, 0), Vector3.new(-10, 0, 0), 2, {
		color = Color3.fromRGB(10, 20, 30), material = "Metal", parent = model,
		transparency = 0.25, canCollide = false,
	})
	GP.ellipsoid("Ellipsoid", Vector3.new(1, 2, 3), Vector3.new(4, 6, 8), {
		color = Color3.fromRGB(40, 50, 60), material = "Neon", parent = model,
	})
	GP.panel("Panel", CFrame.new(5, 6, 7), 10, 20, 0.5, { parent = model })
	GP.disc("Disc", Vector3.new(-1, -2, -3), 4, 0.25, { parent = model })
	model.Parent = targetContainer
end

return P0GeometryMath
`;

async function hasLuauExecutable(): Promise<boolean> {
  try {
    await resolveLuauExecutable();
    return true;
  } catch {
    return false;
  }
}

function flattenNodeNames(nodes: ProceduralGeneratedNode[], depth = 0): string[] {
  return nodes.flatMap((node) => [
    `${"  ".repeat(depth)}${node.class}:${node.name}`,
    ...flattenNodeNames(node.children ?? [], depth + 1),
  ]);
}

function findNodeByName(nodes: ProceduralGeneratedNode[], name: string): ProceduralGeneratedNode | undefined {
  for (const node of nodes) {
    if (node.name === name) {
      return node;
    }
    const child = findNodeByName(node.children ?? [], name);
    if (child) {
      return child;
    }
  }
  return undefined;
}

function expectPartProperties(node: ProceduralGeneratedNode | undefined, name: string): ProceduralPartProperties {
  expect(node).toBeDefined();
  expect(node?.class).toBe("Part");
  if (!node || node.class !== "Part") {
    throw new Error(`Expected ${name} to be a Part node.`);
  }
  return node.properties as ProceduralPartProperties;
}

describe("procedural Luau dummy JSON runtime", () => {
  test("extracts generation metadata from Luau source", () => {
    expect(extractProceduralScriptMetadata(sampleScript)).toEqual({
      generationId: "test-bunny-001",
      scriptName: "Bunny",
    });
  });

  test("fails clearly when explicit Luau executable is unavailable", async () => {
    await expect(
      generateProceduralDummyJson({ scriptSource: sampleScript, parameters }, { luauBin: "/definitely/missing/luau" }),
    ).rejects.toThrow();
  });

  test("generates deterministic dummy JSON through Luau when available", async () => {
    if (!(await hasLuauExecutable())) {
      console.warn("Skipping Luau procedural generation test because no Luau executable is available.");
      return;
    }

    const first = await generateProceduralDummyJson({ scriptSource: sampleScript, parameters });
    const second = await generateProceduralDummyJson({ scriptSource: sampleScript, parameters });

    expect(first).toEqual(second);
    expect(first.kind).toBe("overdare.procedural-dummy-json");
    expect(first.generationId).toBe("test-bunny-001");
    expect(first.scriptName).toBe("Bunny");
    expect(flattenNodeNames(first.children)).toEqual([
      "Model:Bunny",
      "  Part:Body",
      "  Part:Pedestal",
      "  Part:Tail",
      "  Part:DummyLeg",
    ]);
    expect(first.children[0]).toEqual({
      class: "Model",
      name: "Bunny",
      properties: { WorldPivot: { Position: { X: 0, Y: 0, Z: 0 }, Orientation: { X: 0, Y: 0, Z: 0 } } },
      children: expect.any(Array),
    });
    expect(first.children[0]?.children?.[0]).toMatchObject({
      class: "Part",
      name: "Body",
      properties: { Shape: "Ball", Size: { X: 4, Y: 4, Z: 4 }, Anchored: true },
    });
    expect(first.children[0]?.children?.[3]).toMatchObject({
      class: "Part",
      name: "DummyLeg",
      properties: {
        Shape: "Cylinder",
        CFrame: { Position: { X: 0, Y: 0.5, Z: 0 }, Orientation: { X: 0, Y: 0, Z: 180 } },
        Size: { X: 2, Y: 1, Z: 2 },
        Anchored: true,
        Material: "Plastic",
      },
    });
  });

  test("supports Vector3 Dot/Lerp and CFrame.fromMatrix through Luau", async () => {
    const result = await generateProceduralDummyJson({ scriptSource: vectorShimScript, parameters });

    expect(flattenNodeNames(result.children)).toEqual([
      "Model:VectorShim",
      "  Part:BasisBlock",
      "  Part:DiagonalStrut",
    ]);
    expect(result.children[0]?.children?.[0]).toMatchObject({
      class: "Part",
      name: "BasisBlock",
      properties: {
        CFrame: { Position: { X: 1.5, Y: 2, Z: 0 }, Orientation: { X: 0, Y: 0, Z: 0 } },
        Size: { X: 4, Y: 1, Z: 1 },
      },
    });
    expect(result.children[0]?.children?.[1]).toMatchObject({
      class: "Part",
      name: "DiagonalStrut",
      properties: {
        CFrame: { Position: { X: 1.5, Y: 2, Z: 0 }, Orientation: { X: 0, Y: 0, Z: 53.13010235415598 } },
        Size: { X: 5, Y: 1, Z: 0.5 },
      },
    });
  });

  test("exposes MathUtils interpolation and layout helpers through Luau", async () => {
    const result = await generateProceduralDummyJson({ scriptSource: mathUtilsScript, parameters });

    expect(result.generationId).toBe("math-utils-001");
    expect(flattenNodeNames(result.children)).toEqual([
      "Model:MathUtilsDemo",
      "  Part:Mid",
      "  Part:Ring_1",
      "  Part:Ring_2",
      "  Part:Ring_3",
      "  Part:Ring_4",
    ]);

    // lerpVector3 midpoint, lerp radius (3 -> diameter 6), lerpColor 0-255 midpoint.
    expect(expectPartProperties(findNodeByName(result.children, "Mid"), "Mid")).toMatchObject({
      Shape: "Ball",
      CFrame: { Position: { X: 5, Y: 10, Z: 0 } },
      Size: { X: 6, Y: 6, Z: 6 },
      Color: { R: 100, G: 50, B: 20 },
    });

    // forEachPointOnCircle placements around the Y axis at radius 10.
    const ringPositions = ["Ring_1", "Ring_2", "Ring_3", "Ring_4"].map(
      (name) => expectPartProperties(findNodeByName(result.children, name), name).CFrame?.Position,
    );
    expect(ringPositions).toEqual([
      { X: 10, Y: 0, Z: 0 },
      { X: 0, Y: 0, Z: -10 },
      { X: -10, Y: 0, Z: 0 },
      { X: 0, Y: 0, Z: 10 },
    ]);
  });

  test("supports P0 point, transform, and direct-part geometry helpers", async () => {
    const result = await generateProceduralDummyJson({ scriptSource: p0GeometryMathScript, parameters });

    expect(flattenNodeNames(result.children)).toEqual([
      "Model:P0Geometry",
      "  Part:DirectedCylinder",
      "  Part:Ellipsoid",
      "  Part:Panel",
      "  Part:Disc",
    ]);
    expect(expectPartProperties(findNodeByName(result.children, "DirectedCylinder"), "DirectedCylinder")).toMatchObject(
      {
        Shape: "Cylinder",
        CFrame: { Position: { X: -5, Y: 0, Z: 0 } },
        Size: { X: 4, Y: 10, Z: 4 },
        Color: { R: 10, G: 20, B: 30 },
        Material: "Metal",
        Transparency: 0.25,
        CanCollide: false,
      },
    );
    expect(expectPartProperties(findNodeByName(result.children, "Ellipsoid"), "Ellipsoid")).toMatchObject({
      Shape: "Ball",
      CFrame: { Position: { X: 1, Y: 2, Z: 3 } },
      Size: { X: 4, Y: 6, Z: 8 },
      Color: { R: 40, G: 50, B: 60 },
      Material: "Neon",
    });
    expect(expectPartProperties(findNodeByName(result.children, "Panel"), "Panel")).toMatchObject({
      Shape: "Block",
      CFrame: { Position: { X: 5, Y: 6, Z: 7 } },
      Size: { X: 10, Y: 20, Z: 0.5 },
    });
    expect(expectPartProperties(findNodeByName(result.children, "Disc"), "Disc")).toMatchObject({
      Shape: "Cylinder",
      CFrame: { Position: { X: -1, Y: -2, Z: -3 } },
      Size: { X: 8, Y: 0.25, Z: 8 },
    });
  });

  test("keeps vertical quad planes upright with yaw-only orientation", async () => {
    const result = await generateProceduralDummyJson({ scriptSource: quadPlaneScript, parameters });

    const verticalGateSide = expectPartProperties(
      findNodeByName(result.children, "VerticalGateSide"),
      "VerticalGateSide",
    );
    expect(verticalGateSide.CFrame).toEqual({
      Position: { X: 300, Y: 150, Z: 0 },
      Orientation: { X: 0, Y: 0, Z: 0 },
    });
    expect(verticalGateSide.Size).toEqual({ X: 400, Y: 300, Z: 30 });

    const slopedVerticalGateSide = expectPartProperties(
      findNodeByName(result.children, "SlopedVerticalGateSide"),
      "SlopedVerticalGateSide",
    );
    expect(slopedVerticalGateSide.CFrame).toEqual({
      Position: { X: 300, Y: 235, Z: 0 },
      Orientation: { X: 0, Y: 0, Z: 0 },
    });
    expect(slopedVerticalGateSide.Size).toEqual({ X: 400, Y: 230, Z: 30 });
  });

  test("preserves explicit Part physics and visibility properties", async () => {
    const result = await generateProceduralDummyJson({ scriptSource: physicsPropertiesScript, parameters });

    expect(findNodeByName(result.children, "DecorativeMarker")).toMatchObject({
      class: "Part",
      properties: {
        CanCollide: false,
        CanQuery: false,
        CanTouch: false,
        Transparency: 0.35,
      },
    });
    expect(findNodeByName(result.children, "PrimitiveMarker")).toMatchObject({
      class: "Part",
      properties: {
        CanCollide: false,
        CanQuery: false,
        CanTouch: false,
        CastShadow: false,
      },
    });
  });

  test("serializes two-point cylinders with OVERDARE Y-axis orientation", async () => {
    const result = await generateProceduralDummyJson({ scriptSource: yAxisCylinderScript, parameters });

    const rightRisingWhisker = findNodeByName(result.children, "RightRisingWhisker");
    const leftRisingWhisker = findNodeByName(result.children, "LeftRisingWhisker");
    const forwardCylinder = findNodeByName(result.children, "ForwardCylinder");
    const rightRisingWhiskerProperties = expectPartProperties(rightRisingWhisker, "RightRisingWhisker");
    const leftRisingWhiskerProperties = expectPartProperties(leftRisingWhisker, "LeftRisingWhisker");

    expect(rightRisingWhisker).toMatchObject({
      class: "Part",
      properties: {
        Shape: "Cylinder",
        CFrame: { Position: { X: 5, Y: 1, Z: 0 } },
        Size: { X: 2, Y: Math.sqrt(104), Z: 2 },
      },
    });
    expect(leftRisingWhisker).toMatchObject({
      class: "Part",
      properties: {
        Shape: "Cylinder",
        CFrame: { Position: { X: -5, Y: 1, Z: 0 } },
        Size: { X: 2, Y: Math.sqrt(104), Z: 2 },
      },
    });
    expect(forwardCylinder).toMatchObject({
      class: "Part",
      properties: {
        Shape: "Cylinder",
        CFrame: { Position: { X: 0, Y: 0, Z: 5 }, Orientation: { X: 90, Y: 0, Z: 0 } },
        Size: { X: 2, Y: 10, Z: 2 },
      },
    });

    expect(rightRisingWhiskerProperties.CFrame?.Orientation.Z).toBeCloseTo(-78.69006752597979, 12);
    expect(leftRisingWhiskerProperties.CFrame?.Orientation.Z).toBeCloseTo(78.69006752597979, 12);
  });

  test("serializes capsule approximations with radius-aware bounds", async () => {
    const result = await generateProceduralDummyJson({ scriptSource: capsuleApproximationScript, parameters });

    expect(expectPartProperties(findNodeByName(result.children, "EqualCapsule"), "EqualCapsule")).toMatchObject({
      Shape: "Cylinder",
      CFrame: { Position: { X: 0, Y: 5, Z: 0 }, Orientation: { X: 0, Y: 0, Z: 0 } },
      Size: { X: 4, Y: 14, Z: 4 },
      Material: "Plastic",
    });
    expect(expectPartProperties(findNodeByName(result.children, "WideStartCapsule"), "WideStartCapsule")).toMatchObject(
      {
        Shape: "Cylinder",
        CFrame: { Position: { X: 0, Y: 4, Z: 0 }, Orientation: { X: 0, Y: 0, Z: 0 } },
        Size: { X: 6, Y: 14, Z: 6 },
        Material: "Plastic",
      },
    );
    expect(expectPartProperties(findNodeByName(result.children, "WideEndCapsule"), "WideEndCapsule")).toMatchObject({
      Shape: "Cylinder",
      CFrame: { Position: { X: 0, Y: 6, Z: 0 }, Orientation: { X: 0, Y: 0, Z: 0 } },
      Size: { X: 6, Y: 14, Z: 6 },
      Material: "Plastic",
    });
  });

  test("runs the rabbit example with capsule primitives", async () => {
    const result = await generateProceduralDummyJson({ scriptSource: rabbitExampleScript, parameters });

    expect(result.generationId).toBe("2456eb64-ed78-47ea-9410-9fd34fa25c6f");
    expect(flattenNodeNames(result.children)).toContain("Model:Rabbit");
    expect(flattenNodeNames(result.children)).toEqual(
      expect.arrayContaining([
        "  Model:Body",
        "    Part:TorsoMain",
        "    Part:Belly",
        "  Model:Head",
        "    Part:Cheeks",
        "    Model:LeftEar",
        "    Model:RightEar",
        "  Model:LeftLimbs",
        "    Part:FrontUpperLeg",
        "    Part:HindFoot",
        "  Model:RightLimbs",
        "    Part:FrontUpperLeg",
        "    Part:HindFoot",
      ]),
    );
    const rabbit = result.children[0];
    const body = rabbit?.children?.find((node) => node.name === "Body");
    expect(body?.children?.[0]).toMatchObject({
      class: "Part",
      name: "TorsoMain",
      properties: {
        Shape: "Cylinder",
        Anchored: true,
        Material: "Plastic",
      },
    });
  });

  test("supports colosseum-style vector math, destroy, and structural primitives", async () => {
    const result = await generateProceduralDummyJson({
      scriptSource: miniColosseumScript,
      parameters: {
        Size: { X: 40, Y: 20, Z: 30 },
        Attributes: {
          WallThickness: 3,
          StoneColor: { R: 205, G: 185, B: 155 },
        },
      },
    });

    expect(result.parameters.Attributes).toEqual({
      StoneColor: { R: 205, G: 185, B: 155 },
      WallThickness: 3,
    });
    expect(flattenNodeNames(result.children)).toEqual([
      "Model:MiniColosseum",
      "  Model:OuterWall",
      "    Part:WallSeg_0",
      "    Part:Column_0",
      "  Part:ArenaSand_0",
      "  Part:Seat_0_1",
    ]);
    const miniColosseum = result.children[0];
    const outerWall = miniColosseum?.children?.[0];
    expect(outerWall?.children?.[0]).toMatchObject({
      class: "Part",
      name: "WallSeg_0",
      properties: {
        Shape: "Block",
        CFrame: {
          Position: { X: 17.071067811865476, Y: 0, Z: 5.303300858899107 },
          Orientation: { X: 0, Y: -118.91120081841659, Z: 0 },
        },
        Size: { X: 12.116706444028509, Y: 20, Z: 3 },
        Anchored: true,
        Material: "Rock",
      },
    });
    expect(outerWall?.children?.[1]).toMatchObject({
      class: "Part",
      name: "Column_0",
      properties: {
        Shape: "Cylinder",
        CFrame: { Position: { X: 20, Y: 0, Z: 0 }, Orientation: { X: 0, Y: 0, Z: 0 } },
        Anchored: true,
        Material: "Rock",
      },
    });
    expect(miniColosseum?.children?.[1]).toMatchObject({
      class: "Part",
      name: "ArenaSand_0",
      properties: {
        Shape: "Block",
        CFrame: { Orientation: { X: 0, Y: 0, Z: 0 } },
        Material: "Ground",
      },
    });
    expect(miniColosseum?.children?.[2]).toMatchObject({
      class: "Part",
      name: "Seat_0_1",
      properties: {
        Shape: "Block",
        CFrame: { Orientation: { X: 0, Y: -118.91120081841659, Z: 0 } },
        Material: "Rock",
      },
    });
  });

  test("rejects input that would overflow the argv transport limit", async () => {
    await expect(
      generateProceduralDummyJson({ scriptSource: sampleScript, parameters }, { limits: { maxInputBytes: 32 } }),
    ).rejects.toThrow(/transport limit/);
  });

  test("rejects output exceeding the max node count", async () => {
    await expect(
      generateProceduralDummyJson({ scriptSource: sampleScript, parameters }, { limits: { maxNodes: 1 } }),
    ).rejects.toThrow(/exceeds the maximum/);
  });

  test("kills a runaway script once the timeout elapses", async () => {
    const infiniteLoopScript = `-- generationId: infinite-001
local Spin = {}
Spin.OnGenerate = function(parameters, targetContainer)
	while true do end
end
return Spin
`;
    await expect(
      generateProceduralDummyJson({ scriptSource: infiniteLoopScript, parameters }, { limits: { timeoutMs: 300 } }),
    ).rejects.toThrow(/timed out/);
  });

  test("round-trips the large colosseum example through argv transport", async () => {
    const colosseumScript = readFileSync(join(import.meta.dir, "../../src/procedural/examples/colosseum.lua"), "utf8");
    const result = await generateProceduralDummyJson({ scriptSource: colosseumScript, parameters });
    expect(result.generationId).toBe("ad1c33ff-a538-40f3-a853-dc8609c21e5f");
    expect(result.children.length).toBeGreaterThan(0);
  });
});

const shiftTransformScript = `-- generationId: shift-x-001
local Shift = {}
Shift.OnGenerate = function(parameters, targetContainer)
	for _, inst in workspace:GetDescendants() do
		if inst:IsA("BasePart") then
			if inst.Name == "Doomed" then
				inst:Destroy()
			else
				inst.CFrame += Vector3.xAxis * 1
			end
		end
	end
	local GP = require(script.Dependencies.GeometryPrimitives)
	GP.sphere("Added", Vector3.new(0, 100, 0), 5, Color3.fromRGB(255, 0, 0), "Plastic", targetContainer)
end
return Shift
`;

function transformScene(): ProceduralSceneNode {
  const cframe = (x: number) => ({ Position: { X: x, Y: 0, Z: 0 }, Orientation: { X: 0, Y: 0, Z: 0 } });
  return {
    class: "Workspace",
    name: "Workspace",
    guid: "W",
    properties: {},
    children: [
      { class: "Part", name: "Keep", guid: "gKeep", properties: { CFrame: cframe(0) }, children: [] },
      { class: "Part", name: "Doomed", guid: "gDoomed", properties: { CFrame: cframe(5) }, children: [] },
    ],
  };
}

describe("runProceduralScript transform via scene injection", () => {
  test("derives update, delete, and add ops from a transform script", async () => {
    const result = await runProceduralScript({
      scriptSource: shiftTransformScript,
      parameters,
      scene: transformScene(),
      targetGuid: "W",
    });

    expect(result.generationId).toBe("shift-x-001");
    const update = result.ops.find((op) => op.kind === "update");
    expect(update).toMatchObject({ kind: "update", guid: "gKeep", properties: { CFrame: { Position: { X: 1 } } } });
    expect(result.ops).toContainEqual({ kind: "delete", guid: "gDoomed", depth: 1 });
    const add = result.ops.find((op) => op.kind === "add");
    expect(add).toMatchObject({
      kind: "add",
      parentGuid: "W",
      node: { class: "Part", name: "Added", properties: { Shape: "Ball" } },
    });
  });

  test("generate-only run (no scene) produces add ops with the target as parent", async () => {
    const result = await runProceduralScript({ scriptSource: sampleScript, parameters, targetGuid: "TARGET" });
    expect(result.ops.every((op) => op.kind === "add")).toBe(true);
    expect(result.ops[0]).toMatchObject({ kind: "add", parentGuid: "TARGET", node: { class: "Model", name: "Bunny" } });
  });

  test("auto-generates a generationId for one-shot scripts lacking the comment", async () => {
    const noIdScript = `local Anon = {}
Anon.OnGenerate = function(parameters, targetContainer)
	local GP = require(script.Dependencies.GeometryPrimitives)
	GP.sphere("Ball", Vector3.new(0, 0, 0), 1, Color3.fromRGB(1, 2, 3), "Plastic", targetContainer)
end
return Anon
`;
    await expect(runProceduralScript({ scriptSource: noIdScript, parameters })).rejects.toThrow(/generationId/);
    const result = await runProceduralScript({ scriptSource: noIdScript, parameters, autoGenerationId: true });
    expect(result.generationId).toMatch(/[0-9a-f-]{36}/);
  });
});
