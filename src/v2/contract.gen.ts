export interface paths {
    "/api/v2/service": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 查询服务信息 */
        get: operations["getService"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/service/restart": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 请求服务退出，由客户端重新拉起
         * @description 服务只负责退出当前进程，不负责再拉起。客户端在收到 202 后自行启动新进程。
         *     任务图里还有活着的任务（含后台子 Agent）时返回 409，避免打断正在跑的工作。
         */
        post: operations["restartService"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/auth/web-code": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 用本机令牌签发一次性网页登录码 */
        post: operations["createWebCode"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * SSE 推送流
         * @description 一个客户端一条 SSE 连接，用查询参数 `topics` 订阅主题（逗号分隔），`lang` 为 zh 或 en（缺省 zh，不认识的按 zh）。
         *     每条业务事件带全局递增序号，写成标准 SSE：`id: <序号>`、`event: <类型>`、`data: <JSON>`。
         *     断线后带 `Last-Event-ID` 头（或查询参数 `lastEventId`）续传；环形缓冲里补不上（太旧、比当前还新、或格式不对）时先发一份新快照。
         *     没带 Last-Event-ID 时先发快照。快照的 SSE id 是开始计算快照时的最新序号；计算期间该连接订阅主题上到达的事件在快照之后按序补发（seq 大于该 id）。upsert / remove 是整实体替换，重复应用结果一样。
         *     订阅的主题和上次不同时，客户端不要带 Last-Event-ID / lastEventId，直接重新连接拿快照（续传只保证同一组主题）。
         *     心跳每 15 秒一次，不带 id，不进缓冲。
         *
         *     主题 `workspaces` 注册为精确主题。实体：
         *     - `workspace`：id 为工作区 id，值为 Workspace
         *     - `conversation_summary`：id 为对话 id，值为 ConversationSummary
         *
         *     快照与 GET /api/v2/workspaces 同一套数据拆成上述实体。工作区或对话增删改、运行状态或子 Agent 计数变化时 upsert；实体删除时 remove。
         *
         *     主题 `providers` 注册为精确主题。实体：
         *     - `provider`：id 为 Provider id，值为 Provider
         *     - `defaults`：id 为 `self`，值为 ProviderDefaults（`model` 为当前默认 `{ providerId, modelId }`，没有则为 null）
         *
         *     快照是 GET /api/v2/providers 的 providers 与 defaultModel 拆成上述实体（vendors 是静态预设，不进推送）。任何 Provider 增删改、连通性测试、Grok 登录状态变化、上下文上限或默认模型修改后 upsert（新旧接口改动都要触发）；实体删除时 remove。
         *
         *     主题 `extensions` 注册为精确主题。实体：
         *     - `plugin`：id 为插件 id，值为 Plugin
         *     - `skill`：id 为技能 id，值为 Skill
         *     - `git_connection`：id 为 Git 连接 id，值为 GitConnection
         *
         *     快照是 GET /api/v2/plugins、GET /api/v2/skills、GET /api/v2/git/connections 同一套数据拆成上述实体。插件、技能、Git 连接增删改（含旧接口）后 upsert；实体删除时 remove。失败原因、Git 测试结果按订阅的 `lang` 出成句。
         *
         *     主题 `conversation:<id>`（`<id>` 为对话 id）按前缀动态注册。实体：
         *     - `conversation`：id 为对话 id，值为 ConversationView
         *     - `item`：id 为 ThreadItem.id，值为 ThreadItem
         *     - `tool`：id 为 ToolCall.id，值为 ToolCall
         *     - `subagent`：id 为子 Agent id，值为 Subagent。卡住由服务端判定：kernel 状态为 running 且超过 stuckAfterMs（默认 60000，环境变量 WEFT_SUBAGENT_STUCK_MS）没有活动时 status 为 stuck，到点推送 upsert。
         *     - `change`：id 为相对工作区的路径（统一用 `/`），值为 Change。快照带上当前变更列表。工具结束（write / edit / bash 都可能改文件）或经保存接口写入后随重算更新：变了才 upsert，从列表消失则 remove。不做文件监听。
         *
         *     快照是 GET /api/v2/conversations/{id} 的 conversation / items / tools，再加上该对话的 subagent 和 change 实体。模型流式输出时先 upsert 一条 `item`，id 以 `live:` 开头、`streaming` 为 true、`text` 为空；随后用 `text.delta` 追加。正式助手消息到来后 remove 这条流式项，再 upsert 正式项和 conversation。
         *
         *     主题 `subagent:<cid>:<agentId>`（`<cid>` 为父对话 id，`<agentId>` 为子 Agent id）按前缀动态注册。实体：
         *     - `subagent`：id 为子 Agent id，值为 Subagent
         *     - `item`：id 为 ThreadItem.id，值为 ThreadItem（子 Agent 自己的消息流，没有嵌套子 Agent 汇报）
         *     - `tool`：id 为 ToolCall.id，值为 ToolCall
         *
         *     快照是 GET /api/v2/conversations/{id}/subagents/{agentId} 同一套数据拆成上述实体。订阅父对话的内核事件（含 `agent`）后重算；子 Agent 的进展会体现在父对话事件里。
         *
         *     订阅不存在的对话或子 Agent 时仍返回 200：先发 snapshot，entities 为空，并在 snapshot 数据里加 `missing: ["conversation:<id>"]` 或 `missing: ["subagent:<cid>:<agentId>"]`，连接保持。
         *
         *     事件名与 data 的对应关系：
         *     - `snapshot` → SnapshotEvent
         *     - `upsert` → UpsertEvent
         *     - `remove` → RemoveEvent
         *     - `text.delta` → TextDeltaEvent
         *     - `heartbeat` → HeartbeatEvent
         */
        get: operations["getEvents"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/workspaces": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 侧栏工作区和对话列表
         * @description 返回当前未移除的工作区，以及每个工作区下的对话摘要。
         *     对话状态用 statusOf，子 Agent 计数用 subagentDigests，不读完整对话记录。
         *     每个工作区下的对话按 updatedAt 倒序。
         */
        get: operations["getWorkspaces"];
        put?: never;
        /**
         * 新建工作区
         * @description 请求体带 `source`：`local` 用本机目录（`path` 缺省时在数据目录下建空目录），`git` 克隆仓库。
         *     本地路径校验与旧接口相同（resolveAllowedWorkspacePath）。Git 只允许 https / ssh / git@；存储的 URL 去掉凭据。
         *     `connectionId` / `projectId` 走已保存的 Git 连接。成功后 `workspaces` 主题更新。失败原因按 `lang` 出成句，并带结构化 `code`。
         */
        post: operations["createWorkspace"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/workspace-root": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 可浏览的工作区根目录
         * @description 与旧 GET /api/workspace-root 相同，返回 defaultWorkspaceRoot()。
         */
        get: operations["getWorkspaceRoot"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/workspace-root/dirs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 列出可浏览的子目录
         * @description 与旧 GET /api/workspace-root/dirs 相同，复用 listBrowsableDirs。
         *     只列出允许根目录以内的文件夹；越界 400 E_PATH，文案按 lang 出成句。
         */
        get: operations["listWorkspaceRootDirs"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/git/connections": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Git 连接列表
         * @description 令牌只返回打码值。lastTest.errorText 按 lang 出成句。
         */
        get: operations["listGitConnections"];
        put?: never;
        /**
         * 新建 Git 连接
         * @description 令牌只返回打码值。成功后 extensions 主题更新。
         */
        post: operations["createGitConnection"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/git/connections/test": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 测试尚未保存或正在编辑的 Git 连接
         * @description 与旧 POST /api/git/connections/test 相同。校验失败也返回 200 `{ ok: false, code }`，
         *     由服务端按 lang 出成句（statusText）。令牌不出现在响应里。
         */
        post: operations["testGitConnectionUnsaved"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/git/connections/{id}": {
        parameters: {
            query?: {
                lang?: string;
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** 删除 Git 连接 */
        delete: operations["deleteGitConnection"];
        options?: never;
        head?: never;
        /**
         * 更新 Git 连接
         * @description 打码令牌视为未改。成功后 extensions 主题更新。
         */
        patch: operations["updateGitConnection"];
        trace?: never;
    };
    "/api/v2/git/connections/{id}/test": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 测试已保存的 Git 连接并记下结果
         * @description 成功或失败都会写 lastTest。响应带打码后的 connection。extensions 主题更新。
         */
        post: operations["testGitConnection"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/git/connections/{id}/projects": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 列出连接下的 GitLab 项目 */
        get: operations["listGitConnectionProjects"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/git/connections/{id}/projects/{pid}/branches": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 列出项目分支 */
        get: operations["listGitConnectionProjectBranches"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/plugins": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 插件列表
         * @description 失败原因由服务端按 lang 出成句，同时保留 errorCode。
         */
        get: operations["listPlugins"];
        put?: never;
        /**
         * 从本机目录导入插件
         * @description 与旧 POST /api/plugins 相同。成功后 extensions 主题更新。
         */
        post: operations["installPlugin"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/plugins/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** 启用或停用插件 */
        patch: operations["patchPlugin"];
        trace?: never;
    };
    "/api/v2/skills": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 技能列表 */
        get: operations["listSkills"];
        put?: never;
        /**
         * 新建技能
         * @description 成功后 extensions 主题更新。
         */
        post: operations["createSkill"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/skills/{id}": {
        parameters: {
            query?: {
                lang?: string;
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        get?: never;
        /**
         * 更新技能内容或开关
         * @description 与旧 PUT /api/skills/{id} 相同。成功后 extensions 主题更新。
         */
        put: operations["putSkill"];
        post?: never;
        /**
         * 删除技能
         * @description 内置技能 403。成功后 extensions 主题更新。
         */
        delete: operations["deleteSkill"];
        options?: never;
        head?: never;
        /**
         * 部分更新技能
         * @description 与 PUT 相同，对应旧 PATCH /api/skills/{id}。
         */
        patch: operations["patchSkill"];
        trace?: never;
    };
    "/api/v2/workspaces/{id}/conversations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 在工作区新建对话
         * @description 调用和旧接口相同的创建逻辑。`title` 缺省为 New conversation。
         *     工作区不存在或已移除时 404。成功返回新对话的 ConversationSummary。
         */
        post: operations["createWorkspaceConversation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/workspaces/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * 移除工作区
         * @description 只隐藏工作区，磁盘文件和对话记录保留。有运行中的对话时 409 E_WS_BUSY，并返回这些对话 id。
         *     工作区不存在或已移除时 404。
         */
        delete: operations["removeWorkspace"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/workspaces/{id}/tree": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 工作区文件树
         * @description 复用 listWorkspaceTree：最多 500 条、深度 8，跳过 .git 和 node_modules。
         *     达到条数上限时 truncated 为 true。path 相对工作区，统一用 `/`。
         *     越界的符号链接跳过。工作区不存在或已移除 404。
         */
        get: operations["getWorkspaceTree"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/workspaces/{id}/files": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 读工作区文件
         * @description 返回 FileContent。超过 2 MB（环境变量 WEFT_V2_MAX_FILE_BYTES，仅测试用）时 tooLarge 为 true、text 为 null。
         *     前 8 KB 里有 NUL 字节或不是合法 UTF-8 时 binary 为 true、text 为 null。
         *     version 是内容 sha256 的十六进制前 16 位，保存时用来检测冲突。
         *     越界 403 E_SANDBOX；不存在 404；是目录 400。
         */
        get: operations["getWorkspaceFile"];
        /**
         * 保存工作区文件
         * @description 请求体 `{ path, text, baseVersion? }`。带了 baseVersion 且和磁盘当前内容的 version 不同时
         *     返回 409 `{ error, code: E_CONFLICT, current: FileContent }`，不写入。
         *     否则写入（需要时建目录），返回 200 `{ path, version, added, removed }`。
         *     越界 403 E_SANDBOX。写入后若该文件在某个对话的变更列表里，对应 conversation 主题会重算。
         */
        put: operations["saveWorkspaceFile"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/providers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Provider 列表、厂商预设和默认模型
         * @description 返回当前已保存的 Provider 视图、VENDOR_PRESETS 预设列表，以及默认模型。
         *     `statusText` 按 `lang` 出成句。密钥只以 keyMasked 出现，响应不含明文 key。
         */
        get: operations["getProviders"];
        put?: never;
        /**
         * 新增 API Provider
         * @description 创建规则与旧 POST /api/sources 相同（createApiSource）。Grok 不能用此接口创建。
         *     成功后推送 providers 主题。
         */
        post: operations["createProvider"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/providers/test": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 用请求体里的配置测试连通并探测模型（不保存）
         * @description 只把请求发往请求体里的 baseUrl（或该 vendor 预设地址）。不写 lastTest。
         *     探测失败时 models 为空数组。statusText 按 lang 出成句。响应不含明文 key。
         */
        post: operations["testProviderDraft"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/providers/grok/session": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Grok Build 账号会话
         * @description 与旧 GET /api/grok/session 相同：读 ~/.grok/auth.json，不返回令牌。
         *     expiresAt 为毫秒时间戳。
         */
        get: operations["getGrokSession"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/providers/grok/login": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 开始 Grok Build 设备码登录
         * @description 与旧 POST /api/grok/login 相同。返回验证网址和用户码。令牌写回 ~/.grok/auth.json。
         */
        post: operations["startGrokLogin"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/providers/grok/login/poll": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 轮询 Grok 设备码登录
         * @description 与旧 POST /api/grok/login/poll 相同。成功后确保存在 grok Provider，并推送 providers 主题。
         */
        post: operations["pollGrokLogin"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/providers/grok/login/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 取消进行中的 Grok 设备码登录
         * @description 与旧 POST /api/grok/login/cancel 相同。loginId 缺省则取消全部进行中的登录。
         */
        post: operations["cancelGrokLogin"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/providers/grok/logout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 退出 Grok Build 登录
         * @description 与旧 POST /api/grok/logout 相同。只删除 OIDC 会话，保留 xai::api_key。推送 providers 主题。
         */
        post: operations["logoutGrok"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/providers/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * 删除 Provider
         * @description Grok 不能删，返回 400。删除后若它是默认模型来源则清空默认。推送 providers 主题。
         */
        delete: operations["deleteProvider"];
        options?: never;
        head?: never;
        /**
         * 修改已保存的 Provider
         * @description 改名、baseUrl、key、模型列表、默认模型。换 baseUrl 或 vendor 且没给新 key 时清空已存 key，规则同旧 applySourcePatch。
         *     成功后推送 providers 主题；若改了上下文相关字段或默认模型，对话主题的 model / context 也会重算。
         */
        patch: operations["patchProvider"];
        trace?: never;
    };
    "/api/v2/providers/{id}/test": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 测试已保存的 Provider
         * @description 探测已保存配置的连通性和模型列表，结果写回 lastTest。成功时按旧 modelsAfterProbe 合并模型。
         *     推送 providers 主题。响应不含明文 key。
         */
        post: operations["testProvider"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/providers/{id}/models/{modelId}/context-window": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * 设置或恢复某个模型的上下文上限
         * @description `window` 为整数时写入 source.contextWindows（范围同旧 CONTEXT_WINDOW_MIN/MAX，1000–10000000）。
         *     `null` 恢复默认（目录或环境变量）。推送 providers 主题，并重算相关对话的 context。
         */
        put: operations["putProviderModelContextWindow"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/conversations/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 对话完整快照
         * @description 一次返回 ConversationView、对话流 ThreadItem 列表和工具行 ToolCall。
         *     组装在服务端完成。`lang` 为 zh 或 en（缺省 zh，不认识的按 zh）。
         */
        get: operations["getConversation"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * 切换对话模型
         * @description `model` 为 `{ providerId, modelId }` 时绑定该模型，规则同旧 resolveConversationModelPatch。
         *     `model` 为 null 时回到默认。运行中也能改，下次提交生效。成功后推送该对话主题的 ConversationView.model 和 context。
         */
        patch: operations["patchConversation"];
        trace?: never;
    };
    "/api/v2/conversations/{id}/diff": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 某个变更文件的结构化 diff
         * @description 从现有 liveDiff 的 before/after 生成结构化 hunks，与旧接口 unified 内容逐行一致。
         *     文件过大时 tooLarge 为 true、hunks 为空。没有这个路径的变更 404。
         */
        get: operations["getConversationDiff"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/conversations/{id}/messages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 向对话发消息
         * @description 运行中再发就是插话（Pi Durable `whenBusy: steer`）。
         *     `text` 去掉首尾空白后不能为空。`requestId` 缺省时服务端生成；同一个 requestId 重复请求返回同一个 runId。
         */
        post: operations["postConversationMessage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/conversations/{id}/stop": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 停止对话
         * @description 对话不存在 404。不在运行也返回 202，幂等。
         */
        post: operations["stopConversation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/conversations/{id}/continue": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 点「继续」
         * @description 等同于发送 MANUAL_CONTINUE_TEXT（「继续」）。
         *     `requestId` 缺省时服务端生成；同一个 requestId 重复请求返回同一个 runId。
         */
        post: operations["continueConversation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/conversations/{id}/tools/{toolId}/output": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 某次工具调用的完整输出
         * @description 返回完整输出文字。工作区绝对路径替换成相对路径。
         *     对话或工具不存在 404。
         */
        get: operations["getToolOutput"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/conversations/{id}/subagents/{agentId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 子 Agent 线程快照
         * @description 返回 Subagent 视图，以及用子 Agent 自己的消息组装的 ThreadItem / ToolCall。
         *     子 Agent 没有嵌套的子 Agent 汇报。`lang` 为 zh 或 en（缺省 zh，不认识的按 zh）。
         *     对话或子 Agent 不存在 404。
         */
        get: operations["getSubagent"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/conversations/{id}/subagents/{agentId}/messages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 给子 Agent 发消息
         * @description 调用内核 `sendToAgent`。`text` 去掉首尾空白后不能为空。
         *     对话或子 Agent 不存在 404。子 Agent 不在 running 时 409。
         */
        post: operations["postSubagentMessage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/conversations/{id}/subagents/{agentId}/stop": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 停止子 Agent
         * @description 对话或子 Agent 不存在 404。不在运行也返回 202，幂等。
         */
        post: operations["stopSubagent"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        ServiceInfo: {
            protocolVersion: string;
            serviceVersion: string;
            pid: number;
            /** @description 进程启动时间（毫秒时间戳） */
            startedAt: number;
            /** @description 走本地剧本（WEFT_LLM=faux / LLM_API=faux / WEFT_FAUX_SCRIPT）时为 true，界面要标出「演示模型」 */
            demo: boolean;
        };
        RestartAccepted: {
            /** @description 始终为 true。服务即将退出，由客户端重新拉起。 */
            exiting: boolean;
        };
        SendMessageRequest: {
            /** @description 用户输入。服务端去掉首尾空白后不能为空。 */
            text: string;
            /** @description 幂等键。缺省时服务端生成。同一个 requestId 重复提交返回同一个 runId。 */
            requestId?: string;
        };
        ContinueRequest: {
            /** @description 幂等键。缺省时服务端生成。同一个 requestId 重复提交返回同一个 runId。 */
            requestId?: string;
        };
        RunAccepted: {
            /** @description Pi Durable 这次提交的 id */
            runId: string;
        };
        StopAccepted: {
            /** @description 始终为 true。 */
            stopping: boolean;
        };
        SubagentMessageAccepted: {
            /** @description 始终为 true。 */
            ok: boolean;
        };
        ToolOutput: {
            id: string;
            /** @description 完整输出。工作区绝对路径已换成相对路径。 */
            text: string;
            /** @description 完整输出的行数 */
            totalLines: number;
        };
        /** @description 数据目录里的发现文件 `<dataDir>/service.json`，不对应 HTTP 接口。 */
        ServiceDiscovery: {
            protocolVersion: string;
            serviceVersion: string;
            pid: number;
            /** @description 服务实际监听的端口 */
            port: number;
            /** @description 进程启动时间（毫秒时间戳） */
            startedAt: number;
            /** @description 本机令牌。只存在内存和本文件，服务每次启动轮换 */
            token: string;
        };
        WebCode: {
            code: string;
            /** @description 过期时间（毫秒时间戳） */
            expiresAt: number;
        };
        V2Error: {
            error: string;
            code?: string;
        };
        /** @description 远程设备。契约先定义形状，实现以后再做。 */
        Device: {
            id: string;
            name: string;
            platform: string;
            /** @description 创建时间（毫秒时间戳） */
            createdAt: number;
            /** @description 最近出现时间（毫秒时间戳） */
            lastSeenAt: number;
        };
        /** @description 设备配对请求。契约先定义形状，实现以后再做。 */
        PairingRequest: {
            code: string;
            deviceName: string;
            platform: string;
        };
        /** @description 快照里的一条实体。SSE event=snapshot 的 entities 项。 */
        EntityRef: {
            topic: string;
            entity: string;
            id: string;
            /** @description 各主题的实体类型以后各自定义 */
            value: {
                [key: string]: unknown;
            };
        };
        /** @description SSE event=snapshot 的 data。连接时或续传补不上时发送；SSE id 为开始计算快照时的最新序号，计算期间到达的事件在快照之后按序补发。订阅不存在的 conversation:<id> 时 entities 为空，并列出 missing。 */
        SnapshotEvent: {
            protocolVersion: string;
            topics: string[];
            entities: components["schemas"]["EntityRef"][];
            /** @description 已订阅但快照阶段发现不存在的主题（例如 conversation:<id> 对应的对话不存在）。空则省略。 */
            missing?: string[];
        };
        /** @description SSE event=upsert 的 data。实体整个替换，客户端按 id 覆盖。 */
        UpsertEvent: {
            topic: string;
            entity: string;
            id: string;
            /** @description 各主题的实体类型以后各自定义 */
            value: {
                [key: string]: unknown;
            };
        };
        /** @description SSE event=remove 的 data。实体删除。 */
        RemoveEvent: {
            topic: string;
            entity: string;
            id: string;
        };
        /** @description SSE event=text.delta 的 data。只用于流式文字。offset 是追加前的长度。offset 等于当前长度时追加；现有文字从 offset 起已等于 append 时视为已应用、忽略；其他对不上的情况客户端丢掉本地内容，等下一次 upsert。 */
        TextDeltaEvent: {
            topic: string;
            itemId: string;
            offset: number;
            append: string;
        };
        /** @description SSE event=heartbeat 的 data。不带 id，不进环形缓冲。 */
        HeartbeatEvent: Record<string, never>;
        /** @description 单条工具调用的视图模型。全文按需拉 GET /api/v2/tools/<id>/output。 */
        ToolCall: {
            id: string;
            /** @description 所属工具组 id，由组内第一条调用算出 */
            groupId: string;
            /** @enum {string} */
            kind: "read" | "write" | "edit" | "ls" | "grep" | "bash" | "other";
            /** @enum {string} */
            status: "running" | "failed" | "interrupted" | "done";
            heading: {
                title: string;
                detail: string;
                /** @description title 是否来自 input.description */
                fromIntent: boolean;
            };
            /** @description 相对工作区路径。没有则省略 */
            path?: string;
            hint: {
                text: string;
                failed: boolean;
            };
            /** @enum {string} */
            failure: "none" | "probe" | "real";
            /** @description 没有增删行数时为 null */
            diff: null | {
                added: number | null;
                removed: number | null;
            };
            /** @description bash 有退出码时带上，否则省略 */
            exitCode?: number;
            output: {
                /** @description 成功取前 20 行，失败取 TOOL_ERROR_PREVIEW_LINES 行 */
                preview: string;
                truncated: boolean;
                totalLines: number;
            };
        };
        /** @description 工具组摘要。对应 ThreadItem.tool_group.summary。 */
        ToolGroupSummary: {
            /** @description 按客户端语言出成的摘要句子 */
            text: string;
            /** @description 组内真实失败（不含试探失败）的条数 */
            failed: number;
            running: boolean;
        };
        /** @description 行内代码里在工作区中真实存在的文件路径。各端渲染 Markdown 时把这些变成可点的标签。 */
        PathRef: {
            /** @description 行内代码的原文 */
            text: string;
            /** @description 相对工作区的路径（统一用 /） */
            path: string;
            /** @description 来自行内代码里的 :行号 后缀 */
            line?: number;
        };
        /** @description 上下文用量视图。窗口由调用方传入（手动覆盖 → Provider 默认 → 模型目录 → 环境变量）；缺省 128000。 */
        ContextUsage: {
            /** @description 已占用的上下文 token 数。没有用量时为 0 */
            used: number;
            /** @description 上下文窗口大小 */
            window: number;
            /** @description 已用百分比，四舍五入，上限 100 */
            percent: number;
            /**
             * @description percent < 80 为 ok，80 到 94 为 warn，≥ 95 为 full
             * @enum {string}
             */
            level: "ok" | "warn" | "full";
        };
        /** @description 用户消息。 */
        ThreadItemUser: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "user";
            id: string;
            /** @description Markdown 原文 */
            text: string;
            pathRefs: components["schemas"]["PathRef"][];
        };
        /** @description 助手回复。空文字的助手消息不进入对话流。 */
        ThreadItemAssistant: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "assistant";
            id: string;
            /** @description Markdown 原文 */
            text: string;
            pathRefs: components["schemas"]["PathRef"][];
            /** @description 这条回复用的模型 id。没有则省略 */
            model?: string;
            streaming: boolean;
            /** @description 最后一条可见回复且 stopReason 为 length 时为 true，客户端显示继续 */
            truncated: boolean;
        };
        /** @description 连续工具调用合成的一组。 */
        ThreadItemToolGroup: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "tool_group";
            /** @description 工具组 id，等于 toolGroupKey */
            id: string;
            /** @description 组内 ToolCall id，按出现顺序 */
            toolIds: string[];
            summary: components["schemas"]["ToolGroupSummary"];
            /** @description 它是对话流最后一项且对话正在运行时为 true */
            live: boolean;
        };
        /** @description 子 Agent 汇报。存成用户输入，界面不画成用户气泡。 */
        ThreadItemSubagentReport: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "subagent_report";
            id: string;
            /** @description 按 name 找到的子 Agent id；找不到为 null */
            subagentId: null | string;
            name: string;
            /** @enum {string} */
            reportKind: "answered" | "failed";
            body: string;
        };
        /** @description 系统提示。auto_continue 的 text 是服务端出成的句子。 */
        ThreadItemSystemNote: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "system_note";
            id: string;
            /** @enum {string} */
            noteKind: "auto_continue" | "correction" | "note";
            text: string;
        };
        /** @description 对话流里的一项。按 kind 区分。 */
        ThreadItem: components["schemas"]["ThreadItemUser"] | components["schemas"]["ThreadItemAssistant"] | components["schemas"]["ThreadItemToolGroup"] | components["schemas"]["ThreadItemSubagentReport"] | components["schemas"]["ThreadItemSystemNote"];
        /** @description 当前运行状态。供输入框、停止按钮和等待提示使用。 */
        RunState: {
            /**
             * @description present() 状态归一。recovering、resuming 算 running；paused 算 waiting；error 算 failed；done 算 idle
             * @enum {string}
             */
            status: "idle" | "running" | "waiting" | "failed" | "stopped";
            /** @description 这次运行的开始时间（毫秒）。Harness 提交记录没有该字段时为 null */
            startedAt: null | number;
            /** @description running 时的等待句子，其它状态为 null */
            pendingText: null | string;
            /** @description 有工作区时为 true。运行中也能发，会作为插话 */
            canSend: boolean;
            /** @description running 时为 true */
            canStop: boolean;
            /** @description 没有工作区时为 no_workspace，否则 null */
            lockedReason: null | "no_workspace";
            /** @description status 为 failed 时带上，否则 null */
            error: null | {
                code: string;
                message: string;
                retry?: {
                    attempt: number;
                    delayMs: number;
                };
            };
        };
        /** @description 对话当前模型。取对话自己选的或默认模型。 */
        ConversationModel: {
            sourceId: string;
            modelId: string;
            /** @description 先用 modelId */
            label: string;
        };
        /**
         * @description agent 只在契约里预留，当前实现不会返回。
         * @enum {string}
         */
        ProviderAccess: "api_key" | "account" | "local" | "custom_endpoint" | "agent";
        /** @enum {string} */
        ProviderStatus: "ok" | "needs_auth" | "unreachable" | "error" | "untested";
        /** @description Provider 上的一个可用模型。 */
        ProviderModel: {
            id: string;
            /** @description 按品牌表算出的显示名；认不出品牌时等于 id */
            displayName: string;
            /** @description 品牌 id，认不出为 null */
            brand: null | string;
            /** @description 手动覆盖 → 模型目录 → 环境变量 */
            contextWindow: number;
            /** @description true 表示用户手动覆盖 */
            contextWindowCustom: boolean;
        };
        /** @description 模型来源的视图。响应和日志都不含明文 API key。 */
        Provider: {
            id: string;
            /** @description 品牌 id，认不出为 null */
            vendor: null | string;
            name: string;
            access: components["schemas"]["ProviderAccess"];
            /**
             * @description 当前实现恒为 model。agent 只在契约里预留。
             * @enum {string}
             */
            runtime: "model" | "agent";
            baseUrl: string;
            /** @description 没有 key 时为 null。永远不是明文 */
            keyMasked: null | string;
            hasKey: boolean;
            status: components["schemas"]["ProviderStatus"];
            /** @description 服务端按 lang 出成句。ok / untested 时为空字符串 */
            statusText: string;
            /** @description 最近一次探测时间（毫秒）。从未探测为 null */
            lastTestedAt: null | number;
            models: components["schemas"]["ProviderModel"][];
            isDefault: boolean;
        };
        /** @description 可添加的厂商预设（VENDOR_PRESETS）。不含 Grok。 */
        Vendor: {
            id: string;
            name: string;
            access: components["schemas"]["ProviderAccess"];
            needsKey: boolean;
            /** @description 预设默认地址。custom 为空字符串 */
            baseUrl: string;
            /** @description 品牌 id，认不出为 null */
            brand: null | string;
        };
        /** @description 对话或默认绑定的 Provider + 模型。 */
        ResolvedModel: {
            providerId: string;
            modelId: string;
        };
        /** @description GET /api/v2/providers 的响应。 */
        ProvidersSnapshot: {
            providers: components["schemas"]["Provider"][];
            vendors: components["schemas"]["Vendor"][];
            /** @description 当前默认模型。没有则为 null */
            defaultModel: null | components["schemas"]["ResolvedModel"];
        };
        /** @description providers 主题里 defaults/self 实体的值。 */
        ProviderDefaults: {
            /** @description 当前默认模型。没有则为 null */
            model: null | components["schemas"]["ResolvedModel"];
        };
        /** @description 创建 API Provider。规则同旧 POST /api/sources。 */
        CreateProviderRequest: {
            vendor: string;
            name?: string;
            baseUrl?: string;
            apiKey?: string;
            models?: string[];
        };
        /** @description 修改已保存的 Provider。applySourcePatch 规则。 */
        PatchProviderRequest: {
            vendor?: string;
            name?: string;
            baseUrl?: string;
            apiKey?: string;
            models?: string[];
            /** @description 把该 Provider 上的这个模型设为默认；null 且当前默认就是它时清空默认 */
            defaultModel?: null | string;
        };
        /** @description 未保存配置的连通性测试。请求只发往这里的 baseUrl（或 vendor 预设地址）。 */
        TestProviderRequest: {
            vendor: string;
            baseUrl?: string;
            apiKey?: string;
        };
        /** @description 未保存配置的探测结果。失败时 models 为空数组。 */
        ProviderProbeResult: {
            ok: boolean;
            models: string[];
            status: components["schemas"]["ProviderStatus"];
            statusText: string;
        };
        ContextWindowRequest: {
            /** @description 新的上下文上限；null 恢复默认。整数范围 1000–10000000 */
            window: null | number;
        };
        /** @description DELETE /api/v2/providers/{id} 成功。 */
        ProviderRemoved: {
            /** @constant */
            removed: true;
        };
        /** @description PATCH /api/v2/conversations/{id} 的请求体。 */
        PatchConversationModelRequest: {
            /** @description 绑定的模型；null 回到默认 */
            model: null | components["schemas"]["ResolvedModel"];
        };
        /** @description 进行中的设备码登录。 */
        GrokPending: {
            loginId: string;
            verificationUri: string;
            userCode: string;
            /** @description 建议轮询间隔（秒） */
            interval: number;
            /** @description 设备码过期时间（毫秒） */
            expiresAt: number;
        };
        /** @description Grok Build 会话。不含 access / refresh token。 */
        GrokSession: {
            signedIn: boolean;
            account: null | string;
            email: null | string;
            /** @description 会话过期时间（毫秒）。未登录为 null */
            expiresAt: null | number;
            authMode: null | string;
            source: null | string;
            /** @description 进行中的设备码登录。没有则为 null */
            pending: null | components["schemas"]["GrokPending"];
        };
        GrokLoginStart: components["schemas"]["GrokPending"];
        GrokLoginPollRequest: {
            loginId: string;
        };
        GrokLoginCancelRequest: {
            loginId?: string;
        };
        GrokLoginPending: {
            /** @constant */
            status: "pending";
            interval: number;
            /** @description 设备码过期时间（毫秒） */
            expiresAt: number;
        };
        GrokLoginDone: {
            /** @constant */
            status: "done";
            grok: components["schemas"]["GrokSession"];
        };
        GrokLoginPollResult: components["schemas"]["GrokLoginPending"] | components["schemas"]["GrokLoginDone"];
        /** @description 侧栏工作区。 */
        Workspace: {
            id: string;
            name: string;
            path: string;
            /** @enum {string} */
            source: "local" | "git";
            /** @description Git 导入时去掉凭据后的仓库地址。本地工作区为 null */
            gitUrl: null | string;
            /** @description Git 导入时的分支。本地工作区或未指定分支为 null */
            branch: null | string;
            /** @description 该工作区下的对话数 */
            conversationCount: number;
            /** @description 状态为 running 的对话数（recovering、resuming 算 running） */
            runningCount: number;
        };
        /** @description 子 Agent 总数和正在跑的数量。没有子 Agent 时 ConversationSummary.subagents 为 null。 */
        SubagentCounts: {
            total: number;
            live: number;
        };
        /** @description 侧栏对话摘要。 */
        ConversationSummary: {
            id: string;
            workspaceId: string;
            title: string;
            /** @description 毫秒时间戳 */
            updatedAt: number;
            /**
             * @description 按设计 6.1 归一。recovering、resuming 算 running；paused 算 waiting；error 算 failed；stopped 算 idle
             * @enum {string}
             */
            status: "idle" | "running" | "waiting" | "failed";
            /** @description 主 Agent 运行算 1，加上运行中的子 Agent 数。与旧版 conversationMeta「N 个 Agent 运行中」一致 */
            runningAgents: number;
            /** @description 没有子 Agent 时为 null */
            subagents: null | components["schemas"]["SubagentCounts"];
            archived: boolean;
        };
        /** @description GET /api/v2/workspaces 的响应。 */
        WorkspacesSnapshot: {
            workspaces: components["schemas"]["Workspace"][];
            /** @description 每个工作区下的对话按 updatedAt 倒序，再按工作区列表顺序拼接 */
            conversations: components["schemas"]["ConversationSummary"][];
        };
        /** @description 新建对话。title 缺省为 New conversation。 */
        CreateConversationRequest: {
            title?: string;
        };
        /** @description DELETE /api/v2/workspaces/{id} 成功。 */
        WorkspaceRemoved: {
            /** @constant */
            removed: true;
        };
        /** @description 工作区里还有运行中的对话。 */
        WorkspaceBusy: {
            error: string;
            /** @constant */
            code: "E_WS_BUSY";
            /** @description 正在运行、因此挡住移除的对话 id */
            conversations: string[];
        };
        /** @description 一个对话的视图。摘要字段加上模型、运行状态、上下文和对话流顺序。 */
        ConversationView: {
            id: string;
            workspaceId: string;
            title: string;
            /** @description 毫秒时间戳 */
            updatedAt: number;
            /**
             * @description 按设计 6.1 归一。stopped 算 idle
             * @enum {string}
             */
            status: "idle" | "running" | "waiting" | "failed";
            /** @description 解析不到时为 null */
            model: null | components["schemas"]["ConversationModel"];
            run: components["schemas"]["RunState"];
            context: components["schemas"]["ContextUsage"];
            /** @description 对话流 ThreadItem id 的顺序 */
            itemIds: string[];
        };
        /** @description GET /api/v2/conversations/{id} 的响应。客户端按 itemIds 画对话流，按 toolIds 取工具行。 */
        ConversationSnapshot: {
            conversation: components["schemas"]["ConversationView"];
            items: components["schemas"]["ThreadItem"][];
            tools: components["schemas"]["ToolCall"][];
        };
        /** @description 侧栏和子线程里的子 Agent 视图。卡住由服务端判定。 */
        Subagent: {
            /** @description 子 Agent id，形如 `<cid>:sub:<子对话 id>` */
            id: string;
            /** @description 所属主对话 id */
            parentConversationId: string;
            /** @description 按 title → brief 第一行 → lastText → name 回退 */
            title: string;
            name: string;
            /** @enum {string} */
            mode: "foreground" | "background";
            /**
             * @description kernel 的 error 归为 failed。running 且超过 stuckAfterMs 没有活动则为 stuck
             * @enum {string}
             */
            status: "waiting" | "running" | "stuck" | "done" | "stopped" | "failed";
            /** @description 开始时间（毫秒）。没有则为 null */
            startedAt: null | number;
            /** @description 最近活动时间（毫秒）。没有则为 null */
            lastActivityAt: null | number;
            /** @description 结束时间（毫秒）。未结束则为 null */
            endedAt: null | number;
            /** @description 正在做的事。非 running/stuck 或没有则为 null */
            currentAction: null | string;
            /** @description 步数。没有 step/total 则为 null */
            progress: null | {
                step: number;
                total: number;
            };
        };
        /** @description GET /api/v2/conversations/{id}/subagents/{agentId} 的响应。 */
        SubagentSnapshot: {
            subagent: components["schemas"]["Subagent"];
            items: components["schemas"]["ThreadItem"][];
            tools: components["schemas"]["ToolCall"][];
        };
        /** @description 对话右栏变更列表的一项。SSE conversation 主题里 entity=change，id 为 path。 */
        Change: {
            /** @description 相对工作区的路径，统一用 `/` */
            path: string;
            added: number;
            removed: number;
            /** @description 例如文件过大。没有则为 null */
            error: null | string;
        };
        DiffLine: {
            /** @enum {string} */
            op: "ctx" | "add" | "del";
            /** @description 不含换行符的一行 */
            text: string;
            /** @description 旧文件行号（1 起）。add 为 null */
            oldLine: null | number;
            /** @description 新文件行号（1 起）。del 为 null */
            newLine: null | number;
        };
        DiffHunk: {
            oldStart: number;
            oldLines: number;
            newStart: number;
            newLines: number;
            lines: components["schemas"]["DiffLine"][];
        };
        /** @description GET /api/v2/conversations/{id}/diff 的响应。 */
        Diff: {
            /** @description 相对工作区的路径，统一用 `/` */
            path: string;
            added: number;
            removed: number;
            hunks: components["schemas"]["DiffHunk"][];
            /** @description 文件过大时为 true，此时 hunks 为空 */
            tooLarge: boolean;
        };
        /** @description 工作区文件树的一项。 */
        FileNode: {
            /** @description 相对工作区的路径，统一用 `/` */
            path: string;
            /** @enum {string} */
            type: "file" | "dir";
        };
        /** @description GET /api/v2/workspaces/{id}/tree 的响应。 */
        FileTree: {
            entries: components["schemas"]["FileNode"][];
            /** @description 达到 500 条上限时为 true */
            truncated: boolean;
        };
        /** @description GET /api/v2/workspaces/{id}/files 的响应。 */
        FileContent: {
            /** @description 相对工作区的路径，统一用 `/` */
            path: string;
            /** @description 字节数 */
            size: number;
            binary: boolean;
            tooLarge: boolean;
            /** @description 文本内容。binary 或 tooLarge 时为 null */
            text: null | string;
            /** @description 内容 sha256 十六进制前 16 位 */
            version: string;
        };
        /** @description PUT /api/v2/workspaces/{id}/files 的请求体。 */
        SaveFileRequest: {
            path: string;
            text: string;
            /** @description 上次读到的 version。带了且与磁盘当前不同则 409，不写入 */
            baseVersion?: string;
        };
        /** @description PUT /api/v2/workspaces/{id}/files 成功。 */
        SaveResult: {
            path: string;
            version: string;
            added: number;
            removed: number;
        };
        /** @description 保存时 baseVersion 过期。 */
        FileConflict: {
            error: string;
            /** @constant */
            code: "E_CONFLICT";
            current: components["schemas"]["FileContent"];
        };
        /** @description POST /api/v2/workspaces 的请求体。 */
        CreateWorkspaceRequest: {
            name: string;
            /** @enum {string} */
            source: "local" | "git";
            /** @description source=local 时的本机目录。缺省则在数据目录下建空目录 */
            path?: string;
            /** @description source=git 时的仓库地址 */
            gitUrl?: string;
            branch?: string;
            connectionId?: string;
            /** @description GitLab 项目 id，需同时带 connectionId */
            projectId?: string | number;
        };
        /** @description 新建工作区失败。路径越界带 allowedRoot；Git 失败带 code / via。 */
        WorkspaceCreateError: {
            /** @description 按 lang 出成句 */
            error: string;
            code?: string;
            allowedRoot?: string;
            detail?: string;
            via?: string;
        };
        /** @description Git 克隆或 GitLab API 失败。 */
        GitCloneFailure: {
            /** @description 按 lang 出成句 */
            error: string;
            /** @description git_not_found、auth_failed、cert_failed 等，与旧接口相同 */
            code?: string;
            detail?: string;
            via?: string;
        };
        /** @description GET /api/v2/workspace-root。 */
        WorkspaceRoot: {
            root: string;
        };
        /** @description GET /api/v2/workspace-root/dirs。 */
        WorkspaceDirs: {
            root: string;
            path: string;
            /** @description 已在根目录时为 null */
            parent: null | string;
            selectable: boolean;
            git: boolean;
            entries: components["schemas"]["WorkspaceDirEntry"][];
            truncated: boolean;
        };
        WorkspaceDirEntry: {
            name: string;
            path: string;
            git: boolean;
        };
        /** @description 本地路径不在允许范围内。 */
        PathNotAllowed: {
            /** @description 按 lang 出成句 */
            error: string;
            /** @constant */
            code: "E_PATH";
            allowedRoot: string;
        };
        /** @description 插件。失败原因由服务端按 lang 出成句。 */
        Plugin: {
            id: string;
            name: string;
            description: string;
            version: string;
            source: string;
            enabled: boolean;
            loaded: boolean;
            /** @description 失败原因成句。正常为 null */
            error: null | string;
            /** @description 结构化失败码。正常为 null */
            errorCode: null | string;
            tools: components["schemas"]["PluginTool"][];
        };
        PluginTool: {
            name: string;
            description: string;
        };
        PluginList: {
            plugins: components["schemas"]["Plugin"][];
        };
        /** @description 本机插件目录。 */
        InstallPluginRequest: {
            path?: string;
        };
        PatchPluginRequest: {
            enabled?: boolean;
        };
        /** @description 技能。写失败时的原因在 CatalogError 里按 lang 出成句。 */
        Skill: {
            id: string;
            name: string;
            description: string;
            version: string;
            source: string;
            enabled: boolean;
            deletable: boolean;
        };
        SkillList: {
            skills: components["schemas"]["Skill"][];
        };
        SkillWriteRequest: {
            id?: string;
            name?: string;
            description?: string;
            body?: string;
            enabled?: boolean;
        };
        /** @description 插件或技能写操作失败。 */
        CatalogError: {
            /** @description 按 lang 出成句 */
            error: string;
            /** @description err_plugin_* / err_skill_*，与旧接口相同 */
            code?: string;
        };
        /** @description Git 连接。令牌只返回打码值。 */
        GitConnection: {
            id: string;
            name: string;
            /** @enum {string} */
            kind: "gitlab-self" | "gitlab-com" | "other";
            baseUrl: string;
            /** @description 打码后的令牌，不含明文 */
            token: string;
            hasToken: boolean;
            allowHttp: boolean;
            caFile: string;
            /** @description 尚未测试时为 null */
            lastTest: null | components["schemas"]["GitConnectionLastTest"];
        };
        GitConnectionLastTest: {
            ok: boolean;
            username: string;
            /** @description 失败码。成功时为空字符串 */
            error: string;
            /** @description 按 lang 出成句 */
            errorText: string;
            at: string;
        };
        GitConnectionList: {
            connections: components["schemas"]["GitConnection"][];
        };
        GitConnectionWrite: {
            id?: string;
            kind?: string;
            name?: string;
            baseUrl?: string;
            token?: string;
            allowHttp?: boolean;
            caFile?: string;
        };
        GitConnectionInvalid: {
            /** @description 按 lang 出成句 */
            error: string;
            code?: string;
            /** @description 与旧接口相同的字段级错误（name required 等） */
            errors: string[];
        };
        /** @description Git 连接测试结果。 */
        GitTestResult: {
            ok: boolean;
            username: string;
            /** @description 失败码。成功时为空字符串 */
            code: string;
            /** @description 按 lang 出成句 */
            statusText: string;
            connection?: components["schemas"]["GitConnection"];
        };
        GitProject: {
            /** @description GitLab 项目 id */
            id: string | number;
            path: string;
            description: string;
            defaultBranch: string;
            lastActivityAt: string;
            /** @description 去掉凭据后的 http 克隆地址 */
            httpUrl: string;
        };
        GitProjectList: {
            projects: components["schemas"]["GitProject"][];
        };
        GitBranch: {
            name: string;
            default: boolean;
        };
        GitBranchList: {
            branches: components["schemas"]["GitBranch"][];
            defaultBranch: string;
        };
        /** @description 删除成功。 */
        OkId: {
            /** @constant */
            ok: true;
            id: string;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    getService: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 当前进程的服务信息 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ServiceInfo"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    restartService: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 已接受，服务即将退出。重新拉起由客户端完成。 */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RestartAccepted"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 有活着的任务，此时不能退出 */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    createWebCode: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": Record<string, never>;
            };
        };
        responses: {
            /** @description 一次性登录码 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WebCode"];
                };
            };
            /** @description 请求体不是 JSON 对象 */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 未授权（仅接受 Bearer 本机令牌） */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 请求体过大 */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    getEvents: {
        parameters: {
            query: {
                /** @description 逗号分隔的主题列表。空或含未注册主题时 400。`workspaces`、`providers`、`extensions` 已注册；`conversation:<id>` 和 `subagent:<cid>:<agentId>` 按前缀视为已注册。 */
                topics: string;
                /** @description 客户端语言。先支持 zh、en；缺省或不认识的按 zh。 */
                lang?: string;
                /** @description 给不方便设 Last-Event-ID 头的客户端。与 Last-Event-ID 头效果相同。 */
                lastEventId?: string;
            };
            header?: {
                /** @description 上次收到的事件序号。缓冲里还有它之后的全部事件则按主题过滤补发，否则发快照。 */
                "Last-Event-ID"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description SSE 事件流 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/event-stream": string;
                };
            };
            /** @description 主题列表为空或含未注册主题 */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    getWorkspaces: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 工作区和对话摘要 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspacesSnapshot"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    createWorkspace: {
        parameters: {
            query?: {
                /** @description 失败文案语言。zh 或 en；缺省或不认识的按 zh。 */
                lang?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateWorkspaceRequest"];
            };
        };
        responses: {
            /** @description 已创建 */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Workspace"];
                };
            };
            /** @description 名称、路径或 Git 地址无效 */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceCreateError"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description Git 连接不存在 */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    getWorkspaceRoot: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 根目录 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceRoot"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    listWorkspaceRootDirs: {
        parameters: {
            query?: {
                /** @description 要列出的目录。缺省为工作区根目录。 */
                path?: string;
                lang?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 当前目录和子文件夹 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceDirs"];
                };
            };
            /** @description 路径不允许 */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PathNotAllowed"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 路径不存在 */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PathNotAllowed"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    listGitConnections: {
        parameters: {
            query?: {
                lang?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 连接列表 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GitConnectionList"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    createGitConnection: {
        parameters: {
            query?: {
                lang?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["GitConnectionWrite"];
            };
        };
        responses: {
            /** @description 已创建 */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GitConnection"];
                };
            };
            /** @description 连接字段无效 */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GitConnectionInvalid"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    testGitConnectionUnsaved: {
        parameters: {
            query?: {
                lang?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["GitConnectionWrite"];
            };
        };
        responses: {
            /** @description 测试结果 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GitTestResult"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 带了 id 但连接不存在 */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    deleteGitConnection: {
        parameters: {
            query?: {
                lang?: string;
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": Record<string, never>;
            };
        };
        responses: {
            /** @description 已删除 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OkId"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 连接不存在 */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    updateGitConnection: {
        parameters: {
            query?: {
                lang?: string;
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["GitConnectionWrite"];
            };
        };
        responses: {
            /** @description 更新后的连接 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GitConnection"];
                };
            };
            /** @description 连接字段无效 */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GitConnectionInvalid"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 连接不存在 */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    testGitConnection: {
        parameters: {
            query?: {
                lang?: string;
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": Record<string, never>;
            };
        };
        responses: {
            /** @description 测试结果 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GitTestResult"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 连接不存在 */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    listGitConnectionProjects: {
        parameters: {
            query?: {
                search?: string;
                lang?: string;
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 项目列表 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GitProjectList"];
                };
            };
            /** @description 连接不可用 */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GitCloneFailure"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 连接不存在 */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    listGitConnectionProjectBranches: {
        parameters: {
            query?: {
                lang?: string;
            };
            header?: never;
            path: {
                id: string;
                pid: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 分支列表 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GitBranchList"];
                };
            };
            /** @description 连接不可用 */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GitCloneFailure"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 连接不存在 */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    listPlugins: {
        parameters: {
            query?: {
                lang?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 插件列表 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PluginList"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    installPlugin: {
        parameters: {
            query?: {
                lang?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["InstallPluginRequest"];
            };
        };
        responses: {
            /** @description 已导入 */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Plugin"];
                };
            };
            /** @description 路径或清单无效 */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CatalogError"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 同名插件已存在 */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CatalogError"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    patchPlugin: {
        parameters: {
            query?: {
                lang?: string;
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PatchPluginRequest"];
            };
        };
        responses: {
            /** @description 更新后的插件 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Plugin"];
                };
            };
            /** @description 插件 id 无效 */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CatalogError"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 插件不存在 */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CatalogError"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    listSkills: {
        parameters: {
            query?: {
                lang?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 技能列表 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SkillList"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    createSkill: {
        parameters: {
            query?: {
                lang?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SkillWriteRequest"];
            };
        };
        responses: {
            /** @description 已创建 */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Skill"];
                };
            };
            /** @description 内容无效 */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CatalogError"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 同名技能已存在 */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CatalogError"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    putSkill: {
        parameters: {
            query?: {
                lang?: string;
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SkillWriteRequest"];
            };
        };
        responses: {
            /** @description 更新后的技能 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Skill"];
                };
            };
            /** @description 内容无效 */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CatalogError"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 技能不存在 */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CatalogError"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    deleteSkill: {
        parameters: {
            query?: {
                lang?: string;
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": Record<string, never>;
            };
        };
        responses: {
            /** @description 已删除 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OkId"];
                };
            };
            /** @description id 无效 */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CatalogError"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 内置技能不能删除 */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CatalogError"];
                };
            };
            /** @description 技能不存在 */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CatalogError"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    patchSkill: {
        parameters: {
            query?: {
                lang?: string;
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SkillWriteRequest"];
            };
        };
        responses: {
            /** @description 更新后的技能 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Skill"];
                };
            };
            /** @description 内容无效 */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CatalogError"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 技能不存在 */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CatalogError"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    createWorkspaceConversation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 工作区 id */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateConversationRequest"];
            };
        };
        responses: {
            /** @description 已创建 */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConversationSummary"];
                };
            };
            /** @description 请求体无效 */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 工作区不存在 */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    removeWorkspace: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 工作区 id */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 已移除 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceRemoved"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 工作区不存在 */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 有运行中的对话，不能移除 */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceBusy"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    getWorkspaceTree: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 工作区 id */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 文件树 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FileTree"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 路径越界 */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 工作区不存在 */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    getWorkspaceFile: {
        parameters: {
            query: {
                /** @description 相对工作区的文件路径 */
                path: string;
            };
            header?: never;
            path: {
                /** @description 工作区 id */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 文件内容 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FileContent"];
                };
            };
            /** @description 路径是目录或缺少 path */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 路径越界 */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 工作区或文件不存在 */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    saveWorkspaceFile: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 工作区 id */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SaveFileRequest"];
            };
        };
        responses: {
            /** @description 已保存 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SaveResult"];
                };
            };
            /** @description 请求体无效或路径是目录 */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 路径越界 */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 工作区不存在 */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description baseVersion 与磁盘当前 version 不一致 */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FileConflict"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    getProviders: {
        parameters: {
            query?: {
                /** @description 客户端语言。先支持 zh、en；缺省或不认识的按 zh。 */
                lang?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Provider 快照 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProvidersSnapshot"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    createProvider: {
        parameters: {
            query?: {
                lang?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateProviderRequest"];
            };
        };
        responses: {
            /** @description 已创建 */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Provider"];
                };
            };
            /** @description 请求体无效 */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description id 已存在 */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    testProviderDraft: {
        parameters: {
            query?: {
                lang?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TestProviderRequest"];
            };
        };
        responses: {
            /** @description 探测结果 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProviderProbeResult"];
                };
            };
            /** @description 请求体无效 */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    getGrokSession: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 当前会话 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GrokSession"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    startGrokLogin: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": Record<string, never>;
            };
        };
        responses: {
            /** @description 设备码已签发 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GrokLoginStart"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 登录服务不可用 */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    pollGrokLogin: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["GrokLoginPollRequest"];
            };
        };
        responses: {
            /** @description 仍在等待或已完成 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GrokLoginPollResult"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 没有进行中的登录 */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 登录失败或过期 */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    cancelGrokLogin: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["GrokLoginCancelRequest"];
            };
        };
        responses: {
            /** @description 当前会话 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GrokSession"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    logoutGrok: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": Record<string, never>;
            };
        };
        responses: {
            /** @description 当前会话 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GrokSession"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 退出失败 */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    deleteProvider: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Provider id */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 已删除 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProviderRemoved"];
                };
            };
            /** @description 不能删除 Grok */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description Provider 不存在 */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    patchProvider: {
        parameters: {
            query?: {
                lang?: string;
            };
            header?: never;
            path: {
                /** @description Provider id */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PatchProviderRequest"];
            };
        };
        responses: {
            /** @description 更新后的 Provider */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Provider"];
                };
            };
            /** @description 请求体无效或 applySourcePatch 拒绝 */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description Provider 不存在 */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    testProvider: {
        parameters: {
            query?: {
                lang?: string;
            };
            header?: never;
            path: {
                /** @description Provider id */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": Record<string, never>;
            };
        };
        responses: {
            /** @description 更新后的 Provider */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Provider"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description Provider 不存在 */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    putProviderModelContextWindow: {
        parameters: {
            query?: {
                lang?: string;
            };
            header?: never;
            path: {
                /** @description Provider id */
                id: string;
                /** @description 模型 id（含斜杠时需百分号编码） */
                modelId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ContextWindowRequest"];
            };
        };
        responses: {
            /** @description 更新后的 Provider */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Provider"];
                };
            };
            /** @description 窗口超出范围或请求体无效 */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description Provider 不存在 */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    getConversation: {
        parameters: {
            query?: {
                /** @description 客户端语言。先支持 zh、en；缺省或不认识的按 zh。 */
                lang?: string;
            };
            header?: never;
            path: {
                /** @description 对话 id */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 对话快照 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConversationSnapshot"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 对话不存在 */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    patchConversation: {
        parameters: {
            query?: {
                lang?: string;
            };
            header?: never;
            path: {
                /** @description 对话 id */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PatchConversationModelRequest"];
            };
        };
        responses: {
            /** @description 更新后的对话视图 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConversationView"];
                };
            };
            /** @description 模型不存在或请求体无效 */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 对话不存在 */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    getConversationDiff: {
        parameters: {
            query: {
                /** @description 相对工作区的文件路径 */
                path: string;
            };
            header?: never;
            path: {
                /** @description 对话 id */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 结构化 diff */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Diff"];
                };
            };
            /** @description 缺少 path */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 对话不存在或没有这个路径的变更 */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    postConversationMessage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 对话 id */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SendMessageRequest"];
            };
        };
        responses: {
            /** @description 已接受，对话开始或继续运行 */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunAccepted"];
                };
            };
            /** @description 空文字或请求体无效 */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 对话不存在 */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 对话没有工作区 */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    stopConversation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 对话 id */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 已接受停止（含本就未在运行） */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StopAccepted"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 对话不存在 */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    continueConversation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 对话 id */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ContinueRequest"];
            };
        };
        responses: {
            /** @description 已接受 */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunAccepted"];
                };
            };
            /** @description 请求体无效 */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 对话不存在 */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 对话没有工作区 */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    getToolOutput: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 对话 id */
                id: string;
                /** @description 工具调用 id */
                toolId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 完整输出 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ToolOutput"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 对话或工具不存在 */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    getSubagent: {
        parameters: {
            query?: {
                /** @description 客户端语言。先支持 zh、en；缺省或不认识的按 zh。 */
                lang?: string;
            };
            header?: never;
            path: {
                /** @description 父对话 id */
                id: string;
                /** @description 子 Agent id，形如 `<cid>:sub:<子对话 id>` */
                agentId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 子 Agent 线程快照 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SubagentSnapshot"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 对话或子 Agent 不存在 */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    postSubagentMessage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 父对话 id */
                id: string;
                /** @description 子 Agent id */
                agentId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SendMessageRequest"];
            };
        };
        responses: {
            /** @description 已接受 */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SubagentMessageAccepted"];
                };
            };
            /** @description 空文字或请求体无效 */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 对话或子 Agent 不存在 */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 子 Agent 不在运行 */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
    stopSubagent: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 父对话 id */
                id: string;
                /** @description 子 Agent id */
                agentId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 已接受停止（含本就未在运行） */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StopAccepted"];
                };
            };
            /** @description 未授权 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 对话或子 Agent 不存在 */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 客户端错误 */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 服务端错误 */
            "5XX": {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
        };
    };
}
