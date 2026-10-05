/**
 * 重启编排里「进程外」的那一半：计划落盘、桌面壳探测、分离看门狗。
 *
 * 为什么这件事必须有一半在进程外：DSH 没有「重启」API。Host 侧只拿得到 `ctx.appExit`，而它
 * **关的是 Host 子进程自己**（实测启动器源码 `apps/cli/src/profile-boot.ts`：
 * `exit: code => void shutdown.shutdown(code)`），不是桌面应用——桌面壳的
 * `app.relaunch() + exit()` 只在它自己进程内可达（托盘菜单「重启应用与 Host」）。所以顺序是死的：
 *
 *   1. 先**证明**退出去还拉得起来（`probeDesktopShell()` 找到真正的主进程与 exe，并且报出
 *      「本进程」这个 Host 子进程的 pid——要等的是它，不是主进程）；
 *   2. 把「重启前谁在跑」写成计划落盘（退出之后就没人写了）；
 *   3. 用 `detached` 起一个看门狗进程（它**不属于** DSH 的进程树，DSH 死了它还活着）；
 *   4. 最后才请求退出，而且是延迟的——工具结果要先送达调用方。
 *
 * 看门狗分三段，每一段都对应一个实测事实：等 **Host** 消失（那是 `appExit` 真的做到了的事）→
 * 壳还在（后端没了、界面停在「重连中」），先请它关窗、超时就强杀 → 确认没有同名进程残留，才
 * 启动 exe。任何一段超时它都放弃并且**不启动第二个实例**——宁可「重启没发生」，也不要两个 DSH
 * 抢同一个 profile。
 *
 * @module dsh-controller/host/restart
 */
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { controllerStateDir } from './paths.mjs'
import { parseJsonLine } from '../ui/desktop.mjs'

const run = promisify(execFile)

const HERE = dirname(fileURLToPath(import.meta.url))

/** 计划文件的版本；字段变了就加一，读到不认识的版本宁可报错也不猜。 */
export const PLAN_VERSION = 1

/** 延时脚本的绝对路径。 */
export const RELAUNCH_SCRIPT = join(HERE, 'relaunch-watch.ps1')

/** PowerShell 可执行文件：先 pwsh（7+），再 Windows PowerShell 5.1。 */
const POWERSHELL_CANDIDATES = ['pwsh.exe', 'powershell.exe']

/**
 * 本进程大约的启动时刻，**只算一次**。
 *
 * 每次调用都重算会得到差几毫秒的不同答案，于是「这份计划是不是当前进程写的」就变成了掷骰子：
 * 同一个进程的两次 hostIdentity() 会被判成两个进程。身份必须是常量。
 */
const BOOT_EPOCH_MS = Math.round(Date.now() - process.uptime() * 1000)

/** 重启计划文件。 */
export function planPath() {
  return join(controllerStateDir(), 'restart-plan.json')
}

/** 看门狗日志。 */
export function watcherLogPath() {
  return join(controllerStateDir(), 'restart-watch.log')
}

