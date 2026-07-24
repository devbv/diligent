// @summary Product-owned bundled tool provider assembly for OVERDARE Studio.

import type { BundledToolProvider } from "@diligent/runtime";
import { createAnalyticsToolProvider } from "./analytics";
import { createGatewayToolProvider } from "./gateway";
import { createHelloWorldToolProvider, type StudioToolProviderOptions } from "./hello-world";
import { createRagToolProvider } from "./rag";
import { createSleepToolProvider } from "./sleep";
import { createStudioRpcToolProvider } from "./studiorpc";
import { createValidatorToolProvider } from "./validator";

export interface StudioBundledToolProviderOptions extends StudioToolProviderOptions {
  /** When true, omit the Studio RPC provider so nothing connects to Studio (13377). */
  studioDisabled?: boolean;
  canTransmitRecords?: () => boolean;
}

export function createStudioBundledToolProviders(options: StudioBundledToolProviderOptions): BundledToolProvider[] {
  return [
    createHelloWorldToolProvider(options),
    createRagToolProvider(),
    createSleepToolProvider(),
    createValidatorToolProvider(),
    // Studio RPC provider carries the level.save.file turn hooks, so skipping it
    // means zero connection attempts to Studio when running without one.
    ...(options.studioDisabled ? [] : [createStudioRpcToolProvider()]),
    createAnalyticsToolProvider(),
    createGatewayToolProvider(options),
  ];
}
