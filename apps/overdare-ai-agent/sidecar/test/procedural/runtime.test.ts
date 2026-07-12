// @summary Tests the Luau-backed OVERDARE procedural dummy JSON runtime.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_PROCEDURAL_LIMITS,
  generateProceduralDummyJson,
  resolveLuauExecutable,
  runProceduralScript,
} from "../../src/procedural";
import { extractProceduralScriptName } from "../../src/procedural/script-metadata";
import type {
  ProceduralGeneratedNode,
  ProceduralPartProperties,
  ProceduralSceneNode,
} from "../../src/procedural/types";

const sampleScript = `--!strict
local GP = require(script.Dependencies.GeometryPrimitives)

local Bunny = {}

Bunny.OnGenerate = function(parameters, targetContainer)
	local model = GP.model("Bunny", nil)
	GP.sphere("Body", Vector3.new(0, 2, 0), 2, Color3.fromRGB(245, 175, 185), "Plastic", model)
	GP.block("Pedestal", Vector3.new(0, 0, 0), Vector3.new(4, 1, 4), Color3.fromRGB(80, 80, 80), "Metal", model)
	GP.cylinder("Tail", Vector3.new(0, 2, 2), 1, 0.5, Color3.new(1, 1, 1), "Plastic", model)
	GP.taperedCylinder("DummyLeg", Vector3.new(0, 1, 0), Vector3.new(0, 0, 0), 1, 0.5, Color3.fromRGB(245, 175, 185), "Plastic", model)
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
local GP = require(script.Dependencies.GeometryPrimitives)

local PhysicsProperties = {}

PhysicsProperties.OnGenerate = function(parameters, targetContainer)
	local model = GP.model("PhysicsProperties", nil)
	local blocker = GP.block("DecorativeMarker", Vector3.new(0, 0, 0), Vector3.new(1, 1, 1), Color3.fromRGB(255, 0, 0), "Concrete", model)
	blocker.CanCollide = false
	blocker.CanQuery = false
	blocker.CanTouch = false
	blocker.Transparency = 0.35

	local primitive = GP.cylinder("PrimitiveMarker", Vector3.new(0, 0, 0), Vector3.new(0, 2, 0), 0.5, Color3.fromRGB(0, 255, 0), "Sand", model)
	primitive.CanCollide = false
	primitive.CanQuery = false
	primitive.CanTouch = false
	primitive.CastShadow = false
	primitive.Mobility = "Movable"
	model.Parent = targetContainer
end

return PhysicsProperties
`;

const yAxisCylinderScript = `--!strict
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
local GP = require(script.Dependencies.GeometryPrimitives)

local CapsuleApproximation = {}

CapsuleApproximation.OnGenerate = function(parameters, targetContainer)
	local model = GP.model("CapsuleApproximation", nil)
	local equalCapsule = GP.capsule("EqualCapsule", Vector3.new(0, 0, 0), 2, Vector3.new(0, 10, 0), 2, Color3.fromRGB(200, 200, 200), "FabricWeave", model)
	equalCapsule.Mobility = "Movable"
	GP.capsule("WideStartCapsule", Vector3.new(0, 0, 0), 3, Vector3.new(0, 10, 0), 1, Color3.fromRGB(200, 200, 200), "FabricWeave", model)
	GP.capsule("WideEndCapsule", Vector3.new(0, 0, 0), 1, Vector3.new(0, 10, 0), 3, Color3.fromRGB(200, 200, 200), "FabricWeave", model)
	model.Parent = targetContainer
end

return CapsuleApproximation
`;

