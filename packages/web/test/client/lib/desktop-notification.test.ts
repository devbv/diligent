import { describe, expect, test } from "bun:test";
import { createLogger, type LogRecord } from "@diligent/logging";
import type { DiligentServerNotification, DiligentServerRequest } from "@diligent/protocol";
import { DILIGENT_SERVER_NOTIFICATION_METHODS, DILIGENT_SERVER_REQUEST_METHODS } from "@diligent/protocol";
import {
  DESKTOP_NOTIFICATIONS_STORAGE_KEY,
  DesktopNotificationController,
  readDesktopNotificationsEnabled,
  writeDesktopNotificationsEnabled,
} from "../../../src/client/lib/desktop-notification";

function createNotificationEnvironment(options?: {
  isDesktop?: boolean;
  isBackgrounded?: boolean;
  granted?: boolean;
  permissionResult?: "default" | "denied" | "granted";
}) {
  const sent: Array<{
    id: number;
    title: string;
    body: string;
    actionTypeId?: string;
    extra?: Record<string, unknown>;
  }> = [];
  const actionCallbacks: Array<(notification: { extra?: Record<string, unknown> }) => void> = [];
  let granted = options?.granted ?? true;
  const permissionResult = options?.permissionResult ?? "granted";

  return {
    sent,
    actionCallbacks,
    environment: {
      isDesktop: () => options?.isDesktop ?? true,
      isBackgrounded: () => options?.isBackgrounded ?? true,
      createApi: async () => ({
        isPermissionGranted: async () => granted,
        requestPermission: async () => {
          granted = permissionResult === "granted";
          return permissionResult;
        },
        registerActionTypes: async () => undefined,
        sendNotification: async (payload: {
          id: number;
          title: string;
          body: string;
          actionTypeId?: string;
          extra?: Record<string, unknown>;
        }) => {
          sent.push(payload);
        },
        onAction: async (callback: (notification: { extra?: Record<string, unknown> }) => void) => {
          actionCallbacks.push(callback);
          return { unregister: () => undefined };
        },
      }),
    },
  };
}

describe("DesktopNotificationController", () => {
  test("emits structured diagnostics with stable events and fields", async () => {
    const setup = createNotificationEnvironment({ isBackgrounded: false });
    const records: LogRecord[] = [];
    const logger = createLogger({
      scope: "web.client.desktop-notification",
      sink: (record) => records.push(record),
      clock: () => new Date("2026-01-02T03:04:05.006Z"),
    });
    const controller = new DesktopNotificationController(setup.environment, logger);
    const request = {
      method: DILIGENT_SERVER_REQUEST_METHODS.APPROVAL_REQUEST,
      params: {
        threadId: "thread-1",
        request: { permission: "commentary", toolName: "bash", details: {} },
      },
    } satisfies DiligentServerRequest;

    await controller.notifyForServerRequest(7, request);

    expect(records).toMatchObject([
      {
        level: "debug",
        scope: "web.client.desktop-notification",
        event: "notification.skipped_foreground",
        message: "[desktop-notification] skip:foreground",
        fields: {
          source: "server_request",
          enabled: true,
          dedupeKey: "server-request:7:approval",
        },
      },
    ]);
  });

  test("defaults desktop notifications to enabled", () => {
    const original = globalThis.localStorage;
    const storage = new Map<string, string>();
    globalThis.localStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      clear: () => storage.clear(),
      key: (index: number) => Array.from(storage.keys())[index] ?? null,
      get length() {
        return storage.size;
      },
    } as Storage;

    expect(readDesktopNotificationsEnabled()).toBe(true);
    writeDesktopNotificationsEnabled(false);
    expect(storage.get(DESKTOP_NOTIFICATIONS_STORAGE_KEY)).toBe("false");
    expect(readDesktopNotificationsEnabled()).toBe(false);

    globalThis.localStorage = original;
  });

  test("notifies when a background thread turn completes", async () => {
    const setup = createNotificationEnvironment();
    const controller = new DesktopNotificationController(setup.environment);
    const notification = {
      method: DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED,
      params: { threadId: "thread-1", turnId: "turn-1" },
    } satisfies DiligentServerNotification;

    await controller.notifyForNotification(notification);

    expect(setup.sent).toHaveLength(1);
    expect(setup.sent[0]).toMatchObject({
      title: "Diligent",
      body: "Your request is complete.",
      extra: { threadId: "thread-1" },
    });
  });

  test("opens the related thread when notification action fires", async () => {
    const setup = createNotificationEnvironment();
    const controller = new DesktopNotificationController(setup.environment);
    const opened: string[] = [];

    await controller.attachActionHandler((threadId) => {
      opened.push(threadId);
    });

    setup.actionCallbacks[0]?.({ extra: { threadId: "thread-42" } });

    expect(opened).toEqual(["thread-42"]);
  });

  test("does not notify while app is foregrounded", async () => {
    const setup = createNotificationEnvironment({ isBackgrounded: false });
    const controller = new DesktopNotificationController(setup.environment);
    const request = {
      method: DILIGENT_SERVER_REQUEST_METHODS.APPROVAL_REQUEST,
      params: {
        threadId: "thread-1",
        request: { permission: "commentary", toolName: "bash", details: {} },
      },
    } satisfies DiligentServerRequest;

    await controller.notifyForServerRequest(7, request);

    expect(setup.sent).toEqual([]);
  });

  test("requests permission once before sending notifications", async () => {
    const setup = createNotificationEnvironment({ granted: false, permissionResult: "granted" });
    const controller = new DesktopNotificationController(setup.environment);
    const request = {
      method: DILIGENT_SERVER_REQUEST_METHODS.USER_INPUT_REQUEST,
      params: {
        threadId: "thread-1",
        request: {
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
        },
      },
    } satisfies DiligentServerRequest;

    await controller.notifyForServerRequest(10, request);
    await controller.notifyForServerRequest(10, request);

    expect(setup.sent).toMatchObject([
      { title: "Diligent", body: "We need your input.", extra: { threadId: "thread-1" } },
    ]);
  });

  test("does not notify when disabled", async () => {
    const setup = createNotificationEnvironment();
    const controller = new DesktopNotificationController(setup.environment);
    controller.setEnabled(false);
    const notification = {
      method: DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED,
      params: { threadId: "thread-1", turnId: "turn-1" },
    } satisfies DiligentServerNotification;

    await controller.notifyForNotification(notification);

    expect(setup.sent).toEqual([]);
  });
});
