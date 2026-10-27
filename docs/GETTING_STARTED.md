# 快速开始

面向在本机或内网 Windows 上从零跑起 Weft。不需要 Docker。目标运行环境是 **Node 22.19 或以上**。

## 准备

- Node.js **>= 22.19**、npm、Git。Windows 直接安装即可，不必用 WSL。
- 内网 npm 镜像需要能装 **开发依赖**（`vite` 等）：`npm install` 会构建新版网页端。
- 首次演示可以不配模型。显式设置 `WEFT_LLM=faux`（或 `LLM_API=faux`）时用固定剧本，不会访问真实接口。

## 本机运行

```bash
git clone https://github.com/lawrencewzen/weft.git
cd weft
node --version
npm ci
npm start
```

`npm ci` / `npm install` 会拷贝旧版前端的 vendor 文件，并构建新版网页端。如果装包时省略了开发依赖（例如 `--omit=dev`），安装仍会成功，但访问 `/` 会提示：

```
新版界面未构建，请安装开发依赖后运行 npm run build:web
```

启动完成后，控制台先打一行 `WEFT_READY http://127.0.0.1:<端口>`，紧接着一行带一次性码的登录链接：

```
打开新版界面：http://127.0.0.1:<端口>/auth?code=<码>
```

点这个链接即可打开新版界面。码 **10 分钟有效、只能用一次**。过期后用下面的 `weft open` 再生成一枚 60 秒码。

也可以不手点控制台链接，让命令行找到（或拉起）服务并打开浏览器：

```bash
npm run weft -- open
```

其他命令：

```bash
npm run weft -- status          # 在跑则打印端口、pid、协议版本、服务版本、启动时间
npm run weft -- stop            # 空闲时退出服务；有任务在跑则拒绝
npm run weft -- open --print    # 只把登录地址打印到 stdout，不打开浏览器
```

数据目录默认是仓库下的 `data`，可用环境变量 `WEFT_DATA_DIR` 或 `--data-dir <路径>` 改。

旧版界面已删除：`/legacy` 会 302 回 `/`。旧接口 `/api/*` 不变。书签里的 `/next/...` 会 302 到去掉前缀的同一路径。

端口占用时改 `PORT=3001 npm start`。

## 接入真实模型（可选）

没有可用模型时发消息会以 `E_NO_MODEL` 失败，不会自动改走演示剧本。在设置 → 模型里添加 API 源，或设置环境变量：

```bash
LLM_BASE_URL=https://your-provider.example/v1
LLM_API_KEY=YOUR_OWN_KEY
LLM_MODEL=your-provider-model-id
```

优先复用本机 Grok Build 会话（`grok login` 写到 `~/.grok/auth.json`）。设置里的「用 Grok 登录」走同一套设备码。没有 Grok 会话、API Key 或 Base URL 时，服务拒绝回复。

**LLM 费用属于模型服务商。** 不要把密钥发到 Issue。

## 核对

- 网页断开不等于任务取消：对话跑在后端，重新打开页面即可接着看。
- 进程可恢复不等于数据可恢复：请备份 `WEFT_DATA_DIR` 下的 SQLite。
- 旧版界面已删除（T47-1）；新功能做在新版网页端。

部署、常驻和升级见 [部署说明](DEPLOYMENT.md)，环境变量见 [配置参考](CONFIGURATION.md)，问题见 [故障排查](TROUBLESHOOTING.md)。
