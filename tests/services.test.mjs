import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import zlib from 'node:zlib'
import { adapter, probe, userMessage } from '../src/host/services.mjs'
import { hostIdentity } from '../src/host/restart.mjs'
import { normalizeConfig } from '../index.mjs'

/**
 * 每一次 adapter 都带上一根「托盘退出的替身」。
 *
 * 优雅退出那一腿会真的动鼠标、真的把宿主应用关掉：一条没有注入它的 restartHost 用例，跑起来就等于
 * 关掉正在跑测试的这个应用。2026-10-05 真的发生过一次——`node --test "tests/*.test.mjs"` 悬停、
 * 右键、读菜单、点确认，应用在 21:13:50 退出，那一轮测试也跟着没了。所以替身放在这里，而不是指望
 * 每一条用例自己记得注入。运行时另有一道守卫（`testRunRefusal`）兜底，两道都留着。
 *
 * 需要断言这一腿的用例可以读 `quitCalls`；需要另造行为的用例照旧自己传 `deps.quitViaTray`，
 * 它排在展开的后面，会覆盖这个替身。
 */
const quitCalls = []
const safeAdapter = (ctx, config, deps = {}) => adapter(ctx, config, {
  quitViaTray: async (spec) => {
    quitCalls.push(spec)
    return {
      attempted: true,
      clicked: true,
      item: { text: spec?.item ?? '退出' },
      at: { x: 0, y: 0 },
      menuClosed: true,
      mode: 'matched',
      attempts: [],
      elapsedMs: 0,
    }
  },
  ...deps,
})

/** 造一段和会话日志同构的字节：若干独立 zstd 帧直接拼接（和 sessionlog.test.mjs 同款）。 */
function buildLog(frames) {
  return Buffer.concat(frames.map((lines) => zlib.zstdCompressSync(Buffer.from(lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8'))))
}

/** 在一个临时 DSH home 里跑一段代码，跑完把目录和两个环境变量都还原。 */
async function withTempHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-controller-home-'))
  const savedHome = process.env.DSH_HOME
  const savedProfileDir = process.env.DSH_PROFILE_DIR
  try {
    process.env.DSH_HOME = home
    delete process.env.DSH_PROFILE_DIR
    return await fn(home)
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedHome
    if (savedProfileDir === undefined) delete process.env.DSH_PROFILE_DIR; else process.env.DSH_PROFILE_DIR = savedProfileDir
    rmSync(home, { recursive: true, force: true })
  }
}

/** 一个可控的假宿主：只需要给 `get(name)`，就当作真的服务树。 */
function contextWith(services) {
  return { get: (name) => services[name] }
}

/** 一条假的 live agent。 */
function fakeAgent(overrides = {}) {
  return {
    id: overrides.id ?? 'session-1',
    status: overrides.status ?? 'running',
    session: { id: overrides.id ?? 'session-1', header: { cwd: 'C:\\w', createdAt: 1, agentPreset: 'standard' } },
    followupCalls: [],
    steerCalls: [],
    injectCalls: [],
    cancelCalls: [],
    followup(message) { this.followupCalls.push(message) },
    steer(message) { this.steerCalls.push(message) },
    inject(message) { this.injectCalls.push(message) },
    cancel(cause, options) { this.cancelCalls.push({ cause, options }) },
    whenIdle() { return overrides.idlePromise ?? Promise.resolve() },
  }
}

test('probe 对缺失服务给出证据，对存在的服务给出类型', () => {
  const agent = fakeAgent()
  const result = probe(contextWith({ agents: { get: () => agent } }))
  const agents = result.api.find((entry) => entry.service === 'agents')
  const sessions = result.api.find((entry) => entry.service === 'sessions')
  assert.equal(agents.available, true)
  assert.match(agents.evidence, /返回 Object/)
  assert.equal(sessions.available, false)
  assert.match(sessions.evidence, /没有装配/)
  // UI 通道：Windows 上 PowerShell 可用，没装 computer-use 时明确说明。
  assert.equal(result.ui.find((channel) => channel.channel === 'powershell').available, process.platform === 'win32')
})

test('probe 在 ctx.get 抛错时不炸，而是把错误写成证据', () => {
  const result = probe({ get: () => { throw new Error('boom') } })
  assert.ok(result.api.every((entry) => entry.available === false))
  assert.match(result.api[0].evidence, /抛错：boom/)
})

test('listSessions 走 sessionController.list，并把 running 带出来', async () => {
  const host = safeAdapter(contextWith({
    sessionController: { list: () => [
      { sessionId: 'a', running: true, agentAvailable: true, blank: false, cwd: 'C:\\a', updatedAt: 10 },
      { sessionId: 'b', running: false, agentAvailable: false, blank: true, cwd: 'C:\\b', updatedAt: 20 },
    ] },
  }), normalizeConfig(undefined))

  const rows = await host.listSessions({ workspace: 'all', limit: 10 })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].sessionId, 'b', 'updatedAt 大的排前面')
  assert.equal(rows[1].state, 'RUNNING')
  assert.equal(rows[1].source, 'api:sessionController.list')
})

test('listSessions 在没有任何会话服务时退回磁盘，并且明说这件事', async () => {
  // 这条用例必须有自己的 DSH home：磁盘回退读的是真实 `~/.dsh`，否则它会去读这台机器上
  // 全部会话日志（实测 476 条 = 12s），既慢又依赖机器状态。
  await withTempHome(async (home) => {
    const sessionDir = join(home, 'sessions', '--C-w--', 'session-disk')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'session.v4.jsonl.zstd'), buildLog([
      [{ type: 'turn/start', seq: 1, data: { turn: 1 } }],
    ]))

    const warnings = []
    const host = safeAdapter(contextWith({}), normalizeConfig(undefined))
    const rows = await host.listSessions({ workspace: 'all' }, warnings)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].source, 'disk:sessions')
    assert.equal(rows[0].state, 'RUNNING', '磁盘状态是从日志里读出来的，不是元数据编的')
    assert.ok(warnings.some((warning) => warning.includes('退回磁盘扫描')))
  })
})

