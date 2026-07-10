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
	type = type,
	tostring = tostring,
	require = scopedRequire,
	script = scriptObject,
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

-- Transform scripts receive the current scene as a `workspace` global whose
-- descendants carry real scene GUIDs. Generate-only scripts leave it nil.
local sceneRoot = nil
if input.scene ~= nil then
	sceneRoot = Ovdr.injectScene(input.scene)
	environment.workspace = sceneRoot
end

module.OnGenerate(input.parameters, targetContainer)

-- The runner emits a single child list: the mutated injected scene (nodes with
-- GUIDs) followed by freshly-built targetContainer nodes (no GUIDs). Both attach
-- to the run's target GUID on the TS side.
local children = {}
if sceneRoot ~= nil then
	for _, child in ipairs(Ovdr.serializeChildren(sceneRoot)) do
		table.insert(children, child)
	end
end
for _, child in ipairs(Ovdr.serializeChildren(targetContainer)) do
	table.insert(children, child)
end

local output = {
	version = 1,
	kind = "overdare.procedural-dummy-json",
	generationId = input.generationId,
	scriptName = input.scriptName,
	parameters = input.parameters,
	children = children,
}

print("__OVDR_PROCEDURAL_JSON__" .. Json.encode(output))
