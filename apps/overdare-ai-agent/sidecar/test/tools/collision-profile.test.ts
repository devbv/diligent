// @summary Tests .ovdrjm collision channel and profile CRUD tools.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@diligent/core/tool/types";
import { createStudioRpcToolProvider } from "../../src/tools/studiorpc";

const createdDirs: string[] = [];

function makeProject(worldProfileData: Record<string, unknown>): string {
  return makeProjectDocument({ WorldProfileData: worldProfileData });
}

function makeProjectDocument(document: Record<string, unknown>): string {
  const cwd = join(tmpdir(), `sidecar-collision-profile-${process.pid}-${Date.now()}-${createdDirs.length}`);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "Test.umap"), "");
  writeFileSync(join(cwd, "Test.ovdrjm"), JSON.stringify(document, null, 2));
  createdDirs.push(cwd);
  return cwd;
}

function readOvdrjmRaw(cwd: string): string {
  return readFileSync(join(cwd, "Test.ovdrjm"), "utf-8");
}

function readWorldProfileData(cwd: string): Record<string, unknown> {
  const raw = readOvdrjmRaw(cwd);
  const parsed = JSON.parse(raw) as { WorldProfileData: Record<string, unknown> };
  return parsed.WorldProfileData;
}

async function loadCollisionTools(
  cwd: string,
  rpcCalls: Array<{ method: string; params?: Record<string, unknown> }> = [],
): Promise<Map<string, Tool>> {
  const provider = createStudioRpcToolProvider({
    callRpc: async (method, params) => {
      rpcCalls.push({ method, params });
      return { ok: true };
    },
  });
  const tools = await provider.createTools({
    cwd,
    host: { approve: async () => "once" },
  });
  return new Map(tools.map((tool) => [tool.name, tool]));
}