test('getSession 在没有 sessionQuery.readSession 时从磁盘兜底读，而不是抛错', async () => {
  // 这条用例守的是「磁盘兜底分支」：它曾经引用了一个已被改名的内部函数（`logsBySession`），
  // 而那是一个只在运行期才会炸的悬空引用——所有用例都从别的分支走过去了，所以谁都没发现。
  await withTempHome(async (home) => {
    const sessionDir = join(home, 'sessions', '--C-w--', 'session-disk')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'session.v4.jsonl.zstd'), buildLog([
      [{ type: 'session', id: 'session-disk', cwd: 'C:\\w' }],
      [{ type: 'turn/start', seq: 1, data: { turn: 1 } }],
    ]))

    const host = safeAdapter(contextWith({}), normalizeConfig(undefined))
    const detail = await host.getSession({ sessionId: 'session-disk', tail: 5 })
    assert.equal(detail.sessionId, 'session-disk')
    assert.equal(detail.events.length, 2, '磁盘兜底要把事件读出来')
    assert.equal(detail.header?.id, 'session-disk', 'header 从日志里的 session 事件补出来')
  })
})

test('listSessions 的磁盘富化只发生在要返回的行上（先裁剪、再读磁盘）', async () => {
  await withTempHome(async (home) => {
    const workspaceDir = join(home, 'sessions', '--C-w--')
    // 三行里只有 updatedAt 最大的那一行会进结果；只为它建日志，另两行没有日志也不该出错。
    mkdirSync(join(workspaceDir, 'session-newest'), { recursive: true })
    writeFileSync(join(workspaceDir, 'session-newest', 'session.v4.jsonl.zstd'), buildLog([
      [{ type: 'turn/start', seq: 1, data: { turn: 1 } }],
    ]))
    const host = safeAdapter(contextWith({
      sessionController: {
        list: () => [
          { sessionId: 'session-newest', running: false, blank: false, cwd: 'C:\\w', updatedAt: 30 },
          { sessionId: 'session-middle', running: false, blank: false, cwd: 'C:\\w', updatedAt: 20 },
          { sessionId: 'session-oldest', running: false, blank: false, cwd: 'C:\\w', updatedAt: 10 },
        ],
      },
    }), normalizeConfig(undefined))

    const rows = await host.listSessions({ workspace: 'all', limit: 1 })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].sessionId, 'session-newest')
    assert.equal(rows[0].source, 'api:sessionController.list')

    // `enrich: false` 时连这一行都不读磁盘：quietSec 保持 null 而不是被填上。
    const bare = await host.listSessions({ workspace: 'all', limit: 3, enrich: false })
    assert.equal(bare.length, 3)
    assert.ok(bare.every((row) => row.quietSec === null))
  })
})

test('listSessions 不按条调用 sessionQuery.readTitle：标题从投影缓存拿', async () => {
  // 这条用例守的是一个**性能正确性**问题，不是装饰：`readTitle(id)` 每次调用都会把全部持久化
  // 会话重新枚举一遍再整篇读那条日志，放进按条循环就是 478 × 478 次文件读（本机实测一次 list
  // 要 5 分 20 秒）。所以这里既断言它一次都没被调用，也断言标题照样出得来。
  await withTempHome(async (home) => {
    const workspaceDir = join(home, 'sessions', '--C-w--')
    for (const id of ['session-a', 'session-b']) {
      const dir = join(workspaceDir, id)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'session.v4.jsonl.zstd'), buildLog([
        [{ type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } }],
      ]))
    }
    const projectionDir = join(home, 'storages', 'session_projcache', 'sessions')
    mkdirSync(projectionDir, { recursive: true })
    writeFileSync(join(projectionDir, 'session-a.json'), JSON.stringify({
      version: 7,
      record: {
        identity: { formatVersion: 4, createdAt: 1, cwd: 'C:\\w' },
        rows: {
          turnBoundary: { ver: 2, seq: 3, val: { openTurnStartSeq: null, lastTurn: 1 } },
          title: { ver: 1, seq: 3, val: '只在投影里的标题' },
        },
      },
    }))

    let readTitleCalls = 0
    const host = safeAdapter(contextWith({
      sessionQuery: {
        listSessions: () => [
          { header: { id: 'session-a', cwd: 'C:\\w', createdAt: 20 } },
          { header: { id: 'session-b', cwd: 'C:\\w', createdAt: 10 } },
        ],
        readTitle: () => { readTitleCalls += 1; return { title: '从日志折出来的标题' } },
      },
    }), normalizeConfig(undefined))

    const rows = await host.listSessions({ workspace: 'all', limit: 2 })
    assert.equal(readTitleCalls, 0, 'readTitle 绝不允许出现在按条循环里')
    assert.equal(rows.length, 2)
    assert.equal(rows[0].sessionId, 'session-a', 'updatedAt 大的排前面')
    assert.equal(rows[0].title, '只在投影里的标题', '标题来自投影缓存，不是空着')
    assert.equal(rows[0].state, 'IDLE', '投影里的 turnBoundary 说了回合已经闭合')
    assert.equal(rows[0].source, 'api:sessionQuery.listSessions')
  })
})

test('sendToSession 投递一条 user 消息并确认落盘', async () => {
  const agent = fakeAgent()
  let flushed = null
  const host = safeAdapter(contextWith({
    sessionController: { resolveAgent: async () => ({ agent }) },
    sessions: { flush: async (session) => { flushed = session.id; return true } },
  }), normalizeConfig(undefined))

  const result = await host.sendToSession({ sessionId: 'session-1', text: '你好', mode: 'followup' })
  assert.equal(result.transport, 'api')
  assert.equal(agent.followupCalls.length, 1)
  assert.equal(agent.followupCalls[0].role, 'user')
  assert.equal(agent.followupCalls[0].content[0].text, '你好')
  assert.equal(agent.followupCalls[0].source.kind, 'cordis-host-runner')
  assert.ok(typeof agent.followupCalls[0].id === 'string' && agent.followupCalls[0].id.length > 0)
  assert.equal(flushed, 'session-1')
})

