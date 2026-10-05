/**
 * 事实用例：每一条都来自这台机器上**实测出来的事实**，不是想象出来的场景。
 *
 * 这个文件存在的理由：本插件对「应用会怎么退、会话会怎么断」的每一个判断，都曾经判断错过一次
 * （`ctx.appExit` 只关 Host、关窗不退、托盘图标不可发现、快照能卡五分钟）。把那些结论写成用例，
 * 下一次改动就不可能悄悄把它们推翻——尤其是最后那两条真机集成用例：它们真的起一个替身进程、
 * 真的让 `relaunch-watch.ps1` 去收树和拉起，这是插件里唯一「会动这台机器」的部分。
 *
 * @module dsh-controller/tests/facts
 */
import { strict as assert } from 'node:assert'
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { adapter } from '../src/host/services.mjs'
import { RELAUNCH_SCRIPT, hostIdentity, probeDesktopShell } from '../src/host/restart.mjs'
import { PLUGIN_ROOT, normalizeConfig } from '../index.mjs'

const WIN = process.platform === 'win32'

/** 一个假的桌面壳探测结果：父进程的 exe 与本进程相同。 */
function shellProbeOutput(overrides = {}) {
  return JSON.stringify({
    ok: true,
    mainPid: process.ppid,
    exe: process.execPath,
    commandLine: `"${process.execPath}"`,
    name: 'DeepSeek Harness',
    ...overrides,
  })
}

/** 把一次探测的 PowerShell 输出包成 `exec` 依赖。 */
function probeWith(text, options = {}) {
  let calls = 0
  return {
    get calls() { return calls },
    exec: async () => {
      calls += 1
      if (options.enoentFirst === true && calls === 1) {
        const error = new Error('spawn pwsh.exe ENOENT')
        error.code = 'ENOENT'
        throw error
      }
      if (options.throwInstead === true) throw new Error(options.message ?? 'boom')
      return { stdout: Buffer.from(`${text}\n`, 'utf8'), stderr: Buffer.alloc(0) }
    },
  }
}

test('事实：桌面壳探测同时报出 shellPid 与 hostPid（`appExit` 关的是后者）', async () => {
  if (!WIN) return
  const deps = probeWith(shellProbeOutput())
  const result = await probeDesktopShell({ exec: deps.exec })
  assert.equal(result.ok, true)
  assert.equal(result.shellPid, process.ppid, 'shellPid 必须是父进程：桌面应用本身')
  assert.equal(result.hostPid, process.pid, 'hostPid 必须是本进程：ctx.appExit 关掉的那个')
  assert.equal(typeof result.evidence, 'string')
})

test('事实：headless（父进程不是同一个 exe）必须被拒绝，而不是赌一把', async () => {
  if (!WIN) return
  const result = await probeDesktopShell({ exec: probeWith(shellProbeOutput({ exe: 'C:\\Windows\\System32\\cmd.exe', name: 'cmd' })).exec })
  assert.equal(result.ok, false)
  assert.match(result.reason, /不是本进程所在的桌面壳/)
  assert.equal(result.shellPid, process.ppid)
  assert.equal(result.hostPid, process.pid)
})

test('事实：父进程是另一个 Host 子进程（命令行带 --expose-internals）也必须被拒绝', async () => {
  if (!WIN) return
  const result = await probeDesktopShell({ exec: probeWith(shellProbeOutput({ commandLine: `"${process.execPath}" --expose-internals x.js` })).exec })
  assert.equal(result.ok, false)
  assert.match(result.reason, /Host 子进程/)
})

test('事实：父进程已经不在了 / 拿不到 exe 路径时，都给出可读的拒绝理由', async () => {
  if (!WIN) return
  const gone = await probeDesktopShell({ exec: probeWith(JSON.stringify({ ok: false, mainPid: process.ppid, reason: 'no such process' })).exec })
  assert.equal(gone.ok, false)
  assert.match(gone.reason, /不在了/)

  const noExe = await probeDesktopShell({ exec: probeWith(shellProbeOutput({ exe: '' })).exec })
  assert.equal(noExe.ok, false)
  assert.match(noExe.reason, /exe 路径/)
})

