// @summary Method constants for Diligent v1 protocol (shared by TUI and future web)
export const DILIGENT_VERSION = "0.2.6";

/**
 * Version stamp for the AI-data consent notice (OVDR-11475 §3.A). When the stored
 * acknowledged version differs from this, the first-run notice popup is shown again.
 * TODO(OVDR-11484): align this with the deployed Creator Terms version once available.
 */
export const CONSENT_NOTICE_VERSION = "2026-06";

export const DILIGENT_CLIENT_REQUEST_METHODS = {
  INITIALIZE: "initialize",
  THREAD_START: "thread/start",
  THREAD_RESUME: "thread/resume",
  THREAD_LIST: "thread/list",
  THREAD_READ: "thread/read",
  THREAD_COMPACT_START: "thread/compact/start",
  TURN_START: "turn/start",
  TURN_INTERRUPT: "turn/interrupt",
  TURN_STEER: "turn/steer",
  MODE_SET: "mode/set",
  EFFORT_SET: "effort/set",
  KNOWLEDGE_LIST: "knowledge/list",
  KNOWLEDGE_UPDATE: "knowledge/update",
  THREAD_DELETE: "thread/delete",
  TOOLS_LIST: "tools/list",
  TOOLS_SET: "tools/set",
  CONFIG_SET: "config/set",
  CONSENT_SET: "consent/set",
  AUTH_LIST: "auth/list",
  AUTH_SET: "auth/set",
  AUTH_REMOVE: "auth/remove",
  AUTH_OAUTH_START: "auth/oauth/start",
  AUTH_OAUTH_CANCEL: "auth/oauth/cancel",
  THREAD_SUBSCRIBE: "thread/subscribe",
  THREAD_UNSUBSCRIBE: "thread/unsubscribe",
  IMAGE_UPLOAD: "image/upload",
} as const;

export type DiligentClientRequestMethod =
  (typeof DILIGENT_CLIENT_REQUEST_METHODS)[keyof typeof DILIGENT_CLIENT_REQUEST_METHODS];

export const DILIGENT_CLIENT_NOTIFICATION_METHODS = {
  INITIALIZED: "initialized",
} as const;

export type DiligentClientNotificationMethod =
  (typeof DILIGENT_CLIENT_NOTIFICATION_METHODS)[keyof typeof DILIGENT_CLIENT_NOTIFICATION_METHODS];

export const DILIGENT_SERVER_NOTIFICATION_METHODS = {
  AGENT_EVENT: "agent/event",
  THREAD_STARTED: "thread/started",
  THREAD_RESUMED: "thread/resumed",
  THREAD_COMPACTED: "thread/compacted",
  THREAD_COMPACTION_STARTED: "thread/compaction/started",
  THREAD_STATUS_CHANGED: "thread/status/changed",
  TURN_STARTED: "turn/started",
  ITEM_STARTED: "item/started",
  ITEM_DELTA: "item/delta",
  ITEM_COMPLETED: "item/completed",
  TURN_COMPLETED: "turn/completed",
  TURN_INTERRUPTED: "turn/interrupted",
  SERVER_REQUEST_RESOLVED: "server/request/resolved",
  KNOWLEDGE_SAVED: "knowledge/saved",
  ERROR: "error",
  USAGE_UPDATED: "usage/updated",
  ACCOUNT_LOGIN_COMPLETED: "account/login/completed",
  ACCOUNT_UPDATED: "account/updated",
  COLLAB_SPAWN_BEGIN: "collab/spawn/begin",
  COLLAB_SPAWN_END: "collab/spawn/end",
  COLLAB_WAIT_BEGIN: "collab/wait/begin",
  COLLAB_WAIT_END: "collab/wait/end",
  COLLAB_CLOSE_BEGIN: "collab/close/begin",
  COLLAB_CLOSE_END: "collab/close/end",
  COLLAB_INTERACTION_BEGIN: "collab/interaction/begin",
  COLLAB_INTERACTION_END: "collab/interaction/end",
  STEERING_INJECTED: "steering/injected",
} as const;

export type DiligentServerNotificationMethod =
  (typeof DILIGENT_SERVER_NOTIFICATION_METHODS)[keyof typeof DILIGENT_SERVER_NOTIFICATION_METHODS];

export const DILIGENT_SERVER_REQUEST_METHODS = {
  APPROVAL_REQUEST: "approval/request",
  USER_INPUT_REQUEST: "userInput/request",
} as const;

export type DiligentServerRequestMethod =
  (typeof DILIGENT_SERVER_REQUEST_METHODS)[keyof typeof DILIGENT_SERVER_REQUEST_METHODS];