const miniColosseumScript = `--!strict
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
	GP.boxBetween("WallSeg_0", wallS, wallE, wallThickness, parameters.Size.Y, stoneColor, "Rock", wallGroup)

	-- Scratch part built in a temp container and destroyed before serialization.
	local scratch = GP.block("Scratch_0", Vector3.new(0, 0, 0), Vector3.new(1, 1, 1), Color3.new(1, 0, 0), "Plastic", temp)
	scratch:Destroy()

	GP.cylinder("Column_0", ellipse(theta1, 0), ellipse(theta1, parameters.Size.Y), wallThickness * 0.6, trimColor, "Rock", wallGroup)
	GP.triangle("ArenaSand_0", Vector3.new(0, 0, 0), ellipse(theta1, 0), ellipse(theta2, 0), 1, Vector3.yAxis, stoneColor, "Sand", colosseum)
	GP.quad("Seat_0_1", ellipse(theta1, 1), ellipse(theta2, 1), ellipse(theta2, 2), ellipse(theta1, 2), 1, nil, stoneColor, "Rock", colosseum)

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
	assertRejects(function() GP.disc("Bad", Vector3.zero, 1, 1, { mystery = true }) end, "unknown option")
	assertRejects(function() GP.disc("Bad", Vector3.zero, 1, 1, { transparency = 2 }) end, "option range")
	assertRejects(function() GP.disc("Bad", Vector3.zero, 1, 1, { canCollide = "false" }) end, "option type")
	assertRejects(function() GP.disc("Bad", Vector3.zero, 1, 1, { parent = {} }) end, "option parent")

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

const p1GeometryMathScript = `--!strict
local GP = require(script.Dependencies.GeometryPrimitives)
local MU = require(script.Dependencies.MathUtils)

local P1GeometryMath = {}

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