test('sendToSession 的三种模式走三个不同的方法', async () => {
  const agent = fakeAgent()
  const host = safeAdapter(contextWith({ sessionController: { resolveAgent: async () => ({ agent }) } }), normalizeConfig(undefined))
  await host.sendToSession({ sessionId: 's', text: 'a', mode: 'steer' })
  await host.sendToSession({ sessionId: 's', text: 'b', mode: 'inject' })
  assert.equal(agent.steerCalls.length, 1)
  assert.equal(agent.injectCalls.length, 1)
  assert.equal(agent.followupCalls.length, 0)
})

test('sendToSession 把 resolveAgent 的 error 变成可读的异常，而不是静默', async () => {
  const host = safeAdapter(contextWith({ sessionController: { resolveAgent: async () => ({ error: { message: '写锁被占' } }) } }), normalizeConfig(undefined))
  await assert.rejects(() => host.sendToSession({ sessionId: 's', text: 'x' }), /写锁被占/)
})

test('abortSession 用宿主自己的取消口径 cancel({kind:"user"})', async () => {
  const agent = fakeAgent()
  const host = safeAdapter(contextWith({ agents: { get: () => agent } }), normalizeConfig(undefined))
  await host.abortSession({ sessionId: 's' })
  assert.deepEqual(agent.cancelCalls[0].cause, { kind: 'user' })
  assert.equal(agent.cancelCalls[0].options, undefined)
  await host.abortSession({ sessionId: 's', keepInbox: true })
  assert.deepEqual(agent.cancelCalls[1].options, { keepInbox: true })
})

test('abortSession 对没有 live agent 的会话明确拒绝', async () => {
  const host = safeAdapter(contextWith({ agents: { get: () => undefined } }), normalizeConfig(undefined))
  await assert.rejects(() => host.abortSession({ sessionId: 'cold' }), /没有 live agent/)
})

test('waitIdle 把超时当结果返回，而不是抛错', async () => {
  const running = fakeAgent({ status: 'running', idlePromise: new Promise(() => {}) })
  const host = safeAdapter(contextWith({ agents: { get: () => running } }), normalizeConfig(undefined))
  const result = await host.waitIdle({ sessionId: 's', timeoutMs: 30 })
  assert.equal(result.reason, 'timeout')
  assert.equal(result.state, 'RUNNING')
  assert.ok(result.waitedMs >= 0)
})

test('waitIdle 对已经空闲的会话立刻返回', async () => {
  const idle = fakeAgent({ status: 'idle' })
  const host = safeAdapter(contextWith({ agents: { get: () => idle } }), normalizeConfig(undefined))
  const result = await host.waitIdle({ sessionId: 's' })
  assert.equal(result.reason, 'already-idle')
  assert.equal(result.state, 'IDLE')
})

/** 一个假的桌面通道：把 `runDesktop` 的调用记下来，按脚本返回预置结果。 */
function fakeDesktop(script) {
  const calls = []
  const run = async (action, args) => {
    calls.push({ action, args })
    return script(action, args, calls.length)
  }
  return { run, calls }
}

test('createSession 用 sessionController.create + resolveAgent + followup', async () => {
  const agent = fakeAgent({ id: 'session-new' })
  const created = []
  const host = safeAdapter(contextWith({
    sessionController: {
      create: async (request) => { created.push(request); return { sessionId: request.sessionId ?? 'session-new', agentPreset: 'standard' } },
      resolveAgent: async () => ({ agent }),
    },
    sessions: { flush: async () => true },
  }), normalizeConfig(undefined))

  const result = await host.createSession({ text: '开工', cwd: 'C:\\work', via: 'api' })
  assert.equal(result.transport, 'api')
  assert.equal(result.sessionId, 'session-new')
  assert.equal(created[0].cwd, 'C:\\work')
  assert.equal(agent.followupCalls.length, 1)
  assert.equal(agent.followupCalls[0].content[0].text, '开工')
})

test('createSessionViaApi 在没有会话服务时拒绝，而不是偷偷去点 GUI', async () => {
  const host = safeAdapter(contextWith({}), normalizeConfig(undefined))
  await assert.rejects(() => host.createSessionViaApi({ text: 'x', cwd: 'C:\\w' }), /无法新建会话/)
})

test('createSession 默认先试 GUI，GUI 失败才退回 API，并把原因写进 fallback', async () => {
  const agent = fakeAgent({ id: 'session-api' })
  const desktop = fakeDesktop(() => ({ ok: false, reason: 'window-not-found' }))
  const host = safeAdapter(contextWith({
    sessionController: {
      create: async () => ({ sessionId: 'session-api' }),
      resolveAgent: async () => ({ agent }),
    },
  }), normalizeConfig(undefined), { runDesktop: desktop.run })

  const result = await host.createSession({ text: '开工', cwd: 'C:\\work', via: 'auto' })
  assert.equal(result.transport, 'api', 'GUI 不可用时必须落到 API')
  assert.equal(result.sessionId, 'session-api')
  assert.equal(result.fallback.from, 'ui')
  assert.match(result.fallback.reason, /找不到可操作的 DSH 窗口/)
  assert.ok(result.warnings.some((warning) => warning.includes('GUI 新建会话失败，已退回 API')))
  assert.equal(agent.followupCalls.length, 1)
  assert.equal(desktop.calls[0].action, 'window', 'GUI 路的第一步是找窗口，不是瞎点')
})

test('createSession 的 GUI 路成功时一个 API 建会话都不调，会话来自列表差', async () => {
  const followups = []
  const agent = { id: 'gui-created', session: { id: 'gui-created' }, status: 'idle', followup: (message) => followups.push(message) }
  let listed = 0
  const desktop = fakeDesktop((action) => {
    if (action === 'window') return { ok: true, target: { handle: 1, title: 'DeepSeek Harness' } }
    return { ok: true, clicked: true, submitted: true, method: 'sendinput-unicode', sentChars: 3, pointerRestored: true }
  })
  const host = safeAdapter(contextWith({
    sessionController: {
      // 只有列表和投递可用；`create` 一旦被调用就说明路由错了。
      list: async () => {
        listed += 1
        return listed === 1
          ? [{ sessionId: 'old', running: false, blank: false, cwd: 'C:\\w', updatedAt: 1 }]
          : [{ sessionId: 'gui-created', running: true, blank: true, cwd: 'C:\\w', updatedAt: 99 }, { sessionId: 'old', running: false, blank: false, cwd: 'C:\\w', updatedAt: 1 }]
      },
      create: async () => { throw new Error('GUI 成功时不该再调 sessionController.create') },
      resolveAgent: async () => ({ agent }),
    },
    sessions: { flush: async () => true },
  }), normalizeConfig({ create: { waitMs: 4000, submitInGui: true } }), { runDesktop: desktop.run })

  const result = await host.createSession({ text: '你好', via: 'auto' })
  assert.equal(result.transport, 'ui')
  assert.equal(result.sessionId, 'gui-created', '认领的是点之前不存在的那条会话')
  assert.equal(result.detectedBy, 'list-diff')
  assert.equal(result.firstMessage, 'ui')
  assert.equal(followups.length, 0, '消息已经在 GUI 里发出去了，不该再投一遍')
  assert.deepEqual(desktop.calls.map((call) => call.action), ['window', 'new-session', 'new-session'])
})

