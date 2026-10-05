/**
 * `dsh-controller` 的文档注册表：每个工具的用途、每个动作要什么、有什么风险、下一步去哪。
 *
 * 这个文件是**面向模型的 prose 的唯一来源**：`shared.mjs` 从它派生工具描述与 `action` 的
 * enum 说明，`guide` 动作从它渲染完整参考。一个动作在这里没有条目、或者在工具模块里
 * 没有 handler，都会在加载时直接抛错——不会出现「注册了但没人知道它做什么」的工具。
 *
 * 写法约定：
 *   - `summary` 一句话说清这个动作做什么，会被拼进常驻 schema，控制在 200 字符以内。
 *   - `required` 列的是**必填参数**，也就是第一次调用最容易漏的东西。
 *   - `risk` 只写「会改变机器/他人可见状态」的风险，并且要短。
 *   - `detail` 是 `guide` 才渲染的长文本：返回形状、失败模式、例子。
 *
 * @module dsh-controller/tools/registry
 */

/** 传输：这个动作实际走的是哪条路。 */
export const TRANSPORTS = ['api', 'ui']

/** 所有工具的文档条目，键就是工具的注册名。 */
export const TOOLS = {
  dsh_control: {
    purpose: 'Read what DSH itself is: version, home, profile, default model, sandbox, workspaces, sessions, and which of DSH\'s own services this process can actually reach. Read-only — nothing here changes any state.',
    needs: 'nothing beyond the plugin being loaded; every field degrades to a stated absence instead of failing.',
    next: 'dsh_sessions to act on a session, dsh_plugins to manage plugins, dsh_ui when only the GUI exposes the thing you need.',
    actions: {
      overview: {
        summary: 'DSH 自身的概览：版本、家目录、profile、默认模型、沙箱模式、工作区数、会话数、正在跑的会话数。',
        use: '用一次就有全局图景。',
        detail: [
          '返回 `{ transport, dsh, profile, model, sandbox, workspaces, sessions, live }`。',
          '`sessions.total` 来自会话持久化目录；`live.count` 是「回合尚未闭合」的会话数——',
          '它由 `~/.dsh/sessions` 下的日志与 `~/.dsh/storages/session_projcache` 的投影共同判定，',
          '不是内存里的运行态，所以刚崩溃的会话要等 5 分钟才会被判成 STALLED 而不是 RUNNING。',
        ],
      },
      capabilities: {
        summary: '逐个探测 DSH 的 cordis 服务与桌面回退通道，报告每一项可用/缺失以及依据。',
        use: '在依赖某条路径之前先问一次；也是「为什么这个动作走了 UI」的答案来源。',
        detail: [
          '返回 `{ api: [{ service, available, evidence }], ui: [{ channel, available, evidence }] }`。',
          '`api` 里的每一项都是 `ctx.get(name)` 的实际结果；缺失时 `evidence` 说明是哪一层没有装配。',
          '`ui` 检查 PowerShell、Windows OCR、以及 `computer_*` 工具是否已在同进程注册。',
        ],
      },
      session: {
        summary: '一条会话的实时状态：回合是否开着、当前第几步、目标、token 用量、上下文压力。',
        use: '默认看本会话（`self`）；给 sessionId 看别的会话。',
        detail: [
          '参数：`sessionId`（可选，默认本会话）。',
          '返回 `{ sessionId, state, turn, step, goal, usage, context, source }`。',
          '`source: "agent"` 表示数据来自内存里的 live agent（最准），`"projection"` 表示只有落盘的',
          '投影可用（会话冷着的时候就是这样）。',
        ],
      },
      transport: {
        summary: '对每个动作列出它会优先走 API 还是 UI，以及为什么——把「优先 DSH 自己的 API」变成可核对的事实。',
        detail: [
          '返回 `{ action: { preferred, fallback, reason } }`。',
          '`preferred` 只取决于运行期探测结果，不取决于配置文件里写了什么。',
        ],
      },
      guide: {
        summary: '按需渲染完整参考：某个工具或某个动作的参数、返回、成本、坑与例子。',
        use: '常驻 schema 只带判断所需的一句；长尾都在这里。',
        detail: [
          '参数：`tool`（工具名，可选）、`actionName`（动作名，可选，需同时给 `tool`）。',
          '两个都不给时列出全部工具与动作。',
        ],
      },
    },
  },

  dsh_sessions: {
    purpose: 'Read and control DSH conversations themselves: list them with their live state, read one, create a new one with a first message, append a message to an existing one, abort a running turn, wait for idle, rename.',
    needs: 'the `agents` and/or `sessionController` service for anything that touches a live agent; the session log directory for read-only listing, which works even when those services are absent.',
    next: 'dsh_control {action:"session"} to watch one run; dsh_ui if a conversation can only be reached through the GUI.',
    actions: {
      list: {
        summary: '列出会话及其状态（RUNNING / IDLE / STALLED），可按工作区或全部，按最近活动排序。',
        use: '先看清有哪些对话、哪条在跑。',
        detail: [
          '参数：`workspace`（绝对路径或 `all`，默认 `all`）、`limit`（默认 20）。',
          '返回每条会话的 `{ sessionId, title, workspace, state, openTurn, lastActivitySec, goal }`。',
          '状态判定：回合未闭合且最近有写入 = RUNNING；回合未闭合且长时间没写入 = STALLED；',
          '回合已闭合 = IDLE。判定只依赖磁盘证据，因此对刚崩溃的会话有最多 5 分钟的误判窗口。',
        ],
      },
      get: {
        summary: '一条会话的详情：头部（工作目录、创建时间）、最近几轮、当前回合与步、目标、token 用量。',
        required: ['sessionId'],
        detail: [
          '参数：`sessionId`、`tail`（返回最近多少条事件，默认 20）。',
          '活的会话读内存投影；冷的会话读持久化日志——两者的字段形状一致。',
        ],
      },
      create: {
        summary: '新建一条会话：默认先点 DSH 自己的「新会话」按钮，失败再整条退回 API；第一条消息由 API 投递。',
        required: ['text'],
        risk: '会真的开一条新对话并消耗模型额度；GUI 路径会把桌面窗口抢到前台、动真实鼠标；`cwd` 写错会让它在错误的目录里工作。',
        use: '需要一条与当前上下文隔离的新对话时。',
        detail: [
          '参数：`text`（第一条消息）、`cwd`（绝对路径，默认当前工作目录）、`title`（可选）、',
          '`preset`（可选，默认取当前默认 preset）、`via`（`auto` 默认 / `gui` / `api`）。',
          '返回 `{ sessionId, transport, detectedBy, firstMessage, waitedMs, fallback? }`。',
          '`transport: "ui"` = 会话是点出来的、`detectedBy: "list-diff"`；`"api"` = 这条会话由 API 建立，',
          '`fallback.reason` 说明 GUI 为什么没走通。',
          '**为什么 GUI 能优先**：那个按钮走的是产品自己的建会话路径，点出来的会话与',
          '`sessionController.create` 造的是同一种东西；关键是这条路**有证据**——「点之前有哪些会话 id」',
          '与「点之后有哪些」的集合差证明它真的建成了，所以列表里本来就有空会话也不会认领错。',
          '**全有或全无**：窗口不在前台、会话没出现在列表里、第一条消息没投出去——任一步失败就整条退回',
          'API，绝不出现「GUI 建了一半 + API 再建一条」的两条对话。',
          '**这台机器上量出来的边界**（DSH 0.2.0-rc.2）：点按钮有效；`Ctrl+N` 触发不了（默认绑定确是',
          '`primary+KeyN`），所以走真实点击；输入框是 Lexical，只吃 `SendKeys` 的 ASCII——Unicode',
          '`SendInput` 送中文被 Windows 收下却一个字不显示，剪贴板 `^v` 同样无声失败，`Ctrl+A`/退格也清不掉',
          '输入框里遗留的草稿（草稿会跨「新会话」保留）。所以**会话走 GUI、消息走 API**；想让消息也在 GUI 里',
          '敲就打开 `config.create.submitInGui`，脚本会在「输入框已有草稿」或「正文非 ASCII」时明确拒绝。',
        ],
      },
      send: {
        summary: '往一条已有会话追加一条用户消息：活的会话直接投，冷的会话先 resume 再投。',
        required: ['sessionId', 'text'],
        risk: '对方会话会真的开始跑一轮；如果它正忙，消息会排队而不是插队。',
        detail: [
          '参数：`sessionId`、`text`、`mode`（`followup` 默认 = 下一轮；`steer` = 当前轮的中途引导；',
          '`inject` = 只加模型可见上下文，不唤醒驱动）。',
          '实现走 `ctx.sessionController.resolveAgent(sessionId)` + `agent.followup/steer/inject`，',
          '与 `dsh-schedule` 投递提醒是同一条路径。',
        ],
      },
      abort: {
        summary: '中止一条会话当前的活动（回合 + 排队/引导输入）。',
        required: ['sessionId'],
        risk: '被中止的那一轮会以 aborted 收口，未完成的工作不会自动重来。',
        detail: [
          '参数：`sessionId`、`keepInbox`（默认 false，也就是连排队一起清掉）。',
          '实现走 `agent.cancel(cause, { keepInbox })`。',
        ],
      },
      wait: {
        summary: '等到一条会话空闲（或超时），返回它最终的结束原因。',
        required: ['sessionId'],
        detail: [
          '参数：`sessionId`、`timeoutMs`（默认取配置 `api.defaultWaitMs`）。',
          '返回 `{ sessionId, state, waitedMs, reason }`；超时不抛错，而是返回 `state:"RUNNING"` 与',
          '`reason:"timeout"`——超时是结果，不是异常。',
        ],
      },
      rename: {
        summary: '改一条会话的标题。',
        required: ['sessionId', 'title'],
        detail: ['实现走 `ctx.sessionTitle.rename(session, title)`；会话冷着时先 resolve。'],
      },
    },
  },

  dsh_plugins: {
    purpose: 'Inspect and change which DSH plugins are installed and enabled: the profile bundle list, the runtime row tree, enable/disable, install from a path or a package name, and the last operation log.',
    needs: 'the `pluginManager` service (or the profile files on disk) for every action except `list`, which reads the profile manifest directly.',
    next: 'dsh_control {action:"capabilities"} when an action reports the service is absent.',
    actions: {
      list: {
        summary: '列出 profile 里的插件 bundle 与它们的启用状态、版本、来源。',
        detail: [
          '读 `<profile>/package.json` 的 `dsh.profile.bundles` 与 `<profile>/cordis.patch.yml`，',
          '所以即使 pluginManager 服务不在也能回答。',
        ],
      },
      inventory: {
        summary: '运行期实际加载的行树：每个插件的 id、模块、启用状态、以及它注册了什么。',
        detail: ['来自 `ctx.get("pluginInventory")`（`@deepseek-ai/dsh-host-plugin-inventory`）。'],
      },
      enable: {
        summary: '启用一个插件（写 profile patch）。',
        required: ['id'],
        risk: '改的是正在使用的 profile 配置；多数行要重载或重启才真正生效。',
      },
      disable: {
        summary: '禁用一个插件（写 profile patch）。',
        required: ['id'],
        risk: '禁用正在提供服务的行会让依赖它的工具消失。',
      },
      install: {
        summary: '安装一个插件：本地路径、npm 包名或 git 地址。',
        required: ['spec'],
        risk: '会执行包管理器并改 profile；默认需要 confirm:true。',
        detail: [
          '三种来源走同一条 `installBundle(spec)`：npm 名、`git+…`/`github:…`、以及本地绝对路径。',
          '返回 `ChangeResult`，其中 `application` 告诉你这次是 `applied` 还是 `restart-required`——',
          '换掉一个已经加载的同名包必须重启进程，这一条没有 API 能绕开。',
          'pnpm 挡下依赖的构建脚本时，结果里会带 `pendingBuilds`，再带上 `approvedBuilds` 重试。',
        ],
      },
      remove: {
        summary: '卸载一个插件 bundle。',
        required: ['id'],
        risk: '会先取消选择、卸载、再 pnpm remove；正在提供服务的行会让依赖它的工具消失。',
        detail: ['返回 `ChangeResult`；`application` 同上。'],
      },
      inspect: {
        summary: '在安装之前看清一个 spec 是什么：包名、版本、来源、是否带 dsh.bundle。',
        required: ['spec'],
        detail: ['走 `pluginManager.inspect(spec)`；不改任何状态，是 install 之前该做的那一步。'],
      },
      log: {
        summary: '最近几次插件操作的结果与日志尾部。',
        detail: [
          'pluginManager 明确不保留已完成操作的历史（完成后就从在途表里删掉），所以这里读的是它',
          '自己落在 `<profile>/.plugin-manager/logs/operation-*/pnpm.log` 下的日志，按时间倒序。',
          '结果里的 `transport` 是 `disk`——这不是降级，而是唯一存在的地方。',
        ],
      },
    },
  },

  dsh_ui: {
    purpose: 'The fallback path: drive the DSH desktop window with real input when the thing you need is only exposed by the GUI. Everything here acts on the real machine — it takes the foreground, moves the real pointer and types real keys.',
    needs: 'Windows PowerShell 5.1 and a visible DSH window. Nothing else; OCR is not required because `look` returns a PNG the caller can read.',
    next: 'dsh_control {action:"capabilities"} to see whether the API path is simply missing; prefer it whenever it exists.',
    actions: {
      window: {
        summary: '找到 DSH 窗口并（可选）前台化：返回句柄、标题、矩形与是否已在前台。',
        detail: [
          '参数：`title`（可选，标题子串）、`focus`（默认 false）。',
          '返回 `{ handle, title, processId, rect, foreground, matches }`。',
          '没有 `focus` 时只观察，不动窗口——这是本插件里唯一保证不改变机器状态的动作。',
        ],
      },
      look: {
        summary: '把 DSH 窗口截成一张 PNG，返回文件路径与像素尺寸。',
        detail: [
          '参数：`title`（可选）、`path`（可选，默认落到插件 tmp/screens）。',
          '返回 `{ path, width, height, rect }`；调用方自己读图判断，这里不做识别。',
        ],
      },
      click: {
        summary: '在 DSH 窗口内按窗口相对坐标点一下（先确认窗口在前台，否则拒绝点击）。',
        required: ['x', 'y'],
        risk: '真实点击：点到什么就是什么，输入失败不会报错。',
      },
      type: {
        summary: '往 DSH 窗口里输入文本（先前台化并确认）：ASCII 走 SendKeys，非 ASCII 走 Unicode SendInput，再退回剪贴板粘贴。',
        required: ['text'],
        risk: '真实按键：中文走剪贴板粘贴，会覆盖剪贴板内容。',
        detail: [
          '三条投递路径按顺序试，返回里的 `method` 说明这次实际用了哪条：',
          '`sendkeys`（ASCII，实测在 DSH 输入框里能落字）、`sendinput-unicode`（中文/emoji，绕过',
          '输入法与键盘布局）、`clipboard-paste`（写剪贴板再发原生 `Ctrl+V`，只对会自己读剪贴板的',
          '编辑器有效）。',
          '**没有到达校验**：合成输入失败是不报错的，写了就是写了。要确认落点，自己 `look` 一张图',
          '或读回来——这不是谨慎，是这台机器上实测出来的：`SendKeys` 对 Lexical 输入框发 `^v`',
          '返回 ok 而屏幕上一个字都没有。',
        ],
      },
      key: {
        summary: '往 DSH 窗口发一个组合键，例如 `^n`（Ctrl+N）、`{ENTER}`。',
        required: ['chord'],
      },
      scroll: {
        summary: '在 DSH 窗口内滚动若干格（正数向上/远离用户）。',
        required: ['notches'],
      },
    },
  },
}

/**
 * 取一个工具的文档条目；没有就抛错。
 * @param {string} name - 工具名。
 * @returns {object} 文档条目。
 */
export function lookupTool(name) {
  const entry = TOOLS[name]
  if (entry === undefined) throw new Error(`dsh-controller: no registry entry for tool ${name}`)
  return entry
}

// 注册表是纯数据：改这里只影响描述与 guide 的渲染，不会改变任何动作的行为。
