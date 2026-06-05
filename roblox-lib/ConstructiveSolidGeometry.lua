local GeometryService: GeometryService = game:GetService("GeometryService")

local ConstructiveSolidGeometry = {}

-- Shared options for all CSG operations (use Roblox defaults for fidelity)
local CSG_OPTIONS: { [string]: any } = {
	SplitApart = false,
	CollisionFidelity = Enum.CollisionFidelity.Box,
}

-- Optimized recursive function using accumulator pattern to reduce GC overhead
-- Supports BasePart, Model, Folder, and Configuration containers
local function getAllBaseParts(instance: Instance, accumulator: { BasePart }): ()
	if instance:IsA("BasePart") then
		table.insert(accumulator, instance)
	end

	-- Recurse into children (Models, Folders, Configurations, etc.)
	for _, child in instance:GetChildren() do
		getAllBaseParts(child, accumulator)
	end
end

function ConstructiveSolidGeometry.union(
	name: string,
	mainPart: Instance,
	otherParts: { any }
): PartOperation | Instance
	-- Validate inputs
	if not mainPart or not mainPart:IsA("BasePart") then
		return error("mainPart must be a valid BasePart")
	end

	-- Flatten containers (Models, Folders, etc.) into an array of BaseParts
	-- GeometryService only accepts primitive Parts and PartOperations
	local flatParts: { BasePart } = {}
	if otherParts then
		for _, instance in ipairs(otherParts) do
			getAllBaseParts(instance, flatParts)
		end
	end

	if #flatParts == 0 then
		-- union(A, {}) = A: return mainPart directly
		mainPart.Name = name
		return mainPart :: any
	end

	-- Force all parts to match mainPart's appearance for uniform coloring.
	-- Note: With UsePartColor = true (set below), the result's own Color property
	-- (auto-inherited from mainPart) overrides per-face colors, making this
	-- technically redundant. We keep it as defense-in-depth in case UsePartColor
	-- behavior changes or is toggled off.
	for _, part in ipairs(flatParts) do
		part.Material = mainPart.Material
		part.Color = mainPart.Color
	end

	-- Perform union operation with GeometryService
	-- Note: GeometryService does not require parts to be parented to workspace.
	local success, results = pcall(function(): ...any
		return GeometryService:UnionAsync(mainPart, flatParts, CSG_OPTIONS)
	end)

	-- On failure, keep input parts intact (they are valid geometry on their own)
	if not success then
		return error("Union operation failed: " .. tostring(results))
	end

	if not results or #results == 0 then
		return error("Union operation produced no result")
	end

	local result: PartOperation = results[1] :: PartOperation

	-- Configure the result.
	-- GeometryService auto-inherits Color, Material, Transparency, CanCollide,
	-- and Anchored from mainPart, so we only set properties that differ or
	-- are not auto-inherited (Name, UsePartColor).
	-- If mainPart was parented, the result replaces it in the same parent.
	-- If mainPart was unparented (e.g. intermediate parts), result stays unparented.
	result.Name = name
	result.UsePartColor = true
	-- Setting SmoothingAngle is not supported in runtime due to latency and blocking the main thread.
	pcall(function()
		result.SmoothingAngle = 70 -- Blend normals across seam edges (degrees)
	end)
	result.Parent = mainPart.Parent

	-- Cleanup original parts
	mainPart:Destroy()
	for _, part in ipairs(flatParts) do
		part:Destroy()
	end

	return result
end