test('GUI 建出了会话但第一条消息没送进去时，改由 API 投递而不是留下空会话', async () => {
  const followups = []
  const agent = { id: 'gui-created', session: { id: 'gui-created' }, status: 'idle', followup: (message) => followups.push(message) }
  let listed = 0
  const desktop = fakeDesktop((action, args, callIndex) => {
    if (action === 'window') return { ok: true, target: { handle: 1 } }
    if (callIndex === 2) return { ok: true, clicked: true } // 只是点开，不带 submit
    return { ok: false, reason: 'text-not-delivered', sentChars: 0 }
  })
  const host = safeAdapter(contextWith({
    sessionController: {
      list: async () => {
        listed += 1
        return listed === 1 ? [] : [{ sessionId: 'gui-created', running: false, blank: true, cwd: 'C:\\w', updatedAt: 50 }]
      },
      resolveAgent: async () => ({ agent }),
    },
    sessions: { flush: async () => true },
  }), normalizeConfig({ create: { waitMs: 4000, submitInGui: true } }), { runDesktop: desktop.run })

  const result = await host.createSession({ text: '你好', via: 'auto' })
  assert.equal(result.transport, 'ui')
  assert.equal(result.firstMessage, 'api')
  assert.equal(followups.length, 1)
  assert.equal(followups[0].content[0].text, '你好')
  assert.ok(result.warnings.some((warning) => warning.includes('GUI 送字失败')))
})

test('createSession 在 via:"api" 时完全不碰 GUI', async () => {
  const agent = fakeAgent({ id: 'session-api' })
  const desktop = fakeDesktop(() => { throw new Error('via:"api" 不该碰桌面通道') })
  const host = safeAdapter(contextWith({
    sessionController: {
      create: async () => ({ sessionId: 'session-api' }),
      resolveAgent: async () => ({ agent }),
    },
  }), normalizeConfig(undefined), { runDesktop: desktop.run })

  const result = await host.createSession({ text: '开工', via: 'api' })
  assert.equal(result.transport, 'api')
  assert.equal(result.fallback, undefined, 'via:"api" 不该留下回退痕迹')
  assert.equal(desktop.calls.length, 0)
})

test('createSession 在 via:"gui" 时宁可失败也不偷偷用 API', async () => {
  const desktop = fakeDesktop(() => ({ ok: false, reason: 'window-not-found' }))
  const host = safeAdapter(contextWith({
    sessionController: {
      create: async () => { throw new Error('via:"gui" 不该回退到 API') },
      resolveAgent: async () => ({ agent: fakeAgent({ id: 'session-api' }) }),
    },
  }), normalizeConfig(undefined), { runDesktop: desktop.run })

  await assert.rejects(() => host.createSession({ text: 'x', via: 'gui' }), /禁止回退到 API/)
})

test('pluginAction 在没有 pluginManager 时拒绝，并说明原因', async () => {
  const host = safeAdapter(contextWith({}), normalizeConfig(undefined))
  await assert.rejects(() => host.pluginAction('list', {}), /没有 pluginManager 服务/)
})

test('pluginAction list 与 enable 分别打到 listPlugins 和 setPluginEnabled', async () => {
  const calls = []
  const manager = {
    listPlugins: async () => { calls.push('listPlugins'); return [{ entryId: 'controller', moduleName: 'dsh-controller', enabled: true }] },
    listBundles: async () => { calls.push('listBundles'); return [{ name: 'dsh-controller', enabled: true }] },
    setPluginEnabled: async (id, enabled) => { calls.push(`setPluginEnabled:${id}:${enabled}`); return { changed: true, application: 'applied' } },
    setBundleEnabled: async (name, enabled) => { calls.push(`setBundleEnabled:${name}:${enabled}`); return { changed: true, application: 'restart-required' } },
  }
  const host = safeAdapter(contextWith({ pluginManager: manager }), normalizeConfig(undefined))

  const list = await host.pluginAction('list', {})
  assert.equal(list.plugins.length, 1)
  assert.ok(calls.includes('listPlugins') && calls.includes('listBundles'))

  const enableRow = await host.pluginAction('enable', { id: 'some-row' })
  assert.equal(enableRow.appliedAs, 'plugin-row')

  const enableBundle = await host.pluginAction('enable', { id: 'dsh-controller' })
  assert.equal(enableBundle.appliedAs, 'bundle')
  assert.equal(enableBundle.result.application, 'restart-required')
})

test('pluginLog 读 profile 下 .plugin-manager/logs，按时间倒序', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-controller-logs-'))
  const savedHome = process.env.DSH_HOME
  const savedDir = process.env.DSH_PROFILE_DIR
  try {
    process.env.DSH_HOME = home
    const profile = join(home, 'profiles', 'desktop')
    const older = join(profile, '.plugin-manager', 'logs', 'operation-aaa')
    const newer = join(profile, '.plugin-manager', 'logs', 'operation-bbb')
    mkdirSync(older, { recursive: true })
    mkdirSync(newer, { recursive: true })
    writeFileSync(join(older, 'pnpm.log'), '+ old link:C:\\old\n')
    writeFileSync(join(newer, 'pnpm.log'), '+ dsh-controller link:C:\\Users\\Admin\\Documents\\GitHub\\dsh-plugins\\dsh-controller\n')
    process.env.DSH_PROFILE_DIR = profile

    const host = safeAdapter(contextWith({}), normalizeConfig(undefined))
    const result = host.pluginLog({ limit: 2 })
    assert.equal(result.transport, 'disk')
    assert.ok(result.entries.length >= 1)
    assert.ok(result.entries.some((entry) => entry.tail.includes('dsh-controller')))
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedHome
    if (savedDir === undefined) delete process.env.DSH_PROFILE_DIR; else process.env.DSH_PROFILE_DIR = savedDir
    rmSync(home, { recursive: true, force: true })
  }
})

