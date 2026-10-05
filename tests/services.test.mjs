import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { adapter, probe, userMessage } from '../src/host/services.mjs'
import { normalizeConfig } from '../index.mjs'

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
  const warnings = []
  const host = adapter(contextWith({}), normalizeConfig(undefined))
  const rows = await host.listSessions({ workspace: 'all' }, warnings)
  assert.ok(Array.isArray(rows))
  assert.ok(warnings.some((warning) => warning.includes('退回磁盘扫描')))
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
