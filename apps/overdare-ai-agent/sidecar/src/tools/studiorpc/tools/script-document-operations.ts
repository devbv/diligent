// @summary Approval-free .ovdrjm script mutations shared by public tools and playtest orchestration.

import {
  findNodeByActorGuid,
  isRecord,
  normalizeLeadingSpaces,
  normalizeLineEndings,
  type OvdrjmNode,
  readAndWriteOvdrjm,
  removeNodeByActorGuid,
} from "./ovdrjm-utils";

const SCRIPT_CLASSES = new Set(["Script", "LocalScript", "ModuleScript"]);

export interface AddScriptDocumentInput {
  class: "LocalScript" | "Script" | "ModuleScript";
  parentGuid: string;
  name: string;
  source: string;
}

export interface AddScriptDocumentResult {
  guid: string;
  normalizedLeadingSpaceGroups: number;
  normalizedLineEndings: number;
}

function makeActorGuid(): string {
  return Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 16)
      .toString(16)
      .toUpperCase(),
  ).join("");
}

function nextObjectKey(rootDoc: Record<string, unknown>): number {
  const current = rootDoc.MapObjectKeyIndex;
  const numeric = typeof current === "number" && Number.isFinite(current) ? Math.floor(current) : 0;
  const next = numeric + 1;
  rootDoc.MapObjectKeyIndex = next;
  return next;
}

export function addScriptToDocument(
  cwd: string,
  input: AddScriptDocumentInput,
  createGuid: () => string = makeActorGuid,
): AddScriptDocumentResult {
  let result: AddScriptDocumentResult | undefined;

  readAndWriteOvdrjm(cwd, (rootDoc) => {
    const root = rootDoc.Root;
    if (!isRecord(root)) {
      throw new Error("Invalid .ovdrjm format: Root object is missing.");
    }

    const parent = findNodeByActorGuid(root as OvdrjmNode, input.parentGuid);
    if (!parent) {
      throw new Error(`Parent ActorGuid not found in .ovdrjm: ${input.parentGuid}`);
    }

    const childList = Array.isArray(parent.LuaChildren) ? parent.LuaChildren : [];
    parent.LuaChildren = childList;

    const guid = createGuid();
    const normalized = normalizeLeadingSpaces(input.source);
    const eolNormalized = normalizeLineEndings(normalized.result);
    childList.push({
      InstanceType: input.class,
      ActorGuid: guid,
      ObjectKey: nextObjectKey(rootDoc),
      Name: input.name,
      Source: eolNormalized.result,
    });
    result = {
      guid,
      normalizedLeadingSpaceGroups: normalized.converted,
      normalizedLineEndings: eolNormalized.converted,
    };
  });

  if (!result) {
    throw new Error("Script document mutation completed without a result.");
  }
  return result;
}

export function deleteScriptFromDocument(cwd: string, targetGuid: string): void {
  readAndWriteOvdrjm(cwd, (rootDoc) => {
    const root = rootDoc.Root;
    if (!isRecord(root)) {
      throw new Error("Invalid .ovdrjm format: Root object is missing.");
    }

    const target = findNodeByActorGuid(root as OvdrjmNode, targetGuid);
    if (!target) {
      throw new Error(`ActorGuid not found in .ovdrjm: ${targetGuid}`);
    }

    const instanceType = typeof target.InstanceType === "string" ? target.InstanceType : undefined;
    if (!instanceType || !SCRIPT_CLASSES.has(instanceType)) {
      throw new Error(
        `Instance ${targetGuid} is ${instanceType ?? "unknown"}, not a script. ` +
          "Use studiorpc_instance_delete to delete non-script instances.",
      );
    }

    if (!removeNodeByActorGuid(root as OvdrjmNode, targetGuid)) {
      throw new Error(`Failed to remove ActorGuid from .ovdrjm: ${targetGuid}`);
    }
  });
}