test('userMessage 是宿主能收下的字面量形状', () => {
  const message = userMessage('hi')
  assert.equal(message.role, 'user')
  assert.deepEqual(message.content, [{ type: 'text', text: 'hi' }])
  assert.equal(message.source.kind, 'cordis-host-runner')
  assert.ok(message.id.length > 0)
})

/**
 * 造一个「两个会话在跑」的宿主：session-b 是被中止的那个，session-a 通常扮演调用者。
 */
function twoRunningSessions() {
  const agents = new Map([
    ['session-a', fakeAgent({ id: 'session-a' })],
    ['session-b', fakeAgent({ id: 'session-b' })],
  ])
  const ctx = contextWith({
    appExit: () => {},
    sessionController: {
      list: () => [
        { sessionId: 'session-a', running: true, agentAvailable: true, blank: false, cwd: 'C:\\a', updatedAt: 2 },
        { sessionId: 'session-b', running: true, agentAvailable: true, blank: false, cwd: 'C:\\b', updatedAt: 1 },
      ],
    },
    agents: { get: (id) => agents.get(id) },
  })
  return { ctx, agents }
}

test('pauseAll 中止所有在跑的会话，但把调用者自己那条留在 deferred 里', async () => {
  const { ctx, agents } = twoRunningSessions()
  const host = safeAdapter(ctx, normalizeConfig(undefined))

  const result = await host.pauseAll({ callerSessionId: 'session-a' })
  assert.equal(result.transport, 'api')
  assert.equal(result.requested, 2)
  assert.deepEqual(result.cancelled.map((entry) => entry.sessionId), ['session-b'])
  assert.deepEqual(result.deferred.map((entry) => entry.sessionId), ['session-a'])
  assert.equal(agents.get('session-b').cancelCalls.length, 1)
  assert.equal(agents.get('session-a').cancelCalls.length, 0, '中止调用者会把本次工具结果一起带走')
  assert.match(result.deferred[0].reason, /发起调用/)
})

test('pauseAll 的 keepInbox 一路传到 agent.cancel', async () => {
  const { ctx, agents } = twoRunningSessions()
  const host = safeAdapter(ctx, normalizeConfig(undefined))
  await host.pauseAll({ keepInbox: true })
  assert.deepEqual(agents.get('session-b').cancelCalls[0].options, { keepInbox: true })
  assert.deepEqual(agents.get('session-a').cancelCalls[0].options, { keepInbox: true })
})

test('restartHost：计划先落盘、延时脚本先起来、交接是延迟的，调用者最后一刻才收', async () => {
  const { ctx, agents } = twoRunningSessions()
  const written = []
  const timers = []
  const specs = []
  const host = safeAdapter(ctx, normalizeConfig(undefined), {
    probeShell: async () => ({ ok: true, shellPid: 11368, hostPid: 4242, exe: 'C:\\app\\DeepSeek Harness.exe', commandLine: '"C:\\app\\DeepSeek Harness.exe"', evidence: '父进程 11368 是 DeepSeek Harness' }),
    startRelauncher: (spec) => { specs.push(spec); return { pid: 4242, method: 'wmi', logPath: 'C:\\state\\relaunch-watch.log', script: 'relaunch-watch.ps1', shell: 'powershell.exe' } },
    writePlan: (plan) => { written.push(JSON.parse(JSON.stringify(plan))); return plan },
    later: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} } },
    now: () => 1_000_000,
  })

  const result = await host.restartHost({ callerSessionId: 'session-a' })
  assert.equal(result.transport, 'api')
  assert.equal(result.stopped.requested, 2)
  assert.equal(result.stopped.cancelled, 1)
  assert.equal(result.stopped.deferred, 1)
  assert.deepEqual(result.willResume.map((entry) => entry.sessionId).sort(), ['session-a', 'session-b'])
  assert.equal(result.exitInSeconds, 6)
  assert.equal(agents.get('session-b').cancelCalls.length, 1)
  assert.equal(agents.get('session-a').cancelCalls.length, 0)

  // 第一次写盘发生在快照**之前**：那是一份 `arming` 痕迹，没有名单、没有延时脚本、没有交接。
  assert.equal(written[0].state, 'arming')
  assert.deepEqual(written[0].sessions, [])
  assert.equal(written[0].stop.requested, 0)
  assert.equal(written[0].watcher, undefined)
  assert.equal(written[0].exit, undefined)
  // 快照之后才成型为 `armed`：名单、停止结果、延时脚本、交接时刻逐次补上。
  const armed = written.find((plan) => plan.state === 'armed')
  assert.equal(armed.sessions.length, 2)
  assert.equal(armed.stop.requested, 2)
  assert.ok(written.some((plan) => plan.watcher?.pid === 4242))
  assert.ok(written.some((plan) => plan.exit?.delaySeconds === 6))

  // 两个 pid 都要进计划，并且都交给延时脚本：应用会不会优雅退出不由插件决定，脚本要知道等谁。
  assert.deepEqual(armed.shell.shellPid, 11368)
  assert.deepEqual(armed.shell.hostPid, 4242)
  assert.equal(armed.shell.mainPid, undefined, '旧字段名不该再出现')
  // 看门狗的强杀宽限 = 原本的 10 秒 + 优雅退出的预算（默认 60 秒）。少于这个数，它会在托盘点击
  // 落地之前就把进程树收掉，「优雅退出」就成了一句空话。
  assert.deepEqual(specs, [{ shellPid: 11368, hostPid: 4242, exe: 'C:\\app\\DeepSeek Harness.exe', waitSeconds: 120, settleMs: 1500, killAfterSeconds: 70 }])
  // `exit` 是最后一步才补上的，所以要看最后一份计划，而不是那份 `armed` 快照。
  const withExit = written.at(-1)
  assert.equal(withExit.exit.graceful.enabled, true)
  assert.equal(withExit.exit.graceful.iconName, 'DeepSeek Harness', '图标名默认取要拉起的那个 exe 的文件名')
  assert.equal(withExit.exit.graceful.budgetMs, 60_000)
  assert.equal(withExit.exit.graceful.killAfterSeconds, 70, '计划里要能读出「看门狗等多久」是从哪儿来的')

  // 交接必须是延迟的：立刻收尾，调用方就永远看不到这个结果。
  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, 6000)

  timers[0].fn()
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(agents.get('session-a').cancelCalls.length, 1, '交接前一刻才收调用者')
  assert.ok(written.at(-1).exit.handedOffAt !== undefined, '「已交接」要留痕，否则事后分不清没走到和交接了没人响应')
  // 请应用自己退出那一腿必须真的被叫到，而且叫的是替身。这条用例原先没有注入 deps.quitViaTray，于是
  // 它真的去悬停、右键、读菜单、点确认，把正在跑测试的这个应用关掉过一次——这一腿发生在交接的定时器里，
  // 所以断言必须放在定时器跑完之后，否则看到的是「还没叫」而不是「没叫」。
  assert.deepEqual(quitCalls.map((call) => call.iconName), ['DeepSeek Harness'])
  assert.equal(quitCalls[0].budgetMs, 60_000)
  assert.equal(quitCalls[0].item, '退出')
})

