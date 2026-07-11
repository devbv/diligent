-- @summary Luau-side OVDR shim for procedural dummy generation.

local Ovdr = {}
local nextNodeId = 1

local Vector3Meta = {}

local function isVector3(value)
	return type(value) == "table" and getmetatable(value) == Vector3Meta
end

local function vector3(x, y, z)
	return setmetatable({ X = x, Y = y, Z = z }, Vector3Meta)
end

local function magnitude(value)
	return math.sqrt(value.X * value.X + value.Y * value.Y + value.Z * value.Z)
end

local function clamp(value, minValue, maxValue)
	return math.max(minValue, math.min(maxValue, value))
end

local function cleanNumber(value)
	if math.abs(value) < 0.000000000001 then
		return 0
	end
	return value
end

Vector3Meta.__add = function(left, right)
	return vector3(left.X + right.X, left.Y + right.Y, left.Z + right.Z)
end

Vector3Meta.__sub = function(left, right)
	return vector3(left.X - right.X, left.Y - right.Y, left.Z - right.Z)
end

Vector3Meta.__mul = function(left, right)
	if type(left) == "number" then
		return vector3(left * right.X, left * right.Y, left * right.Z)
	end
	if type(right) == "number" then
		return vector3(left.X * right, left.Y * right, left.Z * right)
	end
	error("Vector3 multiplication only supports scalar values")
end

Vector3Meta.__div = function(left, right)
	if type(right) ~= "number" then
		error("Vector3 division only supports scalar values")
	end
	return vector3(left.X / right, left.Y / right, left.Z / right)
end

Vector3Meta.__unm = function(value)
	return vector3(-value.X, -value.Y, -value.Z)
end

Vector3Meta.__index = function(value, key)
	if key == "Magnitude" then
		return magnitude(value)
	end
	if key == "Unit" then
		local mag = magnitude(value)
		if mag == 0 then
			return vector3(0, 0, 0)
		end
		return value / mag
	end
	if key == "Cross" then
		return function(_, other)
			return vector3(
				value.Y * other.Z - value.Z * other.Y,
				value.Z * other.X - value.X * other.Z,
				value.X * other.Y - value.Y * other.X
			)
		end
	end
	if key == "Dot" then
		return function(_, other)
			return value.X * other.X + value.Y * other.Y + value.Z * other.Z
		end
	end
	if key == "Lerp" then
		return function(_, other, alpha)
			return value + (other - value) * alpha
		end
	end
	return rawget(value, key)
end

Ovdr.Vector3 = {
	new = vector3,
	zero = vector3(0, 0, 0),
	xAxis = vector3(1, 0, 0),
	yAxis = vector3(0, 1, 0),
	zAxis = vector3(0, 0, 1),
}

Ovdr.Color3 = {
	fromRGB = function(r, g, b)
		return { R = r, G = g, B = b }
	end,
	new = function(r, g, b)
		return { R = math.floor(r * 255 + 0.5), G = math.floor(g * 255 + 0.5), B = math.floor(b * 255 + 0.5) }
	end,
}

local CFrameMeta = {}

local function isCFrame(value)
	return type(value) == "table" and getmetatable(value) == CFrameMeta
end

local function basisFromOrientation(orientation)
	local roll = math.rad(orientation.X)
	local pitch = math.rad(orientation.Y)
	local yaw = math.rad(orientation.Z)
	local cr, sr = math.cos(roll), math.sin(roll)
	local cp, sp = math.cos(pitch), math.sin(pitch)
	local cy, sy = math.cos(yaw), math.sin(yaw)
	return vector3(cy * cp, sy * cp, -sp),
		vector3(cy * sp * sr - sy * cr, sy * sp * sr + cy * cr, cp * sr),
		vector3(cy * sp * cr + sy * sr, sy * sp * cr - cy * sr, cp * cr)
end

