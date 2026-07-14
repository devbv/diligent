// @summary Configures OVERDARE sidecar structured console and gateway logging destinations.

import { createConsoleSink, createFanoutSink, setDefaultLogSink } from "@diligent/logging";
import {
  type ConsoleSystemErrorForwarderOptions,
  createGatewaySystemLogSink,
  installConsoleSystemErrorForwarder,
} from "./tools/gateway/system-errors";

/** Configure structured destinations while retaining legacy third-party console forwarding. */
export function configureSidecarLogging(options: ConsoleSystemErrorForwarderOptions): void {
  // Install interception first so the console sink retains the existing local console behavior.
  // Its recursion marker tells the interceptor not to submit the same structured record remotely.
  installConsoleSystemErrorForwarder(options);
  setDefaultLogSink(createFanoutSink([createConsoleSink(), createGatewaySystemLogSink(options)]));
}