P1GeometryMath.OnGenerate = function(parameters, targetContainer)
	local grid = MU.pointsOnGrid(
		Vector3.new(1, 2, 3),
		2,
		3,
		Vector3.new(10, 0, 0),
		Vector3.new(0, 0, -5)
	)
	if #grid ~= 6 then error("pointsOnGrid count mismatch") end
	assertVector(grid[1], Vector3.new(1, 2, 3), "grid origin")
	assertVector(grid[2], Vector3.new(11, 2, 3), "grid column order")
	assertVector(grid[3], Vector3.new(1, 2, -2), "grid row order")
	assertVector(grid[6], Vector3.new(11, 2, -7), "grid final point")
	local minimumGrid = MU.pointsOnGrid(Vector3.zero, 1, 1, Vector3.xAxis, Vector3.zAxis)
	if #minimumGrid ~= 1 then error("minimum pointsOnGrid count mismatch") end

	local helix = MU.pointsOnHelix(Vector3.zero, 2, 10, 1, 5, Vector3.yAxis)
	if #helix ~= 5 then error("pointsOnHelix count mismatch") end
	assertVector(helix[1], Vector3.new(2, -5, 0), "helix start")
	assertVector(helix[3], Vector3.new(-2, 0, 0), "helix midpoint")
	assertVector(helix[5], Vector3.new(2, 5, 0), "helix end")
	local mirroredHelix = MU.pointsOnHelix(Vector3.zero, 2, -10, -1, 5, -Vector3.yAxis)
	if #mirroredHelix ~= 5 then error("signed mirrored helix count mismatch") end
	local minimumHelix = MU.pointsOnHelix(Vector3.zero, 2, 1, 0.5, 2, Vector3.zAxis)
	if #minimumHelix ~= 2 then error("minimum pointsOnHelix count mismatch") end

	assertRejects(function() MU.pointsOnGrid(Vector3.zero, 0, 1, Vector3.xAxis, Vector3.zAxis) end, "zero grid columns")
	assertRejects(function() MU.pointsOnGrid(Vector3.zero, 1.5, 1, Vector3.xAxis, Vector3.zAxis) end, "fractional grid columns")
	assertRejects(function() MU.pointsOnGrid(Vector3.zero, 200, 101, Vector3.xAxis, Vector3.zAxis) end, "excessive grid points")
	assertRejects(function() MU.pointsOnGrid(Vector3.zero, 1, 1, Vector3.zero, Vector3.zAxis) end, "zero column step")
	assertRejects(function() MU.pointsOnHelix(Vector3.zero, 1, 1, 1, 1, Vector3.yAxis) end, "helix count")
	assertRejects(function() MU.pointsOnHelix(Vector3.zero, 1, 1, 1, 20001, Vector3.yAxis) end, "excessive helix count")
	assertRejects(function() MU.pointsOnHelix(Vector3.zero, 0, 1, 1, 2, Vector3.yAxis) end, "zero helix radius")
	assertRejects(function() MU.pointsOnHelix(Vector3.zero, 1, 0, 1, 2, Vector3.yAxis) end, "zero helix height")
	assertRejects(function() MU.pointsOnHelix(Vector3.zero, 1, 1, 0, 2, Vector3.yAxis) end, "zero helix turns")
	assertRejects(function() MU.pointsOnHelix(Vector3.zero, 1, 1, 1, 2, Vector3.zero) end, "zero helix axis")

	local tooManyPoints = {}
	for index = 1, 5001 do
		table.insert(tooManyPoints, Vector3.new(index, 0, 0))
	end
	assertRejects(function() GP.polyline("TooLarge", tooManyPoints, 1, nil) end, "polyline segment limit")
	assertRejects(function() GP.polyline("Bad", { Vector3.zero }, 1, nil) end, "polyline point count")
	assertRejects(function() GP.polyline("Bad", { Vector3.zero, Vector3.xAxis }, 0, nil) end, "polyline thickness")
	assertRejects(function() GP.polyline("Bad", { Vector3.zero, Vector3.xAxis }, 1, { segmentShape = "Ball" }) end, "polyline shape")
	assertRejects(function() GP.polyline("Bad", { Vector3.zero, Vector3.xAxis }, 1, { closed = true }) end, "closed polyline point count")
	assertRejects(function() GP.polyline("Bad", { Vector3.zero, Vector3.xAxis }, 1, { segments = 3 }) end, "polyline unknown option")
	assertRejects(function() GP.arc("Bad", Vector3.zero, 1, 0, math.pi, nil) end, "arc options")
	assertRejects(function() GP.arc("Bad", Vector3.zero, 1, 0, math.pi, { segments = 1, axis = Vector3.yAxis }) end, "arc thickness option")
	assertRejects(function() GP.arc("Bad", Vector3.zero, 1, 0, math.pi, { thickness = 1, axis = Vector3.yAxis }) end, "arc segments option")
	assertRejects(function() GP.arc("Bad", Vector3.zero, 1, 0, math.pi, { thickness = 1, segments = 1 }) end, "arc axis option")
	assertRejects(function() GP.arc("Bad", Vector3.zero, 1, 0, math.pi, { thickness = 1, segments = 0, axis = Vector3.yAxis }) end, "arc segment count")
	assertRejects(function() GP.arc("Bad", Vector3.zero, 1, 0, math.pi, { thickness = 1, segments = 5000, axis = Vector3.yAxis }) end, "arc segment limit")
	assertRejects(function() GP.arc("Bad", Vector3.zero, 1, 0, math.pi * 2, { thickness = 1, segments = 1, axis = Vector3.yAxis }) end, "degenerate arc sampling")
	assertRejects(function() GP.ring("Bad", Vector3.zero, 1, { thickness = 1, segments = 2, axis = Vector3.yAxis }) end, "ring segment count")
	assertRejects(function() GP.ring("Bad", Vector3.zero, 0.0000001, { thickness = 1, segments = 3, axis = Vector3.yAxis }) end, "degenerate ring sampling")
	local minimumPolyline = GP.polyline("MinimumPolyline", { Vector3.zero, Vector3.xAxis }, 1, nil)
	if #minimumPolyline.Children ~= 1 then error("minimum polyline segment count mismatch") end
	local minimumArc = GP.arc("MinimumArc", Vector3.zero, 1, 0, math.pi / 2, {
		thickness = 1, segments = 1, axis = Vector3.yAxis,
	})
	if #minimumArc.Children ~= 1 then error("minimum arc segment count mismatch") end

	local root = GP.model("P1Geometry", nil)
	GP.polyline("Route", {
		Vector3.zero,
		Vector3.new(10, 0, 0),
		Vector3.new(10, 0, 0),
		Vector3.new(10, 0, 10),
	}, 2, {
		color = Color3.fromRGB(10, 20, 30), material = "Metal", parent = root,
		canCollide = false,
	})
	GP.polyline("Triangle", {
		Vector3.new(0, 0, 0),
		Vector3.new(4, 0, 0),
		Vector3.new(0, 3, 0),
	}, 1, {
		segmentShape = "Block", closed = true, parent = root, castShadow = false,
	})
	GP.arc("Arch", Vector3.zero, 4, 0, math.pi, {
		thickness = 1, segments = 2, axis = Vector3.yAxis, parent = root,
	})
	GP.ring("Ring", Vector3.zero, 3, {
		thickness = 1, segments = 3, axis = -Vector3.zAxis,
		segmentShape = "Block", parent = root,
	})
	root.Parent = targetContainer
