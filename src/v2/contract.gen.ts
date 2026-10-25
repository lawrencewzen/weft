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
         *     没带 Last-Event-ID 时先发快照。快照的 SSE id 是当时的最新序号。
         *     订阅的主题和上次不同时，客户端不要带 Last-Event-ID / lastEventId，直接重新连接拿快照（续传只保证同一组主题）。
         *     心跳每 15 秒一次，不带 id，不进缓冲。
         *
         *     主题 `workspaces` 注册为精确主题。实体：
         *     - `workspace`：id 为工作区 id，值为 Workspace
         *     - `conversation_summary`：id 为对话 id，值为 ConversationSummary
         *
         *     快照与 GET /api/v2/workspaces 同一套数据拆成上述实体。工作区或对话增删改、运行状态或子 Agent 计数变化时 upsert；实体删除时 remove。
         *
         *     主题 `conversation:<id>`（`<id>` 为对话 id）按前缀动态注册。实体：
         *     - `conversation`：id 为对话 id，值为 ConversationView
         *     - `item`：id 为 ThreadItem.id，值为 ThreadItem
         *     - `tool`：id 为 ToolCall.id，值为 ToolCall
         *
         *     快照是 GET /api/v2/conversations/{id} 同一套数据拆成上述实体。模型流式输出时先 upsert 一条 `item`，id 以 `live:` 开头、`streaming` 为 true、`text` 为空；随后用 `text.delta` 追加。正式助手消息到来后 remove 这条流式项，再 upsert 正式项和 conversation。
         *
         *     订阅不存在的对话时仍返回 200：先发 snapshot，entities 为空，并在 snapshot 数据里加 `missing: ["conversation:<id>"]`，连接保持。
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
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
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
        /** @description SSE event=snapshot 的 data。连接时或续传补不上时发送；SSE id 为当时最新序号。订阅不存在的 conversation:<id> 时 entities 为空，并列出 missing。 */
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
        /** @description SSE event=text.delta 的 data。只用于流式文字。offset 对不上时客户端丢掉本地内容，等下一次 upsert。 */
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
        /** @description 侧栏工作区。 */
        Workspace: {
            id: string;
            name: string;
            path: string;
            /** @enum {string} */
            source: "local" | "git";
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
                /** @description 逗号分隔的主题列表。空或含未注册主题时 400。`workspaces` 已注册；`conversation:<id>` 按前缀视为已注册。 */
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
}
