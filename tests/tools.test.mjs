import { strict as assert } from 'node:assert'
import test from 'node:test'
import { TOOL_NAMES, toolDefinitions } from '../src/tools/index.mjs'
import { TOOLS } from '../src/tools/registry.mjs'
import { createHostTool } from '../src/tools/host.mjs'
import { ControllerError, defineFamilyTool } from '../src/tools/shared.mjs'
import { adapter } from '../src/host/services.mjs'
import { normalizeConfig } from '../index.mjs'

/** 一个什么都不提供的宿主：所有服务缺席，于是全部动作都退到磁盘或不适用。 */
function emptyHost() {
  return adapter({ get: () => undefined }, normalizeConfig(undefined))
}

const logger = { info() {}, warn() {}, error() {} }

test('注册表与注册的工具一一对应', () => {
  assert.deepEqual(Object.keys(TOOLS).sort(), [...TOOL_NAMES].sort())
})

test('五个工具都造得出来，并且 schema 形状正确', () => {
  const definitions = toolDefinitions(emptyHost(), normalizeConfig(undefined), logger)
  assert.deepEqual(definitions.map((definition) => definition.name), TOOL_NAMES)
  assert.equal(definitions.length, 5)
  for (const definition of definitions) {
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.includes('Full detail: dsh_control {action:"guide"'))
    assert.equal(definition.parameters.type, 'object')
    assert.deepEqual(definition.parameters.required, ['action'])
    assert.equal(definition.parameters.additionalProperties, false)
    assert.ok(Array.isArray(definition.parameters.properties.action.enum))
    assert.ok(definition.parameters.properties.action.enum.length > 0)
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(typeof definition.execute, 'function')
  }
})

test('声明的动作与注册表文档双向核对：文档有而声明没有会抛错', () => {
  assert.throws(() => defineFamilyTool({
    name: 'dsh_control',
    actions: ['overview'],
    extraProperties: {},
    handlers: { overview: async () => ({}) },
  }), /有文档但没有声明/)
})

test('声明了但没有 handler 会抛错', () => {
  assert.throws(() => defineFamilyTool({
    name: 'dsh_control',
    actions: ['overview', 'capabilities', 'session', 'transport', 'guide'],
    extraProperties: {},
    handlers: { overview: async () => ({}) },
  }), /声明了但没有 handler/)
})

test('没有注册表条目的工具名会抛错', () => {
  assert.throws(() => defineFamilyTool({ name: 'dsh_nope', actions: [], extraProperties: {}, handlers: {} }), /no registry entry/)
})

test('未知动作抛 ControllerError，并且不落到别的 handler 上', async () => {
  const definitions = toolDefinitions(emptyHost(), normalizeConfig(undefined), logger)
  const sessions = definitions.find((definition) => definition.name === 'dsh_sessions')
  await assert.rejects(() => sessions.execute({ action: 'drop-everything' }, {}), ControllerError)
  await assert.rejects(() => sessions.execute({ action: undefined }, {}), ControllerError)
})

test('dsh_control guide 能列全部工具，也能只渲染一个动作', async () => {
  const definitions = toolDefinitions(emptyHost(), normalizeConfig(undefined), logger)
  const control = definitions.find((definition) => definition.name === 'dsh_control')

  const all = await control.execute({ action: 'guide' }, {})
  assert.deepEqual(all.tools.map((entry) => entry.tool).sort(), [...TOOL_NAMES].sort())

  const one = await control.execute({ action: 'guide', tool: 'dsh_sessions', actionName: 'create' }, {})
  assert.equal(one.tool, 'dsh_sessions')
  assert.equal(one.action, 'create')
  assert.deepEqual(one.required, ['text'])
  assert.ok(one.detail.length > 0)
  // create 是唯一的例外：它声明 GUI 优先、API 兜底。
  assert.equal(one.route.preferred, 'ui')
  assert.equal(one.route.fallback, 'api')

  await assert.rejects(() => control.execute({ action: 'guide', tool: 'dsh_nope' }, {}), /没有名为/)
  await assert.rejects(() => control.execute({ action: 'guide', tool: 'dsh_sessions', actionName: 'nope' }, {}), /没有动作/)
})

test('dsh_control session 拿不到自身会话 id 时明确报错，而不是猜一个', async () => {
  const definitions = toolDefinitions(emptyHost(), normalizeConfig(undefined), logger)
  const control = definitions.find((definition) => definition.name === 'dsh_control')
  await assert.rejects(() => control.execute({ action: 'session' }, {}), /拿不到当前会话 id/)
})

