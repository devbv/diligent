// @summary Anthropic request-level system section conversion
import type { SystemSection } from "../../types";

interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export function toAnthropicBlocks(sections: SystemSection[]): AnthropicTextBlock[] {
  return sections.map((section, index) => {
    const attrs = section.tagAttributes
      ? Object.entries(section.tagAttributes)
          .map(([key, value]) => ` ${key}="${value}"`)
          .join("")
      : "";
    const rendered = section.tag ? `<${section.tag}${attrs}>\n${section.content}\n</${section.tag}>` : section.content;
    const text = index < sections.length - 1 ? `${rendered}\n\n` : rendered;
    return {
      type: "text",
      text,
      ...(section.cacheControl === "ephemeral" ? { cache_control: { type: "ephemeral" as const } } : {}),
    };
  });
}
