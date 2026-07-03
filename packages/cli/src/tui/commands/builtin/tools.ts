// @summary Tool settings command for enabling/disabling built-ins and trusted plugin packages over RPC
import type { PluginDescriptor, ToolDescriptor, ToolsListResponse, ToolsSetParams } from "@diligent/protocol";
import { DILIGENT_CLIENT_REQUEST_METHODS } from "@diligent/protocol";
import type { ListPickerItem } from "../../components/list-picker";
import { t } from "../../theme";
import type { Command, CommandContext } from "../types";

interface ToolSettingsDraft {
  builtin: Record<string, boolean>;
  plugins: Array<{
    package: string;
    enabled: boolean;
    tools: Record<string, boolean>;
  }>;
  removedPackages: string[];
}

function createDraft(state: ToolsListResponse): ToolSettingsDraft {
  return {
    builtin: Object.fromEntries(
      state.tools
        .filter((tool) => tool.source === "builtin" && tool.configurable)
        .map((tool) => [tool.name, tool.enabled]),
    ),
    plugins: state.plugins.map((plugin) => ({
      package: plugin.package,
      enabled: plugin.enabled,
      tools: Object.fromEntries(
        state.tools
          .filter((tool) => tool.source === "plugin" && tool.pluginPackage === plugin.package)
          .map((tool) => [tool.name, tool.enabled]),
      ),
    })),
    removedPackages: [],
  };
}

function buildSetParams(threadId: string | null, draft: ToolSettingsDraft): ToolsSetParams {
  const params: ToolsSetParams = {};
  if (threadId) params.threadId = threadId;
  if (Object.keys(draft.builtin).length > 0) {
    params.builtin = draft.builtin;
  }
  const plugins = [
    ...draft.plugins.map((plugin) => ({ package: plugin.package, enabled: plugin.enabled, tools: plugin.tools })),
    ...draft.removedPackages.map((pkg) => ({ package: pkg, remove: true as const })),
  ];
  if (plugins.length > 0) {
    params.plugins = plugins;
  }
  return params;
}

function describeTool(tool: ToolDescriptor): string {
  const status = tool.enabled ? "on" : "off";
  const lock = tool.immutable ? " · locked" : "";
  const reason =
    tool.reason === "disabled_by_user"
      ? " · disabled in settings"
      : tool.reason === "plugin_disabled"
        ? " · package disabled"
        : tool.reason === "plugin_load_failed"
          ? " · load failed"
          : tool.reason === "conflict_dropped"
            ? " · conflict"
            : tool.reason === "invalid_plugin_tool"
              ? " · invalid"
              : "";
  return `${status}${lock}${reason}`;
}

function describePlugin(plugin: PluginDescriptor): string {
  if (plugin.loadError) {
    return `load failed · ${plugin.loadError}`;
  }
  if (plugin.warnings.length > 0) {
    return `warning · ${plugin.warnings[0]}`;
  }
  if (!plugin.loaded) {
    return plugin.enabled ? "configured · pending load" : "disabled";
  }
  return `${plugin.enabled ? "on" : "off"} · ${plugin.toolCount} tool${plugin.toolCount === 1 ? "" : "s"}`;
}

async function fetchTools(ctx: CommandContext): Promise<ToolsListResponse> {
  const rpc = ctx.app.getRpcClient?.();
  if (!rpc) {
    throw new Error("App server is not initialized.");
  }
  return rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.TOOLS_LIST, {
    threadId: ctx.threadId ?? undefined,
  });
}

async function saveTools(ctx: CommandContext, draft: ToolSettingsDraft): Promise<ToolsListResponse> {
  const rpc = ctx.app.getRpcClient?.();
  if (!rpc) {
    throw new Error("App server is not initialized.");
  }
  return rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.TOOLS_SET, buildSetParams(ctx.threadId, draft));
}

function showPicker(ctx: CommandContext, title: string, items: ListPickerItem[]): Promise<string | null> {
  return ctx.app.pick({ title, items, filterable: true });
}

function promptPackageName(ctx: CommandContext): Promise<string | null> {
  return ctx.app
    .prompt({
      title: "Add plugin package",
      message: "Enter an installed package name to load on the next refresh.",
      placeholder: "@acme/diligent-tools",
    })
    .then((value) => value?.trim() || null);
}

