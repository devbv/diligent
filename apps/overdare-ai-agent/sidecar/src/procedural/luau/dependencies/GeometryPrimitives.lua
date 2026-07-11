-- @summary Luau GeometryPrimitives dependency for OVDR procedural dummy generation.

local Ovdr = require("../ovdr-shim")
local MathUtils = require("./MathUtils")

local GP = {}
local EPSILON = 0.000001
local MAX_POINT_COUNT = 20000
-- A standalone composite consumes one Model node, leaving 4,999 Part nodes
-- under the default procedural limit in limits.ts.
local MAX_COMPOSITE_SEGMENTS = 4999

local function parentTo(instance, parent)
	if parent ~= nil then
		instance.Parent = parent
	end
	return instance
end

local function cframeAt(position)
	return Ovdr.CFrame.new(position.X, position.Y, position.Z)
end

local function validateFiniteNumber(funcName, paramName, value)
	if type(value) ~= "number" or value ~= value or math.abs(value) == math.huge then
		error(funcName .. ": '" .. paramName .. "' must be a finite number")
	end
	return value
end

local function validatePositiveNumber(funcName, paramName, value)
	validateFiniteNumber(funcName, paramName, value)
	if value <= 0 then
		error(funcName .. ": '" .. paramName .. "' must be greater than zero")
	end
	return value
end

local function validateFiniteVector3(funcName, paramName, value)
	if type(value) ~= "table" then
		error(funcName .. ": '" .. paramName .. "' must be a Vector3")
	end
	validateFiniteNumber(funcName, paramName .. ".X", value.X)
	validateFiniteNumber(funcName, paramName .. ".Y", value.Y)
	validateFiniteNumber(funcName, paramName .. ".Z", value.Z)
	return value
end

local function resolveCFrame(funcName, centerOrCFrame)
	if type(centerOrCFrame) == "table" and centerOrCFrame.Position ~= nil then
		validateFiniteVector3(funcName, "centerOrCFrame.Position", centerOrCFrame.Position)
		if centerOrCFrame.Orientation ~= nil then
			validateFiniteVector3(funcName, "centerOrCFrame.Orientation", centerOrCFrame.Orientation)
		end
		return centerOrCFrame
	end
	return cframeAt(validateFiniteVector3(funcName, "centerOrCFrame", centerOrCFrame))
end

local optionDefinitions = {
	{ name = "color", property = "Color", kind = "color" },
	{ name = "material", property = "Material", kind = "string" },
	{ name = "parent", property = "Parent", kind = "parent" },
	{ name = "transparency", property = "Transparency", kind = "unitNumber" },
	{ name = "canCollide", property = "CanCollide", kind = "boolean" },
	{ name = "canQuery", property = "CanQuery", kind = "boolean" },
	{ name = "canTouch", property = "CanTouch", kind = "boolean" },
	{ name = "castShadow", property = "CastShadow", kind = "boolean" },
	{ name = "anchored", property = "Anchored", kind = "boolean" },
	{ name = "collisionGroup", property = "CollisionGroup", kind = "string" },
	{ name = "locked", property = "Locked", kind = "boolean" },
	{ name = "mass", property = "Mass", kind = "positiveNumber" },
	{ name = "massless", property = "Massless", kind = "boolean" },
	{ name = "materialVariant", property = "MaterialVariant", kind = "string" },
	{ name = "reflectance", property = "Reflectance", kind = "unitNumber" },
	{ name = "rootPriority", property = "RootPriority", kind = "number" },
}

local allowedOptionNames = {}
for _, definition in ipairs(optionDefinitions) do
	allowedOptionNames[definition.name] = true
end

