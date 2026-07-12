-- @summary Luau MathUtils dependency for OVDR procedural dummy generation.
--
-- Interpolation, curve, coordinate, and layout helpers. All Vector3/Color3
-- values are built through the ovdr-shim so results share the shim metatables
-- and serialize correctly.
-- Colors use the shim's 0-255 channel model (see Ovdr.Color3.fromRGB).

local Ovdr = require("../ovdr-shim")

local MathUtils = {}
local EPSILON = 0.000001
local MAX_POINT_COUNT = 20000
local MAX_SAFE_INTEGER = 9007199254740991
local RANDOM_MODULUS = 2147483647
local RANDOM_RANGE = RANDOM_MODULUS - 1
local RANDOM_MULTIPLIER = 48271

-- ===========================================================================
-- INPUT VALIDATION
-- ===========================================================================

local function validateFiniteNumber(funcName, paramName, value)
	if type(value) ~= "number" then
		error(funcName .. ": '" .. paramName .. "' must be a number")
	end
	if value ~= value then -- NaN
		error(funcName .. ": '" .. paramName .. "' is NaN (not a number)")
	end
	if math.abs(value) == math.huge then
		error(funcName .. ": '" .. paramName .. "' is " .. tostring(value) .. " (infinite values are not allowed)")
	end
	return value
end

local function validateFiniteVector3(funcName, paramName, v)
	if type(v) ~= "table" or type(v.X) ~= "number" or type(v.Y) ~= "number" or type(v.Z) ~= "number" then
		error(funcName .. ": '" .. paramName .. "' must be a Vector3")
	end
	for _, axis in ipairs({ "X", "Y", "Z" }) do
		validateFiniteNumber(funcName, paramName .. "." .. axis, v[axis])
	end
	return v
end

local function validatePositiveNumber(funcName, paramName, value)
	validateFiniteNumber(funcName, paramName, value)
	if value <= 0 then
		error(funcName .. ": '" .. paramName .. "' must be greater than zero")
	end
	return value
end

local function validateCount(funcName, count, minimum)
	validateFiniteNumber(funcName, "count", count)
	if count ~= math.floor(count) then
		error(funcName .. ": 'count' must be an integer")
	end
	if count < minimum then
		error(funcName .. ": 'count' must be at least " .. tostring(minimum))
	end
	if count > MAX_POINT_COUNT then
		error(funcName .. ": 'count' must not exceed " .. tostring(MAX_POINT_COUNT))
	end
	return count
end

local function validateSafeInteger(funcName, paramName, value)
	validateFiniteNumber(funcName, paramName, value)
	if value ~= math.floor(value) then
		error(funcName .. ": '" .. paramName .. "' must be an integer")
	end
	if math.abs(value) > MAX_SAFE_INTEGER then
		error(funcName .. ": '" .. paramName .. "' must be a safe integer")
	end
	return value
end

local function normalizeSeed(funcName, seed)
	validateSafeInteger(funcName, "seed", seed)
	local normalized = seed % RANDOM_MODULUS
	if normalized <= 0 then
		normalized += RANDOM_RANGE
	end
	return normalized
end

local function validateDenseArray(funcName, paramName, values, requireNonEmpty)
	if type(values) ~= "table" then
		error(funcName .. ": '" .. paramName .. "' must be an array")
	end
	local length = #values
	local entryCount = 0
	for key in pairs(values) do
		if type(key) ~= "number" or key ~= math.floor(key) or key < 1 or key > length then
			error(funcName .. ": '" .. paramName .. "' must be a dense array")
		end
		entryCount += 1
	end
	if entryCount ~= length then
		error(funcName .. ": '" .. paramName .. "' must be a dense array")
	end
	if requireNonEmpty and length == 0 then
		error(funcName .. ": '" .. paramName .. "' must not be empty")
	end
	if length > MAX_POINT_COUNT then
		error(funcName .. ": '" .. paramName .. "' must not contain more than " .. tostring(MAX_POINT_COUNT) .. " items")
	end
	return length
end

local function validateAxis(funcName, paramName, axis)
	validateFiniteVector3(funcName, paramName, axis)
	if axis.Magnitude <= EPSILON then
		error(funcName .. ": '" .. paramName .. "' must be non-zero")
	end
	return axis.Unit