test('事实：pwsh 缺席（ENOENT）时退回 Windows PowerShell，而不是直接失败', async () => {
  if (!WIN) return
  const deps = probeWith(shellProbeOutput(), { enoentFirst: true })
  const result = await probeDesktopShell({ exec: deps.exec })
  assert.equal(result.ok, true, '本机没有 pwsh.exe，实测它必然走这条路')
  assert.equal(deps.calls, 2)
})

// ---------------------------------------------------------------------------
// 会话侧的事实：调用者不能立刻被中止（中止它会把本次工具结果一起带走）
// ---------------------------------------------------------------------------

/** 一个可控的假 agent。 */
function fakeAgent(id) {
  return {
    id,
    status: 'running',
    session: { id, header: { cwd: 'C:\\w' } },
    cancelCalls: [],
    followupCalls: [],
    cancel(cause, options) { this.cancelCalls.push({ cause, options }) },
    followup(message) { this.followupCalls.push(message) },
    whenIdle() { return Promise.resolve() },
  }
}

/** 假宿主上下文。 */
function contextWith(services) {
  return { get: (name) => services[name] }
}

/** 两条在跑的会话，返回 ctx 与 agents。 */
function twoRunning(idA = 'session-a') {
  const agents = new Map([[idA, fakeAgent(idA)], ['session-b', fakeAgent('session-b')]])
  const ctx = contextWith({
    sessionController: {
      list: () => [
        { sessionId: idA, running: true, agentAvailable: true, blank: false, cwd: 'C:\\a', updatedAt: 2 },
        { sessionId: 'session-b', running: true, agentAvailable: true, blank: false, cwd: 'C:\\b', updatedAt: 1 },
      ],
    },
    agents: { get: (id) => agents.get(id) },
  })
  return { ctx, agents }
}

test('事实：宿主没有 ctx.appExit 时 restart 照样能跑（旧版本会在这里拒绝）', async () => {
  // 实测：ctx.appExit 关的是 Host 子进程，桌面应用根本不会跟着退。所以它**不该**是重启的前提。
  const { ctx } = twoRunning()
  assert.equal(ctx.get('appExit'), undefined)
  const host = adapter(ctx, normalizeConfig(undefined), {
    probeShell: async () => ({ ok: true, shellPid: 1, hostPid: 2, exe: 'C:\\app\\a.exe', evidence: 'ok' }),
    startRelauncher: () => ({ pid: 3, method: 'wmi', logPath: 'l', script: 's', shell: 'powershell.exe' }),
    writePlan: (plan) => plan,
    later: () => ({ unref() {} }),
  })
  const result = await host.restartHost({})
  assert.equal(result.transport, 'api')
  assert.equal(result.watcher.pid, 3)
})

test('事实：pause-all 不碰调用者自己那条——它会被留到交接前一刻', async () => {
  const { ctx, agents } = twoRunning()
  const host = adapter(ctx, normalizeConfig(undefined))
  const result = await host.pauseAll({ callerSessionId: 'session-a' })
  assert.deepEqual(result.cancelled.map((entry) => entry.sessionId), ['session-b'])
  assert.deepEqual(result.deferred.map((entry) => entry.sessionId), ['session-a'])
  assert.equal(agents.get('session-a').cancelCalls.length, 0)
})

test('事实：调用者自己没在跑时，deferred 是空的而不是把它算进去', async () => {
  const { ctx } = twoRunning()
  const host = adapter(ctx, normalizeConfig(undefined))
  const result = await host.pauseAll({ callerSessionId: 'session-not-running' })
  assert.equal(result.requested, 2)
  assert.equal(result.cancelled.length, 2)
  assert.deepEqual(result.deferred, [])
})

test('事实：没有会话在跑时 pause-all 返回零，而不是抛错', async () => {
  const host = adapter(contextWith({ sessionController: { list: () => [] } }), normalizeConfig(undefined))
  const result = await host.pauseAll({})
  assert.equal(result.requested, 0)
  assert.deepEqual(result.cancelled, [])
})

