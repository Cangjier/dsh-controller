/**
 * `dsh_host` —— 整个 DSH 的停与重启：停止所有在跑的会话、退出、重新拉起、继续之前那些会话。
 *
 * 为什么这是一个独立工具而不是 `dsh_sessions` 的一个动作：它动的不是某一条会话，而是**整个
 * 进程**——退出意味着这次调用所在的那一轮也会死。所以它的结果必须是「计划 + 证据」，
 * 而不是「已完成」：真正把它干完的是看门狗与下一次启动时的恢复腿。
 *
 * 三件事分开：
 *   - `pause-all` 只停止，不重启；
 *   - `restart` 停止 + 落盘计划 + 起看门狗 + 延迟退出；
 *   - `status` / `resume` 是重启之后那一侧的接口（正常情况下恢复是自动的）。
 *
 * @module dsh-controller/tools/host
 */
import { ControllerError, defineFamilyTool } from './shared.mjs'

export const HOST_TOOL_NAME = 'dsh_host'

/** 分派顺序。 */
export const HOST_ACTIONS = ['pause-all', 'restart', 'status', 'resume']

/**
 * 造 `dsh_host` 的工具定义。
 * @param {object} host - 宿主适配器。
 * @param {object} config - 归一化后的插件配置。
 * @returns {object} 工具定义。
 */
export function createHostTool(host, config) {
  return defineFamilyTool({
    name: HOST_TOOL_NAME,
    actions: HOST_ACTIONS,
    /**
     * 这个工具的时间预算。
     *
     * `restart` 是这里最重的调用，它内部每一步都有自己的上限：探壳的 PowerShell 20s、看门狗的
     * 30s、快照。预算必须大于这些之和——一个太紧的预算会在看门狗**已经起来**之后把结果掐掉，
     * 而那时退出还在排队，调用方会以为「什么都没发生」。
     */
    timeoutFor(action) {
      if (action === 'restart') return 180_000
      if (action === 'resume') return 120_000
      return config.api.actionTimeoutMs
    },
    extraProperties: {
      confirm: { type: 'boolean', description: 'restart: required (true) unless dryRun:true, when config.guard.requireConfirmForRestart is on, which is the default. Say what you are about to do and get one.' },
      keepInbox: { type: 'boolean', description: 'pause-all / restart: true keeps queued and steering input, aborting only the running turn. Default comes from config.restart.keepInbox (false).' },
      sessionIds: { type: 'array', items: { type: 'string' }, description: 'restart / resume: continue exactly these sessions instead of the snapshot taken at restart time. Unknown ids are still attempted and reported per session.' },
      text: { type: 'string', description: 'restart / resume: the message that will be delivered to each continued session after the restart. Defaults to config.restart.resumeText.' },
      delaySeconds: { type: 'number', description: 'restart: how long to wait before requesting exit. The delay is what lets this call\'s result reach you first. Default from config.restart.delaySeconds.' },
      dryRun: { type: 'boolean', description: 'restart: snapshot and report what would happen without stopping anything, writing a plan, or exiting.' },
      force: { type: 'boolean', description: 'resume: bypass the "this plan belongs to the current process" guard. Only useful when re-driving a plan by hand.' },
      max: { type: 'number', description: 'resume: at most this many sessions to continue in one go. Defaults to config.restart.maxResume.' },
    },
    handlers: {
      async 'pause-all'(args, context) {
        return host.pauseAll({
          keepInbox: args.keepInbox === true,
          callerSessionId: callerSessionId(context),
        })
      },

      async restart(args, context) {
        if (config.restart.enabled !== true) {
          throw new ControllerError('config.restart.enabled = false：重启编排被关掉了（那意味着退出之后没人恢复会话）。只想让机器安静下来就用 pause-all。')
        }
        // dryRun 不产生任何副作用（不写盘、不停会话、不退出），所以它不该被最重的门槛挡住：
        // 门槛保护的是**一次真的重启**，而预演恰恰是「先说清要停掉哪些会话」的那一步。
        if (config.guard.requireConfirmForRestart && args.confirm !== true && args.dryRun !== true) {
          throw new ControllerError('重启整个 DSH 需要 confirm:true（config.guard.requireConfirmForRestart 默认打开）。先说清要停掉哪些会话，再带 confirm:true 调用；只想看会发生什么就用 dryRun:true，它不需要 confirm。')
        }
        return host.restartHost({
          keepInbox: args.keepInbox === true,
          text: args.text,
          delaySeconds: args.delaySeconds,
          dryRun: args.dryRun === true,
          sessionIds: args.sessionIds,
          callerSessionId: callerSessionId(context),
        })
      },

      async status() {
        return host.restartStatus()
      },

      async resume(args) {
        return host.resumeAfterRestart({
          sessionIds: args.sessionIds,
          text: args.text,
          max: args.max,
          force: args.force === true,
        })
      },
    },
  })
}

/**
 * 发起这次调用的会话。
 *
 * 这个 id 是 `pause-all` 与 `restart` 的关键输入：**发起者自己那一轮不能立刻被中止**，
 * 否则工具结果还没有送达，这一轮就没了——调用方会以为什么都没发生。
 * @param {object} context - 工具执行上下文。
 * @returns {string|null} 会话 id。
 */
function callerSessionId(context) {
  const id = context?.agent?.session?.id ?? context?.agent?.id
  return typeof id === 'string' && id !== '' ? id : null
}
