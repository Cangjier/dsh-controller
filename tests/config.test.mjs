import { strict as assert } from 'node:assert'
import test from 'node:test'
import { normalizeConfig } from '../index.mjs'

test('空配置得到一套可用的默认值', () => {
  const config = normalizeConfig(undefined)
  assert.equal(config.enabled, true)
  assert.equal(config.api.forceUi, false)
  assert.equal(config.api.defaultWaitMs, 120_000)
  assert.equal(config.ui.processName, 'DeepSeek Harness')
  assert.equal(config.ui.scriptTimeoutMs, 60_000)
  assert.equal(config.ui.focusSettleMs, 120)
  assert.match(config.ui.screenshotDir, /tmp[\\/]screens$/)
  assert.equal(config.guard.requireConfirmForCreate, false)
  // 插件管理默认要求显式确认：它会改 profile 配置。
  assert.equal(config.guard.requireConfirmForPlugins, true)
  // 重启是最重的动作，默认必须显式确认。
  assert.equal(config.guard.requireConfirmForRestart, true)
  assert.equal(config.restart.enabled, true)
  assert.equal(config.restart.delaySeconds, 6)
  assert.equal(config.restart.shellGraceSeconds, 8)
  assert.equal(config.restart.maxResume, 20)
  assert.equal(config.restart.planTtlSeconds, 900)
  assert.equal(config.restart.keepInbox, false)
  assert.ok(config.restart.resumeText.length > 0)
})

test('写出来的配置被逐项采纳', () => {
  const config = normalizeConfig({
    enabled: false,
    api: { forceUi: true, defaultWaitMs: 5000, actionTimeoutMs: 1000 },
    ui: { windowTitle: '会话', processName: 'Harness', screenshotDir: 'D:\\shots', scriptTimeoutMs: 2000, focusSettleMs: 5 },
    guard: { requireConfirmForCreate: true, requireConfirmForPlugins: false, requireConfirmForRestart: false },
    restart: { delaySeconds: 3, maxResume: 2, resumeText: '接着干', keepInbox: true },
  })
  assert.equal(config.enabled, false)
  assert.equal(config.api.forceUi, true)
  assert.equal(config.api.defaultWaitMs, 5000)
  assert.equal(config.ui.windowTitle, '会话')
  assert.equal(config.ui.screenshotDir, 'D:\\shots')
  assert.equal(config.guard.requireConfirmForCreate, true)
  assert.equal(config.guard.requireConfirmForPlugins, false)
  assert.equal(config.guard.requireConfirmForRestart, false)
  assert.equal(config.restart.delaySeconds, 3)
  assert.equal(config.restart.maxResume, 2)
  assert.equal(config.restart.resumeText, '接着干')
  assert.equal(config.restart.keepInbox, true)
})

test('类型写错在加载时就抛错，而不是留到调用时', () => {
  assert.throws(() => normalizeConfig({ enabled: 'yes' }), /config.enabled 必须是布尔值/)
  assert.throws(() => normalizeConfig({ api: { defaultWaitMs: 0 } }), /config.api.defaultWaitMs 必须是正数/)
  assert.throws(() => normalizeConfig({ api: { defaultWaitMs: -1 } }), /config.api.defaultWaitMs 必须是正数/)
  assert.throws(() => normalizeConfig({ ui: { windowTitle: 42 } }), /config.ui.windowTitle 必须是字符串或 null/)
  assert.throws(() => normalizeConfig({ guard: { requireConfirmForPlugins: 'true' } }), /config.guard.requireConfirmForPlugins 必须是布尔值/)
  assert.throws(() => normalizeConfig({ restart: { delaySeconds: 0 } }), /config.restart.delaySeconds 必须是正数/)
  assert.throws(() => normalizeConfig({ restart: { resumeText: 7 } }), /config.restart.resumeText 必须是字符串或 null/)
  assert.throws(() => normalizeConfig({ guard: { requireConfirmForRestart: 'yes' } }), /config.guard.requireConfirmForRestart 必须是布尔值/)
})