end

return P1GeometryMath
`;

const seededRandomScript = `--!strict
-- generationId: seeded-random-001
local GP = require(script.Dependencies.GeometryPrimitives)
local MU = require(script.Dependencies.MathUtils)

local SeededRandom = {}

local function assertRejects(callback, label)
	local ok = pcall(callback)
	if ok then
		error(label .. " should reject invalid input")
	end
end

SeededRandom.OnGenerate = function(parameters, targetContainer)
	local terrainSeed = MU.deriveSeed(12345, "terrain")
	local propsSeed = MU.deriveSeed(12345, "props")
	if terrainSeed ~= 1297138559 or propsSeed ~= 1493243482 then
		error("derived seed regression")
	end
	if terrainSeed == propsSeed or terrainSeed ~= MU.deriveSeed(12345, "terrain") then
		error("derived seeds are not deterministic and scoped")
	end

	local terrainRng = MU.random(terrainSeed)
	local replayRng = MU.random(terrainSeed)
	local model = GP.model("SeededRandom", nil)
	for index = 1, 4 do
		local x = terrainRng:nextInteger(-10, 10)
		local z = terrainRng:nextInteger(-10, 10)
		if x ~= replayRng:nextInteger(-10, 10) or z ~= replayRng:nextInteger(-10, 10) then
			error("same seed did not replay the same sequence")
		end
		GP.sphere("Sample_" .. index, Vector3.new(x, 0, z), 1, Color3.fromRGB(255, 255, 255), "Plastic", model)
	end

	local numberRng = MU.random(7)
	local sampledNumber = numberRng:nextNumber(-2.5, 4.5)
	if sampledNumber < -2.5 or sampledNumber >= 4.5 then
		error("nextNumber left its half-open range")
	end

	local choiceRng = MU.random(42)
	if choiceRng:choice({ "A", "B", "C" }) ~= "C" then
		error("choice regression")
	end
	local original = { 1, 2, 3, 4, 5 }
	local shuffled = MU.random(42):shuffle(original)
	if original[1] ~= 1 or original[2] ~= 2 or original[3] ~= 3 or original[4] ~= 4 or original[5] ~= 5 then
		error("shuffle mutated its input")
	end
	if shuffled[1] ~= 4 or shuffled[2] ~= 1 or shuffled[3] ~= 5 or shuffled[4] ~= 3 or shuffled[5] ~= 2 then
		error("shuffle regression")
	end

	assertRejects(function() MU.random(nil) end, "missing seed")
	assertRejects(function() MU.random(1.5) end, "fractional seed")
	assertRejects(function() MU.random(9007199254740992) end, "unsafe seed")
	assertRejects(function() MU.deriveSeed(1, "") end, "empty seed scope")
	assertRejects(function() MU.deriveSeed(1, 2) end, "non-string seed scope")
	assertRejects(function() MU.random(1):nextNumber(2, 2) end, "empty number range")
	assertRejects(function() MU.random(1):nextNumber(-math.huge, 2) end, "non-finite number range")
	assertRejects(function() MU.random(1):nextInteger(1.5, 2) end, "fractional integer range")
	assertRejects(function() MU.random(1):nextInteger(2, 1) end, "reversed integer range")
	assertRejects(function() MU.random(1):nextInteger(0, 2147483646) end, "oversized integer range")
	assertRejects(function() MU.random(1):choice({}) end, "empty choice")
	assertRejects(function() MU.random(1):choice({ [1] = "A", extra = "B" }) end, "non-array choice")
	assertRejects(function() MU.random(1):shuffle({ [1] = "A", [3] = "C" }) end, "sparse shuffle")

	model.Parent = targetContainer
