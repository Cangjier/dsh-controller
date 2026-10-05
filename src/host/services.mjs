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
import { listSessionLogs, readLog, readProjection, summarizeFromDisk } from './sessionlog.mjs'
import {
  PLAN_VERSION,
  hostIdentity,
  planPath,
  probeDesktopShell,
  probeWatcherAlive,
  readLogTail,
  readPlanResult,
  sameBoot,
  spawnWatcher,
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
  // 重启这件事的副作用入口全部可替换：真机上它们会真的问 Windows、真的起进程、真的请求退出，
  // 而测试必须能在不碰这台机器的前提下走完同一条代码路径。
  const probeShell = typeof deps.probeShell === 'function' ? deps.probeShell : probeDesktopShell
  const startWatcher = typeof deps.startWatcher === 'function' ? deps.startWatcher : spawnWatcher
  const watcherAlive = typeof deps.watcherAlive === 'function' ? deps.watcherAlive : probeWatcherAlive
  const loadPlan = typeof deps.readPlan === 'function' ? deps.readPlan : readPlanResult
  const savePlan = typeof deps.writePlan === 'function' ? deps.writePlan : writePlan
  const later = typeof deps.later === 'function' ? deps.later : (fn, ms) => setTimeout(fn, ms)
  const clock = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const requestExit = typeof deps.requestExit === 'function'
    ? deps.requestExit
    : (code) => {
      const exit = get(ctx, 'appExit')
      if (typeof exit !== 'function') throw new Error('宿主没有提供 ctx.appExit')
      return exit(code)
    }
  const logsBySession = () => new Map(listSessionLogs().map((entry) => [entry.sessionId, entry]))

  /** 这条会话日志的磁盘事实；找不到日志时返回 null。 */
  const diskState = (sessionId, warnings) => {
    try {
      const entry = logsBySession().get(sessionId)
      if (entry === undefined) return null
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
      const sessions = await this.listSessions({ workspace: 'all', limit: 1000 }, warnings)
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

      const disk = diskState(sessionId, warnings)
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
     * @param {object} args - `{ workspace, limit }`。
     * @param {string[]} [outerWarnings] - 调用方的警告收集器。
     * @returns {Promise<object[]>} 归一化后的会话行。
     */
    async listSessions(args = {}, outerWarnings) {
      const warnings = outerWarnings ?? []
      const controller = get(ctx, 'sessionController')
      let usedSource = null
      const summaries = await attempt('sessionController.list', warnings, async () => {
        if (typeof controller?.list !== 'function') return null
        const value = await controller.list()
        return Array.isArray(value) ? value : null
      })

      if (Array.isArray(summaries)) {
        usedSource = 'api:sessionController.list'
        const rows = []
        for (const summary of summaries) {
          const disk = diskState(summary.sessionId, warnings)
          rows.push({
            sessionId: summary.sessionId,
            title: titleText(disk?.title ?? summary.title ?? null),
            workspace: summary.cwd ?? disk?.workspace ?? null,
            running: summary.running === true,
            agentAvailable: summary.agentAvailable === true,
            blank: summary.blank === true,
            parentSessionId: summary.parentSessionId ?? null,
            origin: summary.origin ?? null,
            updatedAt: summary.updatedAt ?? null,
            state: summary.running === true ? 'RUNNING' : disk?.state ?? 'IDLE',
            quietSec: disk?.quietSec ?? null,
            goal: disk?.goal ?? null,
            source: 'api:sessionController.list',
          })
        }
        return filterAndSort(rows, args)
      }

      const query = get(ctx, 'sessionQuery')
      const records = await attempt('sessionQuery.listSessions', warnings, () => (typeof query?.listSessions === 'function' ? query.listSessions() : null))
      if (Array.isArray(records)) {
        usedSource = 'api:sessionQuery.listSessions'
        const agents = get(ctx, 'agents')
        const rows = []
        for (const record of records) {
          const header = record.header ?? {}
          const agent = await attempt('agents.get', warnings, () => (typeof agents?.get === 'function' ? agents.get(header.id) : null))
          const disk = diskState(header.id, warnings)
          const title = await attempt('sessionQuery.readTitle', warnings, () => query.readTitle?.(header.id) ?? null)
          rows.push({
            sessionId: header.id,
            title: titleText(title) ?? disk?.title ?? null,
            workspace: header.cwd ?? disk?.workspace ?? null,
            running: agent?.status === 'running',
            agentAvailable: agent !== null && agent !== undefined,
            blank: null,
            parentSessionId: header.parentSession ?? null,
            origin: header.origin ?? null,
            updatedAt: header.createdAt ?? null,
            state: agent?.status === 'running' ? 'RUNNING' : disk?.state ?? 'IDLE',
            quietSec: disk?.quietSec ?? null,
            goal: disk?.goal ?? null,
            source: 'api:sessionQuery.listSessions',
          })
        }
        return filterAndSort(rows, args)
      }

      warnings.push('sessionController.list 与 sessionQuery.listSessions 都不可用，退回磁盘扫描')
      usedSource = 'disk:sessions'
      const rows = listSessionLogs().map((log) => {
        const summary = summarizeFromDisk(log)
        return { ...summary, running: summary.state === 'RUNNING', agentAvailable: false, blank: null, updatedAt: log.mtimeMs, source: 'disk:sessions' }
      })
      void usedSource
      return filterAndSort(rows, args)
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
        const entry = logsBySession().get(args.sessionId)
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

      const before = await attempt('listSessions(before)', warnings, () => this.listSessions({ workspace: 'all', limit: 500 }))
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
        const rows = await attempt('listSessions(gui-watch)', warnings, () => this.listSessions({ workspace: 'all', limit: 500 }))
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
      const rows = await this.listSessions({ workspace: 'all', limit: SCAN_LIMIT }, warnings)
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
     * @param {object} args - `{ keepInbox, callerSessionId, limit }`。
     * @returns {Promise<object>} `{ requested, cancelled, failed, deferred, warnings }`。
     */
    async pauseAll(args = {}) {
      const snapshot = await this.listRunningSessions()
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
     * 停止所有在跑的会话 → 落盘恢复计划 → 起分离看门狗 → 延迟请求退出。
     *
     * 顺序是刻意的，每一步都为了「退出去还回得来」：
     *   - 先证明桌面壳找得到（`probeShell`），否则直接拒绝，绝不先退出去再说；
     *   - 再快照「谁在跑」，因为重启后要靠这份名单继续它们；
     *   - 计划**先落盘**：退出之后没有任何代码能补写；
     *   - 看门狗**先起来**：它起不来就不请求退出（宁可重启不发生，也不要退出去回不来）；
     *   - 退出是**延迟**的，否则本次工具结果会跟着这一轮一起消失。
     *
     * 调用者自己那条会话不在立即停止之列，而是在退出前一刻收掉（见 `pauseAll`）。
     * @param {object} args - `{ keepInbox, text, delaySeconds, dryRun, sessionIds, callerSessionId, reason }`。
     * @returns {Promise<object>} 计划与证据；`dryRun: true` 时只快照、不碰任何状态。
     */
    async restartHost(args = {}) {
      const warnings = []
      const nowMs = clock()
      const dryRun = args.dryRun === true
      const keepInbox = args.keepInbox ?? config.restart.keepInbox

      // 1. 先证伪：找不到壳、或没有退出入口，就什么都不做。
      const shell = await probeShell()
      if (shell?.ok !== true) {
        throw new Error(`看不到可以重新拉起的桌面壳：${shell?.reason ?? '壳探测没有返回结果'}。headless 的 dsh 请自己重启进程，插件不猜。`)
      }
      if (dryRun !== true && get(ctx, 'appExit') === undefined) {
        throw new Error('宿主没有提供 ctx.appExit —— 没有请求退出的入口（托盘菜单「重启应用与 Host」是产品自己的那条路）')
      }

      // 2. 快照：重启后要继续的就是这份名单。
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

      const callerSessionId = typeof args.callerSessionId === 'string' && args.callerSessionId !== '' ? args.callerSessionId : null
      const delaySeconds = Number.isFinite(args.delaySeconds) && args.delaySeconds > 0 ? args.delaySeconds : config.restart.delaySeconds
      const resumeText = typeof args.text === 'string' && args.text.trim() !== '' ? args.text : config.restart.resumeText

      const plan = {
        version: PLAN_VERSION,
        id: `restart-${randomUUID()}`,
        createdAt: new Date(nowMs).toISOString(),
        createdAtMs: nowMs,
        state: dryRun ? 'dry-run' : 'armed',
        reason: typeof args.reason === 'string' && args.reason !== '' ? args.reason : 'dsh_host {action:"restart"}',
        writer: hostIdentity(),
        shell: { mainPid: shell.mainPid, exe: shell.exe, commandLine: shell.commandLine ?? null, evidence: shell.evidence ?? null },
        stop: { keepInbox, requested: snapshot.rows.length, cancelled: [], failed: [], deferred: [] },
        resume: { text: resumeText, max: config.restart.maxResume },
        sessions,
        outcomes: [],
        resumedAt: null,
        resumedBy: null,
      }

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

      // 3. 立即停止（调用者除外）。
      const stopped = await this.pauseAll({ keepInbox, callerSessionId })
      plan.stop.cancelled = stopped.cancelled
      plan.stop.failed = stopped.failed
      plan.stop.deferred = stopped.deferred
      plan.stop.source = stopped.source
      warnings.push(...stopped.warnings)

      // 4. 计划落盘：退出之后没人能补写。
      savePlan(plan)

      // 5. 看门狗：起不来就绝不请求退出。
      let watcher
      try {
        watcher = await startWatcher({
          mainPid: shell.mainPid,
          exe: shell.exe,
          timeoutSeconds: config.restart.watcherTimeoutSeconds,
          settleMs: config.restart.settleMs,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        plan.state = 'failed'
        plan.failure = `看门狗起不来：${message}`
        savePlan(plan)
        throw new Error(`看门狗起不来，已取消退出（会话已经停了，但 DSH 还在跑）：${message}`)
      }
      // `method` 是证据的一部分：`wmi` = 新进程挂在 WmiPrvSE 下、不在 DSH 的进程树里；
      // `detached` = 只是分离的子进程（壳若用 kill-on-close 的 Job Object，它会跟着走）。
      plan.watcher = {
        pid: watcher.pid ?? null,
        method: watcher.method ?? null,
        shell: watcher.shell ?? null,
        logPath: watcher.logPath,
        script: watcher.script,
        attempts: watcher.attempts ?? [],
      }
      savePlan(plan)

      // 6. 延迟退出：先让本次工具结果送达，再收掉调用者那一轮，最后退出。
      const delayMs = Math.max(1, delaySeconds) * 1000
      plan.exit = { delaySeconds, scheduledAt: new Date(clock()).toISOString() }
      savePlan(plan)
      later(() => {
        void (async () => {
          if (callerSessionId !== null) {
            try { await this.abortSession({ sessionId: callerSessionId, keepInbox }) } catch { /* 退出在即，收不掉也照样退 */ }
          }
          // 最后一道闸：看门狗在这几秒里死了的话，退出就等于把 DSH 关掉且没人拉起来。
          if (Number.isFinite(watcher.pid)) {
            const alive = await watcherAlive(watcher.pid)
            if (alive === false) {
              plan.state = 'failed'
              plan.failure = `退出前发现看门狗（pid ${watcher.pid}）已经不在了，取消退出`
              try { savePlan(plan) } catch { /* 写不动就只剩日志 */ }
              return
            }
          }
          try {
            requestExit(0)
          } catch (error) {
            plan.state = 'failed'
            plan.failure = `请求退出失败：${error instanceof Error ? error.message : String(error)}`
            try { savePlan(plan) } catch { /* 写不动就只剩日志 */ }
          }
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
        note: `这个进程会在约 ${delaySeconds} 秒后退出，看门狗等它退出后重新拉起应用；重启后插件按计划把这些会话继续起来。`,
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
  const limit = Math.max(1, Math.min(args.limit ?? 20, 500))
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
