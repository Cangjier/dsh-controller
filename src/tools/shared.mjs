/**
 * 构造面向模型的 `dsh_*` 工具定义。
 *
 * 三条规矩和 `dsh-computer-use` 一致，因为它们解决的是同一个问题：
 *
 * 1. **每个工具的 JSON Schema 每一轮都在模型上下文里。** 所以按「调用者在做什么」分组，
 *    用 `action` 分派，一句话只写一遍。
 * 2. **prose 只有一个来源。** `registry.mjs` 持有用途/需求/风险，本模块从它派生工具描述与
 *    `action` 的 enum 说明；长尾（返回形状、坑、例子）由 `guide` 动作按需渲染。
 * 3. **一个动作只做一件事，并且要说清它走的是哪条路。** 本插件的核心主张是「优先 DSH 自己
 *    的 API」，所以每个结果里都带 `transport`，让调用方看得出这次是 API 还是桌面自动化。
 *
 * @module dsh-controller/tools/shared
 */
import { lookupTool } from './registry.mjs'

/** 统一的结果渲染：一个 JSON 文本块；结果自带 `text` 时直接用 `text`。 */
export const TEXT_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render(_args, value) {
    return [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value, null, 2) }]
  },
}

/** 共享 `cwd` 参数：相对路径（截图、临时文件）以它为基准。 */
export const CWD_PROPERTY = {
  type: 'string',
  description: 'Working directory that relative paths resolve against. Defaults to the session working directory, then the plugin project root, then the process working directory.',
}

/** 本插件拒绝一个请求时抛的错误；消息是给模型看的，所以要可操作。 */
export class ControllerError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ControllerError'
  }
}

/** 完整参考在哪读；每个工具描述里重复一次。 */
function guideHint(name) {
  return `Full detail: dsh_control {action:"guide", tool:"${name}"}.`
}

/**
 * 一个动作的决策级说明，用作 `action` 的 enum 描述。
 *
 * 常驻，所以按优先级拼并且有长度上限：做什么 → 必填参数 → 风险 → 什么时候用。
 * 放不下的都在 `guide` 里。
 * @param {string} action - 动作名。
 * @param {object} entry - 它的注册表条目。
 * @returns {string} 一行 prose。
 */
export function describeAction(action, entry) {
  const BUDGET = 215
  let line = `${action} — ${entry.summary}`
  if (Array.isArray(entry.required) && entry.required.length > 0) line += ` Requires: ${entry.required.join(', ')}.`

  const optional = [
    entry.risk && entry.risk.length <= 100 ? ` Risk: ${entry.risk}` : null,
    entry.use ? ` Use: ${entry.use}` : null,
  ]
  for (const clause of optional) {
    if (clause !== null && line.length + clause.length <= BUDGET) line += clause
  }
  return line
}

/**
 * 由注册表条目拼工具描述。
 * @param {string} name - 工具名。
 * @param {object} entry - 注册表条目。
 * @param {string[]} actions - 声明的动作列表，按分派顺序。
 * @returns {string} 面向模型的描述。
 */
export function describeTool(name, entry, actions) {
  return [
    entry.purpose,
    `Actions: ${actions.join(', ')}.`,
    `Needs: ${entry.needs}`,
    `Next: ${entry.next}`,
    guideHint(name),
  ].join('\n')
}

/**
 * 造一个 family 工具。
 *
 * 定义从 `registry.mjs` 派生而不是在别处另写一份，并且在加载时**双向核对**：动作声明了却没
 * handler、handler 有了却没文档、文档里有却没声明，三种情况都直接抛错——否则它只会表现为
 * 一个「悄悄少写了说明」的 schema，没人会发现。
 *
 * @param {object} spec - family 定义。
 * @param {string} spec.name - 工具名，例如 `dsh_sessions`。
 * @param {string[]} spec.actions - 全部合法 `action` 值，按分派顺序。
 * @param {object} spec.extraProperties - 额外的 JSON Schema 属性。
 * @param {Record<string, (args: object, context: object) => Promise<object>>} spec.handlers - 每个动作一个实现。
 * @param {() => object} [spec.locate] - 每次调用解析一次宿主服务。
 * @returns {object} 可以交给 `ctx.tools.register` 的原始工具定义。
 */
export function defineFamilyTool(spec) {
  const actions = [...spec.actions]
  const entry = lookupTool(spec.name)

  const documented = Object.keys(entry.actions)
  for (const action of actions) {
    if (entry.actions[action] === undefined) {
      throw new Error(`dsh-controller: ${spec.name}.${action} 在 src/tools/registry.mjs 里没有文档`)
    }
    if (typeof spec.handlers[action] !== 'function') {
      throw new Error(`dsh-controller: ${spec.name}.${action} 声明了但没有 handler`)
    }
  }
  for (const action of documented) {
    if (!actions.includes(action)) {
      throw new Error(`dsh-controller: ${spec.name}.${action} 有文档但没有声明`)
    }
  }

  const actionsHelp = actions.map((action) => describeAction(action, entry.actions[action])).join('\n')

  return {
    name: spec.name,
    description: describeTool(spec.name, entry, actions),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: actions, description: actionsHelp },
        ...spec.extraProperties,
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, context) {
      // 分派只经过声明的列表，不经过 handler 表：兄弟工具的实现不该从这个工具里够得着。
      const handler = actions.includes(args?.action) ? spec.handlers[args.action] : undefined
      if (handler === undefined) {
        throw new ControllerError(
          `${spec.name}: unknown action ${JSON.stringify(args?.action)}; expected one of ${actions.join(', ')}`,
        )
      }
      const located = typeof spec.locate === 'function' ? spec.locate() : {}
      // The registry calls `definition.execute(args, exec)`, where `exec` carries the calling
      // agent (`exec.agent`), the cancellation signal and the call id. Everything from it is
      // passed through: `dsh_control {action:"session"}` needs the calling agent to answer
      // "self", and dropping the rest would make that answer a guess.
      const cwd =
        typeof context?.cwd === 'string' && context.cwd !== ''
          ? context.cwd
          : typeof context?.agent?.session?.header?.cwd === 'string'
            ? context.agent.session.header.cwd
            : process.cwd()
      const safeContext = { ...context, ...located, cwd }
      return handler(args ?? {}, safeContext)
    },
  }
}
