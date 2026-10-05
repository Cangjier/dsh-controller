/**
 * `dsh_control` —— 只读的自我认知：DSH 是什么、能走哪条路、这个动作会走哪条路。
 *
 * @module dsh-controller/tools/control
 */
import { TOOLS } from './registry.mjs'
import { ControllerError } from './shared.mjs'

export const CONTROL_TOOL_NAME = 'dsh_control'

/** 分派顺序。 */
export const CONTROL_ACTIONS = ['overview', 'capabilities', 'session', 'transport', 'guide']

/**
 * 每个动作会优先走哪条路。这是**声明**，而 `capabilities` 是**实测**；两者不一致时以实测为准，
 * 并且 `transport` 会把差异写出来。
 */
const ROUTES = {
  overview: { preferred: 'api', fallback: 'disk', reason: 'sessionController/workspaceRegistry 直接答；缺席时退到 ~/.dsh 下的会话目录与投影缓存' },
  capabilities: { preferred: 'api', fallback: null, reason: '就是逐项探测本身' },
  session: { preferred: 'api', fallback: 'disk', reason: 'live agent 的 status/投影最准；冷会话读投影缓存与日志' },
  transport: { preferred: 'api', fallback: null, reason: '纯计算：把探测结果映射成每个动作的首选通道' },
  guide: { preferred: null, fallback: null, reason: '纯计算：读注册表，不碰宿主' },
  'dsh_sessions.list': { preferred: 'api', fallback: 'disk', reason: 'sessionController.list 一次给全（含 running）' },
  'dsh_sessions.get': { preferred: 'api', fallback: 'disk', reason: 'sessionQuery 读历史，live agent 读状态' },
  'dsh_sessions.create': { preferred: 'ui', fallback: 'api', reason: '默认点真实窗口的「新会话」按钮，再用 API 的会话列表确认它真的出现了；任一步失败就整条退回 sessionController.create + agents.create' },
  'dsh_sessions.send': { preferred: 'api', fallback: null, reason: 'sessionController.resolveAgent + followup，与 dsh-schedule 投递提醒同路' },
  'dsh_sessions.abort': { preferred: 'api', fallback: null, reason: 'agent.cancel 是唯一的干净中止路径' },
  'dsh_sessions.wait': { preferred: 'api', fallback: null, reason: 'agent.whenIdle' },
  'dsh_sessions.rename': { preferred: 'api', fallback: null, reason: 'sessionTitle.rename' },
  'dsh_host.pause-all': { preferred: 'api', fallback: null, reason: 'agent.cancel 是唯一干净的中止路径；「在跑」取 sessionController.list 的 running' },
  'dsh_host.restart': { preferred: 'api', fallback: 'process', reason: '停止与落盘走 API；退出走 ctx.appExit，重新拉起只能由进程外的看门狗做——没有任何 API 能在退出之后还活着' },
  'dsh_host.status': { preferred: 'disk', fallback: null, reason: '计划与看门狗日志是跨进程的事实，只存在于 <DSH home>/controller 下' },
  'dsh_host.resume': { preferred: 'api', fallback: null, reason: 'sessionController.resolveAgent + followup，与 dsh_sessions.send 同一条路' },
  'dsh_plugins.list': { preferred: 'api', fallback: 'disk', reason: 'pluginManager.listPlugins/listBundles；缺席时读 profile 的 package.json 与 loader 行树' },
  'dsh_plugins.inventory': { preferred: 'api', fallback: null, reason: 'loader.entries() 是运行期真相' },
  'dsh_plugins.enable': { preferred: 'api', fallback: null, reason: 'setPluginEnabled/setBundleEnabled 会写 cordis.patch.yml 并触发重载' },
  'dsh_plugins.disable': { preferred: 'api', fallback: null, reason: '同上' },
  'dsh_plugins.install': { preferred: 'api', fallback: 'cli', reason: 'pluginManager.installBundle；服务缺席时可以退到 `dsh plugin --profile <name> add <spec>`' },
  'dsh_plugins.remove': { preferred: 'api', fallback: 'cli', reason: '同上，`dsh plugin … remove`' },
  'dsh_plugins.inspect': { preferred: 'api', fallback: null, reason: 'pluginManager.inspect 在动手之前告诉你这个 spec 是什么' },
  'dsh_plugins.log': { preferred: 'disk', fallback: null, reason: 'pluginManager 不保留历史，日志只存在于 profile/.plugin-manager/logs' },
  'dsh_ui.window': { preferred: 'ui', fallback: null, reason: '看窗口本身就是桌面自动化' },
  'dsh_ui.look': { preferred: 'ui', fallback: null, reason: '截图' },
  'dsh_ui.click': { preferred: 'ui', fallback: null, reason: '真实点击' },
  'dsh_ui.type': { preferred: 'ui', fallback: null, reason: '真实按键' },
  'dsh_ui.key': { preferred: 'ui', fallback: null, reason: '真实组合键' },
  'dsh_ui.scroll': { preferred: 'ui', fallback: null, reason: '真实滚轮' },
}

