/**
 * 回退读取：直接从磁盘读会话状态。
 *
 * 只在宿主服务缺失时用到（`sessionController` / `sessionQuery` 都没有的 profile），所以这里
 * 只实现读，不实现写：能写的路径必须是 DSH 自己的 API，绕过它去改日志会写出宿主看不懂的东西。
 *
 * 两个数据源，和 DSH 自己用的完全一样：
 *   - `session.v4.jsonl.zstd`：append-only 的事件流。每次 flush 追加一个**独立的 zstd 帧**，
 *     所以整个文件是一串帧拼接而成，解码要按 magic 切；末尾半写的帧直接丢掉，这正是
 *     「可以在别人正在写的时候读」的原因。
 *   - `session_projcache/sessions/<id>.json`：GUI 列表用的投影，数值带 `{ver, seq, val}` 包装。
 *
 * @module dsh-controller/host/sessionlog
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import zlib from 'node:zlib'
import { decodeWorkspaceKey, projectionRoot, sessionsRoot } from './paths.mjs'

const LOG_NAME = 'session.v4.jsonl.zstd'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** magic 出现的位置。 */
function magicOffsets(buffer) {
  const offsets = []
  let index = 0
  while ((index = buffer.indexOf(MAGIC, index)) !== -1) {
    offsets.push(index)
    index += 4
  }
  return offsets
}

/**
 * 解码一段缓冲区里的所有完整帧。
 *
 * 压出来的数据里可能**恰好**含有 magic 字节，所以某个切片解不开时不是报错，而是把下一段
 * 也吞进来重试；末尾那个半写的帧则直接放弃。
 * @param {Buffer} buffer - 原始字节。
 * @returns {string} 解码后的文本。
 */
export function decodeFrames(buffer) {
  const starts = magicOffsets(buffer)
  const parts = []
  if (starts.length <= 1) {
    try { parts.push(zlib.zstdDecompressSync(buffer)) } catch { /* 半写的唯一一帧 */ }
    return Buffer.concat(parts).toString('utf8')
  }
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]
    let chunk = buffer.subarray(start, index + 1 < starts.length ? starts[index + 1] : buffer.length)
    let decoded = null
    for (let attempt = 0; attempt < 64 && decoded === null; attempt += 1) {
      try { decoded = zlib.zstdDecompressSync(chunk) } catch {
        const end = starts[index + 2 + attempt]
        if (end === undefined) break
        chunk = buffer.subarray(start, end)
      }
    }
    if (decoded !== null) parts.push(decoded)
  }
  return Buffer.concat(parts).toString('utf8')
}

function readRange(file, from, length) {
  const handle = openSync(file, 'r')
  try {
    const buffer = Buffer.allocUnsafe(length)
    const read = readSync(handle, buffer, 0, length, from)
    return buffer.subarray(0, read)
  } finally { closeSync(handle) }
}

/** 解析 JSONL，坏行直接跳过（追加写入时最后一行可能只写了一半）。 */
export function parseEventLines(text) {
  const events = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try { events.push(JSON.parse(line)) } catch { /* 半行 */ }
  }
  return events
}

/** 会话日志的绝对路径。 */
export function logPathFor(workspaceKey, sessionId) {
  return join(sessionsRoot(), workspaceKey, sessionId, LOG_NAME)
}

/**
 * 枚举磁盘上所有会话日志。
 * @returns {{ sessionId: string, workspaceKey: string, workspace: string|null, file: string, bytes: number, mtimeMs: number }[]}
 */
export function listSessionLogs() {
  const root = sessionsRoot()
  if (!existsSync(root)) return []
  const found = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const workspaceDir = join(root, entry.name)
    for (const session of readdirSync(workspaceDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      for (const candidate of [join(workspaceDir, session.name, LOG_NAME), join(workspaceDir, session.name, session.name, LOG_NAME)]) {
        if (!existsSync(candidate)) continue
        const stats = statSync(candidate)
        found.push({
          sessionId: session.name,
          workspaceKey: entry.name,
          workspace: decodeWorkspaceKey(entry.name),
          file: candidate,
          bytes: stats.size,
          mtimeMs: stats.mtimeMs,
        })
        break
      }
    }
  }
  return found
}

/**
 * 读一条会话日志的事件；默认只读末尾一段，因为日志可以是几十 MB。
 * @param {string} file - 日志路径。
 * @param {object} [options] - `{ tailBytes }`。
 * @returns {{ events: object[], bytes: number, mtimeMs: number, truncated: boolean }}
 */
export function readLog(file, options = {}) {
  const stats = statSync(file)
  const window = Math.min(options.tailBytes ?? 512 * 1024, stats.size)
  const from = Math.max(0, stats.size - window)
  const events = parseEventLines(decodeFrames(readRange(file, from, stats.size - from)))
  return { events, bytes: stats.size, mtimeMs: stats.mtimeMs, truncated: from > 0 }
}

/**
 * 读投影缓存里的一行。
 * @param {string} sessionId - 会话 id。
 * @returns {{ file: string, mtimeMs: number, rows: Record<string, { ver: number, seq: number, val: unknown }>, identity: object|null }|null}
 */
export function readProjection(sessionId) {
  const candidates = [sessionId, sessionId.replace(/^session-/, ''), `session-${sessionId}`, `mail-${sessionId.replace(/^mail-/, '')}`]
  for (const candidate of candidates) {
    const file = join(projectionRoot(), `${candidate}.json`)
    if (!existsSync(file)) continue
    try {
      const document = JSON.parse(readFileSync(file, 'utf8'))
      return {
        file,
        mtimeMs: statSync(file).mtimeMs,
        rows: document.record?.rows ?? {},
        identity: document.record?.identity ?? null,
      }
    } catch { /* 写坏了就当没有 */ }
  }
  return null
}

