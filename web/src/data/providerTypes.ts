import type { components } from '../../../src/v2/contract.gen';

export type Provider = components['schemas']['Provider'];
export type ProviderModel = components['schemas']['ProviderModel'];
export type Model = ProviderModel;
export type ProviderKind = components['schemas']['ProviderKind'];
export type ProviderAuth = components['schemas']['ProviderAuth'];
export type ProviderAuthType = components['schemas']['ProviderAuthType'];
export type ProviderStatus = components['schemas']['ProviderStatus'];
export type ProviderStatusState = components['schemas']['ProviderStatusState'];
export type CustomApi = components['schemas']['CustomApi'];
export type CustomApiProtocol = CustomApi;
export type ModelOverridden = components['schemas']['ModelOverridden'];
export type AvailableProvider = components['schemas']['AvailableProvider'];
export type Available = AvailableProvider;
export type LoginSession = components['schemas']['LoginSession'];
export type LoginSessionEvent = components['schemas']['LoginSessionEvent'];
export type LoginPrompt = components['schemas']['LoginPrompt'];
export type LoginPromptOption = components['schemas']['LoginPromptOption'];
export type ResolvedModel = components['schemas']['ResolvedModel'];
export type DefaultModel = ResolvedModel | null;
export type ProvidersSnapshot = components['schemas']['ProvidersSnapshot'];
export type AvailableProvidersSnapshot = components['schemas']['AvailableProvidersSnapshot'];
export type ProviderDefaults = components['schemas']['ProviderDefaults'];
export type ConnectApiKeyRequest = components['schemas']['ConnectApiKeyRequest'];
export type ConnectEnvRequest = components['schemas']['ConnectEnvRequest'];
export type ConnectOAuthRequest = components['schemas']['ConnectOAuthRequest'];
export type ConnectProviderRequest = components['schemas']['ConnectProviderRequest'];
export type CreateCustomProviderRequest = components['schemas']['CreateCustomProviderRequest'];
export type CustomProviderRequest = CreateCustomProviderRequest;
export type PatchProviderRequest = components['schemas']['PatchProviderRequest'];
export type ModelOverridePatch = components['schemas']['ModelOverridePatch'];
export type LoginAnswerRequest = components['schemas']['LoginAnswerRequest'];
export type ProviderEnvelope = components['schemas']['ProviderEnvelope'];
export type LoginSessionEnvelope = components['schemas']['LoginSessionEnvelope'];

// Helper aliases matching backend responses
export type GetProvidersResponse = ProvidersSnapshot;
export type GetAvailableResponse = AvailableProvidersSnapshot;
