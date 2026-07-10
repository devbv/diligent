--!strict
-- generationId: ad1c33ff-a538-40f3-a853-dc8609c21e5f
local CSG = require(script.Dependencies.ConstructiveSolidGeometry)
local GP = require(script.Dependencies.GeometryPrimitives)
local SO = require(script.Dependencies.SmartObject)
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
	local CuttersTemp = GP.model("CuttersTemp", nil)
	
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
	
	-- Calculate generic arch dimensions based on average chord length
	local avgChord = math.sqrt((a_out * math.cos(dTheta) - a_out)^2 + (b_out * math.sin(dTheta))^2)
	local archWidth = math.min(avgChord * 0.55, lvlHeight * 0.6)
	local archHeight = (lvlHeight * 0.75) - (archWidth / 2)
	
	for i = 0, archCount - 1 do
	    local theta1 = i * dTheta
	    local theta2 = (i + 1) * dTheta
	    local thetaMid = (theta1 + theta2) / 2
	    local isGate = (i % gateInterval == 0)
	
	    -- ==========================================
	    -- 1. OUTER WALL SEGMENT & ARCHES
	    -- ==========================================
	    local wallS = getEllipsePt(a_out, b_out, theta1, smartHeight / 2)
		local wallE = getEllipsePt(a_out, b_out, theta2, smartHeight / 2)
	    
	    local wallSeg = GP.strutFromTwoPoints("WallSeg_"..i, wallS, wallE, wallThickness, smartHeight, stoneColor, "Sandstone", CuttersTemp)
	    
	    local midPt = getEllipsePt(a_out, b_out, thetaMid, 0)
	    local dir = (wallE - wallS).Unit
	    local outwardNormal = dir:Cross(Vector3.yAxis).Unit
	    
	    local cutters = {}
	    
	    -- Create arched cutouts for levels 1, 2, and 3
	    for lvl = 1, 3 do
	        local baseArchY = levelY[lvl] + (archHeight / 2)
	        local cutCenterBase = Vector3.new(midPt.X, baseArchY, midPt.Z)
	        local cutS = cutCenterBase - outwardNormal * (wallThickness + 2)
	        local cutE = cutCenterBase + outwardNormal * (wallThickness + 2)
	        
	        local blockCutter = GP.strutFromTwoPoints("ArchBase_"..lvl, cutS, cutE, archWidth, archHeight, Color3.new(1,0,0), "Plastic", CuttersTemp)
	        table.insert(cutters, blockCutter)
	        
	        local topArchY = levelY[lvl] + archHeight
	        local cylCenter = Vector3.new(midPt.X, topArchY, midPt.Z)
	        local cylS = cylCenter - outwardNormal * (wallThickness + 2)
	        local cylE = cylCenter + outwardNormal * (wallThickness + 2)
	        
	        local cylCutter = GP.cylinder("ArchTop_"..lvl, cylS, cylE, archWidth / 2, Color3.new(1,0,0), "Plastic", CuttersTemp)
	        table.insert(cutters, cylCutter)
	    end
	    
	    -- Level 4 (Attic) gets small square windows instead of large arches
	    local lvl4Y = levelY[4] + (lvlHeight / 2)
	    local sqCenter = Vector3.new(midPt.X, lvl4Y, midPt.Z)
	    local sqS = sqCenter - outwardNormal * (wallThickness + 2)
	    local sqE = sqCenter + outwardNormal * (wallThickness + 2)
	    local sqCutter = GP.strutFromTwoPoints("Window_4", sqS, sqE, archWidth * 0.4, archWidth * 0.4, Color3.new(1,0,0), "Plastic", CuttersTemp)
	    table.insert(cutters, sqCutter)
	
	    local finalWallSegment = CSG.subtract("CSGWall_"..i, wallSeg, cutters)
	    if finalWallSegment then
	        finalWallSegment.Parent = OuterWallGroup
	    end
	    
	    -- Clean up cutters
	    for _, c in ipairs(cutters) do c:Destroy() end
	    wallSeg:Destroy()
	
	    -- Engaged Columns (Pillars) at joints to hide seams and add detail
	    local pillarBase = getEllipsePt(a_out, b_out, theta1, 0)
	    local pillarTop = getEllipsePt(a_out, b_out, theta1, smartHeight)
	    GP.cylinder("Column_"..i, pillarBase, pillarTop, wallThickness * 0.6, trimColor, "Sandstone", OuterWallGroup)
	
	    -- Horizontal Cornices dividing the levels
	    for lvl = 2, 4 do
	        local cy = levelY[lvl]
	        local cornS = getEllipsePt(a_out, b_out, theta1, cy)
	        local cornE = getEllipsePt(a_out, b_out, theta2, cy)
	        -- Offset slightly outwards using the segment normal to avoid Z-fighting
	        local cNorm = (cornE - cornS).Unit:Cross(Vector3.yAxis).Unit
	        GP.strutFromTwoPoints("Cornice_"..lvl.."_"..i, cornS + cNorm * 0.5, cornE + cNorm * 0.5, wallThickness + 1.5, 1.2, trimColor, "Sandstone", OuterWallGroup)
	    end
	
	    -- ==========================================
	    -- 2. ARENA FLOOR & PODIUM WALL
	    -- ==========================================
	    local floorCenter = Vector3.new(0, 0, 0)
	    local floorP1 = getEllipsePt(a_in, b_in, theta1, 0)
	    local floorP2 = getEllipsePt(a_in, b_in, theta2, 0)
	    GP.triangularPrismFromThreePoints("ArenaSand_"..i, floorCenter, floorP2, floorP1, 1, Vector3.yAxis, sandColor, "Sand", ArenaGroup)
	
	    if not isGate then
	        local podT2 = getEllipsePt(a_in, b_in, theta2, podiumHeight)
	        local podT1 = getEllipsePt(a_in, b_in, theta1, podiumHeight)
	        GP.quadFromFourPoints("PodiumWall_"..i, floorP1, floorP2, podT2, podT1, 1.5, nil, trimColor, "Sandstone", ArenaGroup)
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
	                GP.quadFromFourPoints("Riser_"..i.."_"..t, p1_in, p2_in, p2_mid, p1_mid, 1.2, nil, stoneColor, "Sandstone", SeatingGroup)
	            end
	            -- Seat (Horizontal part)
	            GP.quadFromFourPoints("Seat_"..i.."_"..t, p1_mid, p2_mid, p2_out, p1_out, 1.2, nil, stoneColor, "Sandstone", SeatingGroup)
	        else
	            -- For Gates, construct a tunnel passage by building a flat floor and vertical side walls
	            if t == 1 then
	                local f1_in = getEllipsePt(a_in, b_in, theta1, 0)
	                local f2_in = getEllipsePt(a_in, b_in, theta2, 0)
	                local f1_out = getEllipsePt(a_out - wallThickness, b_out - wallThickness, theta1, 0)
	                local f2_out = getEllipsePt(a_out - wallThickness, b_out - wallThickness, theta2, 0)
	                GP.quadFromFourPoints("GateFloor_"..i, f1_in, f2_in, f2_out, f1_out, 1, nil, sandColor, "Sand", SeatingGroup)
	            end
	
	            -- Drop vertical side walls from the current tier's seat level down to the ground
	            local g1_mid = getEllipsePt(a1, b1, theta1, 0)
	            local g1_out = getEllipsePt(a2, b2, theta1, 0)
	            GP.quadFromFourPoints("GateSideL_"..i.."_"..t, g1_mid, g1_out, p1_out, p1_mid, 1.5, nil, stoneColor, "Sandstone", SeatingGroup)
	
	            local g2_mid = getEllipsePt(a1, b1, theta2, 0)
	            local g2_out = getEllipsePt(a2, b2, theta2, 0)
	            GP.quadFromFourPoints("GateSideR_"..i.."_"..t, g2_out, g2_mid, p2_mid, p2_out, 1.5, nil, stoneColor, "Sandstone", SeatingGroup)
	        end
	    end
	end
	
	CuttersTemp:Destroy()
	
	
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