local function cframe(position, orientation, rightVector, upVector, backVector)
	local resolvedOrientation = orientation or vector3(0, 0, 0)
	local right, up, back = rightVector, upVector, backVector
	if right == nil or up == nil or back == nil then
		right, up, back = basisFromOrientation(resolvedOrientation)
	end
	return setmetatable({
		Position = position,
		Orientation = resolvedOrientation,
		_rightVector = right,
		_upVector = up,
		_backVector = back,
	}, CFrameMeta)
end

local function orientationFromBasis(rightVector, upVector, backVector)
	if math.abs(upVector.X) < 0.000001 and math.abs(upVector.Z) < 0.000001 and math.abs(upVector.Y) > 0.999999 then
		return vector3(0, -math.deg(math.atan2(rightVector.Z, rightVector.X)), 0)
	end

	local r00 = rightVector.X
	local r10 = rightVector.Y
	local r20 = rightVector.Z
	local r21 = upVector.Z
	local r22 = backVector.Z
	local r01 = upVector.X
	local r02 = backVector.X

	local pitch = math.asin(clamp(-r20, -1, 1))
	local yaw
	local roll
	if math.abs(math.cos(pitch)) > 0.000001 then
		yaw = math.atan2(r10, r00)
		roll = math.atan2(r21, r22)
	else
		yaw = 0
		roll = math.atan2(-r01, r02)
	end

	return vector3(math.deg(roll), math.deg(pitch), math.deg(yaw))
end

local function pointsBounds(points)
	local first = points[1]
	local minX, minY, minZ = first.X, first.Y, first.Z
	local maxX, maxY, maxZ = first.X, first.Y, first.Z
	for _, point in ipairs(points) do
		minX = math.min(minX, point.X)
		minY = math.min(minY, point.Y)
		minZ = math.min(minZ, point.Z)
		maxX = math.max(maxX, point.X)
		maxY = math.max(maxY, point.Y)
		maxZ = math.max(maxZ, point.Z)
	end
	return {
		center = vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2),
		size = vector3(math.max(maxX - minX, 0.1), math.max(maxY - minY, 0.1), math.max(maxZ - minZ, 0.1)),
	}
end

local function alignmentOffset(thickness, extrusionDir, normal)
	if isVector3(extrusionDir) then
		local sign = extrusionDir:Dot(normal) >= 0 and 1 or -1
		return normal * (sign * thickness / 2)
	end
	return Ovdr.Vector3.zero
end

