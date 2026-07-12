--!strict
local GP = require(script.Dependencies.GeometryPrimitives)
local MU = require(script.Dependencies.MathUtils)


local RomanColosseum = {}

type Parameters = {
	Size: Vector3,
	Attributes: {
		ArchCount: number?,
		TierCount: number?,
		StoneColor: Color3?,
		TrimColor: Color3?,
		SandColor: Color3?,
		WallThickness: number?,
	},
}
RomanColosseum.OnGenerate = function(parameters: Parameters, targetContainer: Instance)
	local colosseum = GP.model("RomanColosseum", nil)-- Fix orientation of the model
	colosseum.WorldPivot = CFrame.identity


	-- REQUIRED Smart Dimensions
	local smartWidth = parameters.Size.X
	local smartHeight = parameters.Size.Y
	local smartDepth = parameters.Size.Z

	-- Semantic Parameters
	local requestedArchCount = parameters.Attributes.ArchCount or 36
	local tierCount = parameters.Attributes.TierCount or 3
	local stoneColor = parameters.Attributes.StoneColor or Color3.fromRGB(205, 185, 155)
	local trimColor = parameters.Attributes.TrimColor or Color3.fromRGB(185, 165, 135)
	local sandColor = parameters.Attributes.SandColor or Color3.fromRGB(215, 200, 165)
	local wallThickness = parameters.Attributes.WallThickness or 3

	-- Structural Groups
	local OuterWallGroup = GP.model("OuterWall", colosseum)
	local SeatingGroup = GP.model("SeatingTiers", colosseum)
	local ArenaGroup = GP.model("ArenaFloor", colosseum)

	-- Enforce arch count as a multiple of 4 for symmetric cardinal gates
	local archCount = math.max(16, math.floor(requestedArchCount / 4) * 4)
	local gateInterval = math.floor(archCount / 4)

	-- Radii definitions
	local a_out = smartWidth / 2
	local b_out = smartDepth / 2
	local a_in = a_out * 0.45
	local b_in = b_out * 0.45

	-- Level Heights for the 4 outer wall stories
	local lvlHeight = smartHeight / 4
	local levelY = {0, lvlHeight, lvlHeight * 2, lvlHeight * 3}

	local dTheta = (math.pi * 2) / archCount
	local podiumHeight = smartHeight * 0.12

	-- Helper to get a point on the ellipse
	local function getEllipsePt(a, b, theta, y)
		return Vector3.new(a * math.cos(theta), y, b * math.sin(theta))
	end

	for i = 0, archCount - 1 do
		local theta1 = i * dTheta
		local theta2 = (i + 1) * dTheta
		local isGate = (i % gateInterval == 0)

		-- ==========================================
		-- 1. OUTER WALL SEGMENT
		-- OVERDARE has no CSG, so the wall is a solid segment (arches cannot be carved).
		-- ==========================================
		local wallS = getEllipsePt(a_out, b_out, theta1, smartHeight / 2)
		local wallE = getEllipsePt(a_out, b_out, theta2, smartHeight / 2)

		GP.boxBetween("WallSeg_"..i, wallS, wallE, wallThickness, smartHeight, stoneColor, "Rock", OuterWallGroup)

		-- Engaged Columns (Pillars) at joints to hide seams and add detail
		local pillarBase = getEllipsePt(a_out, b_out, theta1, 0)
		local pillarTop = getEllipsePt(a_out, b_out, theta1, smartHeight)
		GP.cylinder("Column_"..i, pillarBase, pillarTop, wallThickness * 0.6, trimColor, "Rock", OuterWallGroup)

		-- Horizontal Cornices dividing the levels
		for lvl = 2, 4 do
			local cy = levelY[lvl]
			local cornS = getEllipsePt(a_out, b_out, theta1, cy)
			local cornE = getEllipsePt(a_out, b_out, theta2, cy)
			-- Offset slightly outwards using the segment normal to avoid Z-fighting
			local cNorm = (cornE - cornS).Unit:Cross(Vector3.yAxis).Unit
			GP.boxBetween("Cornice_"..lvl.."_"..i, cornS + cNorm * 0.5, cornE + cNorm * 0.5, wallThickness + 1.5, 1.2, trimColor, "Rock", OuterWallGroup)
		end

		-- ==========================================
		-- 2. ARENA FLOOR & PODIUM WALL
		-- ==========================================
		local floorCenter = Vector3.new(0, 0, 0)
		local floorP1 = getEllipsePt(a_in, b_in, theta1, 0)
		local floorP2 = getEllipsePt(a_in, b_in, theta2, 0)
		GP.triangle("ArenaSand_"..i, floorCenter, floorP2, floorP1, 1, Vector3.yAxis, sandColor, "Sand", ArenaGroup)

		if not isGate then
			local podT2 = getEllipsePt(a_in, b_in, theta2, podiumHeight)
			local podT1 = getEllipsePt(a_in, b_in, theta1, podiumHeight)
			GP.quad("PodiumWall_"..i, floorP1, floorP2, podT2, podT1, 1.5, nil, trimColor, "Rock", ArenaGroup)
		end

		-- ==========================================
		-- 3. SEATING TIERS & GATES
		-- ==========================================
		local seatingTopY = smartHeight * 0.75

		for t = 1, tierCount do
			local t1Ratio = (t - 1) / tierCount
			local t2Ratio = t / tierCount

			local a1 = a_in + (a_out - wallThickness - a_in) * t1Ratio
			local b1 = b_in + (b_out - wallThickness - b_in) * t1Ratio
			local a2 = a_in + (a_out - wallThickness - a_in) * t2Ratio
			local b2 = b_in + (b_out - wallThickness - b_in) * t2Ratio

			local y1 = podiumHeight + (seatingTopY - podiumHeight) * t1Ratio
			local y2 = podiumHeight + (seatingTopY - podiumHeight) * t2Ratio

			local p1_in  = getEllipsePt(a1, b1, theta1, y1)
			local p2_in  = getEllipsePt(a1, b1, theta2, y1)
			local p1_mid = getEllipsePt(a1, b1, theta1, y2)
			local p2_mid = getEllipsePt(a1, b1, theta2, y2)
			local p1_out = getEllipsePt(a2, b2, theta1, y2)
			local p2_out = getEllipsePt(a2, b2, theta2, y2)

			if not isGate then
				-- Riser (Vertical back of the step)
				if t > 1 then
					GP.quad("Riser_"..i.."_"..t, p1_in, p2_in, p2_mid, p1_mid, 1.2, nil, stoneColor, "Rock", SeatingGroup)
				end
				-- Seat (Horizontal part)
				GP.quad("Seat_"..i.."_"..t, p1_mid, p2_mid, p2_out, p1_out, 1.2, nil, stoneColor, "Rock", SeatingGroup)
			else
				-- For Gates, construct a tunnel passage by building a flat floor and vertical side walls
				if t == 1 then
					local f1_in = getEllipsePt(a_in, b_in, theta1, 0)
					local f2_in = getEllipsePt(a_in, b_in, theta2, 0)
					local f1_out = getEllipsePt(a_out - wallThickness, b_out - wallThickness, theta1, 0)
					local f2_out = getEllipsePt(a_out - wallThickness, b_out - wallThickness, theta2, 0)
					GP.quad("GateFloor_"..i, f1_in, f2_in, f2_out, f1_out, 1, nil, sandColor, "Sand", SeatingGroup)
				end

				-- Drop vertical side walls from the current tier's seat level down to the ground
				local g1_mid = getEllipsePt(a1, b1, theta1, 0)
				local g1_out = getEllipsePt(a2, b2, theta1, 0)
				GP.quad("GateSideL_"..i.."_"..t, g1_mid, g1_out, p1_out, p1_mid, 1.5, nil, stoneColor, "Rock", SeatingGroup)

				local g2_mid = getEllipsePt(a1, b1, theta2, 0)
				local g2_out = getEllipsePt(a2, b2, theta2, 0)
				GP.quad("GateSideR_"..i.."_"..t, g2_out, g2_mid, p2_mid, p2_out, 1.5, nil, stoneColor, "Rock", SeatingGroup)
			end
		end
	end


	colosseum.Parent = targetContainer
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

return RomanColosseum
