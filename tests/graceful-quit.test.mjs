/**
 * 优雅退出那一腿的离线用例。
 *
 * 这里**不碰桌面**：托盘能力是一个被假造出来的模块，`import` 也是注入的。要钉住的是三件事：
 *
 *   1. **发现顺序与判据**——「import 成功」不算数，「导出那两个函数」才算，一条不成继续下一条；
 *   2. **找不到兄弟插件时不许失败**——它必须报「优雅退出不可用」并让调用方走回强杀的老路；
 *   3. **失败时把机器放回原样**——没点中就把折叠区收起来、指针放回去（点中了就不必了，应用正在退出）。
 *
 * 数字来自实机：托盘折叠区四个图标走完约 20–30 秒；看门狗的默认强杀宽限是 10 秒——所以
 * 「预算要加进宽限」不是修辞，是这一腿能不能落地的前提。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TRAY_PLUGIN,
  iconNameFromExe,
  loadTrayCore,
  quitViaTray,
  trayCandidates,
  trayCandidatesOnDisk,
  watcherGraceSeconds,
} from '../src/host/graceful-quit.mjs'

/**
 * 这些用例测的是编排：把参数摆好、看每一步有没有按顺序发生。它们不碰这台机器——托盘核心是替身。
 *
 * `env: {}` 是必须的：真实进程里没有 `NODE_TEST_CONTEXT`，而 `node --test` 会给子进程设它，
 * 守卫据此拒绝真的动托盘（这一腿会关掉宿主应用，见 quitViaTray 的注释）。这里显式给一个「不是
 * 测试运行」的环境，等于告诉守卫「这条路径上的副作用都已经被替换掉了」。
 */
const quit = (spec, deps = {}) => quitViaTray(spec, { env: {}, ...deps })

test('测试运行里绝不真的动托盘：守卫在载入托盘核心之前就拒绝，并说清怎么打真机', async () => {
  const result = await quitViaTray({ iconName: 'DeepSeek Harness' }, {
    env: { NODE_TEST_CONTEXT: 'child-v8' },
    import: async () => { throw new Error('守卫应当在这之前就返回') },
    clock: () => 0,
  })
  assert.equal(result.attempted, false)
  assert.equal(result.clicked, false)
  assert.match(result.reason, /拒绝真的走托盘退出/)
  assert.match(result.reason, /NODE_TEST_CONTEXT=child-v8/)
  assert.match(result.reason, /DSH_CONTROLLER_ALLOW_REAL_QUIT=1/)
  assert.match(result.reason, /deps\.quitViaTray/)
})

test('显式许可之后守卫放行，余下的判断照旧', async () => {
  const result = await quitViaTray({ iconName: null }, {
    env: { NODE_TEST_CONTEXT: 'child-v8', DSH_CONTROLLER_ALLOW_REAL_QUIT: '1' },
    import: async () => { throw new Error('名字为空，不该走到载入') },
  })
  assert.equal(result.attempted, false)
  assert.match(result.reason, /没有给出应用名/)
})

/** 一个假的托盘核心，记录每次调用，并按需给出结论。 */
function fakeTray(options = {}) {
  const calls = []
  const module = {
    readPointer: async () => {
      calls.push(['readPointer'])
      return { x: 640, y: 1487 }
    },
    restorePointer: async (point) => {
      calls.push(['restorePointer', point])
      return point
    },
    dismissTray: async () => {
      calls.push(['dismissTray'])
      return { closed: true }
    },
    findTrayIcon: async (request) => {
      calls.push(['findTrayIcon', request.scope])
      const inventory = {
        scope: request.scope,
        region: { x: 2004, y: 1384, width: 136, height: 136 },
        icons: options.icons ?? [],
        candidates: options.candidates ?? 4,
        notes: [],
      }
      return {
        layout: { screen: { x: 0, y: 0, width: 2560, height: 1600 } },
        searched: [inventory],
        revealed: { opened: true },
        matches: options.match === false ? [] : (options.matches ?? [{ point: { x: 2105, y: 1487 }, name: null, menuItems: ['打开 DeepSeek Harness', '退出 DeepSeek Harness'] }]),
        notes: [],
      }
    },
    invokeTrayMenuItem: async (request) => {
      calls.push(['invokeTrayMenuItem', request.item, request.point, request.confirm])
      if (options.invokeThrows === true) throw new Error('boom')
      return options.invoke ?? {
        clicked: true,
        item: { text: '退出 DeepSeek Harness', x: 2279, y: 1437 },
        at: { x: 2279, y: 1437 },
        menuClosed: true,
        confirmation: {
          appeared: true,
          clicked: true,
          window: { handle: 7275128, pid: 1052, title: 'DeepSeek Harness' },
          button: { text: '退出', x: 879, y: 527 },
          verified: true,
        },
      }
    },
  }
  return { module, calls }
}

