/**
 * `dsh_ui` —— 回退通道：只在「GUI 才有」的事情上动真格的输入。
 *
 * 它做的是**一步一个动作**，和 `dsh-computer-use` 的分工一样：插件只负责看和动，判断归模型。
 * 唯一的例外是它自己的一条硬规则——**没确认窗口在前台就绝不发输入**。合成输入失败是不会报错的，
 * 所以前台确认是这里唯一可信的证据。
 *
 * @module dsh-controller/tools/ui
 */
import { runDesktop, screenshotPath } from '../ui/desktop.mjs'
import { ControllerError, defineFamilyTool } from './shared.mjs'

export const UI_TOOL_NAME = 'dsh_ui'

/** 分派顺序。 */
export const UI_ACTIONS = ['window', 'look', 'click', 'type', 'key', 'scroll']

/**
 * 造 `dsh_ui` 的工具定义。
 * @param {object} config - 归一化后的插件配置。
 * @returns {object} 工具定义。
 */
export function createUiTool(config) {
  return defineFamilyTool({
    name: UI_TOOL_NAME,
    actions: UI_ACTIONS,
    extraProperties: {
      title: { type: 'string', description: 'Which DSH window to target: a case-insensitive substring of its title. Default: the window owned by config.ui.processName.' },
      focus: { type: 'boolean', description: 'window: bring it to the foreground before answering. Default false — observing does not touch the window.' },
      path: { type: 'string', description: 'look: where to write the PNG. Defaults to <plugin>/tmp/screens/dsh-window-<timestamp>.png.' },
      x: { type: 'number', description: 'click: x in window-relative pixels. scroll: optional pointer x before scrolling.' },
      y: { type: 'number', description: 'click: y in window-relative pixels. scroll: optional pointer y before scrolling.' },
      text: { type: 'string', description: 'type: the text to type. Non-ASCII text is pasted through the clipboard, which overwrites it.' },
      chord: { type: 'string', description: 'key: one SendKeys chord, for example "^n" for Ctrl+N or "{ENTER}".' },
      notches: { type: 'number', description: 'scroll: how many wheel notches; positive scrolls away from the user.' },
    },
    handlers: {
      async window(args, context) {
        return runDesktop('window', { ...args, cwd: context.cwd }, config)
      },

      async look(args, context) {
        const path = screenshotPath(config, args, context.cwd)
        const result = await runDesktop('look', args, config, { screenshotPath: path })
        if (result.ok === true) {
          return { ...result, note: 'Read this PNG back with the image-reading tool of your choice; this plugin does not recognise text.' }
        }
        return result
      },

      async click(args) {
        if (!Number.isFinite(args.x) || !Number.isFinite(args.y)) throw new ControllerError('dsh_ui {action:"click"} 需要 x 与 y（窗口相对坐标）')
        return runDesktop('click', args, config)
      },

      async type(args) {
        if (typeof args.text !== 'string' || args.text === '') throw new ControllerError('dsh_ui {action:"type"} 需要非空的 text')
        return runDesktop('type', args, config)
      },

      async key(args) {
        if (typeof args.chord !== 'string' || args.chord === '') throw new ControllerError('dsh_ui {action:"key"} 需要 chord')
        return runDesktop('key', args, config)
      },

      async scroll(args) {
        if (!Number.isFinite(args.notches)) throw new ControllerError('dsh_ui {action:"scroll"} 需要 notches')
        return runDesktop('scroll', args, config)
      },
    },
  })
}
