/**
 * 注册全部 `dsh_*` 工具。
 *
 * 一个工具注册失败不该把整棵插件带走：其余工具仍然有用，失败进日志。这和 `dsh-computer-use`
 * 的处理一致——「插件加载了但什么都没暴露」是最难发现的失败。
 *
 * @module dsh-controller/tools
 */
import { createControlTool } from './control.mjs'
import { createHostTool } from './host.mjs'
import { createPluginsTool } from './plugins.mjs'
import { createSessionsTool } from './sessions.mjs'
import { createUiTool } from './ui.mjs'

/** 本插件注册的全部工具名，按呈现顺序。 */
export const TOOL_NAMES = ['dsh_control', 'dsh_sessions', 'dsh_host', 'dsh_plugins', 'dsh_ui']

/**
 * 造全部工具定义。
 * @param {object} host - 宿主适配器（`src/host/services.mjs`）。
 * @param {object} config - 归一化后的插件配置。
 * @param {object} logger - 插件 logger。
 * @returns {object[]} 原始工具定义。
 */
export function toolDefinitions(host, config, logger) {
  return [
    createControlTool(host, config, logger),
    createSessionsTool(host, config),
    createHostTool(host, config),
    createPluginsTool(host, config),
    createUiTool(config),
  ]
}

/**
 * 在一个已经有 `tools` 服务的上下文里注册全部工具。
 * @param {object} toolsCtx - 提供 `tools` 的子上下文。
 * @param {object} host - 宿主适配器。
 * @param {object} config - 归一化后的插件配置。
 * @param {object} logger - 插件 logger。
 * @returns {{ registered: string[], failed: { name: string, error: string }[] }} 结果。
 */
export function registerTools(toolsCtx, host, config, logger) {
  const registered = []
  const failed = []
  for (const definition of toolDefinitions(host, config, logger)) {
    try {
      toolsCtx.tools.register(definition)
      registered.push(definition.name)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failed.push({ name: definition.name, error: message })
      logger.error(`dsh-controller: 注册工具 ${definition.name} 失败：${message}`)
    }
  }
  logger.info(`dsh-controller: 已注册 ${registered.length} 个工具：${registered.join(', ')}`)
  return { registered, failed }
}
