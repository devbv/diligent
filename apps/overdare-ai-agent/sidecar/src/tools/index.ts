// @summary Product-owned bundled tool provider assembly for OVERDARE Studio.

import type { BundledToolProvider } from "@diligent/runtime";
import { createAnalyticsToolProvider } from "./analytics";
import { createGatewayToolProvider } from "./gateway";
import { createHelloWorldToolProvider, type StudioToolProviderOptions } from "./hello-world";
import { createRagToolProvider } from "./rag";
import { createStudioRpcToolProvider } from "./studiorpc";
import { createValidatorToolProvider } from "./validator";

export interface StudioBundledToolProviderOptions extends StudioToolProviderOptions {}

export function createStudioBundledToolProviders(options: StudioBundledToolProviderOptions): BundledToolProvider[] {
  return [
    createHelloWorldToolProvider(options),
    createRagToolProvider(),
    createValidatorToolProvider(),
    createStudioRpcToolProvider(),
    createAnalyticsToolProvider(),
    createGatewayToolProvider(options),
  ];
}
