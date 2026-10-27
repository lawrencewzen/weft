# 网页端可交互原型

不用启动服务、不联网：双击 `index.html` 就能像用真产品一样操作——侧栏切换对话、新建对话、发消息、看 Agent 流式回复和工具记录、停止、切模型。

原型用的是 `web/` 里**真实的前端代码**，只把后端换成运行在浏览器里的模拟后端；界面组件一行不改，所以交互和真产品一致。

## 构建和打开

```bash
npm ci                    # 首次：装依赖（postinstall 会构建 public-next）
npm run build:proto       # 生成 design/prototype/index.html（单文件，构建产物不入库）
open design/prototype/index.html    # macOS；Windows 直接双击
```

- 单文件：JS、CSS、品牌图标全部内联，用 `file://` 打开，不发任何网络请求。
- 路由用 hash（`index.html#/c/<id>`），因为 `file://` 下不能 pushState 到别的路径。
- 数据只在内存里：刷新页面或点右下角「重置原型数据」都会回到预置状态。
- 还没做的接口（右栏文件树 / 文件内容 / 保存、变更列表的 diff、子 Agent 详情、设置里的写操作、新建工作区）返回空数据或「原型暂不支持」，页面不会崩；这些在 T50-B 补。

## 代码在哪

| 位置 | 作用 |
| --- | --- |
| `web/proto/main.tsx` | 原型入口：先装模拟后端和 hash 路由，再渲染 `<App />` |
| `web/vite.proto.config.ts` | 原型打包：入口换成 `web/proto/index.html`，把 JS/CSS 内联成一个 HTML |
| `web/proto/brand-icons.ts` | 把 `brandIconUrl()` 指向的少数品牌图标换成 data URI |
| `web/proto/mock/seed.ts` | 预置数据：2 个工作区、7 个对话、Provider、Git 状态 |
| `web/proto/mock/db.ts` | 内存状态和发布辅助（会话 / 侧栏 / Provider） |
| `web/proto/mock/http.ts` | `/api/v2/*` 路由，返回 `src/v2/contract.gen.ts` 里的形状 |
| `web/proto/mock/hub.ts` | 事件推送：`snapshot` → `upsert` / `remove` / `text.delta` / `heartbeat` |
| `web/proto/mock/run.ts` | 一次运行的模拟：工具记录 → 流式文字 → 完成 / 停止 / 插话排队 |
| `web/proto/mock/views.ts` | 把内存数据转成前端收到的视图，按语言出文案 |
| `tests/e2e/proto-smoke.spec.mjs` | 冒烟：`file://` 打开、切对话、新建并发消息、流式完成、停止、零网络 / 零控制台报错 |

## 加数据、加交互

- **加预置数据**：改 `web/proto/mock/seed.ts`。对话流里的 `tool_group` 用 `group(...)`，工具行用 `tool(...)`；`MockTool` 的标题 / 提示是 `{ zh, en }`，别只写中文。
- **加一个接口**：在 `web/proto/mock/http.ts` 里加路由。请求 / 响应类型直接引用 `src/v2/contract.gen.ts`（`web/tsconfig.json` 已经把 `proto/` 加进 `typecheck:web`）。没实现就先返回合理空数据，或者 `fail(400, '原型暂不支持 …')`。
- **加一种运行步骤**：改 `web/proto/mock/run.ts` 的 `planFor()` / `runTool()`。文字必须通过 `text.delta` 推（先 upsert 一条 `live:` 开头的空助手项，最后 remove 它再 upsert 正式项），不要给前端加原型专用分支。
- **推送时序**：照真服务端来——订阅时先 `snapshot`，之后实体变化发 `upsert`，流式文字发 `text.delta`，删除发 `remove`。主题名看 `web/src/data/store.ts`（`workspaces`、`providers`、`extensions`、`conversation:<id>`）。
- 改完跑：`npm run typecheck:web && npm run build:proto && npx playwright test -c tests/playwright.config.mjs proto-smoke`。

## 改界面的流程

1. 在分支上改 `web/src`；界面需要新数据时，先在 `web/proto/mock/` 里造出来。
2. `npm run build:proto`，把 `design/prototype/index.html`（单个文件）给用户点一遍。
3. 用户确认后再接真后端、跑 e2e、合并 `main`。
4. 合并后如果界面有变化，同步更新模拟数据和 `tests/e2e/proto-smoke.spec.mjs`，保证原型还能反映当前界面。

计划中的第二部分（T50-B）补右栏文件树 / 文件内容 / diff、子 Agent 和设置各页的模拟数据。