/** 确保状态目录存在，返回它。 */
export function ensureStateDir() {
  const dir = controllerStateDir()
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 读重启计划；文件不存在、读不动、或版本不认识都返回 null（并说明原因在 `readPlanResult`）。
 * @returns {object|null} 计划，或 null。
 */
export function readPlan() {
  return readPlanResult().plan
}

/**
 * 读重启计划，连「为什么没有」一起返回。
 * @returns {{ plan: object|null, path: string, error: string|null }} 结果。
 */
export function readPlanResult() {
  const path = planPath()
  if (!existsSync(path)) return { plan: null, path, error: null }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return { plan: null, path, error: '计划文件不是一个对象' }
    if (parsed.version !== PLAN_VERSION) return { plan: null, path, error: `计划版本 ${parsed.version} 不是 ${PLAN_VERSION}，拒绝猜测` }
    return { plan: parsed, path, error: null }
  } catch (error) {
    return { plan: null, path, error: `计划文件读不动：${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * 写重启计划。写的是整份文档：计划很小，而且「半份计划」比重写慢更危险。
 * @param {object} plan - 计划。
 * @returns {object} 写进去的那份。
 */
export function writePlan(plan) {
  ensureStateDir()
  writeFileSync(planPath(), `${JSON.stringify(plan, null, 2)}\n`, 'utf8')
  return plan
}

/**
 * 当前宿主进程的身份。
 *
 * `pid` 单独用不住：重启后新进程可能拿到同一个 pid。`bootEpochMs` 是「这个进程大约何时启动」，
 * 两个一起看才足以区分「同一个进程里的插件重载」和「真的换了进程」。
 * @returns {{ pid: number, ppid: number, execPath: string, bootEpochMs: number, node: string, platform: string }} 身份。
 */
export function hostIdentity() {
  return {
    pid: process.pid,
    ppid: process.ppid,
    execPath: process.execPath,
    bootEpochMs: BOOT_EPOCH_MS,
    node: process.version,
    platform: process.platform,
  }
}

/**
 * 两份宿主身份是不是同一个进程实例。
 * @param {object|undefined} a - 身份。
 * @param {object|undefined} b - 身份。
 * @returns {boolean} 同一个实例就是 true。
 */
export function sameBoot(a, b) {
  if (a === undefined || a === null || b === undefined || b === null) return false
  return a.pid === b.pid && a.bootEpochMs === b.bootEpochMs
}

/** 探桌面壳用的 PowerShell：问父进程是谁、exe 在哪、命令行长什么样。 */
function shellProbeScript(ppid) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$target = ${ppid}`,
    'try {',
    '  $p = Get-Process -Id $target -ErrorAction Stop',
    '  $exe = $p.Path',
    '  $cmd = $null',
    '  try { $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId = $target").CommandLine } catch { $cmd = $null }',
    '  [pscustomobject]@{ ok = $true; mainPid = $target; exe = $exe; commandLine = $cmd; name = $p.ProcessName } | ConvertTo-Json -Compress',
    '} catch {',
    '  [pscustomobject]@{ ok = $false; mainPid = $target; reason = $_.Exception.Message } | ConvertTo-Json -Compress',
    '}',
  ].join('\n')
}

/**
 * 找到桌面壳，并把「重启这件事涉及的两个进程」一起报出来。
 *
 * **先搞清楚这两个 pid 各是谁**（这一步曾经搞反过，代价是一次「重连中」）：
 *   - `shellPid` = `process.ppid` = Electron 主进程，也就是**桌面应用本身**；
 *   - `hostPid` = `process.pid` = 本插件所在的 **Host 子进程**（命令行带 `--expose-internals`）。
 *
 * `ctx.appExit(0)` 关的是**后者**：DSH 的启动器把它接成 Host 自己的关停（实测
 * `apps/cli/src/profile-boot.ts` 里 `exit: code => void shutdown.shutdown(code)`），
 * 桌面壳根本不会跟着退。所以「等主进程消失再拉起」等错了对象：Host 退出、后端消失、界面停在
 * 「重连中」，而壳还在，看门狗等满超时只能放弃。现在两个 pid 都记进计划，看门狗等 Host，
 * 再处理留下来的壳。
 *
 * 判定不靠猜：父进程的 exe 必须和本进程的 `process.execPath` 是同一个文件，而且它的命令行里
 * 不能带 `--expose-internals`（那是 Host 子进程的标志，不是壳主进程的）。跑在 headless 的
 * `dsh` CLI 里时父进程是终端，这两条都过不了——那时重启就该被拒绝，而不是退出去回不来。
 * @param {object} [deps] - `{ exec }`，测试用来避免真的去问 Windows。
 * @returns {Promise<object>} `{ ok, shellPid, hostPid, exe, commandLine, reason, evidence }`。
 */
export async function probeDesktopShell(deps = {}) {
  // 「关掉谁」的答案不随平台变：hostPid 永远是本进程自己。
  const hostPid = process.pid
  if (process.platform !== 'win32') {
    return { ok: false, shellPid: null, hostPid, exe: null, reason: `桌面壳只存在于 Windows（当前平台 ${process.platform}）` }
  }
  const exec = typeof deps.exec === 'function' ? deps.exec : run
  const ppid = process.ppid
  let parsed = null
  let lastError = null
  for (const shell of POWERSHELL_CANDIDATES) {
    try {
      const result = await exec(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', shellProbeScript(ppid)], { maxBuffer: 1024 * 1024, timeout: 20_000, windowsHide: true, encoding: 'buffer' })
      parsed = parseJsonLine(`${result.stdout.toString('utf8')}\n${result.stderr.toString('utf8')}`)
      break
    } catch (error) {
      if (error?.code === 'ENOENT') { lastError = error; continue }
      parsed = parseJsonLine(`${(error?.stdout ?? Buffer.alloc(0)).toString('utf8')}\n${(error?.stderr ?? Buffer.alloc(0)).toString('utf8')}`)
      if (parsed !== null) break
      return { ok: false, shellPid: ppid, hostPid, exe: null, reason: `探测父进程失败：${error?.message ?? String(error)}` }
    }
  }
  if (parsed === null) {
    return { ok: false, shellPid: ppid, hostPid, exe: null, reason: `找不到可用的 PowerShell（试过 ${POWERSHELL_CANDIDATES.join(', ')}）：${lastError?.message ?? ''}` }
  }
  if (parsed.ok !== true) {
    return { ok: false, shellPid: ppid, hostPid, exe: null, reason: `父进程 ${ppid} 不在了：${parsed.reason ?? '未知'}` }
  }

  const exe = typeof parsed.exe === 'string' && parsed.exe !== '' ? parsed.exe : null
  const commandLine = typeof parsed.commandLine === 'string' ? parsed.commandLine : null
  const evidence = `父进程 ${ppid} 是 ${parsed.name ?? '?'}：${exe ?? '(拿不到 exe 路径)'}（本进程 pid ${hostPid} 是它的 Host 子进程）`
  if (exe === null) {
    return { ok: false, shellPid: ppid, hostPid, exe: null, commandLine, evidence, reason: '拿不到父进程的 exe 路径，重启后不知道要拉起什么' }
  }
  if (basename(exe).toLowerCase() !== basename(process.execPath).toLowerCase()) {
    return { ok: false, shellPid: ppid, hostPid, exe, commandLine, evidence, reason: `父进程的 exe（${basename(exe)}）不是本进程所在的桌面壳（${basename(process.execPath)}）——大概率跑在 headless 的 dsh CLI 里` }
  }
  if (commandLine !== null && commandLine.includes('--expose-internals')) {
    return { ok: false, shellPid: ppid, hostPid, exe, commandLine, evidence, reason: '父进程是另一个 Host 子进程，不是桌面壳主进程' }
  }
  return { ok: true, shellPid: ppid, hostPid, exe, commandLine, evidence, reason: null }
}

/** 把命令行参数按 Windows 规则加引号；只在真的需要时加。 */
function quoteArg(value) {
  const text = String(value)
  return text === '' || /[\s"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** 用 WMI 起进程的 PowerShell：命令行走 base64，免得嵌套引号在两层解析里被吃掉。 */
function wmiLaunchScript(base64CommandLine) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$cmd = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${base64CommandLine}'))`,
    'try {',
    '  $res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }',
    '  Start-Sleep -Milliseconds 400',
    '  $alive = $null -ne (Get-Process -Id $res.ProcessId -ErrorAction SilentlyContinue)',
    '  [pscustomobject]@{ ok = (($res.ReturnValue -eq 0) -and $alive); returnValue = $res.ReturnValue; pid = $res.ProcessId; alive = $alive } | ConvertTo-Json -Compress',
    '} catch {',
    '  [pscustomobject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress',
    '}',
  ].join('\n')
}

/**
 * 起一个「延时脚本」：等应用整棵树走干净（或到点把它收掉），然后重新拉起 exe。
 *
 * **它必须活在 DSH 的进程树之外**——应用一退，树内的一切都会被带走，那「谁来重启」就没有答案了。
 * 所以这里试两条路，先试更结实的那条：
 *
 *   1. **WMI**（`Win32_Process.Create`）：新进程的父亲是 WmiPrvSE，不在 DSH 的进程树里，因此即使
 *      桌面壳把子进程放进 kill-on-close 的 Job Object，它也收不走它。起来之后立刻回读 PID 确认活着。
 *   2. **detached spawn**：更简单，但只在壳没有那种 Job Object 时才够——所以它是退路，不是首选。
 *
 * 两条都不行就抛错：调用方会因此**不动这个应用**。宁可重启没发生，也不要关了回不来。
 *
 * 脚本里的 `killAfterSeconds` 是**实测逼出来的兜底**：关掉主窗口之后这个应用可能既不退也不报错
 * （实测进程树活了 90 秒以上），而一个「窗口没了但进程还在」的应用不是重启。所以给优雅退出留一段
 * 宽限，到点就收掉整棵树（同名进程全属于同一个应用实例），再拉起。
 * @param {object} spec - `{ shellPid, hostPid, exe, waitSeconds, settleMs, killAfterSeconds }`。
 * @param {object} [deps] - `{ exec, spawn, launchViaWmi }`，测试用。
 * @returns {Promise<{ pid: number|null, method: string, logPath: string, script: string, shell: string, attempts: object[] }>} 脚本事实。
 * @throws {Error} 脚本不存在，或两条路都起不来时。
 */
export async function spawnRelauncher(spec, deps = {}) {
  if (!existsSync(RELAUNCH_SCRIPT)) throw new Error(`dsh-controller: 找不到延时脚本 ${RELAUNCH_SCRIPT}`)
  ensureStateDir()
  const logPath = watcherLogPath()
  const cliArgs = [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
    '-File', RELAUNCH_SCRIPT,
    '-Exe', String(spec.exe),
    '-LogPath', logPath,
    '-WaitSeconds', String(Math.max(1, Math.round(spec.waitSeconds ?? 120))),
    '-SettleMs', String(Math.max(0, Math.round(spec.settleMs ?? 1500))),
    '-ShellPid', String(spec.shellPid ?? 0),
    '-KillAfterSeconds', String(Math.max(0, Math.round(spec.killAfterSeconds ?? 10))),
  ]
  const exec = typeof deps.exec === 'function' ? deps.exec : run
  const start = typeof deps.spawn === 'function' ? deps.spawn : spawn
  const attempts = []
  const shells = typeof deps.shells === 'function' ? deps.shells() : POWERSHELL_CANDIDATES

  for (const shell of shells) {
    // 路 1：WMI —— 脱离 DSH 的进程树。
    if (deps.launchViaWmi !== false) {
      const commandLine = [shell, ...cliArgs.map(quoteArg)].join(' ')
      const base64 = Buffer.from(commandLine, 'utf8').toString('base64')
      try {
        const result = await exec(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', wmiLaunchScript(base64)], { maxBuffer: 1024 * 1024, timeout: 30_000, windowsHide: true, encoding: 'buffer' })
        const parsed = parseJsonLine(`${result.stdout.toString('utf8')}\n${result.stderr.toString('utf8')}`)
        attempts.push({ method: 'wmi', shell, ok: parsed?.ok === true, pid: parsed?.pid ?? null, detail: parsed?.error ?? (parsed === null ? '没有可解析的输出' : null) })
        if (parsed?.ok === true) {
          return { pid: parsed.pid ?? null, method: 'wmi', logPath, script: RELAUNCH_SCRIPT, shell, attempts }
        }
      } catch (error) {
        if (error?.code === 'ENOENT') { attempts.push({ method: 'wmi', shell, ok: false, detail: 'ENOENT' }); continue }
        attempts.push({ method: 'wmi', shell, ok: false, detail: error?.message ?? String(error) })
      }
    }

    // 路 2：detached spawn。
    try {
      const child = start(shell, cliArgs, { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref?.()
      attempts.push({ method: 'detached', shell, ok: child.pid !== undefined, pid: child.pid ?? null })
      return { pid: child.pid ?? null, method: 'detached', logPath, script: RELAUNCH_SCRIPT, shell, attempts }
    } catch (error) {
      if (error?.code === 'ENOENT') { attempts.push({ method: 'detached', shell, ok: false, detail: 'ENOENT' }); continue }
      attempts.push({ method: 'detached', shell, ok: false, detail: error?.message ?? String(error) })
    }
  }

  const detail = attempts.map((entry) => `${entry.method}/${entry.shell}: ${entry.detail ?? '失败'}`).join('；')
  throw new Error(`dsh-controller: 延时脚本起不来（WMI 与 detached 都试过了）：${detail}`)
}

/**
 * 看门狗还在吗？退出前问一次。
 *
 * 一个已经死掉的看门狗等于「退出去就回不来」，所以 `false` 会让调用方取消退出。
 * 问不出来（没有 PowerShell、命令超时）返回 `null`——**不知道**不该被当成**不在**。
 * @param {number} pid - 看门狗进程 id。
 * @param {object} [deps] - `{ exec }`，测试用。
 * @returns {Promise<boolean|null>} 活着 / 不在了 / 不知道。
 */
export async function probeWatcherAlive(pid, deps = {}) {
  if (!Number.isFinite(pid)) return null
  const exec = typeof deps.exec === 'function' ? deps.exec : run
  const script = `[pscustomobject]@{ alive = ($null -ne (Get-Process -Id ${Math.round(pid)} -ErrorAction SilentlyContinue)) } | ConvertTo-Json -Compress`
  for (const shell of POWERSHELL_CANDIDATES) {
    try {
      const result = await exec(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { maxBuffer: 1024 * 1024, timeout: 15_000, windowsHide: true, encoding: 'buffer' })
      const parsed = parseJsonLine(`${result.stdout.toString('utf8')}\n${result.stderr.toString('utf8')}`)
      if (parsed === null) return null
      return parsed.alive === true
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      return null
    }
  }
  return null
}

/**
 * 读看门狗日志的尾部。
 * @param {string} path - 日志路径。
 * @param {number} [maxLines] - 最多几行。
 * @returns {{ path: string, exists: boolean, lines: string[] }} 日志尾部。
 */
export function readLogTail(path, maxLines = 12) {
  if (!existsSync(path)) return { path, exists: false, lines: [] }
  try {
    const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter((line) => line !== '')
    return { path, exists: true, lines: lines.slice(-Math.max(1, maxLines)) }
  } catch (error) {
    return { path, exists: true, lines: [`(读不动：${error instanceof Error ? error.message : String(error)})`] }
  }
}
