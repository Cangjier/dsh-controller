# dsh-controller

DSH 插件：**让 agent 控制 DSH 自身**。

先走 DSH 自己暴露的 API（cordis 服务），走不通才退回桌面自动化。**唯一的例外是
`dsh_sessions {action:"create"}`：它默认先点真实窗口里的「新会话」按钮，再用 API 的会话列表确认那条
会话真的出现了，任一步失败就整条退回 API 建会话。** 这不是一句口号，是每个工具结果里的 `transport`
字段：`api` = 真的调了 `sessionController` / `agents` / `pluginManager`，`disk` = 只读磁盘事实，
`ui` = 真的去点那个窗口。

```jsonc
// dsh_sessions {action:"create"} 的两种真实返回
// GUI 路成功：会话是点出来的，第一条消息由 API 投递，证据是列表差
{ "transport": "ui", "sessionId": "session-…", "detectedBy": "list-diff", "waitedMs": 742,
  "firstMessage": "api", "evidence": { "click": { "pointerRestored": true } } }
// GUI 不可用：整条退回 API，并说明为什么
{ "transport": "api", "sessionId": "session-…", "fallback": { "from": "ui",
  "reason": "找不到可操作的 DSH 窗口（window-not-found）" } }
```

为什么 `create` 可以反过来、而且不是碰运气：那个按钮走的就是产品自己的建会话路径，点出来的会话与
`sessionController.create` 造的是同一种东西；关键是这条路**有证据**——「点之前有哪些会话 id」与
「点之后有哪些」的集合差证明它真的建成了。两条路都是全有或全无，不会出现「GUI 建了一半 + API 再建
一条」的两条对话。

## 为什么先 API

`dsh-computer-use` 已经能把屏幕、鼠标、键盘变成工具，所以「控制 DSH」看起来可以全靠点。但点 GUI 拿不到
下面任何一件东西，而它们恰好是控制自己时最需要的：

| 只有 API 能回答 | 为什么重要 |
| --- | --- |
| `sessions.flush()` 确认落盘 | 「消息发出去了」和「消息进日志了」是两件事；点回车只有前者 |
| `agent.status` / `agent/cancel()` | 回合到底在跑没有、干净地中止，而不是猜 |
| `ChangeResult.application: restart-required` | 装完插件到底生效了没有 |
| `sessionProjections.stateOf(session, 'goal')` | 目标处在什么阶段、第几轮 |
| 无人值守时也能工作 | 合成输入需要窗口在前台；宿主的服务不需要 |

所以 UI 只留给「确实只有 GUI 暴露」的事情（`create` 是那条例外，理由见上），而且每一次输入前都先
**确认窗口在前台**——合成输入失败是不报错的，前台确认是那里唯一可信的证据。

### 这台机器上实测出来的 GUI 边界

`create` 的 GUI 腿不是「理论上应该能用」，下面每条都是量过的（DSH 0.2.0-rc.2，1296×828 窗口）：

| 动作 | 结果 |
| --- | --- |
| 点 (11.6%, 13.5%) 的「新会话」按钮 | **有效**，会话随后出现在 `sessionController.list` 里 |
| `Ctrl+N`（`session.new` 的默认绑定，`primary+KeyN`） | **无效**：SendKeys 送得进去，界面毫无反应；所以走真实点击，不发组合键 |
| `SendKeys` 送 ASCII 到输入框 | **有效**，但**要先点一下输入框**给它焦点 |
| Unicode `SendInput` 送中文 | **无效且无声**：Windows 收下了（每个字符返回 2），输入框一个字都不显示 |
| 剪贴板 + 原生 `Ctrl+V` | **无效且无声**：返回 ok，输入框仍是空的 |
| `Ctrl+A` / `{BACKSPACE}` 清空输入框 | **无效**：草稿清不掉 |
| 侧边栏的未发送草稿 | **会跨「新会话」保留**：新会话打开时输入框里可能还留着上一次的话 |

结论：**GUI 负责建会话，第一条消息交给 API。** 想让 GUI 也送字就打开 `config.create.submitInGui`，
脚本会在「输入框里已有草稿」（`composer-not-empty`，用回读像素判定）或「正文非 ASCII」
（`text-not-ascii`）时明确拒绝，而不是把两段话接在一起。

## 四个工具

| 工具 | 动作 | 走哪条路 |
| --- | --- | --- |
| `dsh_control` | `overview` `capabilities` `session` `transport` `guide` | 只读；`capabilities` 逐项探测 18 个服务与两条 UI 通道 |
| `dsh_sessions` | `list` `get` `create` `send` `abort` `wait` `rename` | `sessionController` / `agents` / `sessions` / `sessionTitle` |
| `dsh_plugins` | `list` `inventory` `enable` `disable` `install` `remove` `inspect` `log` | `pluginManager`；`log` 只能读磁盘 |
| `dsh_ui` | `window` `look` `click` `type` `key` `scroll` | 桌面自动化（最后手段） |

每个工具的常驻 schema 只带判断所需的一句；完整参考在 `dsh_control {action:"guide"}` 里按需渲染。注册表
（`src/tools/registry.mjs`）是这些 prose 的**唯一来源**，而且加载时会双向核对：动作声明了没文档、或文档
里写了没实现，都会直接抛错。

## 三层通道与降级顺序

```
1. api    cordis 服务          最准；能确认落盘、能报 restart-required
2. disk   ~/.dsh 下的真实文件  服务缺席时仍然能读会话状态、能读插件操作日志
3. cli    `dsh plugin …`       pluginManager 缺席时安装/卸载的退路（见下）
4. ui     真实鼠标键盘          只有 GUI 才有的东西
```

