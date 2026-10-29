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
         *     - `workspace`：id 为工作区 id，值为 Workspace（含可选 git 状态）
         *     - `conversation_summary`：id 为对话 id，值为 ConversationSummary
         *
         *     快照与 GET /api/v2/workspaces 同一套数据拆成上述实体。工作区或对话增删改、运行状态、子 Agent 计数或 git 状态变化时 upsert；实体删除时 remove。值没变不推送。
         *
         *     主题 `providers` 注册为精确主题。实体：
         *     - `provider`：id 为 Provider id，值为 Provider
         *     - `defaults`：id 为 `self`，值为 ProviderDefaults（`model` 为当前默认 `{ providerId, modelId }`，没有则为 null）
         *
         *     快照是 GET /api/v2/providers 的 providers 与 defaultModel 拆成上述实体。任何 Provider 增删改（接入、自定义接口、测试、PATCH、删除）或默认模型修改后 upsert；实体删除时 remove。登录会话不进主题，靠轮询 GET /api/v2/login-sessions/{sid}。密钥永不明文出现在响应或推送里。
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
         *     快照是 GET /api/v2/conversations/{id} 的 conversation / items / tools，再加上该对话的 subagent 和 change 实体。模型流式输出时先 upsert 一条 `item`，id 以 `live:` 开头、`streaming` 为 true、`text` 为空；随后用 `text.delta` 追加。正式助手消息到来后 remove 这条流式项，再 upsert 正式项和 conversation。bash 工具运行中用 `tool.delta` 追加保留窗口（不要复用 `text.delta`）；偏移对不上时客户端丢掉本地缓冲，等下一次 upsert。
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
         *     - `tool.delta` → ToolDeltaEvent
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
    "/api/v2/workspaces/{id}/uploads": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 把文件存进工作区，供发消息时引用
         * @description 任意文件（不只是图片）上传到该工作区 `.weft/uploads/<YYYYMMDD-HHmmss>-<6 位随机>/<name>`。
         *     `name` 只取 basename，去掉控制字符和路径分隔符，空名用 `file`。
         *     单个文件解码后上限 20MB，超了 413。第一次创建 `.weft/` 时写入 `.weft/.gitignore`，内容是 `*`。
         *     返回相对工作区、正斜杠的 path，发消息时放进 `files`。工作区不存在或已删除 404。
         */
        post: operations["uploadWorkspaceFile"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/workspaces/{id}/git/refresh": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 刷新工作区 git 状态
         * @description 用 git（execFile，无 shell，约 3 秒超时）读取工作区当前分支、未提交改动和相对上游的 ahead/behind。
         *     不是 git 仓库或未安装 git 时 `git` 为 null，不报错。同一工作区并发刷新合并为一次，避免同时起多个 git 进程。
         *     值变化时通过 `workspaces` 主题 upsert 该 Workspace。
         */
        post: operations["refreshWorkspaceGit"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/workspaces/{id}/open-terminal": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 在系统终端中打开目录
         * @description 在本机打开系统自带的终端，cwd 为工作区内的目录。浏览器和服务都在 127.0.0.1，服务端直接 spawn 本机终端程序。
         *     body.path 是相对工作区的路径，缺省为工作区根。必须通过 resolveInWorkspace，且必须是已存在的目录。
         *     越界或不是目录时 400 E_PATH。用 spawn 的参数数组，detached、stdio ignore、unref，绝不拼接 shell 字符串。
         *     macOS：`open -a Terminal <dir>`；环境变量 WEFT_TERMINAL_APP 可换成 iTerm 等。
         *     Windows：优先 `wt.exe -d <dir>`；没有则 `cmd /c start "" powershell.exe -NoExit -Command Set-Location -LiteralPath <dir>`。
         *     Linux：`x-terminal-emulator`，否则 `gnome-terminal --working-directory=<dir>`；都没有 501。
         *     找不到程序时返回明确错误。测试用 WEFT_TERMINAL_MOCK 跳过真正拉起窗口。
         */
        post: operations["openWorkspaceTerminal"];
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
         * 已接入的模型服务商和默认模型
         * @description 返回当前 settings.providers 里的 Provider 视图，以及默认模型。
         *     `defaultModel` 是实际会用的默认：已显式设置且仍有效则用它，未显式设置时为自动选择的第一个可用模型。
         *     `status.error` 按 `lang` 出成句。密钥只以 auth.keyTail（末 4 位）出现，响应不含明文 key。
         *     界面上不出现「pi-ai」字样。
         */
        get: operations["getProviders"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/providers/available": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 可接入的内置服务商目录
         * @description 返回全部内置服务商（排除 xai、openai-codex、radius、typesafe）。
         *     popular 优先（固定顺序），其余按 name 排序。
         *     `envVar` / `envDetected` 按内置服务商的环境变量规则；`connected` 表示已在 settings.providers 里。
         *     中文环境下少量本地化名：moonshotai-cn、zai、qwen-token-plan-cn、minimax-cn、xiaomi。
         */
        get: operations["getAvailableProviders"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/providers/custom": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 新增自定义接口
         * @description 先 GET `{baseUrl}/models`，成功才保存。拉到的模型 ≤6 个全启用，否则都不启用。
         *     失败 400 不保存。成功后推送 providers 主题。
         */
        post: operations["createCustomProvider"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/providers/{id}/connect": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 接入内置服务商
         * @description `method=api_key` 或 `env`：用该服务商第一个启用的模型（没有启用的就用目录第一个 chat 模型）发一次 max_tokens=1 的请求；
         *     验证通过后 `{ provider }`。新接入的内置服务商默认启用：模型 ≤6 个时全部，否则一个都不启用。
         *     验证失败 400 `{ error, code: E_AUTH | E_NETWORK | E_HTTP }`，不保存凭据。
         *     `method=oauth`：开始登录会话，返回 `{ session }`。同一服务商同时只允许一个进行中的会话。
         */
        post: operations["connectProvider"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
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
         * 测试已保存的服务商
         * @description 内置：用第一个启用的模型发一次 max_tokens=1 的请求。
         *     自定义：重新拉 /models 并合并，已启用和覆盖保留。
         *     结果写进 lastTest，推送 providers 主题。响应不含明文 key。
         */
        post: operations["testProvider"];
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
         * @description 同时删除凭据。默认模型指向它时清空。推送 providers 主题。成功 204。
         */
        delete: operations["deleteProvider"];
        options?: never;
        head?: never;
        /**
         * 修改已保存的 Provider
         * @description 任意组合：enabled、overrides（null = 清除覆盖）、defaultModel、以及仅自定义的 name / baseUrl / api；
         *     apiKey 内置也可，用来换 Key。成功后推送 providers 主题。
         */
        patch: operations["patchProvider"];
        trace?: never;
    };
    "/api/v2/login-sessions/{sid}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 查询登录会话
         * @description 前端每 1 秒轮询。登录会话不进 providers 主题。
         */
        get: operations["getLoginSession"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/login-sessions/{sid}/answer": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 回答登录会话的 prompt
         * @description 会话处于 state=prompt 时提交用户输入，然后继续登录流程。
         */
        post: operations["answerLoginSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/login-sessions/{sid}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 取消登录会话
         * @description 中止进行中的登录（abort signal）。
         */
        post: operations["cancelLoginSession"];
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
         * 切换对话模型或思考档位
         * @description `model` 为 `{ providerId, modelId }` 时绑定该模型，规则同旧 resolveConversationModelPatch。
         *     `model` 为 null 时回到默认。`thinkingLevel` 为档位名时写入对话；对当前模型不支持的档位按 clampThinkingLevel 就近处理，响应里的 thinkingLevel 是实际生效值。`thinkingLevel` 为 null 时清除，恢复模型默认。至少要有 model 或 thinkingLevel。运行中也能改，下次提交生效。成功后推送该对话主题的 ConversationView（含 model、thinkingLevel 和 context）。
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
         * @description 空闲时发出去就是新一轮。运行中再发：默认 `mode: steer` 插话（Pi Durable `whenBusy: steer`，
         *     当前工具批次结束后写入对话）；`mode: queue` 排队（`whenBusy: followUp`，本轮结束后才作为新消息执行）。
         *     `text` 去掉首尾空白后，若没有 `images`、`files`、`pastes` 则不能为空。
         *     只有图片、文件或粘贴没有文字也可以发送。`files` 的 path 必须是该工作区 `.weft/uploads/` 下已存在的文件。
         *     `requestId` 缺省时服务端生成；同一个 requestId 重复请求返回同一个 runId。
         */
        post: operations["postConversationMessage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/conversations/{id}/messages/{requestId}": {
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
         * 撤回还在排队、没写进对话的提交
         * @description 只能撤回 Pi Durable inbox 里还没写成对话条目的输入（插话或排队），走 `Harness.abortSubmission`。
         *     已经写进对话的返回 409。找不到这条提交返回 404。
         */
        delete: operations["withdrawConversationMessage"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/conversations/{id}/messages/{messageId}/images/{index}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 取用户消息里的一张图片
         * @description 从对话记录里取出这张图的原始字节。`messageId` 与 ThreadItemUser.id 一致，`index` 与 ThreadUserImage.index 一致。
         *     对话记录里的图片不会变，响应带 Cache-Control: private, max-age=31536000, immutable 和 ETag。找不到 404。
         */
        get: operations["getConversationMessageImage"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/conversations/{id}/messages/{messageId}/pastes/{index}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 取用户消息里一段粘贴的全文
         * @description 对话快照里的 pastes 只有行数、字数和前 8 行预览。点「展开」时用这个接口取原文。
         *     `messageId` 与 ThreadItemUser.id 一致，`index` 与 pastes 数组下标一致。
         *     响应 text/plain，Cache-Control: private, max-age=31536000, immutable。找不到 404。
         */
        get: operations["getConversationMessagePaste"];
        put?: never;
        post?: never;
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
        /** @description POST /api/v2/workspaces/{id}/uploads 的请求体。 */
        UploadRequest: {
            /** @description 原始文件名。服务端只取 basename，去掉控制字符和路径分隔符，空名用 file。 */
            name?: string;
            /** @description 原始字节的标准 base64，不含 data URL 前缀。 */
            data: string;
        };
        /** @description 上传成功。 */
        UploadResult: {
            /** @description 相对工作区的路径，正斜杠，形如 .weft/uploads/YYYYMMDD-HHmmss-xxxxxx/name */
            path: string;
            /** @description 清洗后的文件名 */
            name: string;
            /** @description 解码后的字节数 */
            bytes: number;
            /** @description 按扩展名猜测的 MIME，没有则 application/octet-stream */
            mediaType: string;
        };
        SendMessageRequest: {
            /** @description 用户输入。去掉首尾空白后，若没有 images / files / pastes 则不能为空。 */
            text?: string;
            /** @description 内联图片。data 是不带 data URL 前缀的标准 base64，mediaType 为 png / jpeg / gif / webp。 单张解码后不超过 5MB，一条最多 6 张。选内联而不是先上传再拿 id，是因为 Pi Durable 的 UserInput 原生就是 TextContent | ImageContent，图片进对话记录后刷新才能再显示。 */
            images?: components["schemas"]["MessageImage"][];
            /** @description 已上传到该工作区 `.weft/uploads/` 的文件。path 相对工作区、正斜杠，必须真实存在， 否则 400 E_BAD_REQUEST。一条最多 20 个。服务端拼进一条 TextContent，模型用读文件工具去读。 */
            files?: components["schemas"]["SendMessageFile"][];
            /** @description 长粘贴原文。每段最多 1MB，一条最多 10 段。服务端存成独立的 TextContent （`<pasted_text lines="N">`），快照里只给元数据和前 8 行预览。 */
            pastes?: string[];
            /** @description 幂等键。缺省时服务端生成。同一个 requestId 重复提交返回同一个 runId。 */
            requestId?: string;
            /**
             * @description 运行中再发时的处理方式。缺省为 steer（插话，`whenBusy: steer`）。
             *     queue 排队到本轮结束后再作为新消息执行（`whenBusy: followUp`）。空闲时两种都会立刻开始新一轮。
             * @enum {string}
             */
            mode?: "steer" | "queue";
        };
        /** @description 发送时的一张图片。对话视图里不出现这个对象。 */
        MessageImage: {
            /** @enum {string} */
            mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
            /** @description 原始字节的标准 base64，不含 data: 前缀。日志里不得打印。 */
            data: string;
            /** @description 原始文件名，仅供显示 */
            name?: string;
        };
        /** @description 发消息时引用的一个已上传文件。 */
        SendMessageFile: {
            /** @description 相对工作区的路径，必须在 .weft/uploads/ 下且文件存在 */
            path: string;
            /** @description 显示名，缺省用 path 的 basename */
            name?: string;
            /** @description 可选；服务端以磁盘实际大小为准 */
            bytes?: number;
        };
        /** @description 对话视图里的一张用户图片。只有元数据，不含 base64。 */
        ThreadUserImage: {
            /** @description 这条用户消息里的第几张图，和取图接口的 index 一致 */
            index: number;
            /** @enum {string} */
            mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
            /** @description 原始文件名，仅供显示 */
            name?: string;
            /** @description 解码后的字节数，不含图片数据本身 */
            bytes: number;
            /** @description 取这张图的地址。正式快照是 GET /api/v2/conversations/{id}/messages/{messageId}/images/{index}。 乐观上屏还没有服务端地址时可以是 data: 或 blob: URL。 */
            url: string;
        };
        /** @description 对话视图里的一段长粘贴。不含全文。 */
        ThreadUserPaste: {
            /** @description 粘贴原文的行数 */
            lines: number;
            /** @description 粘贴原文的字符数 */
            chars: number;
            /** @description 前 8 行预览。全文走 GET .../pastes/{index} */
            preview: string;
        };
        /** @description 用户附上的一个文件。内容在工作区磁盘上，不进快照。 */
        ThreadUserFile: {
            /** @description 相对工作区的路径，正斜杠 */
            path: string;
            /** @description 文件名，仅供显示 */
            name: string;
            /** @description 字节数 */
            bytes: number;
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
        WithdrawAccepted: {
            /**
             * @description 始终为 true。撤回成功。
             * @constant
             */
            ok: true;
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
        /** @description SSE event=tool.delta 的 data。只用于工具输出（bash 保留窗口）。带 set 时整段替换；否则先按 trimStart 丢掉头部再按 offset 追加。offset 等于当前长度时追加；现有文字从 offset 起已等于 append 时视为已应用、忽略；其他对不上的情况客户端丢掉本地内容，等下一次 upsert。 */
        ToolDeltaEvent: {
            topic: string;
            toolId: string;
            /** @description 整段替换保留窗口。与 append 互斥 */
            set?: string;
            /** @description 追加前的长度（已应用 trimStart 之后）。set 出现时省略 */
            offset?: number;
            /** @description 追加的文本。set 出现时省略 */
            append?: string;
            /** @description 追加前从窗口头部丢掉的字符数 */
            trimStart?: number;
        };
        /** @description SSE event=heartbeat 的 data。不带 id，不进环形缓冲。 */
        HeartbeatEvent: Record<string, never>;
        /** @description 单条工具调用的视图模型。全文按需拉 GET /api/v2/conversations/{id}/tools/{toolId}/output。 */
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
                /** @description Harness 保留的输出窗口（尾部）。运行中的 bash 或预览被截断时带上；省略则预览即全文 */
                text?: string;
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
        /** @description 用户消息。text 只含用户正文，不含粘贴块和附件说明。 */
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
            /** @description 这条用户消息里的图片元数据。没有则省略。不含图片数据。 */
            images?: components["schemas"]["ThreadUserImage"][];
            /** @description 长粘贴元数据。没有则省略。不含粘贴全文。 */
            pastes?: components["schemas"]["ThreadUserPaste"][];
            /** @description 附上的文件。没有则省略。path 相对工作区。 */
            files?: components["schemas"]["ThreadUserFile"][];
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
        /** @description 当前运行状态。供输入框、停止按钮、等待提示和主对话卡住判定使用。 */
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
            /** @description running 时最近一次内核活动时间（毫秒）。文字/思考片段、工具开始/结束/输出、消息结束都算活动。未在跑时为 null */
            lastActivityAt: null | number;
            /** @description running 且 now − lastActivityAt 超过 stallAfterMs（默认 180000，可用 WEFT_MAIN_STALL_MS 改）时为 lastActivityAt，否则 null。等于阈值不算卡住 */
            stalledSince: null | number;
            /** @description 当前正在运行（已 start 未 end）的工具，供界面显示「正在运行 npm test」。没有则为 null */
            activeTool: null | {
                /** @description 工具名，例如 bash */
                name: string;
                /** @description 这次 tool.start 的时间（毫秒） */
                startedAt: number;
                /** @description 工具标题摘要，例如 bash 命令前 80 个字符 */
                summary: string;
            };
        };
        /** @description 对话当前模型。取对话自己选的或默认模型。 */
        ConversationModel: {
            sourceId: string;
            modelId: string;
            /** @description 先用 modelId */
            label: string;
        };
        /** @enum {string} */
        ProviderAuthType: "api_key" | "oauth" | "env" | "none";
        /** @description 服务商凭据视图。响应和日志都不含明文 API key。 */
        ProviderAuth: {
            type: components["schemas"]["ProviderAuthType"];
            /** @description API Key 末 4 位。没有 key 时省略。永远不是明文。 */
            keyTail?: string;
            /** @description OAuth 时的账号描述，可空 */
            account?: string;
            /** @description 环境变量名（auth.type=env 时） */
            envVar?: string;
        };
        /** @enum {string} */
        ProviderStatusState: "ok" | "untested" | "error" | "testing";
        ProviderStatus: {
            state: components["schemas"]["ProviderStatusState"];
            /** @description 最近一次测试时间（毫秒）。从未测试时省略 */
            testedAt?: number;
            /** @description 已按 lang 出成句。state 不是 error 时省略 */
            error?: string;
        };
        /** @enum {string} */
        ProviderKind: "builtin" | "custom";
        /** @enum {string} */
        CustomApi: "openai-completions" | "openai-responses" | "anthropic-messages";
        /** @description 哪些字段被用户覆盖。未覆盖的键省略。 */
        ModelOverridden: {
            contextWindow?: boolean;
            maxTokens?: boolean;
        };
        /**
         * @description pi-ai 思考档位。界面按模型支持的显示为关 / 低 / 中 / 高 / 更高 / 最高。
         * @enum {string}
         */
        ThinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
        /** @description Provider 上的一个 chat 模型。 */
        ProviderModel: {
            id: string;
            /** @description 模型自带的显示名；没有就等于 id */
            name: string;
            /** @description 模型品牌图标 id。认不出为 null */
            brand: null | string;
            enabled: boolean;
            /** @description 已应用用户覆盖；null = 未知（运行时按 128000 算） */
            contextWindow: null | number;
            /** @description 已应用用户覆盖；null = 未知 */
            maxTokens: null | number;
            images: boolean;
            reasoning: boolean;
            /**
             * @description 该模型支持的思考档位，来自 getSupportedThinkingLevels。非推理模型为空数组。
             *     顺序从低到高：off / minimal / low / medium / high / xhigh / max（按模型支持的显示）。
             */
            thinkingLevels?: components["schemas"]["ThinkingLevel"][];
            /** @description 未选档位时的默认。所有推理模型默认 medium，再经 clampThinkingLevel 得到实际值。非推理模型为 null。 */
            defaultThinkingLevel?: null | components["schemas"]["ThinkingLevel"];
            overridden: components["schemas"]["ModelOverridden"];
        };
        /** @description 模型服务商视图。响应和日志都不含明文 API key。 */
        Provider: {
            /** @description 内置为 catalog id（如 deepseek）；自定义为 custom- + 8 位 hex */
            id: string;
            kind: components["schemas"]["ProviderKind"];
            /** @description 品牌图标 id。自定义为 null */
            brand: null | string;
            name: string;
            api?: components["schemas"]["CustomApi"];
            baseUrl?: string;
            auth: components["schemas"]["ProviderAuth"];
            status: components["schemas"]["ProviderStatus"];
            models: components["schemas"]["ProviderModel"][];
        };
        /** @description 可接入的内置服务商。 */
        AvailableProvider: {
            id: string;
            name: string;
            /** @description 品牌图标 id */
            brand?: null | string;
            authMethods: ("api_key" | "oauth")[];
            modelCount: number;
            popular: boolean;
            envVar?: string;
            envDetected: boolean;
            connected: boolean;
        };
        LoginSessionEvent: {
            /** @constant */
            type: "auth_url";
            url: string;
            instructions?: string;
        } | {
            /** @constant */
            type: "device_code";
            userCode: string;
            verificationUri: string;
        } | {
            /** @enum {string} */
            type: "info" | "progress";
            message: string;
        };
        LoginPromptOption: {
            id: string;
            label: string;
            description?: string;
        };
        LoginPrompt: {
            /** @enum {string} */
            type: "text" | "secret" | "select" | "manual_code";
            message: string;
            placeholder?: string;
            options?: components["schemas"]["LoginPromptOption"][];
        };
        /** @description OAuth 登录会话。内存保存，10 分钟过期。 */
        LoginSession: {
            id: string;
            providerId: string;
            /** @enum {string} */
            state: "pending" | "prompt" | "done" | "error" | "cancelled";
            events: components["schemas"]["LoginSessionEvent"][];
            prompt?: components["schemas"]["LoginPrompt"];
            error?: string;
            provider?: components["schemas"]["Provider"];
        };
        /** @description 对话或默认绑定的 Provider + 模型。 */
        ResolvedModel: {
            providerId: string;
            modelId: string;
        };
        /** @description GET /api/v2/providers 的响应。 */
        ProvidersSnapshot: {
            providers: components["schemas"]["Provider"][];
            /** @description 当前默认模型。未显式设置时为自动选择的第一个可用模型；没有任何可用模型时为 null */
            defaultModel: null | components["schemas"]["ResolvedModel"];
        };
        /** @description GET /api/v2/providers/available 的响应。 */
        AvailableProvidersSnapshot: {
            providers: components["schemas"]["AvailableProvider"][];
        };
        /** @description providers 主题里 defaults/self 实体的值。 */
        ProviderDefaults: {
            /** @description 当前默认模型。未显式设置时为自动选择的第一个可用模型；没有任何可用模型时为 null */
            model: null | components["schemas"]["ResolvedModel"];
        };
        ProviderEnvelope: {
            provider: components["schemas"]["Provider"];
        };
        LoginSessionEnvelope: {
            session: components["schemas"]["LoginSession"];
        };
        ConnectApiKeyRequest: {
            /** @constant */
            method: "api_key";
            apiKey: string;
        };
        ConnectEnvRequest: {
            /** @constant */
            method: "env";
        };
        ConnectOAuthRequest: {
            /** @constant */
            method: "oauth";
        };
        /** @description 接入内置服务商。 */
        ConnectProviderRequest: components["schemas"]["ConnectApiKeyRequest"] | components["schemas"]["ConnectEnvRequest"] | components["schemas"]["ConnectOAuthRequest"];
        /** @description 新增自定义接口。先拉 /models，成功才保存。 */
        CreateCustomProviderRequest: {
            name: string;
            baseUrl: string;
            api: components["schemas"]["CustomApi"];
            apiKey?: string;
        };
        ModelOverridePatch: {
            /** @description 新的上下文上限；null 清除覆盖 */
            contextWindow?: null | number;
            /** @description 新的 max tokens；null 清除覆盖 */
            maxTokens?: null | number;
        };
        /** @description 修改已保存的 Provider。后四个仅自定义；apiKey 内置也可用来换 Key。 */
        PatchProviderRequest: {
            enabled?: string[];
            overrides?: {
                [key: string]: components["schemas"]["ModelOverridePatch"];
            };
            /** @description 把该 Provider 上的这个模型设为默认；null 清空（仅当当前默认就是它） */
            defaultModel?: null | string;
            name?: string;
            baseUrl?: string;
            api?: components["schemas"]["CustomApi"];
            apiKey?: string;
        };
        /** @description 回答登录会话当前 prompt。 */
        LoginAnswerRequest: {
            value: string;
        };
        /** @description PATCH /api/v2/conversations/{id} 的请求体。至少包含 model 或 thinkingLevel。 */
        PatchConversationModelRequest: {
            /** @description 绑定的模型；null 回到默认。可与 thinkingLevel 同时传。 */
            model?: null | components["schemas"]["ResolvedModel"];
            /**
             * @description 对话思考档位。合法名为 off / minimal / low / medium / high / xhigh / max；非法名 400。
             *     当前模型不支持的档位按 clampThinkingLevel 就近处理，响应返回实际生效值。null 清除，恢复模型默认。
             */
            thinkingLevel?: null | components["schemas"]["ThinkingLevel"];
        };
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
            /** @description 工作区当前 git 状态。不是 git 仓库或未安装 git 时为 null */
            git: null | components["schemas"]["GitStatus"];
            /** @description 该工作区下的对话数 */
            conversationCount: number;
            /** @description 状态为 running 的对话数（recovering、resuming 算 running） */
            runningCount: number;
        };
        /** @description 工作区实时 git 状态。 */
        GitStatus: {
            /** @description 当前分支名。detached HEAD 时为短 sha */
            branch: string;
            /** @description detached HEAD 时为 true */
            detached: boolean;
            /** @description 未提交改动的文件数，含未跟踪的文件 */
            changedFiles: number;
            /** @description 相对 HEAD 的未提交插入行数（git diff --numstat HEAD；二进制不计） */
            insertions: number;
            /** @description 相对 HEAD 的未提交删除行数（git diff --numstat HEAD；二进制不计） */
            deletions: number;
            /** @description 领先上游的提交数。没有上游时为 null */
            ahead: null | number;
            /** @description 落后上游的提交数。没有上游时为 null */
            behind: null | number;
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
        /** @description POST /api/v2/workspaces/{id}/open-terminal 的请求体。 */
        OpenTerminalRequest: {
            /** @description 相对工作区的目录。缺省或空字符串表示工作区根。 */
            path?: string;
        };
        /** @description POST /api/v2/workspaces/{id}/open-terminal 成功。 */
        OpenTerminalResult: {
            /** @constant */
            opened: true;
            /** @description 可选提示。原型会带「已在系统终端中打开（原型不会真的打开）」；真服务端省略，由客户端显示默认文案。 */
            message?: string;
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
            /**
             * @description 实际生效的思考档位：对话选的经 clampThinkingLevel 处理后的值；没选则为当前模型的 defaultThinkingLevel。
             *     当前模型不支持思考时为 null。
             */
            thinkingLevel?: null | components["schemas"]["ThinkingLevel"];
            run: components["schemas"]["RunState"];
            context: components["schemas"]["ContextUsage"];
            /** @description 对话流 ThreadItem id 的顺序 */
            itemIds: string[];
            /**
             * @description 本进程内经 POST .../messages 与 .../continue 发出的提交，按先后顺序，最多保留最近 20 条。
             *     前端用 requestId 找到自己那条乐观上屏的消息落在哪个 entry 上，据此收回。
             *     还没写进对话的条目带 mode 和 text，供输入框显示排队小条、对话里显示「已插话」。
             *     只在写入它们的服务进程内存在。
             */
            sends?: components["schemas"]["ConversationSend"][];
        };
        /** @description 一次发送在对话里的落点，供前端按 requestId 收回乐观上屏的消息。 */
        ConversationSend: {
            /** @description 发送时带的幂等键（POST 请求体的 requestId）。 */
            requestId: string;
            /**
             * @description 内核把这条输入写进对话后的 entry id，也就是对应 ThreadItem 的 id（user 气泡、subagent 报告卡片或系统提示都可能）。
             *     这条输入还在队列里、没有落盘时为 null。
             */
            entryId: null | string;
            /**
             * @description 这条输入被撤回、丢弃或提交失败，对话里不会再有对应条目（只在 entryId 为 null 时有意义）。
             *     服务端查到 entryId 之后就不再回查提交记录，所以 entryId 不为 null 时该值可能仍是 false。
             */
            dropped: boolean;
            /**
             * @description 发送时的处理方式。steer 插话，queue 排队。缺省按 steer 显示。
             *     还没写进对话时前端靠这个决定气泡下的「已插话」还是输入框里的排队小条。
             * @enum {string}
             */
            mode?: "steer" | "queue";
            /** @description 发送时的文字，供排队小条和刷新后重建「已插话」气泡。没有则为空字符串。 */
            text?: string;
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
            /** @description 按 title → name（空或默认名如 agent-1 则跳过）→ brief 第一行 → lastText 回退 */
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
            /** @description 派出该子 Agent 的那次 delegate / subagent 工具调用 id，与对话快照里 ToolCall.id 一致。从 roster 里来、找不到对应工具调用时为 null */
            toolCallId: null | string;
        };
        /** @description GET /api/v2/conversations/{id}/subagents/{agentId} 的响应。 */
        SubagentSnapshot: {
            subagent: components["schemas"]["Subagent"];
            items: components["schemas"]["ThreadItem"][];
            tools: components["schemas"]["ToolCall"][];
        };
        /** @description 最后一次 write/edit 这个文件的是主 Agent。 */
        ChangeByMain: {
            /** @enum {string} */
            kind: "main";
        };
        /** @description 最后一次 write/edit 这个文件的是某个子 Agent。 */
        ChangeBySubagent: {
            /** @enum {string} */
            kind: "subagent";
            /** @description 子 Agent id，形如 `<cid>:sub:<子对话 id>` */
            agentId: string;
            /** @description 子 Agent 名。前端显示成「子 · <name>」 */
            name: string;
        };
        /** @description 对话右栏变更列表的一项。SSE conversation 主题里 entity=change，id 为 path。 */
        Change: {
            /** @description 相对工作区的路径，统一用 `/` */
            path: string;
            added: number;
            removed: number;
            /** @description 例如文件过大。没有则为 null */
            error: null | string;
            /** @description 最后一次 write/edit 这个文件的是谁。主 Agent 和子 Agent 都改过时取最后一次。只被 bash 等非 write/edit 工具改、拿不到归属时为 null */
            by: null | components["schemas"]["ChangeByMain"] | components["schemas"]["ChangeBySubagent"];
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
    uploadWorkspaceFile: {
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
                "application/json": components["schemas"]["UploadRequest"];
            };
        };
        responses: {
            /** @description 已写入工作区 */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UploadResult"];
                };
            };
            /** @description 请求体无效或 data 不是合法 base64 */
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
            /** @description 工作区不存在或已移除 */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 文件超过 20MB */
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
    refreshWorkspaceGit: {
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
            /** @description 刷新后的工作区（含最新 git） */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Workspace"];
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
    openWorkspaceTerminal: {
        parameters: {
            query?: {
                /** @description 错误文案语言，缺省 zh */
                lang?: "zh" | "en";
            };
            header?: never;
            path: {
                /** @description 工作区 id */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["OpenTerminalRequest"];
            };
        };
        responses: {
            /** @description 已请求打开系统终端 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OpenTerminalResult"];
                };
            };
            /** @description 路径越界或不是目录（E_PATH） */
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
            /** @description 找不到可用的终端程序（E_NO_TERMINAL） */
            501: {
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
    getAvailableProviders: {
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
            /** @description 可接入目录 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AvailableProvidersSnapshot"];
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
    createCustomProvider: {
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
                "application/json": components["schemas"]["CreateCustomProviderRequest"];
            };
        };
        responses: {
            /** @description 已创建 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProviderEnvelope"];
                };
            };
            /** @description 请求体无效或 /models 失败 */
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
    connectProvider: {
        parameters: {
            query?: {
                lang?: string;
            };
            header?: never;
            path: {
                /** @description 内置服务商 id */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConnectProviderRequest"];
            };
        };
        responses: {
            /** @description 已接入或已开始登录会话 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProviderEnvelope"] | components["schemas"]["LoginSessionEnvelope"];
                };
            };
            /** @description 验证失败或请求体无效 */
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
            /** @description 服务商不存在 */
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
                    "application/json": components["schemas"]["ProviderEnvelope"];
                };
            };
            /** @description 测试失败 */
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
    deleteProvider: {
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
        requestBody?: never;
        responses: {
            /** @description 已删除 */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
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
                    "application/json": components["schemas"]["ProviderEnvelope"];
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
    getLoginSession: {
        parameters: {
            query?: {
                lang?: string;
            };
            header?: never;
            path: {
                /** @description 登录会话 id */
                sid: string;
            };
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
                    "application/json": components["schemas"]["LoginSessionEnvelope"];
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
            /** @description 会话不存在 */
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
    answerLoginSession: {
        parameters: {
            query?: {
                lang?: string;
            };
            header?: never;
            path: {
                sid: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["LoginAnswerRequest"];
            };
        };
        responses: {
            /** @description 更新后的会话 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LoginSessionEnvelope"];
                };
            };
            /** @description 当前不能回答 */
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
            /** @description 会话不存在 */
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
    cancelLoginSession: {
        parameters: {
            query?: {
                lang?: string;
            };
            header?: never;
            path: {
                sid: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": Record<string, never>;
            };
        };
        responses: {
            /** @description 已取消的会话 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LoginSessionEnvelope"];
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
            /** @description 会话不存在 */
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
            /** @description 模型不存在、思考档位名非法或请求体无效 */
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
            /** @description 空文字且没有图片 / 文件 / 粘贴，或字段超限 / 格式不对 / 文件不在 uploads 下 */
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
            /** @description 请求体过大（含图片的消息上限约 44MB） */
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
    withdrawConversationMessage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 对话 id */
                id: string;
                /** @description 发送时带的幂等键（POST 请求体的 requestId） */
                requestId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 已从队列撤回 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WithdrawAccepted"];
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
            /** @description 对话或这条提交不存在 */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["V2Error"];
                };
            };
            /** @description 已经写进对话，不能撤回 */
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
    getConversationMessageImage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 对话 id */
                id: string;
                /** @description 用户消息 id，与 thread 里 user 项的 id 相同 */
                messageId: string;
                /** @description 这条消息里的第几张图 */
                index: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 原始图片字节 */
            200: {
                headers: {
                    /** @description private, max-age=31536000, immutable */
                    "Cache-Control"?: string;
                    ETag?: string;
                    [name: string]: unknown;
                };
                content: {
                    "image/png": string;
                    "image/jpeg": string;
                    "image/gif": string;
                    "image/webp": string;
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
            /** @description 对话、消息或这张图不存在 */
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
    getConversationMessagePaste: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 对话 id */
                id: string;
                /** @description 用户消息 id，与 thread 里 user 项的 id 相同 */
                messageId: string;
                /** @description 这条消息里的第几段粘贴 */
                index: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 粘贴原文 */
            200: {
                headers: {
                    /** @description private, max-age=31536000, immutable */
                    "Cache-Control"?: string;
                    ETag?: string;
                    [name: string]: unknown;
                };
                content: {
                    "text/plain": string;
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
            /** @description 对话、消息或这段粘贴不存在 */
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
