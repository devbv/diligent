type RenderBlock = Record<string, unknown>;

type ToolRenderPayload = {
  inputSummary?: string;
  outputSummary?: string;
  blocks: RenderBlock[];
};

function clip(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

export function buildValidateLuaRender(filePath: string, output: string): ToolRenderPayload {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (output.includes("No issues found. Code is valid.")) {
    return {
      inputSummary: clip(filePath),
      outputSummary: "0 issues",
      blocks: [
        {
          type: "key_value",
          title: "Luau validation",
          items: [
            { key: "path", value: filePath },
            { key: "issues", value: "0" },
          ],
        },
        { type: "summary", text: "No issues found. Code is valid.", tone: "success" },
      ],
    };
  }

  const statusItems = lines.filter((line) => line.startsWith("[OK]") || /^\[\d+ issue\(s\)\]/.test(line)).slice(0, 20);
  const issueMatch = output.match(/---\s+\d+ file\(s\) checked,\s+(\d+) issue\(s\) found\s+---/);
  const issueCount = issueMatch?.[1] ?? String(lines.length);
  return {
    inputSummary: clip(filePath),
    outputSummary: `${issueCount} issue${issueCount === "1" ? "" : "s"}`,
    blocks: [
      {
        type: "key_value",
        title: "Luau validation",
        items: [
          { key: "path", value: filePath },
          { key: "lines", value: String(lines.length) },
        ],
      },
      ...(statusItems.length > 0 ? [{ type: "list" as const, title: "Files", items: statusItems }] : []),
      { type: "file", filePath, content: output, isError: true },
    ],
  };
}