end

return SeededRandom
`;

const invalidGeometryOptionsScript = `--!strict
local GP = require(script.Dependencies.GeometryPrimitives)

local InvalidGeometryOptions = {}

InvalidGeometryOptions.OnGenerate = function(parameters, targetContainer)
	local model = GP.model("InvalidGeometryOptions", nil)
	GP.disc("OrphanedDisc", Vector3.zero, 10, 1, {
		Color = Color3.fromRGB(255, 255, 255),
		Material = "Ground",
		Parent = model,
	})
	model.Parent = targetContainer
end

return InvalidGeometryOptions
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
  test("caps freshly generated output at 5,000 nodes by default", () => {
    expect(DEFAULT_PROCEDURAL_LIMITS.maxNodes).toBe(5_000);
  });

  test("extracts the script name from Luau source", () => {
    expect(extractProceduralScriptName(sampleScript)).toBe("Bunny");
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
    expect(first).not.toHaveProperty("generationId");
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
      localId: expect.any(String),
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

  test("supports P1 composite geometry and repeated-layout helpers", async () => {
    const result = await generateProceduralDummyJson({ scriptSource: p1GeometryMathScript, parameters });

    expect(flattenNodeNames(result.children)).toEqual([
      "Model:P1Geometry",
      "  Model:Route",
      "    Part:Route_1",
      "    Part:Route_2",
      "  Model:Triangle",
      "    Part:Triangle_1",
      "    Part:Triangle_2",
      "    Part:Triangle_3",
      "  Model:Arch",
      "    Part:Arch_1",
      "    Part:Arch_2",
      "  Model:Ring",
      "    Part:Ring_1",
      "    Part:Ring_2",
      "    Part:Ring_3",
    ]);
    expect(expectPartProperties(findNodeByName(result.children, "Route_1"), "Route_1")).toMatchObject({
      Shape: "Cylinder",
      CFrame: { Position: { X: 5, Y: 0, Z: 0 }, Orientation: { X: 0, Y: 0, Z: -90 } },
      Size: { X: 2, Y: 10, Z: 2 },
      Color: { R: 10, G: 20, B: 30 },
      Material: "Metal",
      CanCollide: false,
    });
    expect(expectPartProperties(findNodeByName(result.children, "Route_2"), "Route_2")).toMatchObject({
      Shape: "Cylinder",
      CFrame: { Position: { X: 10, Y: 0, Z: 5 }, Orientation: { X: 90, Y: 0, Z: 0 } },
      Size: { X: 2, Y: 10, Z: 2 },
    });
    expect(expectPartProperties(findNodeByName(result.children, "Triangle_1"), "Triangle_1")).toMatchObject({
      Shape: "Block",
      Size: { X: 4, Y: 1, Z: 1 },
      CastShadow: false,
    });
    expect(expectPartProperties(findNodeByName(result.children, "Arch_1"), "Arch_1")).toMatchObject({
      Shape: "Cylinder",
      CFrame: { Position: { X: 2, Y: 0, Z: -2 } },
      Size: { X: 1, Y: 5.65685424949238, Z: 1 },
    });
    expect(expectPartProperties(findNodeByName(result.children, "Ring_1"), "Ring_1")).toMatchObject({
      Shape: "Block",
      Size: { X: 5.196152422706631, Y: 1, Z: 1 },
    });
  });

  test("provides deterministic, scoped random streams for map authoring", async () => {
    const first = await generateProceduralDummyJson({ scriptSource: seededRandomScript, parameters });
    const second = await generateProceduralDummyJson({ scriptSource: seededRandomScript, parameters });

    expect(first).toEqual(second);
    expect(flattenNodeNames(first.children)).toEqual([
      "Model:SeededRandom",
      "  Part:Sample_1",
      "  Part:Sample_2",
      "  Part:Sample_3",
      "  Part:Sample_4",
    ]);
    expect(
      ["Sample_1", "Sample_2", "Sample_3", "Sample_4"].map(
        (name) => expectPartProperties(findNodeByName(first.children, name), name).CFrame?.Position,
      ),
    ).toEqual([
      { X: -8, Y: 0, Z: 9 },
      { X: 3, Y: 0, Z: 1 },
      { X: -4, Y: 0, Z: -8 },
      { X: 4, Y: 0, Z: 9 },
    ]);
  });

  test("rejects unknown geometry options with a casing correction", async () => {
    await expect(
      generateProceduralDummyJson({ scriptSource: invalidGeometryOptionsScript, parameters }),
    ).rejects.toThrow("disc: unknown option 'Color'; use 'color'");
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
        Material: "Concrete",
      },
    });
    expect(findNodeByName(result.children, "PrimitiveMarker")).toMatchObject({
      class: "Part",
      properties: {
        CanCollide: false,
        CanQuery: false,
        CanTouch: false,
        CastShadow: false,
        Material: "Sand",
        Mobility: "Movable",
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
      Material: "FabricWeave",
      Mobility: "Movable",
    });
    expect(expectPartProperties(findNodeByName(result.children, "WideStartCapsule"), "WideStartCapsule")).toMatchObject(
      {
        Shape: "Cylinder",
        CFrame: { Position: { X: 0, Y: 4, Z: 0 }, Orientation: { X: 0, Y: 0, Z: 0 } },
        Size: { X: 6, Y: 14, Z: 6 },
        Material: "FabricWeave",
      },
    );
    expect(expectPartProperties(findNodeByName(result.children, "WideEndCapsule"), "WideEndCapsule")).toMatchObject({
      Shape: "Cylinder",
      CFrame: { Position: { X: 0, Y: 6, Z: 0 }, Orientation: { X: 0, Y: 0, Z: 0 } },
      Size: { X: 6, Y: 14, Z: 6 },
      Material: "FabricWeave",
    });
  });

  test("runs the rabbit example with capsule primitives", async () => {
    const result = await generateProceduralDummyJson({ scriptSource: rabbitExampleScript, parameters });

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
        Material: "FabricWeave",
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
        Material: "Sand",
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

  test("honors an explicitly configured serialized-input limit", async () => {
    await expect(
      generateProceduralDummyJson({ scriptSource: sampleScript, parameters }, { limits: { maxInputBytes: 32 } }),
    ).rejects.toThrow(/input limit/);
  });

  test("transports inline scripts larger than the former 512 KiB argv cap", async () => {
    const largeInlineScript = `${sampleScript}\n-- ]] ]=] ]==] ]===]${"x".repeat(520 * 1024)}`;
    const result = await generateProceduralDummyJson({ scriptSource: largeInlineScript, parameters });
    expect(result.children).toHaveLength(1);
  }, 30_000);

  test("isolates concurrent temporary-input transports", async () => {
    const results = await Promise.all(
      Array.from({ length: 3 }, () => generateProceduralDummyJson({ scriptSource: sampleScript, parameters })),
    );
    expect(results).toHaveLength(3);
  });

  test("rejects output exceeding the max node count", async () => {
    await expect(
      generateProceduralDummyJson({ scriptSource: sampleScript, parameters }, { limits: { maxNodes: 1 } }),
    ).rejects.toThrow(/exceeds the maximum/);
  });

  test("kills a runaway script once the timeout elapses", async () => {
    const infiniteLoopScript = `local Spin = {}
Spin.OnGenerate = function(parameters, targetContainer)
	while true do end
end
return Spin
`;
    await expect(
      generateProceduralDummyJson({ scriptSource: infiniteLoopScript, parameters }, { limits: { timeoutMs: 300 } }),
    ).rejects.toThrow(/timed out/);
  });

  test("round-trips the large colosseum example through temporary-file transport", async () => {
    const colosseumScript = readFileSync(join(import.meta.dir, "../../src/procedural/examples/colosseum.lua"), "utf8");
    const result = await generateProceduralDummyJson({ scriptSource: colosseumScript, parameters });
    expect(result.children.length).toBeGreaterThan(0);
  });
});

