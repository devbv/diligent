// @summary Tests that an empty value on an optional parameter is read as no value.
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { dropEmptyOptionals } from "../../src/tool/empty-arguments";

describe("dropEmptyOptionals", () => {
  test('drops the "" a model writes for an optional it has no answer for', () => {
    // Verbatim from a play-test run: the first game_character_read of the thread, before the
    // agent had any ids to give. Studio answered "That play-test client cannot be read."
    const schema = z.object({
      pieSessionId: z.string().optional(),
      clientId: z.string().optional(),
    });
    expect(dropEmptyOptionals(schema, { pieSessionId: "", clientId: "" })).toEqual({});
    expect(dropEmptyOptionals(schema, { pieSessionId: "377e372c", clientId: "" })).toEqual({
      pieSessionId: "377e372c",
    });
  });

  test("keeps an empty value on a required parameter, where it means something", () => {
    // script_edit's replacement text: "" is how a line gets deleted.
    const schema = z.object({ oldText: z.string(), newText: z.string() });
    expect(dropEmptyOptionals(schema, { oldText: "local x = 1", newText: "" })).toEqual({
      oldText: "local x = 1",
      newText: "",
    });
  });

  test("drops empty arrays and objects too, which are the same gesture", () => {
    const schema = z.object({
      paths: z.array(z.string()).optional(),
      fields: z.array(z.string()).optional(),
      properties: z.record(z.unknown()).optional(),
    });
    expect(dropEmptyOptionals(schema, { paths: [], fields: ["text"], properties: {} })).toEqual({
      fields: ["text"],
    });
  });

  test("reaches inside a nested object, and drops it once it has nothing left", () => {
    const schema = z.object({
      camera: z.object({ position: z.string().optional(), lookAt: z.string().optional() }).optional(),
    });
    expect(dropEmptyOptionals(schema, { camera: { position: "", lookAt: "" } })).toEqual({});
    expect(dropEmptyOptionals(schema, { camera: { position: "0,0,0", lookAt: "" } })).toEqual({
      camera: { position: "0,0,0" },
    });
  });

  test("a whole optional sub-object filled with blanks goes away", () => {
    // overdaresearch's debugCaseFilter, verbatim from a build run — every field blank, on a
    // `source: "docs"` search where the filter applies to debug cases and nothing else. This is
    // the pathology outside the play-test tools entirely: the agent fills what it is offered.
    const schema = z.object({
      query: z.string(),
      source: z.enum(["docs", "code", "assets", "debug"]),
      debugCaseFilter: z
        .object({
          caseId: z.string().optional(),
          category: z.string().optional(),
          severity: z.string().optional(),
          symptomTags: z.array(z.string()).optional(),
          genreTags: z.array(z.string()).optional(),
        })
        .optional(),
    });

    expect(
      dropEmptyOptionals(schema, {
        query: "ProximityPrompt Triggered event server script",
        source: "docs",
        debugCaseFilter: { caseId: "", category: "", severity: "", symptomTags: [], genreTags: [] },
      }),
    ).toEqual({ query: "ProximityPrompt Triggered event server script", source: "docs" });

    // One real field keeps the filter, and only that field.
    expect(
      dropEmptyOptionals(schema, {
        query: "black screen",
        source: "debug",
        debugCaseFilter: { caseId: "", category: "ui", severity: "", symptomTags: [], genreTags: [] },
      }),
    ).toEqual({ query: "black screen", source: "debug", debugCaseFilter: { category: "ui" } });
  });

  test("looks through the wrappers a parameter list picks up", () => {
    const schema = z.preprocess((value) => value, z.object({ under: z.string().optional() }));
    expect(dropEmptyOptionals(schema, { under: "" })).toEqual({});
  });

  test("leaves alone what the schema does not describe, so validation still reports it", () => {
    // `__none__` is a sentinel one model invents for "I have no value here". It is not empty and
    // is not guessable in general, so it stays and the schema decides.
    const schema = z.object({ under: z.string().optional() });
    expect(dropEmptyOptionals(schema, { under: "__none__", stray: "" })).toEqual({
      under: "__none__",
      stray: "",
    });
  });

  test("does not reach inside an array, where the entries are the caller's own data", () => {
    // instance_upsert's shape. Clearing a label is setting its Text to "", and a rule about
    // parameters must not reach down into the values a caller is writing into the world.
    const schema = z.object({
      items: z.array(z.object({ guid: z.string(), properties: z.record(z.unknown()).optional() })).min(1),
    });
    const call = { items: [{ guid: "87979D27", properties: { Text: "", Transparency: 0 } }] };
    expect(dropEmptyOptionals(schema, call)).toEqual(call);
  });

  test("follows a parameter offered as an object or a shorthand for it", () => {
    // game_observe's `instances` is a list of names or a selector object — one question that used
    // to be two parameters. The blanks live inside the object form, and until this the union
    // stopped the walk dead and `namePattern: ""` reached Studio as a filter matching nothing.
    const schema = z.object({
      instances: z
        .union([z.array(z.string()), z.object({ namePattern: z.string().optional(), maxDepth: z.number().optional() })])
        .optional(),
    });
    expect(dropEmptyOptionals(schema, { instances: { maxDepth: 1, namePattern: "" } })).toEqual({
      instances: { maxDepth: 1 },
    });
    expect(dropEmptyOptionals(schema, { instances: ["Gate"] })).toEqual({ instances: ["Gate"] });
  });

  test("declines to guess when a union offers more than one object", () => {
    // Which branch was meant is not knowable before validation, and picking one would drop a key
    // the other requires — editing the request rather than reading it.
    const schema = z.object({
      thing: z.union([z.object({ a: z.string().optional() }), z.object({ b: z.string().optional() })]).optional(),
    });
    expect(dropEmptyOptionals(schema, { thing: { a: "" } })).toEqual({ thing: { a: "" } });
  });

  test("leaves a passthrough schema entirely alone, which is every proxied MCP tool", () => {
    // Tools from an external MCP server are registered with `z.object({}).passthrough()` — the
    // real schema lives on the far server and this side knows nothing about it. Every key is
    // therefore unknown, and an unknown key is not ours to judge: a blank that matters to some
    // other server's tool must arrive as the caller wrote it.
    const schema = z.object({}).passthrough();
    const call = { path: "", depth: 0, tags: [], nested: { a: "" } };
    expect(dropEmptyOptionals(schema, call)).toEqual(call);
  });

  test("passes non-objects through untouched", () => {
    expect(dropEmptyOptionals(z.string(), "hello")).toBe("hello");
    expect(dropEmptyOptionals(z.object({}), undefined)).toBeUndefined();
  });
});
