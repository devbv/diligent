// @summary Zod schemas for structured tool result render blocks (P040)
import { z } from "zod";

export const RenderToneSchema = z.enum(["default", "success", "warning", "danger", "info", "muted"]);
export type RenderTone = z.infer<typeof RenderToneSchema>;

export const SummaryBlockSchema = z.object({
  type: z.literal("summary"),
  text: z.string(),
  tone: RenderToneSchema.optional(),
});
export type SummaryBlock = z.infer<typeof SummaryBlockSchema>;

export const ToolRenderTextBlockSchema = z.object({
  type: z.literal("text"),
  title: z.string().optional(),
  text: z.string(),
  isError: z.boolean().optional(),
});
export type ToolRenderTextBlock = z.infer<typeof ToolRenderTextBlockSchema>;

export const KeyValueBlockSchema = z.object({
  type: z.literal("key_value"),
  title: z.string().optional(),
  items: z.array(z.object({ key: z.string(), value: z.string() })),
});
export type KeyValueBlock = z.infer<typeof KeyValueBlockSchema>;

export const ListBlockSchema = z.object({
  type: z.literal("list"),
  title: z.string().optional(),
  ordered: z.boolean().optional(),
  items: z.array(z.string()),
});
export type ListBlock = z.infer<typeof ListBlockSchema>;

export const TableBlockSchema = z.object({
  type: z.literal("table"),
  title: z.string().optional(),
  columns: z.array(z.string()),
  rows: z.array(z.array(z.string())),
});
export type TableBlock = z.infer<typeof TableBlockSchema>;

export const AssetGalleryItemSchema = z.object({
  id: z.string().optional(),
  title: z.string(),
  subtitle: z.string().optional(),
  price: z.string().optional(),
  thumbnailUrl: z.string().optional(),
  previewUrl: z.string().optional(),
  sourceUrl: z.string().optional(),
  insertValue: z.string().optional(),
  metadata: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
});
export type AssetGalleryItem = z.infer<typeof AssetGalleryItemSchema>;

export const AssetGalleryBlockSchema = z.object({
  type: z.literal("asset_gallery"),
  title: z.string().optional(),
  query: z.string().optional(),
  actionLabel: z.string().optional(),
  items: z.array(AssetGalleryItemSchema),
});
export type AssetGalleryBlock = z.infer<typeof AssetGalleryBlockSchema>;

// TreeNode uses lazy recursion to allow nested children
const TreeNodeSchema: z.ZodType<{ label: string; children?: { label: string; children?: unknown[] }[] }> = z.lazy(() =>
  z.object({
    label: z.string(),
    children: z.array(TreeNodeSchema).optional(),
  }),
);
export type TreeNode = { label: string; children?: TreeNode[] };

export const TreeBlockSchema = z.object({
  type: z.literal("tree"),
  title: z.string().optional(),
  nodes: z.array(TreeNodeSchema),
});
export type TreeBlock = z.infer<typeof TreeBlockSchema>;

export const StatusBadgesBlockSchema = z.object({
  type: z.literal("status_badges"),
  title: z.string().optional(),
  items: z.array(z.object({ label: z.string(), tone: RenderToneSchema.optional() })),
});
export type StatusBadgesBlock = z.infer<typeof StatusBadgesBlockSchema>;

export const FileBlockSchema = z.object({
  type: z.literal("file"),
  filePath: z.string(),
  content: z.string().optional(),
  offset: z.number().int().optional(),
  limit: z.number().int().optional(),
  isError: z.boolean().optional(),
});
export type FileBlock = z.infer<typeof FileBlockSchema>;

export const CommandBlockSchema = z.object({
  type: z.literal("command"),
  command: z.string(),
  output: z.string().optional(),
  isError: z.boolean().optional(),
});
export type CommandBlock = z.infer<typeof CommandBlockSchema>;

export const DiffHunkSchema = z.object({
  oldString: z.string().optional(),
  newString: z.string().optional(),
});
export type DiffHunk = z.infer<typeof DiffHunkSchema>;

export const DiffFileSchema = z.object({
  filePath: z.string(),
  action: z.enum(["Add", "Update", "Delete", "Move"]).optional(),
  movedTo: z.string().optional(),
  hunks: z.array(DiffHunkSchema),
});
export type DiffFile = z.infer<typeof DiffFileSchema>;

export const DiffBlockSchema = z.object({
  type: z.literal("diff"),
  files: z.array(DiffFileSchema),
  output: z.string().optional(),
  isError: z.boolean().optional(),
});
export type DiffBlock = z.infer<typeof DiffBlockSchema>;

export const ToolRenderBlockSchema = z.discriminatedUnion("type", [
  SummaryBlockSchema,
  ToolRenderTextBlockSchema,
  KeyValueBlockSchema,
  ListBlockSchema,
  TableBlockSchema,
  AssetGalleryBlockSchema,
  TreeBlockSchema,
  StatusBadgesBlockSchema,
  FileBlockSchema,
  CommandBlockSchema,
  DiffBlockSchema,
]);
export type ToolRenderBlock = z.infer<typeof ToolRenderBlockSchema>;

export const ToolRenderPayloadSchema = z.object({
  inputSummary: z.string().optional(),
  outputSummary: z.string().optional(),
  blocks: z.array(ToolRenderBlockSchema),
});
export type ToolRenderPayload = z.infer<typeof ToolRenderPayloadSchema>;