test('事实：恢复腿的投递上限与跳过名单要如实报出来', async () => {
  const agents = new Map([['s1', fakeAgent('s1')], ['s2', fakeAgent('s2')], ['s3', fakeAgent('s3')]])
  const plan = {
    version: 1,
    state: 'armed',
    createdAtMs: 1000,
    writer: { pid: 1, bootEpochMs: 1 },
    resume: { text: '继续', max: 2 },
    sessions: [{ sessionId: 's1' }, { sessionId: 's2' }, { sessionId: 's3' }],
    outcomes: [],
  }
  const host = adapter(contextWith({
    sessionController: { resolveAgent: async (id) => ({ agent: agents.get(id) }) },
    sessions: { flush: async () => true },
  }), normalizeConfig({ restart: { maxResume: 2 } }), {
    readPlan: () => ({ plan: JSON.parse(JSON.stringify(plan)), path: 'p', error: null }),
    writePlan: (next) => next,
    now: () => 2000,
  })

  const result = await host.resumeAfterRestart()
  assert.equal(result.state, 'done')
  assert.equal(result.resumed, 2)
  assert.equal(result.requested, 3)
  assert.deepEqual(result.skipped, ['s3'], '超上限的那条要出现在 skipped 里，不能悄悄丢掉')
  assert.equal(agents.get('s3').followupCalls.length, 0)
})

test('事实：force 可以重跑「当前进程写的」计划（手动补救用），默认不行', async () => {
  const agent = fakeAgent('s1')
  const plan = {
    version: 1,
    state: 'armed',
    createdAtMs: 1000,
    // writer 就是当前进程：这正是「插件热重载 / 退出还没发生」的样子。
    writer: hostIdentity(),
    resume: { text: '继续', max: 20 },
    sessions: [{ sessionId: 's1' }],
    outcomes: [],
  }
  const host = adapter(contextWith({
    sessionController: { resolveAgent: async () => ({ agent }) },
    sessions: { flush: async () => true },
  }), normalizeConfig(undefined), {
    readPlan: () => ({ plan: JSON.parse(JSON.stringify(plan)), path: 'p', error: null }),
    writePlan: (next) => next,
    now: () => 2000,
  })

  const refused = await host.resumeAfterRestart()
  assert.equal(refused.state, 'same-boot')
  assert.equal(agent.followupCalls.length, 0, '同一次启动写下的计划默认不重投')

  const forced = await host.resumeAfterRestart({ force: true })
  assert.equal(forced.state, 'done')
  assert.equal(agent.followupCalls.length, 1)
})

// ---------------------------------------------------------------------------
// 真机集成：延时脚本是插件里唯一「会动这台机器」的部分，它必须按事实干活
// ---------------------------------------------------------------------------

/**
 * 造一个替身应用：把系统里的 powershell.exe 复制成 `<dir>\\fakeapp.exe` 再跑起来。
 *
 * 用**文件名**做替身是有原因的：脚本判断「应用还在不在」靠的是 `Get-Process -Name <exe 基名>`，
 * 而 Windows 的进程名就来自可执行文件的文件名——所以改个名字就得到一个可以被脚本当成「应用」
 * 收掉的进程，且不需要往这台机器上装任何东西。
 * @returns {{ exe: string, dir: string, kill: () => void }} 替身事实。
 */
function fakeApp() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-controller-fakeapp-'))
  const exe = join(dir, 'fakeapp.exe')
  copyFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), exe)
  const child = spawn(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 120'], { stdio: 'ignore', windowsHide: true })
  child.unref()
  const kill = () => { spawnSync('taskkill', ['/IM', 'fakeapp.exe', '/F'], { windowsHide: true }) }
  // 等它真的出现在进程表里：脚本按名字找进程，早一步就等于没有替身。
  const deadline = Date.now() + 10_000
  let listed = ''
  while (Date.now() < deadline) {
    const probe = spawnSync('tasklist', ['/FI', 'IMAGENAME eq fakeapp.exe', '/NH'], { encoding: 'utf8', windowsHide: true })
    listed = probe.stdout ?? ''
    if (listed.includes('fakeapp.exe')) break
    spawnSync('ping', ['-n', '1', '-w', '200', '127.0.0.1'], { stdio: 'ignore', windowsHide: true })
  }
  // 替身起不来就不该假装测过：交给调用方 skip，并把原因说清楚。
  if (!listed.includes('fakeapp.exe')) {
    kill()
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 })
    throw new Error('替身进程 fakeapp.exe 没能起来（复制 powershell.exe 被拦？）')
  }
  return { exe, dir, kill }
}