local function validateOptionValue(funcName, definition, value)
	local paramName = "options." .. definition.name
	if definition.kind == "boolean" then
		if type(value) ~= "boolean" then
			error(funcName .. ": '" .. paramName .. "' must be a boolean")
		end
	elseif definition.kind == "string" then
		if type(value) ~= "string" then
			error(funcName .. ": '" .. paramName .. "' must be a string")
		end
	elseif definition.kind == "number" then
		validateFiniteNumber(funcName, paramName, value)
	elseif definition.kind == "positiveNumber" then
		validatePositiveNumber(funcName, paramName, value)
	elseif definition.kind == "unitNumber" then
		validateFiniteNumber(funcName, paramName, value)
		if value < 0 or value > 1 then
			error(funcName .. ": '" .. paramName .. "' must be between 0 and 1")
		end
	elseif definition.kind == "color" then
		if type(value) ~= "table" then
			error(funcName .. ": '" .. paramName .. "' must be a Color3")
		end
		validateFiniteNumber(funcName, paramName .. ".R", value.R)
		validateFiniteNumber(funcName, paramName .. ".G", value.G)
		validateFiniteNumber(funcName, paramName .. ".B", value.B)
	elseif definition.kind == "parent" then
		if type(value) ~= "table" or type(value.Children) ~= "table" then
			error(funcName .. ": '" .. paramName .. "' must be an Instance")
		end
	end
end

local function validateOptions(funcName, options, additionalAllowedOptionNames)
	if options == nil then
		return nil
	end
	if type(options) ~= "table" then
		error(funcName .. ": 'options' must be a table")
	end

	-- Check property-style casing first so common mistakes receive a stable,
	-- actionable correction instead of a generic unknown-key error.
	for _, definition in ipairs(optionDefinitions) do
		if definition.property ~= definition.name and options[definition.property] ~= nil then
			error(funcName .. ": unknown option '" .. definition.property .. "'; use '" .. definition.name .. "'")
		end
	end
	for optionName in pairs(options) do
		local isAdditional = additionalAllowedOptionNames ~= nil and additionalAllowedOptionNames[optionName]
		if type(optionName) ~= "string" or (not allowedOptionNames[optionName] and not isAdditional) then
			error(funcName .. ": unknown option '" .. tostring(optionName) .. "'")
		end
	end
	for _, definition in ipairs(optionDefinitions) do
		local value = options[definition.name]
		if value ~= nil then
			validateOptionValue(funcName, definition, value)
		end
	end
	return options
end

local function validateSegmentShape(funcName, segmentShape)
	if segmentShape ~= nil and segmentShape ~= "Cylinder" and segmentShape ~= "Block" then
		error(funcName .. ": 'options.segmentShape' must be 'Cylinder' or 'Block'")
	end
	return segmentShape or "Cylinder"
end

local function validateSegmentCount(funcName, segments, minimum)
	validateFiniteNumber(funcName, "options.segments", segments)
	if segments ~= math.floor(segments) then
		error(funcName .. ": 'options.segments' must be an integer")
	end
	if segments < minimum then
		error(funcName .. ": 'options.segments' must be at least " .. tostring(minimum))
	end
	if segments > MAX_COMPOSITE_SEGMENTS then
		error(funcName .. ": 'options.segments' must not exceed " .. tostring(MAX_COMPOSITE_SEGMENTS))
	end
	return segments
end

local function copyPartOptions(options, parent)
	local copied = { parent = parent }
	for _, definition in ipairs(optionDefinitions) do
		if definition.name ~= "parent" then
			copied[definition.name] = options[definition.name]
		end
	end
	return copied
end

local function applyOptions(part, options)
	if options == nil then
		return part
	end
	part.Color = options.color
	part.Material = options.material
	for _, definition in ipairs(optionDefinitions) do
		if definition.name ~= "color" and definition.name ~= "material" and definition.name ~= "parent" then
			local value = options[definition.name]
			if value ~= nil then
				part[definition.property] = value
			end
		end
	end
	return parentTo(part, options.parent)
end

local function directPart(funcName, name, shape, cframe, size, options)
	validateOptions(funcName, options)
	local part = Ovdr.createInstance("Part", name)
	part.Anchored = true
	part.Shape = shape
	part.CFrame = cframe
	part.Size = size
	return applyOptions(part, options)
end

