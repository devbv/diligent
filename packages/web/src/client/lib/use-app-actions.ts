// @summary App action handlers for sending, image uploads, slash commands, and turn controls

import type {
  ImageUploadAttachment,
  Mode,
  ModelInfo,
  SkillInfo,
  ThinkingEffort,
  ThreadReadResponse,
} from "@diligent/protocol";
import { DILIGENT_CLIENT_REQUEST_METHODS } from "@diligent/protocol";
import { type Dispatch, type MutableRefObject, type RefObject, type SetStateAction, useCallback } from "react";
import { toWebImageUrl } from "../../shared/image-routes";
import { type AgentContextItem, prependContextToMessage } from "./agent-native-bridge";
import type { AppAction, PendingImage } from "./app-state";
import { fileToBase64, normalizeImageFileName, replaceThreadUrl } from "./app-utils";
import {
  findModelInfo,
  getThinkingEffortUsage,
  normalizeThinkingEffort,
  supportsThinkingEffort,
  supportsThinkingNone,
} from "./model-thinking-helpers";
import type { WebRpcClient } from "./rpc-client";
import { parseSlashCommand, type SlashCommand } from "./slash-commands";
import type { ThreadState } from "./thread-store";

const IMAGE_UPLOAD_INDICATOR_DELAY_MS = 200;

export function clearComposerInputAfterSend({
  activeThreadId,
  clearThreadInput,
  clearDraftInput,
  clearContextItems,
}: {
  activeThreadId: string | null;
  clearThreadInput: (threadId: string) => void;
  clearDraftInput: () => void;
  clearContextItems: () => void;
}): void {
  clearContextItems();
  if (activeThreadId) {
    clearThreadInput(activeThreadId);
    return;
  }
  clearDraftInput();
}

type SteeringControl = {
  pendingAbortRestartMessageRef: MutableRefObject<string | null>;
  suppressNextSteeringInjectedRef: MutableRefObject<boolean>;
};

export async function prepareNewThreadForFirstMessage({
  rpc,
  mode,
  cwd,
  model,
  effort,
  activateServerThread,
  applySessionModel,
  dispatch,
  localText,
  contextItems,
  images,
}: {
  rpc: WebRpcClient;
  mode: Mode;
  cwd: string;
  model?: string;
  effort: ThinkingEffort;
  activateServerThread: (threadId: string) => Promise<ThreadReadResponse>;
  applySessionModel: (sessionModel?: string) => Promise<void>;
  dispatch: Dispatch<AppAction>;
  localText: string;
  contextItems: AgentContextItem[];
  images: PendingImage[];
}): Promise<{ threadId: string; history: ThreadReadResponse }> {
  const started = await rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_START, {
    cwd: cwd || "/",
    mode,
    effort,
    model,
  });
  const threadId = started.threadId;
  const history = await activateServerThread(threadId);
  dispatch({ type: "hydrate", payload: { threadId, mode, history } });
  if (typeof window !== "undefined") {
    replaceThreadUrl(threadId);
  }
  dispatch({ type: "local_user", payload: { text: localText, images, contextItems } });
  await applySessionModel(history.currentModel);
  return { threadId, history };
}

export async function runThreadCompaction({
  rpc,
  threadId,
  mode,
  dispatch,
}: {
  rpc: WebRpcClient;
  threadId: string;
  mode: Mode;
  dispatch: Dispatch<AppAction>;
}): Promise<void> {
  try {
    await rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_COMPACT_START, { threadId }, null);
    const history = await rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_READ, {
      threadId,
    });
    dispatch({ type: "hydrate", payload: { threadId, mode, history } });
  } catch (error) {
    dispatch({ type: "compaction_error" });
    dispatch({
      type: "show_info_toast",
      payload: error instanceof Error ? error.message : "Compaction failed.",
    });
  }
}

export function getModelChangeThreadId(activeThreadId: string | null): string | undefined {
  return activeThreadId ?? undefined;
}

export async function applyModeChange({
  rpc,
  activeThreadId,
  mode,
  dispatch,
}: {
  rpc: WebRpcClient | null;
  activeThreadId: string | null;
  mode: Mode;
  dispatch: Dispatch<AppAction>;
}): Promise<void> {
  dispatch({ type: "set_mode", payload: mode });
  if (!rpc || !activeThreadId) return;
  await rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.MODE_SET, { threadId: activeThreadId, mode });
}

export function normalizeUploadedImageAttachment(attachment: ImageUploadAttachment): PendingImage {
  const webUrl = attachment.webUrl ?? toWebImageUrl(attachment.path);
  if (!attachment.webUrl && webUrl === attachment.path) {
    throw new Error("Image upload did not return a browser-accessible URL.");
  }
  return { ...attachment, webUrl };
}

