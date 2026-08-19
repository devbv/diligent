// @summary Declares the Studio RPC method for reading several parts of the running game in one call.
import { z } from "zod";
import { isRecord } from "../camera-response";
import { dropPlaceholders, postProcess as nameMissesInInstances } from "./live-instance-names";

export const method = "game.observe";

export const description =
  "Read the running play test: where the character is, what the UI says, what instances look like — any " +
  "of them, all from the same moment. This is the only tool that reads live game state, so it is where " +
  "one instance goes as well as twenty; the sections are gathered inside one game-thread call, so no " +
  "tick passes between them, where separate calls read moments seconds apart and have produced wrong " +
  "conclusions when reconciled as one. " +
  "No section you did not ask for comes back, and asking for nothing is rejected rather than answered " +
  "with everything. " +
  'Read `outcome`: "ok" means every section answered; "partial" means `failedSections` names the ones ' +
  "that did not. A failed section is still here, carrying its own `error` where its fields would be — " +
  'do not read a failed `ui` section as "this game has no UI". ' +
  "A section's own fields sit directly on it — `character.CFrame`, `instances.instances` — beside its " +
  "`status`. When the character and instances are read together, each instance also carries " +
  "`distanceFromCharacter`, measured to its surface (the thing a character can reach), from the " +
  "character's origin a capsule half-height (~84) above its feet. " +
  "Screenshots are not a section here: pixels come from a rendered frame rather than the game tick. " +
  "Take one with studiorpc_game_screenshot when you need to see rather than to read. " +
  "There is no clientId here, deliberately. In a session started with more than one player the character " +
  "and ui sections always describe the main play test — the one studiorpc_game_pie_status marks " +
  "targeted: true. To follow a move on another client, read studiorpc_game_character_read with its " +
  "clientId. The instances section needs none: it reads the shared world, so every player's character " +
  "is in it.";

/** What the ui section takes. Narrowing is the only knob; everything else is in the reply. */
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

/**
 * What the instances section takes: naming instances, or searching for them. Two shapes, not one.
 *
 * There is no `name` or `path` here, and no `target`: `targets` takes either spelling, one entry
 * each, so a separate single-instance parameter would say nothing new and would be filled anyway.
 *
 * Naming and searching used to share one flat object, and every measured run filled both. Ten of
 * eleven reports in one round named this as the parameter that earned nothing — "an example of
 * mutually exclusive forms sharing one long parameter object" — and four raised it again as a
 * defect, because the reply could only say `ignoredSelectors` after the fact.
 *
 * Refusing the mixture was tried first and did not work: offered a parameter, a model fills it,
 * and told "ask for one" it reads "these values are wrong" and edits the values instead. Measured
 * on playtest10, which was rejected three times running and never converged. Two shapes fix what
 * a refusal could not — there is now a form with no search fields in it, so choosing to search for
 * nothing is something the schema can express.
 */
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
      .describe(
        "Include where the character is, how fast it is moving, which way it faces and what it stands on. " +
          "Off unless asked for. Ask for it whenever the reading is about the world: an instance's " +
          "position only means something next to where the character was standing. It says nothing about " +
          "where things sit on screen — that is the camera's job, not this section's.",
      ),
    ui: z
      .union([z.literal(true), uiSection])
      .optional()
      .describe(
        "Include the on-screen UI: what each element says, where it sits, and whether a player could " +
          "actually read and hit it. Pass true for all of it, or an object of `paths`/`fields` to narrow " +
          "it — it is the largest section, so narrow it once you know what you are looking for. " +
          "Rects come in viewport-normalized 0..1, the same coordinates studiorpc_game_input_inject's " +
          "`position` takes, so seeing a control and clicking it is one call and then one call. " +
          "`readable` is a contrast verdict against the element's OWN background and nothing else: a label " +
          "can be visible, onScreen and readable at contrast 13 and still unreadable because a button sits " +
          "on top of it, which is what `occludedBy` and `occludedFraction` are for.",
      ),
    instances: z
      .union([z.literal(true), z.array(z.string().min(1)).min(1), instancesSection])
      .optional()
      .describe(
        "Include live instance state — what a script changed while the game ran, which the saved level " +
          "never shows. Naming instances and searching for them are separate shapes, because they are " +
          "separate questions and an object that took both could only answer one. true lists the top " +
          "level, which is where a run starts before it knows any names. An array is the short form for " +
          '"read these": each entry is a dot-separated path (containing a ".") or a runtime name, and ' +
          "each answers with its own `status`, so one wrong name does not cost you the other nineteen — " +
          "and a name that is not there comes back with the nearest ones that are, rather than as an " +
          "error. `{targets: [...]}` is the same read with `properties` available. `{namePattern, class, " +
          "under, maxDepth}` searches instead, for when you cannot name what you are looking for; " +
          "`namePattern` matches the path as well as the name. Use one shape or the other.",
      ),
    fields: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "Which per-instance fields to keep. Applies whichever shape `instances` took — it used to apply " +
          "only to the array form and be ignored beside the object form, silently.",
      ),
  })
  .strict();

