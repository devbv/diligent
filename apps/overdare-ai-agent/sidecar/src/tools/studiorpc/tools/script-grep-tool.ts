// @summary Searches for a regex pattern across script Source properties in .ovdrjm.

import * as scriptGrep from "../methods/script.grep";
import { buildScriptGrepRender } from "../render";
import type { Tool, ToolResult } from "../types";
import { findNodeByActorGuid, type OvdrjmNode, readOvdrjmRoot } from "./ovdrjm-utils";

const SCRIPT_CLASSES = new Set(["Script", "LocalScript", "ModuleScript"]);
const MAX_MATCHES = 100;
const MAX_LINE_LENGTH = 2000;

function toToolName(method: string): string {
  return `studiorpc_${method.replace(/\./g, "_")}`;
}

interface MatchLine {
  scriptName: string;
  scriptGuid: string;
  lineNum: number;
  text: string;
}

/**
 * Walk the subtree rooted at `node`, grep each script's Source line-by-line,
 * and yield matches incrementally so we never buffer all sources in memory.
 */
function grepSubtree(node: OvdrjmNode, regex: RegExp, out: MatchLine[], limit: number): number {
  let total = 0;
  const instanceType = typeof node.InstanceType === "string" ? node.InstanceType : undefined;

  if (instanceType && SCRIPT_CLASSES.has(instanceType)) {
    const source = typeof node.Source === "string" ? node.Source : "";
    const guid = typeof node.ActorGuid === "string" ? node.ActorGuid : "";
    const name = typeof node.Name === "string" ? node.Name : "unnamed";

    // Reset lastIndex for stateless matching per script
    let pos = 0;
    let lineNum = 0;
    while (pos <= source.length) {
      const nl = source.indexOf("\n", pos);
      const lineEnd = nl === -1 ? source.length : nl;
      const line = source.slice(pos, lineEnd);
      lineNum++;

      if (regex.test(line)) {
        total++;
        if (out.length < limit) {
          out.push({
            scriptName: name,
            scriptGuid: guid,
            lineNum,
            text: line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line,
          });
        }
      }

      if (nl === -1) break;
      pos = nl + 1;
    }
  }

  if (Array.isArray(node.LuaChildren)) {
    for (const child of node.LuaChildren) {
      if (typeof child === "object" && child !== null) {
        total += grepSubtree(child as OvdrjmNode, regex, out, limit);
      }
    }
  }

  return total;
}

/** Count scripts in subtree (for metadata). */
function countScripts(node: OvdrjmNode): number {
  let count = 0;
  const instanceType = typeof node.InstanceType === "string" ? node.InstanceType : undefined;
  if (instanceType && SCRIPT_CLASSES.has(instanceType)) count++;
  if (Array.isArray(node.LuaChildren)) {
    for (const child of node.LuaChildren) {
      if (typeof child === "object" && child !== null) {
        count += countScripts(child as OvdrjmNode);
      }
    }
  }
  return count;
}

async function executeScriptGrep(args: Record<string, unknown>, cwd: string): Promise<ToolResult> {
  const parsed = scriptGrep.params.parse(args);
  const { pattern, parentGuid, ignore_case } = parsed;

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, ignore_case ? "i" : "");
  } catch (err) {
    return {
      output: `Error: invalid regex: ${err instanceof Error ? err.message : String(err)}`,
      metadata: { error: true },
    };
  }

  let startNode: OvdrjmNode;
  try {
    const { root } = readOvdrjmRoot(cwd);
    if (parentGuid) {
      const target = findNodeByActorGuid(root, parentGuid);
      if (!target) {
        return { output: `Error: ActorGuid not found: ${parentGuid}`, metadata: { error: true } };
      }
      startNode = target;
    } else {
      startNode = root;
    }
  } catch (err) {
    return {
      output: `Error: ${err instanceof Error ? err.message : String(err)}`,
      metadata: { error: true },
    };
  }

  const scriptsSearched = countScripts(startNode);
  if (scriptsSearched === 0) {
    return { output: "No scripts found in the search scope.", metadata: { error: true } };
  }

  const matchLines: MatchLine[] = [];
  const totalMatches = grepSubtree(startNode, regex, matchLines, MAX_MATCHES);

  if (totalMatches === 0) {
    return {
      output: "No matches found.",
      render: buildScriptGrepRender(pattern, 0, scriptsSearched),
      metadata: { method: "script.grep", matchCount: 0, scriptsSearched },
    };
  }

  let output = matchLines.map((m) => `${m.scriptName} [${m.scriptGuid}]:${m.lineNum}:${m.text}`).join("\n");
  if (totalMatches > MAX_MATCHES) {
    output += `\n\n... (${totalMatches - MAX_MATCHES} more matches not shown)`;
  }

  return {
    output,
    render: buildScriptGrepRender(pattern, totalMatches, scriptsSearched),
    metadata: { method: "script.grep", matchCount: totalMatches, scriptsSearched },
  };
}

export function createScriptGrepTool(cwd: string): Tool {
  return {
    name: toToolName(scriptGrep.method),
    description: scriptGrep.description,
    parameters: scriptGrep.params,
    async execute(args) {
      return executeScriptGrep(args, cwd);
    },
  };
}
