// @summary Declares the Studio RPC method for reading several parts of the running game in one call.
import { z } from "zod";
import { isRecord } from "../camera-response";
import { dropPlaceholders, postProcess as nameMissesInInstances } from "./game.instance.read";

export const method = "game.observe";

export const description =
  "Read several parts of the running play test in one call, all from the same moment. " +
  "Use it whenever you want two or more of: where the character is, what the UI says, and what some " +
  "instances look like. Measured across 68 play-test runs, two thirds of all reads sat in a run of " +
  "consecutive reads with no action between them — one question asked in three or four round trips, each " +
  "one about six real seconds of which the model's own thinking is five, and the game runs through all of " +
  "it. " +
  "Bundling is not only about speed. Read separately, the character comes from one moment and the UI from " +
  "another several seconds later, and treating the two as one picture has already produced wrong " +
  "conclusions. Here the sections are gathered inside one game-thread call, so no tick passes between " +
  "them — and rather than asking you to take that on trust, every section reports the `atFrame` it was " +
  "read at beside the reply's own. Equal numbers are the proof; if they ever differ, that is the reply " +
  "telling you these readings are not one instant and should not be reconciled as one. " +
  "No section you did not ask for comes back, and asking for nothing is rejected rather than answered " +
  "with everything. " +
  'Read `outcome` first, and read only it — there is no second verdict to weigh it against. "ok" means ' +
  'every section you asked for answered; "partial" means `failedSections` names the ones that did not. ' +
  "A failed section is still here, carrying its own `error` where its `data` would be: it is not missing " +
  'and it is not empty, so do not read a failed `ui` section as "this game has no UI". ' +
  "`requestedSections` is what you asked for, in order. " +
  "Each section's `data` is byte-for-byte what the matching single tool returns, so anything that reads " +
  "those replies reads these — which is also why the pose sits at `character.data.character.CFrame` " +
  "rather than one level up. " +
  "Do not use it to read one property of one instance — that is studiorpc_game_instance_read, and it is " +
  "simpler. Screenshots are not a section here: pixels come from a rendered frame rather than the game " +
  "tick, so they cannot honestly carry this call's timestamp. Take one with studiorpc_game_screenshot when " +
  "you need to see rather than to read. " +
  "There is no clientId here, deliberately. In a session started with more than one player the character " +
  "and ui sections always describe the main play test — the one studiorpc_game_pie_status marks " +
  "targeted: true — even when a move was aimed at another client; taking a clientId that only two of the " +
  "three sections could honour is exactly the half-aimed reply this tool exists to prevent. To follow a " +
  "move on another client, read studiorpc_game_character_read with its clientId. The instances section " +
  "needs none: it reads the shared world, so every player's character is in it.";

/** The same arguments studiorpc_game_ui_browse takes, so nothing has to be re-learned here. */
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
 * studiorpc_game_instance_read's arguments, minus the two that `targets` already covers.
 *
 * That tool's `name` and `path` name one instance; `targets` takes either spelling, one entry
 * each. Offering all three invites all three, which is what the first measured run did — and
 * then they disagreed.
 */