end

local function projectUnchecked(vector, unitNormal)
	return vector - unitNormal * vector:Dot(unitNormal)
end

local function circleBasis(funcName, axis)
	local axisDir = validateAxis(funcName, "axis", axis)
	local reference = Ovdr.Vector3.yAxis
	if math.abs(axisDir:Dot(reference)) > 0.95 then
		reference = Ovdr.Vector3.zAxis
	end
	local u = axisDir:Cross(reference).Unit
	local v = axisDir:Cross(u).Unit
	return u, v
end

local function deterministicPerpendicular(unitAxis)
	local candidate = projectUnchecked(Ovdr.Vector3.yAxis, unitAxis)
	if candidate.Magnitude <= EPSILON then
		candidate = projectUnchecked(-Ovdr.Vector3.xAxis, unitAxis)
	end
	if candidate.Magnitude <= EPSILON then
		candidate = projectUnchecked(Ovdr.Vector3.zAxis, unitAxis)
	end
	return candidate.Unit
end

local function frameForDirection(funcName, position, direction, localAxis, up)
	local directionDir = validateAxis(funcName, "direction", direction)
	local localAxisDir = validateAxis(funcName, "localAxis", localAxis)
	local upDir = validateAxis(funcName, "up", up)
	local localYAxisSign = localAxisDir:Dot(Ovdr.Vector3.yAxis)
	if math.abs(localYAxisSign) > 1 - EPSILON and math.abs(upDir:Dot(Ovdr.Vector3.yAxis)) > 1 - EPSILON then
		-- Preserve the established Y-axis cylinder convention while still routing
		-- it through the shared frame primitive. This produces the minimal X/Z
		-- Euler pair used by existing OVERDARE output.
		local mappedY = directionDir * localYAxisSign
		local horizontalMagnitude = math.sqrt(mappedY.X * mappedY.X + mappedY.Y * mappedY.Y)
		local roll = math.atan2(mappedY.Z, horizontalMagnitude)
		local yaw = -math.atan2(mappedY.X, mappedY.Y)
		local yawDegrees = math.deg(yaw)
		if math.abs(yawDegrees + 180) <= EPSILON then
			yawDegrees = 180
		end
		return Ovdr.CFrame.fromPositionOrientation(position, Ovdr.Vector3.new(math.deg(roll), 0, yawDegrees))
	end

	local localSecondary = deterministicPerpendicular(localAxisDir)
	local localThird = localAxisDir:Cross(localSecondary).Unit
	local worldSecondary = projectUnchecked(upDir, directionDir)
	if worldSecondary.Magnitude <= EPSILON then
		worldSecondary = deterministicPerpendicular(directionDir)
	else
		worldSecondary = worldSecondary.Unit
	end
	local worldThird = directionDir:Cross(worldSecondary).Unit

	local function transformLocalBasis(axis)
		return directionDir * axis:Dot(localAxisDir)
			+ worldSecondary * axis:Dot(localSecondary)
			+ worldThird * axis:Dot(localThird)
	end

	return Ovdr.CFrame.fromMatrix(
		position,
		transformLocalBasis(Ovdr.Vector3.xAxis),
		transformLocalBasis(Ovdr.Vector3.yAxis),
		transformLocalBasis(Ovdr.Vector3.zAxis)
	)
end

-- ===========================================================================
-- DETERMINISTIC RANDOM AUTHORING
-- ===========================================================================

function MathUtils.deriveSeed(seed, scope)
	local derived = normalizeSeed("deriveSeed", seed)
	if type(scope) ~= "string" or #scope == 0 then
		error("deriveSeed: 'scope' must be a non-empty string")
	end
	for index = 1, #scope do
		derived = (derived * 257 + string.byte(scope, index) + 1) % RANDOM_MODULUS
	end
	if derived == 0 then
		return 1
	end
	return derived
end

