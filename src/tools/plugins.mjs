/**
 * `dsh_plugins` —— 看和改「DSH 装了哪些插件、哪些开着」。
 *
 * 走 `pluginManager`：它自己写 `cordis.patch.yml`（行）和 `package.json#dsh.profile.bundles`
 * （bundle），并且会告诉你这次改动是 `applied` 还是 `restart-required`。本插件不自己改那两个
 * 文件——绕过 manager 去写，写出来的东西宿主不一定认。
 *
 * 「最近一次操作」没有 API：pluginManager 明确不保留历史，所以 `log` 读的是它自己落在
 * `<profile>/.plugin-manager/logs/` 下的 pnpm 日志。这是磁盘路径，结果里标成 `disk`。
 *
 * @module dsh-controller/tools/plugins
 */
import { ControllerError, defineFamilyTool } from './shared.mjs'

export const PLUGINS_TOOL_NAME = 'dsh_plugins'

/** 分派顺序。 */
export const PLUGINS_ACTIONS = ['list', 'inventory', 'enable', 'disable', 'install', 'remove', 'inspect', 'log']

/**
 * 造 `dsh_plugins` 的工具定义。
 * @param {object} host - 宿主适配器。
 * @param {object} config - 归一化后的插件配置。
 * @returns {object} 工具定义。
 */
export function createPluginsTool(host, config) {
  /** 改状态的动作在配置要求时必须显式确认。 */
  const requireConfirm = (action, args) => {
    if (config.guard.requireConfirmForPlugins && args.confirm !== true) {
      throw new ControllerError(`dsh_plugins {action:"${action}"} 会改 profile 配置，需要 confirm:true（config.guard.requireConfirmForPlugins 打开了）`)
    }
  }

  return defineFamilyTool({
    name: PLUGINS_TOOL_NAME,
    actions: PLUGINS_ACTIONS,
    /**
     * 这个工具的时间预算。
     *
     * 装/卸要走 pnpm（外部进程，几分钟很正常），这两个动作给足预算；其余动作一句话就该回来，
     * 用默认值——它们慢下来只会是「服务卡住」，那时一条可读的超时比无限等待有用。
     */
    timeoutFor(action) {
      if (action === 'install' || action === 'remove') return 900_000
      return config.api.actionTimeoutMs
    },
    extraProperties: {
      id: { type: 'string', description: 'enable / disable / remove: the plugin row id or the bundle name, as reported by list.' },
      spec: { type: 'string', description: 'install / inspect: an npm name, a git URL, or an absolute local path.' },
      enabled: { type: 'boolean', description: 'install: whether the bundle is selected after installing. Default true.' },
      approvedBuilds: { type: 'array', items: { type: 'string' }, description: 'install: names of dependencies whose build scripts you accept, when pnpm blocks them.' },
      limit: { type: 'number', description: 'log: how many operations to return. Default 3, at most 20.' },
      verbose: { type: 'boolean', description: 'list: also return pluginManager\'s raw metadata. Large (about 140 KB on this machine: every row carries its description and some carry a base64 icon); only for diagnosing.' },
      confirm: { type: 'boolean', description: 'Required by every action that changes state when config.guard.requireConfirmForPlugins is true.' },
    },
    handlers: {
      async list(args) {
        const result = await host.pluginAction('list', args)
        return {
          transport: result.transport,
          plugins: result.plugins,
          bundles: result.bundles,
          ...(result.verbose === null || result.verbose === undefined ? {} : { verbose: result.verbose }),
          note: result.note,
          warnings: result.warnings,
        }
      },

      async inventory() {
        const result = await host.plugins()
        return { transport: result.transport, commands: result.commands, inventory: result.inventory, warnings: result.warnings }
      },

      async enable(args) {
        requireConfirm('enable', args)
        if (typeof args.id !== 'string' || args.id === '') throw new ControllerError('dsh_plugins {action:"enable"} 需要 id')
        return host.pluginAction('enable', args)
      },

      async disable(args) {
        requireConfirm('disable', args)
        if (typeof args.id !== 'string' || args.id === '') throw new ControllerError('dsh_plugins {action:"disable"} 需要 id')
        return host.pluginAction('disable', args)
      },

      async install(args) {
        requireConfirm('install', args)
        if (typeof args.spec !== 'string' || args.spec === '') throw new ControllerError('dsh_plugins {action:"install"} 需要 spec')
        return host.pluginAction('install', args)
      },

      async remove(args) {
        requireConfirm('remove', args)
        if (typeof args.id !== 'string' || args.id === '') throw new ControllerError('dsh_plugins {action:"remove"} 需要 id')
        return host.pluginAction('remove', args)
      },

      async inspect(args) {
        if (typeof args.spec !== 'string' || args.spec === '') throw new ControllerError('dsh_plugins {action:"inspect"} 需要 spec')
        return host.pluginAction('inspect', args)
      },

      async log(args) {
        return host.pluginLog({ limit: args.limit ?? 3 })
      },
    },
  })
}
