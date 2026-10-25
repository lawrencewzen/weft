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
}