const instancesSection = z
  .object({
    targets: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe("Names or dot-separated paths to read, one entry each; each answers with its own status."),
    namePattern: z
      .string()
      .min(1)
      .optional()
      .describe("Find every instance whose name or path contains this text, at any depth."),
    class: z.string().min(1).optional().describe('Find every instance of this class, at any depth (e.g. "Part").'),
    under: z.string().min(1).optional().describe("Search only inside this instance, by path."),
    maxDepth: z.number().int().min(1).max(32).optional().describe("How many levels to list. Defaults to 1."),
  })
  .strict()
  // The same pair studiorpc_game_instance_read refuses, for the same reason: `targets` names the
  // instances you want and `namePattern`/`class` search for the ones you cannot name. Studio
  // answers the first and drops the second without saying so.
  .refine((value) => value.targets === undefined || (value.namePattern === undefined && value.class === undefined), {
    message:
      "targets names the instances you want, and namePattern/class search for ones you cannot name — they " +
      "are two questions, and only the first is answered. Ask for one; `under` narrows a search to a subtree.",
  });

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
        "Include the on-screen UI: rects, text, visibility, occlusion, contrast. Pass true for all of it, or " +
          "an object of studiorpc_game_ui_browse arguments to narrow it — it is the largest section, so " +
          "narrow it when you know what you are looking for.",
      ),
    instances: z
      .union([z.array(z.string().min(1)).min(1), instancesSection])
      .optional()
      .describe(
        'Include live instance state. An array is the short form for "read these": each entry is a ' +
          'dot-separated path (containing a ".") or a runtime name, and each answers with its own `status`, ' +
          "so one wrong name does not cost you the other nineteen. An object takes " +
          "studiorpc_game_instance_read's searching and listing arguments — `namePattern`, `class`, " +
          "`under`, `maxDepth` — for when you do not know the names yet.",
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
export function normalizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const { instances, fields } = args;
  // `isRecord` is true for arrays too, and spreading the array shorthand into an object turns
  // ["Gate"] into {"0": "Gate"} — which Studio reads as no targets at all.
  if (!Array.isArray(fields) || Array.isArray(instances) || !isRecord(instances)) {
    // The section takes game.instance.read's identifier parameters, so it inherits the same
    // placeholder problem: a namePattern of "." searches the whole world instead of nothing.
    return isRecord(instances) && !Array.isArray(instances)
      ? { ...args, instances: dropPlaceholders(instances) }
      : args;
  }
  if (instances.fields !== undefined) return { ...args, instances: dropPlaceholders(instances) };
  return { ...args, instances: dropPlaceholders({ ...instances, fields }) };
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
 * How far the character is from each instance, when the same call read both.
 *
 * A run that measured the character to a station's *centre* and compared it against the station's
 * stated reach reported two range violations that were not there: 130 against a limit of 120, and
 * 159 against 140. Both stations were within reach — a game measures to what a character can touch,
 * and the 19-unit discrepancy was the gate's own depth. The tools that know this are
 * studiorpc_game_character_move_to's `distanceToTarget` and this section's Size, and the caller has
 * to know which. Here it does not: both numbers are already in this reply, so the arithmetic is
 * done rather than described.
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
      horizontalDistanceToCentre: Math.round(Math.hypot(from.x - centre.x, from.z - centre.z) * 10) / 10,
    };
  });
  if (measured === 0) return shaped;

  return {
    ...shaped,
    instances: {
      ...wrapper,
      data: {
        ...section,
        instances: withDistances,
        distanceNote:
          "`distanceFromCharacter` is measured to the instance's surface — the thing a character can " +
          "reach — and is the number a game's stated reach is written against. " +
          "`horizontalDistanceToCentre` is the flat distance to its middle, which is how a rule is " +
          "usually worded. They disagree by half the instance's own size, so bracket a stated reach " +
          "against both rather than picking one. Distances are from the character's origin, a capsule " +
          "half-height above its feet, so anything it stands on reads about 84 away.",
      },
    },
  };
}

export function postProcess(result: unknown): unknown {
  if (!isRecord(result)) return result;
  const shaped: Record<string, unknown> = isRecord(result.instances)
    ? {
        ...result,
        instances: isRecord(result.instances.data)
          ? { ...result.instances, data: nameMissesInInstances(result.instances.data) }
          : result.instances,
      }
    : { ...result };

  const requested = Array.isArray(shaped.requestedSections) ? shaped.requestedSections : [];
  const frames = requested
    .map((name) => (typeof name === "string" && isRecord(shaped[name]) ? shaped[name].atFrame : undefined))
    .filter((frame): frame is number => typeof frame === "number");
  if (frames.length > 1 && new Set([...frames, shaped.atFrame]).size > 1) {
    shaped.sectionsSpanFrames = true;
    shaped.sectionsSpanNote =
      `The sections did not all come from one frame (reply ${String(shaped.atFrame)}, sections ` +
      `${frames.join(", ")}). Read them as separate readings taken close together, not as one moment: ` +
      "anything that moved between those frames is described differently by different sections here. " +
      "This is not supposed to happen and is worth reporting.";
  }
  return withDistanceFromCharacter(shaped);
}
