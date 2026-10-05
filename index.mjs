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
  const restart = config.restart ?? {}

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
    // 重启编排：停止全部会话 → 退出 → 由分离看门狗重新拉起 → 按落盘的计划继续那些会话。
    // 计划放在 `<DSH home>/controller/`，所以「重启前的那个进程」和「重启后的新进程」读的是同一份。
    restart: {
      enabled: optionalBoolean(restart, 'enabled', true, 'config.restart.enabled'),
      // 请求退出前的延迟：本次工具结果要先送达调用方，所以退出不能是立即的。
      delaySeconds: optionalPositiveNumber(restart, 'delaySeconds', 6, 'config.restart.delaySeconds'),
      // 看门狗等主进程退出的上限；到点还没退就放弃，绝不启动第二个实例。
      watcherTimeoutSeconds: optionalPositiveNumber(restart, 'watcherTimeoutSeconds', 180, 'config.restart.watcherTimeoutSeconds'),
      // 主进程退出后再等多久才拉起（让会话日志写完）。
      settleMs: optionalPositiveNumber(restart, 'settleMs', 1500, 'config.restart.settleMs'),
      // 一次最多自动继续多少条会话：防止一次重启把一大片会话同时点着。
      maxResume: optionalPositiveNumber(restart, 'maxResume', 20, 'config.restart.maxResume'),
      // 计划的有效期：超过它就不恢复了（一个隔夜才被打开的计划不该突然满血复活）。
      planTtlSeconds: optionalPositiveNumber(restart, 'planTtlSeconds', 900, 'config.restart.planTtlSeconds'),
      // 自动继续时投的那条消息。
      resumeText: optionalString(restart, 'resumeText', '继续上次未完成的工作。', 'config.restart.resumeText'),
      // 中止会话时是否保留排队/引导消息。
      keepInbox: optionalBoolean(restart, 'keepInbox', false, 'config.restart.keepInbox'),
      // 启动后多久开始检查恢复计划（给宿主装配服务留时间），以及最多等多久。
      resumeDelayMs: optionalPositiveNumber(restart, 'resumeDelayMs', 4000, 'config.restart.resumeDelayMs'),
      resumeWaitMs: optionalPositiveNumber(restart, 'resumeWaitMs', 180_000, 'config.restart.resumeWaitMs'),
    },
    guard: {
      requireConfirmForCreate: optionalBoolean(guard, 'requireConfirmForCreate', false, 'config.guard.requireConfirmForCreate'),
      requireConfirmForPlugins: optionalBoolean(guard, 'requireConfirmForPlugins', true, 'config.guard.requireConfirmForPlugins'),
      // 默认 true：重启整个应用是这台机器上最重的动作，必须显式 confirm。
      requireConfirmForRestart: optionalBoolean(guard, 'requireConfirmForRestart', true, 'config.guard.requireConfirmForRestart'),
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

  // 重启后的恢复腿：计划是上一个进程写的，投递发生在这个进程——所以它挂在加载期，
  // 而不是某个工具动作里。
  if (config.restart.enabled) scheduleResumeCheck(host, config, ctx.logger)
}

/** 一次性定时器；`unref` 让一个正在退出的进程不必为一个等待而多活。 */
function timer(fn, ms) {
  const handle = setTimeout(() => { void fn() }, ms)
  handle.unref?.()
  return handle
}

/**
 * 启动时检查有没有「重启前留下的恢复计划」，有就按它继续那些会话。
 *
 * 三条自我约束：
 *   - 宿主刚起来时 `sessionController` 可能还没装配，所以 `services-not-ready` 是重试信号，
 *     不是失败；重试到 `resumeWaitMs` 为止，之后放弃并说明计划还在盘上（可以手动 `resume`）。
 *   - 只有**别的进程**写的计划才会投递（`resumeAfterRestart` 里的 `sameBoot` 判定），
 *     所以插件热重载不会把消息重投一遍。
 *   - 没有计划、计划是本次启动写的、或已经恢复过，都安静地什么也不做——启动日志不该
 *     每次都喊一句「没有计划」。
 * @param {object} host - 宿主适配器。
 * @param {object} config - 归一化后的配置。
 * @param {object} logger - 插件 logger。
 * @returns {void}
 */
function scheduleResumeCheck(host, config, logger) {
  const startedAt = Date.now()
  const attempt = async () => {
    let result
    try {
      result = await host.resumeAfterRestart()
    } catch (error) {
      logger.warn(`dsh-controller: 重启恢复出错：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const state = result?.state
    if (state === 'services-not-ready') {
      if (Date.now() - startedAt >= config.restart.resumeWaitMs) {
        logger.warn(`dsh-controller: 重启恢复放弃：等了 ${Math.round(config.restart.resumeWaitMs / 1000)}s，sessionController 仍未就绪；计划仍在 ${result.planPath}，可用 dsh_host {action:"resume"} 手动恢复`)
        return
      }
      timer(attempt, 3000)
      return
    }
    if (state === 'no-plan' || state === 'same-boot' || state === 'already-done') return
    logger.info(`dsh-controller: 重启恢复 ${state} —— 成功 ${result.resumed ?? 0} 条，失败 ${result.failed ?? 0} 条（计划 ${result.planPath}）`)
  }
  timer(attempt, config.restart.resumeDelayMs)
}