function ConstructiveSolidGeometry.intersect(
	name: string,
	mainPart: Instance,
	otherParts: { any }
): PartOperation | Instance
	-- Validate inputs
	if not mainPart or not mainPart:IsA("BasePart") then
		return error("mainPart must be a valid BasePart")
	end

	-- Flatten containers (Models, Folders, etc.) into an array of BaseParts
	-- GeometryService only accepts primitive Parts and PartOperations
	local flatParts: { BasePart } = {}
	if otherParts then
		for _, instance in ipairs(otherParts) do
			getAllBaseParts(instance, flatParts)
		end
	end

	if #flatParts == 0 then
		-- intersect with empty set: return mainPart as fallback
		mainPart.Name = name
		return mainPart :: Instance
	end

	-- Helper: destroy all input parts (used on error paths)
	local function cleanupAll()
		if mainPart and mainPart.Parent then mainPart:Destroy() end
		for _, part in ipairs(flatParts) do
			if part.Parent then part:Destroy() end
		end
	end

	-- Force all parts to match mainPart's appearance for uniform coloring.
	-- Note: With UsePartColor = true (set below), the result's own Color property
	-- (auto-inherited from mainPart) overrides per-face colors, making this
	-- technically redundant. We keep it as defense-in-depth in case UsePartColor
	-- behavior changes or is toggled off.
	for _, part in ipairs(flatParts) do
		part.Material = mainPart.Material
		part.Color = mainPart.Color
	end

	-- Perform intersection operation with GeometryService
	-- Note: GeometryService does not require parts to be parented to workspace.
	local success, results = pcall(function(): ...any
		return GeometryService:IntersectAsync(mainPart, flatParts, CSG_OPTIONS)
	end)

	if not success then
		cleanupAll()
		return error("Intersection operation failed: " .. tostring(results))
	end

	if not results or #results == 0 then
		cleanupAll()
		return error("Intersection operation produced no result (parts may not overlap)")
	end

	local result: PartOperation = results[1] :: PartOperation

	-- Configure the result.
	-- GeometryService auto-inherits Color, Material, Transparency, CanCollide,
	-- and Anchored from mainPart, so we only set properties that differ or
	-- are not auto-inherited (Name, UsePartColor).
	-- Note: We do NOT override CFrame. The CSG engine correctly positions the
	-- result at the actual intersection location.
	-- If mainPart was parented, the result replaces it in the same parent.
	-- If mainPart was unparented (e.g. intermediate parts), result stays unparented.
	result.Name = name
	result.UsePartColor = true
	-- Setting SmoothingAngle is not supported in runtime due to latency and blocking the main thread.
	pcall(function()
		result.SmoothingAngle = 70 -- Blend normals across seam edges (degrees)
	end)
	result.Parent = mainPart.Parent

	-- Cleanup original parts
	mainPart:Destroy()
	for _, part in ipairs(flatParts) do
		part:Destroy()
	end

	return result
end

function ConstructiveSolidGeometry.subtract(
	name: string,
	mainPart: Instance,
	negateParts: { any }
): PartOperation
	-- Validate inputs
	if not mainPart or not mainPart:IsA("BasePart") then
		return error("mainPart must be a valid BasePart")
	end

	-- Find all baseparts from negateParts using optimized accumulator pattern
	local partsToNegate: { BasePart } = {}
	for _, instance in ipairs(negateParts) do
		getAllBaseParts(instance, partsToNegate)
	end

	if #partsToNegate == 0 then
		return error("negateParts must contain at least one BasePart")
	end

	-- Helper: destroy mainPart + all negate parts (used on error paths)
	local function cleanupAll()
		if mainPart and mainPart.Parent then mainPart:Destroy() end
		for _, part in ipairs(partsToNegate) do
			if part.Parent then part:Destroy() end
		end
	end

	-- Force negative parts to match mainPart's appearance for seamless cuts.
	-- Note: With UsePartColor = true (set below), the result's own Color property
	-- (auto-inherited from mainPart) overrides per-face colors, making this
	-- technically redundant. We keep it as defense-in-depth so cut surfaces
	-- blend correctly regardless of UsePartColor state.
	for _, part in ipairs(partsToNegate) do
		part.Material = mainPart.Material
		part.Color = mainPart.Color
	end

	-- Perform subtraction operation with GeometryService
	-- Note: GeometryService does not require parts to be parented to workspace.
	local success, results = pcall(function(): ...any
		return GeometryService:SubtractAsync(mainPart, partsToNegate, CSG_OPTIONS)
	end)

	if not success then
		cleanupAll()
		return error("Subtraction operation failed: " .. tostring(results))
	end

	if not results or #results == 0 then
		cleanupAll()
		return error("Subtraction operation produced no result")
	end

	local result: PartOperation = results[1] :: PartOperation

	-- Configure the result.
	-- GeometryService auto-inherits Color, Material, Transparency, CanCollide,
	-- and Anchored from mainPart, so we only set properties that differ or
	-- are not auto-inherited (Name, UsePartColor).
	-- If mainPart was parented, the result replaces it in the same parent.
	-- If mainPart was unparented (e.g. intermediate parts), result stays unparented.
	result.Name = name
	result.UsePartColor = true
	-- Setting SmoothingAngle is not supported in runtime due to latency and blocking the main thread.
	pcall(function()
		result.SmoothingAngle = 70 -- Blend normals across seam edges (degrees)
	end)
	result.Parent = mainPart.Parent

	-- Cleanup original parts
	mainPart:Destroy()
	for _, part in ipairs(partsToNegate) do
		part:Destroy()
	end

	return result
end
return ConstructiveSolidGeometry