/**
 * Two passes over the reply Studio sent.
 *
 * The instances section is studiorpc_game_instance_read's own answer, so it gets that tool's
 * own treatment of names that were not there — bundling must not quietly cost a caller the
 * help they would have had reading the same thing one call at a time.
 *
 * And the whole reason this tool is worth more than three calls — that the sections describe one
 * instant — is checked here rather than asserted. The sections each report the frame they were
 * read at, the gate asserts they agree, and this makes the same assertion in the field: if an
 * engine change ever let a handler span a tick, a run would otherwise reconcile two moments as
 * one and nothing would say so. A claim only the test suite checks is a claim nobody checks in
 * the case that matters.
 */
/**
 * `fields` is declared once, at the top level, and Studio reads it from inside the object form of
 * `instances`. Copying it in here is what lets there be one parameter instead of two that differ
 * only in which shape they apply to.
 */
/**
 * Engine plumbing that `properties: true` sweeps up along with the properties a game is made of.
 *
 * All eleven reports in one round named these, and named them the same way: "did not affect any
 * testing decision", "read past these on every observation", "made the result substantially
 * longer without helping". They are not wrong values — they are the serializer's view of an
 * actor rather than the game's, and a reader looking for whether a door is open has to scroll
 * past them to find `CanCollide`.
 *
 * A deny-list rather than an allow-list: what a game means by a property is class-specific and
 * open-ended — a prompt's HoldDuration, a label's Text, a part's Shape — and an allow-list would
 * have to grow every time a class matters, which is the failure the whitelist before it had.
 * What can be enumerated is the plumbing, because it belongs to the engine and not to any game.
 */