test('图标名默认取要拉起的那个 exe 的文件名', () => {
  // 本机实测：exe 是 `DeepSeek Harness.exe`，托盘菜单里写的是「退出 DeepSeek Harness」——对得上。
  assert.equal(iconNameFromExe('C:\\app\\DeepSeek Harness.exe'), 'DeepSeek Harness')
  assert.equal(iconNameFromExe('C:/app/DeepSeek Harness.EXE'), 'DeepSeek Harness')
  assert.equal(iconNameFromExe('C:\\app\\notepad.exe'), 'notepad')
  assert.equal(iconNameFromExe(''), null)
  assert.equal(iconNameFromExe(null), null)
})

test('优雅退出的预算加在强杀宽限上，而不是替换它', () => {
  // 10 秒的默认宽限对不上一次 20–30 秒的托盘搜索：不加起来，看门狗会在点击落地前收树。
  assert.equal(watcherGraceSeconds(60_000, 10), 70)
  assert.equal(watcherGraceSeconds(30_000, 25), 55)
  assert.equal(watcherGraceSeconds(0, 10), 10)
  assert.equal(watcherGraceSeconds(undefined, 10), 10)
  // 不足一秒的预算也要进位：宁可多等一秒，也不要差半秒把树收掉。
  assert.equal(watcherGraceSeconds(1, 0), 1)
  assert.equal(watcherGraceSeconds(100, 0), 1)
})

test('候选路径先看 profile，再看同一个仓库家族的开发布局，最后才是包名', () => {
  const candidates = trayCandidates({ profileDir: () => 'C:\\home\\profiles\\desktop', pluginRoot: 'C:\\repo\\dsh-controller' })
  assert.equal(candidates.length, 3)
  assert.match(candidates[0], /profiles\/desktop\/node_modules\/dsh-computer-use\/src\/core\/index\.mjs$/)
  assert.match(candidates[1], /repo\/dsh-computer-use\/src\/core\/index\.mjs$/)
  assert.equal(candidates[2], `${TRAY_PLUGIN}/core`)
  // 前两条是绝对 file URL：本插件自己也是软链进 profile 的，用包名让 Node 从仓库真实路径往上找
  // 是找不到 profile 的 node_modules 的。
  assert.ok(candidates[0].startsWith('file:///'))
  assert.ok(candidates[1].startsWith('file:///'))
})

test('本机上托盘能力的候选路径确实存在（这条会在布局变了的时候先叫）', () => {
  const onDisk = trayCandidatesOnDisk()
  assert.equal(onDisk.length, 2)
  assert.ok(onDisk[0].exists, `profile 里应该能找到兄弟插件：${onDisk[0].specifier}`)
})

