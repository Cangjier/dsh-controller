import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import zlib from 'node:zlib'
import { decodeFrames, listSessionLogs, parseEventLines, readLog, summarizeFromDisk, summarizeFromProjection } from '../src/host/sessionlog.mjs'

/** 造一段和会话日志同构的字节：若干**独立** zstd 帧直接拼接。 */
function buildLog(frames) {
  return Buffer.concat(frames.map((lines) => zlib.zstdCompressSync(Buffer.from(lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8'))))
}

test('按 magic 切帧解码拼接的 zstd 流', () => {
  const buffer = buildLog([
    [{ type: 'session', id: 'session-x', cwd: 'C:\\w' }],
    [{ type: 'turn/start', seq: 1, data: { turn: 1 } }],
    [{ type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } }],
  ])
  const events = parseEventLines(decodeFrames(buffer))
  assert.equal(events.length, 3)
  assert.equal(events[0].type, 'session')
  assert.equal(events[2].data.reason.kind, 'completed')
})

test('末尾半写的帧被丢掉，前面的照常读出', () => {
  const whole = buildLog([[{ type: 'turn/start', seq: 1, data: { turn: 1 } }]])
  const torn = Buffer.concat([whole, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01, 0x02])])
  const events = parseEventLines(decodeFrames(torn))
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'turn/start')
})

test('坏行跳过，不影响其它行', () => {
  const events = parseEventLines('{"a":1}\n{ not json\n{"b":2}\n')
  assert.deepEqual(events.map((event) => Object.keys(event)[0]), ['a', 'b'])
})

test('磁盘状态：回合未闭合 = RUNNING，闭合 = IDLE', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-controller-test-'))
  const savedHome = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = home
    const workspaceKey = '--C-w--'
    const sessionDir = join(home, 'sessions', workspaceKey, 'session-open')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'session.v4.jsonl.zstd'), buildLog([
      [{ type: 'session', id: 'session-open', cwd: 'C:\\w' }],
      [{ type: 'turn/start', seq: 1, data: { turn: 1 } }],
    ]))

    // 投影缓存里写一份 turnBoundary：磁盘状态的权威判据和 GUI 用的是同一份。
    const projectionDir = join(home, 'storages', 'session_projcache', 'sessions')
    mkdirSync(projectionDir, { recursive: true })
    writeFileSync(join(projectionDir, 'session-open.json'), JSON.stringify({
      version: 7,
      record: {
        identity: { formatVersion: 4, createdAt: 1, cwd: 'C:\\w' },
        rows: {
          turnBoundary: { ver: 2, seq: 2, val: { openTurnStartSeq: 1, lastTurn: 1 } },
          title: { ver: 1, seq: 2, val: '一个开着的会话' },
          goal: { ver: 6, seq: 2, val: { current: { goal: { id: 'g', phase: 'active', maxGoalRounds: 40, objective: '干完' }, roundsStarted: 2 } } },
        },
      },
    }))

    const logs = listSessionLogs()
    assert.equal(logs.length, 1)
    const summary = summarizeFromDisk(logs[0])
    assert.equal(summary.state, 'RUNNING')
    assert.equal(summary.title, '一个开着的会话')
    assert.equal(summary.goal.phase, 'active')
    assert.equal(summary.goal.roundsStarted, 2)

    // 冷日志（很久没写）应被判成 STALLED 而不是 RUNNING。
    const stalled = summarizeFromDisk(logs[0], { staleMs: -1 })
    assert.equal(stalled.state, 'STALLED')

    // 快路径：只靠投影缓存与 mtime，一个字节的日志都不读。会话列表用它，所以它必须和完整
    // 读法给出同样的答案，否则「快」只是把慢换成了错。
    const light = summarizeFromProjection(logs[0])
    assert.equal(light.state, summary.state)
    assert.equal(light.title, summary.title)
    assert.equal(light.workspace, summary.workspace)
    assert.equal(light.quietSec, summary.quietSec)
    assert.deepEqual(light.goal, summary.goal)
    assert.equal(summarizeFromProjection(logs[0], { staleMs: -1 }).state, 'STALLED')

    const tail = readLog(logs[0].file)
    assert.equal(tail.events.length, 2)
    assert.equal(tail.truncated, false)
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('投影不足以判定状态时 summarizeFromProjection 返回 null，而不是猜一个', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-controller-test-'))
  const savedHome = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = home
    const sessionDir = join(home, 'sessions', '--C-w--', 'session-bare')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'session.v4.jsonl.zstd'), buildLog([
      [{ type: 'session', id: 'session-bare', cwd: 'C:\\w' }],
      [{ type: 'turn/start', seq: 1, data: { turn: 1 } }],
    ]))

    const logs = listSessionLogs()
    assert.equal(summarizeFromProjection(logs[0]), null, '没有投影就没有权威判据，必须明说不知道')
    // 退回完整读法仍然给得出状态：快路径不是「唯一一条路」，是「先走的那条」。
    assert.equal(summarizeFromDisk(logs[0]).state, 'RUNNING')
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('没有 sessions 目录时枚举返回空表而不是抛错', () => {
  const savedHome = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = join(tmpdir(), 'dsh-controller-does-not-exist-12345')
    assert.deepEqual(listSessionLogs(), [])
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedHome
  }
})
