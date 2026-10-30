import type { components } from '../../../src/v2/contract.gen';
import type {
  Available,
  CustomApiProtocol,
  DefaultModel,
  LoginSession,
  Model,
  Provider,
} from '../../src/data/providerTypes';
import type { MockRepo } from './repo';

export type Lang = 'zh' | 'en';
export type Bilingual = { zh: string; en: string };

export type ConversationView = components['schemas']['ConversationView'];
export type ConversationSummary = components['schemas']['ConversationSummary'];
export type ConversationSend = components['schemas']['ConversationSend'];
export type ThreadItem = components['schemas']['ThreadItem'];
export type ToolCall = components['schemas']['ToolCall'];
export type Workspace = components['schemas']['Workspace'] & {
  kind?: 'project' | 'chat';
};
export type { Available, CustomApiProtocol, DefaultModel, LoginSession, Model, Provider };
export type ResolvedModel = { providerId: string; modelId: string };
export type Change = components['schemas']['Change'];
export type Diff = components['schemas']['Diff'];
export type Subagent = components['schemas']['Subagent'];
export type RunState = components['schemas']['RunState'];
export type ServiceInfo = components['schemas']['ServiceInfo'];
export type ToolOutput = components['schemas']['ToolOutput'];
export type FileContent = components['schemas']['FileContent'];
export type FileNode = components['schemas']['FileNode'];
export type FileTree = components['schemas']['FileTree'];
export type SaveResult = components['schemas']['SaveResult'];
export type WorkspaceDirEntry = components['schemas']['WorkspaceDirEntry'];
export type WorkspaceDirs = components['schemas']['WorkspaceDirs'];
export type Plugin = components['schemas']['Plugin'];
export type Skill = components['schemas']['Skill'];
export type GitConnection = components['schemas']['GitConnection'];
export type GitProject = components['schemas']['GitProject'];
export type GitBranch = components['schemas']['GitBranch'];
export type GitTestResult = components['schemas']['GitTestResult'];


/** A tool row before it is folded into the language the client asked for. */
export type MockTool = {
  id: string;
  kind: ToolCall['kind'];
  status: ToolCall['status'];
  path?: string;
  title: Bilingual;
  detail?: Bilingual;
  fromIntent: boolean;
  hint: Bilingual;
  hintFailed: boolean;
  failure: ToolCall['failure'];
  diff: ToolCall['diff'];
  exitCode?: number;
  preview: string;
  truncated: boolean;
  totalLines: number;
  output: string;
  liveText?: string;
};

export type MockGroup = {
  kind: 'tool_group';
  id: string;
  toolIds: string[];
  live: boolean;
  summary: Bilingual;
  failed: number;
  running: boolean;
};

type PlainItem = Exclude<ThreadItem, { kind: 'tool_group' }>;

export type MockItem = PlainItem | MockGroup;

export type Steer = {
  requestId: string;
  text: string;
  images?: components['schemas']['MessageImage'][];
  files?: components['schemas']['SendMessageFile'][];
  pastes?: string[];
};

export type FollowUp = Steer;

export type StoredMessageImage = {
  mediaType: components['schemas']['ThreadUserImage']['mediaType'];
  bytes: Uint8Array;
};

export type RunHandle = {
  id: string;
  cancelled: boolean;
  steers: Steer[];
  followUps: FollowUp[];
};

export type MockConv = {
  view: ConversationView;
  /** Language-dependent waiting line kept next to the view. */
  pending: Bilingual | null;
  items: MockItem[];
  tools: Record<string, MockTool>;
  changes: Change[];
  diffs: Record<string, Diff>;
  subagents: Subagent[];
  archived?: boolean;
  run: RunHandle | null;
  /** requestId → runId, so a retried POST stays idempotent. */
  requestRuns: Map<string, string>;
};

/** One subagent of a conversation: view plus its own thread (`subagent:<cid>:<id>` topic). */
export type MockSubThread = {
  view: Subagent;
  items: MockItem[];
  tools: Record<string, MockTool>;
  run: RunHandle | null;
};

export type MockDb = {
  workspaces: Workspace[];
  conversations: Map<string, MockConv>;
  providers: Provider[];
  defaultModel: ResolvedModel | null;
  loginSessions: Map<string, { session: LoginSession; pollCount: number }>;
  /** Per-workspace mock repository used by the right pane file tab. */
  repos: Map<string, MockRepo>;
  plugins: Plugin[];
  skills: Skill[];
  gitConnections: GitConnection[];
  gitProjects: Record<string, GitProject[]>;
  /** `${cid}:${agentId}` → subagent thread. */
  subagents: Map<string, MockSubThread>;
  seq: number;
  /** `${cid}\\t${messageId}\\t${index}` → raw bytes for GET .../images/{index}. */
  messageImages: Map<string, StoredMessageImage>;
  /** `${cid}\t${messageId}\t${index}` → text for GET .../pastes/{index}. */
  messagePastes: Map<string, string>;
  /** `${wsId}\t${uploadPath}` → upload result. */
  workspaceUploads: Map<string, components['schemas']['UploadResult']>;
};

export type EntityValue = object | ((lang: Lang) => object);

export function tr(value: Bilingual, lang: Lang): string {
  return lang === 'en' ? value.en : value.zh;
}