export async function waitForDelayedIndicator<T>({
  task,
  delayMs,
  showIndicator,
}: {
  task: Promise<T>;
  delayMs: number;
  showIndicator: () => void;
}): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const delay = new Promise<"show">((resolve) => {
    timer = setTimeout(() => resolve("show"), delayMs);
  });

  try {
    const first = await Promise.race([
      task.then((value) => ({ type: "complete" as const, value })),
      delay.then(() => ({ type: "show" as const })),
    ]);

    if (first.type === "complete") {
      return first.value;
    }

    showIndicator();
    return await task;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function useAppActions({
  rpcRef,
  state,
  stateRef,
  dispatch,
  activeInput,
  activeContextItems,
  pendingImages,
  canSend,
  isUploadingImages,
  supportsVision,
  effort,
  slashCommands,
  currentModel,
  availableModels,
  currentModelRef,
  clearThreadInput,
  clearDraftInput,
  clearActiveContextItems,
  setPendingImages,
  setIsUploadingImages,
  setShowImageUploadIndicator,
  setEffortState,
  changeModel,
  startNewThread,
  openThread,
  openMcpModal,
  bumpMcpRefreshNonce,
  setSkills,
  steeringControl,
  modeRef,
  cwdRef,
  applySessionModel,
  activateServerThread,
  refreshThreadList,
}: {
  rpcRef: RefObject<WebRpcClient | null>;
  state: ThreadState;
  stateRef: RefObject<ThreadState>;
  dispatch: Dispatch<AppAction>;
  activeInput: string;
  activeContextItems: AgentContextItem[];
  pendingImages: PendingImage[];
  canSend: boolean;
  isUploadingImages: boolean;
  supportsVision: boolean;
  effort: ThinkingEffort;
  slashCommands: SlashCommand[];
  currentModel: string;
  availableModels: ModelInfo[];
  currentModelRef: RefObject<string>;
  clearThreadInput: (threadId: string) => void;
  clearDraftInput: () => void;
  clearActiveContextItems: () => void;
  setPendingImages: Dispatch<SetStateAction<PendingImage[]>>;
  setIsUploadingImages: Dispatch<SetStateAction<boolean>>;
  setShowImageUploadIndicator: Dispatch<SetStateAction<boolean>>;
  setEffortState: Dispatch<SetStateAction<ThinkingEffort>>;
  changeModel: (modelId: string, threadId?: string) => Promise<void>;
  startNewThread: () => Promise<void>;
  openThread: (threadId: string) => Promise<void>;
  openMcpModal: () => void;
  bumpMcpRefreshNonce: () => void;
  setSkills: Dispatch<SetStateAction<SkillInfo[]>>;
  steeringControl: SteeringControl;
  modeRef: RefObject<Mode>;
  cwdRef: RefObject<string>;
  applySessionModel: (sessionModel?: string) => Promise<void>;
  activateServerThread: (threadId: string) => Promise<ThreadReadResponse>;
  refreshThreadList: (rpc?: WebRpcClient | null) => Promise<void>;
}) {
  const sendMessage = useCallback(async (): Promise<void> => {
    const rpc = rpcRef.current;
    if (!rpc || !canSend) return;
    const typedMessage = activeInput.trim();
    const message = prependContextToMessage(typedMessage, activeContextItems);
    const images = pendingImages;
    const existingThreadId = state.activeThreadId;
    clearComposerInputAfterSend({
      activeThreadId: existingThreadId,
      clearThreadInput,
      clearDraftInput,
      clearContextItems: clearActiveContextItems,
    });
    setPendingImages([]);

    try {
      let threadId = existingThreadId;
      if (!threadId) {
        const prepared = await prepareNewThreadForFirstMessage({
          rpc,
          mode: modeRef.current,
          cwd: cwdRef.current || "/",
          model: currentModelRef.current || undefined,
          effort,
          activateServerThread,
          applySessionModel,
          dispatch,
          localText: typedMessage,
          contextItems: activeContextItems,
          images,
        });
        threadId = prepared.threadId;
      } else {
        dispatch({ type: "local_user", payload: { text: typedMessage, images, contextItems: activeContextItems } });
      }

      if (state.items.length === 0 && threadId) {
        dispatch({
          type: "optimistic_thread",
          payload: { threadId, message: typedMessage || "[image]" },
        });
      }

      const content = [
        ...(message ? [{ type: "text" as const, text: message }] : []),
        ...images.map((image) => ({
          type: "local_image" as const,
          path: image.path,
          mediaType: image.mediaType,
          fileName: image.fileName,
        })),
      ];
      await rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.TURN_START, {
        threadId,
        message,
        attachments: images.map((image) => ({
          type: "local_image" as const,
          path: image.path,
          mediaType: image.mediaType,
          fileName: image.fileName,
        })),
        content,
        model: currentModelRef.current || undefined,
      });
      await refreshThreadList(rpc);
    } catch (error) {
      console.error(error);
    }
  }, [
    rpcRef,
    state,
    canSend,
    activeInput,
    activeContextItems,
    pendingImages,
    clearThreadInput,
    clearDraftInput,
    clearActiveContextItems,
    setPendingImages,
    dispatch,
    currentModelRef,
    modeRef,
    cwdRef,
    effort,
    applySessionModel,
    activateServerThread,
    refreshThreadList,
  ]);

  const setMode = useCallback(
    async (mode: Mode): Promise<void> => {
      await applyModeChange({ rpc: rpcRef.current, activeThreadId: state.activeThreadId, mode, dispatch });
    },
    [rpcRef, state.activeThreadId, dispatch],
  );

  const setEffort = useCallback(
    async (nextEffort: ThinkingEffort): Promise<void> => {
      const modelInfo = findModelInfo(availableModels, currentModel);
      const unsupportedMinimal =
        nextEffort === "none" && modelInfo?.supportsThinking === true && !supportsThinkingNone(modelInfo);
      const unsupportedXhigh =
        nextEffort === "xhigh" && modelInfo !== undefined && !supportsThinkingEffort(modelInfo, nextEffort);
      if (unsupportedMinimal || unsupportedXhigh) {
        dispatch({
          type: "show_info_toast",
          payload:
            nextEffort === "none"
              ? "This model does not support minimal thinking."
              : `Thinking effort "${nextEffort}" is not supported for this model.`,
        });
        return;
      }
      // Always update local state so draft (new conversation) picks up the change.
      setEffortState(nextEffort);
      // Persist to server only when a thread is active.
      const rpc = rpcRef.current;
      if (rpc && state.activeThreadId) {
        await rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.EFFORT_SET, {
          threadId: state.activeThreadId,
          effort: nextEffort,
        });
      }
    },
    [rpcRef, state.activeThreadId, availableModels, currentModel, dispatch, setEffortState],
  );

  const handleCompactionClick = useCallback(() => {
    void (async () => {
      const rpc = rpcRef.current;
      if (!rpc || !state.activeThreadId || state.isCompacting) return;
      await runThreadCompaction({
        rpc,
        threadId: state.activeThreadId,
        mode: state.mode,
        dispatch,
      });
    })();
  }, [rpcRef, state.activeThreadId, state.mode, state.isCompacting, dispatch]);

  const handleAddImages = useCallback(
    async (files: FileList | File[]): Promise<void> => {
      const rpc = rpcRef.current;
      if (!rpc || isUploadingImages) return;

      const fileList = Array.from(files);
      if (pendingImages.length + fileList.length > 4) {
        dispatch({ type: "show_info_toast", payload: "You can attach up to 4 images per message." });
        return;
      }
      if (!supportsVision) {
        dispatch({ type: "show_info_toast", payload: "The selected model does not support image input." });
        return;
      }

      const allowedTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
      const uploadTimestamp = Date.now();
      const uploads: Array<{
        file: File;
        fileName: string;
        mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
      }> = [];

      for (const [index, file] of fileList.entries()) {
        const normalizedFileName = normalizeImageFileName(file, index, uploadTimestamp);
        if (!allowedTypes.has(file.type)) {
          dispatch({ type: "show_info_toast", payload: `Unsupported image type: ${normalizedFileName}` });
          return;
        }
        if (file.size > 10 * 1024 * 1024) {
          dispatch({ type: "show_info_toast", payload: `Image exceeds 10 MB: ${normalizedFileName}` });
          return;
        }

        uploads.push({
          file,
          fileName: normalizedFileName,
          mediaType: file.type as "image/png" | "image/jpeg" | "image/webp" | "image/gif",
        });
      }

      setIsUploadingImages(true);
      setShowImageUploadIndicator(false);
      try {
        const uploadTask = (async (): Promise<PendingImage[]> => {
          const uploaded: PendingImage[] = [];
          for (const upload of uploads) {
            const dataBase64 = await fileToBase64(upload.file);
            const result = await rpc.webRequest(DILIGENT_CLIENT_REQUEST_METHODS.IMAGE_UPLOAD, {
              threadId: state.activeThreadId ?? undefined,
              fileName: upload.fileName,
              mediaType: upload.mediaType,
              dataBase64,
            });
            uploaded.push(normalizeUploadedImageAttachment(result.attachment));
          }
          return uploaded;
        })();

        const uploaded = await waitForDelayedIndicator({
          task: uploadTask,
          delayMs: IMAGE_UPLOAD_INDICATOR_DELAY_MS,
          showIndicator: () => setShowImageUploadIndicator(true),
        });

        setPendingImages((previous) => [...previous, ...uploaded]);
      } catch (error) {
        dispatch({ type: "show_info_toast", payload: "Failed to upload images." });
        console.error(error);
      } finally {
        setIsUploadingImages(false);
        setShowImageUploadIndicator(false);
      }
    },
    [
      rpcRef,
      isUploadingImages,
      pendingImages.length,
      supportsVision,
      setIsUploadingImages,
      setShowImageUploadIndicator,
      state.activeThreadId,
      setPendingImages,
      dispatch,
    ],
  );

  const handleRemovePendingImage = useCallback(
    (path: string) => {
      setPendingImages((previous) => previous.filter((image) => image.path !== path));
    },
    [setPendingImages],
  );

  const handleSlashCommand = useCallback(
    (name: string, arg?: string) => {
      const rpc = rpcRef.current;
      const activeThreadId = state.activeThreadId;

      if (activeThreadId) {
        clearThreadInput(activeThreadId);
      }

      switch (name) {
        case "help": {
          const names = slashCommands.map((command) => `/${command.name}`).join(", ");
          dispatch({ type: "show_info_toast", payload: `Commands: ${names}` });
          return;
        }
        case "new":
          void startNewThread();
          return;
        case "resume":
          if (!arg) {
            dispatch({ type: "show_info_toast", payload: "Usage: /resume <thread-id>" });
            return;
          }
          void openThread(arg);
          return;
        case "model": {
          if (!arg) {
            dispatch({ type: "show_info_toast", payload: "Usage: /model <model-id>" });
            return;
          }

          const exists = availableModels.some((model) => model.id === arg);
          if (!exists) {
            dispatch({ type: "show_info_toast", payload: `Unknown model: ${arg}` });
            return;
          }

          void changeModel(arg, getModelChangeThreadId(activeThreadId)).then(() => {
            const modelInfo = availableModels.find((model) => model.id === arg);
            const normalizedEffort = normalizeThinkingEffort(modelInfo, effort);
            if (normalizedEffort !== effort) {
              setEffortState(normalizedEffort);
              dispatch({
                type: "show_info_toast",
                payload: `Model switched to ${arg}. Thinking adjusted to ${normalizedEffort}.`,
              });
              return;
            }
            dispatch({ type: "show_info_toast", payload: `Model switched to ${arg}` });
          });
          return;
        }
        case "effort": {
          const modelInfo = findModelInfo(availableModels, currentModel);
          if (modelInfo && !modelInfo.supportsThinking) {
            dispatch({ type: "show_info_toast", payload: "This model does not support thinking effort settings." });
            return;
          }
          const usage = `/effort <${getThinkingEffortUsage(modelInfo)}>`;
          if (!arg) {
            dispatch({ type: "show_info_toast", payload: `Usage: ${usage}` });
            return;
          }
          const normalized = arg.toLowerCase() === "minimal" ? "none" : arg.toLowerCase();
          if (!["none", "low", "medium", "high", "xhigh", "max"].includes(normalized)) {
            dispatch({ type: "show_info_toast", payload: `Unknown effort: ${arg}. Usage: ${usage}` });
            return;
          }
          void setEffort(normalized as ThinkingEffort);
          return;
        }
        case "mcp": {
          if (!rpc) {
            dispatch({ type: "show_info_toast", payload: "Not connected to the app server." });
            return;
          }
          const [sub, server] = (arg ?? "").trim().split(/\s+/).filter(Boolean);
          if (!sub || sub === "list") {
            openMcpModal();
            return;
          }
          if (sub === "login" || sub === "logout") {
            if (!server) {
              dispatch({ type: "show_info_toast", payload: `Usage: /mcp ${sub} <server>` });
              return;
            }
            if (sub === "login") {
              // Open the modal so the user sees the status flip once login completes, then let the
              // app-server open the browser and drive OAuth (completion arrives via notification).
              openMcpModal();
              dispatch({ type: "show_info_toast", payload: `Opening browser for "${server}" authorization…` });
              void rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.MCP_LOGIN_START, { server }).catch((cause) => {
                dispatch({
                  type: "show_info_toast",
                  payload: `Login failed for "${server}": ${cause instanceof Error ? cause.message : String(cause)}`,
                });
              });
              return;
            }
            void rpc
              .request(DILIGENT_CLIENT_REQUEST_METHODS.MCP_LOGOUT, { server })
              .then(() => {
                dispatch({ type: "show_info_toast", payload: `Cleared stored credentials for "${server}".` });
                bumpMcpRefreshNonce();
              })
              .catch((cause) => {
                dispatch({
                  type: "show_info_toast",
                  payload: `Logout failed for "${server}": ${cause instanceof Error ? cause.message : String(cause)}`,
                });
              });
            return;
          }
          dispatch({
            type: "show_info_toast",
            payload: "Usage: /mcp list | login <server> | logout <server>",
          });
          return;
        }
        case "reload": {
          if (!rpc) {
            dispatch({ type: "show_info_toast", payload: "Not connected to the app server." });
            return;
          }
          void rpc
            .request(DILIGENT_CLIENT_REQUEST_METHODS.CONFIG_RELOAD, {})
            .then((result) => {
              setSkills(result.skills);
              dispatch({ type: "show_info_toast", payload: "Reloaded config, skills, agents, tools & MCP servers." });
            })
            .catch((cause) => {
              dispatch({
                type: "show_info_toast",
                payload: `Reload failed: ${cause instanceof Error ? cause.message : String(cause)}`,
              });
            });
          return;
        }
        default: {
          const isSkill = slashCommands.some((command) => command.name === name && command.isSkill);
          if (isSkill && rpc && activeThreadId) {
            const message = arg ? `/${name} ${arg}` : `/${name}`;
            dispatch({ type: "local_user", payload: { text: message, images: [] } });
            void rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.TURN_START, {
              threadId: activeThreadId,
              message,
              content: [{ type: "text" as const, text: message }],
            });
            return;
          }
          dispatch({ type: "show_info_toast", payload: `Unknown command: /${name}` });
        }
      }
    },
    [
      rpcRef,
      state.activeThreadId,
      clearThreadInput,
      slashCommands,
      dispatch,
      startNewThread,
      openThread,
      openMcpModal,
      bumpMcpRefreshNonce,
      setSkills,
      availableModels,
      changeModel,
      effort,
      setEffortState,
      currentModel,
      setEffort,
    ],
  );

  const handleSend = useCallback(() => {
    const parsedCommand = parseSlashCommand(activeInput);
    if (parsedCommand) {
      const command = slashCommands.find((item) => item.name === parsedCommand.name);
      if (command) {
        handleSlashCommand(parsedCommand.name, parsedCommand.args);
        return;
      }
    }
    void sendMessage();
  }, [activeInput, slashCommands, handleSlashCommand, sendMessage]);

  const handleInterrupt = useCallback(() => {
    void (async () => {
      const rpc = rpcRef.current;
      const threadId = state.activeThreadId;
      if (!rpc || !threadId) return;
      steeringControl.pendingAbortRestartMessageRef.current = stateRef.current.pendingSteers[0]?.content ?? null;
      steeringControl.suppressNextSteeringInjectedRef.current =
        steeringControl.pendingAbortRestartMessageRef.current !== null;
      try {
        await rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.TURN_INTERRUPT, { threadId });
      } catch (error) {
        steeringControl.pendingAbortRestartMessageRef.current = null;
        steeringControl.suppressNextSteeringInjectedRef.current = false;
        console.error("[App] turn/interrupt failed:", error);
      }
    })();
  }, [rpcRef, state.activeThreadId, stateRef, steeringControl]);

  const handleModeChange = useCallback(
    (mode: Mode) => {
      void setMode(mode);
    },
    [setMode],
  );

  const handleEffortChange = useCallback(
    (nextEffort: ThinkingEffort) => {
      void setEffort(nextEffort);
    },
    [setEffort],
  );

  const handleModelChange = useCallback(
    (modelId: string) => {
      void changeModel(modelId, getModelChangeThreadId(state.activeThreadId));
    },
    [changeModel, state.activeThreadId],
  );

  const handleAddImagesToDock = useCallback(
    (files: FileList | File[]) => {
      void handleAddImages(files);
    },
    [handleAddImages],
  );

  return {
    handleSend,
    handleInterrupt,
    handleModeChange,
    handleEffortChange,
    handleModelChange,
    handleCompactionClick,
    handleAddImagesToDock,
    handleRemovePendingImage,
    handleSlashCommand,
  };
}