function MathUtils.random(seed)
	local state = normalizeSeed("random", seed)
	local rng = {}

	local function nextRawInteger()
		state = (state * RANDOM_MULTIPLIER) % RANDOM_MODULUS
		return state - 1
	end

	function rng:nextNumber(minimum, maximum)
		validateFiniteNumber("random.nextNumber", "minimum", minimum)
		validateFiniteNumber("random.nextNumber", "maximum", maximum)
		if minimum >= maximum then
			error("random.nextNumber: 'minimum' must be less than 'maximum'")
		end
		local width = maximum - minimum
		if math.abs(width) == math.huge then
			error("random.nextNumber: range width must be finite")
		end
		return minimum + width * (nextRawInteger() / RANDOM_RANGE)
	end

	function rng:nextInteger(minimum, maximum)
		validateSafeInteger("random.nextInteger", "minimum", minimum)
		validateSafeInteger("random.nextInteger", "maximum", maximum)
		if minimum > maximum then
			error("random.nextInteger: 'minimum' must not exceed 'maximum'")
		end
		local width = maximum - minimum + 1
		if width > RANDOM_RANGE then
			error("random.nextInteger: integer range must not contain more than " .. tostring(RANDOM_RANGE) .. " values")
		end
		local acceptanceLimit = RANDOM_RANGE - (RANDOM_RANGE % width)
		local value
		repeat
			value = nextRawInteger()
		until value < acceptanceLimit
		return minimum + (value % width)
	end

	function rng:choice(items)
		local length = validateDenseArray("random.choice", "items", items, true)
		return items[self:nextInteger(1, length)]
	end

	function rng:shuffle(items)
		local length = validateDenseArray("random.shuffle", "items", items, false)
		local shuffled = {}
		for index = 1, length do
			shuffled[index] = items[index]
		end
		for index = length, 2, -1 do
			local swapIndex = self:nextInteger(1, index)
			shuffled[index], shuffled[swapIndex] = shuffled[swapIndex], shuffled[index]
		end
		return shuffled
	end

	return rng
end

-- ===========================================================================
-- INTERPOLATION
-- ===========================================================================

function MathUtils.lerp(a, b, t)
	validateFiniteNumber("lerp", "a", a)
	validateFiniteNumber("lerp", "b", b)
	validateFiniteNumber("lerp", "t", t)
	t = math.clamp(t, 0, 1)
	return a + (b - a) * t
end

function MathUtils.lerpVector3(v1, v2, t)
	t = math.clamp(t, 0, 1)
	return Ovdr.Vector3.new(
		v1.X + (v2.X - v1.X) * t,
		v1.Y + (v2.Y - v1.Y) * t,
		v1.Z + (v2.Z - v1.Z) * t
	)
end

-- Channels are the shim's 0-255 model; interpolate and round back to integers.
function MathUtils.lerpColor(c1, c2, t)
	t = math.clamp(t, 0, 1)
	local function channel(a, b)
		return math.floor(a + (b - a) * t + 0.5)
	end
	return Ovdr.Color3.fromRGB(channel(c1.R, c2.R), channel(c1.G, c2.G), channel(c1.B, c2.B))
end

-- ===========================================================================
-- CURVES
-- ===========================================================================

function MathUtils.pointOnCubicBezier(t, p0, p1, p2, p3)
	validateFiniteNumber("pointOnCubicBezier", "t", t)
	validateFiniteVector3("pointOnCubicBezier", "p0", p0)
	validateFiniteVector3("pointOnCubicBezier", "p1", p1)
	validateFiniteVector3("pointOnCubicBezier", "p2", p2)
	validateFiniteVector3("pointOnCubicBezier", "p3", p3)
	t = math.clamp(t, 0, 1)
	local u = 1 - t
	return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
end

function MathUtils.pointOnQuadraticBezier(t, p0, p1, p2)
	validateFiniteNumber("pointOnQuadraticBezier", "t", t)
	validateFiniteVector3("pointOnQuadraticBezier", "p0", p0)
	validateFiniteVector3("pointOnQuadraticBezier", "p1", p1)
	validateFiniteVector3("pointOnQuadraticBezier", "p2", p2)
	t = math.clamp(t, 0, 1)
	local u = 1 - t
	return u * u * p0 + 2 * u * t * p1 + t * t * p2
end

-- ===========================================================================
-- COORDINATE UTILITIES
-- ===========================================================================

