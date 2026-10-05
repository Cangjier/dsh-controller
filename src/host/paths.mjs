/**
 * DSH 在本机上的位置：家目录、profile、会话日志、投影缓存。
 *
 * 这些路径全部**从环境推导**，不写死：同一台机器上两个用户各有各的一份，`DSH_HOME`
 * 还能把整棵树搬到别处（`DSH_PROFILE` / `DSH_PROFILE_DIR` 同理）。这也是回退路径能成立
 * 的原因——不依赖任何宿主服务，只依赖磁盘布局。
 *
 * @module dsh-controller/host/paths
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** DSH 家目录。 */
export function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** 当前 profile 的名字。 */
export function profileName() {
  return process.env.DSH_PROFILE ?? 'desktop'
}

/** 当前 profile 的目录。 */
export function profileDir() {
  return process.env.DSH_PROFILE_DIR ?? join(dshHome(), 'profiles', profileName())
}

/** 会话日志根目录：`<home>/sessions/<工作区键>/<会话 id>/session.v4.jsonl.zstd`。 */
export function sessionsRoot() {
  return join(dshHome(), 'sessions')
}

/** 投影缓存目录：`<home>/storages/session_projcache/sessions/<会话 id>.json`。 */
export function projectionRoot() {
  return join(dshHome(), 'storages', 'session_projcache', 'sessions')
}

/** 插件私有 scratch 目录。 */
export function pluginTmp(pluginRoot) {
  return join(pluginRoot, 'tmp')
}

/**
 * 插件在 DSH 家目录下的状态目录：重启计划与看门狗日志放这里。
 *
 * 放在家目录而不是插件仓库里，因为重启恢复要跨进程读同一份文件，而插件仓库可能是个
 * 只读安装（装进 profile 的包）——`DSH_CONTROLLER_DIR` 可以把这份状态搬走。
 * @returns {string} 目录绝对路径。
 */
export function controllerStateDir() {
  return process.env.DSH_CONTROLLER_DIR ?? join(dshHome(), 'controller')
}

/**
 * 把一个工作区绝对路径编码成 DSH 的目录名。
 *
 * 规则是**实测**出来的，不是文档里的：`C:\Users\Admin\Documents\GitHub\xl-example`
 * 对应 `--C-Users-Admin-Documents-GitHub-xl-example--`，也就是先去冒号、再把反斜杠换成
 * 连字符、最后两边各补两个连字符；非 ASCII 字符写成 `~` + 四位大写 UTF-16 码元
 * （`…\deepseek-harness-黑认工作区` → `…-~9ED8~8BA4~5DE5~4F5C~533A`，实测目录名如此）。
 *
 * 只在按路径找目录时用得上；枚举会话一律直接扫 `sessions/` 下的真实目录名，不靠它反推。
 * @param {string} workspacePath - 工作区绝对路径。
 * @returns {string} 目录名。
 */
export function encodeWorkspaceKey(workspacePath) {
  const stripped = workspacePath.replace(/:/g, '').replace(/\\/g, '-').replace(/\//g, '-')
  const encoded = Array.from(stripped)
    .map((char) => (char.codePointAt(0) > 0x7f ? `~${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}` : char))
    .join('')
  return `--${encoded}--`
}

/**
 * 把 DSH 的目录名尽力还原成路径，**只用于显示**。
 *
 * 这个变换是有损的：连字符既可能是路径分隔符、也可能本来就在名字里（`xl-example`），
 * 所以逆变换不唯一，还原出来的路径不能拿去当真实的 cwd 用。真实的 cwd 从投影缓存的
 * `identity.cwd` 读；这个函数只是磁盘回退路径上的一个兜底提示。
 * @param {string} key - 目录名。
 * @returns {string|null} 还原出的路径；看起来不像工作区键时返回 null。
 */
export function decodeWorkspaceKey(key) {
  if (!key.startsWith('--') || !key.endsWith('--')) return null
  const body = key.slice(2, -2)
  return body.replace(/~([0-9A-Fa-f]{4})/g, (_match, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/-/g, '\\')
}
