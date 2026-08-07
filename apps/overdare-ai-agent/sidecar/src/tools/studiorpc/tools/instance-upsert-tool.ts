// @summary Applies batched add or update instance changes to the level file.

import { resolveApiVersion } from "../config";
import * as instanceUpsert from "../methods/instance.upsert";
import { collectUiDiagnostics } from "../methods/instance.upsert";
import { buildInstanceUpsertRender } from "../render";
import { applyLevelChanges } from "../rpc";
import type { Tool, ToolContext, ToolResult } from "../types";
import type { WriteLock } from "../write-lock";
import {
  addInstancesInDocument,
  normalizeWorkspaceMobility,
  requireDocumentRoot,
  updateInstancesInDocument,
} from "./instance-document-operations";
import { resultFromInstanceToolStatusError } from "./instance-status";
import { type OvdrjmNode, readAndWriteOvdrjm } from "./ovdrjm-utils";
import { upsertInstancesViaRpc } from "./v2/instance-upsert";

function toToolName(method: string): string {
  return `studiorpc_${method.replace(/\./g, "_")}`;
}

async function executeInstanceUpsert(
  args: Record<string, unknown>,
  ctx: ToolContext,
  cwd: string,
  writeLock: WriteLock,
): Promise<ToolResult> {
  const toolName = "studiorpc_instance_upsert";
  const parsedArgs = instanceUpsert.parseArgs(args);

  const writeApproval = await ctx.approve({
    permission: "write",
    toolName,
    description: "Update .ovdrjm world file",
    details: parsedArgs,
  });
  if (writeApproval === "reject") {
    return {
      output: "[Rejected by user]",
      metadata: { error: true, method: "instance.upsert" },
    };
  }

  const release = await writeLock.acquire();
  try {
    if (resolveApiVersion() === "v2") return await upsertInstancesViaRpc(parsedArgs);
    return await executeInstanceUpsertInner(parsedArgs, cwd);
  } finally {
    release();
  }
}

export async function executeInstanceUpsertInner(
  parsedArgs: ReturnType<typeof instanceUpsert.parseArgs>,
  cwd: string,
  options: { applyAndSaveChanges?: boolean } = {},
): Promise<ToolResult> {
  let ovdrjmRoot: OvdrjmNode | undefined;
  const applyAndSaveChanges = options.applyAndSaveChanges ?? true;

  const fileResult = (() => {
    try {
      return readAndWriteOvdrjm(cwd, (rootDoc) => {
        const root = requireDocumentRoot(rootDoc);
        const mobilityInfo: string[] = [];
        const writeOptions = { mobilityPolicy: "ignore-non-top-level" as const, mobilityInfo };

        const added: { guid: string; name: string; class: string }[] = [];
        for (const item of parsedArgs.items) {
          if (instanceUpsert.isUpdateItem(item)) {
            updateInstancesInDocument(root, [{ ...item, properties: item.properties ?? {} }], writeOptions);
            continue;
          }
          added.push(
            ...addInstancesInDocument(rootDoc, [{ ...item, properties: item.properties ?? {} }], writeOptions),
          );
        }

        // A top-level object's Mobility governs its whole assembly, so cascade it
        // down to every descendant that carries an explicit Mobility.
        normalizeWorkspaceMobility(root);

        ovdrjmRoot = root;
        return { added, mobilityInfo };
      });
    } catch (error) {
      const result = resultFromInstanceToolStatusError(error);
      if (result) return result;
      throw error;
    }
  })();

  if ("output" in fileResult) {
    return fileResult;
  }

  if (applyAndSaveChanges) {
    await applyLevelChanges();
  }
  const diag = ovdrjmRoot ? collectUiDiagnostics(ovdrjmRoot) : { warnings: [], info: [] };
  diag.info.push(...fileResult.mobilityInfo);
  const addedGuids = fileResult.added.map((item) => item.guid);
  const updatedGuids = parsedArgs.items.flatMap((item) => (instanceUpsert.isUpdateItem(item) ? [item.guid] : []));
  const targetGuids = [...updatedGuids, ...addedGuids];
  const addCount = fileResult.added.length;
  const updateCount = updatedGuids.length;

  const lines: string[] = [];
  if (fileResult.added.length > 0) {
    lines.push("<added-instances>");
    for (const a of fileResult.added) {
      lines.push(`<instance name="${a.name}" class="${a.class}" guid="${a.guid}" />`);
    }
    lines.push("</added-instances>");
  }
  if (diag.warnings.length > 0) {
    lines.push("<warnings>", ...diag.warnings, "</warnings>");
  }
  if (diag.info.length > 0) {
    lines.push("<suggestions>", ...diag.info, "</suggestions>");
  }

  return {
    output: lines.join("\n") || "OK",
    render: buildInstanceUpsertRender(parsedArgs as unknown as Record<string, unknown>, lines.join("\n") || "OK"),
    metadata: {
      method: "instance.upsert",
      targetGuids,
      addCount,
      updateCount,
      added: fileResult.added,
      ...(diag.warnings.length > 0 && { warnings: diag.warnings }),
      ...(diag.info.length > 0 && { info: diag.info }),
    },
  };
}

export function createInstanceUpsertTool(cwd: string, writeLock: WriteLock): Tool {
  return {
    name: toToolName(instanceUpsert.method),
    description: instanceUpsert.description,
    parameters: instanceUpsert.params,
    parseArgs: (raw) => instanceUpsert.parseArgs(raw as Record<string, unknown>),
    async execute(args, ctx) {
      return executeInstanceUpsert(args, ctx, cwd, writeLock);
    },
  };
}
