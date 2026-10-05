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

## 五个工具

| 工具 | 动作 | 走哪条路 |
| --- | --- | --- |
| `dsh_control` | `overview` `capabilities` `session` `transport` `guide` | 只读；`capabilities` 逐项探测 18 个服务与两条 UI 通道 |
| `dsh_sessions` | `list` `get` `create` `send` `abort` `wait` `rename` | `sessionController` / `agents` / `sessions` / `sessionTitle` |
| `dsh_host` | `pause-all` `restart` `status` `resume` | 停止与继续走 `agents` / `sessionController`；退出走 `ctx.appExit`；**重新拉起由进程外的看门狗完成**；`status` 只读磁盘 |
| `dsh_plugins` | `list` `inventory` `enable` `disable` `install` `remove` `inspect` `log` | `pluginManager`；`log` 只能读磁盘 |
| `dsh_ui` | `window` `look` `click` `type` `key` `scroll` | 桌面自动化（最后手段） |

每个工具的常驻 schema 只带判断所需的一句；完整参考在 `dsh_control {action:"guide"}` 里按需渲染。注册表
（`src/tools/registry.mjs`）是这些 prose 的**唯一来源**，而且加载时会双向核对：动作声明了没文档、或文档
里写了没实现，都会直接抛错。

## 停掉全部并重启（`dsh_host`）

「把所有对话停下来 → 重启 DSH → 接着干」是一次调用：

```jsonc
// dsh_host {action:"restart", confirm:true}
{ "transport": "api", "restartId": "restart-…", "exitInSeconds": 6,
  "stopped": { "requested": 3, "cancelled": 2, "failed": 0, "deferred": 1 },
  "willResume": [ { "sessionId": "session-…", "wasRunning": true } ],
  "watcher": { "pid": 4242, "logPath": "C:\\Users\\…\\.dsh\\controller\\restart-watch.log" } }
```

**顺序就是安全边界**，少一步都不行：

1. **先证伪**——父进程的 exe 必须就是本进程所在的那个 exe，且命令行里没有 `--expose-internals`：
   证明「退出去之后有东西可以重新拉起」。跑在 headless 的 `dsh` CLI 里时这一步就失败，于是明确拒绝。
2. **先落一份 `arming` 计划**——在干最重的那一步之前先留下痕迹。快照要列全部会话，它曾经在一次调用里
   逐条重折 478 份日志（实测 255.7s / 293.9s / 320.7s），于是 `restart` 停在第二步：没有错误、没有结果，
   盘上连状态目录都没有，事后只能从会话日志里把它挖出来。现在只要 `status` 里看到 `arming`，答案就是
   「有人按过重启、卡在快照」。`arming` **不可恢复**：没有请求过退出，就没有证据表明会话被中断过，
   恢复腿不会投任何消息；超过 `planTtlSeconds` 它自己变成 `expired`。
3. **快照**——重启前 `running: true` 的会话就是重启后要接着跑的名单。这份快照随后交给 `pauseAll` 复用，
   同一次调用不扫第二遍。
4. **停止**——立即 `agent.cancel()`，逐条报成功/失败。**发起调用的那条会话除外**：中止它会把正在执行
   本次调用的那一轮一起收掉，工具结果就再也送不回去；它排在退出前一刻收。
5. **计划成型落盘**——状态改成 `armed`，写进 `<DSH home>/controller/restart-plan.json`。退出之后没有任何
   代码能补写，所以它必须先写。
6. **看门狗先起来**——它**不属于 DSH 的进程树**：优先用 WMI（`Win32_Process.Create`）起，新进程的父进程
   是 `WmiPrvSE.exe`（实测），所以即使桌面壳用 kill-on-close 的 Job Object 收子进程也带不走它；WMI 不可用
   时才退回 `detached` spawn。它起不来就**不请求退出**：宁可重启没发生，也不要退出去回不来。
7. **延迟退出**——默认 6 秒后才 `ctx.appExit(0)`，为的就是让上面的结果先送达调用方。退出前还会回读一次
   看门狗是否还活着（`probeWatcherAlive`），它已经不在了就取消退出——退出去且没人拉起来是最坏的结局。

整个动作的时间预算是 **180s**（探壳 20s + 看门狗 30s + 余量）：比它内部每一步的上限都大，否则会在看门狗
已经起来之后把结果掐掉，而那时退出还在排队——那正是「按了没反应」的另一种形态。

看门狗只做一件事：等主进程 PID 消失 → 再等 `settleMs` 让日志写完 → 确认没有同名进程残留 →
`Start-Process` 拉起 exe。超时还没退，它**放弃并且不启动第二个实例**（退 3），因为两个 DSH 抢同一个
profile 比重启失败更糟。

重启后的恢复腿挂在 bundle 加载期：读那份计划，`sessionController` 还没装配就每 3 秒重试（最多
`resumeWaitMs`），然后对每条会话 `resolveAgent + followup` 投一条「继续」（默认正文
`继续上次未完成的工作。`）。三条自我约束：

- **只有别的进程写的计划才会投递**：`pid` 与进程启动时刻一起比对，所以插件热重载不会把消息重投一遍；
- **先 claim 再投**：投递前把状态写成 `claimed` 落盘，投到一半崩了也不会从头再来一遍；
- **过期不恢复**：超过 `planTtlSeconds`（默认 15 分钟）的计划改成 `expired`，隔夜才打开的应用不会突然满血复活。

`dsh_host {action:"status"}` 读的就是那份计划与看门狗日志（`transport: "disk"`——它们只存在于磁盘上，
这不是降级，而是唯一存在的地方）。想只看不动，用 `restart {dryRun:true}`（**不需要 `confirm`**：它不写盘、
不停会话、不退出，而它恰恰就是「先说清要停掉哪些会话」的那一步）：它照样会跑「先证伪」与快照那两步，
所以「这台机器上到底能不能重启」在没有副作用的情况下就能问出答案。