const shiftTransformScript = `local Shift = {}
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

    const update = result.ops.find((op) => op.kind === "update");
    expect(update).toMatchObject({ kind: "update", guid: "gKeep", properties: { CFrame: { Position: { X: 1 } } } });
    expect(result.ops).toContainEqual({ kind: "delete", guid: "gDoomed", depth: 1 });
    const add = result.ops.find((op) => op.kind === "add");
    expect(add).toMatchObject({
      kind: "add",
      localId: expect.any(String),
      parent: { kind: "existing", guid: "W" },
      class: "Part",
      name: "Added",
      properties: { Shape: "Ball" },
    });
  });

  test("generate-only run (no scene) produces add ops with the target as parent", async () => {
    const result = await runProceduralScript({ scriptSource: sampleScript, parameters, targetGuid: "TARGET" });
    expect(result.ops.every((op) => op.kind === "add")).toBe(true);
    expect(result.ops[0]).toMatchObject({
      kind: "add",
      localId: expect.any(String),
      parent: { kind: "existing", guid: "TARGET" },
      class: "Model",
      name: "Bunny",
    });
    const localIds = result.ops.flatMap((op) => (op.kind === "add" ? [op.localId] : []));
    expect(new Set(localIds).size).toBe(localIds.length);
  });

  test("creates any upsert-supported class through the generic Instance API", async () => {
    const script = `local Generic = {}
