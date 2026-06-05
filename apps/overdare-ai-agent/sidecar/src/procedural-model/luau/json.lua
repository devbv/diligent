-- @summary Minimal JSON encoder/decoder for the OVDR procedural Luau runner.

local Json = {}

local function skipWhitespace(source, index)
	while true do
		local char = string.sub(source, index, index)
		if char ~= " " and char ~= "\n" and char ~= "\r" and char ~= "\t" then
			return index
		end
		index += 1
	end
end

local parseValue

local function parseString(source, index)
	index += 1
	local result = ""
	while index <= #source do
		local char = string.sub(source, index, index)
		if char == '"' then
			return result, index + 1
		end
		if char == "\\" then
			local escaped = string.sub(source, index + 1, index + 1)
			if escaped == '"' or escaped == "\\" or escaped == "/" then
				result ..= escaped
			elseif escaped == "n" then
				result ..= "\n"
			elseif escaped == "r" then
				result ..= "\r"
			elseif escaped == "t" then
				result ..= "\t"
			else
				error("Unsupported JSON escape: \\" .. escaped)
			end
			index += 2
		else
			result ..= char
			index += 1
		end
	end
	error("Unterminated JSON string")
end

local function parseNumber(source, index)
	local startIndex = index
	while string.match(string.sub(source, index, index), "[%d%+%-%e%E%.]") do
		index += 1
	end
	return tonumber(string.sub(source, startIndex, index - 1)), index
end

local function parseArray(source, index)
	local result = {}
	result.__jsonArray = true
	index = skipWhitespace(source, index + 1)
	if string.sub(source, index, index) == "]" then
		return result, index + 1
	end
	while true do
		local value
		value, index = parseValue(source, index)
		table.insert(result, value)
		index = skipWhitespace(source, index)
		local char = string.sub(source, index, index)
		if char == "]" then
			return result, index + 1
		end
		if char ~= "," then
			error("Expected comma in JSON array")
		end
		index = skipWhitespace(source, index + 1)
	end
end

local function parseObject(source, index)
	local result = {}
	result.__jsonObject = true
	index = skipWhitespace(source, index + 1)
	if string.sub(source, index, index) == "}" then
		return result, index + 1
	end
	while true do
		local key
		key, index = parseString(source, index)
		index = skipWhitespace(source, index)
		if string.sub(source, index, index) ~= ":" then
			error("Expected colon in JSON object")
		end
		local value
		value, index = parseValue(source, skipWhitespace(source, index + 1))
		result[key] = value
		index = skipWhitespace(source, index)
		local char = string.sub(source, index, index)
		if char == "}" then
			return result, index + 1
		end
		if char ~= "," then
			error("Expected comma in JSON object")
		end
		index = skipWhitespace(source, index + 1)
	end
end

parseValue = function(source, index)
	index = skipWhitespace(source, index)
	local char = string.sub(source, index, index)
	if char == '"' then
		return parseString(source, index)
	end
	if char == "{" then
		return parseObject(source, index)
	end
	if char == "[" then
		return parseArray(source, index)
	end
	if string.sub(source, index, index + 3) == "true" then
		return true, index + 4
	end
	if string.sub(source, index, index + 4) == "false" then
		return false, index + 5
	end
	if string.sub(source, index, index + 3) == "null" then
		return nil, index + 4
	end
	return parseNumber(source, index)
end

function Json.decode(source)
	local value = parseValue(source, 1)
	return value
end

local function isArray(value)
	if value.__jsonArray == true then
		return true
	end
	if value.__jsonObject == true then
		return false
	end
	local max = 0
	local count = 0
	for key in pairs(value) do
		if type(key) ~= "number" then
			return false
		end
		if key > max then
			max = key
		end
		count += 1
	end
	return max == count
end

local function encodeString(value)
	value = string.gsub(value, "\\", "\\\\")
	value = string.gsub(value, '"', '\\"')
	value = string.gsub(value, "\n", "\\n")
	value = string.gsub(value, "\r", "\\r")
	value = string.gsub(value, "\t", "\\t")
	return '"' .. value .. '"'
end

local encodeValue

local function sortedKeys(value)
	local keys = {}
	for key in pairs(value) do
		table.insert(keys, key)
	end
	table.sort(keys, function(left, right)
		return tostring(left) < tostring(right)
	end)
	return keys
end

encodeValue = function(value)
	local valueType = type(value)
	if valueType == "nil" then
		return "null"
	end
	if valueType == "boolean" or valueType == "number" then
		return tostring(value)
	end
	if valueType == "string" then
		return encodeString(value)
	end
	if valueType == "table" then
		if isArray(value) then
			local chunks = {}
			for index = 1, #value do
				table.insert(chunks, encodeValue(value[index]))
			end
			return "[" .. table.concat(chunks, ",") .. "]"
		end
		local chunks = {}
		for _, key in ipairs(sortedKeys(value)) do
			if key ~= "__jsonObject" and key ~= "__jsonArray" then
				table.insert(chunks, encodeString(tostring(key)) .. ":" .. encodeValue(value[key]))
			end
		end
		return "{" .. table.concat(chunks, ",") .. "}"
	end
	error("Unsupported JSON value type: " .. valueType)
end

function Json.encode(value)
	return encodeValue(value)
end

return Json