test('restartHost 交接时会先请应用自己退出，并把这一腿的结论写进计划', async () => {
  const { ctx } = twoRunningSessions()
  const written = []
  const timers = []
  const attempts = []
  const host = safeAdapter(ctx, normalizeConfig(undefined), {
    probeShell: async () => ({ ok: true, shellPid: 11368, hostPid: 4242, exe: 'C:\\app\\DeepSeek Harness.exe', commandLine: null, evidence: 'x' }),
    startRelauncher: () => ({ pid: 4242, method: 'wmi', logPath: 'log', script: 's', shell: 'powershell.exe' }),
    writePlan: (plan) => { written.push(JSON.parse(JSON.stringify(plan))); return plan },
    later: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} } },
    now: () => 1_000_000,
    quitViaTray: async (spec) => {
      attempts.push(spec)
      return { attempted: true, clicked: true, specifier: 'file:///.../dsh-computer-use/src/core/index.mjs', icon: { name: null, menuItems: ['打开 DeepSeek Harness', '退出 DeepSeek Harness'], point: { x: 2105, y: 1487 } }, item: { text: '退出 DeepSeek Harness', at: { x: 2279, y: 1437 } }, menuClosed: true, elapsedMs: 21_000, attempts: [] }
    },
  })

  await host.restartHost({ callerSessionId: 'session-a' })
  timers[0].fn()
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve))

  assert.equal(attempts.length, 1, '交接之后要真的去点托盘菜单')
  assert.equal(attempts[0].iconName, 'DeepSeek Harness')
  assert.equal(attempts[0].item, '退出')
  assert.equal(attempts[0].budgetMs, 60_000)
  const last = written.at(-1)
  assert.equal(last.exit.graceful.enabled, true)
  assert.equal(last.exit.graceful.clicked, true)
  assert.equal(last.exit.graceful.item.text, '退出 DeepSeek Harness')
  assert.equal(last.exit.graceful.menuClosed, true)
  assert.ok(last.exit.gracefulFinishedAt !== undefined, '这一腿跑完了也要留痕')
})

test('优雅退出失败不影响结局：看门狗照样到点收树', async () => {
  const { ctx } = twoRunningSessions()
  const written = []
  const timers = []
  const specs = []
  const host = safeAdapter(ctx, normalizeConfig(undefined), {
    probeShell: async () => ({ ok: true, shellPid: 11368, hostPid: 4242, exe: 'C:\\app\\DeepSeek Harness.exe', commandLine: null, evidence: 'x' }),
    startRelauncher: (spec) => { specs.push(spec); return { pid: 4242, method: 'wmi', logPath: 'log', script: 's', shell: 'powershell.exe' } },
    writePlan: (plan) => { written.push(JSON.parse(JSON.stringify(plan))); return plan },
    later: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} } },
    now: () => 1_000_000,
    quitViaTray: async () => ({ attempted: true, clicked: false, reason: '托盘里没有名字匹配 "DeepSeek Harness" 的图标', elapsedMs: 30_000, attempts: [] }),
  })

  const result = await host.restartHost({})
  assert.match(result.note, /请它自己退出/)
  assert.equal(specs[0].killAfterSeconds, 70, '优雅退出的预算要算进看门狗的宽限')

  timers[0].fn()
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(written.at(-1).exit.graceful.clicked, false)
  assert.match(written.at(-1).exit.graceful.reason, /没有名字匹配/)
})

test('gracefulQuit = false 时回到老行为：直接交给看门狗，宽限不加预算', async () => {
  const { ctx } = twoRunningSessions()
  const specs = []
  const timers = []
  let trayCalls = 0
  const host = safeAdapter(ctx, normalizeConfig({ restart: { gracefulQuit: false } }), {
    probeShell: async () => ({ ok: true, shellPid: 11368, hostPid: 4242, exe: 'C:\\app\\x.exe', commandLine: null, evidence: 'x' }),
    startRelauncher: (spec) => { specs.push(spec); return { pid: 1, method: 'wmi', logPath: 'log', script: 's', shell: 'powershell.exe' } },
    writePlan: (plan) => plan,
    later: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} } },
    now: () => 1_000_000,
    quitViaTray: async () => { trayCalls += 1; return { attempted: true, clicked: true } },
  })

  const result = await host.restartHost({})
  assert.equal(specs[0].killAfterSeconds, 10)
  assert.deepEqual(result.gracefulExit, { enabled: false, reason: 'config.restart.gracefulQuit = false：直接交给看门狗收树' })
  timers[0].fn()
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(trayCalls, 0, '关掉之后一次都不该点托盘')
})

