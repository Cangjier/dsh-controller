/**
 * 优雅退出那一腿：点托盘菜单里的「退出」，让应用自己走。
 *
 * ## 为什么这一腿现在才存在
 *
 * 早先的结论是「没有一条『应用自己退出』的路可以在无人值守时依赖」——`ctx.appExit` 只关 Host、
 * 关主窗口不退、托盘那条路够不着（窗口盖住任务栏、通知区域折叠、UIA 下 0 个子元素）。所以重启
 * 一直靠**收进程树**完成，代价是明说的：数据面安全，但丢的是应用自己的收尾动作。
 *
 * 2026-10-05 这个前提变了：`dsh-computer-use` 长出了托盘能力（`computer_tray`），它能只看像素
 * 就把托盘图标找出来、右键、读出菜单、按名字点中一项——包括**折叠在 `^` 后面的**那些图标。
 * 于是「点托盘菜单里的退出」从一个够不着的坐标，变成了一条可调用、可验证的路。
 *
 * ## 它在这里做什么，不做什么
 *
 * 只做一件事：让应用自己退出。**不做**的是「拉起」——那仍然是进程外看门狗的事，因为应用退出
 * 之后，它自己进程里的任何代码都不存在了。所以顺序不变：计划落盘 → 看门狗先起来 → 再请求退出；
 * 变的只是「请求退出」这一步从「等看门狗到点强杀」变成「先请它自己走，走不掉再看门狗收」。
 *
 * ## 依赖是可选的，缺了就说清楚
 *
 * 托盘能力在**另一个插件**里。这里用三条候选路径去找它（profile 的 node_modules、同一个仓库家族
 * 的开发布局、以及包名说明符），第一条能 import 且导出所需函数的就用；一条都不成，这一腿就
 * 报「优雅退出不可用」并**退回原来的强杀**，绝不因为找不到兄弟插件而让重启失败。
 *
 * 不去调 `tools` 服务的 `execute` 是有意的：那需要自己造一个 `exec` 载体（调度器令牌、取消状态、
 * 策略管线），而它的字段是随宿主版本变的——正是本插件一直拒绝的那种耦合。
 *
 * @module dsh-controller/host/graceful-quit
 */
import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { profileDir } from './paths.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/** dsh-controller 自己的仓库根。 */
export const PLUGIN_ROOT = resolve(HERE, '..', '..')

/** 兄弟插件的包名。 */
export const TRAY_PLUGIN = 'dsh-computer-use'

/** 托盘核心相对包根的路径。 */
const TRAY_ENTRY = join('src', 'core', 'index.mjs')

/** 工具层相对包根的路径：这一条才是**首选**，见 {@link loadTrayTool}。 */
const TOOL_ENTRY = join('src', 'tools', 'index.mjs')

/** 包根：配置归一化在那儿。 */
const ROOT_ENTRY = 'index.mjs'

/** 库里的那个脚本名。dsh-controller 不自己写一套退出编排，它跑这个脚本。 */
export const QUIT_SCRIPT = 'quit-dsh'

/** 工具层里的那个工具名。 */
export const QUIT_TOOL = 'computer_script'

/**
 * 去找托盘核心的三条候选路径，按「最可能对、又最不依赖巧合」排序。
 *
 * 1. **profile 的 node_modules**：插件是 `link:` 进 profile 的，所以这是运行时真正被加载的那一份。
 *    用绝对路径而不是包名说明符，因为本插件自己也是软链进来的：Node 会从**仓库的真实路径**往上找，
 *    走到 profile 的 node_modules 是走不到的。
 * 2. **同一个仓库家族的开发布局**：`<本插件>/../dsh-computer-use`，本机就是这个布局。
 * 3. **包名说明符**：万一宿主把 profile 的 node_modules 放进了本进程的解析路径（或它被声明成依赖）。
 *
 * @param {object} [deps] - `{ profileDir, pluginRoot }`，测试用。
 * @returns {string[]} 候选说明符（前两条是 file URL）。
 */