local function planeNormalFromPoints(points, origin)
	if #points >= 4 then
		local normalSum = vector3(0, 0, 0)
		for index, current in ipairs(points) do
			local nextPoint = points[(index % #points) + 1]
			normalSum += vector3(
				(current.Y - nextPoint.Y) * (current.Z + nextPoint.Z),
				(current.Z - nextPoint.Z) * (current.X + nextPoint.X),
				(current.X - nextPoint.X) * (current.Y + nextPoint.Y)
			)
		end
		if normalSum.Magnitude > 0.000001 then
			return normalSum.Unit
		end
	end

	for secondIndex = 2, #points - 1 do
		for thirdIndex = secondIndex + 1, #points do
			local candidate = (points[secondIndex] - origin):Cross(points[thirdIndex] - origin)
			if candidate.Magnitude > 0.000001 then
				return candidate.Unit
			end
		end
	end

	return nil
end

local function verticalPlaneProperties(points, thickness, extrusionDir, normal)
	local horizontalNormal = vector3(normal.X, 0, normal.Z)
	if horizontalNormal.Magnitude <= 0.000001 then
		return nil, nil
	end
	horizontalNormal = horizontalNormal.Unit
	local horizontalAxis = Ovdr.Vector3.yAxis:Cross(horizontalNormal)
	if horizontalAxis.Magnitude <= 0.000001 then
		horizontalAxis = Ovdr.Vector3.xAxis
	else
		horizontalAxis = horizontalAxis.Unit
	end

	local minX, maxX = math.huge, -math.huge
	local minY, maxY = math.huge, -math.huge
	local minNormal, maxNormal = math.huge, -math.huge
	for _, point in ipairs(points) do
		local localX = point:Dot(horizontalAxis)
		local localY = point.Y
		local localNormal = point:Dot(horizontalNormal)
		minX = math.min(minX, localX)
		maxX = math.max(maxX, localX)
		minY = math.min(minY, localY)
		maxY = math.max(maxY, localY)
		minNormal = math.min(minNormal, localNormal)
		maxNormal = math.max(maxNormal, localNormal)
	end

	local center = horizontalAxis * ((minX + maxX) / 2)
		+ Ovdr.Vector3.yAxis * ((minY + maxY) / 2)
		+ horizontalNormal * ((minNormal + maxNormal) / 2)
		+ alignmentOffset(thickness, extrusionDir, horizontalNormal)
	local yaw = -math.deg(math.atan2(horizontalAxis.Z, horizontalAxis.X))
	return cframe(center, vector3(0, yaw, 0)), vector3(
		math.max(maxX - minX, thickness),
		math.max(maxY - minY, thickness),
		math.max(maxNormal - minNormal, thickness)
	)
end

local function orientedPlaneProperties(points, thickness, extrusionDir)
	local origin = points[1]
	local normal = planeNormalFromPoints(points, origin)
	if normal == nil then
		local bounds = pointsBounds(points)
		return cframe(bounds.center, vector3(0, 0, 0)), bounds.size
	end

	if isVector3(extrusionDir) and normal:Dot(extrusionDir) < 0 then
		normal = -normal
	elseif not isVector3(extrusionDir) and math.abs(normal.Y) > 0.01 and normal.Y < 0 then
		normal = -normal
	end

	if math.abs(normal.Y) < 0.05 then
		local planeCFrame, planeSize = verticalPlaneProperties(points, thickness, extrusionDir, normal)
		if planeCFrame ~= nil and planeSize ~= nil then
			return planeCFrame, planeSize
		end
	end

	local xAxis = nil
	for index = 2, #points do
		local edge = points[index] - origin
		if edge.Magnitude > 0.000001 then
			xAxis = edge.Unit
			break
		end
	end
	if xAxis == nil then
		local bounds = pointsBounds(points)
		return cframe(bounds.center, vector3(0, 0, 0)), bounds.size
	end

	local zAxis = xAxis:Cross(normal)
	if zAxis.Magnitude <= 0.000001 then
		local fallback = math.abs(normal:Dot(Ovdr.Vector3.yAxis)) > 0.95 and Ovdr.Vector3.zAxis or Ovdr.Vector3.yAxis
		xAxis = fallback:Cross(normal).Unit
		zAxis = xAxis:Cross(normal)
	end
	zAxis = zAxis.Unit
	xAxis = normal:Cross(zAxis).Unit

	local minX, maxX = math.huge, -math.huge
	local minZ, maxZ = math.huge, -math.huge
	for _, point in ipairs(points) do
		local offset = point - origin
		local localX = offset:Dot(xAxis)
		local localZ = offset:Dot(zAxis)
		minX = math.min(minX, localX)
		maxX = math.max(maxX, localX)
		minZ = math.min(minZ, localZ)
		maxZ = math.max(maxZ, localZ)
	end

	local center = origin + xAxis * ((minX + maxX) / 2) + zAxis * ((minZ + maxZ) / 2) + alignmentOffset(thickness, extrusionDir, normal)
	if not isVector3(extrusionDir) and math.abs(normal.Y) < 0.000001 and math.abs(zAxis.Y) > 0.999999 then
		return cframe(center, vector3(0, -math.deg(math.atan2(xAxis.Z, xAxis.X)), 0)), vector3(math.max(maxX - minX, thickness), math.max(maxZ - minZ, thickness), thickness)
	end
	return Ovdr.CFrame.fromMatrix(center, xAxis, normal, zAxis), vector3(math.max(maxX - minX, thickness), thickness, math.max(maxZ - minZ, thickness))
end

local supportedMaterials = {
	Basic = true,
	Plastic = true,
	Brick = true,
	Rock = true,
	Metal = true,
	Unlit = true,
	Bark = true,
	SmallBrick = true,
	LeafyGround = true,
	MossyGround = true,
	Ground = true,
	Glass = true,
	Paving = true,
	MossyRock = true,
	Wood = true,
	Neon = true,
}

local materialAliases = {
	Concrete = "Rock",
	Granite = "Rock",
	Marble = "Rock",
	Sand = "Ground",
	Sandstone = "Rock",
	Slate = "Rock",
	SmoothPlastic = "Plastic",
}

local function cleanMaterial(material)
	if type(material) ~= "string" then
		return material
	end
	if supportedMaterials[material] then
		return material
	end
	return materialAliases[material] or "Plastic"
end

local partOverrideKeys = {
	"CanCollide",
	"CanQuery",
	"CanTouch",
	"CastShadow",
	"CollisionGroup",
	"Locked",
	"Mass",
	"Massless",
	"MaterialVariant",
	"Reflectance",
	"RootPriority",
	"Transparency",
}

local function applyPartOverrides(properties, node)
	if node.Anchored ~= nil then
		properties.Anchored = node.Anchored
	else
		properties.Anchored = true
	end
	for _, key in ipairs(partOverrideKeys) do
		local value = node[key]
		if value ~= nil then
			properties[key] = value
		end
	end
	return properties
end

CFrameMeta.__add = function(left, right)
	if isVector3(right) then
		return cframe(left.Position + right, left.Orientation, left._rightVector, left._upVector, left._backVector)
	end
	error("CFrame addition only supports Vector3")
end

CFrameMeta.__sub = function(left, right)
	if isVector3(right) then
		return cframe(left.Position - right, left.Orientation, left._rightVector, left._upVector, left._backVector)
	end
	error("CFrame subtraction only supports Vector3")
end

CFrameMeta.__index = function(value, key)
	if key == "RightVector" then
		return value._rightVector
	end
	if key == "UpVector" then
		return value._upVector
	end
	if key == "BackVector" then
		return value._backVector
	end
	if key == "LookVector" then
		return -value._backVector
	end
	if key == "VectorToWorldSpace" then
		return function(_, localVector)
			return value._rightVector * localVector.X
				+ value._upVector * localVector.Y
				+ value._backVector * localVector.Z
		end
	end
	if key == "PointToWorldSpace" then
		return function(_, localPoint)
			return value.Position + value:VectorToWorldSpace(localPoint)
		end
	end
	return rawget(value, key)
end

Ovdr.CFrame = {
	identity = cframe(vector3(0, 0, 0), vector3(0, 0, 0)),
	new = function(x, y, z)
		return cframe(vector3(x or 0, y or 0, z or 0), vector3(0, 0, 0))
	end,
	fromPositionOrientation = function(position, orientation)
		return cframe(position, orientation)
	end,
	fromMatrix = function(position, rightVector, upVector, backVector)
		local right = rightVector.Unit
		local up = upVector.Unit
		local back = backVector
		if back == nil then
			back = right:Cross(up)
		end
		back = back.Unit
		return cframe(position, orientationFromBasis(right, up, back), right, up, back)
	end,
}

local Instance = {}
Instance.__index = function(instance, key)
	if key == "Parent" then
		return rawget(instance, "_parent")
	end
	if key == "CFrame" then
		return rawget(instance, "_cframe")
	end
	return Instance[key] or rawget(instance, key)
end

Instance.__newindex = function(instance, key, value)
	if key == "CFrame" and instance.ClassName == "Primitive" then
		Ovdr.applyCFrameOffset(instance, value)
		return
	end
	if key ~= "Parent" then
		rawset(instance, key, value)
		return
	end
	local previous = rawget(instance, "_parent")
	if previous == value then
		return
	end
	if previous then
		for index, child in ipairs(previous.Children) do
			if child == instance then
				table.remove(previous.Children, index)
				break
			end
		end
	end
	rawset(instance, "_parent", value)
	if value then
		table.insert(value.Children, instance)
	end
end

function Instance:IsA(className)
	if className == self.ClassName then
		return true
	end
	if className == "Instance" then
		return true
	end
	if className == "BasePart" and (self.ClassName == "BasePart" or self.ClassName == "Part" or self.ClassName == "Primitive") then
		return true
	end
	return false
end

function Instance:GetDescendants()
	local descendants = {}
	local function visit(node)
		for _, child in ipairs(node.Children) do
			table.insert(descendants, child)
			visit(child)
		end
	end
	visit(self)
	return descendants
end

function Instance:Destroy()
	for _, child in ipairs({ unpack(self.Children) }) do
		child:Destroy()
	end
	self.Parent = nil
	self.Children = {}
	self.Destroyed = true
end

function Ovdr.createInstance(className, name)
	local id = "node-" .. tostring(nextNodeId)
	nextNodeId += 1
	return setmetatable({
		Id = id,
		ClassName = className,
		Name = name,
		Children = {},
	}, Instance)
end

function Ovdr.createTargetContainer()
	return Ovdr.createInstance("Model", "TargetContainer")
end

-- Scene injection: turn a serialized subtree into mock Instances that carry the
-- real scene GUID. Transform scripts read/mutate these; the TS side diffs the
-- serialized end state against the same snapshot to derive update/delete ops.
local function deserializeVector3(value)
	if type(value) ~= "table" then
		return nil
	end
	return vector3(value.X or 0, value.Y or 0, value.Z or 0)
end

local function deserializeCFrame(value)
	if type(value) ~= "table" then
		return nil
	end
	return cframe(deserializeVector3(value.Position) or vector3(0, 0, 0), deserializeVector3(value.Orientation) or vector3(0, 0, 0))
end

local function injectNode(sceneNode)
	local node = Ovdr.createInstance(sceneNode.class or "Instance", sceneNode.name or "")
	node.Injected = true
	node.Guid = sceneNode.guid
	local properties = sceneNode.properties or {}
	-- Whitelisted properties are stored as raw keys so scripts can read them and
	-- reassign them (e.g. `part.CFrame -= Vector3.yAxis * n`) without going
	-- through the Primitive-only CFrame offset path.
	if properties.CFrame ~= nil then
		rawset(node, "CFrame", deserializeCFrame(properties.CFrame))
	end
	if properties.WorldPivot ~= nil then
		rawset(node, "WorldPivot", deserializeCFrame(properties.WorldPivot))
	end
	if properties.Size ~= nil then
		rawset(node, "Size", deserializeVector3(properties.Size))
	end
	if properties.Color ~= nil then
		rawset(node, "Color", properties.Color)
	end
	if properties.Material ~= nil then
		rawset(node, "Material", properties.Material)
	end
	if type(sceneNode.children) == "table" then
		for _, childScene in ipairs(sceneNode.children) do
			injectNode(childScene).Parent = node
		end
	end
	return node
end

function Ovdr.injectScene(sceneJson)
	return injectNode(sceneJson)
end

local function cleanValue(value)
	if isVector3(value) then
		return { X = cleanNumber(value.X), Y = cleanNumber(value.Y), Z = cleanNumber(value.Z) }
	end
	if isCFrame(value) then
		return { Position = cleanValue(value.Position), Orientation = cleanValue(value.Orientation) }
	end
	if type(value) == "table" and value.Id ~= nil then
		return { refId = value.Id, name = value.Name }
	end
	if type(value) ~= "table" then
		return value
	end
	local result = {}
	for key, child in pairs(value) do
		if key ~= "__jsonObject" and key ~= "__jsonArray" then
			result[key] = cleanValue(child)
		end
	end
	return result
end

local function offsetStructuredValue(value, offset)
	if isVector3(value) then
		return value + offset
	end
	if isCFrame(value) then
		return value + offset
	end
	if type(value) ~= "table" or value.Id ~= nil then
		return value
	end
	for key, child in pairs(value) do
		if key ~= "__jsonObject" and key ~= "__jsonArray" then
			value[key] = offsetStructuredValue(child, offset)
		end
	end
	return value
end

function Ovdr.applyCFrameOffset(instance, newCFrame)
	local previous = instance.CFrame
	rawset(instance, "_cframe", newCFrame)
	if previous == nil or not isCFrame(previous) or not isCFrame(newCFrame) then
		return
	end
	local offset = newCFrame.Position - previous.Position
	if instance.ClassName == "Primitive" and instance.Data ~= nil then
		offsetStructuredValue(instance.Data, offset)
	end
end

local function primitiveProperties(node)
	local data = node.Data or {}
	local properties = {
		Shape = "Block",
		CFrame = cleanValue(node.CFrame),
		Size = cleanValue(node.Size or vector3(1, 1, 1)),
		Color = cleanValue(data.color),
		Material = cleanMaterial(data.material),
	}

	if node.Primitive == "CylinderFromTwoPoints" then
		local startPoint = data.startPoint
		local endPoint = data.endPoint
		local radius = data.radius or 0.5
		if startPoint ~= nil and endPoint ~= nil then
			local length = (endPoint - startPoint).Magnitude
			properties.Shape = "Cylinder"
			properties.CFrame = cleanValue(node.CFrame)
			properties.Size = cleanValue(vector3(radius * 2, math.max(length, 0.1), radius * 2))
		end
	elseif node.Primitive == "StrutFromTwoPoints" then
		local startPoint = data.startPoint
		local endPoint = data.endPoint
		local thickness = data.thickness or 1
		local height = data.height or thickness
		if startPoint ~= nil and endPoint ~= nil then
			local length = (endPoint - startPoint).Magnitude
			properties.CFrame = cleanValue(node.CFrame)
			properties.Size = cleanValue(vector3(math.max(length, 0.1), height, thickness))
		end
	elseif node.Primitive == "QuadFromFourPoints" then
		local point1 = data.point1
		local point2 = data.point2
		local point3 = data.point3
		local point4 = data.point4
		if point1 ~= nil and point2 ~= nil and point3 ~= nil and point4 ~= nil then
			local thickness = data.thickness or 0.2
			local planeCFrame, planeSize = orientedPlaneProperties({ point1, point2, point3, point4 }, thickness, data.normal)
			properties.CFrame = cleanValue(planeCFrame)
			properties.Size = cleanValue(planeSize)
		end
	elseif node.Primitive == "TriangularPrismFromThreePoints" then
		local point1 = data.point1
		local point2 = data.point2
		local point3 = data.point3
		if point1 ~= nil and point2 ~= nil and point3 ~= nil then
			local thickness = data.thickness or 0.2
			local planeCFrame, planeSize = orientedPlaneProperties({ point1, point2, point3 }, thickness, data.normal)
			properties.CFrame = cleanValue(planeCFrame)
			properties.Size = cleanValue(planeSize)
		end
	elseif node.Primitive == "TaperedCylinder" or node.Primitive == "RegularPrism" then
		local startPoint = data.startPoint
		local endPoint = data.endPoint
		local radius = data.radius or math.max(data.radiusTop or 0, data.radiusBottom or 0, 0.5)
		if startPoint ~= nil and endPoint ~= nil then
			local length = (endPoint - startPoint).Magnitude
			properties.Shape = "Cylinder"
			properties.CFrame = cleanValue(node.CFrame)
			properties.Size = cleanValue(vector3(radius * 2, math.max(length, 0.1), radius * 2))
		end
	elseif node.Primitive == "Capsule" then
		local endpoint1 = data.endpoint1
		local endpoint2 = data.endpoint2
		local radius1 = data.radius1 or 0.5
		local radius2 = data.radius2 or radius1
		if endpoint1 ~= nil and endpoint2 ~= nil then
			local length = (endpoint2 - endpoint1).Magnitude
			local radius = math.max(radius1, radius2)
			if length <= math.abs(radius1 - radius2) then
				local center = radius1 >= radius2 and endpoint1 or endpoint2
				properties.Shape = "Ball"
				properties.CFrame = cleanValue(cframe(center, vector3(0, 0, 0)))
				properties.Size = cleanValue(vector3(radius * 2, radius * 2, radius * 2))
			else
				local direction = (endpoint2 - endpoint1).Unit
				local center = ((endpoint1 - direction * radius1) + (endpoint2 + direction * radius2)) / 2
				properties.Shape = "Cylinder"
				properties.CFrame = cleanValue(node.CFrame + (center - node.CFrame.Position))
				properties.Size = cleanValue(vector3(radius * 2, math.max(length + radius1 + radius2, 0.1), radius * 2))
			end
		end
	end

	return applyPartOverrides(properties, node)
end

local function serializeInjectedNode(node)
	local properties = {}
	if node.CFrame ~= nil then
		properties.CFrame = cleanValue(node.CFrame)
	end
	if node.WorldPivot ~= nil then
		properties.WorldPivot = cleanValue(node.WorldPivot)
	end
	if node.Size ~= nil then
		properties.Size = cleanValue(node.Size)
	end
	if node.Color ~= nil then
		properties.Color = cleanValue(node.Color)
	end
	if node.Material ~= nil then
		properties.Material = node.Material
	end
	return {
		class = node.ClassName,
		name = node.Name,
		guid = node.Guid,
		properties = properties,
	}
end

local function serializeNode(node)
	if node.Destroyed then
		return nil
	end
	-- Injected (pre-existing scene) nodes pass through with their GUID + a
	-- whitelisted property set, regardless of class. The unsupported-class error
	-- below must never fire for them.
	if node.Injected then
		local result = serializeInjectedNode(node)
		result.children = {}
		for _, child in ipairs(node.Children) do
			local serializedChild = serializeNode(child)
			if serializedChild ~= nil then
				table.insert(result.children, serializedChild)
			end
		end
		if #result.children == 0 then
			result.children = nil
		end
		return result
	end
	local properties = {}
	local className = node.ClassName
	if node.ClassName == "Model" then
		properties.WorldPivot = cleanValue(node.WorldPivot)
	elseif node.ClassName == "Part" then
		properties = applyPartOverrides({
			Shape = node.Shape,
			CFrame = cleanValue(node.CFrame),
			Size = cleanValue(node.Size),
			Color = cleanValue(node.Color),
			Material = cleanMaterial(node.Material),
		}, node)
	elseif node.ClassName == "Primitive" then
		className = "Part"
		properties = primitiveProperties(node)
	else
		error("Unsupported OVDR procedural instance class: " .. tostring(node.ClassName))
	end
	local result = {
		class = className,
		name = node.Name,
		properties = cleanValue(properties),
		children = {},
	}
	for _, child in ipairs(node.Children) do
		local serializedChild = serializeNode(child)
		if serializedChild ~= nil then
			table.insert(result.children, serializedChild)
		end
	end
	if #result.children == 0 then
		result.children = nil
	end
	return result
end

function Ovdr.serializeChildren(targetContainer)
	local children = {}
	for _, child in ipairs(targetContainer.Children) do
		local serializedChild = serializeNode(child)
		if serializedChild ~= nil then
			table.insert(children, serializedChild)
		end
	end
	return children
end

return Ovdr
