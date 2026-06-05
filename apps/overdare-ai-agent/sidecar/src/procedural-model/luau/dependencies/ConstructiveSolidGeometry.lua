-- @summary Dummy CSG dependency for MVP procedural dummy generation.

local Ovdr = require("../ovdr-shim")

local CSG = {}

function CSG.subtract(name, baseObject, cutters)
	local node = Ovdr.createInstance("Primitive", name)
	node.Primitive = "CSGSubtract"
	node.Base = baseObject
	node.CutterIds = {}
	node.CFrame = baseObject and baseObject.CFrame or Ovdr.CFrame.identity
	node.Data = {
		base = baseObject,
		cutters = cutters or {},
	}
	for _, cutter in ipairs(cutters or {}) do
		if type(cutter) == "table" and cutter.Id ~= nil then
			table.insert(node.CutterIds, cutter.Id)
		end
	end
	return node
end

return CSG