function MathUtils.polarToCartesian(center, radius, angle, plane)
	validateFiniteVector3("polarToCartesian", "center", center)
	validateFiniteNumber("polarToCartesian", "radius", radius)
	validateFiniteNumber("polarToCartesian", "angle", angle)
	local c = math.cos(angle) * radius
	local s = math.sin(angle) * radius
	if plane == "XY" then
		return Ovdr.Vector3.new(center.X + c, center.Y + s, center.Z)
	elseif plane == "YZ" then
		return Ovdr.Vector3.new(center.X, center.Y + c, center.Z + s)
	else -- "XZ" (default)
		return Ovdr.Vector3.new(center.X + c, center.Y, center.Z + s)
	end
end

-- ===========================================================================
-- VECTOR / TRANSFORM UTILITIES
-- ===========================================================================

function MathUtils.pointsOnCubicBezier(p0, p1, p2, p3, segments)
	validateFiniteVector3("pointsOnCubicBezier", "p0", p0)
	validateFiniteVector3("pointsOnCubicBezier", "p1", p1)
	validateFiniteVector3("pointsOnCubicBezier", "p2", p2)
	validateFiniteVector3("pointsOnCubicBezier", "p3", p3)
	validateFiniteNumber("pointsOnCubicBezier", "segments", segments)
	local points = {}
	for i = 0, segments do
		local t = i / segments
		table.insert(points, MathUtils.pointOnCubicBezier(t, p0, p1, p2, p3))
	end
	return points
end

function MathUtils.projectOnPlane(vector, normal)
	validateFiniteVector3("projectOnPlane", "vector", vector)
	local normalDir = validateAxis("projectOnPlane", "normal", normal)
	return projectUnchecked(vector, normalDir)
end

function MathUtils.frameBetween(startPoint, endPoint, localAxis, up)
	validateFiniteVector3("frameBetween", "startPoint", startPoint)
	validateFiniteVector3("frameBetween", "endPoint", endPoint)
	local delta = endPoint - startPoint
	if delta.Magnitude <= EPSILON then
		error("frameBetween: 'startPoint' and 'endPoint' must be distinct")
	end
	return frameForDirection("frameBetween", (startPoint + endPoint) / 2, delta, localAxis, up)
end

function MathUtils.frameFromNormal(position, normal, up)
	validateFiniteVector3("frameFromNormal", "position", position)
	validateFiniteVector3("frameFromNormal", "normal", normal)
	return frameForDirection("frameFromNormal", position, normal, Ovdr.Vector3.yAxis, up)
end

function MathUtils.rotateAroundAxis(point, pivot, axis, angle)
	validateFiniteVector3("rotateAroundAxis", "point", point)
	validateFiniteVector3("rotateAroundAxis", "pivot", pivot)
	local axisDir = validateAxis("rotateAroundAxis", "axis", axis)
	validateFiniteNumber("rotateAroundAxis", "angle", angle)
	local offset = point - pivot
	local cosine = math.cos(angle)
	local sine = math.sin(angle)
	return pivot + offset * cosine + axisDir:Cross(offset) * sine + axisDir * axisDir:Dot(offset) * (1 - cosine)
end

function MathUtils.mirrorPoint(point, planePoint, planeNormal)
	validateFiniteVector3("mirrorPoint", "point", point)
	validateFiniteVector3("mirrorPoint", "planePoint", planePoint)
	local normalDir = validateAxis("mirrorPoint", "planeNormal", planeNormal)
	local offset = point - planePoint
	return point - normalDir * (2 * offset:Dot(normalDir))
end

function MathUtils.transformPoints(points, cframe)
	if type(points) ~= "table" then
		error("transformPoints: 'points' must be an array")
	end
	if type(cframe) ~= "table" or type(cframe.PointToWorldSpace) ~= "function" then
		error("transformPoints: 'cframe' must be a CFrame")
	end
	if #points > MAX_POINT_COUNT then
		error("transformPoints: point count must not exceed " .. tostring(MAX_POINT_COUNT))
	end
	local transformed = {}
	for index, point in ipairs(points) do
		validateFiniteVector3("transformPoints", "points[" .. tostring(index) .. "]", point)
		table.insert(transformed, cframe:PointToWorldSpace(point))
	end
	return transformed
