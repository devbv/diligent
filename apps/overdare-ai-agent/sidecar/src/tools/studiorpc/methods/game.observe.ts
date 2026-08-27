// @summary Declares the Studio RPC method for reading several parts of the running game in one call.
import { z } from "zod";
import { isRecord } from "../camera-response";
import { dropPlaceholders, postProcess as nameMissesInInstances } from "./live-instance-names";

export const method = "game.observe";

export const description =
  "Read character, UI, and live instance state from one game-thread observation. Ask for at least one " +
  'section. `outcome` is "ok" or "partial"; partial replies name `failedSections`, and each section keeps ' +
  "its own status or error. Narrowed sections report `fieldsNotAnswered` when no returned element supplied " +
  "a requested field. Reading character and instances together adds each Part's surface " +
  "`distanceFromCharacter`. UI and character describe the targeted main client; instances read the shared " +
  "client or authority world. Use a screenshot for rendered pixels.";
const uiSection = z
  .object({
    paths: z
      .array(z.string().min(1))
      .optional()
      .describe("Only these elements, by name, full path, or on-screen label; a trailing .* takes a subtree."),
    fields: z
      .array(z.string().min(1))
      .optional()
      .describe("Only these fields of each element. path and class always come back."),
  })
  .strict();
const propertiesFlag = z
  .boolean()
  .optional()
  .describe(
    "true returns every live property the instance's class serializes — a ProximityPrompt's " +
      "HoldDuration, a Part's Shape or Anchored, a TextLabel's Text. Off, each instance answers with " +
      "name/path/class, CFrame, and a Part's Size/Transparency/CanCollide/CanTouch/Color.",
  );

const worldFlag = z
  .enum(["client", "authority"])
  .optional()
  .describe(
    'Which world answers. Default "client" — the replica the input tools drive, which is what the ' +
      'player sees. "authority" reads the server world instead, where game rules and collision are ' +
      "judged: a server-owned door's real collision state, a moving hazard's server-side transform, " +
      "a value mid-replication. The reply's `world` field says which one actually answered.",
  );

const namedInstances = z
  .object({
    targets: z
      .array(z.string().min(1))
      .min(1)
      .max(64)
      .describe("Names or dot-separated paths to read, one entry each; each answers with its own status."),
    properties: propertiesFlag,
    world: worldFlag,
  })
  .strict();

const searchedInstances = z
  .object({
    namePattern: z
      .string()
      .min(1)
      .optional()
      .describe("Find every instance whose name or path contains this text, at any depth."),
    class: z.string().min(1).optional().describe('Find every instance of this class, at any depth (e.g. "Part").'),
    under: z.string().min(1).optional().describe("Search only inside this instance, by path."),
    maxDepth: z.number().int().min(1).max(32).optional().describe("How many levels to list. Defaults to 1."),
    properties: propertiesFlag,
    world: worldFlag,
  })
  .strict();

const instancesSection = z.union([namedInstances, searchedInstances]);

export const params = z
  .object({
    character: z
      .boolean()
      .optional()
      .describe("Include the targeted character's pose, velocity, facing, and standingOn state."),
    ui: z
      .union([z.boolean(), uiSection])
      .optional()
      .describe(
        "Include UI text, normalized rects, visibility, contrast, and occlusion. Pass true or narrow with " +
          "paths/fields; omit it to skip UI. false is accepted as omission for conditional calls. `readable` " +
          "covers contrast against the element's own opaque background; null means the background is " +
          "transparent and must be judged from a screenshot. Occlusion is reported separately and does not " +
          "detect the element clipping its own text.",
      ),
    instances: z
      .union([z.boolean(), z.array(z.string().min(1)).min(1).max(64), instancesSection])
      .optional()
      .describe(
        "Include script-mutated live instance state. true lists the top level; an array or `targets` reads " +
          "names/paths independently; `{namePattern, class, under, maxDepth}` searches. Omit it to skip " +
          "instances; false is accepted as omission for conditional calls. Use either naming or searching. " +
          "Missing targets keep the successful entries and receive name suggestions.",
      ),
    fields: z.array(z.string().min(1)).optional().describe("Per-instance fields to keep for any instances shape."),
  })
  .strict();
const ENGINE_PLUMBING = new Set([
  "ObjectKey",
  "Archivable",
  "Mobility",
  "PivotOffsetCFrame",
  "bDisableAdaptiveNetUpdateFrequency",
  "AssemblyRootPart",
  "AssemblyLinearVelocity",
  "AssemblyAngularVelocity",
  "CurrentPhysicalProperties",
  "CustomPhysicalProperties",
  "TraceGroupNameString",
  "WorldTransform",
  "UnitExtent",
  "BrickColor",
]);

function withoutEnginePlumbing(entry: unknown): unknown {
  if (!isRecord(entry)) return entry;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (!ENGINE_PLUMBING.has(key)) kept[key] = value;
  }
  return kept;
}

export function normalizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const withoutDisabledSections = { ...args };
  for (const section of ["character", "ui", "instances"]) {
    if (withoutDisabledSections[section] === false) delete withoutDisabledSections[section];
  }
  const shaped =
    withoutDisabledSections.instances === true
      ? { ...withoutDisabledSections, instances: {} }
      : withoutDisabledSections;
  const { instances, fields } = shaped;
  if (!Array.isArray(fields) || Array.isArray(instances) || !isRecord(instances)) {
    return isRecord(instances) && !Array.isArray(instances)
      ? { ...shaped, instances: dropPlaceholders(instances) }
      : shaped;
  }
  return { ...shaped, instances: dropPlaceholders({ ...instances, fields }) };
}

