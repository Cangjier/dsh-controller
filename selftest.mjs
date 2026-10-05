/**
 * 自检：不开 DSH 也能跑，用来证明「插件本身是活的」。
 *
 * 它做四件事，每一件都打印原始证据而不是结论：
 *   1. 归一化配置并列出四个工具的 schema 摘要；
 *   2. 用一个**什么都不提供**的宿主跑一遍磁盘回退（overview + 会话列表）；
 *   3. 用当前进程的虚假宿主跑 capabilities，看看在这台机器上探测到了什么；
 *   4. 跑一次 UI 回退的 `window` 动作（**不动窗口**，只观察）。
 *
 * 用法：node selftest.mjs
 */
import { adapter, probe } from './src/host/services.mjs'
import { toolDefinitions } from './src/tools/index.mjs'
import { normalizeConfig } from './index.mjs'
import { runDesktop } from './src/ui/desktop.mjs'
import { dshHome, profileDir } from './src/host/paths.mjs'

const logger = { info: (message) => console.log(`[info] ${message}`), warn: (message) => console.log(`[warn] ${message}`), error: (message) => console.log(`[error] ${message}`) }
const config = normalizeConfig(undefined)
/** 没有宿主服务的上下文：所有动作只能走磁盘或不适用。 */
const hostless = { get: () => undefined }

console.log('=== dsh-controller selftest ===')
console.log(`DSH_HOME      : ${dshHome()}`)
console.log(`profile dir   : ${profileDir()}`)
console.log(`screenshots   : ${config.ui.screenshotDir}`)

console.log('\n=== 1. 工具 schema ===')
for (const definition of toolDefinitions(adapter(hostless, config), config, logger)) {
  const actions = definition.parameters.properties.action.enum
  console.log(`${definition.name.padEnd(14)} actions=${actions.join(',')}`)
}

console.log('\n=== 2. 磁盘回退（没有宿主服务）===')
const diskHost = adapter(hostless, config)
const overview = await diskHost.overview()
console.log(JSON.stringify({
  runtimeDesktopVersion: overview.dsh.runtime.desktopVersion,
  workspaces: overview.workspaces?.count ?? null,
  sessions: overview.sessions,
  warnings: overview.warnings,
}, null, 2))

console.log('\n=== 3. 服务探测（宿主缺席时的样子）===')
const capabilities = probe(hostless)
console.log(JSON.stringify({
  unavailable: capabilities.api.filter((entry) => !entry.available).map((entry) => entry.service),
  firstEvidence: capabilities.api[0].evidence,
  ui: capabilities.ui,
}, null, 2))

console.log('\n=== 4. UI 回退：找 DSH 窗口（不前台化、不输入）===')
if (process.platform !== 'win32') {
  console.log('非 Windows：回退脚本不适用，跳过。')
} else {
  const window = await runDesktop('window', {}, config)
  console.log(JSON.stringify({
    ok: window.ok,
    reason: window.reason ?? null,
    target: window.target === undefined || window.target === null ? null : { title: window.target.title, process: window.target.process, rect: window.target.rect, background: window.target.background },
    matches: Array.isArray(window.matches) ? window.matches.length : 0,
  }, null, 2))
}

console.log('\n自检结束。上面任何一项写 "null" 都是「这台机器上没有」，不是失败。')
