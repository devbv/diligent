--!strict
-- generationId: demo-simple-house-001
local GP = require(script.Dependencies.GeometryPrimitives)

local SimpleHouse = {}

SimpleHouse.OnGenerate = function(parameters, targetContainer)
	local house = GP.model("SimpleHouse", nil)
	house.WorldPivot = CFrame.identity

	local width = parameters.Attributes.Width or 12
	local height = parameters.Attributes.Height or 8
	local depth = parameters.Attributes.Depth or 10
	local wallColor = parameters.Attributes.WallColor or Color3.fromRGB(230, 210, 170)
	local roofColor = parameters.Attributes.RoofColor or Color3.fromRGB(160, 60, 45)
	local trimColor = parameters.Attributes.TrimColor or Color3.fromRGB(90, 70, 55)
	local windowColor = parameters.Attributes.WindowColor or Color3.fromRGB(120, 180, 240)

	local foundation = GP.model("Foundation", house)
	GP.block("BaseSlab", Vector3.new(0, 0, 0), Vector3.new(width + 1, 1, depth + 1), trimColor, "Rock", foundation)

	local walls = GP.model("Walls", house)
	GP.block("WallFront", Vector3.new(0, height / 2, -depth / 2), Vector3.new(width, height, 1), wallColor, "Plastic", walls)
	GP.block("WallBack", Vector3.new(0, height / 2, depth / 2), Vector3.new(width, height, 1), wallColor, "Plastic", walls)
	GP.block("WallLeft", Vector3.new(-width / 2, height / 2, 0), Vector3.new(1, height, depth), wallColor, "Plastic", walls)
	GP.block("WallRight", Vector3.new(width / 2, height / 2, 0), Vector3.new(1, height, depth), wallColor, "Plastic", walls)

	local roof = GP.model("Roof", house)
	GP.strutFromTwoPoints("RoofLeft", Vector3.new(-width / 2 - 1, height + 1, -depth / 2 - 1), Vector3.new(0, height + 4, 0), depth + 2, 1.2, roofColor, "Metal", roof)
	GP.strutFromTwoPoints("RoofRight", Vector3.new(width / 2 + 1, height + 1, -depth / 2 - 1), Vector3.new(0, height + 4, 0), depth + 2, 1.2, roofColor, "Metal", roof)

	local doorGroup = GP.model("DoorGroup", walls)
	GP.block("Door", Vector3.new(0, 2, -depth / 2 - 0.6), Vector3.new(2.5, 4, 0.4), trimColor, "Wood", doorGroup)
	GP.sphere("DoorKnob", Vector3.new(0.9, 2, -depth / 2 - 0.9), 0.2, Color3.fromRGB(240, 210, 80), "Metal", doorGroup)

	local windowGroup = GP.model("WindowGroup", walls)
	GP.block("WindowLeft", Vector3.new(-3.5, 5, -depth / 2 - 0.6), Vector3.new(2, 2, 0.3), windowColor, "Glass", windowGroup)
	GP.block("WindowRight", Vector3.new(3.5, 5, -depth / 2 - 0.6), Vector3.new(2, 2, 0.3), windowColor, "Glass", windowGroup)

	house.Parent = targetContainer
end

return SimpleHouse