## 三层通道与降级顺序

```
1. api      cordis 服务          最准；能确认落盘、能报 restart-required
2. disk     ~/.dsh 下的真实文件  服务缺席时仍然能读会话状态、能读插件操作日志
3. cli      `dsh plugin …`       pluginManager 缺席时安装/卸载的退路（见下）
4. ui       真实鼠标键盘          只有 GUI 才有的东西
5. process  DSH 之外的进程        重启看门狗：退出之后唯一还活着、能把应用拉起来的东西
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
包名写进 `bundles` 后，同一轮对话的下一次请求就看到了这五个工具）。

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
| `api.actionTimeoutMs` | `30000` | 一次调用的时间预算：超时以可读错误收口（不等于取消）。慢动作各自声明更大的上限：`wait` = `defaultWaitMs`+10s、`create` = `clickTimeoutMs`+`waitMs`+30s、`install`/`remove` = 900s、`restart` = 180s、`resume` = 120s |
| `ui.windowTitle` | `null` | 目标窗口标题子串；`null` = 按进程名找 |
| `ui.processName` | `DeepSeek Harness` | 没有 `windowTitle` 时按进程名找窗口 |
| `ui.screenshotDir` | `<插件>/tmp/screens` | `look` 的落地目录 |
| `ui.scriptTimeoutMs` | `60000` | 单次 PowerShell 动作超时 |
| `ui.focusSettleMs` | `120` | 前台化后等待多久再确认 |
| `guard.requireConfirmForCreate` | `false` | 建会话是否必须带 `confirm:true` |
| `guard.requireConfirmForPlugins` | `true` | 改插件状态是否必须带 `confirm:true` |
| `guard.requireConfirmForRestart` | `true` | `dsh_host {action:"restart"}` 是否必须带 `confirm:true`（`dryRun:true` 不需要） |
| `restart.enabled` | `true` | 启动时是否检查并执行恢复计划 |
| `restart.delaySeconds` | `6` | 请求退出前的延迟：本次工具结果要先送达 |
| `restart.watcherTimeoutSeconds` | `180` | 看门狗等主进程退出的上限；到点放弃，不启动第二个实例 |
| `restart.settleMs` | `1500` | 主进程退出后再等多久才拉起（让会话日志写完） |
| `restart.maxResume` | `20` | 一次最多自动继续多少条会话 |
| `restart.planTtlSeconds` | `900` | 计划的有效期；过期不再恢复 |
| `restart.resumeText` | `继续上次未完成的工作。` | 重启后投给每条会话的正文 |
| `restart.keepInbox` | `false` | 中止会话时是否保留排队/引导消息 |
| `restart.resumeDelayMs` / `resumeWaitMs` | `4000` / `180000` | 启动后多久开始检查恢复、最多等宿主装配多久 |

配置写错在**加载时**抛错，不留到调用时；一个悄悄用着默认值的插件比一个加载失败的插件更难查。

## 验证

```powershell
node --test "tests/*.test.mjs"   # 64 个用例：配置归一化、路径编码、zstd 帧解码、工具契约、宿主适配、重启计划
node selftest.mjs                # 不开 DSH 也能跑：磁盘回退 + 探测 + UI 回退找窗口 + 重启计划位置
```

自检里有一项值得一提：磁盘回退能在一台**没开 DSH** 的机器上列出全部会话（本次实测 462 条 / 2 条在跑），
因为会话日志是 append-only 的 zstd 帧串，按 magic 切帧、末尾半写的帧丢掉就能在别人正在写的时候读。

## 已知边界

- **重启是「进程外」完成的，而且只认桌面壳**。DSH 没有公开的 restart API：桌面壳自己的「重启应用与
  Host」是 Electron 侧的 `app.relaunch() + exit()`，Host 只拿得到 `ctx.appExit`——它能请求退出，但退出
  之后没有任何代码还活着去把应用拉起来。所以本插件写计划 + 起看门狗 + 延迟退出三步走。**跑在 headless
  的 `dsh` CLI 里时它会明确拒绝**（那时看不到桌面壳，退出就回不来），而不是赌一把。
- **看门狗的存活方式是量出来的，不是假设的**。WMI 起的进程父进程是 `WmiPrvSE.exe`（实测），所以它不在
  DSH 的进程树里；`detached` 只是退路。仍有残余风险：如果壳在退出时把**整个用户会话**里的进程都收走
  （目前没有观察到），重启就不会自动发生——那种情况下的兜底是「计划仍在盘上」，你手动打开 DSH 后恢复腿
  照样会把那些会话继续起来。
- **`state` 是推断出来的**。`RUNNING` / `IDLE` / `STALLED` 来自「回合边界 + 文件 mtime」；一个刚崩掉的
  会话最多 5 分钟会被报成 `RUNNING`。要看内存里的权威状态，用 `dsh_control {action:"session"}` 的
  `live.status`。**重启快照用的是宿主口径**（`sessionController.list()` 的 `running`），只有在退到磁盘
  扫描时才带上 `staleRisk: true`。
- **`dsh_sessions {action:"abort"}` 与 `dsh_host {action:"pause-all"}` 都是破坏性的**：被中止的那一轮以
  `aborted` 收口，未完成的工作不会重来（重启那次的「继续」是重新开始一轮，不是接着半个工具调用跑）。
- **「继续」是一次新的模型调用**。重启后自动继续 N 条会话就是 N 个新回合，会真的花钱花时间，所以有
  `restart.maxResume` 这个上限，而且范围默认只覆盖「重启前真的在跑」的那些。
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