function toolContext() {
  return { toolCallId: "test", signal: new AbortController().signal, abort: () => {} };
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("collision channel tools", () => {
  test("reads WorldProfileData from the ovdrjm Root LuaChildren tree", async () => {
    const cwd = makeProjectDocument({
      FileVersion: 1,
      Root: {
        InstanceType: "World",
        LuaChildren: [
          { InstanceType: "Folder", Name: "Other" },
          {
            InstanceType: "WorldSettings",
            WorldProfileData: {
              DefaultChannelResponses: [
                {
                  channel: "ECC_EngineTraceChannel5",
                  defaultResponse: "ECR_Ignore",
                  bTraceType: true,
                  bStaticObject: false,
                  name: "WeaponTrace",
                },
                {
                  channel: "ECC_GameTraceChannel1",
                  defaultResponse: "ECR_Block",
                  bTraceType: false,
                  bStaticObject: false,
                  name: "Bullet",
                },
              ],
              Profiles: [
                {
                  name: "BlockAll",
                  collisionEnabled: "QueryAndPhysics",
                  bCanModify: false,
                  objectTypeName: "WorldStatic",
                  customResponses: [],
                },
                {
                  name: "Ragdoll",
                  collisionEnabled: "QueryAndPhysics",
                  bCanModify: false,
                  objectTypeName: "PhysicsBody",
                  customResponses: [],
                },
                {
                  name: "PlayerProfile",
                  collisionEnabled: "QueryAndPhysics",
                  bCanModify: true,
                  objectTypeName: "Pawn",
                  customResponses: [{ channel: "Bullet", response: "ECR_Overlap" }],
                },
              ],
              EditProfiles: [
                {
                  name: "BlockAll",
                  customResponses: [{ channel: "Bullet", response: "ECR_Ignore" }],
                },
              ],
            },
          },
        ],
      },
    });
    const tools = await loadCollisionTools(cwd);

    const channelResult = await tools.get("get_collision_channels")!.execute({}, toolContext());
    const profileResult = await tools.get("get_collision_profiles")!.execute({}, toolContext());

    expect(channelResult.metadata?.result).toMatchObject({
      defaultChannels: expect.arrayContaining([
        expect.objectContaining({ name: "WorldStatic" }),
        expect.objectContaining({ name: "WeaponTrace", channel: "ECC_EngineTraceChannel5" }),
      ]),
      customChannels: [{ name: "Bullet" }],
      defaultChannelCount: 10,
      customChannelCount: 1,
      totalChannelCount: 11,
    });
    expect(channelResult.render).toMatchObject({
      inputSummary: "list collision channels",
      outputSummary: "11 channels (1 custom)",
    });
    expect(profileResult.metadata?.result).toMatchObject({
      defaultProfiles: expect.arrayContaining([
        expect.objectContaining({
          name: "BlockAll",
          customResponses: [{ channel: "Bullet", response: "ECR_Ignore" }],
        }),
        expect.objectContaining({ name: "Ragdoll" }),
      ]),
      customProfiles: [expect.objectContaining({ name: "PlayerProfile" })],
      defaultProfileCount: 22,
      customProfileCount: 1,
      totalProfileCount: 23,
    });
    expect(profileResult.render).toMatchObject({
      inputSummary: "list collision profiles",
      outputSummary: "23 profiles (1 custom)",
    });
  });

  test("reads channels and profiles without modifying the ovdrjm file", async () => {
    const cwd = makeProject({
      DefaultChannelResponses: [
        {
          channel: "ECC_GameTraceChannel1",
          defaultResponse: "ECR_Block",
          bTraceType: false,
          bStaticObject: false,
          name: "Bullet",
        },
      ],
      Profiles: [
        {
          name: "PlayerProfile",
          collisionEnabled: "QueryAndPhysics",
          bCanModify: true,
          objectTypeName: "Pawn",
          customResponses: [{ channel: "Bullet", response: "ECR_Overlap" }],
        },
      ],
      EditProfiles: {
        BlockAll: {
          customResponses: [{ channel: "Bullet", response: "ECR_Ignore" }],
        },
      },
    });
    const rpcCalls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const tools = await loadCollisionTools(cwd, rpcCalls);
    const before = readOvdrjmRaw(cwd);

    const channelResult = await tools.get("get_collision_channels")!.execute({}, toolContext());
    const profileResult = await tools.get("get_collision_profiles")!.execute({}, toolContext());

    expect(channelResult.metadata?.result).toMatchObject({
      customChannels: [{ name: "Bullet" }],
    });
    expect(profileResult.metadata?.result).toMatchObject({
      customProfiles: [expect.objectContaining({ name: "PlayerProfile" })],
    });
    expect(readOvdrjmRaw(cwd)).toBe(before);
    expect(rpcCalls).toEqual([]);
  });

  test("lists, adds, renames, and deletes custom channels with profile response synchronization", async () => {
    const cwd = makeProject({
      DefaultChannelResponses: [
        {
          channel: "ECC_WorldStatic",
          defaultResponse: "ECR_Block",
          bTraceType: false,
          bStaticObject: true,
          name: "WorldStatic",
        },
        {
          channel: "ECC_GameTraceChannel1",
          defaultResponse: "ECR_Block",
          bTraceType: false,
          bStaticObject: false,
          name: "Bullet",
        },
      ],
      Profiles: [
        {
          name: "PlayerProfile",
          collisionEnabled: "QueryAndPhysics",
          bCanModify: true,
          objectTypeName: "Pawn",
          customResponses: [{ channel: "Bullet", response: "ECR_Overlap" }],
        },
        {
          name: "ProjectileProfile",
          collisionEnabled: "QueryAndPhysics",
          bCanModify: true,
          objectTypeName: "Bullet",
          customResponses: [],
        },
      ],
      EditProfiles: {
        BlockAll: {
          customResponses: [{ channel: "Bullet", response: "ECR_Ignore" }],
        },
      },
    });
    const rpcCalls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const tools = await loadCollisionTools(cwd, rpcCalls);

    const listResult = await tools.get("get_collision_channels")!.execute({}, toolContext());
    expect(listResult.metadata?.result).toMatchObject({
      defaultChannels: expect.arrayContaining([expect.objectContaining({ name: "WorldStatic" })]),
      customChannels: [{ name: "Bullet" }],
    });

    await tools.get("add_collision_channel")!.execute(
      {
        channel: "ECC_GameTraceChannel2",
        name: "Sensor",
        defaultResponse: "ECR_Overlap",
        bTraceType: true,
        bStaticObject: false,
      },
      toolContext(),
    );
    expect(rpcCalls).toEqual([{ method: "level.apply", params: {} }]);

    const updateResult = await tools.get("update_collision_channel")!.execute(
      {
        channel: "ECC_GameTraceChannel1",
        name: "Projectile",
        defaultResponse: "ECR_Ignore",
      },
      toolContext(),
    );
    expect(updateResult.metadata?.result).toMatchObject({
      sync: { profilesUpdated: 2, responsesUpdated: 2, objectTypeNamesUpdated: 1 },
      levelApplyResult: { ok: true },
    });

    let world = readWorldProfileData(cwd);
    expect(world.DefaultChannelResponses).toContainEqual(
      expect.objectContaining({
        channel: "ECC_GameTraceChannel1",
        name: "Projectile",
        defaultResponse: "ECR_Ignore",
      }),
    );
    expect(world.DefaultChannelResponses).toContainEqual(expect.objectContaining({ name: "Sensor" }));
    expect(world.Profiles).toContainEqual(
      expect.objectContaining({
        name: "PlayerProfile",
        customResponses: [{ channel: "Projectile", response: "ECR_Overlap" }],
      }),
    );
    expect(world.Profiles).toContainEqual(
      expect.objectContaining({
        name: "ProjectileProfile",
        objectTypeName: "Projectile",
      }),
    );
    expect(world.EditProfiles).toMatchObject({
      BlockAll: { customResponses: [{ channel: "Projectile", response: "ECR_Ignore" }] },
    });

    const deleteResult = await tools
      .get("delete_collision_channel")!
      .execute({ channel: "ECC_GameTraceChannel1" }, toolContext());
    expect(deleteResult.metadata).toMatchObject({ error: true, code: "INVALID_CHANNEL" });

    await tools.get("edit_collision_profile")!.execute(
      {
        name: "ProjectileProfile",
        objectTypeName: "Pawn",
      },
      toolContext(),
    );

    const deleteAfterProfileUpdateResult = await tools
      .get("delete_collision_channel")!
      .execute({ channel: "ECC_GameTraceChannel1" }, toolContext());
    expect(deleteAfterProfileUpdateResult.metadata?.result).toMatchObject({
      cleanup: { profilesUpdated: 2, responsesRemoved: 2 },
      levelApplyResult: { ok: true },
    });
    expect(rpcCalls).toEqual([
      { method: "level.apply", params: {} },
      { method: "level.apply", params: {} },
      { method: "level.apply", params: {} },
      { method: "level.apply", params: {} },
    ]);

    world = readWorldProfileData(cwd);
    expect(world.DefaultChannelResponses).not.toContainEqual(expect.objectContaining({ name: "Projectile" }));
    expect(world.Profiles).toContainEqual(expect.objectContaining({ name: "PlayerProfile", customResponses: [] }));
    expect(world.EditProfiles).toMatchObject({ BlockAll: { customResponses: [] } });
  });

  test("rejects default channel mutation", async () => {
    const cwd = makeProject({
      DefaultChannelResponses: [
        {
          channel: "ECC_WorldStatic",
          defaultResponse: "ECR_Block",
          bTraceType: false,
          bStaticObject: true,
          name: "WorldStatic",
        },
      ],
      Profiles: [],
      EditProfiles: {},
    });
    const tools = await loadCollisionTools(cwd);

    const result = await tools.get("delete_collision_channel")!.execute({ channel: "ECC_WorldStatic" }, toolContext());

    expect(result.metadata).toMatchObject({ error: true, code: "PROTECTED_CHANNEL" });
  });

  test("rejects protected channel updates and trace conversion when profiles use the channel as object type", async () => {
    const cwd = makeProject({
      DefaultChannelResponses: [
        {
          channel: "ECC_WorldStatic",
          defaultResponse: "ECR_Block",
          bTraceType: false,
          bStaticObject: true,
          name: "WorldStatic",
        },
        {
          channel: "ECC_GameTraceChannel1",
          defaultResponse: "ECR_Block",
          bTraceType: false,
          bStaticObject: false,
          name: "Projectile",
        },
      ],
      Profiles: [
        {
          name: "ProjectileProfile",
          collisionEnabled: "QueryAndPhysics",
          bCanModify: true,
          objectTypeName: "Projectile",
          customResponses: [],
        },
      ],
      EditProfiles: {},
    });
    const tools = await loadCollisionTools(cwd);

    const protectedResult = await tools.get("update_collision_channel")!.execute(
      {
        channel: "ECC_WorldStatic",
        defaultResponse: "ECR_Ignore",
      },
      toolContext(),
    );
    expect(protectedResult.metadata).toMatchObject({ error: true, code: "PROTECTED_CHANNEL" });

    const traceResult = await tools.get("update_collision_channel")!.execute(
      {
        channel: "ECC_GameTraceChannel1",
        bTraceType: true,
      },
      toolContext(),
    );
    expect(traceResult.metadata).toMatchObject({ error: true, code: "INVALID_CHANNEL" });
  });

  test("uses spec error codes for duplicate channels and invalid responses", async () => {
    const cwd = makeProject({
      DefaultChannelResponses: [
        {
          channel: "ECC_GameTraceChannel1",
          defaultResponse: "ECR_Block",
          bTraceType: false,
          bStaticObject: false,
          name: "Bullet",
        },
      ],
      Profiles: [],
      EditProfiles: {},
    });
    const tools = await loadCollisionTools(cwd);

    const duplicateResult = await tools.get("add_collision_channel")!.execute(
      {
        channel: "ECC_GameTraceChannel1",
        name: "OtherBullet",
        defaultResponse: "ECR_Block",
        bTraceType: false,
        bStaticObject: false,
      },
      toolContext(),
    );
    expect(duplicateResult.metadata).toMatchObject({ error: true, code: "DUPLICATE_NAME" });

    const duplicateNameResult = await tools.get("add_collision_channel")!.execute(
      {
        channel: "ECC_GameTraceChannel2",
        name: "Bullet",
        defaultResponse: "ECR_Block",
        bTraceType: false,
        bStaticObject: false,
      },
      toolContext(),
    );
    expect(duplicateNameResult.metadata).toMatchObject({ error: true, code: "DUPLICATE_NAME" });

    const invalidChannelIdResult = await tools.get("add_collision_channel")!.execute(
      {
        channel: "ECC_GameTraceChannel19",
        name: "OutOfRange",
        defaultResponse: "ECR_Block",
        bTraceType: false,
        bStaticObject: false,
      },
      toolContext(),
    );
    expect(invalidChannelIdResult.metadata).toMatchObject({ error: true, code: "INVALID_CHANNEL" });

    const invalidResponseResult = await tools.get("add_collision_channel")!.execute(
      {
        channel: "ECC_GameTraceChannel2",
        name: "Sensor",
        defaultResponse: "ECR_Bounce",
        bTraceType: false,
        bStaticObject: false,
      },
      toolContext(),
    );
    expect(invalidResponseResult.metadata).toMatchObject({ error: true, code: "INVALID_RESPONSE" });
  });
});

describe("collision profile tools", () => {
  test("creates, updates, lists, and deletes profiles while storing default overrides in EditProfiles", async () => {
    const cwd = makeProject({
      DefaultChannelResponses: [
        {
          channel: "ECC_GameTraceChannel1",
          defaultResponse: "ECR_Block",
          bTraceType: false,
          bStaticObject: false,
          name: "Bullet",
        },
      ],
      Profiles: [],
      EditProfiles: {
        BlockAll: {
          customResponses: [{ channel: "Bullet", response: "ECR_Ignore" }],
        },
      },
    });
    const tools = await loadCollisionTools(cwd);

    const listResult = await tools.get("get_collision_profiles")!.execute({}, toolContext());
    expect(listResult.metadata?.result).toMatchObject({
      defaultProfiles: expect.arrayContaining([
        expect.objectContaining({
          name: "NoCollision",
          bCanModify: false,
        }),
        expect.objectContaining({
          name: "BlockAll",
          customResponses: [{ channel: "Bullet", response: "ECR_Ignore" }],
        }),
      ]),
      customProfiles: [],
    });

    const createResult = await tools.get("create_collision_profile")!.execute(
      {
        name: "Ghost",
        objectTypeName: "Pawn",
        customResponses: [{ channel: "Bullet", response: "ECR_Ignore" }],
        helpMessage: "Ghost profile",
        bCanModify: false,
      },
      toolContext(),
    );
    expect(createResult.metadata?.result).toMatchObject({
      profile: {
        name: "Ghost",
        collisionEnabled: "QueryAndPhysics",
        bCanModify: true,
        objectTypeName: "Pawn",
      },
    });

    await tools.get("edit_collision_profile")!.execute(
      {
        name: "BlockAll",
        customResponses: [{ channel: "Bullet", response: "ECR_Overlap" }],
      },
      toolContext(),
    );

    await tools.get("edit_collision_profile")!.execute(
      {
        name: "Ghost",
        collisionEnabled: "QueryAndPhysics",
        objectTypeName: "WorldDynamic",
        customResponses: [],
        helpMessage: null,
      },
      toolContext(),
    );

    let world = readWorldProfileData(cwd);
    expect(world.EditProfiles).toMatchObject({
      BlockAll: { customResponses: [{ channel: "Bullet", response: "ECR_Overlap" }] },
    });
    expect(world.Profiles).toContainEqual(
      expect.objectContaining({
        name: "Ghost",
        collisionEnabled: "QueryAndPhysics",
        bCanModify: true,
        objectTypeName: "WorldDynamic",
        customResponses: [],
      }),
    );
    expect(world.Profiles).not.toContainEqual(expect.objectContaining({ helpMessage: "Ghost profile" }));

    await tools.get("delete_collision_profile")!.execute({ name: "Ghost" }, toolContext());

    world = readWorldProfileData(cwd);
    expect(world.Profiles).toEqual([]);
  });

  test("rejects protected default profile deletion", async () => {
    const cwd = makeProject({
      DefaultChannelResponses: [],
      Profiles: [],
      EditProfiles: {},
    });
    const tools = await loadCollisionTools(cwd);

    const result = await tools.get("delete_collision_profile")!.execute({ name: "BlockAll" }, toolContext());

    expect(result.metadata).toMatchObject({ error: true, code: "PROTECTED_PROFILE" });
  });

  test("stores default profile custom response overrides only when protected fields are omitted", async () => {
    const cwd = makeProject({
      DefaultChannelResponses: [
        {
          channel: "ECC_GameTraceChannel1",
          defaultResponse: "ECR_Block",
          bTraceType: false,
          bStaticObject: false,
          name: "Bullet",
        },
      ],
      Profiles: [
        {
          name: "BlockAll",
          collisionEnabled: "QueryAndPhysics",
          bCanModify: false,
          objectTypeName: "WorldStatic",
          customResponses: [{ channel: "WorldStatic", response: "ECR_Block" }],
        },
      ],
      EditProfiles: {},
    });
    const tools = await loadCollisionTools(cwd);

    const rejectedResult = await tools.get("edit_collision_profile")!.execute(
      {
        name: "BlockAll",
        collisionEnabled: "QueryAndPhysics",
        objectTypeName: "WorldStatic",
        customResponses: [
          { channel: "WorldStatic", response: "ECR_Block" },
          { channel: "Bullet", response: "ECR_Ignore" },
        ],
      },
      toolContext(),
    );
    expect(rejectedResult.metadata).toMatchObject({ error: true, code: "PROTECTED_PROFILE" });

    const result = await tools.get("edit_collision_profile")!.execute(
      {
        name: "BlockAll",
        customResponses: [
          { channel: "WorldStatic", response: "ECR_Block" },
          { channel: "Bullet", response: "ECR_Ignore" },
        ],
      },
      toolContext(),
    );

    expect(result.metadata?.result).toMatchObject({
      storedIn: "EditProfiles",
      profile: {
        customResponses: [
          { channel: "WorldStatic", response: "ECR_Block" },
          { channel: "Bullet", response: "ECR_Ignore" },
        ],
      },
      levelApplyResult: { ok: true },
    });
    const world = readWorldProfileData(cwd);
    expect(world.Profiles).toContainEqual(
      expect.objectContaining({
        name: "BlockAll",
        collisionEnabled: "QueryAndPhysics",
        objectTypeName: "WorldStatic",
      }),
    );
    expect(world.EditProfiles).toMatchObject({
      BlockAll: {
        customResponses: [
          { channel: "WorldStatic", response: "ECR_Block" },
          { channel: "Bullet", response: "ECR_Ignore" },
        ],
      },
    });
  });

  test("rejects invalid profile references and protected default profile field edits", async () => {
    const cwd = makeProject({
      DefaultChannelResponses: [
        {
          channel: "ECC_GameTraceChannel1",
          defaultResponse: "ECR_Block",
          bTraceType: false,
          bStaticObject: false,
          name: "Bullet",
        },
        {
          channel: "ECC_GameTraceChannel2",
          defaultResponse: "ECR_Ignore",
          bTraceType: true,
          bStaticObject: false,
          name: "HitScan",
        },
      ],
      Profiles: [],
      EditProfiles: {},
    });
    const tools = await loadCollisionTools(cwd);

    const defaultNameResult = await tools.get("create_collision_profile")!.execute(
      {
        name: "BlockAll",
        objectTypeName: "Pawn",
      },
      toolContext(),
    );
    expect(defaultNameResult.metadata).toMatchObject({ error: true, code: "DUPLICATE_NAME" });

    const traceObjectTypeResult = await tools.get("create_collision_profile")!.execute(
      {
        name: "TraceProfile",
        objectTypeName: "HitScan",
      },
      toolContext(),
    );
    expect(traceObjectTypeResult.metadata).toMatchObject({ error: true, code: "INVALID_CHANNEL" });

    const unknownResponseResult = await tools.get("create_collision_profile")!.execute(
      {
        name: "UnknownChannelProfile",
        objectTypeName: "Pawn",
        customResponses: [{ channel: "MissingChannel", response: "ECR_Block" }],
      },
      toolContext(),
    );
    expect(unknownResponseResult.metadata).toMatchObject({ error: true, code: "INVALID_CHANNEL" });

    const defaultFieldEditResult = await tools.get("edit_collision_profile")!.execute(
      {
        name: "BlockAll",
        collisionEnabled: "QueryOnly",
      },
      toolContext(),
    );
    expect(defaultFieldEditResult.metadata).toMatchObject({ error: true, code: "PROTECTED_PROFILE" });
  });
});
