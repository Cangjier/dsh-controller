/**
 * `dsh-controller`：让 agent 控制 DSH 自身。
 *
 * **默认优先 DSH 自己暴露的 API，其次才是 computer 自动化；`dsh_sessions create` 是唯一的
 * 例外，它反过来——先 GUI、失败退 API。** 这不是口号，是每个结果里的 `transport` 字段：
 * `api` = 走 cordis 服务（`sessionController` / `agents` / `pluginManager` …），
 * `disk` = 宿主服务缺席时读磁盘事实，`ui` = 真的去点那个窗口。`dsh_control {action:"transport"}`
 * 会把这张表按当前进程实测结果列出来。
 *
 * 为什么读和控制仍然先用 API：API 能回答「落盘确认了吗」（`sessions.flush`）、能报
 * `restart-required`、能在没人看着的时候也工作；而合成输入失败是不报错的——点歪了也算成功。
 * 为什么 `create` 例外：那个「新会话」按钮走的就是产品自己的建会话路径，点出来的会话与 API
 * 造的是同一种东西；而且这条路**有证据**——点之前与点之后的会话 id 集合差证明它真的建成了，
 * 所以「GUI 先试」在这里不是碰运气。两条路都是全有或全无，不会建出两条对话。
 *
 * 本包是纯 ESM、零依赖：它**不能** import `@deepseek-ai/*`（那些包在 DSH 的 app.asar 里，
 * link 进来的插件解析不到），所以服务全部通过 `ctx.get(name)` 拿，拿不到就退回磁盘或报缺失。
 * 同理，工具定义的 schema 用字面量写，而不是 `defineTool()`。
 *
 * @module dsh-controller
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { adapter } from './src/host/services.mjs'
import { registerTools } from './src/tools/index.mjs'

/** 稳定的 cordis 插件名。 */
export const name = 'controller'

/** 注册工具前需要的服务。 */
export const inject = ['tools']

/** 本插件仓库根目录。 */
const HERE = dirname(fileURLToPath(import.meta.url))

/** 本插件仓库根目录（导出供测试与配置默认值使用）。 */
export const PLUGIN_ROOT = HERE

/** 默认单次 PowerShell 回退动作超时。 */
export const DEFAULT_SCRIPT_TIMEOUT_MS = 60_000

/** 默认等待会话空闲的上限。 */
export const DEFAULT_WAIT_MS = 120_000

/** `config.create.via` 的合法取值：auto = GUI 优先、失败退 API。 */
export const CREATE_VIA = ['auto', 'gui', 'api']

/**
 * 读一个可选字符串，null/undefined 都表示「用默认值」。
 * @param {object} raw - 原始配置。
 * @param {string} key - 字段名。
 * @param {string|null} fallback - 缺省值。
 * @param {string} where - 出错信息里的路径。
 * @returns {string|null} 结果。
 */
function optionalString(raw, key, fallback, where) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') throw new TypeError(`dsh-controller: ${where} 必须是字符串或 null`)
  return value
}

/**
 * 读一个可选布尔值。
 * @param {object} raw - 原始配置。
 * @param {string} key - 字段名。
 * @param {boolean} fallback - 缺省值。
 * @param {string} where - 出错信息里的路径。
 * @returns {boolean} 结果。
 */
function optionalBoolean(raw, key, fallback, where) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw new TypeError(`dsh-controller: ${where} 必须是布尔值`)
  return value
}

/**
 * 读一个可选正数。
 * @param {object} raw - 原始配置。
 * @param {string} key - 字段名。
 * @param {number} fallback - 缺省值。
 * @param {string} where - 出错信息里的路径。
 * @returns {number} 结果。
 */
function optionalPositiveNumber(raw, key, fallback, where) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`dsh-controller: ${where} 必须是正数`)
  }
  return value
}

/**
 * 读一个枚举值。
 * @param {object} raw - 原始配置。
 * @param {string} key - 字段名。
 * @param {string[]} allowed - 合法取值。
 * @param {string} fallback - 缺省值。
 * @param {string} where - 出错信息里的路径。
 * @returns {string} 结果。
 */
function optionalEnum(raw, key, allowed, fallback, where) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new TypeError(`dsh-controller: ${where} 必须是 ${allowed.join(' / ')} 之一`)
  }
  return value
}

/**
 * 校验并归一化这一行的 `config`。
 *
 * 配置写错在**加载时**就抛错，而不是等到某次调用才失败：一个悄悄用着默认值的插件，
 * 比一个加载失败的插件更难查。
 * @param {object} [raw] - `cordis.patch.yml` 里这一行的 `config`。
 * @returns {object} 归一化后的配置。
 * @throws {TypeError} 任一字段类型或取值非法时。
 */
