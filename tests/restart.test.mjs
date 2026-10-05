import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  PLAN_VERSION,
  RELAUNCH_SCRIPT,
  hostIdentity,
  planPath,
  readLogTail,
  readPlan,
  readPlanResult,
  sameBoot,
  spawnRelauncher,
  writePlan,
} from '../src/host/restart.mjs'

/**
 * 每个测试自己一个状态目录。
 *
 * 计划文件的路径来自 `DSH_CONTROLLER_DIR`，所以这些测试碰的是临时目录，不是这台机器真正的
 * `~/.dsh/controller`——一个会判断「要不要恢复你的会话」的模块，绝不能拿真目录来测。
 */
function withStateDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-controller-state-'))
  const previous = process.env.DSH_CONTROLLER_DIR
  process.env.DSH_CONTROLLER_DIR = dir
  try {
    return fn(dir)
  } finally {
    if (previous === undefined) delete process.env.DSH_CONTROLLER_DIR
    else process.env.DSH_CONTROLLER_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 同上，给异步用例用。 */
async function withStateDirAsync(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-controller-state-'))
  const previous = process.env.DSH_CONTROLLER_DIR
  process.env.DSH_CONTROLLER_DIR = dir
  try {
    return await fn(dir)
  } finally {
    if (previous === undefined) delete process.env.DSH_CONTROLLER_DIR
    else process.env.DSH_CONTROLLER_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  }
}

test('计划写进状态目录并能原样读回来', () => {
  withStateDir((dir) => {
    assert.equal(planPath(), join(dir, 'restart-plan.json'))
    const plan = { version: PLAN_VERSION, state: 'armed', sessions: [{ sessionId: 's1' }] }
    writePlan(plan)
    const onDisk = JSON.parse(readFileSync(planPath(), 'utf8'))
    assert.equal(onDisk.state, 'armed')
    assert.deepEqual(readPlan(), plan)
    assert.equal(readPlanResult().error, null)
  })
})

test('没有计划文件时返回 null 而不是抛错，并且说清楚是「没有」', () => {
  withStateDir(() => {
    const result = readPlanResult()
    assert.equal(result.plan, null)
    assert.equal(result.error, null)
    assert.match(result.path, /restart-plan\.json$/)
  })
})

test('版本不认识的计划被拒绝，而不是按当前版本猜字段', () => {
  withStateDir(() => {
    writeFileSync(planPath(), JSON.stringify({ version: PLAN_VERSION + 1, state: 'armed' }), 'utf8')
    const result = readPlanResult()
    assert.equal(result.plan, null)
    assert.match(result.error, /版本/)
  })
})

test('坏掉的计划文件变成一句可读的错误，而不是异常', () => {
  withStateDir(() => {
    writeFileSync(planPath(), '{ not json', 'utf8')
    const result = readPlanResult()
    assert.equal(result.plan, null)
    assert.match(result.error, /读不动/)
  })
})

test('同一个进程的两次身份相等，不同 pid 或不同启动时刻都不相等', () => {
  const first = hostIdentity()
  const second = hostIdentity()
  assert.ok(sameBoot(first, second))
  assert.ok(!sameBoot(first, { ...second, pid: second.pid + 1 }))
  assert.ok(!sameBoot(first, { ...second, bootEpochMs: second.bootEpochMs + 1 }))
  assert.ok(!sameBoot(first, undefined))
})

test('延时脚本必须是纯 ASCII 且没有 BOM：5.1 会按系统 ANSI 码页读 BOM-less 的 .ps1', () => {
  const bytes = readFileSync(RELAUNCH_SCRIPT)
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], '带 BOM 的脚本在 5.1 下会多出一个字符')
  const text = bytes.toString('utf8')
  const nonAscii = [...text].filter((char) => char.codePointAt(0) > 0x7f)
  // 实测过一次：一句 UTF-8 中文注释让 5.1 在三行之后报了一个多余的 '}'。这个守护很便宜。
  assert.equal(nonAscii.length, 0, `看门狗脚本里出现了非 ASCII 字符：${nonAscii.join('')}`)
  // 两个 pid 是这次修复的核心：脚本必须同时认这两个参数，并且保留旧名字以防旧版 Node 调它。
  for (const parameter of ['$ShellPid', '$KillAfterSeconds', 'Stop-Process', 'Start-Process']) {
    assert.ok(text.includes(parameter), `看门狗脚本里缺少 ${parameter}`)
  }
})

