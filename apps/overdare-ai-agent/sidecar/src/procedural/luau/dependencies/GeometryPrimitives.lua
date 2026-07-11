-- @summary Luau GeometryPrimitives dependency for OVDR procedural dummy generation.

local Ovdr = require("../ovdr-shim")
local MathUtils = require("./MathUtils")

local GP = {}
local EPSILON = 0.000001

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

local optionProperties = {
	transparency = "Transparency",
	canCollide = "CanCollide",
	canQuery = "CanQuery",
	canTouch = "CanTouch",
	castShadow = "CastShadow",
	anchored = "Anchored",
	collisionGroup = "CollisionGroup",
	locked = "Locked",
	mass = "Mass",
	massless = "Massless",
	materialVariant = "MaterialVariant",
	reflectance = "Reflectance",
	rootPriority = "RootPriority",
}

local function applyOptions(part, options)
	if options == nil then
		return part
	end
	if type(options) ~= "table" then
		error("geometry options must be a table")
	end
	part.Color = options.color
	part.Material = options.material
	for optionName, propertyName in pairs(optionProperties) do
		if options[optionName] ~= nil then
			part[propertyName] = options[optionName]
		end
	end
	return parentTo(part, options.parent)
end

local function directPart(name, shape, cframe, size, options)
	local part = Ovdr.createInstance("Part", name)
	part.Shape = shape
	part.CFrame = cframe
	part.Size = size
	return applyOptions(part, options)
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
	part.Shape = "Ball"
	part.CFrame = cframeAt(center)
	part.Size = Ovdr.Vector3.new(radius * 2, radius * 2, radius * 2)
	part.Color = color
	part.Material = material
	return parentTo(part, parent)
end

function GP.block(name, center, size, color, material, parent)
	local part = Ovdr.createInstance("Part", name)
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
	return directPart(name, "Ball", resolveCFrame("ellipsoid", centerOrCFrame), size, options)
end

function GP.panel(name, centerOrCFrame, width, height, thickness, options)
	validatePositiveNumber("panel", "width", width)
	validatePositiveNumber("panel", "height", height)
	validatePositiveNumber("panel", "thickness", thickness)
	return directPart(
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
		name,
		"Cylinder",
		resolveCFrame("disc", centerOrCFrame),
		Ovdr.Vector3.new(radius * 2, thickness, radius * 2),
		options
	)
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
	validateFiniteVector3("boxBetween", "startPoint", startPoint)
	validateFiniteVector3("boxBetween", "endPoint", endPoint)
	validatePositiveNumber("boxBetween", "thickness", thickness)
	validatePositiveNumber("boxBetween", "height", height)
	local length = (endPoint - startPoint).Magnitude
	if length <= EPSILON then
		error("boxBetween: 'startPoint' and 'endPoint' must be distinct")
	end
	return directPart(
		name,
		"Block",
		MathUtils.frameBetween(startPoint, endPoint, Ovdr.Vector3.xAxis, Ovdr.Vector3.yAxis),
		Ovdr.Vector3.new(length, height, thickness),
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
