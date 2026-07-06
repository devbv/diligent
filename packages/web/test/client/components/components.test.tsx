// @summary Static render tests for core UI components and accessibility attributes

import { expect, test } from "bun:test";
import { DEFAULT_ANTHROPIC_MODEL_ID } from "@diligent/core/llm/models";
import { renderToStaticMarkup } from "react-dom/server";
import { AppHeader } from "../../../src/client/components/AppHeader";
import { AssetThumbnail } from "../../../src/client/components/AssetThumbnail";
import { AssistantMessage } from "../../../src/client/components/AssistantMessage";
import { Button } from "../../../src/client/components/Button";
import {
  CollabEventBlock,
  deriveChildPreview,
  getCollabEventPersistenceKey,
  resolveEffectiveTimeline,
} from "../../../src/client/components/CollabEventBlock";
import { CollabGroup } from "../../../src/client/components/CollabGroup";
import { ContextMessage } from "../../../src/client/components/ContextMessage";
import { EmptyState } from "../../../src/client/components/EmptyState";
import { ErrorBanner } from "../../../src/client/components/ErrorBanner";
import { Input } from "../../../src/client/components/Input";
import {
  extractPastedImageFiles,
  getModeBadgeClasses,
  getModeBadgeLabel,
  getModeLabel,
  InputDock,
} from "../../../src/client/components/InputDock";
import { KnowledgeManagerModal } from "../../../src/client/components/KnowledgeManagerModal";
import { MarkdownContent } from "../../../src/client/components/MarkdownContent";
import { McpServersModal } from "../../../src/client/components/McpServersModal";
import { MessageList } from "../../../src/client/components/MessageList";
import { Modal } from "../../../src/client/components/Modal";
import { ProviderSettingsModal } from "../../../src/client/components/ProviderSettingsModal";
import { isUserInputComplete, QuestionCard } from "../../../src/client/components/QuestionCard";
import { ResponsiveSidebar } from "../../../src/client/components/ResponsiveSidebar";
import { Sidebar } from "../../../src/client/components/Sidebar";
import { SlashMenu } from "../../../src/client/components/SlashMenu";
import { ThinkingBlock } from "../../../src/client/components/ThinkingBlock";
import { Toast } from "../../../src/client/components/Toast";
import { ToolActivityGroup } from "../../../src/client/components/ToolActivityGroup";
import { ToolBlock } from "../../../src/client/components/ToolBlock";
import { ToolSettingsModal } from "../../../src/client/components/ToolSettingsModal";
import { UserMessage } from "../../../src/client/components/UserMessage";
import { normalizeImageFileName } from "../../../src/client/lib/app-utils";

function createClipboardFile(name: string, type: string): File {
  return new File([`${name}:${type}`], name, { type });
}

test("mcp servers modal renders server rows with login/logout affordances", () => {
  const html = renderToStaticMarkup(
    <McpServersModal
      initialState={{
        servers: [
          { name: "linear", transport: "http", status: "needs_auth", toolCount: 0 },
          { name: "notion-http", transport: "http", status: "connected", toolCount: 5 },
          { name: "github", transport: "stdio", status: "connected", toolCount: 8 },
          { name: "notion", transport: "http", status: "error", toolCount: 0, error: "connect timeout" },
        ],
      }}
      onList={async () => ({ servers: [] })}
      onLoginStart={async () => ({ authUrl: "https://example.com/auth" })}
      onLogout={async () => ({ ok: true })}
      onClose={() => {}}
    />,
  );

  expect(html).toContain("MCP Servers");
  expect(html).toContain("linear");
  // HTTP servers get auth affordances: needs_auth -> Login, connected -> Logout.
  expect(html).toContain("Login");
  expect(html).toContain("Logout");
  // stdio servers are not OAuth-backed, so they expose neither Login nor Logout.
  expect(html).toContain("github");
  expect(html).toContain("connect timeout");
});

test("mcp servers modal omits login/logout for stdio transports", () => {
  const html = renderToStaticMarkup(
    <McpServersModal
      initialState={{
        servers: [{ name: "github", transport: "stdio", status: "connected", toolCount: 8 }],
      }}
      onList={async () => ({ servers: [] })}
      onLoginStart={async () => ({ authUrl: "https://example.com/auth" })}
      onLogout={async () => ({ ok: true })}
      onClose={() => {}}
    />,
  );

  expect(html).toContain("github");
  expect(html).not.toContain("Login");
  expect(html).not.toContain("Logout");
});

test("tool settings modal renders vertex provider badge label", () => {
  const html = renderToStaticMarkup(
    <ToolSettingsModal
      threadId="thread-1"
      initialState={{
        configPath: "/repo/.diligent/config.jsonc",
        appliesOnNextTurn: true,
        trustMode: "full_trust",
        conflictPolicy: "error",
        tools: [],
        plugins: [],
      }}
      providers={[{ provider: "vertex", configured: true, maskedKey: "Vertex ADC" }]}
      onList={async () => {
        throw new Error("unused");
      }}
      onSave={async () => {
        throw new Error("unused");
      }}
      onOpenProviders={() => {}}
      onClose={() => {}}
    />,
  );

  expect(html).toContain("Vertex AI");
  expect(html).toContain("Open AI connection settings");
});

function createClipboardData(options: {
  items?: Array<{ kind: string; type: string; file?: File | null }>;
  files?: File[];
}): DataTransfer {
  return {
    items: (options.items ?? []).map((item) => ({
      kind: item.kind,
      type: item.type,
      getAsFile: () => item.file ?? null,
    })),
    files: options.files ?? [],
  } as unknown as DataTransfer;
}

test("button renders aria-label and intent class", () => {
  const html = renderToStaticMarkup(
    <Button intent="danger" aria-label="Delete action">
      Delete
    </Button>,
  );

  expect(html).toContain("Delete action");
  expect(html).toContain("bg-danger");
});

test("input renders accessibility label", () => {
  const html = renderToStaticMarkup(<Input aria-label="Message input" placeholder="Type" />);
  expect(html).toContain("Message input");
  expect(html).toContain('placeholder="Type"');
});

test("question card always renders custom input row", () => {
  const html = renderToStaticMarkup(
    <QuestionCard
      request={{
        questions: [
          {
            id: "reason",
            header: "Reason",
            question: "Why?",
            options: [{ label: "A", description: "Option A" }],
            allow_multiple: false,
            is_secret: false,
          },
        ],
      }}
      answers={{}}
      onAnswerChange={() => {}}
      onSubmit={() => {}}
      onCancel={() => {}}
    />,
  );

  expect(html).toContain('placeholder="or type a custom answer…"');
  expect(html).toContain('aria-label="Reason"');
  expect(html).toContain("items-start px-3 py-2");
  expect(html).toContain('aria-hidden="true" class="mt-0.5 h-4 w-4 shrink-0"');
  expect(html).toContain("flex min-w-0 flex-1 flex-col");
  expect(html).toContain("min-w-0 truncate bg-transparent");
  expect(html).toContain('disabled=""');
});

test("question card enables submit only after every question has an answer", () => {
  const request = {
    questions: [
      {
        id: "move",
        header: "Move",
        question: "How should the character move?",
        options: [{ label: "Dash", description: "Move fast." }],
      },
      {
        id: "direction",
        header: "Direction",
        question: "Which direction should it use?",
        options: [{ label: "Forward", description: "Move ahead." }],
      },
    ],
  };

  expect(isUserInputComplete(request, {})).toBe(false);
  expect(isUserInputComplete(request, { move: "Dash" })).toBe(false);
  expect(isUserInputComplete(request, { move: "Dash", direction: "   " })).toBe(false);
  expect(isUserInputComplete(request, { move: "Dash", direction: "Forward" })).toBe(true);

  const incompleteHtml = renderToStaticMarkup(
    <QuestionCard
      request={request}
      answers={{ move: "Dash" }}
      onAnswerChange={() => {}}
      onSubmit={() => {}}
      onCancel={() => {}}
    />,
  );
  const completeHtml = renderToStaticMarkup(
    <QuestionCard
      request={request}
      answers={{ move: "Dash", direction: "Forward" }}
      onAnswerChange={() => {}}
      onSubmit={() => {}}
      onCancel={() => {}}
    />,
  );

  expect(incompleteHtml).toContain('disabled=""');
  expect(completeHtml).not.toContain('disabled=""');
});

test("question card treats empty multi-select answers as incomplete", () => {
  const request = {
    questions: [
      {
        id: "effects",
        header: "Effects",
        question: "Pick effects",
        allow_multiple: true,
        options: [
          { label: "Particles", description: "Add visual feedback." },
          { label: "Sound", description: "Add audio feedback." },
        ],
      },
    ],
  };

  expect(isUserInputComplete(request, { effects: [] })).toBe(false);
  expect(isUserInputComplete(request, { effects: ["   "] })).toBe(false);
  expect(isUserInputComplete(request, { effects: ["Particles"] })).toBe(true);
});