export function normalizeConfig(raw) {
  const config = raw ?? {}
  const api = config.api ?? {}
  const ui = config.ui ?? {}
  const guard = config.guard ?? {}
  const create = config.create ?? {}

  const screenshotDir = optionalString(ui, 'screenshotDir', null, 'config.ui.screenshotDir')
  return {
    enabled: optionalBoolean(config, 'enabled', true, 'config.enabled'),
    api: {
      forceUi: optionalBoolean(api, 'forceUi', false, 'config.api.forceUi'),
      defaultWaitMs: optionalPositiveNumber(api, 'defaultWaitMs', DEFAULT_WAIT_MS, 'config.api.defaultWaitMs'),
      actionTimeoutMs: optionalPositiveNumber(api, 'actionTimeoutMs', 30_000, 'config.api.actionTimeoutMs'),
    },
    // 新建会话走哪条路。默认 auto = 先 GUI、失败退 API；`api` 是纯 API 的旧行为，
    // `gui` 是「宁可失败也不偷偷用 API」。
    create: {
      via: optionalEnum(create, 'via', CREATE_VIA, 'auto', 'config.create.via'),
      // .116/.135 是实测出来的：「新会话」按钮中心在 1296x828 的窗口里是 (150, 112)。
      // 用比例而不是像素，换分辨率、换缩放都不用重测。
      newSessionX: optionalPositiveNumber(create, 'newSessionX', 0.116, 'config.create.newSessionX'),
      newSessionY: optionalPositiveNumber(create, 'newSessionY', 0.135, 'config.create.newSessionY'),
      composerX: optionalPositiveNumber(create, 'composerX', 0.61, 'config.create.composerX'),
      composerY: optionalPositiveNumber(create, 'composerY', 0.565, 'config.create.composerY'),
      settleMs: optionalPositiveNumber(create, 'settleMs', 1200, 'config.create.settleMs'),
      waitMs: optionalPositiveNumber(create, 'waitMs', 15_000, 'config.create.waitMs'),
      clickTimeoutMs: optionalPositiveNumber(create, 'clickTimeoutMs', 45_000, 'config.create.clickTimeoutMs'),
      // 第一条消息默认交给 API，而不是在 GUI 里敲：实测这台机器上 DSH 的输入框（Lexical）
      // 只接受 `SendKeys` 的 ASCII——Unicode SendInput 被 Windows 收下（每个字符返回 2）却一个字
      // 都不显示，剪贴板粘贴（`^v`）同样无声失败；而且侧边栏会保留没发出去的草稿，新会话打开时
      // 输入框里可能还留着上一次的话。默认 false 时 `text` 只能走 API；要试 GUI 送字就打开它，
      // 脚本会在有草稿或非 ASCII 时明确拒绝（`composer-not-empty` / `text-not-ascii`）。
      submitInGui: optionalBoolean(create, 'submitInGui', false, 'config.create.submitInGui'),
    },
    ui: {
      windowTitle: optionalString(ui, 'windowTitle', null, 'config.ui.windowTitle'),
      processName: optionalString(ui, 'processName', 'DeepSeek Harness', 'config.ui.processName'),
      screenshotDir: screenshotDir === null ? resolve(HERE, 'tmp', 'screens') : screenshotDir,
      scriptTimeoutMs: optionalPositiveNumber(ui, 'scriptTimeoutMs', DEFAULT_SCRIPT_TIMEOUT_MS, 'config.ui.scriptTimeoutMs'),
      focusSettleMs: optionalPositiveNumber(ui, 'focusSettleMs', 120, 'config.ui.focusSettleMs'),
    },
    guard: {
      requireConfirmForCreate: optionalBoolean(guard, 'requireConfirmForCreate', false, 'config.guard.requireConfirmForCreate'),
      requireConfirmForPlugins: optionalBoolean(guard, 'requireConfirmForPlugins', true, 'config.guard.requireConfirmForPlugins'),
    },
  }
}

/**
 * 挂载工具。
 *
 * 注册包在 `ctx.inject(['tools'], …)` 里：`tools` 服务还没到位时不是静默失败，而是一直等到它出现；
 * 注册本身失败也会进日志，并且 `dsh_control {action:"capabilities"}` 会照出「服务在不在」。
 * @param {object} ctx - cordis 插件上下文。
 * @param {object} rawConfig - 这一行的 `config`。
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  let config
  try {
    config = normalizeConfig(rawConfig)
  } catch (error) {
    ctx.logger.error(`dsh-controller: 配置无效，插件未注册任何工具：${error.message}`)
    return
  }

  if (!config.enabled) {
    ctx.logger.info('dsh-controller: config.enabled = false，未注册任何工具')
    return
  }

  const host = adapter(ctx, config)

  ctx.inject(['tools'], (toolsCtx) => {
    const outcome = registerTools(toolsCtx, host, config, ctx.logger)
    if (outcome.registered.length === 0) {
      ctx.logger.error('dsh-controller: 没有注册任何工具，插件实际上不可用')
    }
  })
}
