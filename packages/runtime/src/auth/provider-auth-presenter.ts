// @summary Runtime-owned provider authentication labels and masked credential status

import type { ProviderManager, ProviderName } from "@diligent/core/provider-contract";

export interface ExternalProviderAuthPresentation {
  maskedKey: string;
  oauth?: boolean;
}

export interface ProviderAuthPresentationStatus {
  configured: boolean;
  maskedKey: string | undefined;
  oauthConnected: boolean | undefined;
}

function maskKey(key: string): string {
  return key.length > 7 ? `${key.slice(0, 7)}...` : key;
}

export class ProviderAuthPresenter {
  private readonly externalAuth: Partial<Record<ProviderName, ExternalProviderAuthPresentation>> = {};

  constructor(private readonly providerManager: ProviderManager) {}

  setExternalAuth(provider: ProviderName, presentation: ExternalProviderAuthPresentation): void {
    this.externalAuth[provider] = presentation;
  }

  removeExternalAuth(provider: ProviderName): void {
    delete this.externalAuth[provider];
  }

  getStatus(provider: ProviderName): ProviderAuthPresentationStatus {
    const configured = this.providerManager.hasKeyFor(provider);
    const apiKey = this.providerManager.getApiKey(provider);
    const external = this.externalAuth[provider];
    return {
      configured,
      maskedKey: configured ? (apiKey ? maskKey(apiKey) : external?.maskedKey) : undefined,
      oauthConnected: external?.oauth ? configured : undefined,
    };
  }
}