`dsh_control {action:"capabilities"}` 会把当前进程实测结果摆出来（含每个服务原型上的方法名——版本之间
方法集是会变的，「服务在但没有我要的方法」是这里最常见的失败）。

## 安装

```powershell
# 1) 链进 profile（pnpm 会写成 link:，改动立即对文件系统可见）
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm add "C:\Users\Admin\Documents\GitHub\dsh-plugins\dsh-controller"

# 2) 把包名加进 package.json 的 dsh.profile.bundles
#    （顺序有意义：bundle patch 按这个顺序叠加，新加的排在最后）
```

第二步之后运行中的桌面应用会重载 profile 配置并把 `dsh_*` 工具注册进来——**不需要重启应用**（实测：
包名写进 `bundles` 后，同一轮对话的下一次请求就看到了这四个工具）。

**改插件源码需要重启应用。** HMR 默认 `root: []`，只监听配置不监听模块；要把插件目录登记成模块根：

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml
- id: hmr
  name: '@deepseek-ai/dsh-hmr'
  config:
    root:
      - '.'
      - 'C:/Users/Admin/Documents/GitHub/dsh-plugins/dsh-controller'
```

（这一步在本次开发里试过：登记之后模块并不会立刻换掉已加载的那一份，所以**最稳的说法是：改源码 → 重启应用**。
Node 对同一个真实路径有模块缓存，换掉已加载的包本来就要新的一代 JS。）

## 配置

`cordis.patch.yml` 默认值就是可用的一套：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | `false` = 一个工具都不注册 |
| `api.forceUi` | `false` | 明确要求「即使 API 可用也走 UI」，只在排查时用 |
| `api.defaultWaitMs` | `120000` | `dsh_sessions {action:"wait"}` 的默认上限 |
| `api.actionTimeoutMs` | `30000` | 会话类动作的超时 |
| `ui.windowTitle` | `null` | 目标窗口标题子串；`null` = 按进程名找 |
| `ui.processName` | `DeepSeek Harness` | 没有 `windowTitle` 时按进程名找窗口 |
| `ui.screenshotDir` | `<插件>/tmp/screens` | `look` 的落地目录 |
| `ui.scriptTimeoutMs` | `60000` | 单次 PowerShell 动作超时 |
| `ui.focusSettleMs` | `120` | 前台化后等待多久再确认 |
| `guard.requireConfirmForCreate` | `false` | 建会话是否必须带 `confirm:true` |
| `guard.requireConfirmForPlugins` | `true` | 改插件状态是否必须带 `confirm:true` |

配置写错在**加载时**抛错，不留到调用时；一个悄悄用着默认值的插件比一个加载失败的插件更难查。

## 验证

```powershell
node --test "tests/*.test.mjs"   # 40 个用例：配置归一化、路径编码、zstd 帧解码、工具契约、宿主适配
node selftest.mjs                # 不开 DSH 也能跑：磁盘回退 + 探测 + UI 回退找窗口
```

自检里有一项值得一提：磁盘回退能在一台**没开 DSH** 的机器上列出全部会话（本次实测 462 条 / 2 条在跑），
因为会话日志是 append-only 的 zstd 帧串，按 magic 切帧、末尾半写的帧丢掉就能在别人正在写的时候读。

## 已知边界

- **不能重启宿主，也不能卸载自己**。DSH 没有公开的 restart API（`reconcileProfilePatches` + `hmr` 是
  私有的），Electron 那一侧只走 Node IPC。所以 `dsh_plugins` 报的是 `restart-required`，而不是假装成功了。
- **`state` 是推断出来的**。`RUNNING` / `IDLE` / `STALLED` 来自「回合边界 + 文件 mtime」；一个刚崩掉的
  会话最多 5 分钟会被报成 `RUNNING`。要看内存里的权威状态，用 `dsh_control {action:"session"}` 的
  `live.status`。
- **`dsh_sessions {action:"abort"}` 是破坏性的**：被中止的那一轮以 `aborted` 收口，未完成的工作不会重来。
- **`dsh_ui` 动的是真机器**：`click` / `type` / `key` / `scroll` 会抢焦点、覆盖剪贴板（中文走粘贴）。
  没确认前台就拒绝发输入，这是它唯一的一条硬规则。
- **`dsh_plugins {action:"list"}` 默认裁剪字段**。不裁的话一次 list 约 140 KB（每个插件都带描述，实验包
  还带 base64 图标），那是模型上下文而不是日志。要原始数据加 `verbose:true`。
- **`cli` 通道还没实现**。`dsh plugin --profile <name> add <spec>` 是一条真实的退路（launcher 把它原样
  转给 pnpm），但本插件目前只在 `transport` 表里声明它；实现它需要在宿主里找到 `dsh` 可执行文件的位置。

## 实现备注

- **零依赖是硬约束，不是风格**。`link:` 进 profile 的插件 import 不到 `@deepseek-ai/*`（那些包在
  DSH 的 `app.asar` 里），所以工具 schema 用字面量写，服务全部 `ctx.get(name)` 拿，拿不到就退。
- **投递消息用 `source.kind = 'cordis-host-runner'`**：宿主自己在进程内投递时用的就是它
  （`dsh-mail-notify` 同款），而且它**不会**被当成「直接来自人类」——工具投递的消息本来也不该满足那类判定。
- **`sessionTitle.rename(session, title)` 要 Session 对象，不是会话 id**。传字符串会得到
  `session "undefined" is not live in this store`（实测踩过，`create` 里的改名就是因此挪到拿到 agent 之后）。
- **工作区目录名是有损编码**（`--C-Users-…-xl-example--`）：连字符既可能是分隔符也可能在名字里，所以只能
  用于显示；真实 cwd 从投影缓存的 `identity.cwd` 读。

## 许可

MIT。