/**
 * 造 `dsh_control` 的工具定义。
 * @param {object} host - `src/host/services.mjs` 造出来的适配器。
 * @param {object} config - 归一化后的插件配置。
 * @param {object} logger - 插件 logger。
 * @returns {object} 工具定义。
 */
export function createControlTool(host, config, logger) {
  return {
    name: CONTROL_TOOL_NAME,
    description: [
      'Read what DSH itself is and which of its own APIs this process can reach.',
      `Actions: ${CONTROL_ACTIONS.join(', ')}.`,
      'Needs: nothing beyond the plugin being loaded; every field degrades to a stated absence.',
      `Next: dsh_sessions to act, dsh_host to stop or restart DSH itself, dsh_plugins to manage plugins, dsh_ui only when the GUI is the only way.`,
      `Full detail: dsh_control {action:"guide", tool:"${CONTROL_TOOL_NAME}"}.`,
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: CONTROL_ACTIONS,
          description: CONTROL_ACTIONS.map((name) => {
            const entry = TOOLS[CONTROL_TOOL_NAME].actions[name]
            return `${name} — ${entry.summary}`
          }).join('\n'),
        },
        sessionId: { type: 'string', description: 'session: which session to inspect. Defaults to the calling session.' },
        tool: { type: 'string', description: 'guide: the tool to render in full, for example "dsh_sessions". Omit to list every tool.' },
        actionName: { type: 'string', description: 'guide: one action of `tool` to render in full.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
    async execute(args, context) {
      switch (args.action) {
        case 'overview':
          return host.overview()
        case 'capabilities':
          return { transport: 'api', ...host.capabilities() }
        case 'session': {
          const sessionId = args.sessionId ?? selfSessionId(context)
          if (sessionId === null) {
            throw new ControllerError('dsh_control {action:"session"}: 拿不到当前会话 id（调用上下文里没有 agent），请显式给 sessionId')
          }
          return host.sessionState(sessionId)
        }
        case 'transport': {
          const capabilities = host.capabilities()
          const available = new Set(capabilities.api.filter((entry) => entry.available).map((entry) => entry.service))
          const rows = {}
          for (const [key, route] of Object.entries(ROUTES)) {
            rows[key] = {
              preferred: route.preferred,
              fallback: route.fallback,
              reason: route.reason,
              // 首选通道现在真的可用吗：api 看服务是否在，ui 看平台与脚本，disk 永远可用。
              usableNow: route.preferred === 'api'
                ? available.size > 0
                : route.preferred === 'ui'
                  ? capabilities.ui.some((channel) => channel.available)
                  : route.preferred === 'disk'
                    ? true
                    : null,
            }
          }
          return { transport: 'api', servicesAvailable: [...available].sort(), routes: rows, uiChannels: capabilities.ui }
        }
        case 'guide':
          return guide(args, logger)
        default:
          throw new ControllerError(`dsh_control: unknown action ${JSON.stringify(args.action)}`)
      }
    },
  }
}

/**
 * 调用方是哪个会话。
 * @param {object} context - 工具执行上下文（`exec`）。
 * @returns {string|null} 会话 id。
 */
function selfSessionId(context) {
  return context?.agent?.session?.id ?? context?.agent?.id ?? null
}

/** 把结果渲染成一个 JSON 文本块。 */
function renderText(_args, value) {
  return [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value, null, 2) }]
}

/** 渲染注册表：给 `tool`/`actionName` 就给细节，否则列全部。 */
function guide(args, logger) {
  if (args.tool === undefined) {
    const tools = Object.entries(TOOLS).map(([name, entry]) => ({ tool: name, purpose: entry.purpose, actions: Object.keys(entry.actions) }))
    logger?.info?.(`dsh-controller: guide 列出了 ${tools.length} 个工具`)
    return { transport: null, tools }
  }
  const entry = TOOLS[args.tool]
  if (entry === undefined) throw new ControllerError(`guide: 没有名为 ${JSON.stringify(args.tool)} 的工具；现有：${Object.keys(TOOLS).join(', ')}`)
  if (args.actionName === undefined) {
    return {
      transport: null,
      tool: args.tool,
      purpose: entry.purpose,
      needs: entry.needs,
      next: entry.next,
      actions: Object.fromEntries(Object.entries(entry.actions).map(([name, action]) => [name, { summary: action.summary, required: action.required ?? [], risk: action.risk ?? null, use: action.use ?? null, detail: action.detail ?? [] }])),
      routes: Object.fromEntries(Object.entries(ROUTES).filter(([key]) => key.startsWith(args.tool)).map(([key, route]) => [key, route])),
    }
  }
  const action = entry.actions[args.actionName]
  if (action === undefined) throw new ControllerError(`guide: ${args.tool} 没有动作 ${JSON.stringify(args.actionName)}；现有：${Object.keys(entry.actions).join(', ')}`)
  return {
    transport: null,
    tool: args.tool,
    action: args.actionName,
    summary: action.summary,
    required: action.required ?? [],
    risk: action.risk ?? null,
    use: action.use ?? null,
    detail: action.detail ?? [],
    route: ROUTES[`${args.tool}.${args.actionName}`] ?? null,
  }
}
