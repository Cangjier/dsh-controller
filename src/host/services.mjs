/**
 * 宿主适配层：**读和控制先走 DSH 自己的 API，读不到才退回磁盘**；唯一例外是
 * `createSession()`——它默认先点真实窗口里的「新会话」，失败再整条退回 API。
 *
 * 这一层存在的理由只有一个：把「这次用的是哪条路」变成结果里的一个字段。所以每个方法都返回
 * `source` 或 `transport`，并且在 API 调用失败时把原因放进 `warnings`——**不抛错、不静默降级**。
 * 一个插件对宿主内部的猜测错了，应该表现为一条可读的警告，而不是一次异常的失败或者一次假成功。
 *
 * 探测出来的服务清单在 `API_SERVICES`：每一项都是 `ctx.get(name)` 的真实结果，缺失时说明
 * 是哪一层没装配。判定依据来自 DSH 0.2.0-rc.2 的包源码（`dsh-client-*` 与各服务的 README），
 * 不是猜的；但版本会变，所以每个调用都写成「有就用、没有就退」。
 *
 * @module dsh-controller/host/services
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome, profileDir, profileName } from './paths.mjs'
import { iconNameFromExe, quitViaTray, watcherGraceSeconds } from './graceful-quit.mjs'
import { listSessionLogs, readLog, readProjection, summarizeFromDisk, summarizeFromProjection } from './sessionlog.mjs'
import {
  PLAN_VERSION,
  hostIdentity,
  planPath,
  probeDesktopShell,
  readLogTail,
  readPlanResult,
  sameBoot,
  spawnRelauncher,
  watcherLogPath,
  writePlan,
} from './restart.mjs'
import { runDesktop } from '../ui/desktop.mjs'

/** 本插件会用来控制 DSH 的宿主服务，以及每一项缺席意味着什么。 */
export const API_SERVICES = [
  { name: 'agents', why: '创建/恢复 agent、读 status、cancel、whenIdle —— 会话控制的核心' },
  { name: 'sessions', why: 'live 会话对象与 `flush` 落盘确认' },
  { name: 'sessionController', why: '`create` / `resolveAgent` / `list` / `inspect` —— 产品自己投递消息与开新会话的路径' },
  { name: 'sessionQuery', why: '历史与标题的精确读取（冷会话也能读）' },
  { name: 'sessionProjections', why: '实时投影：goal、turnBoundary 等' },
  { name: 'sessionTitle', why: '改会话标题' },
  { name: 'workspaceRegistry', why: '工作区列表、把新会话归入分组' },
  { name: 'goals', why: '读目标（需 live agent）' },
  { name: 'jobs', why: '列后台任务' },
  { name: 'schedule', why: '列定时提醒' },
  { name: 'pluginManager', why: '插件 list / enable / disable / install / remove' },
  { name: 'pluginInventory', why: '运行期实际加载的行树' },
  { name: 'loader', why: '插件行树的原始来源（pluginInventory 缺席时的退路）' },
  { name: 'tools', why: '注册本插件的工具、探测同进程的 computer_* 工具' },
  { name: 'llm', why: '模型路由信息' },
  { name: 'agentDefaultModel', why: '默认模型选择' },
  { name: 'agentPresets', why: 'preset 解析（新建会话时挂 preset 用）' },
  { name: 'appExit', why: '请求宿主退出' },
]

/** 宿主缺失时用来表达「没有」的取值。 */
const ABSENT = undefined

/**
 * 读一个服务，`ctx.get` 不存在或抛错都当作缺失。
 * @param {object} ctx - cordis 上下文。
 * @param {string} name - 服务名。
 * @returns {object|undefined} 服务实例。
 */
function get(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) ?? ABSENT : ABSENT
  } catch {
    return ABSENT
  }
}

/** 把「有没有」变成一句可读的证据。 */
function evidenceFor(ctx, name) {
  if (typeof ctx?.get !== 'function') return 'ctx.get 不可用：插件上下文不是 cordis Context'
  try {
    const value = ctx.get(name)
    if (value === undefined || value === null) return 'ctx.get(name) 返回空：这一行没有装配'
    return `ctx.get('${name}') 返回 ${value.constructor?.name ?? typeof value}`
  } catch (error) {
    return `ctx.get('${name}') 抛错：${error instanceof Error ? error.message : String(error)}`
  }
}

/** 一个服务原型上的公开方法名，最多 40 个（够判断，又不至于把结果撑爆）。 */
function describeMethods(service) {
  try {
    const seen = new Set()
    let prototype = Object.getPrototypeOf(service)
    while (prototype !== null && prototype !== Object.prototype) {
      for (const name of Object.getOwnPropertyNames(prototype)) {
        if (name !== 'constructor' && !name.startsWith('_')) seen.add(name)
      }
      prototype = Object.getPrototypeOf(prototype)
    }
    return [...seen].sort().slice(0, 40)
  } catch {
    return []
  }
}

/**
 * 把标题归一化成字符串。
 *
 * `sessionQuery.readTitle()` 返回的是**一个对象**（`{ title, messageSeqs, source, eventSeq, updatedAt }`），
 * 而投影缓存里存的是字符串。两者都会被读到，所以这里统一收口，免得调用方拿到两种形状。
 * @param {unknown} value - 原始标题。
 * @returns {string|null} 标题字符串。
 */
export function titleText(value) {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object' && typeof value.title === 'string') return value.title
  return null
}

/** 把 tokenMeter 的测量结果压成总量，不把逐节点数组塞进上下文。 */
function trimUsage(usage) {
  if (usage === null || usage === undefined || typeof usage !== 'object') return usage ?? null
  return {
    totalTokens: usage.totalTokens ?? null,
    surfaceTokens: usage.surfaceTokens ?? null,
    surfaceDeltaTokens: usage.surfaceDeltaTokens ?? null,
    baselineTokens: usage.baseline?.tokens ?? null,
    baselineUsage: usage.baseline?.usage ?? null,
    nodeCount: Array.isArray(usage.nodes) ? usage.nodes.length : null,
  }
}

/**
 * 探测当前进程能走哪条路。只读，不动任何状态。
 *
 * 除了「有没有」，还列出每个服务原型上的方法名：DSH 各版本之间方法集是会变的，而
 * 「这个服务在，但它没有我要调的那个方法」是这里最常见的失败。把方法名摆出来，
 * 上层就能自己判断该走哪条路，而不是等一次调用炸掉才发现。
 * @param {object} ctx - cordis 上下文。
 * @returns {{ api: object[], ui: object[] }} 逐项可用性与证据。
 */
export function probe(ctx) {
  const api = API_SERVICES.map(({ name, why }) => {
    const service = get(ctx, name)
    const available = service !== ABSENT
    return {
      service: name,
      why,
      available,
      evidence: evidenceFor(ctx, name),
      methods: available ? describeMethods(service) : [],
    }
  })

  const tools = get(ctx, 'tools')
  const computerTools = []
  for (const candidate of ['computer_env', 'computer_screen', 'computer_window', 'computer_locate', 'computer_mouse', 'computer_keyboard']) {
    try {
      if (typeof tools?.get === 'function' && tools.get(candidate) !== undefined) computerTools.push(candidate)
    } catch { /* 探测失败就当没有 */ }
  }

  return {
    api,
    ui: [
      {
        channel: 'powershell',
        available: process.platform === 'win32',
        evidence: process.platform === 'win32' ? 'Windows：src/ui/desktop.ps1 可以用 Windows PowerShell 5.1 跑' : `平台是 ${process.platform}，回退脚本只支持 Windows`,
      },
      {
        channel: 'computer_* tools',
        available: computerTools.length > 0,
        evidence: computerTools.length > 0
          ? `同进程已注册：${computerTools.join(', ')}（dsh-computer-use）`
          : '同进程没有 computer_* 工具；需要桌面自动化时用本插件自己的 dsh_ui',
      },
    ],
  }
}

/** 一个 user 角色消息的字面量。 */
/**
 * 构造一条用户消息。
 *
 * 不用宿主的 `createUserMessage()`：本插件是零依赖的 link 包，import 不到宿主内部模块。
 * 会话侧只校验 `id` 非空、`role` 与事件类型匹配、`content` 是数组、`source.kind` 非空，
 * 所以字面量就是合法输入；`source.kind` 取 `cordis-host-runner`——这是宿主自己在进程内
 * 投递消息时用的 kind（`dsh-mail-notify` 用的是同一个）。它**不会**被当成「直接来自人类」，
 * 这一点是对的：工具投递的消息不该满足 requireDirectHuman 那类判定。
 * @param {string} text - 消息正文。
 * @returns {object} 用户消息。
 */
export function userMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'cordis-host-runner' },
  }
}

