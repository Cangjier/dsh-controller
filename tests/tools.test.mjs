import { strict as assert } from 'node:assert'
import test from 'node:test'
import { TOOL_NAMES, toolDefinitions } from '../src/tools/index.mjs'
import { TOOLS } from '../src/tools/registry.mjs'
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

test('四个工具都造得出来，并且 schema 形状正确', () => {
  const definitions = toolDefinitions(emptyHost(), normalizeConfig(undefined), logger)
  assert.deepEqual(definitions.map((definition) => definition.name), TOOL_NAMES)
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
  assert.equal(one.route.preferred, 'api')

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

test('每个动作的结果都带 transport，除非它本来就不碰宿主', async () => {
  const definitions = toolDefinitions(emptyHost(), normalizeConfig(undefined), logger)
  const control = definitions.find((definition) => definition.name === 'dsh_control')
  const transport = await control.execute({ action: 'transport' }, {})
  assert.equal(transport.transport, 'api')
  assert.ok(Object.keys(transport.routes).length > 10)
})