/** 跑一次延时脚本，返回它写下的日志。 */
function runRelauncher(args) {
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', RELAUNCH_SCRIPT, ...args,
  ], { encoding: 'utf8', timeout: 60_000, windowsHide: true })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

test('事实：延时脚本到点收掉整棵树并拉起 exe（KillAfterSeconds=0，今天真机上走过的那条路）', { skip: !WIN }, (t) => {
  let app
  try { app = fakeApp() } catch (error) { t.skip(String(error.message)); return }
  const log = join(app.dir, 'relaunch.log')
  try {
    const run = runRelauncher(['-Exe', app.exe, '-LogPath', log, '-WaitSeconds', '60', '-SettleMs', '200', '-KillAfterSeconds', '0'])
    const text = existsSync(log) ? readFileSync(log, 'utf8') : ''
    assert.match(text, /relauncher start/, `脚本没写日志：${run.stderr}`)
    assert.match(text, /stopping them so the app can actually restart/, '到点必须由脚本自己收树')
    assert.match(text, /stopped pid \d+/, '收树要逐条留痕')
    assert.match(text, /no fakeapp process left/)
    assert.match(text, /relaunched: pid \d+/, '收干净之后必须真的拉起')
  } finally {
    app.kill()
    // Windows 释放 exe 文件句柄是异步的：刚 taskkill 完立刻删目录会 EPERM。
    rmSync(app.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 })
  }
})

test('事实：树没走干净且没到收树点时必须放弃，绝不启动第二个实例', { skip: !WIN }, (t) => {
  let app
  try { app = fakeApp() } catch (error) { t.skip(String(error.message)); return }
  const log = join(app.dir, 'relaunch.log')
  try {
    // 等 2 秒就放弃，收树点放到很后面：脚本只该写 give up，不该启动任何东西。
    const run = runRelauncher(['-Exe', app.exe, '-LogPath', log, '-WaitSeconds', '2', '-SettleMs', '200', '-KillAfterSeconds', '300'])
    const text = existsSync(log) ? readFileSync(log, 'utf8') : ''
    assert.match(text, /give up: \d+ process\(es\) named fakeapp are still running after 2s/)
    assert.doesNotMatch(text, /relaunched/)
    assert.notEqual(run.status, 0, '放弃必须是非零退出码，调用方才看得见')
  } finally {
    app.kill()
    // Windows 释放 exe 文件句柄是异步的：刚 taskkill 完立刻删目录会 EPERM。
    rmSync(app.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 })
  }
})

test('事实：脚本在 DSH 的进程树之外（WMI 起，父进程不是本进程）', async () => {
  if (!WIN) return
  const { spawnRelauncher } = await import('../src/host/restart.mjs')
  const calls = []
  const watcher = await spawnRelauncher(
    { shellPid: 1, exe: 'C:\\app\\a.exe', waitSeconds: 5, settleMs: 1, killAfterSeconds: 2 },
    {
      shells: () => ['powershell.exe'],
      exec: async () => ({ stdout: Buffer.from(JSON.stringify({ ok: true, returnValue: 0, pid: 4242, alive: true }), 'utf8'), stderr: Buffer.alloc(0) }),
      spawn: (...args) => { calls.push(args); return { pid: 1, unref() {} } },
    },
  )
  assert.equal(watcher.method, 'wmi')
  assert.deepEqual(calls, [], 'WMI 成功就不该再起一个 detached 的')
})

test('事实：插件的脚本文件都在仓库里，装机后不会指到一个不存在的路径', () => {
  assert.ok(existsSync(RELAUNCH_SCRIPT), `延时脚本必须在：${RELAUNCH_SCRIPT}`)
  assert.ok(RELAUNCH_SCRIPT.startsWith(PLUGIN_ROOT), '脚本必须来自插件自己的目录')
})