test('延时脚本优先走 WMI：新进程不在 DSH 的进程树里，并且拿到两个 pid 与宽限期', async () => {
  await withStateDirAsync(async () => {
    const spawned = []
    const watcher = await spawnRelauncher(
      { shellPid: 11368, hostPid: 909, exe: 'C:\\app\\DeepSeek Harness.exe', waitSeconds: 120, settleMs: 1500, killAfterSeconds: 12 },
      {
        shells: () => ['powershell.exe'],
        // WMI 那条路：假装返回了一个活着的 pid。
        exec: async (_shell, args) => {
          assert.equal(args.at(-2), '-Command')
          const script = args.at(-1)
          const base64 = script.match(/FromBase64String\('([^']+)'\)/)[1]
          const commandLine = Buffer.from(base64, 'base64').toString('utf8')
          assert.match(commandLine, /relaunch-watch\.ps1/)
          // 脚本要拿到壳 pid（只用于日志）和优雅退出的宽限期；它等的是整棵树，不是某一个 pid。
          assert.match(commandLine, /-ShellPid 11368/)
          assert.match(commandLine, /-KillAfterSeconds 12/)
          assert.match(commandLine, /-WaitSeconds 120/)
          // exe 路径里有空格，必须被引起来——否则 WMI 收到的是两个参数。
          assert.match(commandLine, /-Exe "C:\\app\\DeepSeek Harness\.exe"/)
          return { stdout: Buffer.from(JSON.stringify({ ok: true, returnValue: 0, pid: 777, alive: true }), 'utf8'), stderr: Buffer.alloc(0) }
        },
        spawn: (...args) => { spawned.push(args); return { pid: 999, unref() {} } },
      },
    )

    assert.equal(watcher.method, 'wmi')
    assert.equal(watcher.pid, 777)
    assert.deepEqual(spawned, [], 'WMI 成功了就不该再起一个 detached 的')
    assert.equal(watcher.attempts[0].ok, true)
  })
})

test('WMI 起不来时退回 detached spawn，两条都失败才抛错', async () => {
  await withStateDirAsync(async () => {
    const fallback = await spawnRelauncher(
      { shellPid: 1, exe: 'C:\\app\\a.exe', waitSeconds: 5, settleMs: 1 },
      {
        shells: () => ['powershell.exe'],
        exec: async () => ({ stdout: Buffer.from(JSON.stringify({ ok: false, error: 'CimCmdlets 不在' }), 'utf8'), stderr: Buffer.alloc(0) }),
        spawn: (_shell, args) => { assert.ok(args.includes('-File')); return { pid: 4242, unref() {} } },
      },
    )
    assert.equal(fallback.method, 'detached')
    assert.equal(fallback.pid, 4242)
    assert.deepEqual(fallback.attempts.map((entry) => entry.ok), [false, true])

    await assert.rejects(
      () => spawnRelauncher({ shellPid: 1, exe: 'C:\\app\\a.exe' }, {
        shells: () => ['powershell.exe'],
        exec: async () => ({ stdout: Buffer.from(JSON.stringify({ ok: false, error: 'nope' }), 'utf8'), stderr: Buffer.alloc(0) }),
        spawn: () => { throw new Error('spawn 也不行') },
      }),
      /延时脚本起不来/,
    )
  })
})

test('看门狗日志尾部：不存在时说没有，存在时只给最后几行', () => {
  withStateDir((dir) => {
    const path = join(dir, 'restart-watch.log')
    assert.equal(readLogTail(path, 3).exists, false)
    writeFileSync(path, ['one', 'two', 'three', 'four', ''].join('\n'), 'utf8')
    const tail = readLogTail(path, 2)
    assert.equal(tail.exists, true)
    assert.deepEqual(tail.lines, ['three', 'four'])
  })
})
