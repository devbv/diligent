// @summary DOM interaction tests for config modal skill settings save behavior
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, expect, test } from "bun:test";
import type {
  ExperimentsListResponse,
  ExperimentsSetParams,
  ExperimentsSetResponse,
  SkillsListResponse,
  SkillsSetParams,
  SkillsSetResponse,
  SubagentsListResponse,
  SubagentsSetParams,
  SubagentsSetResponse,
  ToolsListResponse,
  ToolsSetParams,
  ToolsSetResponse,
} from "@diligent/protocol";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ToolSettingsModal } from "../../../src/client/components/ToolSettingsModal";

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  void GlobalRegistrator.unregister();
});

const toolState: ToolsListResponse = {
  configPath: "/home/user/.diligent/config.jsonc",
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
  ],
  plugins: [],
};

const skillState: SkillsListResponse = {
  configPath: "/home/user/.diligent/config.jsonc",
  appliesOnNextTurn: true,
  skillsEnabled: true,
  skillsEnabledControlledBy: "default",
  skills: [
    {
      name: "tech-lead",
      description: "Review architecture sustainability.",
      source: "global",
      globalEnabled: true,
      effectiveEnabled: true,
      available: true,
      controlledBy: "default",
      reason: "enabled",
    },
    {
      name: "project-only",
      description: "A project controlled skill.",
      source: "project",
      globalEnabled: true,
      effectiveEnabled: false,
      available: false,
      controlledBy: "project",
      reason: "disabled_by_user",
    },
  ],
};

const subagentState: SubagentsListResponse = {
  configPath: "/home/user/.diligent/config.jsonc",
  appliesOnNextTurn: true,
  subagents: [
    {
      name: "general",
      description: "Required execution fallback.",
      source: "builtin",
      required: true,
      globalEnabled: true,
      effectiveEnabled: true,
      available: true,
      controlledBy: "required",
      reason: "required_builtin",
    },
    {
      name: "explore",
      description: "Explore the codebase.",
      source: "builtin",
      required: false,
      globalEnabled: true,
      effectiveEnabled: true,
      available: true,
      controlledBy: "default",
      reason: "enabled",
    },
    {
      name: "project-reviewer",
      description: "Project-controlled reviewer.",
      source: "project",
      required: false,
      globalEnabled: true,
      effectiveEnabled: false,
      available: false,
      controlledBy: "project",
      reason: "disabled_by_user",
    },
  ],
};

const experimentState: ExperimentsListResponse = {
  configPath: "/home/user/.overdare/config.jsonc",
  appliesOnNextTurn: true,
  experiments: [
    {
      id: "procedural",
      title: "Procedural generation",
      description: "Create scenes from reusable Luau recipes.",
      enabled: false,
      defaultEnabled: false,
    },
  ],
};

function renderModal(options: {
  onSave?: (params: ToolsSetParams) => Promise<ToolsSetResponse>;
  onSaveSkills?: (params: SkillsSetParams) => Promise<SkillsSetResponse>;
  onSaveSubagents?: (params: SubagentsSetParams) => Promise<SubagentsSetResponse>;
  onSaveExperiments?: (params: ExperimentsSetParams) => Promise<ExperimentsSetResponse>;
  withExperiments?: boolean;
  onSkillsChange?: (skills: Array<{ name: string; description: string }>) => void;
  onClose?: () => void;
}) {
  const rootElement = document.createElement("div");
  document.body.appendChild(rootElement);
  const root = createRoot(rootElement);
  return {
    rootElement,
    root,
    render: async () => {
      await act(async () => {
        root.render(
          createElement(ToolSettingsModal, {
            threadId: "thread-1",
            initialState: toolState,
            initialSkillState: skillState,
            onList: async () => toolState,
            onSave: options.onSave ?? (async () => toolState),
            onListSkills: async () => skillState,
            onSaveSkills: options.onSaveSkills ?? (async () => skillState),
            onListExperiments: options.withExperiments ? async () => experimentState : undefined,
            onSaveExperiments: options.withExperiments
              ? (options.onSaveExperiments ?? (async () => experimentState))
              : undefined,
            onListSubagents: async () => subagentState,
            onSaveSubagents: options.onSaveSubagents ?? (async () => subagentState),
            onSkillsChange: options.onSkillsChange,
            onClose: options.onClose ?? (() => {}),
          }),
        );
      });
    },
  };
}

function checkboxFor(labelText: string): HTMLInputElement {
  const labels = Array.from(document.querySelectorAll("label"));
  const label = labels.find((entry) => entry.textContent?.includes(labelText));
  const checkbox = label?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  expect(checkbox).not.toBeNull();
  return checkbox!;
}

function saveButton(): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find((entry) => entry.textContent === "Save");
  expect(button).not.toBeNull();
  return button!;
}

test("skill toggle save sends changed non-project overrides and refreshes active skills", async () => {
  const skillPayloads: SkillsSetParams[] = [];
  const refreshedSkills: Array<{ name: string; description: string }>[] = [];
  const closed: string[] = [];
  const { rootElement, root, render } = renderModal({
    onSaveSkills: async (params) => {
      skillPayloads.push(params);
      return {
        ...skillState,
        skills: skillState.skills.map((skill) =>
          skill.name === "tech-lead"
            ? { ...skill, globalEnabled: false, effectiveEnabled: false, available: false, reason: "disabled_by_user" }
            : skill,
        ),
      };
    },
    onSkillsChange: (skills) => refreshedSkills.push(skills),
    onClose: () => closed.push("closed"),
  });

  await render();
  await act(async () => {
    checkboxFor("tech-lead").click();
  });
  await act(async () => {
    saveButton().click();
  });

  expect(skillPayloads).toEqual([{ threadId: "thread-1", overrides: { "tech-lead": false } }]);
  expect(refreshedSkills).toEqual([[]]);
  expect(closed).toEqual(["closed"]);

  await act(async () => root.unmount());
  rootElement.remove();
});