local function boxBetweenWithOptions(funcName, name, startPoint, endPoint, thickness, height, options)
	validateFiniteVector3(funcName, "startPoint", startPoint)
	validateFiniteVector3(funcName, "endPoint", endPoint)
	validatePositiveNumber(funcName, "thickness", thickness)
	validatePositiveNumber(funcName, "height", height)
	local length = (endPoint - startPoint).Magnitude
	if length <= EPSILON then
		error(funcName .. ": 'startPoint' and 'endPoint' must be distinct")
	end
	return directPart(
		funcName,
		name,
		"Block",
		MathUtils.frameBetween(startPoint, endPoint, Ovdr.Vector3.xAxis, Ovdr.Vector3.yAxis),
		Ovdr.Vector3.new(length, height, thickness),
		options
	)
end

local function midpoint(points)
	local total = Ovdr.Vector3.zero
	for _, point in ipairs(points) do
		total += point
	end
	return total / #points
end

local function primitive(name, primitiveName, data, cframe, parent)
	if type(parent) == "table" and parent.Children ~= nil then
	else
		parent = nil
	end
	local node = Ovdr.createInstance("Primitive", name)
	node.Primitive = primitiveName
	node.Data = data or {}
	node.CFrame = cframe or Ovdr.CFrame.identity
	return parentTo(node, parent)
end

function GP.model(name, parent)
	local model = Ovdr.createInstance("Model", name)
	model.WorldPivot = Ovdr.CFrame.identity
	return parentTo(model, parent)
end

function GP.sphere(name, center, radius, color, material, parent)
	local part = Ovdr.createInstance("Part", name)
	part.Anchored = true
	part.Shape = "Ball"
	part.CFrame = cframeAt(center)
	part.Size = Ovdr.Vector3.new(radius * 2, radius * 2, radius * 2)
	part.Color = color
	part.Material = material
	return parentTo(part, parent)
end

function GP.block(name, center, size, color, material, parent)
	local part = Ovdr.createInstance("Part", name)
	part.Anchored = true
	part.Shape = "Block"
	part.CFrame = center.Position and center or cframeAt(center)
	part.Size = size
	part.Color = color
	part.Material = material
	return parentTo(part, parent)
end

function GP.cylinder(name, center, height, radius, color, material, parent)
	if type(height) == "table" then
		return GP.cylinderBetween(name, center, height, radius, {
			color = color,
			material = material,
			parent = parent,
		})
	end

	local part = Ovdr.createInstance("Part", name)
	part.Anchored = true
	part.Shape = "Cylinder"
	part.CFrame = cframeAt(center)
	part.Size = Ovdr.Vector3.new(radius * 2, height, radius * 2)
	part.Color = color
	part.Material = material
	return parentTo(part, parent)
end

function GP.cylinderBetween(name, startPoint, endPoint, radius, options)
	validateFiniteVector3("cylinderBetween", "startPoint", startPoint)
	validateFiniteVector3("cylinderBetween", "endPoint", endPoint)
	validatePositiveNumber("cylinderBetween", "radius", radius)
	local length = (endPoint - startPoint).Magnitude
	if length <= EPSILON then
		error("cylinderBetween: 'startPoint' and 'endPoint' must be distinct")
	end
	return directPart(
		"cylinderBetween",
		name,
		"Cylinder",
		MathUtils.frameBetween(startPoint, endPoint, Ovdr.Vector3.yAxis, Ovdr.Vector3.yAxis),
		Ovdr.Vector3.new(radius * 2, length, radius * 2),
		options
	)
end

function GP.ellipsoid(name, centerOrCFrame, size, options)
	validateFiniteVector3("ellipsoid", "size", size)
	validatePositiveNumber("ellipsoid", "size.X", size.X)
	validatePositiveNumber("ellipsoid", "size.Y", size.Y)
	validatePositiveNumber("ellipsoid", "size.Z", size.Z)
	return directPart("ellipsoid", name, "Ball", resolveCFrame("ellipsoid", centerOrCFrame), size, options)
end