export function trayCandidates(deps = {}) {
  const profile = typeof deps.profileDir === 'function' ? deps.profileDir() : profileDir()
  const root = typeof deps.pluginRoot === 'string' ? deps.pluginRoot : PLUGIN_ROOT
  return [
    pathToFileURL(join(profile, 'node_modules', TRAY_PLUGIN, TRAY_ENTRY)).href,
    pathToFileURL(join(root, '..', TRAY_PLUGIN, TRAY_ENTRY)).href,
    `${TRAY_PLUGIN}/core`,
  ]
}

/** 一条失败原因，短到能进计划文件。 */
function shortReason(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 200 ? `${message.slice(0, 197)}...` : message
}

/** 工具层要一个 logger；默认安静，这样「跑一次脚本」不会往宿主日志里灌东西。 */
function quietLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} }
}

/**
 * 兄弟插件**工具层**的三条候选路径，与 {@link trayCandidates} 同一套排序。
 *
 * 每一对是 `{ tools, root }`：工具定义在 `src/tools/index.mjs`，配置归一化在包根。两个都要，
 * 因为造一个工具定义要传归一化后的配置。
 *
 * @param {object} [deps] - `{ profileDir, pluginRoot }`，测试用。
 * @returns {Array<{tools: string, root: string}>} 候选。
 */
export function trayToolCandidates(deps = {}) {
  const profile = typeof deps.profileDir === 'function' ? deps.profileDir() : profileDir()
  const root = typeof deps.pluginRoot === 'string' ? deps.pluginRoot : PLUGIN_ROOT
  const base = join(root, '..', TRAY_PLUGIN)
  return [
    {
      tools: pathToFileURL(join(profile, 'node_modules', TRAY_PLUGIN, TOOL_ENTRY)).href,
      root: pathToFileURL(join(profile, 'node_modules', TRAY_PLUGIN, ROOT_ENTRY)).href,
    },
    { tools: pathToFileURL(join(base, TOOL_ENTRY)).href, root: pathToFileURL(join(base, ROOT_ENTRY)).href },
    { tools: `${TRAY_PLUGIN}/tools`, root: TRAY_PLUGIN },
  ]
}

/**
 * 载入兄弟插件的**工具层**——这是首选的一条路。
 *
 * 为什么走工具而不是直接调核心：dsh-controller 要的是「把退出这件事交给 dsh-computer-use」，
 * 而那个插件对外承诺的接口是它的**工具**。`computer_script { action:"run", name:"quit-dsh" }`
 * 是用户能按、能被文档描述、能被别的插件照抄的那一句话；直接调核心函数等于绕过它，把两个插件的
 * 内部形状焊在一起——兄弟插件重构一次核心，这里就坏一次。
 *
 * **不去调宿主的 `tools` 服务**（那需要自己造 `exec` 载体：调度器令牌、取消状态、策略管线，字段随
 * 宿主版本变）。这里用的是兄弟插件**自己导出的** `toolDefinitions(config, logger)`，它的
 * `execute(args, context)` 只要一个 `{ cwd }`——这是包边界内的调用，不是宿主协议。
 *
 * @param {object} [deps] - `{ import, profileDir, pluginRoot }`，测试用。
 * @returns {Promise<{ ok: boolean, toolDefinitions: Function|null, normalizeConfig: Function|null, specifier: string|null, attempts: object[] }>} 结果。
 */
export async function loadTrayTool(deps = {}) {
  const importModule = typeof deps.import === 'function' ? deps.import : (specifier) => import(specifier)
  const attempts = []
  for (const candidate of trayToolCandidates(deps)) {
    try {
      const [tools, root] = await Promise.all([importModule(candidate.tools), importModule(candidate.root)])
      const usable = typeof tools?.toolDefinitions === 'function' && typeof root?.normalizeConfig === 'function'
      attempts.push({
        specifier: candidate.tools,
        ok: usable,
        reason: usable ? null : '模块里没有 toolDefinitions（或包根没有 normalizeConfig）',
      })
      if (usable) {
        return {
          ok: true,
          toolDefinitions: tools.toolDefinitions,
          normalizeConfig: root.normalizeConfig,
          specifier: candidate.tools,
          attempts,
        }
      }
    } catch (error) {
      attempts.push({ specifier: candidate.tools, ok: false, reason: shortReason(error) })
    }
  }
  return { ok: false, toolDefinitions: null, normalizeConfig: null, specifier: null, attempts }
}