async function editBuiltins(ctx: CommandContext, state: ToolsListResponse, draft: ToolSettingsDraft): Promise<void> {
  while (true) {
    const builtinTools = state.tools.filter((tool) => tool.source === "builtin" && !tool.immutable);
    const items: ListPickerItem[] = [
      ...builtinTools.map((tool) => ({
        label: `${(draft.builtin[tool.name] ?? tool.enabled) ? "✓" : "✗"} ${tool.name}`,
        description: describeTool(tool),
        value: tool.name,
      })),
      { label: "Back", description: "Return to tool settings", value: "__back" },
    ];

    const choice = await showPicker(ctx, "Built-in tools", items);
    if (!choice || choice === "__back") return;

    const tool = builtinTools.find((entry) => entry.name === choice);
    if (!tool) continue;
    if (!tool.configurable) {
      ctx.displayLines([`  ${t.warn}${tool.name} is not configurable.${t.reset}`]);
      continue;
    }

    draft.builtin[tool.name] = !(draft.builtin[tool.name] ?? tool.enabled);
    const enabled = draft.builtin[tool.name];
    ctx.displayLines([`  ${tool.name}: ${enabled ? `${t.success}enabled` : `${t.warn}disabled`}${t.reset}`]);
  }
}

async function editPluginTools(
  ctx: CommandContext,
  pluginState: PluginDescriptor,
  pluginDraft: ToolSettingsDraft["plugins"][number],
  state: ToolsListResponse,
  draft: ToolSettingsDraft,
): Promise<void> {
  while (true) {
    const pluginTools = state.tools.filter(
      (tool) => tool.source === "plugin" && tool.pluginPackage === pluginState.package,
    );
    const items: ListPickerItem[] = [
      {
        label: `${pluginDraft.enabled ? "✓" : "✗"} Package enabled`,
        description: describePlugin(pluginState),
        value: "__toggle_package",
      },
      ...pluginTools.map((tool) => ({
        label: `${(pluginDraft.tools[tool.name] ?? tool.enabled) ? "✓" : "✗"} ${tool.name}`,
        description: describeTool(tool),
        value: tool.name,
      })),
      { label: "Remove package", description: "Delete this package from config", value: "__remove" },
      { label: "Back", description: "Return to tool settings", value: "__back" },
    ];

    const choice = await showPicker(ctx, pluginState.package, items);
    if (!choice || choice === "__back") return;

    if (choice === "__toggle_package") {
      pluginDraft.enabled = !pluginDraft.enabled;
      ctx.displayLines([
        `  ${pluginState.package}: ${pluginDraft.enabled ? `${t.success}enabled` : `${t.warn}disabled`}${t.reset}`,
      ]);
      continue;
    }

    if (choice === "__remove") {
      draftRemovePlugin(pluginState.package, pluginDraft, draft, ctx);
      return;
    }

    const tool = pluginTools.find((entry) => entry.name === choice);
    if (!tool) continue;
    if (!tool.configurable || !tool.available) {
      ctx.displayLines([`  ${t.warn}${tool.name} cannot be toggled until the package loads cleanly.${t.reset}`]);
      continue;
    }

    pluginDraft.tools[tool.name] = !(pluginDraft.tools[tool.name] ?? tool.enabled);
    ctx.displayLines([
      `  ${tool.name}: ${pluginDraft.tools[tool.name] ? `${t.success}enabled` : `${t.warn}disabled`}${t.reset}`,
    ]);
  }
}

function draftRemovePlugin(
  packageName: string,
  pluginDraft: ToolSettingsDraft["plugins"][number],
  draft: ToolSettingsDraft,
  ctx: CommandContext,
): void {
  draft.plugins = draft.plugins.filter((plugin) => plugin !== pluginDraft && plugin.package !== packageName);
  if (!draft.removedPackages.includes(packageName)) {
    draft.removedPackages.push(packageName);
  }
  ctx.displayLines([`  Removed ${t.bold}${packageName}${t.reset} from tool settings.`]);
}

