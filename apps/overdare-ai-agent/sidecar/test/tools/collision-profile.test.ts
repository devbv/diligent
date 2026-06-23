// @summary Tests .ovdrjm collision channel and profile CRUD tools.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@diligent/core/tool/types";
import { createStudioRpcToolProvider } from "../../src/tools/studiorpc";

const createdDirs: string[] = [];

function makeProject(worldProfileData: Record<string, unknown>): string {
  const cwd = join(tmpdir(), `sidecar-collision-profile-${process.pid}-${Date.now()}-${createdDirs.length}`);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "Test.umap"), "");
  writeFileSync(join(cwd, "Test.ovdrjm"), JSON.stringify({ WorldProfileData: worldProfileData }, null, 2));
  createdDirs.push(cwd);
  return cwd;
}

function readWorldProfileData(cwd: string): Record<string, unknown> {
  const raw = readFileSync(join(cwd, "Test.ovdrjm"), "utf-8");
  const parsed = JSON.parse(raw) as { WorldProfileData: Record<string, unknown> };
  return parsed.WorldProfileData;
}

async function loadCollisionTools(cwd: string): Promise<Map<string, Tool>> {
  const provider = createStudioRpcToolProvider();
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
    const tools = await loadCollisionTools(cwd);

    const listResult = await tools.get("get_collision_channels")!.execute({}, toolContext());
    expect(listResult.metadata?.result).toMatchObject({
      defaultChannels: [{ name: "WorldStatic" }],
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
    });

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
});
