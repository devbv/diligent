// @summary Greps script sources from a subtree fetched with a single instance.read.

import type * as scriptGrep from "../../methods/script.grep";
import { buildScriptGrepRender } from "../../render";
import type { ToolResult } from "../../types";
import type { OvdrjmNode } from "../ovdrjm-utils";
import { countScripts, grepSubtree, MAX_MATCHES, type MatchLine } from "../script-grep-tool";
import { DEPTH_SUBTREE, readInstanceNode, readLevelRoot } from "./client";

type ScriptGrepArgs = ReturnType<typeof scriptGrep.params.parse>;

export async function grepScriptsViaRpc(parsed: ScriptGrepArgs): Promise<ToolResult> {
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
    const target = parentGuid ? await readInstanceNode(parentGuid, DEPTH_SUBTREE) : await readLevelRoot();
    if (!target) {
      return { output: `Error: ActorGuid not found: ${parentGuid}`, metadata: { error: true } };
    }
    startNode = target;
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