const ENGINE_PLUMBING = new Set([
  // Serialization and editor bookkeeping.
  "ObjectKey",
  "Archivable",
  "Mobility",
  "PivotOffsetCFrame",
  "bDisableAdaptiveNetUpdateFrequency",
  // Physics assembly internals: a game states its rules in CanCollide and CanTouch, not in these.
  "AssemblyRootPart",
  "AssemblyLinearVelocity",
  "AssemblyAngularVelocity",
  "CurrentPhysicalProperties",
  "CustomPhysicalProperties",
  "TraceGroupNameString",
  // Duplicates of fields the same entry already carries, in a second spelling.
  "WorldTransform", // the actor's CFrame, which is right above it
  "UnitExtent", // Size, before scale
  "BrickColor", // Color, as a palette name
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
  // `instances: true` is the top-level listing, which Studio spells as an instance read with no
  // arguments. It cannot be written as `{}` here: an empty object is a blank, and blanks are
  // dropped before this runs — the section would vanish and the call would be rejected for asking
  // for nothing, which is a confusing way to be told to write it differently.
  const shaped = args.instances === true ? { ...args, instances: {} } : args;
  const { instances, fields } = shaped;
  // `isRecord` is true for arrays too, and spreading the array shorthand into an object turns
  // ["Gate"] into {"0": "Gate"} — which Studio reads as no targets at all.
  if (!Array.isArray(fields) || Array.isArray(instances) || !isRecord(instances)) {
    // The section takes game.instance.read's identifier parameters, so it inherits the same
    // placeholder problem: a namePattern of "." searches the whole world instead of nothing.
    return isRecord(instances) && !Array.isArray(instances)
      ? { ...shaped, instances: dropPlaceholders(instances) }
      : shaped;
  }
  return { ...shaped, instances: dropPlaceholders({ ...instances, fields }) };
}

type Vec3 = { x: number; y: number; z: number };

/** A Studio Vector3, whichever of the two spellings the reply used. */
function vec3(value: unknown): Vec3 | undefined {
  if (!isRecord(value)) return undefined;
  const x = value.X ?? value.x;
  const y = value.Y ?? value.y;
  const z = value.Z ?? value.z;
  if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") return undefined;
  return { x, y, z };
}

/** Distance to the nearest point of the box, which is what a range rule is written against. */
function surfaceDistance(from: Vec3, centre: Vec3, size: Vec3): number {
  const dx = Math.max(Math.abs(from.x - centre.x) - size.x / 2, 0);
  const dy = Math.max(Math.abs(from.y - centre.y) - size.y / 2, 0);
  const dz = Math.max(Math.abs(from.z - centre.z) - size.z / 2, 0);
  return Math.hypot(dx, dy, dz);
}

/**
 * How far the character is from each instance's surface, when the same call read both. The
 * arithmetic the reply does once instead of every caller redoing it — and measuring to the
 * surface rather than the centre, which is the difference that once produced two phantom
 * range violations exactly one gate-depth wide.
 */
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
    // A Model or a Folder has neither, and there is nothing to measure to.
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

/**
 * A section, with the wrapper that only existed to keep it byte-identical to a tool that is gone.
 *
 * Studio nests each section as `{status, data: {...}}`: the `data` was verbatim what the matching
 * single tool returned. Those single tools are gone, so the wrapper is pure depth and comes off.
 *
 * `success` goes with it — it sat beside `status` saying the same thing, and one verdict field is
 * the rule everywhere in this tool.
 *
 * `status` comes first and cannot be displaced: a section's verdict read after a 178-entry array
 * is a verdict nobody reads, and a payload that carried its own `status` would otherwise replace
 * it with something answering a different question. No payload does; a test says so.
 */
function flattenSection(name: string, section: unknown): unknown {
  if (!isRecord(section) || !isRecord(section.data)) return section;
  const { data, ...meta } = section;
  const { success: _success, ...rest } = data;
  // The character payload holds one thing, an object also called `character`, so leaving it
  // wrapped just moves the doubled name one level in rather than removing it.
  const payload = name === "character" && isRecord(rest.character) ? { ...rest, ...rest.character } : rest;
  if (name === "character") delete (payload as Record<string, unknown>).character;
  const flat: Record<string, unknown> = { ...meta };
  for (const [key, value] of Object.entries(payload)) {
    if (!(key in flat)) flat[key] = value;
  }
  return flat;
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

  // `properties: true` is the whole class, and the whole class is mostly the engine. Strip the
  // plumbing here rather than in Studio: this is where the tool's contract lives, and the same
  // reply is what a reader has to scan.
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

  // Flattening happens last, so everything above still reads the shape Studio sent.
  const measured = withDistanceFromCharacter(shaped);
  if (!isRecord(measured)) return measured;
  const flat: Record<string, unknown> = { ...measured };
  for (const name of ["character", "ui", "instances"]) {
    if (name in flat) flat[name] = flattenSection(name, flat[name]);
  }
  return flat;
}