test('restartHost 先落 arming 痕迹、再快照，而且同一次调用只扫一遍会话', async () => {
  const order = []
  let listCalls = 0
  const ctx = contextWith({
    appExit: () => {},
    sessionController: {
      list: () => {
        listCalls += 1
        order.push('snapshot')
        return [{ sessionId: 'session-a', running: true, agentAvailable: true, blank: false, cwd: 'C:\\a', updatedAt: 2 }]
      },
    },
    agents: { get: () => null },
  })
  const host = safeAdapter(ctx, normalizeConfig(undefined), {
    probeShell: async () => ({ ok: true, shellPid: 11368, hostPid: 4242, exe: 'C:\\app\\DeepSeek Harness.exe', evidence: 'ok' }),
    startRelauncher: () => ({ pid: 1, method: 'wmi', logPath: 'l', script: 's', shell: 'powershell.exe' }),
    watcherAlive: async () => true,
    writePlan: (plan) => { order.push(`plan:${plan.state}`); return plan },
    later: () => ({ unref() {} }),
    requestExit: () => {},
  })

  await host.restartHost({})
  assert.equal(order[0], 'plan:arming', '痕迹必须落在最重的那一步之前——卡在快照时它是唯一的证据')
  assert.ok(order.indexOf('plan:arming') < order.indexOf('snapshot'))
  assert.equal(listCalls, 1, 'pauseAll 复用同一份快照，不再扫第二遍（那一步曾经是分钟级的）')
  assert.equal(order.filter((entry) => entry === 'plan:arming').length, 1)
})

test('restartHost 把两个 pid 和宽限期交给延时脚本（它会等整棵树，必要时收掉它）', async () => {
  const { ctx } = twoRunningSessions()
  const specs = []
  const host = safeAdapter(ctx, normalizeConfig({ restart: { killAfterSeconds: 25, waitSeconds: 60 } }), {
    probeShell: async () => ({ ok: true, shellPid: 5320, hostPid: 18620, exe: 'C:\\app\\DeepSeek Harness.exe', evidence: 'ok' }),
    startRelauncher: (spec) => { specs.push(spec); return { pid: 1, method: 'wmi', logPath: 'l', script: 's', shell: 'powershell.exe' } },
    writePlan: (plan) => plan,
    later: () => ({ unref() {} }),
  })

  await host.restartHost({})
  assert.equal(specs.length, 1)
  assert.equal(specs[0].shellPid, 5320)
  assert.equal(specs[0].hostPid, 18620)
  // 25 是配置里写的强杀宽限；优雅退出那一腿的预算（默认 60 秒）另算在上面。
  assert.equal(specs[0].killAfterSeconds, 85)
  assert.equal(specs[0].waitSeconds, 60)
})

test('restartHost 的 dryRun 保持纯净：不写任何文件，包括那份 arming 痕迹', async () => {
  const { ctx, agents } = twoRunningSessions()
  const written = []
  const host = safeAdapter(ctx, normalizeConfig(undefined), {
    probeShell: async () => ({ ok: true, shellPid: 11368, hostPid: 4242, exe: 'C:\\app\\DeepSeek Harness.exe', evidence: 'ok' }),
    writePlan: (plan) => { written.push(plan); return plan },
    startRelauncher: () => { throw new Error('dryRun 不该起延时脚本') },
  })

  const result = await host.restartHost({ dryRun: true })
  assert.equal(result.dryRun, true)
  assert.deepEqual(written, [], '预演不落痕迹——痕迹只在真的要重启时才有意义')
  assert.equal(result.wouldStop.length, 2)
  assert.equal(result.wouldResume.length, 2)
  assert.equal(agents.get('session-a').cancelCalls.length, 0)
  assert.equal(agents.get('session-b').cancelCalls.length, 0)
})

test('restartHost 在延时脚本起不来时什么都不动（会话已停的事实要说清）', async () => {
  const { ctx, agents } = twoRunningSessions()
  const written = []
  const host = safeAdapter(ctx, normalizeConfig(undefined), {
    probeShell: async () => ({ ok: true, shellPid: 11368, hostPid: 4242, exe: 'C:\\app\\DeepSeek Harness.exe', evidence: 'ok' }),
    startRelauncher: () => { throw new Error('powershell 起不来') },
    writePlan: (plan) => { written.push(JSON.parse(JSON.stringify(plan))); return plan },
    later: () => { throw new Error('不该排任何定时器') },
  })

  await assert.rejects(() => host.restartHost({ callerSessionId: 'session-a' }), /延时脚本起不来/)
  assert.equal(written.at(-1).state, 'failed')
  assert.match(written.at(-1).failure, /powershell 起不来/)
  assert.equal(agents.get('session-b').cancelCalls.length, 1, '停止已经发生了，结果里要说清楚')
})

test('restartHost 在找不到桌面壳时什么都不做', async () => {
  const { ctx, agents } = twoRunningSessions()
  const host = safeAdapter(ctx, normalizeConfig(undefined), {
    probeShell: async () => ({ ok: false, shellPid: 1, hostPid: 4242, exe: null, reason: '跑在 headless 的 dsh CLI 里' }),
    startRelauncher: () => { throw new Error('不该起延时脚本') },
  })

  await assert.rejects(() => host.restartHost({}), /headless 的 dsh CLI/)
  assert.equal(agents.get('session-a').cancelCalls.length, 0)
  assert.equal(agents.get('session-b').cancelCalls.length, 0)
})

