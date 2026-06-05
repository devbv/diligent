-- @summary Luau GeometryPrimitives dependency for OVDR procedural dummy generation.

local Ovdr = require("../ovdr-shim")

local GP = {}

local function parentTo(instance, parent)
	if parent ~= nil then
		instance.Parent = parent
	end
	return instance
end

local function cframeAt(position)
	return Ovdr.CFrame.new(position.X, position.Y, position.Z)
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
		local startPoint = center
		local endPoint = height
		local pointRadius = radius
		local pointColor = color
		local pointMaterial = material
		local pointParent = parent
		return primitive(name, "CylinderFromTwoPoints", {
			startPoint = startPoint,
			endPoint = endPoint,
			radius = pointRadius,
			color = pointColor,
			material = pointMaterial,
		}, cframeAt(midpoint({ startPoint, endPoint })), pointParent)
	end

	local part = Ovdr.createInstance("Part", name)
	part.Shape = "Cylinder"
	part.CFrame = cframeAt(center)
	part.Size = Ovdr.Vector3.new(radius * 2, height, radius * 2)
	part.Color = color
	part.Material = material
	return parentTo(part, parent)
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
	}, cframeAt(midpoint({ startPoint, endPoint })), parent)
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
	}, cframeAt(midpoint({ endpoint1, endpoint2 })), parent)
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
	}, cframeAt(midpoint({ startPoint, endPoint })), parent)
end

function GP.strutFromTwoPoints(name, ...)
	local startPoint, endPoint, thickness, height, color, material, parent = ...
	return primitive(name, "StrutFromTwoPoints", {
		startPoint = startPoint,
		endPoint = endPoint,
		thickness = thickness,
		height = height,
		color = color,
		material = material,
	}, cframeAt(midpoint({ startPoint, endPoint })), parent)
end

function GP.triangularPrismFromThreePoints(name, ...)
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

function GP.pyramid(name, ...)
	local baseCorner1, baseCorner2, apex, color, material, parent = ...
	return primitive(name, "Pyramid", {
		baseCorner1 = baseCorner1,
		baseCorner2 = baseCorner2,
		apex = apex,
		color = color,
		material = material,
	}, cframeAt(midpoint({ baseCorner1, baseCorner2, apex })), parent)
end

function GP.quadFromFourPoints(name, ...)
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

return GP