test("question card renders multi-select options as clear checkboxes", () => {
  const html = renderToStaticMarkup(
    <QuestionCard
      request={{
        questions: [
          {
            id: "next-steps",
            header: "Next steps",
            question: "Choose next steps",
            options: [
              { label: "Fix UI", description: "Recommended" },
              { label: "Wait", description: "No changes" },
            ],
            allow_multiple: true,
            is_secret: false,
          },
        ],
      }}
      answers={{ "next-steps": ["Fix UI"] }}
      onAnswerChange={() => {}}
      onSubmit={() => {}}
      onCancel={() => {}}
    />,
  );

  expect(html).toContain('type="checkbox"');
  expect(html).toContain('checked=""');
  expect(html).toContain("rounded-sm");
  expect(html).toContain("bg-control-choice");
  expect(html).toContain('stroke="currentColor"');
  expect(html).not.toContain("[x]");
  expect(html).not.toContain("[ ]");
  expect(html).not.toContain("✓");
});

test("question card renders single-select options as design system radios", () => {
  const html = renderToStaticMarkup(
    <QuestionCard
      request={{
        questions: [
          {
            id: "direction",
            header: "Direction",
            question: "Choose direction",
            options: [
              { label: "Forward", description: "Move ahead" },
              { label: "Back", description: "Move back" },
            ],
            allow_multiple: false,
            is_secret: false,
          },
        ],
      }}
      answers={{ direction: "Forward" }}
      onAnswerChange={() => {}}
      onSubmit={() => {}}
      onCancel={() => {}}
    />,
  );

  expect(html).toContain('type="radio"');
  expect(html).toContain('checked=""');
  expect(html).toContain("rounded-full");
  expect(html).toContain("bg-control-choice");
  expect(html).toContain("bg-text");
});

test("modal renders dialog role", () => {
  const html = renderToStaticMarkup(
    <Modal title="Approval required" description="test">
      <div>Body</div>
    </Modal>,
  );

  expect(html).toContain('role="dialog"');
  expect(html).toContain("Approval required");
});

test("toast keeps long provider errors bounded and wrappable", () => {
  const message =
    "ProviderError: An error occurred while processing your request. Please include the request ID 00f97018-852a-44a9-8da4-ffa4773df9d5 in your message.";
  const html = renderToStaticMarkup(
    <Toast toast={{ id: "err-1", kind: "error", message, fatal: false }} onDismiss={() => {}} />,
  );

  expect(html).toContain('role="alert"');
  expect(html).toContain("fixed right-4 top-20 z-50");
  expect(html).toContain("w-toast-mobile");
  expect(html).toContain("sm:w-toast");
  expect(html).toContain("max-h-toast");
  expect(html).toContain("whitespace-pre-wrap break-words");
  expect(html).toContain("00f97018-852a-44a9-8da4-ffa4773df9d5");
});

test("error banner wraps provider error text", () => {
  const html = renderToStaticMarkup(
    <ErrorBanner
      error={{
        id: "err-1",
        name: "ProviderError",
        message:
          "An error occurred while processing your request. Please include the request ID 00f97018-852a-44a9-8da4-ffa4773df9d5 in your message.",
        fatal: false,
        timestamp: 1,
        providerErrorType: "unknown",
      }}
      onOpenProviders={() => {}}
    />,
  );

  expect(html).toContain("ProviderError: An error occurred");
  expect(html).toContain('role="alert"');
  expect(html).toContain("border-b border-danger/30");
  expect(html).toContain("break-words");
  expect(html).toContain("whitespace-pre-wrap");
});

test("markdown content renders external links and fenced code blocks cleanly", () => {
  const markdown = ["# Title", "", "Visit [site](https://example.com).", "", "```ts", "const value = 1;", "```"].join(
    "\n",
  );
  const html = renderToStaticMarkup(<MarkdownContent text={markdown} />);

  expect(html).toContain('class="prose-content"');
  expect(html).toContain('class="prose-link"');
  expect(html).toContain('target="_blank"');
  expect(html).toContain('class="language-ts"');
  expect(html).toContain("hljs-keyword");
  expect(html).toContain("value = ");
  expect(html).toContain('hljs-number">1</span>');
});

test("markdown content preserves unordered and ordered list structure", () => {
  const markdown = ["- one", "- two", "", "1. first", "2. second"].join("\n");
  const html = renderToStaticMarkup(<MarkdownContent text={markdown} />);

  expect(html).toContain("<ul>");
  expect(html).toContain("<li>one</li>");
  expect(html).toContain("<li>two</li>");
  expect(html).toContain("<ol>");
  expect(html).toContain("<li>first</li>");
  expect(html).toContain("<li>second</li>");
});