/**
 * 把 `quitApplicationViaTray` 或 `quit-dsh` 的结果，映射成这一腿对外承诺的证据形状。
 *
 * 两条新路（工具、核心）返回的是同一个结构，所以映射只有一份：计划文件与调用方读的字段
 * （`attempted` / `clicked` / `icon` / `item.text` / `item.x` / `item.y` / `confirmation` /
 * `menuClosed` / `reason`）与老路完全一致，新增字段（`mode` / `learned` / `timeline`）只增不改。
 *
 * @param {object} outcome - 新路的结果。
 * @param {object} extra - `{ capability, specifier, attempts, fallbackMs }`。
 * @returns {object} 证据。
 */
function mapOutcome(outcome, extra) {
  const item = outcome?.item ?? null
  return {
    attempted: outcome?.attempted !== false,
    clicked: outcome?.clicked === true,
    capability: extra.capability,
    specifier: extra.specifier,
    mode: outcome?.mode ?? null,
    icon: outcome?.icon ?? null,
    item: item === null
      ? null
      : { text: item.text ?? null, x: item.at?.x ?? item.x ?? null, y: item.at?.y ?? item.y ?? null, at: item.at ?? null },
    confirmation: outcome?.confirmation ?? null,
    menuClosed: outcome?.menuClosed ?? null,
    learned: outcome?.learned ?? null,
    timeline: outcome?.timeline ?? [],
    dryRun: outcome?.dryRun === true,
    reason: outcome?.reason
      ?? (outcome?.clicked === true ? null : outcome?.dryRun === true ? '演练：走了整条路，没有真的退出' : '这一腿没有点中退出项'),
    attempts: extra.attempts,
    elapsedMs: Number.isFinite(outcome?.elapsedMs) ? outcome.elapsedMs : extra.fallbackMs,
  }
}

/**
 * 首选的一条路：跑兄弟插件库里的 `quit-dsh` 脚本。
 *
 * 调用的是**工具**：`computer_script { action:"run", name:"quit-dsh" }`。参数一路传进去
 * （应用名、菜单项、预算），返回的 `returned` 就是脚本的结论，与核心那条路同构。
 *
 * 三种「没跑成」要分开：工具层里没有这个工具、脚本库的 `run` 报错（通常是库里没有这个脚本）、
 * 以及脚本自己抛错。三种都**不抛出去**，而是把原因交给调用方去走下一条路——这一腿的契约是
 * 「绝不因为优雅退出失败而让重启失败」。
 *
 * @param {object} request - `{ tool, wanted, deps, elapsed }`。
 * @returns {Promise<{ outcome: object|null, reason: string|null }>} 结论，或没跑成的原因。
 */
async function quitThroughScript(request) {
  const { tool, wanted, deps, elapsed } = request
  const logger = typeof deps.logger === 'object' && deps.logger !== null ? deps.logger : quietLogger()
  try {
    const definitions = tool.toolDefinitions(tool.normalizeConfig(undefined), logger)
    const definition = Array.isArray(definitions) ? definitions.find((entry) => entry.name === QUIT_TOOL) : undefined
    if (definition === undefined || typeof definition.execute !== 'function') {
      return { outcome: null, reason: `兄弟插件的工具层里没有 ${QUIT_TOOL}` }
    }
    const result = await definition.execute(
      {
        action: 'run',
        name: QUIT_SCRIPT,
        // 只有确定有值才传：脚本那边的默认值（名字、菜单项、预算）比这里的猜测更可信。
        args: {
          ...(wanted.iconName === null ? {} : { name: wanted.iconName }),
          item: wanted.item,
          confirm: wanted.confirm,
          budgetMs: wanted.budgetMs,
          // 演练：脚本走完整条路但不答确认框。dsh-controller 自己也需要一个「不影响任何东西地
          // 验证这一腿」的入口，否则它永远只能在真重启里被验证。
          ...(wanted.dryRun ? { dryRun: true } : {}),
        },
      },
      { cwd: typeof deps.cwd === 'string' && deps.cwd !== '' ? deps.cwd : process.cwd() },
    )
    if (result === null || typeof result !== 'object' || result.ok !== true) {
      const why = result?.error?.message ?? result?.error ?? '脚本没有返回 ok'
      return { outcome: null, reason: `${QUIT_SCRIPT} 脚本没跑成：${shortReason(why)}` }
    }
    return {
      outcome: mapOutcome(result.returned ?? {}, {
        capability: 'script',
        specifier: tool.specifier,
        attempts: tool.attempts,
        fallbackMs: elapsed(),
      }),
      reason: null,
    }
  } catch (error) {
    return { outcome: null, reason: `跑 ${QUIT_SCRIPT} 脚本失败：${shortReason(error)}（脚本库里没有它？）` }
  }
}


