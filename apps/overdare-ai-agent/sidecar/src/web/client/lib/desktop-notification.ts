// @summary Desktop-only OS notification helpers for background turn completion and pending prompts

import { createLogger, type Logger } from "@diligent/logging";
import type { DiligentServerNotification, DiligentServerRequest } from "@diligent/protocol";
import { DILIGENT_SERVER_NOTIFICATION_METHODS, DILIGENT_SERVER_REQUEST_METHODS } from "@diligent/protocol";
import { APP_PROJECT_NAME } from "./app-config";

type NotificationPermission = "default" | "denied" | "granted";

type NotificationActionType = {
  id: string;
  actions: Array<{ id: string; title: string; foreground?: boolean }>;
};

type NotificationApi = {
  isPermissionGranted: () => Promise<boolean>;
  requestPermission: () => Promise<NotificationPermission>;
  registerActionTypes: (types: NotificationActionType[]) => Promise<void>;
  sendNotification: (options: {
    id: number;
    title: string;
    body: string;
    actionTypeId?: string;
    extra?: Record<string, unknown>;
  }) => Promise<void>;
  onAction: (
    callback: (notification: { extra?: Record<string, unknown> }) => void,
  ) => Promise<{ unregister: () => void }>;
};

type NotificationEnvironment = {
  isDesktop: () => boolean;
  isBackgrounded: () => boolean;
  createApi: () => Promise<NotificationApi | null>;
};

type NotifyPayload = {
  id: number;
  title: string;
  body: string;
  dedupeKey: string;
  extra?: Record<string, unknown>;
};

type NotifyContext = {
  source: "turn_completed" | "server_request";
};

const REQUEST_DEDUPE_TTL_MS = 30_000;
const NOTIFICATION_THREAD_ID_KEY = "threadId";
const NOTIFICATION_ACTION_TYPE_ID = "diligent-open";
export const DESKTOP_NOTIFICATIONS_STORAGE_KEY = "diligent.desktopNotifications.enabled";
const MAX_NOTIFICATION_ID = 2_147_483_647;

const defaultLogger = createLogger({ scope: "web.client.desktop-notification" });

const NOTIFICATION_LOG_EVENTS = {
  "skip:no-payload": "notification.skipped_no_payload",
  "skip:disabled": "notification.skipped_disabled",
  "skip:not-desktop": "notification.skipped_not_desktop",
  "skip:foreground": "notification.skipped_foreground",
  "skip:deduped": "notification.skipped_deduplicated",
  "skip:no-api": "notification.skipped_no_api",
  "skip:permission-denied": "notification.skipped_permission_denied",
  sent: "notification.sent",
} as const;

type NotificationLogMessage = keyof typeof NOTIFICATION_LOG_EVENTS;

let lastNotificationId = 0;

function nextNotificationId(): number {
  const now = Date.now() % MAX_NOTIFICATION_ID;
  lastNotificationId = Math.max(now, lastNotificationId + 1);
  if (lastNotificationId > MAX_NOTIFICATION_ID) {
    lastNotificationId = 1;
  }
  return lastNotificationId;
}

function hasDesktopTauri(): boolean {
  return typeof window !== "undefined" && typeof (window as Window & { __TAURI__?: unknown }).__TAURI__ !== "undefined";
}

function isAppBackgrounded(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  return document.visibilityState !== "visible" || !document.hasFocus();
}

async function createTauriNotificationApi(): Promise<NotificationApi | null> {
  if (!hasDesktopTauri()) {
    return null;
  }
  const plugin = await import("@tauri-apps/plugin-notification");
  return {
    isPermissionGranted: plugin.isPermissionGranted,
    requestPermission: plugin.requestPermission,
    registerActionTypes: plugin.registerActionTypes,
    sendNotification: async ({ id, title, body, actionTypeId, extra }) => {
      await plugin.sendNotification({ id, title, body, actionTypeId, extra });
    },
    onAction: async (callback) => plugin.onAction(callback),
  };
}

function buildTurnCompletedPayload(notification: DiligentServerNotification): NotifyPayload | null {
  if (notification.method !== DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED) {
    return null;
  }
  return {
    id: nextNotificationId(),
    title: APP_PROJECT_NAME,
    body: "Your request is complete.",
    dedupeKey: `turn-completed:${notification.params.threadId}:${notification.params.turnId}`,
    extra: { [NOTIFICATION_THREAD_ID_KEY]: notification.params.threadId },
  };
}

function buildServerRequestPayload(requestId: number, request: DiligentServerRequest): NotifyPayload | null {
  if (request.method === DILIGENT_SERVER_REQUEST_METHODS.APPROVAL_REQUEST) {
    return {
      id: nextNotificationId(),
      title: APP_PROJECT_NAME,
      body: "We need your approval.",
      dedupeKey: `server-request:${requestId}:approval`,
      extra: { [NOTIFICATION_THREAD_ID_KEY]: request.params.threadId },
    };
  }
  if (request.method === DILIGENT_SERVER_REQUEST_METHODS.USER_INPUT_REQUEST) {
    return {
      id: nextNotificationId(),
      title: APP_PROJECT_NAME,
      body: "We need your input.",
      dedupeKey: `server-request:${requestId}:user-input`,
      extra: { [NOTIFICATION_THREAD_ID_KEY]: request.params.threadId },
    };
  }
  return null;
}

