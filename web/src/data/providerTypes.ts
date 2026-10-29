export type CustomApiProtocol = 'openai-completions' | 'openai-responses' | 'anthropic-messages';

export type ProviderAuth = {
  type: 'api_key' | 'oauth' | 'env' | 'none';
  keyTail?: string;
  account?: string;
  envVar?: string;
};

export type ProviderStatusState = 'ok' | 'untested' | 'error' | 'testing';

export type ProviderStatus = {
  state: ProviderStatusState;
  testedAt?: number;
  error?: string;
};

export type Model = {
  id: string;
  name: string;
  brand: string | null;
  enabled: boolean;
  contextWindow: number | null;
  maxTokens: number | null;
  images: boolean;
  reasoning: boolean;
  overridden: {
    contextWindow?: boolean;
    maxTokens?: boolean;
  };
};

export type Provider = {
  id: string;
  kind: 'builtin' | 'custom';
  brand: string | null;
  name: string;
  api?: CustomApiProtocol;
  baseUrl?: string;
  auth: ProviderAuth;
  status: ProviderStatus;
  models: Model[];
};

export type Available = {
  id: string;
  name: string;
  authMethods: ('api_key' | 'oauth')[];
  modelCount: number;
  popular: boolean;
  envVar?: string;
  envDetected: boolean;
  connected: boolean;
};

export type LoginSessionEvent =
  | { type: 'auth_url'; url: string; instructions?: string }
  | { type: 'device_code'; userCode: string; verificationUri: string }
  | { type: 'info' | 'progress'; message: string };

export type LoginPromptOption = {
  id: string;
  label: string;
  description?: string;
};

export type LoginPrompt = {
  type: 'text' | 'secret' | 'select' | 'manual_code';
  message: string;
  placeholder?: string;
  options?: LoginPromptOption[];
};

export type LoginSession = {
  id: string;
  providerId: string;
  state: 'pending' | 'prompt' | 'done' | 'error' | 'cancelled';
  events: LoginSessionEvent[];
  prompt?: LoginPrompt;
  error?: string;
  provider?: Provider;
};

export type DefaultModel = {
  providerId: string;
  modelId: string;
} | null;

export type GetProvidersResponse = {
  providers: Provider[];
  defaultModel: DefaultModel;
};

export type GetAvailableResponse = {
  providers: Available[];
};

export type ConnectApiKeyRequest = {
  method: 'api_key';
  apiKey: string;
};

export type ConnectEnvRequest = {
  method: 'env';
};

export type ConnectOAuthRequest = {
  method: 'oauth';
};

export type ConnectProviderRequest = ConnectApiKeyRequest | ConnectEnvRequest;

export type CustomProviderRequest = {
  name: string;
  baseUrl: string;
  api: CustomApiProtocol;
  apiKey?: string;
};

export type PatchProviderRequest = {
  enabled?: string[];
  overrides?: Record<string, { contextWindow?: number | null; maxTokens?: number | null }>;
  defaultModel?: string | null;
  name?: string;
  baseUrl?: string;
  api?: CustomApiProtocol;
  apiKey?: string;
};