/**
 * 载入托盘核心，并说清它提供哪一代能力。
 *
 * 判定「能用的那一份」不是「import 成功」而是「它真的导出能用的东西」：一个装错的同名包 import
 * 得进来、什么也不提供，那种情况必须继续往下试，而不是带着 null 去调用。
 *
 * 两代能力，优先用新一代：
 *
 *   - **`fast`**：`quitApplicationViaTray`——图片匹配托盘图标，约 2.5 秒走完；匹配不到就退回逐个悬停
 *     的笨办法，并把图标裁下来当模板，下次直接匹配。2026-10-05 起 dsh-computer-use 提供。
 *   - **`classic`**：`findTrayIcon` + `invokeTrayMenuItem`——插件自己编排那两步，逐个悬停找图标，
 *     实测 52–96 秒。留着是为了兼容一个**还没升级的兄弟插件**，不是因为它更好。
 *
 * @param {object} [deps] - `{ import, profileDir, pluginRoot }`，测试用。
 * @returns {Promise<{ ok: boolean, module: object|null, specifier: string|null, capability: string|null, attempts: object[] }>} 结果。
 */
export async function loadTrayCore(deps = {}) {
  const importModule = typeof deps.import === 'function' ? deps.import : (specifier) => import(specifier)
  const attempts = []
  for (const specifier of trayCandidates(deps)) {
    try {
      const module = await importModule(specifier)
      const fast = typeof module?.quitApplicationViaTray === 'function'
      const classic = typeof module?.findTrayIcon === 'function' && typeof module?.invokeTrayMenuItem === 'function'
      const capability = fast ? 'fast' : classic ? 'classic' : null
      attempts.push({
        specifier,
        ok: capability !== null,
        capability,
        reason: capability === null ? '模块里既没有 quitApplicationViaTray，也没有 findTrayIcon + invokeTrayMenuItem' : null,
      })
      if (capability !== null) return { ok: true, module, specifier, capability, attempts }
    } catch (error) {
      attempts.push({ specifier, ok: false, capability: null, reason: shortReason(error) })
    }
  }
  return { ok: false, module: null, specifier: null, capability: null, attempts }
}

/**
 * 允许的「优雅退出」动作，逐条写清楚，因为这是一个会**真的发出鼠标点击**的动作。
 * @param {object} spec - `{ iconName, item, budgetMs, scratchDir, language }`。
 * @returns {object} 归一化后的参数。
 */
function normaliseSpec(spec = {}) {
  const iconName = typeof spec.iconName === 'string' && spec.iconName.trim() !== '' ? spec.iconName.trim() : null
  const item = typeof spec.item === 'string' && spec.item.trim() !== '' ? spec.item.trim() : '退出'
  return {
    iconName,
    item,
    // 确认框默认要答：实测点了「退出」并不会退出，应用会再问一句。
    confirm: spec.confirm !== false,
    // 演练：走完整条路但不答确认框。给「优雅退出这一腿到底能不能落地」一个可验证的入口，
    // 也因此能在不影响任何东西的前提下真机验证它。
    dryRun: spec.dryRun === true,
    budgetMs: Number.isFinite(spec.budgetMs) && spec.budgetMs > 0 ? Math.round(spec.budgetMs) : 60_000,
    scratchDir: typeof spec.scratchDir === 'string' && spec.scratchDir !== '' ? spec.scratchDir : null,
    language: typeof spec.language === 'string' && spec.language !== '' ? spec.language : 'zh-Hans-CN',
  }
}