end

-- ===========================================================================
-- LAYOUT / DISTRIBUTION UTILITIES
-- ===========================================================================

function MathUtils.pointsOnLine(startPoint, endPoint, count)
	validateFiniteVector3("pointsOnLine", "startPoint", startPoint)
	validateFiniteVector3("pointsOnLine", "endPoint", endPoint)
	validateCount("pointsOnLine", count, 2)
	if (endPoint - startPoint).Magnitude <= EPSILON then
		error("pointsOnLine: 'startPoint' and 'endPoint' must be distinct")
	end
	local points = {}
	for i = 1, count do
		local t = (i - 1) / (count - 1)
		table.insert(points, startPoint:Lerp(endPoint, t))
	end
	return points
end

function MathUtils.pointsOnCircle(center, radius, count, axis)
	validateFiniteVector3("pointsOnCircle", "center", center)
	validatePositiveNumber("pointsOnCircle", "radius", radius)
	validateCount("pointsOnCircle", count, 3)
	local u, v = circleBasis("pointsOnCircle", axis)
	local points = {}
	for i = 1, count do
		local angle = ((i - 1) / count) * math.pi * 2
		table.insert(points, center + u * (math.cos(angle) * radius) + v * (math.sin(angle) * radius))
	end
	return points
end

function MathUtils.pointsOnArc(center, radius, startAngle, endAngle, count, axis)
	validateFiniteVector3("pointsOnArc", "center", center)
	validatePositiveNumber("pointsOnArc", "radius", radius)
	validateFiniteNumber("pointsOnArc", "startAngle", startAngle)
	validateFiniteNumber("pointsOnArc", "endAngle", endAngle)
	validateCount("pointsOnArc", count, 2)
	if math.abs(endAngle - startAngle) <= EPSILON then
		error("pointsOnArc: 'startAngle' and 'endAngle' must be distinct")
	end
	local u, v = circleBasis("pointsOnArc", axis)
	local points = {}
	for i = 1, count do
		local t = (i - 1) / (count - 1)
		local angle = startAngle + (endAngle - startAngle) * t
		table.insert(points, center + u * (math.cos(angle) * radius) + v * (math.sin(angle) * radius))
	end
	return points
end

function MathUtils.pointsOnEllipse(center, radiusX, radiusY, count, axis)
	validateFiniteVector3("pointsOnEllipse", "center", center)
	validatePositiveNumber("pointsOnEllipse", "radiusX", radiusX)
	validatePositiveNumber("pointsOnEllipse", "radiusY", radiusY)
	validateCount("pointsOnEllipse", count, 3)
	local u, v = circleBasis("pointsOnEllipse", axis)
	local points = {}
	for i = 1, count do
		local angle = ((i - 1) / count) * math.pi * 2
		table.insert(points, center + u * (math.cos(angle) * radiusX) + v * (math.sin(angle) * radiusY))
	end
	return points
end

function MathUtils.pointsOnGrid(origin, columns, rows, columnStep, rowStep)
	validateFiniteVector3("pointsOnGrid", "origin", origin)
	validateFiniteNumber("pointsOnGrid", "columns", columns)
	validateFiniteNumber("pointsOnGrid", "rows", rows)
	if columns ~= math.floor(columns) or columns < 1 then
		error("pointsOnGrid: 'columns' must be a positive integer")
	end
	if rows ~= math.floor(rows) or rows < 1 then
		error("pointsOnGrid: 'rows' must be a positive integer")
	end
	if columns * rows > MAX_POINT_COUNT then
		error("pointsOnGrid: point count must not exceed " .. tostring(MAX_POINT_COUNT))
	end
	validateFiniteVector3("pointsOnGrid", "columnStep", columnStep)
	validateFiniteVector3("pointsOnGrid", "rowStep", rowStep)
	if columnStep.Magnitude <= EPSILON then
		error("pointsOnGrid: 'columnStep' must be non-zero")
	end
	if rowStep.Magnitude <= EPSILON then
		error("pointsOnGrid: 'rowStep' must be non-zero")
	end

	local points = {}
	for row = 1, rows do
		for column = 1, columns do
			table.insert(points, origin + columnStep * (column - 1) + rowStep * (row - 1))
		end
	end
	return points
