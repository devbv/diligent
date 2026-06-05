local CSG = require(script.Parent.ConstructiveSolidGeometry)
local GP = require(script.Parent.GeometryPrimitives)

local SmartObject = {}

-- Create the DSL builder

function SmartObject.getAttribute(instance: any, key: string, defaultValue: number | string | boolean | Color3 | Vector3 | Vector2 | CFrame | UDim | UDim2 | NumberRange | Rect): number | string | boolean | Color3 | Vector3 | Vector2 | CFrame | UDim | UDim2 | NumberRange | Rect
	local sourceType = typeof(instance)

	if sourceType == "table" then
		local tbl = instance :: { [string]: any }
		if not tbl.Attributes or not tbl.Size then
			warn("SO.getAttribute: table must have 'Size' (Vector3) and 'Attributes' (table) fields")
			return defaultValue
		end

		local attrs = tbl.Attributes

		if attrs[key] == nil then
			attrs[key] = defaultValue
		end

		if key == "smartWidth" or key == "SmartWidth" then return tbl.Size.X end
		if key == "smartHeight" or key == "SmartHeight"then return tbl.Size.Y end
		if key == "smartDepth" or key == "SmartDepth"then return tbl.Size.Z end

		return attrs[key]

	elseif sourceType == "Instance" then
		local inst = instance :: Instance
		local stored = inst:GetAttribute(key)
		if stored == nil then
			inst:SetAttribute(key, defaultValue)
			return defaultValue
		end

		local expectedType = typeof(defaultValue)
		if typeof(stored) ~= expectedType then
			warn(string.format(
				"SO.getAttribute: attribute '%s' expected type '%s' but got '%s'; using default",
				key, expectedType, typeof(stored)
			))
			inst:SetAttribute(key, defaultValue)
			return defaultValue
		end

		return stored :: number | string | boolean | Color3 | Vector3 | Vector2 | CFrame | UDim | UDim2 | NumberRange | Rect
	else
		warn(string.format(
			"SO.getAttribute: expected Instance or table, got '%s'",
			sourceType
		))
		return defaultValue
	end
end
return SmartObject
