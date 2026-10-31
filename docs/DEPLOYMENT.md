# 本地 / 内网 Windows 部署

Weft 是单用户本机服务，只监听 `127.0.0.1`。目标环境是内网 Windows + Node 22，用 `npm install` 和 `npm start` 即可。

先按 [快速开始](GETTING_STARTED.md) 在本机跑通，再按本文做成常驻服务。

## 1. 环境

- **Node.js >= 22.19**（`package.json` 的 `engines.node`）。Windows 安装官方安装包，把 `node` 和 `npm` 加进 PATH。
- Git。导入仓库还需要本机 Git for Windows，或把 `WEFT_GIT_BIN` 设成 `git.exe` 的完整路径。
- npm 镜像必须能装 **开发依赖**。新版网页端在 `npm install` / `npm ci` 时用 Vite 构建；`--omit=dev` 或镜像缺 `vite` 时安装不会失败，但访问 `/` 会提示运行 `npm run build:web`。

```bat
git clone https://github.com/lawrencewzen/weft.git
cd weft
node --version
npm ci
```

## 2. 数据目录

默认是仓库下的 `data/`（对话索引 `weft.sqlite`、Harness 的 `harness/session.sqlite`、插件和技能、发现文件 `service.json`）。

生产建议把数据放到仓库以外，避免升级时被覆盖：

```bat
set WEFT_DATA_DIR=D:\weft-data
npm start
```

备份时复制整个数据目录（含 `-wal` / `-shm`）。先停服务再拷，一致性最好。不要把备份提交进 Git。

## 3. 启动与登录

```bat
npm start
```

进程只绑定 `127.0.0.1`。默认端口 `3000`，可用 `PORT` 改。启动成功后 stdout 两行：

```
WEFT_READY http://127.0.0.1:<端口>
打开新版界面：http://127.0.0.1:<端口>/auth?code=<码>
```

第一行格式固定，测试和工具依赖它。第二行的码 10 分钟有效、只能用一次；过期后用 `weft open` 重新生成。码只出现在这一次控制台（以及若把 stdout 重定向到日志文件，则在该文件里），不会写入发现文件。

`weft open` 仍然可用：找到或拉起服务，申请一枚 60 秒码并打开浏览器。这和启动时打印的 10 分钟码是两套，互不影响。不做本机免登录。

```bat
npm run weft -- open
npm run weft -- status
npm run weft -- stop
```

旧版界面已删除，`/legacy` 302 回 `/`。旧接口 `/api/*` 不变。可选的旧登录 `GET /login?token=`（`WEFT_TOKEN`）行为不变。

## 4. 常驻和空闲退出

- 手动 `npm start` **不会**因空闲而退出，适合当成本机常驻。
- `weft open` 拉起的进程会带 `WEFT_LAUNCHED_BY=weft-open`，空闲超过 `WEFT_IDLE_EXIT_MINUTES`（默认 30）且没有运行中的任务、也没有客户端连接时自行退出。`0` 表示不退出。
- Windows 上可用「任务计划程序」或启动文件夹在登录时执行 `npm start`（先 `cd` 到安装目录并设置 `WEFT_DATA_DIR`）。不需要管理员权限。
- 停止：有任务在跑时 `weft stop` 会拒绝；空闲时退出。任务管理器结束进程也可以，下次启动会按检查点恢复对话。

## 5. 升级

1. 停服务（`npm run weft -- stop`，或结束 `node server.mjs`）。
2. `git pull --ff-only`（或换到要部署的 tag / 提交）。
3. `npm ci`（会再次构建新版网页端）。
4. 用原来的 `WEFT_DATA_DIR` 重新 `npm start`。

不要删除数据目录。涉及数据库格式变化时先看该版本说明和 CI。

## 6. 验收

- 控制台有 `WEFT_READY` 和登录链接；点链接能进新版界面。
- `npm run weft -- status` 能读到端口和 pid。
- 发一条消息（演示模型或真实模型），刷新页面后对话还在。
- `/legacy` 现在 302 回 `/`（旧界面已删除）。

配置项见 [CONFIGURATION.md](CONFIGURATION.md)，排障见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。
