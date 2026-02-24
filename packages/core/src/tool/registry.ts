import type { z } from "zod";
import type { Tool, ToolRegistry } from "./types";

export class ToolRegistryBuilder {
  private tools: Map<string, Tool> = new Map();

  register<T extends z.ZodType>(tool: Tool<T>): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate tool name: ${tool.name}`);
    }
    this.tools.set(tool.name, tool as unknown as Tool);
    return this;
  }

  build(): ToolRegistry {
    return new Map(this.tools);
  }
}