type Vec3 = { x: number; y: number; z: number };
function vec3(value: unknown): Vec3 | undefined {
  if (!isRecord(value)) return undefined;
  const x = value.X ?? value.x;
  const y = value.Y ?? value.y;
  const z = value.Z ?? value.z;
  if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") return undefined;
  return { x, y, z };
}
function surfaceDistance(from: Vec3, centre: Vec3, size: Vec3): number {
  const dx = Math.max(Math.abs(from.x - centre.x) - size.x / 2, 0);
  const dy = Math.max(Math.abs(from.y - centre.y) - size.y / 2, 0);
  const dz = Math.max(Math.abs(from.z - centre.z) - size.z / 2, 0);
  return Math.hypot(dx, dy, dz);
}
function withDistanceFromCharacter(shaped: Record<string, unknown>): Record<string, unknown> {
  const character = isRecord(shaped.character) && isRecord(shaped.character.data) ? shaped.character.data : undefined;
  const inner = isRecord(character?.character) ? character.character : undefined;
  const from = vec3(isRecord(inner?.CFrame) ? inner.CFrame.Position : undefined);
  const wrapper = isRecord(shaped.instances) ? shaped.instances : undefined;
  const section = wrapper && isRecord(wrapper.data) ? wrapper.data : undefined;
  const listed = Array.isArray(section?.instances) ? section.instances : undefined;
  if (!from || !wrapper || !section || !listed) return shaped;

  let measured = 0;
  const withDistances = listed.map((entry) => {
    if (!isRecord(entry)) return entry;
    const centre = vec3(isRecord(entry.CFrame) ? entry.CFrame.Position : undefined);
    const size = vec3(entry.Size);
    if (!centre || !size) return entry;
    measured += 1;
    return {
      ...entry,
      distanceFromCharacter: Math.round(surfaceDistance(from, centre, size) * 10) / 10,
    };
  });
  if (measured === 0) return shaped;

  return {
    ...shaped,
    instances: { ...wrapper, data: { ...section, instances: withDistances } },
  };
}
function flattenSection(name: string, section: unknown): unknown {
  if (!isRecord(section) || !isRecord(section.data)) return section;
  const { data, ...meta } = section;
  const { success: _success, ...rest } = data;
  const payload = name === "character" && isRecord(rest.character) ? { ...rest, ...rest.character } : rest;
  if (name === "character") delete (payload as Record<string, unknown>).character;
  const flat: Record<string, unknown> = { ...meta };
  for (const [key, value] of Object.entries(payload)) {
    if (!(key in flat)) flat[key] = value;
  }
  return flat;
}
function fieldsNotAnswered(
  section: unknown,
  requested: unknown,
  collection: "elements" | "instances",
): string[] | undefined {
  if (!Array.isArray(requested) || requested.length === 0 || !isRecord(section)) return undefined;
  const entries = section[collection];
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  const answered = new Set<string>();
  let sawAnElement = false;
  const collect = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const entry of value) collect(entry);
      return;
    }
    if (!isRecord(value)) return;
    sawAnElement = true;
    for (const key of Object.keys(value)) answered.add(key.toLowerCase());
  };
  collect(entries);
  if (!sawAnElement) return undefined;
  const missing = requested.filter(
    (name): name is string => typeof name === "string" && !answered.has(name.toLowerCase()),
  );
  return missing.length > 0 ? missing : undefined;
}

export function postProcess(result: unknown, args: Record<string, unknown> = {}): unknown {
  if (!isRecord(result)) return result;
  const shaped: Record<string, unknown> = isRecord(result.instances)
    ? {
        ...result,
        instances: isRecord(result.instances.data)
          ? { ...result.instances, data: nameMissesInInstances(result.instances.data) }
          : result.instances,
      }
    : { ...result };
  const askedForProperties =
    isRecord(args.instances) && !Array.isArray(args.instances) && args.instances.properties === true;
  if (askedForProperties && isRecord(shaped.instances) && isRecord(shaped.instances.data)) {
    const section = shaped.instances.data;
    if (Array.isArray(section.instances)) {
      shaped.instances = {
        ...shaped.instances,
        data: { ...section, instances: section.instances.map(withoutEnginePlumbing) },
      };
    }
  }
  const measured = withDistanceFromCharacter(shaped);
  if (!isRecord(measured)) return measured;
  const flat: Record<string, unknown> = { ...measured };
  for (const name of ["character", "ui", "instances"]) {
    if (name in flat) flat[name] = flattenSection(name, flat[name]);
  }
  const uiFields = isRecord(args.ui) ? args.ui.fields : undefined;
  const instanceFields = args.fields ?? (isRecord(args.instances) ? args.instances.fields : undefined);
  for (const [name, requested, collection] of [
    ["ui", uiFields, "elements"],
    ["instances", instanceFields, "instances"],
  ] as const) {
    const missing = fieldsNotAnswered(flat[name], requested, collection);
    if (missing && isRecord(flat[name])) flat[name] = { ...flat[name], fieldsNotAnswered: missing };
  }
  return flat;
}
