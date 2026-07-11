--!strict
local GP = require(script.Dependencies.GeometryPrimitives)
local MU = require(script.Dependencies.MathUtils)


local Rabbit = {}

type Parameters = {
	Size: Vector3,
	Attributes: {
		EarLength: number?,
		FurColor: Color3?,
		BellyColor: Color3?,
		NoseColor: Color3?,
		InnerEarColor: Color3?,
		EyeColor: Color3?,
		TailColor: Color3?,
	},
}
Rabbit.OnGenerate = function(parameters: Parameters, targetContainer: Instance)
	-- GP and MU are automatically imported - do NOT include require statements
	local rabbit = GP.model("Rabbit", nil)-- Fix orientation of the model
	rabbit.WorldPivot = CFrame.identity


	-- REQUIRED: all three smart dimensions (default is always 10)
	local smartWidth  = parameters.Size.X
	local smartHeight = parameters.Size.Y
	local smartDepth  = parameters.Size.Z

	local sX = smartWidth / 10
	local sY = smartHeight / 10
	local sZ = smartDepth / 10
	local avgS = (sX + sY + sZ) / 3

	-- Semantic Parameters
	local earLength = parameters.Attributes.EarLength or 5.0 * sY
	local colorFur = parameters.Attributes.FurColor or Color3.fromRGB(160, 145, 135) -- Soft brown/grey
	local colorBelly = parameters.Attributes.BellyColor or Color3.fromRGB(235, 225, 215) -- Cream
	local colorNose = parameters.Attributes.NoseColor or Color3.fromRGB(250, 170, 180) -- Pink
	local colorInnerEar = parameters.Attributes.InnerEarColor or Color3.fromRGB(230, 150, 160) -- Soft pink
	local colorEye = parameters.Attributes.EyeColor or Color3.fromRGB(15, 15, 15) -- Dark
	local colorTail = parameters.Attributes.TailColor or Color3.fromRGB(245, 245, 245) -- White

	local matFur = "FabricWeave"
	local matSmooth = "Plastic"

	-- == BODY ==
	local bodyModel = GP.model("Body", rabbit)

	local rumpPos = Vector3.new(0, 3.5 * sY, 3.0 * sZ)
	local rumpRadius = 3.5 * avgS
	local chestPos = Vector3.new(0, 5.5 * sY, -1.0 * sZ)
	local chestRadius = 2.5 * avgS

	GP.capsule("TorsoMain", rumpPos, rumpRadius, chestPos, chestRadius, colorFur, matFur, bodyModel)

	-- Lighter Belly
	local bellyRumpPos = Vector3.new(0, 2.2 * sY, 2.5 * sZ)
	local bellyChestPos = Vector3.new(0, 4.0 * sY, -1.5 * sZ)
	GP.capsule("Belly", bellyRumpPos, rumpRadius * 0.9, bellyChestPos, chestRadius * 0.9, colorBelly, matFur, bodyModel)

	-- == HEAD ==
	local headModel = GP.model("Head", rabbit)

	local headCenter = Vector3.new(0, 7.0 * sY, -3.5 * sZ)
	local headRadius = 2.0 * avgS

	GP.sphere("Cranium", headCenter, headRadius, colorFur, matFur, headModel)

	-- Cheeks
	local cheekBase = headCenter + Vector3.new(0, -0.5 * sY, -0.5 * sZ)
	GP.capsule("Cheeks",
	    cheekBase + Vector3.new(-1.2 * sX, 0, 0), 1.2 * avgS,
	    cheekBase + Vector3.new(1.2 * sX, 0, 0), 1.2 * avgS,
	    colorBelly, matFur, headModel)

	-- Snout
	local snoutStart = headCenter + Vector3.new(0, -0.2 * sY, -1.0 * sZ)
	local snoutTip = headCenter + Vector3.new(0, -0.8 * sY, -2.8 * sZ)
	GP.taperedCylinder("Snout", snoutStart, snoutTip, 1.4 * avgS, 0.6 * avgS, colorBelly, matFur, headModel)

	-- Nose
	local noseCenter = snoutTip + Vector3.new(0, 0.1 * sY, -0.2 * sZ)
	GP.sphere("Nose", noseCenter, 0.25 * avgS, colorNose, matSmooth, headModel)

	-- Whiskers
	local function buildWhiskers(signX)
	    local sideStr = signX < 0 and "Left" or "Right"
	    local whiskerOrigin = snoutTip + Vector3.new(signX * 0.5 * sX, 0, 0)

	    for i = 1, 4 do
	        local angleY = (i - 2.5) * 0.3
	        local dirX = signX * 0.8
	        local dirY = math.sin(angleY) * 0.8
	        local dirZ = -0.2 + math.cos(angleY) * 0.2
	        local dir = Vector3.new(dirX, dirY, dirZ).Unit

	        local wEnd = whiskerOrigin + dir * (2.5 * avgS)
	        GP.boxBetween("Whisker_" .. sideStr .. "_" .. i, whiskerOrigin, wEnd, 0.02 * avgS, 0.02 * avgS, colorBelly, matSmooth, headModel)
	    end
	end
	buildWhiskers(-1)
	buildWhiskers(1)

	-- == SYMMETRICAL FEATURES (Ears, Eyes, Limbs) ==
	local function buildSideFeatures(signX)
	    local sideStr = signX < 0 and "Left" or "Right"

	    -- Eyes
	    local eyePos = headCenter + Vector3.new(signX * 1.5 * sX, 0.2 * sY, -1.2 * sZ)
	    GP.sphere(sideStr .. "Eye", eyePos, 0.3 * avgS, colorEye, matSmooth, headModel)

	    local eyeHighlight = eyePos + Vector3.new(signX * 0.05 * sX, 0.1 * sY, -0.2 * sZ)
	    GP.sphere(sideStr .. "EyeHighlight", eyeHighlight, 0.08 * avgS, Color3.new(1,1,1), "Neon", headModel)

	    -- Ears
	    local earBase = headCenter + Vector3.new(signX * 0.8 * sX, 1.5 * sY, 0.5 * sZ)
	    local earTip = earBase + Vector3.new(signX * 0.5 * sX, earLength, -0.5 * sZ)

	    local earModel = GP.model(sideStr .. "Ear", headModel)
	    GP.taperedCylinder("OuterEar", earBase, earTip, 0.6 * avgS, 0.2 * avgS, colorFur, matFur, earModel)

	    -- Inner ear (offset to prevent z-fighting, embedded slightly towards the front face)
	    local innerBase = earBase + Vector3.new(signX * 0.1 * sX, 0.2 * sY, -0.2 * sZ)
	    local innerTip = earTip + Vector3.new(signX * 0.05 * sX, -0.2 * sY, -0.1 * sZ)
	    GP.taperedCylinder("InnerEar", innerBase, innerTip, 0.4 * avgS, 0.1 * avgS, colorInnerEar, matFur, earModel)

	    -- Front Legs
	    local limbsModel = GP.model(sideStr .. "Limbs", rabbit)

	    local fShoulder = chestPos + Vector3.new(signX * 1.5 * sX, -1.0 * sY, 0)
	    local fElbow = fShoulder + Vector3.new(0, -1.5 * sY, 0.5 * sZ)
	    local fPaw = fElbow + Vector3.new(0, -2.5 * sY, -1.0 * sZ)

	    GP.capsule("FrontUpperLeg", fShoulder, 0.6 * avgS, fElbow, 0.5 * avgS, colorFur, matFur, limbsModel)
	    GP.capsule("FrontLowerLeg", fElbow, 0.5 * avgS, fPaw, 0.4 * avgS, colorBelly, matFur, limbsModel)

	    local pawTip = fPaw + Vector3.new(0, -0.2 * sY, -0.8 * sZ)
	    GP.capsule("FrontPaw", fPaw, 0.4 * avgS, pawTip, 0.3 * avgS, colorBelly, matFur, limbsModel)

	    -- Hind Legs
	    -- Thigh is a large rounded shape pressing against the lower back
	    local hHip = rumpPos + Vector3.new(signX * 2.0 * sX, -1.0 * sY, 0.5 * sZ)
	    local hKnee = hHip + Vector3.new(signX * 0.5 * sX, 1.0 * sY, -2.5 * sZ)
	    local hAnkle = hHip + Vector3.new(0, -2.0 * sY, -1.0 * sZ)

	    GP.sphere("HindThigh", hHip, 2.5 * avgS, colorFur, matFur, limbsModel)

	    -- Hind Foot (Long flat foot resting on ground)
	    local hFootEnd = hAnkle + Vector3.new(0, -0.3 * sY, -3.0 * sZ)
	    GP.capsule("HindFoot", hAnkle, 0.7 * avgS, hFootEnd, 0.5 * avgS, colorBelly, matFur, limbsModel)
	end

	buildSideFeatures(-1) -- Object's Left (-X)
	buildSideFeatures(1)  -- Object's Right (+X)

	-- == TAIL ==
	local tailCenter = rumpPos + Vector3.new(0, -0.5 * sY, 3.5 * sZ)
	GP.sphere("Tail", tailCenter, 1.2 * avgS, colorTail, matFur, rabbit)

	rabbit.Parent = targetContainer
	-- reposition
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

return Rabbit