/**
 * 显式许可：只有设了它，测试运行里的托盘退出才会真的动手。
 *
 * 存在的理由是它挡住的那件事：这一腿**真的会把宿主应用关掉**，而「跑一遍测试」不该有关掉应用的
 * 副作用。2026-10-05 实测发生过一次：`tests/services.test.mjs` 里一条 restartHost 用例没有注入
 * `deps.quitViaTray`，于是一次 `node --test "tests/*.test.mjs"` 真的悬停、右键、读菜单、点确认，
 * 应用在 21:13:50 退出——那一轮的测试进程也随它一起没了。
 */
export const REAL_QUIT_OPT_IN = 'DSH_CONTROLLER_ALLOW_REAL_QUIT'

/**
 * 这次调用是不是一次测试运行，而测试运行里不该真的动托盘。
 *
 * 判据是 `NODE_TEST_CONTEXT`：`node --test` 会给每个测试子进程设它（本机实测值 `child-v8`），
 * 而正常的插件进程里没有这个变量。宁可在这里拒绝一次真的重启，也不要让「跑测试」变成一个会关掉
 * 应用的动作——后者的代价（丢掉手上所有会话、丢一次排查现场）远大于前者（一行说清楚为什么拒绝）。
 *
 * @param {object} [env] - 环境变量，测试用。
 * @returns {string|null} 拒绝的理由，或者 null 表示可以继续。
 */
export function testRunRefusal(env = process.env) {
  const context = typeof env?.NODE_TEST_CONTEXT === 'string' ? env.NODE_TEST_CONTEXT.trim() : ''
  if (context === '') return null
  if (env[REAL_QUIT_OPT_IN] === '1') return null
  return (
    `拒绝真的走托盘退出：这是一次测试运行（NODE_TEST_CONTEXT=${context}），而这一腿会真的把宿主应用关掉。` +
    `测试应当注入 deps.quitViaTray；确实要在测试里打真机，就设 ${REAL_QUIT_OPT_IN}=1。`
  )
}

/**
 * 请应用自己退出：找到它自己的托盘图标，右键，点「退出」。
 *
 * 每一步的判据都是托盘核心量出来的（图标靠 tooltip 与菜单文字认、菜单靠右键前后 diff 认、点没点中
 * 靠菜单有没有关掉验证），这里只负责编排与**绝不抛错**：这一腿失败时调用方要做的事，与它根本不存在
 * 时完全相同——让看门狗到点收掉进程树。
 *
 * @param {object} spec - `{ iconName, item, budgetMs, scratchDir, language }`。
 * @param {object} [deps] - `{ import, clock, profileDir, pluginRoot, env }`，测试用。
 * @returns {Promise<object>} 证据：有没有试、找到没有、点了没有、为什么。
 */
