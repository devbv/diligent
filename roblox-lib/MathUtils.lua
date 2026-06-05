local CSG = require(script.Parent.ConstructiveSolidGeometry)
local GP = require(script.Parent.GeometryPrimitives)
local SO = require(script.Parent.SmartObject)

local MathUtils = {}

-- Create the DSL builder

-- ===========================================================================
-- INPUT VALIDATION
-- ===========================================================================

local function validateFiniteNumber(funcName: string, paramName: string, value: number): number
	if value == nil then return value end
	if value ~= value then -- NaN
		error(funcName .. ": '" .. paramName .. "' is NaN (not a number)")
	end
	if math.abs(value) == math.huge then
		error(funcName .. ": '" .. paramName .. "' is " .. tostring(value) .. " (infinite values are not allowed)")
	end
	return value
end

local function validateFiniteVector3(funcName: string, paramName: string, v: Vector3): Vector3
	for _, axis in { "X", "Y", "Z" } do
		validateFiniteNumber(funcName, paramName .. "." .. axis, (v :: any)[axis])
	end
	return v
end

-- ===========================================================================
-- INTERPOLATION
-- ===========================================================================

function MathUtils.lerp(a: number, b: number, t: number): number
	validateFiniteNumber("lerp", "a", a)
	validateFiniteNumber("lerp", "b", b)
	validateFiniteNumber("lerp", "t", t)
	t = math.clamp(t, 0, 1)
	return a + (b - a) * t
end

function MathUtils.lerpVector3(v1: Vector3, v2: Vector3, t: number): Vector3
	t = math.clamp(t, 0, 1)
	return Vector3.new(
		v1.X + (v2.X - v1.X) * t,
		v1.Y + (v2.Y - v1.Y) * t,
		v1.Z + (v2.Z - v1.Z) * t
	)
end

function MathUtils.lerpColor(c1: Color3, c2: Color3, t: number): Color3
	t = math.clamp(t, 0, 1)
	return Color3.new(
		c1.R + (c2.R - c1.R) * t,
		c1.G + (c2.G - c1.G) * t,
		c1.B + (c2.B - c1.B) * t
	)
end

-- ===========================================================================
-- CURVES
-- ===========================================================================

function MathUtils.bezier(t: number, p0: Vector3, p1: Vector3, p2: Vector3, p3: Vector3): Vector3
	validateFiniteNumber("bezier", "t", t)
	validateFiniteVector3("bezier", "p0", p0)
	validateFiniteVector3("bezier", "p1", p1)
	validateFiniteVector3("bezier", "p2", p2)
	validateFiniteVector3("bezier", "p3", p3)
	t = math.clamp(t, 0, 1)
	local u = 1 - t
	return u * u * u * p0
		+ 3 * u * u * t * p1
		+ 3 * u * t * t * p2
		+ t * t * t * p3
end

function MathUtils.quadraticBezier(t: number, p0: Vector3, p1: Vector3, p2: Vector3): Vector3
	validateFiniteNumber("quadraticBezier", "t", t)
	validateFiniteVector3("quadraticBezier", "p0", p0)
	validateFiniteVector3("quadraticBezier", "p1", p1)
	validateFiniteVector3("quadraticBezier", "p2", p2)
	t = math.clamp(t, 0, 1)
	local u = 1 - t
	return u * u * p0 + 2 * u * t * p1 + t * t * p2
end

-- ===========================================================================
-- COORDINATE UTILITIES
-- ===========================================================================

function MathUtils.polarToCartesian(center: Vector3, radius: number, angle: number, plane: string): Vector3
	validateFiniteVector3("polarToCartesian", "center", center)
	validateFiniteNumber("polarToCartesian", "radius", radius)
	validateFiniteNumber("polarToCartesian", "angle", angle)
	local c = math.cos(angle) * radius
	local s = math.sin(angle) * radius
	if plane == "XY" then
		return Vector3.new(center.X + c, center.Y + s, center.Z)
	elseif plane == "YZ" then
		return Vector3.new(center.X, center.Y + c, center.Z + s)
	else -- "XZ" (default)
		return Vector3.new(center.X + c, center.Y, center.Z + s)
	end
end

-- ===========================================================================
-- VECTOR / TRANSFORM UTILITIES
-- ===========================================================================

function MathUtils.sampleBezierPoints(p0: Vector3, p1: Vector3, p2: Vector3, p3: Vector3, segments: number): { Vector3 }
	validateFiniteVector3("sampleBezierPoints", "p0", p0)
	validateFiniteVector3("sampleBezierPoints", "p1", p1)
	validateFiniteVector3("sampleBezierPoints", "p2", p2)
	validateFiniteVector3("sampleBezierPoints", "p3", p3)
	validateFiniteNumber("sampleBezierPoints", "segments", segments)
	local points = {}
	for i = 0, segments do
		local t = i / segments
		table.insert(points, MathUtils.bezier(t, p0, p1, p2, p3))
	end
	return points
end

-- ===========================================================================
-- LAYOUT / DISTRIBUTION UTILITIES
-- ===========================================================================

function MathUtils.linearArray(startPos: Vector3, endPos: Vector3, count: number, callback: (Vector3, number) -> ()): ()
	validateFiniteVector3("linearArray", "startPos", startPos)
	validateFiniteVector3("linearArray", "endPos", endPos)
	validateFiniteNumber("linearArray", "count", count)
	for i = 1, count do
		local t = (count > 1) and ((i - 1) / (count - 1)) or 0
		local pos = startPos:Lerp(endPos, t)
		callback(pos, i)
	end
end

function MathUtils.radialArray(center: Vector3, radius: number, count: number, axis: Vector3, callback: (Vector3, number) -> ()): ()
	validateFiniteVector3("radialArray", "center", center)
	validateFiniteNumber("radialArray", "radius", radius)
	validateFiniteNumber("radialArray", "count", count)
	validateFiniteVector3("radialArray", "axis", axis)
	local axisDir = axis.Unit
	local upRef = Vector3.new(0, 1, 0)
	if math.abs(axisDir:Dot(upRef)) > 0.95 then
		upRef = Vector3.new(0, 0, 1)
	end
	local u = axisDir:Cross(upRef).Unit
	local v = axisDir:Cross(u).Unit

	for i = 1, count do
		local angle = ((i - 1) / count) * math.pi * 2
		local pos = center + (math.cos(angle) * u + math.sin(angle) * v) * radius
		callback(pos, i)
	end
end

function MathUtils.radialArrayConnected(center: Vector3, radius: number, count: number, axis: Vector3, callback: (Vector3, number, Vector3) -> ()): ()
	validateFiniteVector3("radialArrayConnected", "center", center)
	validateFiniteNumber("radialArrayConnected", "radius", radius)
	validateFiniteNumber("radialArrayConnected", "count", count)
	validateFiniteVector3("radialArrayConnected", "axis", axis)
	local axisDir = axis.Unit
	local upRef = Vector3.new(0, 1, 0)
	if math.abs(axisDir:Dot(upRef)) > 0.95 then
		upRef = Vector3.new(0, 0, 1)
	end
	local u = axisDir:Cross(upRef).Unit
	local v = axisDir:Cross(u).Unit

	for i = 1, count do
		local angle = ((i - 1) / count) * math.pi * 2
		local nextAngle = (i / count) * math.pi * 2

		local pos = center + (math.cos(angle) * u + math.sin(angle) * v) * radius
		local nextPos = center + (math.cos(nextAngle) * u + math.sin(nextAngle) * v) * radius

		callback(pos, i, nextPos)
	end
end
return MathUtils