test("tool settings modal renders tool and plugin rows", () => {
  const html = renderToStaticMarkup(
    <ToolSettingsModal
      threadId="thread-1"
      runtimeVersion="1.2.3"
      initialState={{
        configPath: "/repo/.diligent/config.jsonc",
        appliesOnNextTurn: true,
        trustMode: "full_trust",
        conflictPolicy: "error",
        tools: [
          {
            name: "bash",
            source: "builtin",
            enabled: true,
            immutable: false,
            configurable: true,
            available: true,
            reason: "enabled",
          },
          {
            name: "plan",
            source: "builtin",
            enabled: true,
            immutable: true,
            configurable: false,
            available: true,
            reason: "immutable_forced_on",
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
      }}
      consent={{
        noticeAcknowledged: true,
        serviceImprovement: true,
        privacyPolicyUrl: "https://example.com/privacy",
      }}
      onConsentChange={() => {}}
      onList={async () => {
        throw new Error("unused");
      }}
      onSave={async () => {
        throw new Error("unused");
      }}
      onClose={() => {}}
    />,
  );

  expect(html).toContain("Built-in tools");
  expect(html).toContain("Runtime version");
  expect(html).toContain("1.2.3");
  expect(html).toContain("bash");
  expect(html).toContain("Locked");
  expect(html).toContain("@acme/diligent-tools");
  expect(html).toContain("Add Package");
  expect(html).toContain("min-w-28 shrink-0 whitespace-nowrap");
  expect(html).toContain("focus-visible:ring-inset focus-visible:ring-offset-0");
  expect(html).toContain("jira_comment");
  expect(html).toContain("AI Agent Data Use");
  expect(html).toContain("Improve service with your chats");
  expect(html).toContain("This data is not used to train AI models.");
  expect(html).toContain("Default On · Turning off stops improvement use");
  expect(html).toContain("View Privacy Policy");
  expect(html).toContain("lucide-external-link");
  expect(html).toContain('href="https://example.com/privacy"');
});

test("tool settings modal shows runtime fallback when version is missing", () => {
  const html = renderToStaticMarkup(
    <ToolSettingsModal
      threadId="thread-1"
      initialState={{
        configPath: "/repo/.diligent/config.jsonc",
        appliesOnNextTurn: true,
        trustMode: "full_trust",
        conflictPolicy: "error",
        tools: [],
        plugins: [],
      }}
      onList={async () => {
        throw new Error("unused");
      }}
      onSave={async () => {
        throw new Error("unused");
      }}
      onClose={() => {}}
    />,
  );

  expect(html).toContain("Runtime version");
  expect(html).toContain("Unavailable");
});

test("knowledge manager modal renders inline overlay controls and filter UI", () => {
  const html = renderToStaticMarkup(
    <KnowledgeManagerModal
      threadId="thread-1"
      className="absolute inset-0 z-40 bg-black/35"
      onList={async () => ({
        data: [
          {
            id: "k1",
            timestamp: "2026-03-11T08:00:00.000Z",
            type: "pattern",
            content: "Use focused tests first",
            confidence: 0.8,
            tags: ["tests"],
            sessionId: "thread-1",
          },
        ],
      })}
      onUpdate={async () => {
        throw new Error("unused");
      }}
      onDelete={async () => ({ deleted: true })}
      onClose={() => {}}
    />,
  );

  expect(html).toContain('aria-label="Knowledge"');
  expect(html).toContain("absolute inset-0 z-40 bg-black/35");
  expect(html).toContain("Search");
  expect(html).toContain("Filter knowledge type");
  expect(html).toContain("Sort knowledge entries");
  expect(html).not.toContain("New entry");
  expect(html).toContain("Loading knowledge entries…");
  expect(html).toContain("Entries (0/0)");
  expect(html).toContain("pattern");
  expect(html).toContain("backlog");
});

test("user message renders attached images", () => {
  const html = renderToStaticMarkup(
    <UserMessage
      text="See attached"
      images={[{ url: "blob:test-image", fileName: "screen.png", mediaType: "image/png" }]}
    />,
  );

  expect(html).toContain("See attached");
  expect(html).toContain('src="blob:test-image"');
  expect(html).toContain('alt="screen.png"');
});

test("input dock renders attached context chips", () => {
  const html = renderToStaticMarkup(
    <InputDock
      input="hello"
      onInputChange={() => {}}
      onSend={() => {}}
      onSteer={() => {}}
      onInterrupt={() => {}}
      onCompactionClick={() => {}}
      isCompacting={false}
      canSend={true}
      canSteer={false}
      threadStatus="idle"
      mode="default"
      onModeChange={() => {}}
      effort="medium"
      onEffortChange={() => {}}
      currentModel="gpt-5"
      availableModels={[]}
      onModelChange={() => {}}
      usage={{ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 }}
      currentContextTokens={0}
      contextWindow={0}
      hasProvider={true}
      supportsVision={false}
      supportsThinking={false}
      pendingImages={[]}
      contextItems={[
        { kind: "instance", source: "studiorpc", GUID: "guid-1", ClassType: "Part", Name: "Spawn_A" },
        { kind: "file", source: "vscode", uri: "file:///workspace/mock.ts", Name: "mock.ts", languageId: "typescript" },
      ]}
      isUploadingImages={false}
      onAddImages={() => {}}
      onRemoveImage={() => {}}
      onRemoveContextItem={() => {}}
      onClearContextItems={() => {}}
      slashCommands={[]}
    />,
  );

  expect(html).toContain("Spawn_A (Part)");
  expect(html).toContain("mock.ts (typescript)");
  expect(html).toContain("Clear all");
});

test("input dock shows a compact non-default mode badge", () => {
  expect(getModeLabel("default")).toBe("default");
  expect(getModeBadgeLabel("default")).toBeNull();
  expect(getModeBadgeLabel("plan")).toBe("Plan");
  expect(getModeBadgeLabel("execute")).toBe("Execute");
  expect(getModeBadgeClasses("plan")).toContain("emerald");
  expect(getModeBadgeClasses("execute")).toContain("accent");

  const defaultHtml = renderToStaticMarkup(
    <InputDock
      input=""
      onInputChange={() => {}}
      onSend={() => {}}
      onSteer={() => {}}
      onInterrupt={() => {}}
      onCompactionClick={() => {}}
      isCompacting={false}
      canSend={true}
      canSteer={false}
      threadStatus="idle"
      mode="default"
      onModeChange={() => {}}
      effort="medium"
      onEffortChange={() => {}}
      currentModel="gpt-5"
      availableModels={[]}
      onModelChange={() => {}}
      usage={{ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 }}
      currentContextTokens={0}
      contextWindow={0}
      hasProvider={true}
      supportsVision={false}
      supportsThinking={false}
      pendingImages={[]}
      contextItems={[]}
      isUploadingImages={false}
      onAddImages={() => {}}
      onRemoveImage={() => {}}
      onRemoveContextItem={() => {}}
      onClearContextItems={() => {}}
      slashCommands={[]}
    />,
  );

  expect(defaultHtml).not.toContain('title="Current mode: default"');

  const planHtml = renderToStaticMarkup(
    <InputDock
      input=""
      onInputChange={() => {}}
      onSend={() => {}}
      onSteer={() => {}}
      onInterrupt={() => {}}
      onCompactionClick={() => {}}
      isCompacting={false}
      canSend={true}
      canSteer={false}
      threadStatus="idle"
      mode="plan"
      onModeChange={() => {}}
      effort="medium"
      onEffortChange={() => {}}
      currentModel="gpt-5"
      availableModels={[]}
      onModelChange={() => {}}
      usage={{ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 }}
      currentContextTokens={0}
      contextWindow={0}
      hasProvider={true}
      supportsVision={false}
      supportsThinking={false}
      pendingImages={[]}
      contextItems={[]}
      isUploadingImages={false}
      onAddImages={() => {}}
      onRemoveImage={() => {}}
      onRemoveContextItem={() => {}}
      onClearContextItems={() => {}}
      slashCommands={[]}
    />,
  );

  expect(planHtml).toContain('title="Current mode: Plan"');
  expect(planHtml).toContain("border-emerald-400/30");
  expect(planHtml).toContain("text-emerald-300");
  expect(planHtml).toContain(">Plan</div>");
});

test("input dock only blocks submission while a prompt is pending", () => {
  const html = renderToStaticMarkup(
    <InputDock
      input="answer draft"
      onInputChange={() => {}}
      onSend={() => {}}
      onSteer={() => {}}
      onInterrupt={() => {}}
      onCompactionClick={() => {}}
      isCompacting={false}
      canSend={false}
      canSteer={true}
      threadStatus="busy"
      mode="plan"
      onModeChange={() => {}}
      effort="medium"
      onEffortChange={() => {}}
      currentModel="gpt-5"
      availableModels={[]}
      onModelChange={() => {}}
      usage={{ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 }}
      currentContextTokens={0}
      contextWindow={0}
      hasProvider={true}
      hasBlockingPrompt={true}
      supportsVision={false}
      supportsThinking={false}
      pendingImages={[]}
      contextItems={[]}
      isUploadingImages={false}
      onAddImages={() => {}}
      onRemoveImage={() => {}}
      onRemoveContextItem={() => {}}
      onClearContextItems={() => {}}
      slashCommands={[]}
    />,
  );

  expect(html).toContain('aria-label="Steering input"');
  expect(html).toContain('placeholder="Steer the agent…"');
  expect(html).toContain('<button type="button" aria-label="Steer agent" disabled=""');
});

test("input dock composer textarea does not inherit field border styles", () => {
  const html = renderToStaticMarkup(
    <InputDock
      input=""
      onInputChange={() => {}}
      onSend={() => {}}
      onSteer={() => {}}
      onInterrupt={() => {}}
      onCompactionClick={() => {}}
      isCompacting={false}
      canSend={false}
      canSteer={true}
      threadStatus="busy"
      mode="default"
      onModeChange={() => {}}
      effort="medium"
      onEffortChange={() => {}}
      currentModel="gpt-5"
      availableModels={[]}
      onModelChange={() => {}}
      usage={{ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 }}
      currentContextTokens={0}
      contextWindow={0}
      hasProvider={true}
      supportsVision={false}
      supportsThinking={false}
      pendingImages={[]}
      contextItems={[]}
      isUploadingImages={false}
      onAddImages={() => {}}
      onRemoveImage={() => {}}
      onRemoveContextItem={() => {}}
      onClearContextItems={() => {}}
      slashCommands={[]}
    />,
  );

  const textarea = html.match(/<textarea[^>]*aria-label="Steering input"[^>]*>/)?.[0] ?? "";
  expect(html).toContain("relative rounded-sm border bg-surface-composer px-4 py-3");
  expect(textarea).toContain("min-h-[52px]");
  expect(textarea).toContain("rounded-md");
  expect(textarea).toContain("px-1");
  expect(textarea).toContain("py-2");
  expect(textarea).toContain("border-0");
  expect(textarea).toContain("bg-transparent");
  expect(textarea).not.toContain("!px-1");
  expect(textarea).not.toContain("px-3");
  expect(textarea).not.toContain("py-0");
  expect(textarea).not.toContain("border-border");
  expect(textarea).not.toContain("bg-surface-dark");
  expect(html).toContain("border-white/10");
});

test("input dock composer selectors do not inherit bordered select trigger styles", () => {
  const html = renderToStaticMarkup(
    <InputDock
      input=""
      onInputChange={() => {}}
      onSend={() => {}}
      onSteer={() => {}}
      onInterrupt={() => {}}
      onCompactionClick={() => {}}
      isCompacting={false}
      canSend={true}
      canSteer={false}
      threadStatus="idle"
      mode="default"
      onModeChange={() => {}}
      effort="medium"
      onEffortChange={() => {}}
      currentModel="gpt-5"
      availableModels={[
        {
          id: "gpt-5",
          provider: "openai",
          contextWindow: 300000,
          maxOutputTokens: 64000,
          supportsVision: true,
          supportsThinking: true,
          supportedEfforts: ["low", "medium", "high"],
        },
      ]}
      onModelChange={() => {}}
      usage={{ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 }}
      currentContextTokens={0}
      contextWindow={0}
      hasProvider={true}
      supportsVision={true}
      supportsThinking={true}
      pendingImages={[]}
      contextItems={[]}
      isUploadingImages={false}
      onAddImages={() => {}}
      onRemoveImage={() => {}}
      onRemoveContextItem={() => {}}
      onClearContextItems={() => {}}
      slashCommands={[]}
    />,
  );

  const modelTrigger = html.match(/<button[^>]*aria-label="Model selector"[^>]*>/)?.[0] ?? "";
  const effortTrigger = html.match(/<button[^>]*aria-label="Effort selector"[^>]*>/)?.[0] ?? "";

  expect(modelTrigger).toContain("bg-black");
  expect(effortTrigger).toContain("bg-black");
  expect(html).toContain("w-[180px]");
  expect(html).toContain("w-[90px]");
  expect(modelTrigger).not.toContain("rounded-md");
  expect(effortTrigger).not.toContain("rounded-md");
  expect(modelTrigger).not.toContain("border-border");
  expect(effortTrigger).not.toContain("border-border");
  expect(modelTrigger).not.toContain("bg-surface-dark");
  expect(effortTrigger).not.toContain("bg-surface-dark");
});

test("user message renders context chips above text", () => {
  const html = renderToStaticMarkup(
    <UserMessage
      text="Move these"
      contextItems={[{ kind: "instance", source: "studiorpc", GUID: "guid-1", ClassType: "Part", Name: "Spawn_A" }]}
    />,
  );

  expect(html).toContain("Spawn_A (Part)");
  expect(html).toContain("Move these");
});

test("context message renders a subtle collapsed compaction divider", () => {
  const html = renderToStaticMarkup(<ContextMessage summary={"## Goal\nShip transcript-aware compaction UI"} />);

  expect(html).toContain("Context compacted");
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain("bg-border/25");
  expect(html).not.toContain("Context checkpoint");
  expect(html).not.toContain("Older conversation was compressed to keep the thread efficient.");
  expect(html).not.toContain("Ship transcript-aware compaction UI");
});

test("app header exposes sidebar toggle state and target", () => {
  const html = renderToStaticMarkup(
    <AppHeader
      sidebarOpen={true}
      onToggleSidebar={() => {}}
      onNewThread={() => {}}
      threadStatus="idle"
      isCompacting={false}
      threadTitle="Thread"
      onOpenKnowledge={() => {}}
      onOpenConfig={() => {}}
    />,
  );

  expect(html).toContain('aria-label="Close sidebar"');
  expect(html).toContain('aria-controls="app-sidebar"');
  expect(html).toContain('aria-expanded="true"');
});

test("app header shows new conversation action only when sidebar is closed", () => {
  const closedHtml = renderToStaticMarkup(
    <AppHeader
      sidebarOpen={false}
      onToggleSidebar={() => {}}
      onNewThread={() => {}}
      threadStatus="idle"
      isCompacting={false}
      threadTitle="Thread"
      onOpenKnowledge={() => {}}
      onOpenConfig={() => {}}
    />,
  );
  const openHtml = renderToStaticMarkup(
    <AppHeader
      sidebarOpen={true}
      onToggleSidebar={() => {}}
      onNewThread={() => {}}
      threadStatus="idle"
      isCompacting={false}
      threadTitle="Thread"
      onOpenKnowledge={() => {}}
      onOpenConfig={() => {}}
    />,
  );

  expect(closedHtml).toContain('aria-label="New conversation"');
  expect(closedHtml).toContain('title="New conversation"');
  expect(openHtml).not.toContain('aria-label="New conversation"');
  expect(openHtml).not.toContain('title="New conversation"');
});

test("responsive sidebar renders a mobile full-screen overlay when open", () => {
  const html = renderToStaticMarkup(
    <ResponsiveSidebar open={true}>
      <div>Navigation</div>
    </ResponsiveSidebar>,
  );

  expect(html).toContain('id="app-sidebar"');
  expect(html).toContain('aria-label="Conversations"');
  expect(html).toContain("fixed inset-0 z-50");
  expect(html).toContain("w-screen");
  expect(html).toContain("translate-x-0");
  expect(html).toContain("sm:w-sidebar");
  expect(html).toContain("transition-transform");
  expect(html).not.toContain("bg-overlay/45");
});

test("responsive sidebar hides closed overlay from focus and assistive tech", () => {
  const html = renderToStaticMarkup(
    <ResponsiveSidebar open={false}>
      <button type="button">Hidden navigation action</button>
    </ResponsiveSidebar>,
  );

  expect(html).toContain('aria-hidden="true"');
  expect(html).toContain("inert");
  expect(html).toContain("-translate-x-full");
  expect(html).toContain("sm:w-0");
  expect(html).toContain("transition-none");
});

test("sidebar includes a mobile close action", () => {
  const html = renderToStaticMarkup(
    <Sidebar
      cwd="/repo/project"
      threadList={[]}
      activeThreadId={null}
      onNewThread={() => {}}
      onOpenThread={() => {}}
      onClose={() => {}}
    />,
  );

  expect(html).toContain("Conversations");
  expect(html).toContain('aria-label="Close sidebar"');
  expect(html).toContain("data-sidebar-initial-focus");
  expect(html).toContain("sm:hidden");
});

test("assistant message can suppress thinking block during compaction", () => {
  const html = renderToStaticMarkup(
    <AssistantMessage
      suppressThinking
      item={{
        id: "assistant-thinking-hidden",
        kind: "assistant",
        text: "",
        thinking: "internal reasoning",
        contentBlocks: [],
        thinkingDone: false,
        timestamp: 1,
        reasoningDurationMs: 0,
      }}
    />,
  );

  expect(html).toBe('<div class="pb-1"></div>');
});

test("empty state renders connect CTA when provider is not configured", () => {
  const html = renderToStaticMarkup(
    <EmptyState hasProvider={false} oauthPending={false} onOpenProviders={() => {}} onQuickConnectChatGPT={() => {}} />,
  );

  expect(html).toContain("Connect your AI account to start building");
  expect(html).toContain("Connect ChatGPT");
});

test("provider settings modal hides vertex from the connect list", () => {
  // Vertex needs project/location/endpoint config the token-only UI can't express, so it is
  // hidden here and configured via provider.vertex in config.jsonc instead.
  const html = renderToStaticMarkup(
    <ProviderSettingsModal
      providers={[{ provider: "vertex", configured: false }]}
      oauthPending={false}
      oauthError={null}
      onSet={async () => {}}
      onRemove={async () => {}}
      onOAuthStart={async () => ({ authUrl: "https://example.com" })}
      onClose={() => {}}
    />,
  );

  expect(html).not.toContain("Vertex AI");
});

test("provider settings modal shows a single OAuth label for connected ChatGPT", () => {
  const html = renderToStaticMarkup(
    <ProviderSettingsModal
      providers={[{ provider: "chatgpt", configured: true, maskedKey: "ChatGPT OAuth", oauthConnected: true }]}
      oauthPending={false}
      oauthError={null}
      onSet={async () => {}}
      onRemove={async () => {}}
      onOAuthStart={async () => ({ authUrl: "https://example.com" })}
      onClose={() => {}}
    />,
  );

  expect(html).toContain(">OAuth<");
  expect(html).not.toContain("ChatGPT OAuth");
  expect(html.match(/OAuth/g)?.length).toBe(1);
});

test("empty state is hidden when provider is configured", () => {
  const html = renderToStaticMarkup(
    <EmptyState hasProvider={true} oauthPending={false} onOpenProviders={() => {}} onQuickConnectChatGPT={() => {}} />,
  );

  expect(html).toBe("");
});

test("assistant message only shows meaningful thinking duration in the default transcript", () => {
  const html = renderToStaticMarkup(
    <AssistantMessage
      item={{
        id: "assistant-1",
        kind: "assistant",
        text: "Done.",
        thinking: "Checked relevant files",
        contentBlocks: [{ type: "text", text: "Done." }],
        thinkingDone: true,
        timestamp: 1,
        reasoningDurationMs: 1200,
        turnDurationMs: 4200,
      }}
    />,
  );

  expect(html).not.toContain("Completed in 4.2s");
  expect(html).not.toContain("1.2s");
  expect(html).toContain(">1s<");
  expect(html).not.toContain("Reasoned for");
  expect(html).not.toContain("text-xs uppercase tracking-wide text-muted/65");
  expect(html).not.toContain('class="pb-2 pt-3"');
});

test("assistant message hides zero reasoning duration", () => {
  const html = renderToStaticMarkup(
    <AssistantMessage
      item={{
        id: "assistant-zero-reasoning",
        kind: "assistant",
        text: "Done.",
        thinking: "Checked relevant files",
        contentBlocks: [{ type: "text", text: "Done." }],
        thinkingDone: true,
        timestamp: 1,
        reasoningDurationMs: 0,
      }}
    />,
  );

  expect(html).toContain("Thought");
  expect(html).not.toContain("0ms");
});

test("thinking block renders markdown emphasis instead of literal markers", () => {
  const html = renderToStaticMarkup(<ThinkingBlock text={"**Considering button sizes**\n\nReasoning body."} />);

  expect(html).toContain("<strong>Considering button sizes</strong>");
  expect(html).not.toContain("**Considering button sizes**");
});

test("thinking block renders streaming markdown emphasis instead of raw markers", () => {
  const html = renderToStaticMarkup(
    <ThinkingBlock text={"**Considering button sizes**\n\nReasoning body."} streaming={true} />,
  );

  expect(html).toContain("thinking-content");
  expect(html).toContain("<strong>Considering button sizes</strong>");
  expect(html).not.toContain("**Considering button sizes**");
  expect(html).not.toContain("whitespace-pre-wrap");
});

test("assistant message collapses skill usage preface into a compact activity row", () => {
  const html = renderToStaticMarkup(
    <AssistantMessage
      item={{
        id: "assistant-skill-1",
        kind: "assistant",
        text: [
          "Skill used: overdare-debug-expert",
          "Work area: script",
          "Classification rationale: decision path points to a script issue.",
          "Reproduction path: DUO -> CANCEL -> SOLO PLAY.",
          "Reference cases: inspect state transition examples.",
          "Goal for this loop: confirm selected mode values.",
          "First checks: Play.log and controllers.",
          "",
          "Starting with the relevant scripts.",
        ].join("\n"),
        thinking: "",
        contentBlocks: [
          {
            type: "text",
            text: [
              "Skill used: overdare-debug-expert",
              "Work area: script",
              "Classification rationale: decision path points to a script issue.",
              "Reproduction path: DUO -> CANCEL -> SOLO PLAY.",
              "Reference cases: inspect state transition examples.",
              "Goal for this loop: confirm selected mode values.",
              "First checks: Play.log and controllers.",
              "",
              "Starting with the relevant scripts.",
            ].join("\n"),
          },
        ],
        thinkingDone: true,
        timestamp: 1,
      }}
    />,
  );

  expect(html).toContain("Skill used: overdare-debug-expert");
  expect((html.match(/Skill used: overdare-debug-expert/g) ?? []).length).toBe(1);
  expect(html).toContain(">script<");
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain("Starting with the relevant scripts.");
  expect(html).not.toContain("Classification rationale: decision path points to a script issue.");
  expect(html).not.toContain("Reproduction path: DUO");
});

test("assistant message keeps standalone skill usage row spacing compact", () => {
  const html = renderToStaticMarkup(
    <AssistantMessage
      item={{
        id: "assistant-skill-standalone",
        kind: "assistant",
        text: "Skill used: overdare-debug-expert\nWork area: script",
        thinking: "",
        contentBlocks: [],
        thinkingDone: true,
        timestamp: 1,
      }}
    />,
  );

  expect(html).toContain("Skill used: overdare-debug-expert");
  expect(html).toContain('class="mb-0"');
  expect(html).not.toContain("mb-1");
});

test("assistant message does not add an empty divider when duration is unavailable", () => {
  const html = renderToStaticMarkup(
    <AssistantMessage
      item={{
        id: "assistant-2",
        kind: "assistant",
        text: "Persisted reply",
        thinking: "",
        contentBlocks: [{ type: "text", text: "Persisted reply" }],
        thinkingDone: true,
        timestamp: 2,
      }}
    />,
  );

  expect(html).not.toContain("h-px w-full bg-border/10");
  expect(html).not.toContain("Completed in");
});

test("assistant message renders provider-native web blocks and citations", () => {
  const html = renderToStaticMarkup(
    <AssistantMessage
      item={{
        id: "assistant-web-1",
        kind: "assistant",
        text: "Found it.",
        thinking: "",
        contentBlocks: [
          {
            type: "provider_tool_use",
            id: "ws_1",
            provider: "openai",
            name: "web_search",
            input: { query: "diligent" },
          },
          {
            type: "web_search_result",
            toolUseId: "ws_1",
            provider: "openai",
            results: [{ url: "https://example.com", title: "Example", snippet: "Result snippet" }],
          },
          {
            type: "text",
            text: "Found it.",
            citations: [
              { type: "web_search_result_location", url: "https://example.com", title: "Example", citedText: "Found" },
            ],
          },
        ],
        thinkingDone: true,
        timestamp: 3,
      }}
    />,
  );

  expect(html).toContain("Searching web");
  expect(html).toContain("Searched web");
  expect(html).not.toContain("Searching diligent");
  expect(html).not.toContain("Found 1 result");
  expect(html).toContain("Example");
  expect(html).not.toContain("animate-pulse");
  expect(html).not.toContain("tool-activity-running");
  expect(html).not.toContain(">running<");
  expect(html).toContain("Source 1:");
  expect(html).not.toContain("chatgpt");
  expect(html).not.toContain("openai");
  expect(html).not.toContain('class="pb-2 pt-3"');
  expect(html).not.toContain("Completed in");
});

test("assistant message suppresses empty provider-native tool blocks", () => {
  const html = renderToStaticMarkup(
    <AssistantMessage
      item={{
        id: "assistant-web-empty-1",
        kind: "assistant",
        text: "",
        thinking: "",
        contentBlocks: [
          {
            type: "provider_tool_use",
            id: "wf_1",
            provider: "anthropic",
            name: "web_fetch",
            input: {},
          },
          {
            type: "web_search_result",
            toolUseId: "wf_1",
            provider: "anthropic",
            results: [],
          },
          {
            type: "text",
            text: "   ",
          },
        ],
        thinkingDone: true,
        timestamp: 4,
      }}
    />,
  );

  expect(html).toBe("");
});

test("input dock renders pending image preview and add-images action", () => {
  const html = renderToStaticMarkup(
    <InputDock
      input=""
      onInputChange={() => {}}
      onSend={() => {}}
      onSteer={() => {}}
      onInterrupt={() => {}}
      onCompactionClick={() => {}}
      canSend={true}
      canSteer={false}
      threadStatus="idle"
      mode="default"
      onModeChange={() => {}}
      effort="none"
      onEffortChange={() => {}}
      currentModel="gpt-5.4"
      availableModels={[
        {
          id: "gpt-5.4",
          provider: "openai",
          contextWindow: 400000,
          maxOutputTokens: 64000,
          supportsVision: true,
          supportsThinking: true,
          supportedEfforts: ["none", "low", "medium", "high", "max"],
        },
      ]}
      onModelChange={() => {}}
      usage={{ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 }}
      currentContextTokens={0}
      contextWindow={1000000}
      hasProvider={true}
      onOpenProviders={() => {}}
      supportsVision={true}
      supportsThinking={true}
      pendingImages={[{ path: "/tmp/shot.png", url: "blob:shot", fileName: "shot.png" }]}
      contextItems={[]}
      isUploadingImages={false}
      onAddImages={() => {}}
      onRemoveImage={() => {}}
      onRemoveContextItem={() => {}}
      onClearContextItems={() => {}}
    />,
  );

  expect(html).toContain('src="blob:shot"');
  expect(html).toContain('accept="image/png,image/jpeg,image/webp,image/gif"');
  expect(html).toContain('placeholder="Ask anything or attach images…"');
  expect(html).toContain('class="relative z-20 bg-surface-dark');
  expect(html).toContain("minimal");
  expect(html).toContain("minimal");
});

test("input dock compaction menu does not show compacting label swap", () => {
  const html = renderToStaticMarkup(
    <InputDock
      input=""
      onInputChange={() => {}}
      onSend={() => {}}
      onSteer={() => {}}
      onInterrupt={() => {}}
      onCompactionClick={() => {}}
      isCompacting={true}
      canSend={true}
      canSteer={true}
      threadStatus="idle"
      mode="default"
      onModeChange={() => {}}
      effort="medium"
      onEffortChange={() => {}}
      currentModel="gpt-5"
      availableModels={[]}
      onModelChange={() => {}}
      usage={{ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 }}
      currentContextTokens={0}
      contextWindow={0}
      hasProvider={true}
      supportsVision={false}
      supportsThinking={false}
      pendingImages={[]}
      contextItems={[]}
      isUploadingImages={false}
      onAddImages={() => {}}
      onRemoveImage={() => {}}
      onRemoveContextItem={() => {}}
      onClearContextItems={() => {}}
    />,
  );

  expect(html).not.toContain("Compacting…");
});

test("input dock shows uploading state and disables send affordance", () => {
  const html = renderToStaticMarkup(
    <InputDock
      input="Describe this"
      onInputChange={() => {}}
      onSend={() => {}}
      onSteer={() => {}}
      onInterrupt={() => {}}
      onCompactionClick={() => {}}
      canSend={false}
      canSteer={false}
      threadStatus="idle"
      mode="default"
      onModeChange={() => {}}
      effort="high"
      onEffortChange={() => {}}
      currentModel={DEFAULT_ANTHROPIC_MODEL_ID}
      availableModels={[
        {
          id: DEFAULT_ANTHROPIC_MODEL_ID,
          provider: "anthropic",
          contextWindow: 1000000,
          maxOutputTokens: 64000,
          supportsVision: true,
        },
      ]}
      onModelChange={() => {}}
      usage={{ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 }}
      currentContextTokens={0}
      contextWindow={1000000}
      hasProvider={true}
      onOpenProviders={() => {}}
      supportsVision={true}
      supportsThinking={true}
      pendingImages={[]}
      contextItems={[]}
      isUploadingImages={true}
      onAddImages={() => {}}
      onRemoveImage={() => {}}
      onRemoveContextItem={() => {}}
      onClearContextItems={() => {}}
    />,
  );

  expect(html).toContain("Uploading…");
  expect(html).toContain("h-20 w-20 shrink-0");
  expect(html).toContain("disabled");
});

test("input dock hides effort selector when model does not support thinking", () => {
  const html = renderToStaticMarkup(
    <InputDock
      input=""
      onInputChange={() => {}}
      onSend={() => {}}
      onSteer={() => {}}
      onInterrupt={() => {}}
      onCompactionClick={() => {}}
      canSend={true}
      canSteer={false}
      threadStatus="idle"
      mode="default"
      onModeChange={() => {}}
      effort="medium"
      onEffortChange={() => {}}
      currentModel="gpt-5.3-chat-latest"
      availableModels={[
        {
          id: "gpt-5.3-chat-latest",
          provider: "openai",
          contextWindow: 400000,
          maxOutputTokens: 16384,
          supportsThinking: false,
        },
      ]}
      onModelChange={() => {}}
      usage={{ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 }}
      currentContextTokens={0}
      contextWindow={400000}
      hasProvider={true}
      onOpenProviders={() => {}}
      supportsVision={false}
      supportsThinking={false}
      pendingImages={[]}
      contextItems={[]}
      isUploadingImages={false}
      onAddImages={() => {}}
      onRemoveImage={() => {}}
      onRemoveContextItem={() => {}}
      onClearContextItems={() => {}}
    />,
  );

  expect(html).not.toContain("Effort selector");
});

test("slash menu renders a flat command list without submenu affordances", () => {
  const html = renderToStaticMarkup(
    <SlashMenu
      commands={[
        { name: "help", description: "Show available commands" },
        { name: "resume", description: "Resume thread", usage: "/resume <thread-id>", requiresArgs: true },
      ]}
      selectedIndex={1}
      onSelect={() => {}}
    />,
  );

  expect(html).toContain('role="listbox"');
  expect(html).toContain("/help");
  expect(html).toContain("/resume");
  expect(html).toContain("Resume thread");
  expect(html).not.toContain("›");
  expect(html).not.toContain("Default");
  expect(html).not.toContain("Execute");
});

test("tool activity group reveals flat child rows with inline previews as the second level", () => {
  const html = renderToStaticMarkup(
    <ToolActivityGroup
      initialOpen={true}
      items={[
        {
          id: "tool-1",
          kind: "tool",
          toolName: "bash",
          inputText: "find /Volumes -maxdepth 4",
          outputText: "Command completed",
          isError: false,
          status: "done",
          timestamp: 1,
          toolCallId: "call-1",
          startedAt: 1,
          durationMs: 300058,
          render: {
            inputSummary: "find /Volumes -maxdepth 4",
            outputSummary: "Command completed",
            blocks: [],
          },
        },
      ]}
    />,
  );

  expect(html).toContain("Ran 1 command");
  expect(html).toContain("Ran command: find /Volumes -maxdepth 4 · Command completed");
  expect(html).toContain("find /Volumes -maxdepth 4");
  expect(html).toContain("Command completed");
  expect(html).toContain(">5m<");
  expect(html).toContain("gap-2 py-0.5");
  expect(html).not.toContain("gap-1.5");
  expect(html).not.toContain("ml-7 mt-1 space-y-1 border-l");
  expect(html).not.toContain("max-h-72");
});

test("nested tool block reveals scrollable third-level details when expanded", () => {
  const html = renderToStaticMarkup(
    <ToolBlock
      nested={true}
      initialOpen={true}
      inlinePreviewWhenCollapsed={true}
      item={{
        id: "tool-1",
        kind: "tool",
        toolName: "bash",
        inputText: "find /Volumes -maxdepth 4",
        outputText: "Command completed",
        isError: false,
        status: "done",
        timestamp: 1,
        toolCallId: "call-1",
        startedAt: 1,
        durationMs: 300058,
        render: {
          inputSummary: "find /Volumes -maxdepth 4",
          outputSummary: "Command completed",
          blocks: [{ type: "text", title: "Output", text: "Command completed" }],
        },
      }}
    />,
  );

  expect(html).toContain("max-h-72");
  expect(html).toContain("overflow-y-auto");
  expect(html).toContain("Ran command: find /Volumes -maxdepth 4 · Command completed");
  expect(html).toContain("find /Volumes -maxdepth 4");
  expect(html).toContain("Command completed");
  expect(html).not.toContain("300058ms");
  expect(html).toContain(">5m<");
  expect(html).toContain("gap-2 py-0.5");
  expect(html).toContain("flex h-5 w-5");
  expect(html).not.toContain("gap-1.5");
  expect(html).not.toContain("ml-7");
  expect(html).not.toContain("border-l border-border");
  expect(html).not.toContain("pl-3");
});

test("tool block hides completed duration in the default row", () => {
  const html = renderToStaticMarkup(
    <ToolBlock
      item={{
        id: "tool-1",
        kind: "tool",
        toolName: "bash",
        inputText: '{"command":"echo hi"}',
        outputText: "hi",
        isError: false,
        status: "done",
        timestamp: 200,
        toolCallId: "call-1",
        startedAt: 100,
        durationMs: 123,
      }}
    />,
  );

  expect(html).not.toContain("123ms");
  expect(html).toContain("Ran command");
});

test("tool block shows completed duration only after one second", () => {
  const html = renderToStaticMarkup(
    <ToolBlock
      item={{
        id: "tool-long",
        kind: "tool",
        toolName: "bash",
        inputText: '{"command":"sleep 1"}',
        outputText: "done",
        isError: false,
        status: "done",
        timestamp: 1_500,
        toolCallId: "call-long",
        startedAt: 100,
        durationMs: 1_350,
      }}
    />,
  );

  expect(html).toContain(">1s<");
  expect(html).not.toContain("1350ms");
});

test("tool block uses a neutral fallback icon instead of the target glyph", () => {
  const html = renderToStaticMarkup(
    <ToolBlock
      item={{
        id: "tool-fallback",
        kind: "tool",
        toolName: "unknown_custom_tool",
        inputText: "{}",
        outputText: "done",
        isError: false,
        status: "done",
        timestamp: 1,
        toolCallId: "call-fallback",
        startedAt: 1,
      }}
    />,
  );

  expect(html).toContain("lucide-sliders-horizontal");
  expect(html).not.toContain("lucide-bot");
  expect(html).not.toContain("lucide-crosshair");
});

test("tool block hides duration while tool is still running", () => {
  const html = renderToStaticMarkup(
    <ToolBlock
      item={{
        id: "tool-2",
        kind: "tool",
        toolName: "bash",
        inputText: '{"command":"sleep 1"}',
        outputText: "",
        isError: false,
        status: "streaming",
        timestamp: 100,
        toolCallId: "call-2",
        startedAt: 100,
      }}
    />,
  );

  expect(html).not.toContain("123ms");
  expect(html).toContain("Running command");
  expect(html).toContain(">running<");
  expect(html).toContain("tool-activity-running");
  expect(html).not.toContain("px-1 pr-2");
});

test("tool block keeps request and response summaries hidden while collapsed", () => {
  const html = renderToStaticMarkup(
    <ToolBlock
      item={{
        id: "tool-3",
        kind: "tool",
        toolName: "read",
        inputText: "src/ARCHITECTURE.md",
        outputText: "# Architecture\nDetails",
        isError: false,
        status: "done",
        timestamp: 300,
        toolCallId: "call-3",
        startedAt: 200,
        durationMs: 0,
        render: {
          inputSummary: "src/ARCHITECTURE.md",
          outputSummary: "1 # Architecture",
          blocks: [],
        },
      }}
    />,
  );

  expect(html).toContain("Read files");
  expect(html).not.toContain("0ms");
  expect(html).not.toContain("src/ARCHITECTURE.md");
  expect(html).not.toContain("1 # Architecture");
});

test("tool block treats namespaced request_user_input as user-input tool (hides output summary)", () => {
  const html = renderToStaticMarkup(
    <ToolBlock
      item={{
        id: "tool-4",
        kind: "tool",
        toolName: "overdare/request_user_input",
        inputText: '{"questions":[{"id":"q1"}]}',
        outputText: "[Done] Answer submitted",
        isError: false,
        status: "done",
        timestamp: 400,
        toolCallId: "call-4",
        startedAt: 300,
        durationMs: 15,
        render: {
          inputSummary: "Ask player",
          outputSummary: "Answer submitted",
          blocks: [],
        },
      }}
    />,
  );

  expect(html).toContain("Requested input");
  expect(html).not.toContain("Ask player");
  expect(html).not.toContain("Answer submitted");
});

test("tool block renders asset gallery previews expanded", () => {
  const html = renderToStaticMarkup(
    <ToolBlock
      item={{
        id: "tool-assets",
        kind: "tool",
        toolName: "overdaresearch",
        inputText: '{"source":"assets","query":"fountain classic stone"}',
        outputText: "Found assets",
        isError: false,
        status: "done",
        timestamp: 500,
        toolCallId: "call-assets",
        startedAt: 450,
        durationMs: 42,
        render: {
          inputSummary: "assets: fountain classic stone",
          outputSummary: "5 assets",
          blocks: [
            {
              type: "asset_gallery",
              title: "OVERDARE Assets",
              query: "fountain classic stone",
              items: [
                {
                  id: "asset-fountain-1",
                  title: "Classic Stone Fountain",
                  subtitle: "MODEL",
                  price: "Free",
                  thumbnailUrl: "https://assets.example/fountain.png",
                  metadata: [
                    { key: "assetType", value: "MODEL" },
                    { key: "category", value: "ENVIRONMENT" },
                  ],
                },
              ],
            },
          ],
        },
      }}
    />,
  );

  expect(html).toContain('data-asset-id="asset-fountain-1"');
  expect(html).toContain('src="https://assets.example/fountain.png"');
  expect(html).toContain("Classic Stone Fountain");
  expect(html).toContain("ENVIRONMENT · MODEL");
  expect(html).toContain("OVERDARE Assets");
  expect(html).toContain("1 result for &quot;fountain classic stone&quot;");
  expect(html).not.toContain('aria-label="Select Classic Stone Fountain"');
  expect(html).not.toContain("aria-pressed");
});

test("collab event block renders as a compact agent activity row", () => {
  const html = renderToStaticMarkup(
    <CollabEventBlock
      item={{
        id: "collab-1",
        kind: "collab",
        eventType: "spawn",
        childThreadId: "child-1",
        nickname: "Juniper",
        agentType: "explore",
        description: "Trace the rendering path",
        status: "completed",
        childTools: [],
        timestamp: 1,
      }}
    />,
  );

  expect(html).toContain('type="button"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain("Spawned Juniper [explore]");
  expect(html).toContain("completed");
  expect(html).toContain("text-success/85");
  expect(html).toContain("gap-2 py-0.5");
  expect(html).not.toContain("bg-surface-dark py-2.5");
  expect(html).not.toContain(">expand<");
  expect(html).not.toContain(">collapse<");
});

test("collab event expanded timeline renders compact child activity rows", () => {
  const html = renderToStaticMarkup(
    <CollabEventBlock
      initialOpen={true}
      item={{
        id: "collab-expanded-1",
        kind: "collab",
        eventType: "spawn",
        childThreadId: "child-expanded-1",
        nickname: "Camellia",
        agentType: "explore",
        description: "Analyze Lua and level hierarchy",
        status: "running",
        childTools: [
          {
            toolCallId: "tool-read-1",
            toolName: "read",
            status: "running",
            isError: false,
            inputText: '{"file_path":"/Volumes/overdare-newgame/Lua/FRU_RoundManager.lua","offset":1,"limit":400}',
            outputText: "undefined",
          },
        ],
        childTimeline: [
          {
            kind: "assistant",
            message: "**Inspecting files** I am planning to inspect files before using grep.",
          },
          {
            kind: "tool",
            toolCallId: "tool-grep-1",
            toolName: "grep",
            status: "done",
            isError: true,
            inputText: '{"pattern":"RoundState","path":"/Volumes/overdare-newgame"}',
            outputText: 'Error running grep: Executable not found in $PATH: "rg"',
          },
          {
            kind: "tool",
            toolCallId: "tool-read-1",
            toolName: "read",
            status: "running",
            isError: false,
            inputText: '{"file_path":"/Volumes/overdare-newgame/Lua/FRU_RoundManager.lua","offset":1,"limit":400}',
            outputText: "undefined",
          },
        ],
        timestamp: 1,
      }}
    />,
  );

  expect(html).toContain("Spawned Camellia [explore]");
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain("Analyze Lua and level hierarchy");
  expect(html).toContain("Thought: Inspecting files I am planning to inspect files before using grep.");
  expect(html).toContain("Search failed: pattern=RoundState, path=/Volumes/overdare-newgame");
  expect(html).toContain("Error running grep: Executable not found in $PATH");
  expect(html).toContain("Reading files: file_path=/Volumes/overdare-newgame/Lua/FRU_RoundManager.lua");
  expect(html).toContain("ml-7 space-y-0.5");
  expect(html).not.toContain("**Inspecting files**");
  expect(html).not.toContain("ㄴ");
  expect(html).not.toContain("&gt;undefined&lt;");
});

test("collab wait event shows animated spinner while agents are still running", () => {
  const html = renderToStaticMarkup(
    <CollabEventBlock
      item={{
        id: "collab-wait-1",
        kind: "collab",
        eventType: "wait",
        status: "running",
        agents: [
          {
            threadId: "child-1",
            nickname: "Juniper",
            status: "running",
            message: "Tracing UI state",
          },
        ],
        childTools: [],
        timestamp: 1,
      }}
    />,
  );

  expect(html).toContain("Waiting for Juniper");
  expect(html).toContain(">running<");
  expect(html).toContain("tool-activity-running");
  expect(html).not.toContain("px-1 pr-2");
});

test("collab wait timeout keeps ongoing spinner UI without explicit timeout label", () => {
  const html = renderToStaticMarkup(
    <CollabEventBlock
      item={{
        id: "collab-wait-timeout-1",
        kind: "collab",
        eventType: "wait",
        status: "running",
        timedOut: true,
        agents: [
          {
            threadId: "child-1",
            nickname: "Juniper",
            status: "running",
            message: "Still tracing UI state",
          },
        ],
        childTools: [],
        timestamp: 1,
      }}
    />,
  );

  expect(html).toContain("Waiting for Juniper");
  expect(html).toContain(">running<");
  expect(html).toContain("tool-activity-running");
  expect(html).not.toContain("timed out");
});

test("collab event spawn persistence key is stable across remount-friendly ids", () => {
  const keyA = getCollabEventPersistenceKey({
    id: "collab:spawn:call-1",
    kind: "collab",
    eventType: "spawn",
    childThreadId: "child-1",
    nickname: "Juniper",
    childTools: [],
    timestamp: 1,
  });
  const keyB = getCollabEventPersistenceKey({
    id: "history:collab:spawn:call-99",
    kind: "collab",
    eventType: "spawn",
    childThreadId: "child-1",
    nickname: "Juniper",
    childTools: [],
    timestamp: 2,
  });

  expect(keyA).toBe("spawn:child-1");
  expect(keyB).toBe("spawn:child-1");
});

test("collab event prefers live child timeline over loaded snapshot preview", () => {
  const liveTimeline = [{ kind: "assistant" as const, message: "live turn 6" }];
  const loadedPreview = {
    childTools: [],
    childMessages: ["stale snapshot"],
    childTimeline: [{ kind: "assistant" as const, message: "stale snapshot" }],
  };

  expect(resolveEffectiveTimeline(liveTimeline, loadedPreview)).toEqual(liveTimeline);
  expect(resolveEffectiveTimeline(undefined, loadedPreview)).toEqual(loadedPreview.childTimeline);
});

test("collab child snapshot preview merges tool start and completed rows by toolCallId", () => {
  const preview = deriveChildPreview({
    threadId: "child-1",
    cwd: "/repo",
    items: [
      {
        type: "toolCall",
        itemId: "tool:tc-ls",
        toolCallId: "tc-ls",
        toolName: "ls",
        input: { path: "/Users/devbv/git" },
        timestamp: 1,
        startedAt: 1,
      },
      {
        type: "toolCall",
        itemId: "tool:tc-ls",
        toolCallId: "tc-ls",
        toolName: "ls",
        input: { path: "/Users/devbv/git" },
        output: "diligent/",
        isError: false,
        timestamp: 2,
        startedAt: 1,
      },
    ],
    errors: [],
    hasFollowUp: false,
    entryCount: 2,
    isRunning: false,
    totalCost: 0,
  });

  expect(preview.childTools).toHaveLength(1);
  expect(preview.childTimeline).toHaveLength(1);
  expect(preview.childTools[0]).toMatchObject({ toolCallId: "tc-ls", status: "done", outputText: "diligent/" });
  expect(preview.childTimeline[0]).toMatchObject({ kind: "tool", toolCallId: "tc-ls", status: "done" });
});

test("collab group renders consecutive events directly without earlier-events toggle", () => {
  const html = renderToStaticMarkup(
    <CollabGroup
      items={[
        {
          id: "collab-1",
          kind: "collab",
          eventType: "spawn",
          childThreadId: "child-1",
          nickname: "Juniper",
          agentType: "explore",
          description: "Trace the rendering path",
          status: "running",
          childTools: [],
          timestamp: 1,
        },
        {
          id: "collab-2",
          kind: "collab",
          eventType: "spawn",
          childThreadId: "child-2",
          nickname: "Basil",
          agentType: "explore",
          description: "Inspect the reducer flow",
          status: "completed",
          childTools: [],
          timestamp: 2,
        },
      ]}
    />,
  );

  expect(html).toContain("Spawned Juniper [explore]");
  expect(html).toContain("Spawned Basil [explore]");
  expect(html).not.toContain("show earlier events");
});

test("extractPastedImageFiles returns empty array for null clipboard", () => {
  expect(extractPastedImageFiles(null)).toEqual([]);
});

test("extractPastedImageFiles ignores text-only clipboard items", () => {
  const clipboardData = createClipboardData({
    items: [{ kind: "string", type: "text/plain" }],
  });

  expect(extractPastedImageFiles(clipboardData)).toEqual([]);
});

test("extractPastedImageFiles returns supported image files from clipboard items", () => {
  const png = createClipboardFile("shot.png", "image/png");
  const jpeg = createClipboardFile("photo.jpg", "image/jpeg");
  const clipboardData = createClipboardData({
    items: [
      { kind: "file", type: "image/png", file: png },
      { kind: "file", type: "image/svg+xml", file: createClipboardFile("vector.svg", "image/svg+xml") },
      { kind: "file", type: "image/jpeg", file: jpeg },
    ],
  });

  expect(extractPastedImageFiles(clipboardData)).toEqual([png, jpeg]);
});

test("extractPastedImageFiles falls back to clipboard files when items are unavailable", () => {
  const gif = createClipboardFile("anim.gif", "image/gif");
  const txt = createClipboardFile("notes.txt", "text/plain");
  const clipboardData = createClipboardData({
    items: [],
    files: [gif, txt],
  });

  expect(extractPastedImageFiles(clipboardData)).toEqual([gif]);
});

test("normalizeImageFileName keeps existing file names", () => {
  const file = createClipboardFile("existing-name.webp", "image/webp");
  expect(normalizeImageFileName(file, 0, 12345)).toBe("existing-name.webp");
});

test("normalizeImageFileName generates PNG fallback names for empty clipboard file names", () => {
  const file = createClipboardFile("", "image/png");
  expect(normalizeImageFileName(file, 2, 12345)).toBe("pasted-image-12345-2.png");
});

test("normalizeImageFileName generates JPEG fallback names for blank clipboard file names", () => {
  const file = createClipboardFile("   ", "image/jpeg");
  expect(normalizeImageFileName(file, 1, 222)).toBe("pasted-image-222-1.jpg");
});

test("slash menu renders command list with listbox role", () => {
  const commands = [
    { name: "help", description: "Show available commands" },
    { name: "new", description: "Start a new conversation" },
    { name: "model", description: "Switch model" },
  ];

  const html = renderToStaticMarkup(<SlashMenu commands={commands} selectedIndex={0} onSelect={() => {}} />);

  expect(html).toContain('role="listbox"');
  expect(html).toContain("/help");
  expect(html).toContain("/new");
  expect(html).toContain("/model");
  expect(html).toContain("Show available commands");
});

test("slash menu highlights selected command with accent class", () => {
  const commands = [
    { name: "help", description: "Show available commands" },
    { name: "new", description: "Start a new conversation" },
  ];

  const html = renderToStaticMarkup(<SlashMenu commands={commands} selectedIndex={1} onSelect={() => {}} />);

  // The second item (index 1) should have accent highlight and aria-selected
  expect(html).toContain('aria-selected="true"');
  // Both items have role="option"
  const optionCount = (html.match(/role="option"/g) ?? []).length;
  expect(optionCount).toBe(2);
});

test("slash menu returns null for empty commands", () => {
  const html = renderToStaticMarkup(<SlashMenu commands={[]} selectedIndex={0} onSelect={() => {}} />);

  expect(html).toBe("");
});

test("ErrorBanner shows concise auth copy with Reconnect button", () => {
  const html = renderToStaticMarkup(
    <ErrorBanner
      error={{
        id: "event:error:1",
        message: "ChatGPT API error (401): unauthorized",
        name: "ProviderError",
        providerErrorType: "auth",
        fatal: false,
        timestamp: 1715562000000,
      }}
      onOpenProviders={() => {}}
    />,
  );

  expect(html).toContain("Provider authentication failed");
  expect(html).toContain("Reconnect this provider to continue.");
  expect(html).toContain("Reconnect");
  expect(html).not.toContain("ChatGPT API error (401): unauthorized");
  expect(html).not.toContain("ProviderError:");
});

test("MessageList renders shrink-safe question prompts in the feed", () => {
  const html = renderToStaticMarkup(
    <MessageList
      items={[]}
      threadStatus="idle"
      hasProvider={true}
      onOpenProviders={() => {}}
      onQuickConnectChatGPT={() => {}}
      questionPrompt={{
        request: {
          questions: [
            {
              id: "build_scope",
              header: "Build",
              question: "How far should I build in this pass?",
              options: [
                {
                  label: "Full Prototype",
                  description: "Add selection, different shooting, and first weapon-specific upgrades.",
                },
              ],
            },
          ],
        },
        answers: { build_scope: "Full Prototype" },
        onAnswerChange: () => {},
        onSubmit: () => {},
        onCancel: () => {},
      }}
    />,
  );

  expect(html).toContain("How far should I build in this pass?");
  expect(html).toContain('placeholder="or type a custom answer…"');
  expect(html).toContain("flex min-w-0 flex-1 flex-col");
  expect(html).toContain("min-w-0 truncate bg-transparent");
  expect(html).not.toContain("Start a new conversation");
});

test("ErrorBanner does not show Reconnect button on non-auth error", () => {
  const html = renderToStaticMarkup(
    <ErrorBanner
      error={{
        id: "event:error:2",
        message: "Rate limit exceeded",
        name: "ProviderError",
        providerErrorType: "rate_limit",
        fatal: false,
        timestamp: 1715562000000,
      }}
      onOpenProviders={() => {}}
    />,
  );

  expect(html).not.toContain("Reconnect");
});

test("AssetThumbnail renders the image when a url is present", () => {
  const html = renderToStaticMarkup(
    <AssetThumbnail asset={{ title: "Katana", thumbnailUrl: "https://assets.example/k.png" }} />,
  );
  expect(html).toContain("https://assets.example/k.png");
  expect(html).toContain('alt="Katana"');
});

test("AssetThumbnail falls back to the title initial when no url is present", () => {
  const html = renderToStaticMarkup(<AssetThumbnail asset={{ title: "katana" }} />);
  expect(html).not.toContain("<img");
  expect(html).toContain("K");
});

test("QuestionCard renders an asset thumbnail grid for display:asset questions", () => {
  const html = renderToStaticMarkup(
    <QuestionCard
      request={{
        questions: [
          {
            id: "asset",
            header: "Asset",
            question: 'Pick an asset for "katana"',
            display: "asset",
            options: [
              {
                label: "Katana, Rusty",
                description: "MODEL",
                value: "6584600",
                asset: { thumbnailUrl: "https://assets.example/k.png", price: "100" },
              },
            ],
          },
        ],
      }}
      answers={{}}
      onAnswerChange={() => {}}
      onSubmit={() => {}}
      onCancel={() => {}}
    />,
  );
  expect(html).toContain("https://assets.example/k.png");
  expect(html).toContain("Katana, Rusty");
  expect(html).toContain("100");
});

test("ErrorBanner keeps provider error details for non-auth errors without turn metadata", () => {
  const html = renderToStaticMarkup(
    <ErrorBanner
      error={{
        id: "event:error:3",
        message: "Anthropic thinking blocks require signature",
        name: "ProviderError",
        providerErrorType: "unknown",
        fatal: false,
        timestamp: 1715562000000,
        turnId: "turn-c9b7d446",
      }}
      onOpenProviders={() => {}}
    />,
  );

  expect(html).toContain("ProviderError: Anthropic thinking blocks require signature");
  expect(html).not.toContain("Turn:");
  expect(html).not.toContain("turn-c9b7d446");
});