test('import 成功但没导出能用的东西的一律不算数，继续试下一条', async () => {
  const tried = []
  const result = await loadTrayCore({
    profileDir: () => 'C:\\home\\profiles\\desktop',
    pluginRoot: 'C:\\repo\\dsh-controller',
    import: async (specifier) => {
      tried.push(specifier)
      if (tried.length === 1) return { somethingElse: true }
      if (tried.length === 2) throw new Error('ENOENT')
      return { findTrayIcon() {}, invokeTrayMenuItem() {} }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(tried.length, 3)
  assert.match(result.specifier, /dsh-computer-use\/core$/)
  assert.equal(result.capability, 'classic', '只导出那两个函数的，是老一代能力')
  assert.match(result.attempts[0].reason, /既没有 quitApplicationViaTray，也没有 findTrayIcon \+ invokeTrayMenuItem/)
  assert.match(result.attempts[1].reason, /ENOENT/)
  assert.equal(result.attempts[2].ok, true)
})

test('同时导出两代能力时选新一代：图片匹配那条路', async () => {
  const result = await loadTrayCore({
    pluginRoot: 'C:\\repo\\dsh-controller',
    import: async () => ({ quitApplicationViaTray() {}, findTrayIcon() {}, invokeTrayMenuItem() {} }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.capability, 'fast')
  assert.equal(result.attempts[0].ok, true)
})

test('一条候选都不成时明确报「不可用」，而不是抛错', async () => {
  const result = await loadTrayCore({ import: async () => { throw new Error('not found') } })
  assert.equal(result.ok, false)
  assert.equal(result.module, null)
  assert.equal(result.attempts.length, 3)
})

test('点了菜单里的退出：结论、证据、耗时一起回来', async () => {
  const { module, calls } = fakeTray()
  const result = await quit(
    { iconName: 'DeepSeek Harness', item: '退出', budgetMs: 60_000 },
    { import: async () => module, clock: (() => { let t = 0; return () => (t += 500) })() },
  )
  assert.equal(result.attempted, true)
  assert.equal(result.clicked, true)
  assert.equal(result.item.text, '退出 DeepSeek Harness')
  assert.equal(result.item.at.x, 2279)
  assert.equal(result.menuClosed, true)
  // 先找折叠区（20–30 秒那条路），没找到才扩大到「可见区 + 折叠区」。
  assert.deepEqual(calls.filter((call) => call[0] === 'findTrayIcon').map((call) => call[1]), ['overflow'])
  assert.deepEqual(calls.find((call) => call[0] === 'invokeTrayMenuItem').slice(1), ['退出', { x: 2105, y: 1487 }, true])
  // 「点了菜单项」不等于「应用开始退」：中间那个确认框答没答上，是这一腿唯一的内部证据。
  assert.equal(result.confirmation.appeared, true)
  assert.equal(result.confirmation.button.text, '退出')
  assert.equal(result.confirmation.verified, true)
  // 点中了就不再去复位：应用正在退出，指针留在菜单项上没有任何关系。
  assert.equal(calls.some((call) => call[0] === 'restorePointer'), false)
})

test('新一代能力被优先使用：不再自己编排「找图标、点菜单项」那两步', async () => {
  const calls = []
  const module = {
    // 新一代：一条路走完（匹配 → 找 → 学）。给一个与自己无关的记号，确认老两步一次都没被碰。
    quitApplicationViaTray: async (request) => {
      calls.push(['quitApplicationViaTray', request])
      return {
        attempted: true,
        clicked: true,
        mode: 'matched',
        icon: { point: { x: 2105, y: 1487 }, score: 1, source: 'learned' },
        item: { at: { x: 2236, y: 1449 }, text: '退出 DeepSeek Harness' },
        confirmation: { appeared: true, clicked: true, at: { x: 879, y: 527 } },
        learned: { template: 'C:\\tray\\tray-icon.png', profile: 'C:\\tray\\quit-profile.json', saved: true },
        timeline: [{ ms: 150, step: 'opened the notification flyout', note: null }],
        elapsedMs: 2400,
      }
    },
    findTrayIcon: async () => { calls.push(['findTrayIcon']); return { matches: [] } },
    invokeTrayMenuItem: async () => { calls.push(['invokeTrayMenuItem']); return { clicked: false } },
  }
  const result = await quit({ iconName: 'DeepSeek Harness', item: '退出', budgetMs: 60_000 }, { import: async () => module, clock: () => 0 })

  assert.equal(result.attempted, true)
  assert.equal(result.clicked, true)
  assert.equal(result.capability, 'fast')
  assert.equal(result.mode, 'matched')
  // 证据形状与老路一致：计划文件与调用方读的字段没变。
  assert.equal(result.item.text, '退出 DeepSeek Harness')
  assert.equal(result.item.x, 2236)
  assert.equal(result.item.y, 1449)
  assert.equal(result.confirmation.clicked, true)
  assert.equal(result.learned.saved, true)
  assert.equal(result.timeline.length, 1)
  // 传给新能力的参数：应用名、菜单项、要不要答确认框、预算，一个不少。
  assert.deepEqual(calls.map((call) => call[0]), ['quitApplicationViaTray'])
  assert.equal(calls[0][1].name, 'DeepSeek Harness')
  assert.equal(calls[0][1].item, '退出')
  assert.equal(calls[0][1].confirm, true)
  assert.equal(calls[0][1].budgetMs, 60_000)
})

test('新能力失败时把原因带出来，而不是抛出去', async () => {
  const module = {
    quitApplicationViaTray: async () => ({
      attempted: true,
      clicked: false,
      mode: 'discovered',
      reason: '托盘里没有名字匹配 "DeepSeek Harness" 的图标（可见区与折叠区都找过）',
      elapsedMs: 90_000,
    }),
  }
  const result = await quit({ iconName: 'DeepSeek Harness' }, { import: async () => module, clock: () => 0 })
  assert.equal(result.attempted, true)
  assert.equal(result.clicked, false)
  assert.equal(result.capability, 'fast')
  assert.match(result.reason, /没有名字匹配/)
  assert.equal(result.elapsedMs, 90_000)
})

test('新能力自己抛错时这一腿只报告', async () => {
  const module = { quitApplicationViaTray: async () => { throw new Error('托盘核心炸了') } }
  const result = await quit({ iconName: 'DeepSeek Harness' }, { import: async () => module, clock: () => 0 })
  assert.equal(result.attempted, true)
  assert.equal(result.clicked, false)
  assert.match(result.reason, /托盘核心炸了/)
})

test('首选是兄弟插件的工具：computer_script 跑 quit-dsh，而不是调它的内部函数', async () => {
  const ran = []
  const toolModule = {
    toolDefinitions: (config, logger) => {
      ran.push(['toolDefinitions', typeof logger?.info])
      return [{
        name: 'computer_script',
        execute: async (args, context) => {
          ran.push(['execute', args, context])
          return {
            ok: true,
            name: 'quit-dsh',
            steps: 0,
            logs: ['  173 ms  opened the notification flyout'],
            returned: {
              attempted: true,
              clicked: true,
              mode: 'matched',
              icon: { point: { x: 1414, y: 794 }, score: 1, source: 'learned' },
              item: { at: { x: 1545, y: 757 } },
              confirmation: { appeared: true, clicked: true, at: { x: 958, y: 447 } },
              learned: { template: 'C:\\tray\\tray-icon.png', profile: 'C:\\tray\\quit-profile.json', saved: true },
              elapsedMs: 2400,
            },
          }
        },
      }]
    },
  }
  const rootModule = { normalizeConfig: () => ({ scripts: { dir: 'C:\\scripts' } }) }
  const coreModule = {
    // 工具那条路成了，核心这条路一次都不该被碰。
    quitApplicationViaTray: async () => { throw new Error('不该走到核心') },
    findTrayIcon: async () => { throw new Error('不该走到核心') },
    invokeTrayMenuItem: async () => { throw new Error('不该走到核心') },
  }
  const result = await quit(
    { iconName: 'DeepSeek Harness', item: '退出', budgetMs: 60_000 },
    { import: async (specifier) => (specifier.includes('tools') ? toolModule : specifier.endsWith('index.mjs') ? rootModule : coreModule), clock: () => 0 },
  )

  assert.equal(result.attempted, true)
  assert.equal(result.clicked, true)
  assert.equal(result.capability, 'script', '走的是工具那条路')
  assert.equal(result.mode, 'matched')
  // 工具被怎么调的：动作、脚本名、以及一路传下去的参数。
  const call = ran.find((entry) => entry[0] === 'execute')
  assert.equal(call[1].action, 'run')
  assert.equal(call[1].name, 'quit-dsh')
  assert.equal(call[1].args.name, 'DeepSeek Harness')
  assert.equal(call[1].args.item, '退出')
  assert.equal(call[1].args.confirm, true)
  assert.equal(call[1].args.budgetMs, 60_000)
  assert.equal(typeof call[2].cwd, 'string', '工具要一个 cwd；不需要宿主的 exec 载体')
  // 证据形状与老路一致。
  assert.equal(result.confirmation.clicked, true)
  assert.equal(result.icon.score, 1)
  assert.equal(result.learned.saved, true)
  assert.equal(result.item.x, 1545)
  assert.equal(result.item.y, 757)
  assert.equal(result.elapsedMs, 2400)
})

test('脚本库里没有 quit-dsh 时，退到核心那条路，并把原因留在 notes 里', async () => {
  const toolModule = {
    toolDefinitions: () => [{
      name: 'computer_script',
      // 工具层的真实行为：库里没有这个脚本时 `run` 会带着 error 回来。
      execute: async () => ({ ok: false, name: 'quit-dsh', error: { name: 'ScriptError', message: '脚本库里没有 quit-dsh' } }),
    }],
  }
  const rootModule = { normalizeConfig: () => ({}) }
  const coreModule = {
    quitApplicationViaTray: async () => ({ attempted: true, clicked: true, mode: 'matched', elapsedMs: 2500 }),
  }
  const result = await quit(
    { iconName: 'DeepSeek Harness' },
    { import: async (specifier) => (specifier.includes('tools') ? toolModule : specifier.endsWith('index.mjs') ? rootModule : coreModule), clock: () => 0 },
  )
  assert.equal(result.capability, 'fast', '工具那条路不成，退到核心')
  assert.equal(result.clicked, true)
  assert.equal(result.notes.length, 1)
  assert.match(result.notes[0], /quit-dsh 脚本没跑成：脚本库里没有 quit-dsh/)
})

test('确认框没答上时要说清楚：点了菜单项，但应用并没有开始退', async () => {
  const { module } = fakeTray({
    invoke: {
      clicked: true,
      item: { text: '退出 DeepSeek Harness' },
      at: { x: 1, y: 2 },
      menuClosed: true,
      confirmation: { appeared: true, clicked: false, reason: '弹窗里没有任何一行是「是」那一类', } ,
    },
  })
  const result = await quit({ iconName: 'DeepSeek Harness' }, { import: async () => module, clock: () => 0 })
  assert.equal(result.clicked, true, '菜单项确实点中了')
  assert.equal(result.confirmation.clicked, false, '但确认框没答上，所以这一腿其实没退出去')
  assert.match(result.confirmation.reason, /没有任何一行/)
})

test('根本没有确认框时也如实报告（有些应用的退出直接生效）', async () => {
  const { module } = fakeTray({
    invoke: { clicked: true, item: { text: 'Quit' }, at: { x: 1, y: 2 }, menuClosed: true, confirmation: { appeared: false, clicked: false, reason: '等了 4 秒，没有出现新的窗口' } },
  })
  const result = await quit({ iconName: 'DeepSeek Harness' }, { import: async () => module, clock: () => 0 })
  assert.equal(result.confirmation.appeared, false)
})

test('折叠区里没有这个图标时，预算还够就扩大到整个任务栏', async () => {
  let attempt = 0
  const scopes = []
  const module = {
    readPointer: async () => ({ x: 1, y: 1 }),
    restorePointer: async () => ({}),
    dismissTray: async () => ({}),
    findTrayIcon: async (request) => {
      scopes.push(request.scope)
      attempt += 1
      return {
        layout: {},
        searched: [],
        revealed: null,
        matches: attempt === 1 ? [] : [{ point: { x: 100, y: 200 }, name: 'DeepSeek Harness' }],
        notes: [],
      }
    },
    invokeTrayMenuItem: async () => ({ clicked: true, item: { text: '退出 DeepSeek Harness' }, at: { x: 1, y: 2 }, menuClosed: true }),
  }
  const result = await quit({ iconName: 'DeepSeek Harness' }, { import: async () => module, clock: () => 0 })
  assert.equal(result.clicked, true)
  assert.deepEqual(scopes, ['overflow', 'both'])
})

test('找不到图标时把折叠区收起来、指针放回去，并把搜过哪里报出来', async () => {
  const { module, calls } = fakeTray({ match: false, icons: [], candidates: 0 })
  const result = await quit({ iconName: 'DeepSeek Harness' }, { import: async () => module, clock: () => 0 })
  assert.equal(result.attempted, true)
  assert.equal(result.clicked, false)
  assert.match(result.reason, /没有名字匹配/)
  assert.deepEqual(calls.filter((call) => call[0] === 'dismissTray').length, 1)
  assert.deepEqual(calls.find((call) => call[0] === 'restorePointer')[1], { x: 640, y: 1487 })
  assert.deepEqual(result.searched.map((entry) => entry.scope), ['overflow', 'both'])
})

test('菜单里没有那一项时不点，并把实际有哪些项还回来', async () => {
  const { module, calls } = fakeTray({ invoke: { clicked: false, candidates: ['打开 DeepSeek Harness'], reason: '没有匹配' } })
  const result = await quit({ iconName: 'DeepSeek Harness', item: 'Quit' }, { import: async () => module, clock: () => 0 })
  assert.equal(result.clicked, false)
  assert.match(result.reason, /没有匹配 "Quit" 的项/)
  assert.match(result.reason, /打开 DeepSeek Harness/)
  assert.equal(calls.some((call) => call[0] === 'restorePointer'), true, '没点中就要把机器放回原样')
  assert.equal(calls.some((call) => call[0] === 'dismissTray'), true, '菜单/折叠区也要收起来')
})

test('托盘核心抛错时这一腿只报告、不抛出去', async () => {
  const { module } = fakeTray({ invokeThrows: true })
  const result = await quit({ iconName: 'DeepSeek Harness' }, { import: async () => module, clock: () => 0 })
  assert.equal(result.clicked, false)
  assert.match(result.reason, /点击菜单项时出错：boom/)
})

test('没有应用名就没有可点的图标，直接报清楚', async () => {
  const result = await quit({ iconName: null }, { import: async () => { throw new Error('不该走到这里') } })
  assert.equal(result.attempted, false)
  assert.match(result.reason, /没有给出应用名/)
})

test('找不到兄弟插件时退回强杀，而不是让重启失败', async () => {
  const result = await quit({ iconName: 'DeepSeek Harness' }, { import: async () => { throw new Error('ENOENT') }, clock: () => 0 })
  assert.equal(result.attempted, false)
  assert.equal(result.clicked, false)
  assert.match(result.reason, /优雅退出不可用，退回强杀/)
  // 两条载入腿各试了三条候选路径：先工具层（跑 quit-dsh 脚本那条），再核心（图片匹配 / 老编排）。
  // 证据里两条都留着，读的人才知道「试过哪些地方、各自为什么不成」。
  assert.equal(result.attempts.length, 6)
  assert.equal(result.attempts.filter((entry) => entry.specifier.includes('tools')).length, 3)
  assert.deepEqual(result.notes, ['兄弟插件没有可用的工具层（src/tools/index.mjs）'])
})
