/**
 * `dsh_sessions` —— 读和控制 DSH 的对话本身。
 *
 * 这是本插件的核心：开一条新对话、往一条已有对话里投话、中止、等待、改名。全部走 DSH 自己的
 * API（`sessionController` / `agents` / `sessions` / `sessionTitle`），没有一条路径是去点 GUI 的——
 * 因为点 GUI 既不可靠，也拿不到「这条消息真的落盘了吗」这个答案。
 *
 * @module dsh-controller/tools/sessions
 */
import { ControllerError, defineFamilyTool } from './shared.mjs'

export const SESSIONS_TOOL_NAME = 'dsh_sessions'

/** 分派顺序。 */
export const SESSIONS_ACTIONS = ['list', 'get', 'create', 'send', 'abort', 'wait', 'rename']

/** 投递模式：下一轮 / 当前轮中途引导 / 只加模型可见上下文。 */
const SEND_MODES = ['followup', 'steer', 'inject']

/**
 * 造 `dsh_sessions` 的工具定义。
 * @param {object} host - 宿主适配器。
 * @param {object} config - 归一化后的插件配置。
 * @returns {object} 工具定义。
 */
export function createSessionsTool(host, config) {
  return defineFamilyTool({
    name: SESSIONS_TOOL_NAME,
    actions: SESSIONS_ACTIONS,
    extraProperties: {
      sessionId: { type: 'string', description: 'get / send / abort / wait / rename: the session to act on. send also accepts a cold session — it is resumed first.' },
      workspace: { type: 'string', description: 'list: an absolute workspace path, or "all" (default).' },
      limit: { type: 'number', description: 'list: how many rows to return. Default 20, at most 500.' },
      tail: { type: 'number', description: 'get: how many recent events to include. Default 20, at most 200.' },
      text: { type: 'string', description: 'create / send: the message text. For create this is the conversation\'s first message.' },
      cwd: { type: 'string', description: 'create: absolute working directory for the new conversation. Defaults to the calling session\'s cwd.' },
      title: { type: 'string', description: 'create / rename: the conversation title.' },
      preset: { type: 'string', description: 'create: agent preset id (for example "standard"). Defaults to the host default.' },
      mode: { type: 'string', enum: SEND_MODES, description: 'send: "followup" (default, next turn), "steer" (mid-turn guidance), "inject" (model-visible context only, does not wake the driver).' },
      keepInbox: { type: 'boolean', description: 'abort: true keeps queued and steering work, aborting only the running turn. Default false (clears the inbox too).' },
      timeoutMs: { type: 'number', description: 'wait: how long to wait for idle before answering "still running". Default from config.api.defaultWaitMs.' },
      confirm: { type: 'boolean', description: 'create: required only when config.guard.requireConfirmForCreate is true.' },
    },
    handlers: {
      async list(args) {
        const warnings = []
        const sessions = await host.listSessions({ workspace: args.workspace ?? 'all', limit: args.limit ?? 20 }, warnings)
        return {
          // 每行自带来源；整批的来源取第一行。空表时 `transport` 是 none，不是谎报成 api。
          transport: sessions[0]?.source ?? 'none',
          count: sessions.length,
          sessions: sessions.map((session) => ({
            sessionId: session.sessionId,
            title: session.title,
            workspace: session.workspace,
            state: session.state,
            running: session.running,
            goal: session.goal?.phase ?? null,
            quietSec: session.quietSec,
            updatedAt: session.updatedAt,
          })),
          warnings,
        }
      },

      async get(args, context) {
        const sessionId = args.sessionId ?? context?.agent?.session?.id
        if (typeof sessionId !== 'string' || sessionId === '') throw new ControllerError('dsh_sessions {action:"get"} 需要 sessionId')
        return host.getSession({ sessionId, tail: args.tail ?? 20 })
      },

      async create(args, context) {
        if (config.guard.requireConfirmForCreate && args.confirm !== true) {
          throw new ControllerError('新建会话需要 confirm:true（config.guard.requireConfirmForCreate 打开了）')
        }
        if (typeof args.text !== 'string' || args.text.trim() === '') throw new ControllerError('dsh_sessions {action:"create"} 需要非空的 text')
        return host.createSession({
          text: args.text,
          cwd: args.cwd ?? context?.cwd,
          title: args.title,
          preset: args.preset,
        })
      },

      async send(args) {
        if (typeof args.sessionId !== 'string' || args.sessionId === '') throw new ControllerError('dsh_sessions {action:"send"} 需要 sessionId')
        if (typeof args.text !== 'string' || args.text.trim() === '') throw new ControllerError('dsh_sessions {action:"send"} 需要非空的 text')
        return host.sendToSession({ sessionId: args.sessionId, text: args.text, mode: args.mode ?? 'followup' })
      },

      async abort(args) {
        if (typeof args.sessionId !== 'string' || args.sessionId === '') throw new ControllerError('dsh_sessions {action:"abort"} 需要 sessionId')
        return host.abortSession({ sessionId: args.sessionId, keepInbox: args.keepInbox === true })
      },

      async wait(args) {
        if (typeof args.sessionId !== 'string' || args.sessionId === '') throw new ControllerError('dsh_sessions {action:"wait"} 需要 sessionId')
        return host.waitIdle({ sessionId: args.sessionId, timeoutMs: args.timeoutMs })
      },

      async rename(args) {
        if (typeof args.sessionId !== 'string' || args.sessionId === '') throw new ControllerError('dsh_sessions {action:"rename"} 需要 sessionId')
        if (typeof args.title !== 'string' || args.title.trim() === '') throw new ControllerError('dsh_sessions {action:"rename"} 需要非空的 title')
        return host.renameSession({ sessionId: args.sessionId, title: args.title })
      },
    },
  })
}