Generic.OnGenerate = function(parameters, targetContainer)
	local light = Instance.new("PointLight")
	light.Name = "HallLight"
	light.Brightness = 125
	light.Range = 900
	light.Color = Color3.fromRGB(255, 210, 170)
	light.Parent = targetContainer
end
return Generic
`;

    const result = await runProceduralScript({ scriptSource: script, parameters, targetGuid: "TARGET" });

    expect(result.ops).toContainEqual(
      expect.objectContaining({
        kind: "add",
        localId: expect.any(String),
        parent: { kind: "existing", guid: "TARGET" },
        class: "PointLight",
        name: "HallLight",
        properties: {
          Brightness: 125,
          Range: 900,
          Color: { R: 255, G: 210, B: 170 },
        },
      }),
    );
  });

  test("diffs updates for properties outside the former procedural whitelist", async () => {
    const script = `local Generic = {}
Generic.OnGenerate = function(parameters, targetContainer)
	workspace:FindFirstChild("Keep").Transparency = 0.5
end
return Generic
`;
    const scene = transformScene();
    scene.children[0].properties.Transparency = 0;

    const result = await runProceduralScript({ scriptSource: script, parameters, scene, targetGuid: "W" });

    expect(result.ops).toContainEqual({
      kind: "update",
      guid: "gKeep",
      class: "Part",
      properties: { Transparency: 0.5 },
    });
  });

  test("diffs canonical property updates on the injected target root", async () => {
    const script = `local Generic = {}
Generic.OnGenerate = function(parameters, targetContainer)
	workspace.Gravity = 750
end
return Generic
`;
    const scene = transformScene();
    scene.properties.Gravity = 980;

    const result = await runProceduralScript({ scriptSource: script, parameters, scene, targetGuid: "W" });

    expect(result.ops).toContainEqual({
      kind: "update",
      guid: "W",
      class: "Workspace",
      properties: { Gravity: 750 },
    });
  });

  test("keeps only the final reparent when an existing node is moved twice", async () => {
    const script = `local Reparent = {}
Reparent.OnGenerate = function(parameters, targetContainer)
	local existing = workspace:FindFirstChild("Keep")
	local first = Instance.new("Folder")
	first.Name = "First"
	first.Parent = workspace
	local final = Instance.new("Folder")
	final.Name = "Final"
	final.Parent = workspace
	existing.Parent = first
	existing.Parent = final