test('create 的确认门槛按配置生效', async () => {
  const strict = toolDefinitions(
    adapter({ get: () => undefined }, normalizeConfig({ guard: { requireConfirmForCreate: true } })),
    normalizeConfig({ guard: { requireConfirmForCreate: true } }),
    logger,
  ).find((definition) => definition.name === 'dsh_sessions')

  await assert.rejects(() => strict.execute({ action: 'create', text: '你好' }, {}), /需要 confirm:true/)
})

test('send 的参数校验在碰宿主之前完成', async () => {
  const definitions = toolDefinitions(emptyHost(), normalizeConfig(undefined), logger)
  const sessions = definitions.find((definition) => definition.name === 'dsh_sessions')
  await assert.rejects(() => sessions.execute({ action: 'send', text: '你好' }, {}), /需要 sessionId/)
  await assert.rejects(() => sessions.execute({ action: 'send', sessionId: 's' }, {}), /需要非空的 text/)
})

test('restart 的确认门槛默认打开，过了门槛才碰宿主', async () => {
  const calls = []
  const stub = {
    pauseAll: async (args) => { calls.push(['pause-all', args]); return { transport: 'api', requested: 0, cancelled: [], failed: [], deferred: [] } },
    restartHost: async (args) => { calls.push(['restart', args]); return { transport: 'api', dryRun: true } },
    restartStatus: async () => ({ transport: 'disk' }),
    resumeAfterRestart: async (args) => { calls.push(['resume', args]); return { transport: 'api', state: 'no-plan' } },
  }

  const strict = createHostTool(stub, normalizeConfig({ guard: { requireConfirmForRestart: true } }))
  await assert.rejects(() => strict.execute({ action: 'restart', dryRun: true }, {}), /需要 confirm:true/)
  assert.equal(calls.length, 0, '门槛没过就一步都不该碰宿主')

  await strict.execute({ action: 'restart', confirm: true, dryRun: true }, {})
  assert.deepEqual(calls.map(([name]) => name), ['restart'])
  assert.equal(calls[0][1].dryRun, true)

  // 调用者身份要一路传下去：restart / pause-all 靠它把「自己那一轮」留到退出前才收。
  const loose = createHostTool(stub, normalizeConfig({ guard: { requireConfirmForRestart: false } }))
  await loose.execute({ action: 'pause-all' }, { agent: { session: { id: 'session-self' } } })
  assert.equal(calls.at(-1)[0], 'pause-all')
  assert.equal(calls.at(-1)[1].callerSessionId, 'session-self')

  // 关掉重启编排 = 连按都不给按：退出之后没人恢复会话，这不该是个「悄悄少了后半段」的选项。
  const disabled = createHostTool(stub, normalizeConfig({ restart: { enabled: false }, guard: { requireConfirmForRestart: false } }))
  await assert.rejects(() => disabled.execute({ action: 'restart', confirm: true }, {}), /重启编排被关掉了/)
  await disabled.execute({ action: 'pause-all' }, {})
})

test('dsh_host 的 guide 说清 restart 要 confirm，并且路由写明重新拉起由进程外完成', async () => {
  const definitions = toolDefinitions(emptyHost(), normalizeConfig(undefined), logger)
  const control = definitions.find((definition) => definition.name === 'dsh_control')

  const guide = await control.execute({ action: 'guide', tool: 'dsh_host', actionName: 'restart' }, {})
  assert.deepEqual(guide.required, ['confirm'])
  assert.equal(guide.route.preferred, 'api')
  assert.equal(guide.route.fallback, 'process')
  assert.ok(guide.detail.some((line) => line.includes('看门狗')))

  const transport = await control.execute({ action: 'transport' }, {})
  assert.equal(transport.routes['dsh_host.status'].preferred, 'disk')
  assert.equal(transport.routes['dsh_host.restart'].fallback, 'process')
})

test('每个动作的结果都带 transport，除非它本来就不碰宿主', async () => {
  const definitions = toolDefinitions(emptyHost(), normalizeConfig(undefined), logger)
  const control = definitions.find((definition) => definition.name === 'dsh_control')
  const transport = await control.execute({ action: 'transport' }, {})
  assert.equal(transport.transport, 'api')
  assert.ok(Object.keys(transport.routes).length > 10)
})
