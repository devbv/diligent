--!strict
local GP = require(script.Dependencies.GeometryPrimitives)

local Pentagon = {}

Pentagon.OnGenerate = function(parameters, targetContainer)
	local model = GP.model("Pentagon", nil)
	model.WorldPivot = CFrame.identity

	local radius = parameters.Attributes.Radius or 10
	local height = parameters.Attributes.Height or 4
	local wallThickness = parameters.Attributes.WallThickness or 1
	local wallColor = parameters.Attributes.WallColor or Color3.fromRGB(120, 160, 220)
	local floorColor = parameters.Attributes.FloorColor or Color3.fromRGB(180, 180, 180)

	local center = Vector3.new(0, 0, 0)
	local points = {}
	for i = 1, 5 do
		local theta = ((i - 1) / 5) * math.pi * 2 - math.pi / 2
		points[i] = Vector3.new(math.cos(theta) * radius, 0, math.sin(theta) * radius)
	end

	for i = 1, 5 do
		local nextIndex = (i % 5) + 1
		GP.boxBetween("Wall_" .. i, points[i] + Vector3.yAxis * (height / 2), points[nextIndex] + Vector3.yAxis * (height / 2), wallThickness, height, wallColor, "Metal", model)
		GP.cylinder("Corner_" .. i, points[i], points[i] + Vector3.yAxis * height, wallThickness * 0.75, wallColor, "Metal", model)
		GP.triangle("FloorTri_" .. i, center, points[i], points[nextIndex], 0.2, Vector3.yAxis, floorColor, "Plastic", model)
	end

	model.Parent = targetContainer
end

return Pentagon