end
return Reparent
`;

    const result = await runProceduralScript({
      scriptSource: script,
      parameters,
      scene: transformScene(),
      targetGuid: "W",
    });
    const moves = result.ops.filter((op) => op.kind === "move");
    const finalAdd = result.ops.find((op) => op.kind === "add" && op.name === "Final");
    expect(moves).toHaveLength(1);
    expect(moves[0]).toEqual({
      kind: "move",
      guid: "gKeep",
      parent: { kind: "generated", localId: finalAdd?.kind === "add" ? finalAdd.localId : "missing" },
    });
  });

  test("emits delete rather than move when a moved existing node is destroyed", async () => {
    const script = `local Remove = {}
Remove.OnGenerate = function(parameters, targetContainer)
	local keep = workspace:FindFirstChild("Keep")
	local doomed = workspace:FindFirstChild("Doomed")
	doomed.Parent = keep
	doomed:Destroy()
end
return Remove
`;

    const result = await runProceduralScript({
      scriptSource: script,
      parameters,
      scene: transformScene(),
      targetGuid: "W",
    });
    expect(result.ops.filter((op) => op.kind === "move")).toEqual([]);
    expect(result.ops).toEqual([{ kind: "delete", guid: "gDoomed", depth: 1 }]);
  });

  test("rejects mixed existing/generated hierarchy cycles in the Luau mock tree", async () => {
    const script = `local Cycle = {}
Cycle.OnGenerate = function(parameters, targetContainer)
	local existing = workspace:FindFirstChild("Keep")
	local folder = Instance.new("Folder")
	folder.Parent = existing
	existing.Parent = folder
end
return Cycle
`;

    await expect(
      runProceduralScript({ scriptSource: script, parameters, scene: transformScene(), targetGuid: "W" }),
    ).rejects.toThrow(/hierarchy cycle/i);
  });

  test("rejects destroying the protected injected target root", async () => {
    const script = `local DestroyRoot = {}
DestroyRoot.OnGenerate = function(parameters, targetContainer)
	workspace:Destroy()
end
return DestroyRoot
`;

    await expect(
      runProceduralScript({ scriptSource: script, parameters, scene: transformScene(), targetGuid: "W" }),
    ).rejects.toThrow(/protected.*root/i);
  });

  test("accepts a whole-workspace snapshot larger than the former argv cap", async () => {
    const noOpScript = `local NoOp = {}
NoOp.OnGenerate = function(parameters, targetContainer) end
return NoOp
`;
    const largeScene: ProceduralSceneNode = {
      class: "Workspace",
      name: "Workspace",
      guid: "W",
      properties: {},
      children: Array.from({ length: 2_500 }, (_, index) => ({
        class: "Part",
        name: `Existing_${index}_${"x".repeat(64)}`,
        guid: `existing-${index}`,
        properties: {
          CFrame: {
            Position: { X: index, Y: 0, Z: 0 },
            Orientation: { X: 0, Y: 0, Z: 0 },
          },
        },
        children: [],
      })),
    };
    expect(Buffer.byteLength(JSON.stringify(largeScene), "utf8")).toBeGreaterThan(512 * 1024);

    const result = await runProceduralScript(
      { scriptSource: noOpScript, parameters, scene: largeScene, targetGuid: "W" },
      { limits: { maxNodes: 1 } },
    );
    expect(result.ops).toEqual([]);
    expect(result.nodeCount).toBe(0);
  });

  test("runs scripts without identity metadata", async () => {
    const noIdScript = `local Anon = {}
Anon.OnGenerate = function(parameters, targetContainer)
	local GP = require(script.Dependencies.GeometryPrimitives)
	GP.sphere("Ball", Vector3.new(0, 0, 0), 1, Color3.fromRGB(1, 2, 3), "Plastic", targetContainer)
end
return Anon
`;
    const result = await runProceduralScript({
      scriptSource: noIdScript,
      parameters,
      targetGuid: "TARGET",
    });
    expect(result.ops).toHaveLength(1);
  });
});