test('resumeAfterRestart 只在别的进程写的计划上投递，并且先 claim 再投', async () => {
  const agent = fakeAgent({ id: 'session-b' })
  const written = []
  const plan = {
    version: 1,
    id: 'restart-1',
    state: 'armed',
    createdAtMs: 1000,
    writer: { pid: 111, bootEpochMs: 500 },
    resume: { text: '继续上次未完成的工作。', max: 20 },
    sessions: [{ sessionId: 'session-b' }],
    outcomes: [],
  }
  const host = safeAdapter(contextWith({
    sessionController: { resolveAgent: async () => ({ agent }) },
    sessions: { flush: async () => true },
  }), normalizeConfig(undefined), {
    readPlan: () => ({ plan: JSON.parse(JSON.stringify(plan)), path: 'C:\\state\\restart-plan.json', error: null }),
    writePlan: (next) => { written.push(JSON.parse(JSON.stringify(next))); return next },
    now: () => 5000,
  })

  const result = await host.resumeAfterRestart()
  assert.equal(result.state, 'done')
  assert.equal(result.resumed, 1)
  assert.equal(result.failed, 0)
  assert.equal(agent.followupCalls.length, 1)
  assert.equal(agent.followupCalls[0].content[0].text, '继续上次未完成的工作。')
  assert.equal(written[0].state, 'claimed', '先记账再投递，才不会有第二次重复投递')
  assert.equal(written.at(-1).state, 'done')
  assert.deepEqual(result.outcomes, [{ sessionId: 'session-b', ok: true, transport: 'api', flushed: true }])
})

test('resumeAfterRestart 拒绝恢复「当前这个进程」写下的计划', async () => {
  let resolveCalls = 0
  const host = safeAdapter(contextWith({
    sessionController: { resolveAgent: async () => { resolveCalls += 1; return { agent: fakeAgent() } } },
  }), normalizeConfig(undefined), {
    readPlan: () => ({
      plan: { version: 1, state: 'armed', createdAtMs: 0, writer: hostIdentity(), resume: { text: 'x' }, sessions: [{ sessionId: 's' }], outcomes: [] },
      path: 'p',
      error: null,
    }),
    writePlan: (plan) => plan,
  })

  const result = await host.resumeAfterRestart()
  assert.equal(result.state, 'same-boot')
  assert.equal(resolveCalls, 0, '插件热重载不该把消息再投一遍')
})

test('resumeAfterRestart 对过期计划改成 expired，而不是突然把会话全都点着', async () => {
  const written = []
  const host = safeAdapter(contextWith({ sessionController: { resolveAgent: async () => ({ agent: fakeAgent() }) } }), normalizeConfig({ restart: { planTtlSeconds: 10 } }), {
    readPlan: () => ({
      plan: { version: 1, state: 'armed', createdAtMs: 0, writer: { pid: 1, bootEpochMs: 1 }, resume: { text: 'x' }, sessions: [{ sessionId: 's' }], outcomes: [] },
      path: 'p',
      error: null,
    }),
    writePlan: (plan) => { written.push(JSON.parse(JSON.stringify(plan))); return plan },
    now: () => 60_000,
  })

  const result = await host.resumeAfterRestart()
  assert.equal(result.state, 'expired')
  assert.equal(written.at(-1).state, 'expired')
})

test('resumeAfterRestart 在服务还没装配好时给出可重试的信号', async () => {
  const host = safeAdapter(contextWith({}), normalizeConfig(undefined), {
    readPlan: () => ({
      plan: { version: 1, state: 'armed', createdAtMs: 0, writer: { pid: 1, bootEpochMs: 1 }, resume: { text: 'x' }, sessions: [{ sessionId: 's' }], outcomes: [] },
      path: 'p',
      error: null,
    }),
    writePlan: (plan) => plan,
    now: () => 1000,
  })

  const result = await host.resumeAfterRestart()
  assert.equal(result.state, 'services-not-ready')
  assert.equal(result.retryable, true)
})

test('resumeAfterRestart 不会拿「停在快照阶段」的 arming 计划去投消息', async () => {
  let deliveries = 0
  const host = safeAdapter(contextWith({
    sessionController: { resolveAgent: async () => { deliveries += 1; return { agent: fakeAgent() } } },
  }), normalizeConfig(undefined), {
    readPlan: () => ({
      plan: { version: 1, state: 'arming', createdAtMs: 0, writer: { pid: 1, bootEpochMs: 1 }, resume: { text: 'x' }, sessions: [], outcomes: [] },
      path: 'p',
      error: null,
    }),
    writePlan: (plan) => plan,
    now: () => 1000,
  })

  const result = await host.resumeAfterRestart()
  assert.equal(result.state, 'arming')
  assert.equal(deliveries, 0, '没有请求过退出，就没有证据表明会话被中断过——投递就是凭空的打扰')
  assert.match(result.reason, /快照阶段/)
})

test('resumeAfterRestart 把过期的 arming 计划收成 expired，而不是永远留着中间态', async () => {
  const written = []
  const host = safeAdapter(contextWith({}), normalizeConfig({ restart: { planTtlSeconds: 10 } }), {
    readPlan: () => ({
      plan: { version: 1, state: 'arming', createdAtMs: 0, writer: { pid: 1, bootEpochMs: 1 }, resume: { text: 'x' }, sessions: [], outcomes: [] },
      path: 'p',
      error: null,
    }),
    writePlan: (plan) => { written.push(JSON.parse(JSON.stringify(plan))); return plan },
    now: () => 60_000,
  })

  const result = await host.resumeAfterRestart()
  assert.equal(result.state, 'expired')
  assert.match(result.failure, /快照阶段/)
  assert.equal(written.at(-1).state, 'expired')
})

test('restartStatus 把 arming 计划直说成「按了重启但停在快照」', async () => {
  const host = safeAdapter(contextWith({}), normalizeConfig(undefined), {
    readPlan: () => ({
      plan: { version: 1, state: 'arming', createdAtMs: 0, writer: { pid: 1, bootEpochMs: 1 }, shell: {}, stop: {}, sessions: [], outcomes: [] },
      path: 'p',
      error: null,
    }),
    now: () => 5000,
  })

  const result = await host.restartStatus()
  assert.equal(result.plan.state, 'arming')
  assert.match(result.note, /停在快照阶段/)
  assert.equal(result.belongsToCurrentBoot, false)
})

test('restartStatus 在没有计划时说清楚没有，而不是编一个', async () => {
  const host = safeAdapter(contextWith({}), normalizeConfig(undefined), {
    readPlan: () => ({ plan: null, path: 'C:\\state\\restart-plan.json', error: null }),
  })
  const result = await host.restartStatus()
  assert.equal(result.transport, 'disk')
  assert.equal(result.plan, null)
  assert.match(result.note, /没有重启计划/)
  assert.equal(typeof result.watcherLog.exists, 'boolean')
  assert.equal(typeof result.currentHost.pid, 'number')
})