/**
 * 把一个会话的磁盘事实折成一行状态。
 *
 * `turnBoundary` 判定和 GUI 一致：最后一次 `turn/start` 之后没有 `turn/end` 就是「回合未闭合」。
 * 活性只能从文件 mtime 推，因此一个刚崩掉的会话最多 5 分钟会被报成 RUNNING——这是**磁盘证据
 * 的极限**，不是可以修掉的 bug，所以状态名里写清楚它是推断出来的。
 * @param {object} log - `listSessionLogs()` 的一项。
 * @param {object} [options] - `{ now, staleMs }`。
 * @returns {object} 状态行。
 */
export function summarizeFromDisk(log, options = {}) {
  const now = options.now ?? Date.now()
  const projection = readProjection(log.sessionId)
  const boundary = projection?.rows?.turnBoundary?.val ?? null
  const stats = projection ? { mtimeMs: projection.mtimeMs } : null
  const { events, mtimeMs } = readLog(log.file)

  let openTurn = null
  let lastTurnEnd = null
  for (const event of events) {
    if (event.type === 'turn/start') openTurn = event.data?.turn ?? null
    else if (event.type === 'turn/end') { openTurn = null; lastTurnEnd = event.data ?? null }
  }

  const activityMs = Math.max(mtimeMs, stats?.mtimeMs ?? 0)
  const quietSec = Math.max(0, Math.round((now - activityMs) / 1000))
  const open = boundary !== null ? boundary.openTurnStartSeq !== null : openTurn !== null
  const staleMs = options.staleMs ?? 300_000

  let state = 'IDLE'
  if (open) state = quietSec * 1000 > staleMs ? 'STALLED' : 'RUNNING'
  else if (lastTurnEnd == null && boundary == null) state = 'UNKNOWN'

  return {
    sessionId: log.sessionId,
    workspaceKey: log.workspaceKey,
    workspace: projection?.identity?.cwd ?? log.workspace,
    title: projection?.rows?.title?.val ?? null,
    state,
    openTurn,
    lastTurn: projection?.rows?.turnBoundary?.val?.lastTurn ?? lastTurnEnd?.turn ?? null,
    lastTurnReason: lastTurnEnd?.reason?.kind ?? null,
    quietSec,
    bytes: log.bytes,
    source: 'disk',
    goal: goalFromProjection(projection),
  }
}

/** 投影缓存里的 goal 行折成一行状态；没有就返回 null。两个摘要函数共用同一份折法。 */
function goalFromProjection(projection) {
  const goal = projection?.rows?.goal?.val?.current?.goal ?? null
  if (goal === null) return null
  return {
    phase: goal.phase,
    roundsStarted: projection.rows.goal.val.current.roundsStarted,
    maxGoalRounds: goal.maxGoalRounds,
    objective: goal.objective,
  }
}

/**
 * 一行**只从投影缓存与文件 mtime**得出的状态——不读日志。
 *
 * `summarizeFromDisk()` 为了折出 `openTurn` / `lastTurnReason` 会把日志尾巴整段解开并解析
 * （默认 512KB，本机 478 条实测约 21ms/条）。但会话列表真正要的四个字段——`title` / `state` /
 * `quietSec` / `goal`——投影缓存与文件 mtime 已经全部给出：投影里的 `turnBoundary` 有值，
 * 「回合是否还开着」就有了和 GUI 同一份的权威答案，日志在这条路上一个字节都不需要读。
 *
 * 所以这里**只回答投影能证明的部分**。投影缺失、或里面还没有 `turnBoundary` 行时返回 `null`，
 * 让调用方明确地退回 `summarizeFromDisk()`，而不是拿一串 null 假装那就是状态。
 * `state` 的判法必须与 `summarizeFromDisk()` 逐字一致，否则两条路会给出不同的答案。
 * @param {object} log - `listSessionLogs()` 的一项。
 * @param {object} [options] - `{ now, staleMs }`。
 * @returns {object|null} 状态行；证据不足时是 `null`。
 */
export function summarizeFromProjection(log, options = {}) {
  const projection = readProjection(log.sessionId)
  const rows = projection?.rows ?? {}
  const boundary = rows.turnBoundary?.val ?? null
  if (projection === null || boundary === null) return null

  const now = options.now ?? Date.now()
  const staleMs = options.staleMs ?? 300_000
  // mtime 取「日志文件」与「投影文件」里更新的那个，和 summarizeFromDisk() 一致。
  const activityMs = Math.max(log.mtimeMs ?? 0, projection.mtimeMs ?? 0)
  const quietSec = Math.max(0, Math.round((now - activityMs) / 1000))
  const open = boundary.openTurnStartSeq !== null

  return {
    sessionId: log.sessionId,
    workspaceKey: log.workspaceKey,
    workspace: projection.identity?.cwd ?? log.workspace,
    title: rows.title?.val ?? null,
    state: open ? (quietSec * 1000 > staleMs ? 'STALLED' : 'RUNNING') : 'IDLE',
    quietSec,
    bytes: log.bytes,
    source: 'projection',
    goal: goalFromProjection(projection),
  }
}

/** 一个会话的日志目录名（用于展示）。 */
export function sessionDirName(file) {
  return basename(join(file, '..'))
}
