/**
 * 桌面回退通道：把 `desktop.ps1` 包成一个可等的调用。
 *
 * 这一层只负责**跑脚本、读 JSON、把失败变成结构化结果**。判断（点哪里、输什么、要不要
 * 前台化）全部留给调用方，因为那是模型的事，不是插件的事。
 *
 * 三条实测出来的约定：
 *   - 脚本永远打印一行 JSON 并退出 0；非零退出是脚本自己崩了，不是业务失败。
 *   - Node 侧统一按 UTF-8 解码（`encoding: 'buffer'` 再自己 toString），避免 Windows
 *     默认代码页把中文变成问号——那时 JSON 仍然能解析，只是所有查找都找不到东西。
 *   - 超时按结果返回，不抛出：一个卡住的 SetForegroundWindow 不该把整轮对话变成异常。
 *
 * @module dsh-controller/ui/desktop
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

const HERE = dirname(fileURLToPath(import.meta.url))

/** 插件仓库根目录。 */
export const PLUGIN_ROOT = resolvePath(HERE, '..', '..')

/** 回退脚本的绝对路径。 */
export const DESKTOP_SCRIPT = join(HERE, 'desktop.ps1')

/** 回退动作名，和脚本里的 `-Action` 取值一一对应。 */
export const UI_ACTIONS = ['window', 'look', 'click', 'type', 'key', 'scroll']

/** PowerShell 可执行文件：先 pwsh（7+），再 Windows PowerShell 5.1。 */
const POWERSHELL_CANDIDATES = ['pwsh.exe', 'powershell.exe']

/**
 * 这个动作要往脚本传哪些参数。
 *
 * 只列出真正传下去的参数：传 `-X 0` 一类的默认值会让脚本无法区分「没给」和「给了 0」。
 * @param {string} action - 动作名。
 * @param {object} args - 工具参数。
 * @param {object} config - 归一化后的插件配置。
 * @param {string} screenshotPath - `look` 的目标文件。
 * @returns {string[]} 脚本参数（不含可执行文件本身）。
 */
function scriptArgs(action, args, config, screenshotPath) {
  const list = ['-Action', action]
  if (typeof config.ui.windowTitle === 'string' && config.ui.windowTitle !== '') list.push('-Title', config.ui.windowTitle)
  else if (typeof args.title === 'string' && args.title !== '') list.push('-Title', args.title)
  if (typeof config.ui.processName === 'string' && config.ui.processName !== '') list.push('-ProcessName', config.ui.processName)

  if (action === 'window' && args.focus === true) list.push('-Focus')
  if (action === 'look') list.push('-Path', screenshotPath)
  if (action === 'click') list.push('-X', String(Math.round(args.x)), '-Y', String(Math.round(args.y)))
  if (action === 'type') list.push('-Text', String(args.text))
  if (action === 'key') list.push('-Chord', String(args.chord))
  if (action === 'scroll') {
    list.push('-Notches', String(Math.round(args.notches)))
    if (Number.isFinite(args.x)) list.push('-X', String(Math.round(args.x)))
    if (Number.isFinite(args.y)) list.push('-Y', String(Math.round(args.y)))
  }
  return list
}

/**
 * 跑一次回退脚本。
 * @param {string} action - 动作名。
 * @param {object} args - 工具参数。
 * @param {object} config - 归一化后的插件配置。
 * @param {object} [options] - `{ screenshotPath, timeoutMs }`。
 * @returns {Promise<object>} 脚本返回的 JSON，外加 `transport: "ui"`。
 * @throws {Error} 脚本文件缺失时。
 */
export async function runDesktop(action, args, config, options = {}) {
  if (!existsSync(DESKTOP_SCRIPT)) {
    throw new Error(`dsh-controller: 找不到 UI 回退脚本 ${DESKTOP_SCRIPT}`)
  }
  const timeoutMs = options.timeoutMs ?? config.ui.scriptTimeoutMs
  const cliArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', DESKTOP_SCRIPT, ...scriptArgs(action, args, config, options.screenshotPath)]

  let lastError = null
  for (const shell of POWERSHELL_CANDIDATES) {
    try {
      const result = await run(shell, cliArgs, { maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs, windowsHide: true, encoding: 'buffer' })
      const text = `${result.stdout.toString('utf8')}\n${result.stderr.toString('utf8')}`
      return { ...parseJsonLine(text), transport: 'ui' }
    } catch (error) {
      if (error?.code === 'ENOENT') { lastError = error; continue }
      const stdout = (error?.stdout ?? Buffer.alloc(0)).toString('utf8')
      const stderr = (error?.stderr ?? Buffer.alloc(0)).toString('utf8')
      const parsed = parseJsonLine(`${stdout}\n${stderr}`)
      if (parsed !== null) return { ...parsed, transport: 'ui' }
      return {
        ok: false,
        transport: 'ui',
        reason: error?.killed === true ? 'timeout' : 'script-failed',
        exitCode: typeof error?.code === 'number' ? error.code : null,
        shell,
        message: (stderr || stdout || String(error?.message ?? error)).trim().slice(-2000),
        timeoutMs,
      }
    }
  }
  throw new Error(`dsh-controller: 找不到可用的 PowerShell（试过 ${POWERSHELL_CANDIDATES.join(', ')}）：${lastError?.message ?? ''}`)
}

/**
 * 从脚本输出里取最后一行 JSON。
 *
 * 取最后一行而不是第一行：`Add-Type` 的编译警告会先出现在 stdout 上，而结果永远是最后一行。
 * @param {string} text - 脚本的 stdout + stderr。
 * @returns {object|null} 解析出的对象；一行都解析不出来时返回 null。
 */
export function parseJsonLine(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith('{'))
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index])
      if (value !== null && typeof value === 'object') return value
    } catch {
      // 不是 JSON 的行直接跳过：脚本的编译警告也长得像输出。
    }
  }
  return null
}

/**
 * `look` 的默认落地路径。
 * @param {object} config - 归一化后的插件配置。
 * @param {object} args - 工具参数。
 * @param {string} cwd - 会话工作目录。
 * @returns {string} 绝对路径。
 */
export function screenshotPath(config, args, cwd) {
  if (typeof args.path === 'string' && args.path !== '') {
    return resolvePath(cwd, args.path)
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return join(config.ui.screenshotDir, `dsh-window-${stamp}.png`)
}