/** 读运行时的版本事实；读不到就说读不到。 */
function runtimeFacts() {
  const file = join(dshHome(), 'dsh-runtimes', 'dsh-primary-runtime', 'runtime.json')
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return { source: file, desktopVersion: parsed.desktopVersion ?? null, node: parsed.node ?? null, python: parsed.python ?? null, platform: parsed.platform ?? null, arch: parsed.arch ?? null }
  } catch (error) {
    return { source: null, desktopVersion: null, node: null, python: null, platform: null, arch: null, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 安全的调用：把异常变成 `{ error }`，让调用方决定怎么呈现。 */
async function attempt(label, warnings, fn) {
  try {
    return await fn()
  } catch (error) {
    warnings.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/**
 * 造一个会话/插件控制器。每次工具调用都会用同一个 `ctx` 重新解析服务，
 * 因为 cordis 树可以在运行期变化（插件被禁用/启用），缓存服务引用会读到过期的实例。
 * @param {object} ctx - cordis 上下文。
 * @param {object} config - 归一化后的插件配置。
 * @param {object} [deps] - 可替换的副作用入口；目前只有 `runDesktop`，测试用它避免真的去点窗口。
 * @returns {object} 适配器。
 */
export function adapter(ctx, config, deps = {}) {
  const desktop = typeof deps.runDesktop === 'function' ? deps.runDesktop : runDesktop
  // 重启这件事的副作用入口全部可替换：真机上它们会真的问 Windows、真的起进程，
  // 而测试必须能在不碰这台机器的前提下走完同一条代码路径。
  const probeShell = typeof deps.probeShell === 'function' ? deps.probeShell : probeDesktopShell
  const startRelauncher = typeof deps.startRelauncher === 'function' ? deps.startRelauncher : spawnRelauncher
  // 优雅退出那一腿也会真的动鼠标，所以它同样必须可替换：测试要能在不碰这台机器的前提下走完
  // 「先请它自己退、退不掉再看门狗收」这条路径。
  const gracefulQuit = typeof deps.quitViaTray === 'function' ? deps.quitViaTray : quitViaTray
  const loadPlan = typeof deps.readPlan === 'function' ? deps.readPlan : readPlanResult
  const savePlan = typeof deps.writePlan === 'function' ? deps.writePlan : writePlan
  const later = typeof deps.later === 'function' ? deps.later : (fn, ms) => setTimeout(fn, ms)
  const clock = typeof deps.now === 'function' ? deps.now : () => Date.now()
  /**
   * 建一次会话目录索引。
   *
   * **一次工具调用只建一次。** `listSessionLogs()` 要遍历 `~/.dsh/sessions` 下每个工作区、每条会话
   * 并逐个 stat：本机 476 条会话实测 61ms。原先每个会话行都重建一次这份索引，一次 `listSessions`
   * 就变成 476 × 61ms ≈ 29s 的二次项（实测 `overview` 因此要 33.5s）。一次调用里的目录快照本来
   * 就该是同一份，所以这里不做过期，只要求调用方建一次、传下去。
   * @returns {Map<string, object>} 会话 id → `listSessionLogs()` 的条目。
   */
  const buildLogIndex = () => new Map(listSessionLogs().map((entry) => [entry.sessionId, entry]))

  /**
   * 这条会话日志的磁盘事实；找不到日志时返回 null。
   * @param {string} sessionId - 会话 id。
   * @param {string[]} warnings - 警告收集器。
   * @param {Map<string, object>} index - `buildLogIndex()` 的结果；必须由调用方复用，不要每行重建。
   * @param {object} [options] - `{ light }`：`light: true` 表示「列表只要 title/state/quietSec/goal」，
   * 投影缓存能回答就不读日志尾巴；投影不足以判定时**仍然**退回完整读法，不是猜。
   * @returns {object|null} 磁盘状态行。
   */
  const diskState = (sessionId, warnings, index, options = {}) => {
    try {
      const entry = index.get(sessionId)
      if (entry === undefined) return null
      if (options.light === true) {
        const light = summarizeFromProjection(entry)
        if (light !== null) return light
      }
      return summarizeFromDisk(entry)
    } catch (error) {
      warnings.push(`读磁盘会话状态失败：${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  return {
    /** 概览。 */
    async overview() {
      const warnings = []
      const workspaces = await attempt('workspaceRegistry.list', warnings, () => {
        const list = get(ctx, 'workspaceRegistry')?.list?.()
        return Array.isArray(list) ? list.map((workspace) => ({ id: workspace.id, path: workspace.path, title: workspace.title ?? null, sessions: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.length : null })) : null
      })
      // 概览只要两个数：会话总条数与「在跑」的条数，两者都直接来自 API。所以这里既不取磁盘事实
      // （`enrich: false`——476 条会话的磁盘富化实测要 10.9s，而这两个数一个字节都用不上），
      // 也不裁到 500（`limit: 'all'`），否则 `total` 会静默地说一个假数字。
      const sessions = await this.listSessions({ workspace: 'all', limit: 'all', enrich: false }, warnings)
      const selection = await attempt('agentDefaultModel.currentSelection', warnings, () => get(ctx, 'agentDefaultModel')?.currentSelection?.() ?? null)

      return {
        transport: 'api',
        dsh: {
          home: dshHome(),
          profile: profileName(),
          profileDir: profileDir(),
          runtime: runtimeFacts(),
          process: { pid: process.pid, node: process.versions.node, platform: process.platform, arch: process.arch, cwd: process.cwd() },
        },
        model: selection ?? null,
        workspaces: workspaces === null ? null : { count: workspaces.length, items: workspaces },
        sessions: { total: sessions.length, live: sessions.filter((session) => session.running === true).length },
        warnings,
      }
    },

    /** 探测结果。 */
    capabilities() {
      return probe(ctx)
    },

    /**
     * 一条会话的实时状态。API 顺序：live agent → 投影 → 投影缓存 → 日志。
     * @param {string} sessionId - 会话 id。
     * @returns {Promise<object>} 状态。
     */
    async sessionState(sessionId) {
      const warnings = []
      const agents = get(ctx, 'agents')
      const agent = await attempt('agents.get', warnings, () => (typeof agents?.get === 'function' ? agents.get(sessionId) : null))

      const projection = readProjection(sessionId)
      let live = null
      if (agent !== null && agent !== undefined) {
        const session = agent.session
        const goal = await attempt('sessionProjections.stateOf(goal)', warnings, () => get(ctx, 'sessionProjections')?.stateOf?.(session, 'goal') ?? null)
        const boundary = await attempt('sessionProjections.stateOf(turnBoundary)', warnings, () => get(ctx, 'sessionProjections')?.stateOf?.(session, 'turnBoundary') ?? null)
        const usage = await attempt('tokenMeter.measure', warnings, () => get(ctx, 'tokenMeter')?.measure?.(session) ?? null)
        const goals = get(ctx, 'goals')
        const goalView = await attempt('goals.get', warnings, () => (typeof goals?.get === 'function' ? goals.get(agent) ?? null : null))
        live = {
          status: agent.status ?? null,
          session: session?.id ?? sessionId,
          cwd: session?.header?.cwd ?? null,
          agentPreset: session?.header?.agentPreset ?? null,
          createdAt: session?.header?.createdAt ?? null,
          title: titleText(await attempt('sessionTitle.get', warnings, () => get(ctx, 'sessionTitle')?.get?.(session) ?? null)),
          goal: goalView ?? goal ?? null,
          turnBoundary: boundary ?? null,
          usage: trimUsage(usage),
        }
      }

      // 只查这一条会话，所以索引也是这里建一次：`diskState` 不自己建，免得回到「每行一次枚举」。
      const disk = diskState(sessionId, warnings, buildLogIndex())
      const rows = projection?.rows ?? {}
      const state = live?.status === 'running'
        ? 'RUNNING'
        : live !== null
          ? 'IDLE'
          : disk?.state ?? 'UNKNOWN'

      return {
        transport: live !== null ? 'api' : disk !== null ? 'disk' : 'none',
        sessionId,
        state,
        running: live?.status === 'running' ?? (disk ? disk.state === 'RUNNING' : null),
        live,
        projection: projection === null ? null : {
          file: projection.file,
          seq: rows.title?.seq ?? null,
          title: rows.title?.val ?? null,
          goal: rows.goal?.val ?? null,
          turnBoundary: rows.turnBoundary?.val ?? null,
          stats: rows.sessionStats?.val ?? null,
          modelSelection: rows.modelSelection?.val ?? null,
          contextPressure: rows.contextPressure?.val ?? null,
          tokenUsage: rows.tokenUsage?.val ?? null,
        },
        disk,
        warnings,
      }
    },

    /**
     * 列出会话。优先 `sessionController.list()`（自带 running 与 agentAvailable），
     * 再退 `sessionQuery.listSessions()`，最后退磁盘扫描。
     *
     * **磁盘富化是这里唯一昂贵的一步，所以它被挪到筛选之后。** `title` / `state` / `quietSec` /
     * `goal` 只能从 `~/.dsh/sessions` 与投影缓存读出来，代价是「每条会话读一段日志 + zstd 解压」——
     * 本机 476 条实测 10.9s。原来的写法在建行的循环里逐行读磁盘、**然后才**筛选与裁剪，等于为了
     * 20 行结果把 476 条全读一遍。现在先用 API 字段建行、筛选排序、裁到 `limit`，只给真的要返回的
     * 那些行补磁盘事实。
     *
     * **`sessionQuery.readTitle` 不允许出现在任何按条循环里。** 它每次调用都会把全部持久化会话
     * 重新枚举一遍（`persistence.list()` 要打开每条日志读首行）再整篇读那条日志，所以「每条都调
     * 一次」是 478 × 478 次文件读：本机实测一次 `list` 要 5 分 20 秒。标题改由投影缓存提供，
     * 且只对真正返回的行读——见 `enrichDisk` 的 `light` 路径。
     *
     * `enrich: false` 表示连富化都跳过：内部调用方（概览只要计数、GUI 建会话只要 id 的集合差、
     * 重启前只要 `running`）用不上 `title` / `quietSec` / `goal`，而每个都要等那一轮磁盘活。
     * @param {object} args - `{ workspace, limit, enrich }`；`limit: 'all'` 表示不裁剪。
     * @param {string[]} [outerWarnings] - 调用方的警告收集器。
     * @returns {Promise<object[]>} 归一化后的会话行。
     */
    async listSessions(args = {}, outerWarnings) {
      const warnings = outerWarnings ?? []
      const enrich = args.enrich !== false

      /**
       * 只给要返回的那些行补磁盘事实。
       * @param {object[]} rows - 已经筛过、裁过的行。
       * @param {Function} titleOf - `(row, disk) => string|null`，让每个分支保留自己的标题优先级。
       * @returns {object[]} 补好的行。
       */
      const enrichDisk = (rows, titleOf) => {
        if (rows.length === 0) return rows
        // 索引只建一次，传给每一行——这是原来那个二次项的修复点。
        const index = buildLogIndex()
        return rows.map((row) => {
          // `light`：列表要的四个字段投影缓存就有，不必为每一行解开 512KB 的日志尾巴。
          const disk = diskState(row.sessionId, warnings, index, { light: true })
          return {
            ...row,
            title: titleOf(row, disk),
            workspace: row.workspace ?? disk?.workspace ?? null,
            state: row.running === true ? 'RUNNING' : disk?.state ?? row.state,
            quietSec: disk?.quietSec ?? null,
            goal: disk?.goal ?? null,
          }
        })
      }

      const controller = get(ctx, 'sessionController')
      let usedSource = null
      const summaries = await attempt('sessionController.list', warnings, async () => {
        if (typeof controller?.list !== 'function') return null
        const value = await controller.list()
        return Array.isArray(value) ? value : null
      })

      if (Array.isArray(summaries)) {
        usedSource = 'api:sessionController.list'
        const rows = summaries.map((summary) => ({
          sessionId: summary.sessionId,
          title: titleText(summary.title ?? null),
          workspace: summary.cwd ?? null,
          running: summary.running === true,
          agentAvailable: summary.agentAvailable === true,
          blank: summary.blank === true,
          parentSessionId: summary.parentSessionId ?? null,
          origin: summary.origin ?? null,
          updatedAt: summary.updatedAt ?? null,
          state: summary.running === true ? 'RUNNING' : 'IDLE',
          quietSec: null,
          goal: null,
          source: 'api:sessionController.list',
        }))
        const selected = filterAndSort(rows, args)
        return enrich ? enrichDisk(selected, (row, disk) => titleText(disk?.title ?? row.title ?? null)) : selected
      }

      const query = get(ctx, 'sessionQuery')
      const records = await attempt('sessionQuery.listSessions', warnings, () => (typeof query?.listSessions === 'function' ? query.listSessions() : null))
      if (Array.isArray(records)) {
        usedSource = 'api:sessionQuery.listSessions'
        const agents = get(ctx, 'agents')
        const rows = []
        for (const record of records) {
          const header = record.header ?? {}
          // `agents.get` 是一次 Map 查表（`AgentRegistry.get`），不是磁盘读，所以每条都问没关系。
          const agent = await attempt('agents.get', warnings, () => (typeof agents?.get === 'function' ? agents.get(header.id) : null))
          rows.push({
            sessionId: header.id,
            // **不在这里读标题。** `sessionQuery.readTitle(id)` 看着是一条记录，实际每一次都要
            // 先把全部持久化会话重新枚举一遍（`corpus.projectMany()` → `persistence.list()` →
            // 逐个打开日志读首行取 header），再把那条日志**整篇**读出来折标题。放在这个循环里
            // 就是 478 × 478 次文件读：本机实测一次 `list` 要 **5 分 20 秒**（tool/call →
            // tool/result 320.7s，另一次 293.9s），而且与 `limit` 无关——裁剪发生在循环之后。
            // 列表要的那个标题投影缓存里就有（`sessionlog.mjs` 的 `summarizeFromProjection()`），
            // 而且只在真正要返回的那几行上读，所以这里留 null，让 `titleOf` 去取。
            title: null,
            workspace: header.cwd ?? null,
            running: agent?.status === 'running',
            agentAvailable: agent !== null && agent !== undefined,
            blank: null,
            parentSessionId: header.parentSession ?? null,
            origin: header.origin ?? null,
            updatedAt: header.createdAt ?? null,
            state: agent?.status === 'running' ? 'RUNNING' : 'IDLE',
            quietSec: null,
            goal: null,
            source: 'api:sessionQuery.listSessions',
          })
        }
        const selected = filterAndSort(rows, args)
        return enrich ? enrichDisk(selected, (row, disk) => row.title ?? titleText(disk?.title ?? null)) : selected
      }

      warnings.push('sessionController.list 与 sessionQuery.listSessions 都不可用，退回磁盘扫描')
      usedSource = 'disk:sessions'

      /**
       * 一行磁盘事实。`light` 先走投影缓存：能证明状态就不读日志尾巴。
       * 注意这里的 `state` / `title` / `goal` 因此有两个来源（投影或日志），`source` 字段会写出来。
       */
      const diskRow = (log) => {
        const summary = summarizeFromProjection(log) ?? summarizeFromDisk(log)
        return { ...summary, running: summary.state === 'RUNNING', agentAvailable: false, blank: null, updatedAt: log.mtimeMs, source: 'disk:sessions' }
      }
      /** 只靠目录元数据的一行。mtime 就是 `updatedAt`，够排序与裁剪，一个字节的日志都不用读。 */
      const metadataRow = (log) => ({
        sessionId: log.sessionId,
        title: null,
        workspace: log.workspace,
        running: false,
        agentAvailable: false,
        blank: null,
        updatedAt: log.mtimeMs,
        state: 'UNKNOWN',
        quietSec: Math.max(0, Math.round((Date.now() - log.mtimeMs) / 1000)),
        goal: null,
        source: 'disk:sessions',
      })

      const logs = listSessionLogs()
      // 两条路都可能走到这里，所以「先裁剪再读」这个优化不能无条件用：
      //   - `enrich: false` 的调用方要的正是「哪条在跑」，而「在跑」必须对每条会话都得出一个答案
      //     —— 不能只算要返回的几行；
      //   - 按 `workspace` 过滤时，工作区目录名是有损编码，真实 cwd 只在投影里 —— 也必须全量
      //     （元数据行的 workspace 只是目录名还原出来的显示值）。
      // 其余情况（默认的 `list`：workspace=all、要完整字段）可以只读要返回的那几行。
      //
      // 「全量」说的是**每条都要出一个结论**，不等于每条都要读日志：`diskRow` 先走投影缓存，
      // 投影能证明 `state` 就不解开日志尾巴。投影缺失时才退到整段读，所以这里不会因为
      // 「全量」再次变成 478 次 512KB 解码。
      const workspaceIsAll = args.workspace === undefined || args.workspace === 'all'
      if (args.enrich === false || !workspaceIsAll) {
        const all = logs.map(diskRow)
        void usedSource
        return filterAndSort(all, args)
      }

      const logsById = new Map(logs.map((log) => [log.sessionId, log]))
      const selected = filterAndSort(logs.map(metadataRow), args)
      void usedSource
      return selected.map((row) => diskRow(logsById.get(row.sessionId)))
    },

    /**
     * 一条会话的详情：头部 + 最近事件 + 状态。
     * @param {object} args - `{ sessionId, tail }`。
     * @returns {Promise<object>} 详情。
     */
    async getSession(args) {
      const warnings = []
      const state = await this.sessionState(args.sessionId)
      warnings.push(...(state.warnings ?? []))

      const query = get(ctx, 'sessionQuery')
      let header = state.live?.session === undefined ? null : { id: args.sessionId, cwd: state.live.cwd, createdAt: state.live.createdAt, agentPreset: state.live.agentPreset }
      let events = []

      const snapshot = await attempt('sessionQuery.readSession', warnings, () => (typeof query?.readSession === 'function' ? query.readSession(args.sessionId) : null))
      if (snapshot !== null && snapshot !== undefined) {
        header = snapshot.session ?? header
        events = Array.isArray(snapshot.events) ? snapshot.events : []
      } else {
        const entry = buildLogIndex().get(args.sessionId)
        if (entry !== undefined) {
          const log = readLog(entry.file)
          events = log.events
          if (header === null) {
            const first = events.find((event) => event.type === 'session')
            header = first ?? null
          }
        }
      }

      const tail = Math.max(1, Math.min(args.tail ?? 20, 200))
      const recent = events.slice(-tail).map(condenseEvent)
      const surface = await attempt('sessionQuery.readSurface', warnings, () => (typeof query?.readSurface === 'function' ? query.readSurface(args.sessionId) : null))
      const surfaceEvents = Array.isArray(surface?.events) ? surface.events : []
      const lastAssistant = [...surfaceEvents].reverse().find((event) => event.type === 'assistant/message') ?? [...events].reverse().find((event) => event.type === 'assistant/message') ?? null

      return {
        sessionId: args.sessionId,
        state: state.state,
        running: state.running,
        transport: state.transport,
        header,
        title: state.live?.title ?? state.projection?.title ?? null,
        goal: state.live?.goal ?? state.disk?.goal ?? null,
        usage: state.live?.usage ?? state.projection?.tokenUsage ?? null,
        contextPressure: state.projection?.contextPressure ?? null,
        lastAssistant: lastAssistant === null ? null : condenseEvent(lastAssistant),
        events: recent,
        eventCount: events.length,
        warnings,
      }
    },

    /**
     * 新建会话并投第一条消息——**路由**：先 GUI，失败退 API。
     *
     * 为什么 GUI 能排在前面而不是「只留给只有 GUI 才有的事」：DSH 桌面壳的「新会话」按钮
     * 走的是产品自己的建会话路径（点它等于人点了它），所以这条路造出来的会话和 API 造的
     * 是同一种东西，而不是一个冒牌货。代价是它需要有人看得见的窗口，并且会把窗口抢到前台。
     *
     * 两条路都是**全有或全无**：GUI 半路失败（窗口不在前台、会话没出现在列表里、第一条消息
     * 没送进去）就整条退掉，绝不出现「GUI 建了一半 + API 再建一条」的两条对话。
     * @param {object} args - `{ text, cwd, title, preset, via }`。
     * @returns {Promise<object>} 结果，带 `transport: "ui" | "api"` 与 `fallback` 说明。
     */
    async createSession(args) {
      const via = args.via ?? config.create.via
      if (via === 'api') return this.createSessionViaApi(args)

      const warnings = []
      const gui = await this.createSessionViaGui(args, warnings)
      if (gui.ok === true) return { ...gui, warnings: [...warnings, ...(gui.warnings ?? [])] }

      if (via === 'gui') {
        throw new Error(`GUI 新建会话失败（已按 config.create.via="gui" 禁止回退到 API）：${gui.reason}`)
      }
      const viaApi = await this.createSessionViaApi(args)
      return {
        ...viaApi,
        fallback: { from: 'ui', reason: gui.reason, guiEvidence: gui.evidence ?? null },
        warnings: [...warnings, `GUI 新建会话失败，已退回 API：${gui.reason}`, ...(viaApi.warnings ?? [])],
      }
    },

    /**
     * GUI 路：点 DSH 自己的「新会话」，等它出现在会话列表里，再把第一条消息送进输入框。
     *
     * 检测用的是**集合差**（点之前有哪些会话 id，点之后多了哪一个），不是「找一条空会话」：
     * 列表里有历史遗留的空会话是常态，靠 `blank` 认领会认错人。检测走 `listSessions`，
     * 所以列表本身不可用时这条路直接失败并说明原因——而不是假装成功。
     * @param {object} args - `{ text, cwd, title, preset }`。
     * @param {string[]} warnings - 警告收集器。
     * @returns {Promise<object>} `{ ok, reason, evidence, sessionId? }`。
     */
    async createSessionViaGui(args, warnings) {
      if (process.platform !== 'win32') {
        return { ok: false, reason: `桌面通道只在 Windows 上可用（当前平台 ${process.platform}）` }
      }
      const window = await attempt('ui.window', warnings, () => desktop('window', {}, config, { timeoutMs: 20_000 }))
      if (window === null || window?.ok !== true || window?.target === undefined) {
        return { ok: false, reason: `找不到可操作的 DSH 窗口（${window?.reason ?? 'window 动作没有返回目标'}）`, evidence: { window } }
      }

      const before = await attempt('listSessions(before)', warnings, () => this.listSessions({ workspace: 'all', limit: 500, enrich: false }))
      if (!Array.isArray(before)) {
        return { ok: false, reason: '会话列表读不出来，无法确认 GUI 是否真的建了会话' }
      }
      const known = new Set(before.map((row) => row.sessionId))

      const click = await attempt('ui.new-session', warnings, () => desktop('new-session', {
        newSessionX: config.create.newSessionX,
        newSessionY: config.create.newSessionY,
        settleMs: config.create.settleMs,
      }, config, { timeoutMs: config.create.clickTimeoutMs }))
      if (click === null || click?.ok !== true) {
        return { ok: false, reason: `点击「新会话」失败：${click?.reason ?? '脚本没有返回结果'}`, evidence: { click } }
      }

      const detected = await this.waitForNewSession(known, config.create.waitMs, warnings)
      if (detected === null) {
        return {
          ok: false,
          reason: `点了「新会话」，但 ${config.create.waitMs}ms 内没有新会话出现在列表里`,
          evidence: { click, sessionsBefore: before.length },
        }
      }

      // 会话已经在屏幕上了。第一条消息仍然按 `submitInGui` 决定走哪条路：GUI 送字依赖
      // 真实键盘注入，送不进去就交给 API，而不是把一条空会话留给用户。
      const warningsFromApi = []
      let submitted = { transport: 'api', delivered: false }
      if (config.create.submitInGui) {
        const type = await attempt('ui.new-session(submit)', warningsFromApi, () => desktop('new-session', {
          newSessionX: config.create.newSessionX,
          newSessionY: config.create.newSessionY,
          composerX: config.create.composerX,
          composerY: config.create.composerY,
          settleMs: config.create.settleMs,
          text: args.text,
          submit: true,
        }, config, { timeoutMs: config.create.clickTimeoutMs + args.text.length * 20 + 4000 }))
        if (type?.ok === true && type?.submitted === true) submitted = { transport: 'ui', delivered: true, method: type.method, sentChars: type.sentChars }
        else warningsFromApi.push(`GUI 送字失败，已改用 API 投递第一条消息：${type?.reason ?? '脚本没有返回结果'}`)
      }
      if (submitted.delivered !== true) {
        const delivered = await this.deliverFirstMessage(detected.sessionId, args.text, warningsFromApi)
        if (delivered !== true) {
          return {
            ok: false,
            reason: `会话已在 GUI 中建立（${detected.sessionId}），但第一条消息没能投递`,
            evidence: { sessionId: detected.sessionId, click },
          }
        }
        // 走到这里消息是真的投出去了，而投递的那条路是 API，不是 GUI。
        submitted = { transport: 'api', delivered: true }
      }

      const titleResult = args.title === undefined ? null : await attempt('rename(gui-created)', warningsFromApi, () => this.renameSession({ sessionId: detected.sessionId, title: args.title }))
      const cwdResult = args.cwd === undefined ? null : await attempt('workspaceRegistry.attach(gui-created)', warningsFromApi, async () => {
        const workspaces = get(ctx, 'workspaceRegistry')
        if (typeof workspaces?.create !== 'function') return null
        const workspace = await workspaces.create(args.cwd)
        return workspace.attachSession(detected.sessionId)
      })

      return {
        ok: true,
        transport: 'ui',
        sessionId: detected.sessionId,
        cwd: detected.cwd ?? args.cwd ?? null,
        title: args.title ?? null,
        firstMessage: submitted.delivered === true ? submitted.transport : 'none',
        detectedBy: detected.detectedBy,
        waitedMs: detected.waitedMs,
        evidence: { click: { newSessionX: click.newSessionX, newSessionY: click.newSessionY, pointerRestored: click.pointerRestored }, sessionsBefore: before.length, title: titleResult, cwd: cwdResult },
        warnings: warningsFromApi,
      }
    },

    /**
     * 等一条新会话出现在列表里。返回它，或者超时返回 null。
     * @param {Set<string>} known - 点之前已知的会话 id。
     * @param {number} waitMs - 上限。
     * @param {string[]} warnings - 警告收集器。
     * @returns {Promise<object|null>} `{ sessionId, cwd, detectedBy, waitedMs }`。
     */
    async waitForNewSession(known, waitMs, warnings) {
      const started = Date.now()
      const deadline = started + Math.max(1, waitMs)
      let rounds = 0
      let diskSweep = false
      while (Date.now() < deadline) {
        rounds += 1
        await new Promise((resolve) => setTimeout(resolve, 250))
        const rows = await attempt('listSessions(gui-watch)', warnings, () => this.listSessions({ workspace: 'all', limit: 500, enrich: false }))
        if (Array.isArray(rows)) {
          const fresh = rows.filter((row) => !known.has(row.sessionId))
          if (fresh.length > 0) {
            // 多了不止一条就说清楚取了哪条：按最近活动排，就是刚点出来的那条。
            const chosen = fresh[0]
            return { sessionId: chosen.sessionId, cwd: chosen.workspace ?? null, detectedBy: 'list-diff', waitedMs: Date.now() - started, rounds, extraNewSessions: fresh.length - 1 }
          }
        } else if (!diskSweep) {
          // 列表读不出来时退到磁盘事实：新会话目录会先出现在 ~/.dsh/sessions 下。
          diskSweep = true
          const found = await this.waitForNewSessionDirectory(known, Math.max(1000, deadline - Date.now()))
          if (found !== null) return { ...found, detectedBy: 'disk-directory', waitedMs: Date.now() - started, rounds }
          return null
        }
      }
      return null
    },

    /**
     * 磁盘兜底：轮询 `~/.dsh/sessions` 找一个新的会话目录。
     * @param {Set<string>} known - 已知会话 id。
     * @param {number} budgetMs - 还能等多久。
     * @returns {Promise<object|null>} 找到的会话，或 null。
     */
    async waitForNewSessionDirectory(known, budgetMs) {
      const deadline = Date.now() + budgetMs
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 300))
        try {
          const fresh = listSessionLogs().filter((entry) => !known.has(entry.sessionId))
          if (fresh.length > 0) return { sessionId: fresh[0].sessionId, cwd: null }
        } catch { /* 读不到就继续等 */ }
      }
      return null
    },

    /**
     * 把第一条消息投进一条已经存在的会话（GUI 建出来、API 接手的那一步）。
     * @param {string} sessionId - 目标会话。
     * @param {string} text - 消息正文。
     * @param {string[]} warnings - 警告收集器。
     * @returns {Promise<boolean>} 投出去了就是 true。
     */
    async deliverFirstMessage(sessionId, text, warnings) {
      const controller = get(ctx, 'sessionController')
      const resolved = await attempt('sessionController.resolveAgent(gui-created)', warnings, () => (typeof controller?.resolveAgent === 'function' ? controller.resolveAgent(sessionId) : null))
      const agent = resolved?.agent ?? null
      if (agent === null || typeof agent.followup !== 'function') {
        warnings.push(`会话 ${sessionId} 拿不到可投递的 agent`)
        return false
      }
      agent.followup(userMessage(text))
      await attempt('sessions.flush(gui-created)', warnings, () => get(ctx, 'sessions')?.flush?.(agent.session) ?? null)
      return true
    },

    /**
     * API 路：`sessionController.create()`（产品自己的路径）+ `resolveAgent().agent.followup()`；
     * 服务缺席时退回 `agents.create()`（`dsh-mail-notify` 用的就是后者）。
     * @param {object} args - `{ text, cwd, title, preset, provider, model, sessionId }`。
     * @returns {Promise<object>} 结果。
     */
    async createSessionViaApi(args) {
      const warnings = []
      const controller = get(ctx, 'sessionController')
      const agents = get(ctx, 'agents')
      const sessionId = args.sessionId ?? `session-${randomUUID()}`
      const cwd = args.cwd
      let created = null

      if (typeof controller?.create === 'function') {
        created = await controller.create({
          sessionId: args.sessionId ?? undefined,
          cwd: args.sessionId === undefined ? cwd : undefined,
          ...(args.preset === undefined ? {} : { agentPreset: args.preset }),
        })
      } else if (typeof agents?.create === 'function') {
        const registry = get(ctx, 'agentPresets')
        const preset = registry === undefined ? null : await attempt('agentPresets.resolve', warnings, () => registry.resolve?.() ?? null)
        const selection = get(ctx, 'agentDefaultModel')?.currentSelection?.() ?? null
        const handle = await agents.create({
          sessionId,
          meta: { cwd, ...(preset === null ? {} : { agentPreset: preset.id }) },
          ...(selection === null ? {} : { agentOptions: selection }),
          ...(preset === null || registry === undefined ? {} : { setup: async (agentCtx) => { await registry.mount(agentCtx, preset.id) } }),
        })
        created = { sessionId: handle?.agent?.session?.id ?? sessionId, handle }
      } else {
        throw new Error('宿主没有 sessionController.create，也没有 agents.create —— 无法新建会话')
      }

      const targetId = created?.sessionId ?? sessionId
      const workspaces = get(ctx, 'workspaceRegistry')
      if (cwd !== undefined && typeof workspaces?.create === 'function') {
        await attempt('workspaceRegistry.create', warnings, async () => {
          const workspace = await workspaces.create(cwd)
          await workspace.attachSession(targetId)
        })
      }
      if (args.title !== undefined && created?.handle !== undefined) {
        // `agents.create` 那条路直接给 handle；`sessionController.create` 不返回它，
        // 那种情况的改名在下面 agent 到手之后补。
        await attempt('sessionTitle.rename', warnings, () => get(ctx, 'sessionTitle')?.rename?.(created.handle.agent.session, args.title))
      }

      const resolved = await attempt('sessionController.resolveAgent', warnings, () => (typeof controller?.resolveAgent === 'function' ? controller.resolveAgent(targetId) : created?.handle ?? null))
      const agent = resolved?.agent ?? (typeof resolved?.followup === 'function' ? resolved : null)
      if (agent === null || typeof agent?.followup !== 'function') {
        throw new Error(`会话 ${targetId} 已创建，但拿不到可投递的 agent（resolveAgent 没有返回 agent）`)
      }
      // 改名必须拿 Session 对象，不能拿会话 id 字符串：`sessionTitle.rename(session, title)`
      // 对着字符串会报 `session "undefined" is not live in this store`（实测）。
      if (args.title !== undefined && created?.handle === undefined) {
        await attempt('sessionTitle.rename', warnings, () => get(ctx, 'sessionTitle')?.rename?.(agent.session, args.title))
      }

      agent.followup(userMessage(args.text))
      const flushed = await attempt('sessions.flush', warnings, () => get(ctx, 'sessions')?.flush?.(agent.session) ?? null)

      return { transport: 'api', sessionId: targetId, cwd: agent.session?.header?.cwd ?? cwd ?? null, preset: created?.agentPreset ?? null, flushed, warnings }
    },

    /**
     * 往已有会话投一条消息。
     * @param {object} args - `{ sessionId, text, mode }`。
     * @returns {Promise<object>} 结果。
     */
    async sendToSession(args) {
      const warnings = []
      const controller = get(ctx, 'sessionController')
      if (typeof controller?.resolveAgent !== 'function') throw new Error('宿主没有 sessionController.resolveAgent —— 无法把消息投进已有会话')

      const resolved = await controller.resolveAgent(args.sessionId)
      if (resolved?.error !== undefined) throw new Error(`打开会话 ${args.sessionId} 失败：${resolved.error?.message ?? JSON.stringify(resolved.error)}`)
      const agent = resolved?.agent ?? (typeof resolved?.followup === 'function' ? resolved : null)
      if (agent === null || typeof agent.followup !== 'function') throw new Error(`打开会话 ${args.sessionId} 失败：resolveAgent 没有返回可用的 agent`)

      const mode = args.mode ?? 'followup'
      const message = userMessage(args.text)
      if (mode === 'steer') agent.steer(message)
      else if (mode === 'inject') agent.inject(message)
      else agent.followup(message)

      const flushed = await attempt('sessions.flush', warnings, () => get(ctx, 'sessions')?.flush?.(agent.session) ?? null)
      return { transport: 'api', sessionId: args.sessionId, mode, flushed, status: agent.status ?? null, warnings }
    },

    /**
     * 中止一条会话当前的活动。
     * @param {object} args - `{ sessionId, keepInbox }`。
     * @returns {Promise<object>} 结果。
     */
    async abortSession(args) {
      const warnings = []
      const agents = get(ctx, 'agents')
      let agent = await attempt('agents.get', warnings, () => (typeof agents?.get === 'function' ? agents.get(args.sessionId) : null))
      if (agent === null || agent === undefined) {
        const controller = get(ctx, 'sessionController')
        const resolved = await attempt('sessionController.resolveAgent', warnings, () => (typeof controller?.resolveAgent === 'function' ? controller.resolveAgent(args.sessionId) : null))
        agent = resolved?.agent ?? null
      }
      if (agent === null || agent === undefined) throw new Error(`会话 ${args.sessionId} 没有 live agent，没有可中止的回合`)
      if (args.keepInbox === true) agent.cancel({ kind: 'user' }, { keepInbox: true })
      else agent.cancel({ kind: 'user' })
      return { transport: 'api', sessionId: args.sessionId, keepInbox: args.keepInbox === true, status: agent.status ?? null, warnings }
    },

    /**
     * 等到一条会话空闲，或超时。
     * @param {object} args - `{ sessionId, timeoutMs }`。
     * @returns {Promise<object>} 结果；超时是结果不是异常。
     */
    async waitIdle(args) {
      const warnings = []
      const timeoutMs = args.timeoutMs ?? config.api.defaultWaitMs
      const agents = get(ctx, 'agents')
      const agent = await attempt('agents.get', warnings, () => (typeof agents?.get === 'function' ? agents.get(args.sessionId) : null))
      if (agent === null || agent === undefined) return { transport: 'api', sessionId: args.sessionId, state: 'not-live', waitedMs: 0, reason: 'no-live-agent', warnings }

      const started = Date.now()
      if (agent.status !== 'running') return { transport: 'api', sessionId: args.sessionId, state: 'IDLE', waitedMs: 0, reason: 'already-idle', warnings }

      let timer = null
      const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs) })
      const settled = await Promise.race([
        Promise.resolve(agent.whenIdle?.()).then(() => 'idle').catch((error) => { warnings.push(`whenIdle: ${error instanceof Error ? error.message : String(error)}`); return 'error' }),
        timeout,
      ])
      if (timer !== null) clearTimeout(timer)

      return {
        transport: 'api',
        sessionId: args.sessionId,
        state: settled === 'idle' ? 'IDLE' : agent.status === 'running' ? 'RUNNING' : 'UNKNOWN',
        waitedMs: Date.now() - started,
        reason: settled,
        warnings,
      }
    },

    /**
     * 现在真的在跑的会话。
     *
     * 「在跑」取宿主自己的口径（`sessionController.list()` 的 `running`），不是磁盘回溯：
     * 磁盘上「回合没闭合」也可能是上次崩溃留下的，拿它去停止或恢复会认错人。走磁盘回退时
     * 结果里带 `staleRisk: true`，把这件事说出来而不是假装一样准。
     * @param {object} args - `{ limit }`。
     * @returns {Promise<object>} `{ rows, scanned, source, staleRisk, warnings }`。
     */
    async listRunningSessions() {
      const warnings = []
      // 500 是 `listSessions` 自己的列取上限（`filterAndSort` 里钉死的）。正在跑的会话每一步都在写日志，
      // 按最近活动排序时排在最前面；但「撞到上限」这件事必须说出来——悄悄少停一条会话，
      // 比明确报一条警告糟得多。
      const SCAN_LIMIT = 500
      // `enrich: false`：「谁在跑」取的是 API 的 `running`，磁盘状态在这里只用来判 `staleRisk`，
      // 而那是 API 缺席时才有的情况（那时走的是磁盘回退分支，本来就带磁盘字段）。
      const rows = await this.listSessions({ workspace: 'all', limit: SCAN_LIMIT, enrich: false }, warnings)
      const running = rows.filter((row) => row.running === true)
      const source = rows[0]?.source ?? 'none'
      const truncated = rows.length >= SCAN_LIMIT
      if (truncated) warnings.push(`会话列取到 ${SCAN_LIMIT} 条就是上限了：可能有正在跑的会话没进扫描范围`)
      return { rows: running, scanned: rows.length, source, staleRisk: source === 'disk:sessions', truncated, warnings }
    },

    /**
     * 立即中止所有正在跑的回合——**除了调用者自己那条**。
     *
     * 为什么排除调用者：`pause-all` 十有八九是某个 agent 在它自己那一轮里调的，而
     * `agent.cancel()` 会把这一轮一起中止，工具结果就再也送不回去了。所以调用者的那一轮
     * 留在 `deferred` 里，由调用方决定（`restartHost` 会在请求退出的那一刻收掉它）。
     * @param {object} args - `{ keepInbox, callerSessionId, snapshot }`。
     * @returns {Promise<object>} `{ requested, cancelled, failed, deferred, warnings }`。
     */
    async pauseAll(args = {}) {
      // `snapshot` 让调用方复用已经取过的那一份。`restartHost` 就靠它避免在同一次调用里扫两遍
      // 「谁在跑」——那一步曾经是分钟级的（478 条会话逐条重折日志，实测 255.7–320.7s），
      // 扫两遍就是把这个代价翻倍，也把「卡在半路」的机会翻倍。
      const snapshot = Array.isArray(args.snapshot?.rows) ? args.snapshot : await this.listRunningSessions()
      const callerSessionId = typeof args.callerSessionId === 'string' && args.callerSessionId !== '' ? args.callerSessionId : null
      const cancelled = []
      const failed = []
      const deferred = []

      for (const row of snapshot.rows) {
        const entry = { sessionId: row.sessionId, title: row.title ?? null, workspace: row.workspace ?? null }
        if (callerSessionId !== null && row.sessionId === callerSessionId) {
          deferred.push({ ...entry, reason: '这是发起调用的那条会话：中止它会把本次工具结果一起带走' })
          continue
        }
        try {
          const result = await this.abortSession({ sessionId: row.sessionId, keepInbox: args.keepInbox === true })
          cancelled.push({ ...entry, status: result.status ?? null })
        } catch (error) {
          failed.push({ ...entry, error: error instanceof Error ? error.message : String(error) })
        }
      }

      return {
        transport: 'api',
        requested: snapshot.rows.length,
        cancelled,
        failed,
        deferred,
        keepInbox: args.keepInbox === true,
        source: snapshot.source,
        staleRisk: snapshot.staleRisk,
        warnings: snapshot.warnings,
      }
    },

    /**
     * 停止所有在跑的会话 → 落盘恢复计划 → 起分离看门狗 → 延迟请求关停 → 由看门狗重新拉起应用。
     *
     * 顺序是刻意的，每一步都为了「退出去还回得来」：
     *   - 先证明桌面壳找得到（`probeShell`），否则直接拒绝，绝不先退出去再说；
     *   - 在干最重的那一步（快照）**之前**先把一份 `arming` 计划落盘，这样「按了重启但没反应」
     *     在盘上留下痕迹，而不是无从查起（见下面的注释）；
     *   - 再快照「谁在跑」，因为重启后要靠这份名单继续它们；
     *   - 计划**先落盘**：退出之后没有任何代码能补写；
     *   - 看门狗**先起来**：它起不来就不请求退出（宁可重启不发生，也不要退出去回不来）；
     *   - 退出是**延迟**的，否则本次工具结果会跟着这一轮一起消失。
     *
     * **重启是「进程外交接」的，不是 Host 自己关停。** 实测：`ctx.appExit` 只关 Host（启动器
     * `exit: code => void shutdown.shutdown(code)`），桌面壳留下一个没有后端的窗口——「重连中」；
     * 而关掉主窗口这个应用也不一定退（实测进程树活了 90 秒以上）。所以真正让应用消失的是进程外那个
     * 延时脚本：先给 `killAfterSeconds` 秒优雅退出的机会，到点收掉整棵树，再拉起 exe。
     * 插件这一侧只负责「计划落盘、会话停好、脚本起来」——三件都不依赖应用能不能优雅退出。
     *
     * 调用者自己那条会话不在立即停止之列，而是在交接前一刻收掉（见 `pauseAll`）。
     * @param {object} args - `{ keepInbox, text, delaySeconds, dryRun, sessionIds, callerSessionId, reason }`。
     * @returns {Promise<object>} 计划与证据；`dryRun: true` 时只快照、不碰任何状态。
     */
    async restartHost(args = {}) {
      const warnings = []
      const nowMs = clock()
      const dryRun = args.dryRun === true
      const keepInbox = args.keepInbox ?? config.restart.keepInbox

      // 1. 先证伪：找不到桌面壳就什么都不做。
      //
      // **不再要求 `ctx.appExit`**：实测它是 Host 自己的关停（启动器 `exit: code => void
      // shutdown.shutdown(code)`），桌面应用根本不会跟着退——壳留下一个没有后端的窗口，也就是
      // 「重连中」那一屏。这条路已经废掉，退出交给进程外的延时脚本。
      const shell = await probeShell()
      if (shell?.ok !== true) {
        throw new Error(`看不到可以重新拉起的桌面壳：${shell?.reason ?? '壳探测没有返回结果'}。headless 的 dsh 请自己重启进程，插件不猜。`)
      }

      const callerSessionId = typeof args.callerSessionId === 'string' && args.callerSessionId !== '' ? args.callerSessionId : null
      const delaySeconds = Number.isFinite(args.delaySeconds) && args.delaySeconds > 0 ? args.delaySeconds : config.restart.delaySeconds
      const resumeText = typeof args.text === 'string' && args.text.trim() !== '' ? args.text : config.restart.resumeText

      const plan = {
        version: PLAN_VERSION,
        id: `restart-${randomUUID()}`,
        createdAt: new Date(nowMs).toISOString(),
        createdAtMs: nowMs,
        state: dryRun ? 'dry-run' : 'arming',
        reason: typeof args.reason === 'string' && args.reason !== '' ? args.reason : 'dsh_host {action:"restart"}',
        writer: hostIdentity(),
        // 两个 pid 都要记：`hostPid`（本进程——`appExit` 关的就是它）与 `shellPid`（桌面壳——它不会
        // 跟着退，得由看门狗请它关窗、不行再强杀）。只记壳 pid 的早期版本让看门狗等错了对象。
        shell: { shellPid: shell.shellPid, hostPid: shell.hostPid, exe: shell.exe, commandLine: shell.commandLine ?? null, evidence: shell.evidence ?? null },
        stop: { keepInbox, requested: 0, cancelled: [], failed: [], deferred: [] },
        resume: { text: resumeText, max: config.restart.maxResume },
        sessions: [],
        outcomes: [],
        resumedAt: null,
        resumedBy: null,
      }

      // 2. 先落痕迹，再干最重的那一步。
      //
      // 快照要列全部会话，而它曾经是分钟级的：一次调用里逐条重折 478 份日志（实测 255.7s /
      // 293.9s / 320.7s）。那次 `restart` 就停在第二步——没有错误、没有结果，盘上连状态目录
      // 都没有，事后只能从会话日志里把它挖出来。所以现在先写一份 `arming`：只要
      // `dsh_host {action:"status"}` 看到它，答案就是「有人按过重启、卡在快照」。
      //
      // `arming` **不是可恢复状态**：没有证据表明重启真的发生过，所以恢复腿不会拿它去投消息
      // （见 `resumeAfterRestart`）；超过 `planTtlSeconds` 它自己会变成 `expired`。
      // `dryRun` 保持纯净：它不写任何文件。
      if (!dryRun) savePlan(plan)

      // 3. 快照：重启后要继续的就是这份名单。
      const snapshot = await this.listRunningSessions()
      const byId = new Map(snapshot.rows.map((row) => [row.sessionId, row]))
      const plannedIds = Array.isArray(args.sessionIds) && args.sessionIds.length > 0
        ? args.sessionIds.filter((id) => typeof id === 'string' && id !== '')
        : snapshot.rows.map((row) => row.sessionId)
      const sessions = plannedIds.map((sessionId) => ({
        sessionId,
        title: byId.get(sessionId)?.title ?? null,
        workspace: byId.get(sessionId)?.workspace ?? null,
        wasRunning: byId.has(sessionId),
      }))
      plan.sessions = sessions
      plan.stop.requested = snapshot.rows.length

      if (dryRun) {
        return {
          transport: 'api',
          dryRun: true,
          planPath: planPath(),
          shell: plan.shell,
          wouldStop: snapshot.rows.map((row) => ({ sessionId: row.sessionId, title: row.title ?? null })),
          wouldResume: sessions,
          resumeText,
          delaySeconds,
          warnings: [...warnings, ...snapshot.warnings],
        }
      }

      // 4. 计划成型：从这一刻起它是一份「已落盘、等退出」的计划。
      plan.state = 'armed'
      savePlan(plan)

      // 5. 立即停止（调用者除外）。用同一份快照，不再扫第二遍。
      const stopped = await this.pauseAll({ keepInbox, callerSessionId, snapshot })
      plan.stop.cancelled = stopped.cancelled
      plan.stop.failed = stopped.failed
      plan.stop.deferred = stopped.deferred
      plan.stop.source = stopped.source
      warnings.push(...stopped.warnings)

      // 6. 停止结果落盘：退出之后没人能补写。
      savePlan(plan)

      // 7. 延时脚本：起不来就绝不动这个应用（宁可重启没发生，也不要关了回不来）。
      //
      // 它的**强杀宽限**现在要把优雅退出那一腿的时间加进去：第 8 步会先去点托盘菜单里的「退出」，
      // 那一次搜索实测要 20–30 秒（折叠区四个图标、每个悬停读 tooltip、读不出就开菜单），而看门狗
      // 的默认宽限只有 10 秒——不加起来，看门狗会在点击落地之前就把进程树收掉，「优雅」就成了一句空话。
      const gracefulSpec = config.restart.gracefulQuit
        ? {
            iconName: iconNameFromExe(shell.exe),
            item: config.restart.gracefulQuitItem,
            budgetMs: config.restart.gracefulQuitBudgetMs,
            language: config.restart.gracefulQuitLanguage,
          }
        : null
      const killAfterSeconds = gracefulSpec === null
        ? config.restart.killAfterSeconds
        : watcherGraceSeconds(gracefulSpec.budgetMs, config.restart.killAfterSeconds)
      let relauncher
      try {
        relauncher = await startRelauncher({
          shellPid: shell.shellPid,
          hostPid: shell.hostPid,
          exe: shell.exe,
          waitSeconds: config.restart.waitSeconds,
          settleMs: config.restart.settleMs,
          killAfterSeconds,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        plan.state = 'failed'
        plan.failure = `延时脚本起不来：${message}`
        savePlan(plan)
        throw new Error(`延时脚本起不来，已取消重启（会话已经停了，但 DSH 还在跑）：${message}`)
      }
      // `method` 是证据的一部分：`wmi` = 新进程挂在 WmiPrvSE 下、不在 DSH 的进程树里；
      // `detached` = 只是分离的子进程（壳若用 kill-on-close 的 Job Object，它会跟着走）。
      plan.watcher = {
        pid: relauncher.pid ?? null,
        method: relauncher.method ?? null,
        shell: relauncher.shell ?? null,
        logPath: relauncher.logPath,
        script: relauncher.script,
        attempts: relauncher.attempts ?? [],
      }
      savePlan(plan)

      // 8. 延迟收尾：先让本次工具结果送达，再收掉调用者那一轮，然后**请应用自己退出**。
      //
      // **这里不请求 appExit。** 实测它只关 Host：壳留下一个没有后端窗口（「重连中」）。真正让应用
      // 退出的是两条路，按顺序：
      //
      //   1. **优雅退出**（`quitViaTray`）：右键应用自己的托盘图标，点菜单里的「退出」——就是用户
      //      手工做的那件事。它由 `dsh-computer-use` 的托盘能力完成，只看像素，不依赖无障碍接口。
      //      成不成都会把结论写进计划（成功那一次往往写不完最后一句，因为应用正在退出；看门狗日志
      //      才是那一刻的权威记录）。
      //   2. **收进程树**：看门狗那一侧的兜底，宽限已经加上这一腿的预算。它一条都不是「优雅」，
      //      但它是唯一被证明一定发生的机制——所以它留着，而且是默认结局。
      //
      // 顺序是先收调用者那一轮，再写「已交接」，最后才点退出：那一下之后应用随时会消失，盘子上的
      // 东西必须先写完。
      const delayMs = Math.max(1, delaySeconds) * 1000
      plan.exit = {
        delaySeconds,
        scheduledAt: new Date(clock()).toISOString(),
        graceful: gracefulSpec === null
          ? { enabled: false, reason: 'config.restart.gracefulQuit = false：直接交给看门狗收树' }
          : { enabled: true, iconName: gracefulSpec.iconName, item: gracefulSpec.item, budgetMs: gracefulSpec.budgetMs, killAfterSeconds },
      }
      savePlan(plan)
      later(() => {
        void (async () => {
          if (callerSessionId !== null) {
            try { await this.abortSession({ sessionId: callerSessionId, keepInbox }) } catch { /* 退出在即，收不掉也照样退 */ }
          }
          // 记录「交接完成」：否则事后分不清「没走到这一步」和「交接了但没人响应」。
          plan.exit.handedOffAt = new Date(clock()).toISOString()
          try { savePlan(plan) } catch { /* 写不动就只剩日志 */ }
          if (gracefulSpec === null) return
          // 这一腿自己绝不抛错：它失败时要做的事，与它不存在时完全相同——等看门狗。
          const outcome = await gracefulQuit({
            ...gracefulSpec,
            scratchDir: config.restart.gracefulQuitScratchDir,
          })
          plan.exit.graceful = { ...plan.exit.graceful, ...outcome }
          plan.exit.gracefulFinishedAt = new Date(clock()).toISOString()
          try { savePlan(plan) } catch { /* 应用可能已经在退出了，写不动是正常的 */ }
        })()
      }, delayMs)

      return {
        transport: 'api',
        restartId: plan.id,
        planPath: planPath(),
        shell: plan.shell,
        watcher: plan.watcher,
        stopped: { requested: plan.stop.requested, cancelled: plan.stop.cancelled.length, failed: plan.stop.failed.length, deferred: plan.stop.deferred.length, detail: plan.stop },
        willResume: sessions,
        resumeText,
        exitInSeconds: delaySeconds,
        gracefulExit: plan.exit.graceful,
        note: gracefulSpec === null
          ? `进程外的延时脚本（pid ${plan.watcher.pid ?? '?'}）在等应用整棵树退出：先给 ${killAfterSeconds} 秒优雅退出的机会，到点收掉整棵树，然后拉起 exe。约 ${delaySeconds} 秒后应用会被重启，重启后插件按计划把这些会话继续起来。`
          : `约 ${delaySeconds} 秒后，本插件会先点应用自己托盘菜单里的「${gracefulSpec.item}」（就是用户手工做的那件事），请它自己退出；`
            + `成不成都不影响结局——进程外的延时脚本（pid ${plan.watcher.pid ?? '?'}）在等整棵树走干净，到点（${killAfterSeconds} 秒，已含优雅退出的预算）收掉它并拉起 exe。`
            + '重启后插件按计划把这些会话继续起来。',
        warnings,
      }
    },

    /**
     * 上次重启计划的状态、看门狗日志，以及「这份计划是不是当前这个进程写的」。
     * @returns {Promise<object>} 状态；没有计划时说清楚没有，而不是编一个。
     */
    async restartStatus() {
      const { plan, path, error } = loadPlan()
      const watcherLog = readLogTail(watcherLogPath(), 12)
      const current = hostIdentity()
      if (plan === null) {
        return { transport: 'disk', planPath: path, plan: null, planError: error, watcherLog, currentHost: current, note: '没有重启计划：这个进程不是被 dsh_host 重启起来的（或计划已被清掉）' }
      }
      const ageSeconds = Math.round((clock() - (plan.createdAtMs ?? 0)) / 1000)
      return {
        transport: 'disk',
        planPath: path,
        plan: {
          id: plan.id ?? null,
          state: plan.state ?? null,
          createdAt: plan.createdAt ?? null,
          ageSeconds,
          reason: plan.reason ?? null,
          shell: plan.shell ?? null,
          watcher: plan.watcher ?? null,
          exit: plan.exit ?? null,
          stop: {
            requested: plan.stop?.requested ?? 0,
            cancelled: plan.stop?.cancelled?.length ?? 0,
            failed: plan.stop?.failed?.length ?? 0,
            deferred: plan.stop?.deferred ?? [],
          },
          resume: plan.resume ?? null,
          sessions: plan.sessions ?? [],
          outcomes: plan.outcomes ?? [],
          resumedAt: plan.resumedAt ?? null,
          failure: plan.failure ?? null,
        },
        belongsToCurrentBoot: sameBoot(plan.writer, current),
        watcherLog,
        currentHost: current,
        // `arming` 是唯一一种「按了重启但什么都没发生」的形态，值得直说：它意味着协调器停在
        // 快照那一步，既没落盘会话名单，也没起看门狗，也没请求退出。旧版本的这一步是分钟级的。
        ...(plan.state === 'arming'
          ? { note: `上一次重启停在快照阶段（${ageSeconds}s 前落盘，state=arming）：没有会话名单、没有看门狗、也没有请求退出——DSH 一直在跑。这就是「restart 没反应」的样子；重试即可，超过 ${config.restart.planTtlSeconds}s 它自己会变成 expired。` }
          : {}),
      }
    },

    /**
     * 重启后的恢复腿：按计划把重启前在跑的会话重新驱动起来。
     *
     * 只有「计划是**别的**进程写的」才会真的投递：同一个进程里的插件重载不该把消息再投一遍。
     * 投递前先把状态改成 `claimed` 落盘，所以即使中途崩了也不会重复投递。
     * @param {object} args - `{ sessionIds, text, max, force }`。
     * @returns {Promise<object>} 恢复结果；服务还没起来时返回 `state: "services-not-ready"` 让调用方重试。
     */
    async resumeAfterRestart(args = {}) {
      const current = hostIdentity()
      const { plan, path, error } = loadPlan()
      if (plan === null) return { transport: 'disk', state: 'no-plan', planPath: path, planError: error, currentHost: current }

      if (args.force !== true && sameBoot(plan.writer, current)) {
        return { transport: 'disk', state: 'same-boot', planPath: path, planState: plan.state ?? null, currentHost: current, reason: '这份计划是当前这个进程写的：退出还没发生（或插件被重载），不重复恢复；要强制执行用 force:true' }
      }
      if (plan.state === 'done') return { transport: 'disk', state: 'already-done', planPath: path, outcomes: plan.outcomes ?? [], resumedAt: plan.resumedAt ?? null }
      if (plan.state === 'expired') return { transport: 'disk', state: 'expired', planPath: path, failure: plan.failure ?? null }

      // `arming` = 上一次重启停在快照阶段：它**没有**请求过退出，所以没有任何理由认为那些会话
      // 被中断过。投递恢复消息会是凭空的打扰，所以这里只报事实；过期的 arming 自己收成 expired，
      // 免得盘上永远留着一份看不懂的中间态。
      if (plan.state === 'arming') {
        const armedAgeSeconds = (clock() - (plan.createdAtMs ?? 0)) / 1000
        if (armedAgeSeconds > config.restart.planTtlSeconds) {
          plan.state = 'expired'
          plan.failure = `计划停在快照阶段（没有请求退出），已过期：${Math.round(armedAgeSeconds)}s > ${config.restart.planTtlSeconds}s`
          savePlan(plan)
          return { transport: 'disk', state: 'expired', planPath: path, ageSeconds: Math.round(armedAgeSeconds), failure: plan.failure }
        }
        return {
          transport: 'disk',
          state: 'arming',
          planPath: path,
          ageSeconds: Math.round(armedAgeSeconds),
          reason: '这份计划停在快照阶段：没有落盘会话名单，也没有请求退出，因此没有证据表明会话被中断过——不投递恢复消息。用 dsh_host {action:"restart"} 重试即可。',
        }
      }

      if (plan.state !== 'armed' && plan.state !== 'claimed') {
        return { transport: 'disk', state: plan.state ?? 'unknown', planPath: path, failure: plan.failure ?? null, reason: `计划状态是 ${plan.state ?? '未知'}，不再恢复` }
      }

      const ageSeconds = (clock() - (plan.createdAtMs ?? 0)) / 1000
      if (ageSeconds > config.restart.planTtlSeconds) {
        plan.state = 'expired'
        plan.failure = `计划已过期：${Math.round(ageSeconds)}s > ${config.restart.planTtlSeconds}s`
        savePlan(plan)
        return { transport: 'disk', state: 'expired', planPath: path, ageSeconds: Math.round(ageSeconds), failure: plan.failure }
      }

      const controller = get(ctx, 'sessionController')
      if (typeof controller?.resolveAgent !== 'function') {
        return { transport: 'api', state: 'services-not-ready', planPath: path, reason: 'sessionController.resolveAgent 还没上线', retryable: true }
      }

      const planned = Array.isArray(plan.sessions) ? plan.sessions : []
      const requested = Array.isArray(args.sessionIds) && args.sessionIds.length > 0
        ? args.sessionIds.filter((id) => typeof id === 'string' && id !== '')
        : planned.map((entry) => entry.sessionId)
      const max = Number.isFinite(args.max) && args.max > 0 ? Math.round(args.max) : config.restart.maxResume
      const targets = requested.slice(0, max)
      const skipped = requested.slice(max)
      const text = typeof args.text === 'string' && args.text.trim() !== '' ? args.text : plan.resume?.text ?? config.restart.resumeText

      // 先记账再投递：投到一半崩了，重启也不该把已投的再投一遍。
      plan.state = 'claimed'
      plan.claimedAt = new Date(clock()).toISOString()
      plan.claimedBy = current
      savePlan(plan)

      const outcomes = []
      for (const sessionId of targets) {
        try {
          const result = await this.sendToSession({ sessionId, text, mode: 'followup' })
          outcomes.push({ sessionId, ok: true, transport: result.transport, flushed: result.flushed ?? null })
        } catch (error) {
          outcomes.push({ sessionId, ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      }

      const resumed = outcomes.filter((outcome) => outcome.ok).length
      const failed = outcomes.filter((outcome) => outcome.ok !== true)
      plan.outcomes = outcomes
      plan.resumedAt = new Date(clock()).toISOString()
      plan.resumedBy = current
      plan.state = failed.length === 0 ? 'done' : resumed === 0 ? 'failed' : 'partial'
      savePlan(plan)

      return {
        transport: 'api',
        state: plan.state,
        planPath: path,
        resumed,
        failed: failed.length,
        outcomes,
        requested: requested.length,
        skipped,
        text,
        currentHost: current,
        warnings: [],
      }
    },

    /**
     * 改会话标题。
     * @param {object} args - `{ sessionId, title }`。
     * @returns {Promise<object>} 结果。
     */
    async renameSession(args) {
      const warnings = []
      const agents = get(ctx, 'agents')
      let session = await attempt('agents.get', warnings, () => (typeof agents?.get === 'function' ? agents.get(args.sessionId)?.session : null))
      if (session === null || session === undefined) {
        session = await attempt('sessions.get', warnings, () => get(ctx, 'sessions')?.get?.(args.sessionId) ?? null)
      }
      if (session === null || session === undefined) {
        const controller = get(ctx, 'sessionController')
        const resolved = await attempt('sessionController.resolveAgent', warnings, () => (typeof controller?.resolveAgent === 'function' ? controller.resolveAgent(args.sessionId) : null))
        session = resolved?.agent?.session ?? null
      }
      const title = get(ctx, 'sessionTitle')
      if (session === null || session === undefined || typeof title?.rename !== 'function') {
        throw new Error(`会话 ${args.sessionId} 拿不到可改名的 session 对象（或 sessionTitle 服务缺席）`)
      }
      title.rename(session, args.title)
      return { transport: 'api', sessionId: args.sessionId, title: args.title, warnings }
    },

    /** 目标：需要 live agent。 */
    async goalOf(sessionId) {
      const warnings = []
      const state = await this.sessionState(sessionId)
      warnings.push(...(state.warnings ?? []))
      return { transport: state.transport, sessionId, goal: state.live?.goal ?? state.disk?.goal ?? null, warnings }
    },

    /** 后台任务。 */
    async jobsOf(sessionId) {
      const warnings = []
      const jobs = get(ctx, 'jobs')
      const list = await attempt('jobs.list', warnings, () => (typeof jobs?.list === 'function' ? jobs.list(sessionId) : null))
      return { transport: 'api', sessionId, jobs: Array.isArray(list) ? list.map((job) => ({ id: job.id, kind: job.kind, label: job.label, status: job.status, owner: job.owner ?? null, startedAt: job.startedAt ?? null, finishedAt: job.finishedAt ?? null })) : null, warnings }
    },

    /** 定时提醒。 */
    async schedulesOf(sessionId) {
      const warnings = []
      const schedule = get(ctx, 'schedule')
      const catalog = await attempt('schedule.catalog', warnings, () => (typeof schedule?.catalog === 'function' ? schedule.catalog() : null))
      const all = Array.isArray(catalog) ? catalog : Array.isArray(catalog?.tasks) ? catalog.tasks : null
      const filtered = all === null ? null : sessionId === undefined ? all : all.filter((task) => task.sessionId === sessionId)
      return { transport: 'api', sessionId: sessionId ?? null, schedules: filtered, warnings }
    },

    /** 插件行与 bundle。 */
    async plugins() {
      const warnings = []
      const manager = get(ctx, 'pluginManager')
      const commands = Object.fromEntries(
        ['listPlugins', 'listBundles', 'setPluginEnabled', 'setBundleEnabled', 'installBundle', 'removeBundle', 'inspect', 'registries']
          .map((name) => [name, typeof manager?.[name] === 'function']),
      )
      const inventory = await attempt('loader.entries', warnings, () => {
        const loader = get(ctx, 'loader')
        if (typeof loader?.entries !== 'function') return null
        return loader.entries().filter((entry) => entry?.options?.group !== true).map((entry) => ({
          id: entry.id ?? null,
          moduleName: entry.options?.name ?? null,
          enabled: entry.disabled !== true,
          fiber: entry.fiber?.state ?? null,
        }))
      })
      return { transport: 'api', commands, inventory, warnings }
    },

    /** 插件操作（写）。 */
    async pluginAction(action, args) {
      const warnings = []
      const manager = get(ctx, 'pluginManager')
      if (manager === undefined || manager === null) throw new Error('宿主没有 pluginManager 服务 —— 插件管理不可用')
      const call = async (label, fn) => {
        const result = await attempt(label, warnings, fn)
        if (result === null) throw new Error(`pluginManager.${label} 调用失败：${warnings[warnings.length - 1] ?? '未知错误'}`)
        return result
      }

      if (action === 'list') {
        const plugins = await call('listPlugins', () => manager.listPlugins())
        const bundles = await call('listBundles', () => manager.listBundles())
        // 默认**只回判断所需的字段**：完整 meta 里带着每个插件的标题、描述和（实验包的）base64
        // 图标，实测一次 list 能到 140 KB —— 那是模型上下文，不是日志。
        return {
          transport: 'api',
          plugins: Array.isArray(plugins) ? plugins.map((plugin) => ({
            entryId: plugin.entryId,
            moduleName: plugin.moduleName,
            enabled: plugin.enabled,
            fiberPhase: plugin.fiberPhase ?? null,
            ...(plugin.patchId === undefined ? {} : { patchId: plugin.patchId }),
            ...(plugin.readOnlyReason === undefined ? {} : { readOnlyReason: plugin.readOnlyReason }),
            title: typeof plugin.meta?.title === 'string' ? plugin.meta.title : undefined,
          })) : plugins,
          bundles: Array.isArray(bundles) ? bundles.map((bundle) => ({
            name: bundle.name,
            version: bundle.version ?? null,
            enabled: bundle.enabled === true,
            installed: bundle.installed === true,
            optional: bundle.optional === true,
            removable: bundle.removable === true,
            rows: Array.isArray(bundle.rows) ? bundle.rows.length : null,
            overrides: Array.isArray(bundle.overrides) ? bundle.overrides.length : null,
            ...(bundle.readOnlyReason === undefined ? {} : { readOnlyReason: bundle.readOnlyReason }),
          })) : bundles,
          verbose: args.verbose === true ? { plugins, bundles } : null,
          note: 'verbose:true 会把 pluginManager 的原始 meta 一并返回（很大，通常不需要）。',
          warnings,
        }
      }
      if (action === 'enable' || action === 'disable') {
        const enabled = action === 'enable'
        const target = args.id
        const bundles = await call('listBundles', () => manager.listBundles())
        const isBundle = Array.isArray(bundles) && bundles.some((bundle) => bundle.name === target)
        return {
          transport: 'api',
          result: isBundle
            ? await call('setBundleEnabled', () => manager.setBundleEnabled(target, enabled))
            : await call('setPluginEnabled', () => manager.setPluginEnabled(target, enabled)),
          appliedAs: isBundle ? 'bundle' : 'plugin-row',
          warnings,
        }
      }
      if (action === 'install') return { transport: 'api', result: await call('installBundle', () => manager.installBundle(args.spec, { enabled: args.enabled !== false, ...(Array.isArray(args.approvedBuilds) ? { approvedBuilds: args.approvedBuilds } : {}) })), warnings }
      if (action === 'remove') return { transport: 'api', result: await call('removeBundle', () => manager.removeBundle(args.id)), warnings }
      if (action === 'inspect') return { transport: 'api', result: await call('inspect', () => manager.inspect(args.spec)), warnings }
      throw new Error(`dsh_plugins: 不支持的动作 ${action}`)
    },

    /**
     * 插件操作日志：pluginManager 不保留历史，但每次 pnpm 运行都落在 profile 下。
     * @param {object} args - `{ limit }`。
     * @returns {object} 最近的日志尾部。
     */
    pluginLog(args = {}) {
      const root = join(profileDir(), '.plugin-manager', 'logs')
      if (!existsSync(root)) return { transport: 'disk', root, entries: [], note: '这个 profile 下还没有任何插件管理操作记录' }
      const entries = []
      for (const directory of readdirSync(root, { withFileTypes: true })) {
        if (!directory.isDirectory()) continue
        for (const file of readdirSync(join(root, directory.name))) {
          const full = join(root, directory.name, file)
          try {
            const stats = statSync(full)
            entries.push({ operation: directory.name, file, bytes: stats.size, mtimeMs: stats.mtimeMs, tail: readFileSync(full, 'utf8').split(/\r?\n/).slice(-40).join('\n') })
          } catch { /* 读不了就跳过 */ }
        }
      }
      entries.sort((left, right) => right.mtimeMs - left.mtimeMs)
      return { transport: 'disk', root, entries: entries.slice(0, Math.max(1, Math.min(args.limit ?? 3, 20))) }
    },
  }
}

/** 按工作区与数量筛选、按最近活动排序。 */
function filterAndSort(rows, args) {
  const workspace = args.workspace ?? 'all'
  // `args.limit === 'all'` 是给「只要计数」的内部调用方用的（`overview`）：`sessionController.list()`
  // 本来就把全部会话一次交出来，再裁到 500 只会把一个假数字写进 `sessions.total`。公开的 list 动作
  // 仍然受 500 这个上限保护，行为不变。
  const limit = args.limit === 'all'
    ? Number.POSITIVE_INFINITY
    : Math.max(1, Math.min(args.limit ?? 20, 500))
  const filtered = workspace === 'all'
    ? rows
    : rows.filter((row) => typeof row.workspace === 'string' && row.workspace.toLowerCase() === String(workspace).toLowerCase())
  return filtered
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0) || (left.quietSec ?? 0) - (right.quietSec ?? 0))
    .slice(0, limit)
}

/** 把一条会话事件压成可读的一行，避免把整篇 Markdown 塞进结果。 */
export function condenseEvent(event) {
  const data = event?.data ?? {}
  const base = { type: event?.type, seq: event?.seq, time: event?.time }
  if (event?.type === 'user/message' || event?.type === 'assistant/message') {
    const text = (data.message?.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('\n')
    const calls = (data.message?.content ?? []).filter((block) => block.type === 'tool-call').map((block) => block.name)
    return { ...base, role: data.message?.role ?? null, text: text.length > 800 ? `${text.slice(0, 800)}…` : text, toolCalls: calls }
  }
  if (event?.type === 'tool/call') return { ...base, name: data.name, callId: data.callId }
  if (event?.type === 'tool/result') return { ...base, callId: data.toolCallId ?? data.message?.toolCallId ?? null, isError: data.message?.isError ?? null }
  if (event?.type === 'turn/end') return { ...base, turn: data.turn, reason: data.reason?.kind ?? null }
  if (event?.type === 'turn/start' || event?.type === 'step/start' || event?.type === 'step/end') return { ...base, turn: data.turn, step: data.step }
  if (event?.type === 'goal/change') return { ...base, operation: data.operation, goal: data.goal?.objective ?? null }
  return { ...base, keys: Object.keys(data).slice(0, 8) }
}