export async function quitViaTray(spec = {}, deps = {}) {
  const clock = typeof deps.clock === 'function' ? deps.clock : Date.now
  const startedAt = clock()
  const wanted = normaliseSpec(spec)
  const elapsed = () => Math.round(clock() - startedAt)

  // 守卫在**任何副作用之前**：连托盘核心都不去载入，更不会悬停、右键或点确认。
  const refusal = testRunRefusal(deps.env ?? process.env)
  if (refusal !== null) {
    return { attempted: false, clicked: false, reason: refusal, elapsedMs: elapsed(), attempts: [], mode: null, timedOut: false }
  }

  if (wanted.iconName === null) {
    return { attempted: false, clicked: false, reason: '没有给出应用名，无法在托盘里认出它的图标', elapsedMs: 0, attempts: [], mode: null, timedOut: false }
  }

  // 首选：跑兄弟插件库里的 quit-dsh 脚本——也就是用**它的工具**，而不是它的某个内部函数。
  // 「跑测试/跑脚本来退出」这件事由那个插件负责，这里只负责把参数递过去、把结论读回来。
  const notes = []
  const tool = await loadTrayTool(deps)
  if (tool.ok) {
    const scriptRoute = await quitThroughScript({ tool, wanted, deps, elapsed })
    if (scriptRoute.outcome !== null) return scriptRoute.outcome
    notes.push(scriptRoute.reason)
  } else {
    notes.push('兄弟插件没有可用的工具层（src/tools/index.mjs）')
  }

  const load = await loadTrayCore(deps)
  if (!load.ok) {
    return {
      attempted: false,
      clicked: false,
      capability: null,
      notes,
      reason: `找不到托盘能力的实现（${TRAY_PLUGIN}）：优雅退出不可用，退回强杀`,
      elapsedMs: elapsed(),
      attempts: [...tool.attempts, ...load.attempts],
    }
  }
  const tray = load.module
  const reading = {
    ...(wanted.scratchDir === null ? {} : { scratchDir: wanted.scratchDir }),
    language: wanted.language,
  }

  // 次选：兄弟插件导出的是核心的那一代能力——一条路走完（匹配 → 找 → 学）。
  if (load.capability === 'fast') {
    let outcome = null
    let failure = null
    try {
      outcome = await tray.quitApplicationViaTray({
        name: wanted.iconName,
        item: wanted.item,
        confirm: wanted.confirm,
        budgetMs: wanted.budgetMs,
        ...(wanted.dryRun ? { dryRun: true } : {}),
        ...reading,
      })
    } catch (error) {
      failure = shortReason(error)
    }
    if (outcome === null) {
      return {
        attempted: true,
        clicked: false,
        capability: 'fast',
        specifier: load.specifier,
        notes,
        reason: `托盘能力报错：${failure ?? '没有返回结果'}`,
        attempts: [...tool.attempts, ...load.attempts],
        elapsedMs: elapsed(),
      }
    }
    return { ...mapOutcome(outcome, { capability: 'fast', specifier: load.specifier, attempts: load.attempts, fallbackMs: elapsed() }), notes }
  }

  // 兜底：兄弟插件只有老一代能力（还没升级），插件自己编排「找图标、点菜单项」那两步。
  // 指针先记下来：这一腿失败时要把机器放回原样（按下菜单项那一下之后就不必了，应用正在退出）。
  let pointer = null
  try {
    pointer = await tray.readPointer(reading)
  } catch {
    pointer = null
  }

  let found = null
  let searchError = null
  // 搜过哪些区域要跨两次尝试累积：只报最后一次的 `searched` 会让「折叠区和任务栏都找过了」变成
  // 「只在折叠区找过」，而调用方正是靠这句话决定要不要相信「这个图标不在托盘里」。
  const searched = []
  const collect = (result) => {
    for (const inventory of result?.searched ?? []) {
      searched.push({ scope: inventory.scope, region: inventory.region ?? null, candidates: inventory.candidates ?? 0, icons: (inventory.icons ?? []).length })
    }
    return result
  }
  try {
    found = collect(await tray.findTrayIcon({ ...reading, name: wanted.iconName, scope: 'overflow', reveal: true, names: 'auto', maxHovers: 8, maxMenus: 6 }))
  } catch (error) {
    searchError = shortReason(error)
  }

  if (elapsed() < wanted.budgetMs && (found === null || found.matches.length === 0)) {
    // 折叠区里没有：那就连任务栏上钉着的那些一起找。这一条更贵（可见区与折叠区各走一遍），
    // 所以只在预算还够、而且第一条路确实没找到时才走。
    try {
      const wider = collect(await tray.findTrayIcon({ ...reading, name: wanted.iconName, scope: 'both', reveal: true, names: 'auto', maxHovers: 12, maxMenus: 8 }))
      if (wider.matches.length > 0) found = wider
    } catch (error) {
      searchError = searchError ?? shortReason(error)
    }
  }

  if (found === null || found.matches.length === 0) {
    if (pointer !== null) {
      try { await tray.dismissTray(reading) } catch { /* 收不起来也不影响结论 */ }
      try { await tray.restorePointer(pointer, reading) } catch { /* 同上 */ }
    }
    return {
      attempted: true,
      clicked: false,
      specifier: load.specifier,
      reason: searchError === null
        ? `托盘里没有名字匹配 ${JSON.stringify(wanted.iconName)} 的图标（可见区与折叠区都找过）`
        : `找图标时出错：${searchError}`,
      searched,
      elapsedMs: elapsed(),
      attempts: load.attempts,
    }
  }

  const target = found.matches[0]
  let outcome = null
  let invokeError = null
  try {
    // `confirm` 默认就是开的：**实测点了「退出」并不会退出**，应用会再问一句
    // （`退出 DeepSeek Harness?`，按钮是「退出」与「取消」）。不走完这一步，这一腿就永远退不出去，
    // 而且会在用户桌面上留一个模态框。
    outcome = await tray.invokeTrayMenuItem({ ...reading, point: target.point, layout: found.layout, item: wanted.item, confirm: wanted.confirm })
  } catch (error) {
    invokeError = shortReason(error)
  }

  if (outcome === null || outcome.clicked !== true) {
    if (pointer !== null) {
      try { await tray.dismissTray(reading) } catch { /* 收不起来也不影响结论 */ }
      try { await tray.restorePointer(pointer, reading) } catch { /* 同上 */ }
    }
    return {
      attempted: true,
      clicked: false,
      specifier: load.specifier,
      icon: { name: target.name, menuItems: target.menuItems ?? null, point: target.point },
      reason: invokeError !== null
        ? `点击菜单项时出错：${invokeError}`
        : outcome === null
          ? '点击没有返回结果'
          : `菜单里没有匹配 ${JSON.stringify(wanted.item)} 的项：${(outcome.candidates ?? []).join(' / ') || '菜单是空的'}`,
      elapsedMs: elapsed(),
      attempts: load.attempts,
    }
  }

  return {
    attempted: true,
    clicked: true,
    specifier: load.specifier,
    icon: { name: target.name, menuItems: target.menuItems ?? null, point: target.point },
    item: { text: outcome.item?.text ?? null, at: outcome.at ?? null },
    menuClosed: outcome.menuClosed ?? null,
    // 「点了菜单项」与「应用真的开始退」是两件事，中间隔着一个确认框。它答没答上，是这一腿成不成
    // 的唯一内部证据——应用退出之后就没有下一句话可说了。
    confirmation: outcome.confirmation ?? null,
    elapsedMs: elapsed(),
    attempts: load.attempts,
  }
}

