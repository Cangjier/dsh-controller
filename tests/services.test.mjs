import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import zlib from 'node:zlib'
import { adapter, probe, userMessage } from '../src/host/services.mjs'
import { hostIdentity } from '../src/host/restart.mjs'
import { normalizeConfig } from '../index.mjs'

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
  const host = adapter(contextWith({
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
    const host = adapter(contextWith({}), normalizeConfig(undefined))
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

    const host = adapter(contextWith({}), normalizeConfig(undefined))
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
    const host = adapter(contextWith({
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
    const host = adapter(contextWith({
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
  const host = adapter(contextWith({
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
  const host = adapter(contextWith({ sessionController: { resolveAgent: async () => ({ agent }) } }), normalizeConfig(undefined))
  await host.sendToSession({ sessionId: 's', text: 'a', mode: 'steer' })
  await host.sendToSession({ sessionId: 's', text: 'b', mode: 'inject' })
  assert.equal(agent.steerCalls.length, 1)
  assert.equal(agent.injectCalls.length, 1)
  assert.equal(agent.followupCalls.length, 0)
})

test('sendToSession 把 resolveAgent 的 error 变成可读的异常，而不是静默', async () => {
  const host = adapter(contextWith({ sessionController: { resolveAgent: async () => ({ error: { message: '写锁被占' } }) } }), normalizeConfig(undefined))
  await assert.rejects(() => host.sendToSession({ sessionId: 's', text: 'x' }), /写锁被占/)
})

test('abortSession 用宿主自己的取消口径 cancel({kind:"user"})', async () => {
  const agent = fakeAgent()
  const host = adapter(contextWith({ agents: { get: () => agent } }), normalizeConfig(undefined))
  await host.abortSession({ sessionId: 's' })
  assert.deepEqual(agent.cancelCalls[0].cause, { kind: 'user' })
  assert.equal(agent.cancelCalls[0].options, undefined)
  await host.abortSession({ sessionId: 's', keepInbox: true })
  assert.deepEqual(agent.cancelCalls[1].options, { keepInbox: true })
})

test('abortSession 对没有 live agent 的会话明确拒绝', async () => {
  const host = adapter(contextWith({ agents: { get: () => undefined } }), normalizeConfig(undefined))
  await assert.rejects(() => host.abortSession({ sessionId: 'cold' }), /没有 live agent/)
})

test('waitIdle 把超时当结果返回，而不是抛错', async () => {
  const running = fakeAgent({ status: 'running', idlePromise: new Promise(() => {}) })
  const host = adapter(contextWith({ agents: { get: () => running } }), normalizeConfig(undefined))
  const result = await host.waitIdle({ sessionId: 's', timeoutMs: 30 })
  assert.equal(result.reason, 'timeout')
  assert.equal(result.state, 'RUNNING')
  assert.ok(result.waitedMs >= 0)
})

test('waitIdle 对已经空闲的会话立刻返回', async () => {
  const idle = fakeAgent({ status: 'idle' })
  const host = adapter(contextWith({ agents: { get: () => idle } }), normalizeConfig(undefined))
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
  const host = adapter(contextWith({
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
  const host = adapter(contextWith({}), normalizeConfig(undefined))
  await assert.rejects(() => host.createSessionViaApi({ text: 'x', cwd: 'C:\\w' }), /无法新建会话/)
})

test('createSession 默认先试 GUI，GUI 失败才退回 API，并把原因写进 fallback', async () => {
  const agent = fakeAgent({ id: 'session-api' })
  const desktop = fakeDesktop(() => ({ ok: false, reason: 'window-not-found' }))
  const host = adapter(contextWith({
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
  const host = adapter(contextWith({
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
  const host = adapter(contextWith({
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
  const host = adapter(contextWith({
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
  const host = adapter(contextWith({
    sessionController: {
      create: async () => { throw new Error('via:"gui" 不该回退到 API') },
      resolveAgent: async () => ({ agent: fakeAgent({ id: 'session-api' }) }),
    },
  }), normalizeConfig(undefined), { runDesktop: desktop.run })

  await assert.rejects(() => host.createSession({ text: 'x', via: 'gui' }), /禁止回退到 API/)
})

test('pluginAction 在没有 pluginManager 时拒绝，并说明原因', async () => {
  const host = adapter(contextWith({}), normalizeConfig(undefined))
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
  const host = adapter(contextWith({ pluginManager: manager }), normalizeConfig(undefined))

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

    const host = adapter(contextWith({}), normalizeConfig(undefined))
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
  const host = adapter(ctx, normalizeConfig(undefined))

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
  const host = adapter(ctx, normalizeConfig(undefined))
  await host.pauseAll({ keepInbox: true })
  assert.deepEqual(agents.get('session-b').cancelCalls[0].options, { keepInbox: true })
  assert.deepEqual(agents.get('session-a').cancelCalls[0].options, { keepInbox: true })
})

test('restartHost：计划先落盘、看门狗先起来、退出是延迟的，调用者最后一刻才收', async () => {
  const { ctx, agents } = twoRunningSessions()
  const written = []
  const timers = []
  const exits = []
  const host = adapter(ctx, normalizeConfig(undefined), {
    probeShell: async () => ({ ok: true, mainPid: 11368, exe: 'C:\\app\\DeepSeek Harness.exe', commandLine: '"C:\\app\\DeepSeek Harness.exe"', evidence: '父进程 11368 是 DeepSeek Harness' }),
    startWatcher: () => ({ pid: 4242, method: 'wmi', logPath: 'C:\\state\\restart-watch.log', script: 'restart-watch.ps1', shell: 'powershell.exe' }),
    watcherAlive: async () => true,
    writePlan: (plan) => { written.push(JSON.parse(JSON.stringify(plan))); return plan },
    later: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} } },
    requestExit: (code) => { exits.push(code) },
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

  // 计划是先落盘的那一份；带 watcher / exit 的是后续几次更新。
  assert.equal(written[0].state, 'armed')
  assert.equal(written[0].sessions.length, 2)
  assert.equal(written[0].watcher, undefined)
  assert.ok(written.some((plan) => plan.watcher?.pid === 4242))
  assert.ok(written.some((plan) => plan.exit?.delaySeconds === 6))

  // 退出必须是延迟的：立刻退，调用方就永远看不到这个结果。
  assert.deepEqual(exits, [])
  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, 6000)

  timers[0].fn()
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(agents.get('session-a').cancelCalls.length, 1, '退出前一刻才收调用者')
  assert.deepEqual(exits, [0])
})

test('restartHost 在看门狗起不来时绝不请求退出', async () => {
  const { ctx, agents } = twoRunningSessions()
  const written = []
  const exits = []
  const host = adapter(ctx, normalizeConfig(undefined), {
    probeShell: async () => ({ ok: true, mainPid: 11368, exe: 'C:\\app\\DeepSeek Harness.exe', evidence: 'ok' }),
    startWatcher: () => { throw new Error('powershell 起不来') },
    writePlan: (plan) => { written.push(JSON.parse(JSON.stringify(plan))); return plan },
    later: () => { throw new Error('不该排任何定时器') },
    requestExit: (code) => { exits.push(code) },
  })

  await assert.rejects(() => host.restartHost({ callerSessionId: 'session-a' }), /看门狗起不来/)
  assert.deepEqual(exits, [], '退出去回不来，比不重启更糟')
  assert.equal(written.at(-1).state, 'failed')
  assert.match(written.at(-1).failure, /powershell 起不来/)
  assert.equal(agents.get('session-b').cancelCalls.length, 1, '停止已经发生了，结果里要说清楚')
})

test('restartHost 在退出前发现看门狗已经死了，就取消退出', async () => {
  const { ctx } = twoRunningSessions()
  const written = []
  const exits = []
  const timers = []
  const host = adapter(ctx, normalizeConfig(undefined), {
    probeShell: async () => ({ ok: true, mainPid: 11368, exe: 'C:\\app\\DeepSeek Harness.exe', evidence: 'ok' }),
    startWatcher: () => ({ pid: 4242, method: 'wmi', logPath: 'l', script: 's', shell: 'powershell.exe' }),
    watcherAlive: async () => false,
    writePlan: (plan) => { written.push(JSON.parse(JSON.stringify(plan))); return plan },
    later: (fn) => { timers.push(fn); return { unref() {} } },
    requestExit: (code) => { exits.push(code) },
  })

  await host.restartHost({ callerSessionId: 'session-a' })
  timers[0]()
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(exits, [], '看门狗没了还退，就等于把 DSH 关掉且没人拉起来')
  assert.equal(written.at(-1).state, 'failed')
  assert.match(written.at(-1).failure, /取消退出/)
})

test('restartHost 在问不出看门狗死活时（null）照常退出', async () => {
  const { ctx } = twoRunningSessions()
  const exits = []
  const timers = []
  const host = adapter(ctx, normalizeConfig(undefined), {
    probeShell: async () => ({ ok: true, mainPid: 11368, exe: 'C:\\app\\DeepSeek Harness.exe', evidence: 'ok' }),
    startWatcher: () => ({ pid: 4242, method: 'detached', logPath: 'l', script: 's', shell: 'powershell.exe' }),
    watcherAlive: async () => null,
    writePlan: (plan) => plan,
    later: (fn) => { timers.push(fn); return { unref() {} } },
    requestExit: (code) => { exits.push(code) },
  })

  await host.restartHost({})
  timers[0]()
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(exits, [0], '「不知道」不该被当成「不在」')
})

test('restartHost 在找不到桌面壳时什么都不做', async () => {
  const { ctx, agents } = twoRunningSessions()
  const host = adapter(ctx, normalizeConfig(undefined), {
    probeShell: async () => ({ ok: false, mainPid: 1, exe: null, reason: '跑在 headless 的 dsh CLI 里' }),
    startWatcher: () => { throw new Error('不该起看门狗') },
  })

  await assert.rejects(() => host.restartHost({}), /headless 的 dsh CLI/)
  assert.equal(agents.get('session-a').cancelCalls.length, 0)
  assert.equal(agents.get('session-b').cancelCalls.length, 0)
})

test('restartHost 的 dryRun 只快照，不停不写不退', async () => {
  const { ctx, agents } = twoRunningSessions()
  const written = []
  const host = adapter(ctx, normalizeConfig(undefined), {
    probeShell: async () => ({ ok: true, mainPid: 11368, exe: 'C:\\app\\DeepSeek Harness.exe', evidence: 'ok' }),
    writePlan: (plan) => { written.push(plan); return plan },
    startWatcher: () => { throw new Error('dryRun 不该起看门狗') },
  })

  const result = await host.restartHost({ dryRun: true })
  assert.equal(result.dryRun, true)
  assert.equal(result.wouldStop.length, 2)
  assert.equal(result.wouldResume.length, 2)
  assert.deepEqual(written, [])
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
  const host = adapter(contextWith({
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
  const host = adapter(contextWith({
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
  const host = adapter(contextWith({ sessionController: { resolveAgent: async () => ({ agent: fakeAgent() }) } }), normalizeConfig({ restart: { planTtlSeconds: 10 } }), {
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
  const host = adapter(contextWith({}), normalizeConfig(undefined), {
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

test('restartStatus 在没有计划时说清楚没有，而不是编一个', async () => {
  const host = adapter(contextWith({}), normalizeConfig(undefined), {
    readPlan: () => ({ plan: null, path: 'C:\\state\\restart-plan.json', error: null }),
  })
  const result = await host.restartStatus()
  assert.equal(result.transport, 'disk')
  assert.equal(result.plan, null)
  assert.match(result.note, /没有重启计划/)
  assert.equal(typeof result.watcherLog.exists, 'boolean')
  assert.equal(typeof result.currentHost.pid, 'number')
})
