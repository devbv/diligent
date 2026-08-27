// @summary Adds a script instance through the Studio instance.create RPC.

import type * as scriptAdd from "../../methods/script.add";
import { buildScriptAddRender } from "../../render";
import type { ToolResult } from "../../types";
import { normalizeLeadingSpaces, normalizeLineEndings } from "../ovdrjm-utils";
import { callInstanceRpc, createdActorGuids, saveLevelFile } from "./client";

type ScriptAddArgs = ReturnType<typeof scriptAdd.params.parse>;

export async function addScriptViaRpc(parsed: ScriptAddArgs): Promise<ToolResult> {
  const normalized = normalizeLeadingSpaces(parsed.source);
  const eolNormalized = normalizeLineEndings(normalized.result);

  const result = await callInstanceRpc("instance.create", {
    ParentActorGuid: parsed.parentGuid,
    Instances: [{ InstanceType: parsed.class, Name: parsed.name, Source: eolNormalized.result }],
  });
  await saveLevelFile();

  const addedGuid = createdActorGuids(result)[0] ?? "";
  let output = `Script added: ${parsed.name} (${addedGuid})`;
  const normalizations: string[] = [];
  if (normalized.converted > 0) normalizations.push(`${normalized.converted} leading 4-space group(s) → tabs`);
  if (eolNormalized.converted > 0) normalizations.push(`${eolNormalized.converted} line ending(s) normalized`);
  if (normalizations.length > 0) output += ` (${normalizations.join(", ")})`;

  return {
    output,
    render: buildScriptAddRender(parsed as unknown as Record<string, unknown>, output, addedGuid),
    metadata: { method: "script.add", guid: addedGuid, name: parsed.name, class: parsed.class },
  };
}