test("product experiment is hidden without server advertisement and saves one coupled override when advertised", async () => {
  const payloads: ExperimentsSetParams[] = [];
  const hidden = renderModal({});
  await hidden.render();
  expect(document.body.textContent).not.toContain("Procedural generation");
  await act(async () => hidden.root.unmount());
  hidden.rootElement.remove();

  const shown = renderModal({
    withExperiments: true,
    onSaveExperiments: async (params) => {
      payloads.push(params);
      return { ...experimentState, experiments: [{ ...experimentState.experiments[0]!, enabled: true }] };
    },
  });
  await shown.render();
  await act(async () => checkboxFor("Procedural generation").click());
  await act(async () => saveButton().click());
  expect(payloads).toEqual([{ threadId: "thread-1", overrides: { procedural: true } }]);
  await act(async () => shown.root.unmount());
  shown.rootElement.remove();
});

test("project-controlled skill rows are read-only and omitted from save payload", async () => {
  const skillPayloads: SkillsSetParams[] = [];
  const { rootElement, root, render } = renderModal({
    onSaveSkills: async (params) => {
      skillPayloads.push(params);
      return skillState;
    },
  });

  await render();
  const projectCheckbox = checkboxFor("project-only");
  expect(projectCheckbox.disabled).toBe(true);
  await act(async () => {
    projectCheckbox.click();
    checkboxFor("tech-lead").click();
  });
  await act(async () => {
    saveButton().click();
  });

  expect(skillPayloads).toEqual([{ threadId: "thread-1", overrides: { "tech-lead": false } }]);

  await act(async () => root.unmount());
  rootElement.remove();
});

test("tool and skill writes run sequentially", async () => {
  const order: string[] = [];
  const { rootElement, root, render } = renderModal({
    onSave: async () => {
      order.push("tools:start");
      await Promise.resolve();
      order.push("tools:end");
      return toolState;
    },
    onSaveSkills: async () => {
      order.push("skills:start");
      order.push("skills:end");
      return skillState;
    },
  });

  await render();
  await act(async () => {
    checkboxFor("bash").click();
    checkboxFor("tech-lead").click();
  });
  await act(async () => {
    saveButton().click();
  });

  expect(order).toEqual(["tools:start", "tools:end", "skills:start", "skills:end"]);

  await act(async () => root.unmount());
  rootElement.remove();
});

test("tools, skills, and subagents writes run sequentially", async () => {
  const order: string[] = [];
  const { rootElement, root, render } = renderModal({
    onSave: async () => {
      order.push("tools");
      return toolState;
    },
    onSaveSkills: async () => {
      order.push("skills");
      return skillState;
    },
    onSaveSubagents: async () => {
      order.push("subagents");
      return subagentState;
    },
  });

  await render();
  await act(async () => {
    checkboxFor("bash").click();
    checkboxFor("tech-lead").click();
    checkboxFor("explore").click();
  });
  await act(async () => {
    saveButton().click();
  });

  expect(order).toEqual(["tools", "skills", "subagents"]);
  await act(async () => root.unmount());
  rootElement.remove();
});

test("required and project-controlled subagents are read-only and omitted from payload", async () => {
  const payloads: SubagentsSetParams[] = [];
  const { rootElement, root, render } = renderModal({
    onSaveSubagents: async (params) => {
      payloads.push(params);
      return subagentState;
    },
  });

  await render();
  expect(checkboxFor("general").disabled).toBe(true);
  expect(checkboxFor("project-reviewer").disabled).toBe(true);
  await act(async () => {
    checkboxFor("general").click();
    checkboxFor("project-reviewer").click();
    checkboxFor("explore").click();
  });
  await act(async () => {
    saveButton().click();
  });

  expect(payloads).toEqual([{ threadId: "thread-1", overrides: { explore: false } }]);
  await act(async () => root.unmount());
  rootElement.remove();
});

test("partial failure keeps modal open with already persisted message", async () => {
  const closed: string[] = [];
  const { rootElement, root, render } = renderModal({
    onSave: async () => toolState,
    onSaveSkills: async () => {
      throw new Error("skill write failed");
    },
    onClose: () => closed.push("closed"),
  });

  await render();
  await act(async () => {
    checkboxFor("bash").click();
    checkboxFor("tech-lead").click();
  });
  await act(async () => {
    saveButton().click();
  });

  expect(closed).toEqual([]);
  expect(document.body.textContent).toContain("Saved tool settings before the failure. skill write failed");

  await act(async () => root.unmount());
  rootElement.remove();
});

test("subagent failure reports earlier persisted sections and keeps modal open", async () => {
  const closed: string[] = [];
  const { rootElement, root, render } = renderModal({
    onSave: async () => toolState,
    onSaveSkills: async () => skillState,
    onSaveSubagents: async () => {
      throw new Error("subagent write failed");
    },
    onClose: () => closed.push("closed"),
  });

  await render();
  await act(async () => {
    checkboxFor("bash").click();
    checkboxFor("tech-lead").click();
    checkboxFor("explore").click();
  });
  await act(async () => {
    saveButton().click();
  });

  expect(closed).toEqual([]);
  expect(document.body.textContent).toContain(
    "Saved tool settings and skill settings before the failure. subagent write failed",
  );

  await act(async () => root.unmount());
  rootElement.remove();
});