async function editPlugins(ctx: CommandContext, state: ToolsListResponse, draft: ToolSettingsDraft): Promise<void> {
  while (true) {
    const knownPackages = new Set<string>();
    const items: ListPickerItem[] = [
      ...state.plugins.map((plugin) => {
        knownPackages.add(plugin.package);
        return {
          label: plugin.package,
          description: describePlugin(plugin),
          value: plugin.package,
        };
      }),
      ...draft.plugins
        .filter((plugin) => !knownPackages.has(plugin.package))
        .map((plugin) => ({
          label: plugin.package,
          description: `${plugin.enabled ? "enabled" : "disabled"} · pending save`,
          value: plugin.package,
        })),
      { label: "Add package", description: "Configure another installed plugin package", value: "__add" },
      { label: "Back", description: "Return to tool settings", value: "__back" },
    ];

    const choice = await showPicker(ctx, "Plugin packages", items);
    if (!choice || choice === "__back") return;

    if (choice === "__add") {
      const pkg = await promptPackageName(ctx);
      if (!pkg) continue;
      if (
        draft.plugins.some((plugin) => plugin.package === pkg) ||
        state.plugins.some((plugin) => plugin.package === pkg)
      ) {
        ctx.displayError(`Package already configured: ${pkg}`);
        continue;
      }
      draft.plugins.push({ package: pkg, enabled: true, tools: {} });
      draft.removedPackages = draft.removedPackages.filter((entry) => entry !== pkg);
      ctx.displayLines([`  Added ${t.bold}${pkg}${t.reset}. Save to load it on the next refresh.`]);
      continue;
    }

    const pluginState = state.plugins.find((plugin) => plugin.package === choice);
    if (!pluginState) {
      const pendingDraft = draft.plugins.find((plugin) => plugin.package === choice);
      if (pendingDraft) {
        pendingDraft.enabled = !pendingDraft.enabled;
        ctx.displayLines([
          `  ${choice}: ${pendingDraft.enabled ? `${t.success}enabled` : `${t.warn}disabled`}${t.reset}`,
        ]);
      }
      continue;
    }

    const pluginDraft = draft.plugins.find((plugin) => plugin.package === pluginState.package);
    if (!pluginDraft) continue;
    await editPluginTools(ctx, pluginState, pluginDraft, state, draft);
  }
}

export const toolsCommand: Command = {
  name: "tools",
  description: "Manage built-in tools and trusted plugin packages",
  supportsArgs: false,
  handler: async (_args, ctx) => {
    let state = await fetchTools(ctx);
    let draft = createDraft(state);

    while (true) {
      const items: ListPickerItem[] = [
        {
          label: "Built-in tools",
          description: `${state.tools.filter((tool) => tool.source === "builtin" && !tool.immutable).length} entries`,
          value: "__builtins",
        },
        {
          label: "Plugin packages",
          description: `${Math.max(state.plugins.length, draft.plugins.length)} configured`,
          value: "__plugins",
        },
        { label: "Save", description: "Persist to .diligent/config.jsonc", value: "__save" },
        { label: "Close", description: "Exit without saving more changes", value: "__close" },
      ];

      const choice = await showPicker(ctx, "Tool settings", items);
      if (!choice || choice === "__close") {
        return;
      }
      if (choice === "__builtins") {
        await editBuiltins(ctx, state, draft);
        continue;
      }
      if (choice === "__plugins") {
        await editPlugins(ctx, state, draft);
        continue;
      }
      if (choice === "__save") {
        const confirmed = await ctx.app.confirm({
          title: "Apply config changes?",
          message: "Tool and auto progress changes apply after /reload or when you open a new session.",
          confirmLabel: "Save",
          cancelLabel: "Cancel",
        });
        if (!confirmed) {
          continue;
        }
        state = await saveTools(ctx, draft);
        draft = createDraft(state);
        ctx.displayLines([
          `  ${t.success}Saved tool settings.${t.reset}`,
          `  ${t.dim}${state.configPath}${t.reset}`,
          `  ${t.dim}Run /reload or open a new session to apply these changes.${t.reset}`,
        ]);
      }
    }
  },
};

export { buildSetParams, createDraft };
export type { ToolSettingsDraft };