function GP.panel(name, centerOrCFrame, width, height, thickness, options)
	validatePositiveNumber("panel", "width", width)
	validatePositiveNumber("panel", "height", height)
	validatePositiveNumber("panel", "thickness", thickness)
	return directPart(
		"panel",
		name,
		"Block",
		resolveCFrame("panel", centerOrCFrame),
		Ovdr.Vector3.new(width, height, thickness),
		options
	)
end

function GP.disc(name, centerOrCFrame, radius, thickness, options)
	validatePositiveNumber("disc", "radius", radius)
	validatePositiveNumber("disc", "thickness", thickness)
	return directPart(
		"disc",
		name,
		"Cylinder",
		resolveCFrame("disc", centerOrCFrame),
		Ovdr.Vector3.new(radius * 2, thickness, radius * 2),
		options
	)
end

function GP.polyline(name, points, thickness, options)
	validatePositiveNumber("polyline", "thickness", thickness)
	validateOptions("polyline", options, { segmentShape = true, closed = true })
	local segmentShape = validateSegmentShape("polyline", options and options.segmentShape)
	local closed = options and options.closed or false
	if options ~= nil and options.closed ~= nil and type(options.closed) ~= "boolean" then
		error("polyline: 'options.closed' must be a boolean")
	end
	if type(points) ~= "table" then
		error("polyline: 'points' must be an array")
	end
	local minimum = closed and 3 or 2
	if #points < minimum then
		error("polyline: 'points' must contain at least " .. tostring(minimum) .. " points")
	end
	if #points > MAX_POINT_COUNT then
		error("polyline: point count must not exceed " .. tostring(MAX_POINT_COUNT))
	end
	for index, point in ipairs(points) do
		validateFiniteVector3("polyline", "points[" .. tostring(index) .. "]", point)
	end

	local segments = {}
	local function appendSegment(startPoint, endPoint)
		if (endPoint - startPoint).Magnitude > EPSILON then
			table.insert(segments, { startPoint = startPoint, endPoint = endPoint })
		end
	end
	for index = 1, #points - 1 do
		appendSegment(points[index], points[index + 1])
	end
	if closed then
		appendSegment(points[#points], points[1])
	end
	if #segments > MAX_COMPOSITE_SEGMENTS then
		error("polyline: segment count must not exceed " .. tostring(MAX_COMPOSITE_SEGMENTS))
	end

	local model = GP.model(name, nil)
	local partOptions = copyPartOptions(options or {}, model)
	for index, segment in ipairs(segments) do
		local segmentName = name .. "_" .. tostring(index)
		if segmentShape == "Block" then
			boxBetweenWithOptions(
				"polyline",
				segmentName,
				segment.startPoint,
				segment.endPoint,
				thickness,
				thickness,
				partOptions
			)
		else
			GP.cylinderBetween(segmentName, segment.startPoint, segment.endPoint, thickness / 2, partOptions)
		end
	end
	return parentTo(model, options and options.parent)
end

local curveOptionNames = { thickness = true, segments = true, axis = true, segmentShape = true }

local function validateCurveOptions(funcName, options, minimumSegments)
	if type(options) ~= "table" then
		error(funcName .. ": 'options' must be a table")
	end
	validateOptions(funcName, options, curveOptionNames)
	if options.thickness == nil then
		error(funcName .. ": 'options.thickness' is required")
	end
	if options.segments == nil then
		error(funcName .. ": 'options.segments' is required")
	end
	if options.axis == nil then
		error(funcName .. ": 'options.axis' is required")
	end
	validatePositiveNumber(funcName, "options.thickness", options.thickness)
	validateSegmentCount(funcName, options.segments, minimumSegments)
	validateFiniteVector3(funcName, "options.axis", options.axis)
	if options.axis.Magnitude <= EPSILON then
		error(funcName .. ": 'options.axis' must be non-zero")
	end
	validateSegmentShape(funcName, options.segmentShape)
	return options
end

local function curvePolylineOptions(options, closed)
	local polylineOptions = copyPartOptions(options, options.parent)
	polylineOptions.segmentShape = options.segmentShape
	polylineOptions.closed = closed
	return polylineOptions
end

local function validateSampledSegments(funcName, points, closed)
	for index = 1, #points - 1 do
		if (points[index + 1] - points[index]).Magnitude <= EPSILON then
			error(funcName .. ": the requested sampling produces a degenerate segment")
		end
	end
	if closed and (points[1] - points[#points]).Magnitude <= EPSILON then
		error(funcName .. ": the requested sampling produces a degenerate segment")
	end
end

function GP.arc(name, center, radius, startAngle, endAngle, options)
	validateCurveOptions("arc", options, 1)
	local points = MathUtils.pointsOnArc(center, radius, startAngle, endAngle, options.segments + 1, options.axis)
	validateSampledSegments("arc", points, false)
	return GP.polyline(name, points, options.thickness, curvePolylineOptions(options, false))
end

function GP.ring(name, center, radius, options)
	validateCurveOptions("ring", options, 3)
	local points = MathUtils.pointsOnCircle(center, radius, options.segments, options.axis)
	validateSampledSegments("ring", points, true)
	return GP.polyline(name, points, options.thickness, curvePolylineOptions(options, true))
end

function GP.taperedCylinder(name, ...)
	local startPoint, endPoint, radiusTop, radiusBottom, color, material, parent = ...
	return primitive(name, "TaperedCylinder", {
		startPoint = startPoint,
		endPoint = endPoint,
		radiusTop = radiusTop,
		radiusBottom = radiusBottom,
		color = color,
		material = material,
	}, MathUtils.frameBetween(startPoint, endPoint, Ovdr.Vector3.yAxis, Ovdr.Vector3.yAxis), parent)
end

function GP.capsule(name, ...)
	local endpoint1, radius1, endpoint2, radius2, color, material, parent = ...
	return primitive(name, "Capsule", {
		endpoint1 = endpoint1,
		endpoint2 = endpoint2,
		radius1 = radius1,
		radius2 = radius2,
		color = color,
		material = material,
	}, MathUtils.frameBetween(endpoint1, endpoint2, Ovdr.Vector3.yAxis, Ovdr.Vector3.yAxis), parent)
end

function GP.regularPrism(name, ...)
	local startPoint, endPoint, radius, sides, color, material, parent = ...
	return primitive(name, "RegularPrism", {
		startPoint = startPoint,
		endPoint = endPoint,
		radius = radius,
		sides = sides,
		color = color,
		material = material,
	}, MathUtils.frameBetween(startPoint, endPoint, Ovdr.Vector3.yAxis, Ovdr.Vector3.yAxis), parent)
end

function GP.boxBetween(name, ...)
	local startPoint, endPoint, thickness, height, color, material, parent = ...
	return boxBetweenWithOptions(
		"boxBetween",
		name,
		startPoint,
		endPoint,
		thickness,
		height,
		{ color = color, material = material, parent = parent }
	)
end

function GP.triangle(name, ...)
	local point1, point2, point3, thickness, normal, color, material, parent = ...
	return primitive(name, "TriangularPrismFromThreePoints", {
		point1 = point1,
		point2 = point2,
		point3 = point3,
		thickness = thickness,
		normal = normal,
		color = color,
		material = material,
	}, cframeAt(midpoint({ point1, point2, point3 })), parent)
end

function GP.quad(name, ...)
	local point1, point2, point3, point4, thickness, normal, color, material, parent = ...
	return primitive(name, "QuadFromFourPoints", {
		point1 = point1,
		point2 = point2,
		point3 = point3,
		point4 = point4,
		thickness = thickness,
		normal = normal,
		color = color,
		material = material,
	}, cframeAt(midpoint({ point1, point2, point3, point4 })), parent)
end

-- Compatibility aliases for scripts authored against the original API.
GP.strutFromTwoPoints = GP.boxBetween
GP.triangularPrismFromThreePoints = GP.triangle
GP.quadFromFourPoints = GP.quad

return GP