/**
 * 这一腿要花多久：看门狗的强杀宽限必须比它长。
 *
 * 否则「优雅退出」就是一个笑话——看门狗会在托盘点击落地之前把进程树收掉。多出来的秒数直接加在
 * `killAfterSeconds` 上，而不是引入插件与看门狗之间的第二个通信通道：一个数字比一个协议好。
 * @param {number} budgetMs - 优雅退出的预算（毫秒）。
 * @param {number} killAfterSeconds - 原本的强杀宽限（秒）。
 * @returns {number} 交给看门狗的强杀宽限（秒）。
 */
export function watcherGraceSeconds(budgetMs, killAfterSeconds) {
  const extra = Number.isFinite(budgetMs) && budgetMs > 0 ? Math.ceil(budgetMs / 1000) : 0
  const base = Number.isFinite(killAfterSeconds) ? killAfterSeconds : 0
  return extra + base
}

/**
 * 应用名 → 托盘图标名。
 *
 * 默认拿**要拉起的那个 exe 的文件名**当图标名：托盘菜单里写的通常就是产品名，而这是本进程已经
 * 确知、又不需要任何猜测的名字（本机 `DeepSeek Harness.exe` → `DeepSeek Harness`，与菜单里的
 * `退出 DeepSeek Harness` 对得上）。找不到 exe 时返回 null，这一腿就会明确报「没有应用名」。
 * @param {string} exe - exe 路径。
 * @returns {string|null} 图标名。
 */
export function iconNameFromExe(exe) {
  if (typeof exe !== 'string' || exe === '') return null
  const stem = basename(exe).replace(/\.exe$/i, '').trim()
  return stem === '' ? null : stem
}

/** 便于测试与自检：这个模块是否找得到兄弟插件（不产生任何副作用之外的调用）。 */
export async function trayCoreStatus(deps = {}) {
  const load = await loadTrayCore(deps)
  return {
    available: load.ok,
    capability: load.capability,
    specifier: load.specifier,
    attempts: load.attempts,
    candidates: trayCandidates(deps),
    ...(load.ok ? {} : { note: '优雅退出不可用：重启会退回「给优雅退出留一段宽限，到点收掉进程树」的老路，功能不受影响。' }),
  }
}

/** 便于自检：这条候选路径在磁盘上存在吗（只查前两条 file URL 候选）。 */
export function trayCandidatesOnDisk(deps = {}) {
  return trayCandidates(deps)
    .filter((specifier) => specifier.startsWith('file:'))
    .map((specifier) => ({ specifier, exists: existsSync(fileURLToPath(specifier)) }))
}
