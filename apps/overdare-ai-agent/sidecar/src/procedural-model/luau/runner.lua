-- @summary Luau runner that executes procedural scripts and writes dummy JSON.

local inputJson = ...
if inputJson == nil then
	error("Usage: runner.lua --program-args <input-json>")
end

local Json = require("./json")
local Ovdr = require("./ovdr-shim")

local input = Json.decode(inputJson)

local dependencies = {
	ConstructiveSolidGeometry = require("./dependencies/ConstructiveSolidGeometry"),
	GeometryPrimitives = require("./dependencies/GeometryPrimitives"),
	SmartObject = require("./dependencies/SmartObject"),
	MathUtils = require("./dependencies/MathUtils"),
}

local scriptObject = {
	Dependencies = dependencies,
	Destroying = {
		Connect = function() end,
	},
	IsDescendantOf = function()
		return true
	end,
	GetFullName = function()
		return input.scriptName
	end,
}

local function scopedRequire(value)
	return value
end

local environment = {
	assert = assert,
	error = error,
	getmetatable = getmetatable,
	ipairs = ipairs,
	math = math,
	next = next,
	pairs = pairs,
	pcall = pcall,
	print = print,
	select = select,
	setmetatable = setmetatable,
	string = string,
	table = table,
	tick = os.clock,
	type = type,
	tostring = tostring,
	task = {
		spawn = function(callback)
			return coroutine.create(callback)
		end,
		cancel = function() end,
		wait = function() end,
	},
	require = scopedRequire,
	script = scriptObject,
	game = {},
	Vector3 = Ovdr.Vector3,
	Color3 = Ovdr.Color3,
	CFrame = Ovdr.CFrame,
}

local chunk = assert(loadstring(input.scriptSource, input.scriptName))
setfenv(chunk, environment)
local module = chunk()
if type(module) ~= "table" or type(module.OnGenerate) ~= "function" then
	error("Procedural script must return a table with OnGenerate(parameters, targetContainer).")
end

local targetContainer = Ovdr.createTargetContainer()
module.OnGenerate(input.parameters, targetContainer)

local output = {
	version = 1,
	kind = "overdare.procedural-dummy-json",
	generationId = input.generationId,
	scriptName = input.scriptName,
	parameters = input.parameters,
	children = Ovdr.serializeChildren(targetContainer),
}

print("__OVDR_PROCEDURAL_JSON__" .. Json.encode(output))
