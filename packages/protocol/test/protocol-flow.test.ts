// @summary Tests for codex-like Diligent protocol flow schemas (thread/turn/item + callbacks)
import { describe, expect, it } from "bun:test";
import {
  DILIGENT_CLIENT_REQUEST_METHODS,
  DILIGENT_SERVER_NOTIFICATION_METHODS,
  DILIGENT_SERVER_REQUEST_METHODS,
  DiligentClientRequestSchema,
  DiligentClientResponseSchema,
  DiligentServerNotificationSchema,
  DiligentServerRequestResponseSchema,
  DiligentServerRequestSchema,
  InitializeResponseSchema,
  MessageSchema,
  PluginDescriptorSchema,
  SkillDescriptorSchema,
  SkillsListResponseSchema,
  SubagentDescriptorSchema,
  SubagentsListResponseSchema,
  ThreadItemSchema,
  ToolDescriptorSchema,
  ToolRenderPayloadSchema,
  ToolResultMessageSchema,
  ToolsListResponseSchema,
} from "../src";

const TEST_MODEL_ID = "claude-sonnet-5";

describe("protocol/flow", () => {
  it("accepts structured context notices for live events and thread snapshots", () => {
    const presentation = {
      kind: "human-edits",
      title: "Human edits detected",
      content: "Added: Ramp",
    };
    expect(
      DiligentServerNotificationSchema.safeParse({
        method: DILIGENT_SERVER_NOTIFICATION_METHODS.AGENT_EVENT,
        params: {
          threadId: "th-1",
          turnId: "turn-1",
          event: { type: "context_notice", source: "studiorpc-human-edits", presentation },
        },
      }).success,
    ).toBe(true);
    expect(
      ThreadItemSchema.safeParse({
        type: "contextMessage",
        itemId: "ctx-1",
        source: "studiorpc-human-edits",
        presentation,
        timestamp: 1,
      }).success,
    ).toBe(true);
  });

  it("accepts thread and turn client requests", () => {
    expect(
      DiligentClientRequestSchema.safeParse({
        method: DILIGENT_CLIENT_REQUEST_METHODS.THREAD_START,
        params: { cwd: "/tmp/work", effort: "high" },
      }).success,
    ).toBe(true);

    expect(
      DiligentClientRequestSchema.safeParse({
        method: DILIGENT_CLIENT_REQUEST_METHODS.EFFORT_SET,
        params: { threadId: "th-1", effort: "xhigh" },
      }).success,
    ).toBe(true);

    expect(
      DiligentClientRequestSchema.safeParse({
        method: DILIGENT_CLIENT_REQUEST_METHODS.EFFORT_SET,
        params: { threadId: "th-1", effort: "none" },
      }).success,
    ).toBe(false);

    expect(
      DiligentClientResponseSchema.safeParse({
        method: DILIGENT_CLIENT_REQUEST_METHODS.EFFORT_SET,
        result: { effort: "xhigh" },
      }).success,
    ).toBe(true);

    expect(
      DiligentClientRequestSchema.safeParse({
        method: DILIGENT_CLIENT_REQUEST_METHODS.TURN_START,
        params: { threadId: "th-1", message: "hello" },
      }).success,
    ).toBe(true);

    expect(
      DiligentClientRequestSchema.safeParse({
        method: DILIGENT_CLIENT_REQUEST_METHODS.TURN_START,
        params: {
          threadId: "th-1",
          message: "",
          attachments: [
            {
              type: "local_image",
              path: "/tmp/shot.png",
              mediaType: "image/png",
              fileName: "shot.png",
            },
          ],
          content: [{ type: "local_image", path: "/tmp/shot.png", mediaType: "image/png", fileName: "shot.png" }],
        },
      }).success,
    ).toBe(true);

    expect(
      DiligentClientRequestSchema.safeParse({
        method: DILIGENT_CLIENT_REQUEST_METHODS.TURN_STEER,
        params: {
          threadId: "th-1",
          content: "use this image",
          attachments: [
            {
              type: "local_image",
              path: "/tmp/shot.png",
              mediaType: "image/png",
              fileName: "shot.png",
            },
          ],
          followUp: false,
        },
      }).success,
    ).toBe(true);
  });

  it("accepts initialize response bootstrap metadata for raw web transport", () => {
    expect(
      InitializeResponseSchema.safeParse({
        serverName: "diligent-app-server",
        serverVersion: "0.0.1",
        protocolVersion: 1,
        capabilities: {
          supportsFollowUp: true,
          supportsApprovals: true,
          supportsUserInput: true,
        },
        cwd: "/repo",
        mode: "default",
        effort: "medium",
        currentModel: { provider: "anthropic", modelId: TEST_MODEL_ID },
        availableModels: [],
      }).success,
    ).toBe(true);
  });

  it("accepts thread read response with restored current mode", () => {
    expect(
      DiligentClientResponseSchema.safeParse({
        method: DILIGENT_CLIENT_REQUEST_METHODS.THREAD_READ,
        result: {
          cwd: "/repo",
          items: [],
          hasFollowUp: false,
          entryCount: 1,
          isRunning: false,
          currentMode: "plan",
          currentEffort: "medium",
          currentModel: { provider: "anthropic", modelId: TEST_MODEL_ID },
        },
      }).success,
    ).toBe(true);
  });

  it("accepts web image upload responses with canonical webUrl", () => {
    expect(
      DiligentClientResponseSchema.safeParse({
        method: DILIGENT_CLIENT_REQUEST_METHODS.IMAGE_UPLOAD,
        result: {
          attachment: {
            type: "local_image",
            path: "/repo/.diligent/images/thread-1/shot.png",
            mediaType: "image/png",
            fileName: "shot.png",
            webUrl: "/_diligent/image/thread-1/shot.png",
          },
        },
      }).success,
    ).toBe(true);
  });

  it("accepts normalized provider-native web tool transcript blocks", () => {
    expect(
      MessageSchema.safeParse({
        role: "assistant",
        model: { provider: "openai", modelId: "gpt-5" },
        usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "end_turn",
        timestamp: 1,
        content: [
          {
            type: "provider_tool_use",
            id: "toolu_1",
            provider: "openai",
            name: "web_search",
            input: { query: "diligent" },
          },
          {
            type: "web_search_result",
            toolUseId: "toolu_1",
            provider: "openai",
            results: [
              {
                url: "https://example.com",
                title: "Example",
                snippet: "Example snippet",
              },
            ],
          },
          {
            type: "text",
            text: "Found it.",
            citations: [
              {
                type: "web_search_result_location",
                url: "https://example.com",
                title: "Example",
                citedText: "Example snippet",
              },
            ],
          },
          {
            type: "web_fetch_result",
            toolUseId: "toolu_2",
            provider: "anthropic",
            url: "https://example.com/doc",
            document: {
              mimeType: "text/html",
              text: "Hello",
              title: "Doc",
              citationsEnabled: true,
            },
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("accepts tools/list and tools/set request/response payloads", () => {
    expect(
      DiligentClientRequestSchema.safeParse({
        method: DILIGENT_CLIENT_REQUEST_METHODS.TOOLS_LIST,
        params: { threadId: "th-1" },
      }).success,
    ).toBe(true);

    expect(
      DiligentClientRequestSchema.safeParse({
        method: DILIGENT_CLIENT_REQUEST_METHODS.TOOLS_SET,
        params: {
          threadId: "th-1",
          builtin: { bash: false, read: true },
          plugins: [
            { package: "@acme/diligent-tools", enabled: true, tools: { jira_comment: false } },
            { package: "@acme/old-tools", remove: true },
          ],
          conflictPolicy: "plugin_wins",
        },
      }).success,
    ).toBe(true);

    const tool = ToolDescriptorSchema.safeParse({
      name: "plan",
      source: "builtin",
      enabled: true,
      immutable: true,
      configurable: false,
      available: true,
      reason: "immutable_forced_on",
    });
    expect(tool.success).toBe(true);

    const plugin = PluginDescriptorSchema.safeParse({
      package: "@acme/diligent-tools",
      configured: true,
      enabled: true,
      loaded: true,
      toolCount: 2,
      warnings: ["duplicate tool name ignored"],
    });
    expect(plugin.success).toBe(true);

    expect(
      ToolsListResponseSchema.safeParse({
        configPath: "/repo/.diligent/config.jsonc",
        appliesOnNextTurn: true,
        trustMode: "full_trust",
        conflictPolicy: "error",
        tools: [
          {
            name: "plan",
            source: "builtin",
            enabled: true,
            immutable: true,
            configurable: false,
            available: true,
            reason: "enabled",
          },
          {
            name: "jira_comment",
            source: "plugin",
            pluginPackage: "@acme/diligent-tools",
            enabled: false,
            immutable: false,
            configurable: true,
            available: true,
            reason: "disabled_by_user",
          },
        ],
        plugins: [
          {
            package: "@acme/diligent-tools",
            configured: true,
            enabled: true,
            loaded: true,
            toolCount: 1,
            warnings: [],
          },
        ],
      }).success,
    ).toBe(true);

    expect(
      DiligentClientResponseSchema.safeParse({
        method: DILIGENT_CLIENT_REQUEST_METHODS.TOOLS_SET,
        result: {
          configPath: "/repo/.diligent/config.jsonc",
          appliesOnNextTurn: true,
          trustMode: "full_trust",
          conflictPolicy: "builtin_wins",
          tools: [],
          plugins: [],
        },
      }).success,
    ).toBe(true);
  });

  it("accepts skills/list and skills/set request/response payloads", () => {
    expect(
      DiligentClientRequestSchema.safeParse({
        method: DILIGENT_CLIENT_REQUEST_METHODS.SKILLS_LIST,
        params: { threadId: "th-1" },
      }).success,
    ).toBe(true);

    expect(
      DiligentClientRequestSchema.safeParse({
        method: DILIGENT_CLIENT_REQUEST_METHODS.SKILLS_SET,
        params: { threadId: "th-1", overrides: { "tech-lead": false, "write-plan": true } },
      }).success,
    ).toBe(true);

    expect(
      SkillDescriptorSchema.safeParse({
        name: "tech-lead",
        description: "Review architecture",
        source: "project",
        globalEnabled: false,
        effectiveEnabled: false,
        available: false,
        controlledBy: "global",
        reason: "disabled_by_user",
      }).success,
    ).toBe(true);

    const response = {
      configPath: "/home/me/.diligent/config.jsonc",
      appliesOnNextTurn: true,
      skillsEnabled: true,
      skillsEnabledControlledBy: "default",
      skills: [
        {
          name: "write-plan",
          description: "Create implementation plans",
          source: "global",
          globalEnabled: true,
          effectiveEnabled: true,
          available: true,
          controlledBy: "default",
          reason: "enabled",
        },
      ],
    };

    expect(SkillsListResponseSchema.safeParse(response).success).toBe(true);
    expect(
      DiligentClientResponseSchema.safeParse({
        method: DILIGENT_CLIENT_REQUEST_METHODS.SKILLS_SET,
        result: response,
      }).success,
    ).toBe(true);
  });

  it("accepts subagents/list and subagents/set request/response payloads", () => {
    expect(
      DiligentClientRequestSchema.safeParse({
        method: DILIGENT_CLIENT_REQUEST_METHODS.SUBAGENTS_SET,
        params: { threadId: "th-1", overrides: { explore: false } },
      }).success,
    ).toBe(true);
    const descriptor = {
      name: "general",
      description: "Execution agent",
      source: "builtin",
      required: true,
      globalEnabled: true,
      effectiveEnabled: true,
      available: true,
      controlledBy: "required",
      reason: "required_builtin",
    };
    expect(SubagentDescriptorSchema.safeParse(descriptor).success).toBe(true);
    const response = {
      configPath: "/home/me/.diligent/config.jsonc",
      appliesOnNextTurn: true,
      subagents: [descriptor],
    };
    expect(SubagentsListResponseSchema.safeParse(response).success).toBe(true);
    expect(
      DiligentClientResponseSchema.safeParse({
        method: DILIGENT_CLIENT_REQUEST_METHODS.SUBAGENTS_LIST,
        result: response,
      }).success,
    ).toBe(true);
  });

  it("accepts knowledge update (upsert/delete) request and response payloads", () => {
    expect(
      DiligentClientRequestSchema.safeParse({
        method: DILIGENT_CLIENT_REQUEST_METHODS.KNOWLEDGE_UPDATE,
        params: {
          action: "upsert",
          threadId: "th-1",
          type: "backlog",
          content: "Use feature flag X for rollout",
          tags: ["rollout", "flag"],
        },
      }).success,
    ).toBe(true);

    expect(
      DiligentClientRequestSchema.safeParse({
        method: DILIGENT_CLIENT_REQUEST_METHODS.KNOWLEDGE_UPDATE,
        params: {
          action: "upsert",
          threadId: "th-1",
          id: "k-1",
          type: "correction",
          content: "Feature flag X defaults to false",
          tags: ["correction"],
        },
      }).success,
    ).toBe(true);

    expect(
      DiligentClientRequestSchema.safeParse({
        method: DILIGENT_CLIENT_REQUEST_METHODS.KNOWLEDGE_UPDATE,
        params: {
          action: "delete",
          threadId: "th-1",
          id: "k-1",
        },
      }).success,
    ).toBe(true);

    expect(
      DiligentClientResponseSchema.safeParse({
        method: DILIGENT_CLIENT_REQUEST_METHODS.KNOWLEDGE_UPDATE,
        result: {
          entry: {
            id: "k-1",
            timestamp: new Date().toISOString(),
            type: "pattern",
            content: "Always run focused tests first",
            confidence: 0.8,
          },
        },
      }).success,
    ).toBe(true);

    expect(
      DiligentClientResponseSchema.safeParse({
        method: DILIGENT_CLIENT_REQUEST_METHODS.KNOWLEDGE_UPDATE,
        result: { deleted: true },
      }).success,
    ).toBe(true);
  });

  it("rejects malformed tool protocol payloads", () => {
    expect(
      DiligentClientRequestSchema.safeParse({
        method: DILIGENT_CLIENT_REQUEST_METHODS.TOOLS_SET,
        params: {
          builtin: { bash: "nope" },
        },
      }).success,
    ).toBe(false);

    expect(
      ToolsListResponseSchema.safeParse({
        configPath: "/repo/.diligent/config.jsonc",
        appliesOnNextTurn: true,
        trustMode: "full_trust",
        conflictPolicy: "error",
        tools: [
          {
            name: "bad_tool",
            source: "plugin",
            enabled: true,
            immutable: false,
            configurable: true,
            available: true,
            reason: "not_a_real_reason",
          },
        ],
        plugins: [],
      }).success,
    ).toBe(false);
  });

  it("accepts server/request/resolved notification", () => {
    const resolved = DiligentServerNotificationSchema.safeParse({
      method: DILIGENT_SERVER_NOTIFICATION_METHODS.SERVER_REQUEST_RESOLVED,
      params: { requestId: 42 },
    });
    expect(resolved.success).toBe(true);
  });

  it("accepts codex-like item lifecycle notifications", () => {
    const itemStarted = DiligentServerNotificationSchema.safeParse({
      method: DILIGENT_SERVER_NOTIFICATION_METHODS.ITEM_STARTED,
      params: {
        threadId: "th-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          itemId: "item-1",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "hi" }],
            model: { provider: "anthropic", modelId: TEST_MODEL_ID },
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
            stopReason: "end_turn",
            timestamp: Date.now(),
          },
        },
      },
    });
    expect(itemStarted.success).toBe(true);

    const itemDelta = DiligentServerNotificationSchema.safeParse({
      method: DILIGENT_SERVER_NOTIFICATION_METHODS.ITEM_DELTA,
      params: {
        threadId: "th-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: { type: "messageText", itemId: "item-1", delta: "more" },
      },
    });
    expect(itemDelta.success).toBe(true);

    const itemCompleted = DiligentServerNotificationSchema.safeParse({
      method: DILIGENT_SERVER_NOTIFICATION_METHODS.ITEM_COMPLETED,
      params: {
        threadId: "th-1",
        turnId: "turn-1",
        item: {
          type: "toolCall",
          itemId: "item-2",
          toolCallId: "tc-1",
          toolName: "bash",
          input: { cmd: "pwd" },
          output: "/tmp/work",
          isError: false,
        },
      },
    });
    expect(itemCompleted.success).toBe(true);
  });

  it("accepts approval and user-input server callback requests", () => {
    const approvalReq = DiligentServerRequestSchema.safeParse({
      method: DILIGENT_SERVER_REQUEST_METHODS.APPROVAL_REQUEST,
      params: {
        threadId: "th-1",
        request: {
          permission: "write",
          toolName: "write_file",
          description: "write src/index.ts",
        },
      },
    });
    expect(approvalReq.success).toBe(true);

    const approvalRes = DiligentServerRequestResponseSchema.safeParse({
      method: DILIGENT_SERVER_REQUEST_METHODS.APPROVAL_REQUEST,
      result: { decision: "once" },
    });
    expect(approvalRes.success).toBe(true);

    const userInputReq = DiligentServerRequestSchema.safeParse({
      method: DILIGENT_SERVER_REQUEST_METHODS.USER_INPUT_REQUEST,
      params: {
        threadId: "th-1",
        request: {
          questions: [
            {
              id: "q1",
              header: "Need path",
              question: "file path?",
              options: [{ label: "Current", description: "Use current directory" }],
              allow_multiple: true,
            },
          ],
        },
      },
    });
    expect(userInputReq.success).toBe(true);

    const userInputRes = DiligentServerRequestResponseSchema.safeParse({
      method: DILIGENT_SERVER_REQUEST_METHODS.USER_INPUT_REQUEST,
      result: { answers: { q1: ["Current", "Custom path"] } },
    });
    expect(userInputRes.success).toBe(true);
  });

  it("accepts and validates ToolRenderPayload with all block kinds", () => {
    const payload = ToolRenderPayloadSchema.safeParse({
      inputSummary: "Inspect files",
      outputSummary: "Done",
      blocks: [
        { type: "summary", text: "Done", tone: "success" },
        { type: "text", title: "Input", text: "files" },
        { type: "key_value", title: "Info", items: [{ key: "Count", value: "42" }] },
        { type: "list", title: "Files", ordered: false, items: ["a.ts", "b.ts"] },
        { type: "table", title: "Results", columns: ["Name", "Status"], rows: [["foo", "ok"]] },
        {
          type: "asset_gallery",
          title: "OVERDARE Assets",
          query: "fountain classic stone",
          items: [
            {
              id: "asset-1",
              title: "Classic Stone Fountain",
              subtitle: "MODEL",
              price: "Free",
              thumbnailUrl: "https://assets.example/fountain.png",
              previewUrl: "https://assets.example/fountain",
              metadata: [{ key: "assetType", value: "MODEL" }],
            },
          ],
        },
        { type: "tree", nodes: [{ label: "root", children: [{ label: "child" }] }] },
        { type: "status_badges", items: [{ label: "passing", tone: "success" }, { label: "skipped" }] },
      ],
    });
    expect(payload.success).toBe(true);
  });

  it("rejects ToolRenderPayload with unknown block type (discriminated union)", () => {
    const bad = ToolRenderPayloadSchema.safeParse({
      blocks: [{ type: "chart", data: [] }],
    });
    expect(bad.success).toBe(false);
  });

  it("accepts ToolResultMessage", () => {
    const msg = ToolResultMessageSchema.safeParse({
      role: "tool_result",
      toolCallId: "tc-1",
      toolName: "bash",
      output: "hello",
      isError: false,
      timestamp: 1000,
      render: {
        inputSummary: "echo hello",
        outputSummary: "hello",
        blocks: [{ type: "text", title: "Output", text: "hello" }],
      },
    });
    expect(msg.success).toBe(true);
  });

  it("accepts mcp/list, mcp/login/start, and mcp/logout request + response payloads", () => {
    expect(
      DiligentClientRequestSchema.safeParse({
        method: DILIGENT_CLIENT_REQUEST_METHODS.MCP_LIST,
        params: { threadId: "th-1" },
      }).success,
    ).toBe(true);
    expect(
      DiligentClientResponseSchema.safeParse({
        method: DILIGENT_CLIENT_REQUEST_METHODS.MCP_LIST,
        result: {
          servers: [
            { name: "github", transport: "stdio", status: "connected", toolCount: 12 },
            { name: "linear", transport: "http", status: "needs_auth", toolCount: 0 },
            { name: "notion", transport: "http", status: "error", toolCount: 0, error: "connect timeout" },
          ],
        },
      }).success,
    ).toBe(true);

    expect(
      DiligentClientRequestSchema.safeParse({
        method: DILIGENT_CLIENT_REQUEST_METHODS.MCP_LOGIN_START,
        params: { server: "linear" },
      }).success,
    ).toBe(true);
    expect(
      DiligentClientResponseSchema.safeParse({
        method: DILIGENT_CLIENT_REQUEST_METHODS.MCP_LOGIN_START,
        result: { authUrl: "https://example.com/oauth/authorize?x=1" },
      }).success,
    ).toBe(true);

    expect(
      DiligentClientResponseSchema.safeParse({
        method: DILIGENT_CLIENT_REQUEST_METHODS.MCP_LOGOUT,
        result: { ok: true },
      }).success,
    ).toBe(true);
  });

  it("accepts config/reload request + response payloads", () => {
    expect(
      DiligentClientRequestSchema.safeParse({
        method: DILIGENT_CLIENT_REQUEST_METHODS.CONFIG_RELOAD,
        params: {},
      }).success,
    ).toBe(true);
    expect(
      DiligentClientResponseSchema.safeParse({
        method: DILIGENT_CLIENT_REQUEST_METHODS.CONFIG_RELOAD,
        result: { skills: [{ name: "write-plan", description: "Create implementation plans" }] },
      }).success,
    ).toBe(true);
  });

  it("accepts the mcp/login/completed server notification", () => {
    expect(
      DiligentServerNotificationSchema.safeParse({
        method: DILIGENT_SERVER_NOTIFICATION_METHODS.MCP_LOGIN_COMPLETED,
        params: { server: "linear", success: true, toolCount: 8, error: null },
      }).success,
    ).toBe(true);
    expect(
      DiligentServerNotificationSchema.safeParse({
        method: DILIGENT_SERVER_NOTIFICATION_METHODS.MCP_LOGIN_COMPLETED,
        params: { server: "linear", success: false, error: "timed out" },
      }).success,
    ).toBe(true);
  });

  it("accepts old and presentation-aware error notifications", () => {
    const legacy = DiligentServerNotificationSchema.safeParse({
      method: DILIGENT_SERVER_NOTIFICATION_METHODS.ERROR,
      params: {
        threadId: "th-1",
        error: { message: "legacy failure", name: "Error" },
        fatal: false,
      },
    });
    const presented = DiligentServerNotificationSchema.safeParse({
      method: DILIGENT_SERVER_NOTIFICATION_METHODS.ERROR,
      params: {
        threadId: "th-1",
        error: {
          message: "Invalid API key",
          name: "ProviderError",
          code: "invalid_api_key",
          providerErrorType: "auth",
          providerErrorReason: "credentials_rejected",
          presentation: {
            message: "The provider rejected the saved credentials. Reconnect to continue.",
            recovery: { kind: "configure_provider", provider: "openai" },
          },
        },
        fatal: false,
      },
    });

    expect(legacy.success).toBe(true);
    expect(presented.success).toBe(true);
  });

  it("rejects unknown recovery actions", () => {
    const result = DiligentServerNotificationSchema.safeParse({
      method: DILIGENT_SERVER_NOTIFICATION_METHODS.ERROR,
      params: {
        error: {
          message: "failure",
          name: "Error",
          presentation: { message: "failure", recovery: { kind: "reload_page" } },
        },
        fatal: false,
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects malformed flow payloads", () => {
    const bad = DiligentServerNotificationSchema.safeParse({
      method: DILIGENT_SERVER_NOTIFICATION_METHODS.ITEM_DELTA,
      params: {
        threadId: "th-1",
        turnId: "turn-1",
        // missing itemId
        delta: { type: "messageText", itemId: "item-1", delta: "x" },
      },
    });

    expect(bad.success).toBe(false);
  });
});