end

function MathUtils.pointsOnHelix(center, radius, height, turns, count, axis)
	validateFiniteVector3("pointsOnHelix", "center", center)
	validatePositiveNumber("pointsOnHelix", "radius", radius)
	validateFiniteNumber("pointsOnHelix", "height", height)
	validateFiniteNumber("pointsOnHelix", "turns", turns)
	validateCount("pointsOnHelix", count, 2)
	if math.abs(height) <= EPSILON then
		error("pointsOnHelix: 'height' must be non-zero")
	end
	if math.abs(turns) <= EPSILON then
		error("pointsOnHelix: 'turns' must be non-zero")
	end
	local axisDir = validateAxis("pointsOnHelix", "axis", axis)
	local u, v = circleBasis("pointsOnHelix", axisDir)
	local points = {}
	for index = 1, count do
		local t = (index - 1) / (count - 1)
		local angle = t * turns * math.pi * 2
		local axialOffset = height * (t - 0.5)
		table.insert(
			points,
			center + axisDir * axialOffset + u * (math.cos(angle) * radius) + v * (math.sin(angle) * radius)
		)
	end
	return points
end

function MathUtils.segmentsFromPoints(points, closed)
	if type(points) ~= "table" then
		error("segmentsFromPoints: 'points' must be an array")
	end
	if closed ~= nil and type(closed) ~= "boolean" then
		error("segmentsFromPoints: 'closed' must be a boolean")
	end
	local minimum = closed and 3 or 2
	if #points < minimum then
		error("segmentsFromPoints: 'points' must contain at least " .. tostring(minimum) .. " points")
	end
	if #points > MAX_POINT_COUNT then
		error("segmentsFromPoints: point count must not exceed " .. tostring(MAX_POINT_COUNT))
	end
	for index, point in ipairs(points) do
		validateFiniteVector3("segmentsFromPoints", "points[" .. tostring(index) .. "]", point)
	end
	local segments = {}
	for index = 1, #points - 1 do
		if (points[index + 1] - points[index]).Magnitude <= EPSILON then
			error("segmentsFromPoints: consecutive points must be distinct")
		end
		table.insert(segments, { startPoint = points[index], endPoint = points[index + 1] })
	end
	if closed then
		if (points[1] - points[#points]).Magnitude <= EPSILON then
			error("segmentsFromPoints: closed endpoints must be distinct")
		end
		table.insert(segments, { startPoint = points[#points], endPoint = points[1] })
	end
	return segments
end

function MathUtils.forEachPointOnLine(startPoint, endPoint, count, callback)
	if type(callback) ~= "function" then error("forEachPointOnLine: 'callback' must be a function") end
	for index, point in ipairs(MathUtils.pointsOnLine(startPoint, endPoint, count)) do
		callback(point, index)
	end
end

function MathUtils.forEachPointOnCircle(center, radius, count, axis, callback)
	if type(callback) ~= "function" then error("forEachPointOnCircle: 'callback' must be a function") end
	for index, point in ipairs(MathUtils.pointsOnCircle(center, radius, count, axis)) do
		callback(point, index)
	end
end

function MathUtils.forEachSegmentOnCircle(center, radius, count, axis, callback)
	if type(callback) ~= "function" then error("forEachSegmentOnCircle: 'callback' must be a function") end
	local segments = MathUtils.segmentsFromPoints(MathUtils.pointsOnCircle(center, radius, count, axis), true)
	for index, segment in ipairs(segments) do
		callback(segment.startPoint, index, segment.endPoint)
	end
end

-- Compatibility aliases for scripts authored against the original API.
MathUtils.bezier = MathUtils.pointOnCubicBezier
MathUtils.quadraticBezier = MathUtils.pointOnQuadraticBezier
MathUtils.sampleBezierPoints = MathUtils.pointsOnCubicBezier
MathUtils.linearArray = MathUtils.forEachPointOnLine
MathUtils.radialArray = MathUtils.forEachPointOnCircle
MathUtils.radialArrayConnected = MathUtils.forEachSegmentOnCircle

return MathUtils