function readThreadIdFromExtra(extra: Record<string, unknown> | undefined): string | null {
  const threadId = extra?.[NOTIFICATION_THREAD_ID_KEY];
  return typeof threadId === "string" && threadId.length > 0 ? threadId : null;
}

export function readDesktopNotificationsEnabled(): boolean {
  if (typeof localStorage === "undefined") {
    return true;
  }
  return localStorage.getItem(DESKTOP_NOTIFICATIONS_STORAGE_KEY) !== "false";
}

export function writeDesktopNotificationsEnabled(enabled: boolean): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  localStorage.setItem(DESKTOP_NOTIFICATIONS_STORAGE_KEY, enabled ? "true" : "false");
}

export class DesktopNotificationController {
  private readonly recentKeys = new Map<string, number>();
  private permissionRequested = false;
  private enabled = readDesktopNotificationsEnabled();
  private actionListenerRegistered = false;

  constructor(
    private readonly environment: NotificationEnvironment = {
      isDesktop: hasDesktopTauri,
      isBackgrounded: isAppBackgrounded,
      createApi: createTauriNotificationApi,
    },
    private readonly logger: Logger = defaultLogger,
  ) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    writeDesktopNotificationsEnabled(enabled);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async attachActionHandler(onOpenThread: (threadId: string) => void): Promise<void> {
    if (this.actionListenerRegistered || !this.environment.isDesktop()) {
      return;
    }
    const api = await this.environment.createApi();
    if (!api) {
      return;
    }
    this.actionListenerRegistered = true;
    try {
      await api.registerActionTypes([
        {
          id: NOTIFICATION_ACTION_TYPE_ID,
          actions: [{ id: "open", title: "Open", foreground: true }],
        },
      ]);
      await api.onAction((notification) => {
        const threadId = readThreadIdFromExtra(notification.extra);
        if (!threadId) {
          return;
        }
        if (typeof window !== "undefined") {
          window.focus();
        }
        onOpenThread(threadId);
      });
    } catch (error) {
      this.actionListenerRegistered = false;
      this.logger.warn("action_listener.unavailable", {
        message: "[desktop-notification] action-listener-unavailable",
        error,
      });
    }
  }

  async notifyForNotification(notification: DiligentServerNotification): Promise<void> {
    const payload = buildTurnCompletedPayload(notification);
    await this.notify(payload, { source: "turn_completed" });
  }

  async notifyForServerRequest(requestId: number, request: DiligentServerRequest): Promise<void> {
    const payload = buildServerRequestPayload(requestId, request);
    await this.notify(payload, { source: "server_request" });
  }

  private async notify(payload: NotifyPayload | null, context: NotifyContext): Promise<void> {
    if (!payload) {
      this.log("skip:no-payload", context);
      return;
    }
    if (!this.enabled) {
      this.log("skip:disabled", context, { dedupeKey: payload.dedupeKey });
      return;
    }
    if (!this.environment.isDesktop()) {
      this.log("skip:not-desktop", context, { dedupeKey: payload.dedupeKey });
      return;
    }
    if (!this.environment.isBackgrounded()) {
      this.log("skip:foreground", context, { dedupeKey: payload.dedupeKey });
      return;
    }
    this.pruneRecentKeys();
    if (this.recentKeys.has(payload.dedupeKey)) {
      this.log("skip:deduped", context, { dedupeKey: payload.dedupeKey });
      return;
    }

    const api = await this.environment.createApi();
    if (!api) {
      this.log("skip:no-api", context, { dedupeKey: payload.dedupeKey });
      return;
    }

    const granted = await this.ensurePermission(api);
    if (!granted) {
      this.log("skip:permission-denied", context, { dedupeKey: payload.dedupeKey });
      return;
    }

    await api.sendNotification({
      id: payload.id,
      title: payload.title,
      body: payload.body,
      actionTypeId: NOTIFICATION_ACTION_TYPE_ID,
      extra: payload.extra,
    });
    this.recentKeys.set(payload.dedupeKey, Date.now());
    this.log("sent", context, {
      id: payload.id,
      dedupeKey: payload.dedupeKey,
      title: payload.title,
    });
  }

  private async ensurePermission(api: NotificationApi): Promise<boolean> {
    if (await api.isPermissionGranted()) {
      return true;
    }
    if (this.permissionRequested) {
      return false;
    }
    this.permissionRequested = true;
    return (await api.requestPermission()) === "granted";
  }

  private pruneRecentKeys(): void {
    const now = Date.now();
    for (const [key, timestamp] of this.recentKeys) {
      if (now - timestamp > REQUEST_DEDUPE_TTL_MS) {
        this.recentKeys.delete(key);
      }
    }
  }

  private log(event: NotificationLogMessage, context: NotifyContext, details?: Record<string, unknown>): void {
    this.logger.debug(NOTIFICATION_LOG_EVENTS[event], {
      message: `[desktop-notification] ${event}`,
      fields: {
        source: context.source,
        enabled: this.enabled,
        ...details,
      },
    });
  }
}

export function createDesktopNotificationController(): DesktopNotificationController {
  return new DesktopNotificationController();
}
