/**
 * Start a new conversation in a named DSH workspace — finding every point it touches by reading the
 * screen, never by computing one coordinate from another.
 *
 * Nothing here is aimed at a hard-coded offset. The workspace row is found by its own label, the `+`
 * button by matching its picture, the composer by its placeholder text, and each of those three
 * brings its own box along. What is left is one kind of number only: what a reading must satisfy to
 * be accepted as one of those things. None of them ever moves the pointer.
 *
 * Two facts about this window had to be measured rather than assumed:
 *
 *   - the panel title `工作区` is NOT inside the list that scrolls — a wheel over it moves nothing,
 *     verified by capturing the list before and after — so the wheel has to be placed on a row;
 *   - the sidebar is the leftmost cluster of text in the window, and where that cluster ends is found
 *     by the widest jump between the left edges that are actually present (≈190 to ≈635 here). The
 *     first version of this script guessed "the left half of the window" instead, which swept in the
 *     conversation pane and spent twelve scrolls scrolling the wrong box.
 *
 * That matters because this machine answered the geometry question twice, differently: the DSH window
 * was at -7,-7 / 1188x571 on a 1173x596 desktop with a DPI-unaware helper, and later at 104,0 /
 * 1552x856 on a 1760x894 desktop with a per-monitor one, with a new process id and window handle.
 * A script holding a sidebar offset would have kept clicking into the wrong place without saying so.
 *
 * The `+` template is embedded because the button does not exist until the pointer rests on a row, so
 * there is no moment at which it could be learned from an unhovered screen.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const meta = {
  description:
    '在 DSH 侧边栏按文字找到指定工作区行，悬停后用图片模板认出 + 并点击，再按占位文字找到编辑框、输入、读回确认后回车；全程不使用硬编码坐标或偏移',
  args: {
    workspace: '必填：工作区行的名字，按整行匹配（例如 xl-example）',
    text: '必填：要输入并发送的内容',
    window: 'DSH 窗口标题片段，默认 DeepSeek Harness',
    anchor: '侧边栏用来认出面板自身的标题文字，默认 工作区',
    template: '可选：用外部图片当 + 按钮的模板（默认用内置那张，21x21，裁自本机实拍）',
    threshold: '模板匹配下限，默认 0.85；够不到就什么都不点',
    imageScale: '模板可能的缩放，默认 auto（这台机器的显示缩放变过）',
    step: '每次滚动的格数，默认 -1 朝列表末尾；这个方向走到底会自动反向再找一遍',
    maxSteps: '最多滚动几次，默认 12',
    send: 'false：输入并读回确认，但不按回车',
    dryRun: 'true：找到并悬停该行就停，不点 +（演练用）',
  },
}

/** The `+` button of a workspace row: 21x21, cut from a real capture on this machine. */
const PLUS_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABUAAAAVCAIAAAAmdTLBAAACSklEQVR4nKWUbU/TUBTHb9c2W1fcI2NjMu3WTcYrH0NQE1FH2BRfGDSAH8z4xg+gJs7oK6PRYGIiLBEGG2O6BybJmNAHfOo6hu01o0vX1hEW/b86997+cv7n3HuKsPw38E+CEAIATP8DAwCwrseCIGxuVjme53d3rYQ1EPAPHfeTJPn3l4jBvyg2lpbSq9kchmFer2fA018XRWaH43g+EqEvjY2SpFVNDgz89x8/nyafWyyWC+fPRMI0giAdR7+EV2/mGYa5fm2cDlFd+HpdTD57Ybfbb03FtaRWHxZS6ZXs7N3bTpdT2en0b2ExheF4Ih47DAYAXBwbDQz5X75+K0mSjm/uNT8XyuNXLuM4rgXuP3jIcby6hBBOxK42Go3SRkXHr63nbTbboM8LjpLZbI4On6pWazqeYdhQ8AToTW63c6v2VYnb9y9JksmEam2r8aMnSSWYm5l2HbQNxzAoy3pehhjW4edmptvw42QiHnM47AAABW7dlChaCULH97udLMtpHLraEQIcDruyVJ+NIIgEYdHVPzISLZUrzebeYTWrsCzLhWKJoigdb7cdO3f29P7+bwN2b/ZOx8uBltMZCEB0ONz21+P8KvnXcvn5d++nbk5SJ1uXBSHUzd8Ow1a3aiRB0HQQRVHDXKVXVpfTmfhkTIGN+RdTHzPZXDhElStfTCbUP+jzeNxul0uSpWJxo1AsAQBuJCa0MISww29vM319pDKemWxuPf+JZVsvF0VRn28gTAdDwaDadrWinurXDrxh8+j/V1dY1R8IMAOlmpcBqgAAAABJRU5ErkJggg=='

/** Compare text the way the plugin does: case and the spaces a recogniser inserts do not count. */
const key = (value) => String(value ?? '').toLowerCase().replace(/\s+/g, '')

/** The centre of a recognised line, from the box the reading carried. */
const centreOf = (line) => ({ x: Math.round(line.x + line.width / 2), y: Math.round(line.y + line.height / 2) })

export default async function ({ window: win, locate, mouse, keyboard, args, dir, log, sleep }) {
  const started = Date.now()
  const timeline = []
  const mark = (step, note = '') => {
    timeline.push({ ms: Date.now() - started, step, note })
    log(`${String(Date.now() - started).padStart(5)} ms  ${step}${note === '' ? '' : `  ${note}`}`)
  }

  const workspace = String(args.workspace ?? '').trim()
  if (workspace === '') throw new Error('需要 "workspace"：要在哪个工作区里新建对话。')
  const text = String(args.text ?? '')
  if (text === '') throw new Error('需要 "text"：要输入并发送的内容。')

  const title = typeof args.window === 'string' && args.window !== '' ? args.window : 'DeepSeek Harness'
  const anchorText = typeof args.anchor === 'string' && args.anchor !== '' ? args.anchor : '工作区'
  const threshold = Number.isFinite(Number(args.threshold)) ? Number(args.threshold) : 0.85
  const imageScale = args.imageScale === undefined || args.imageScale === null ? 'auto' : args.imageScale
  const step = Number.isFinite(Number(args.step)) ? Math.round(Number(args.step)) || -1 : -1
  const maxSteps = Number.isFinite(Number(args.maxSteps)) ? Math.round(Number(args.maxSteps)) : 12

  // The template has to exist as a file: the picture channel takes a path. Written every run so a
  // changed build cannot leave a stale button behind.
  const templatePath =
    typeof args.template === 'string' && args.template !== '' ? args.template : join(dir, 'dsh-new-conversation.plus.png')
  if (typeof args.template !== 'string' || args.template === '') {
    writeFileSync(templatePath, Buffer.from(PLUS_PNG_BASE64, 'base64'))
  }

  const located = await win.find({ title })
  if (located.window === null) throw new Error(`找不到标题含「${title}」的窗口。`)
  const frame = located.window
  const handle = frame.handle
  mark('窗口', `handle ${handle}  ${frame.width}x${frame.height} @ ${frame.x},${frame.y}`)

  /**
   * One reading of the window, split into the panel title and the sidebar's own column of rows.
   *
   * The title is the leftmost line equal to the anchor text — the conversation pane contains the same
   * words often enough that "leftmost" is doing real work here. The column is then the leftmost
   * cluster of left edges below it, cut at the widest jump those edges contain; both are measurements
   * of the reading in hand, and both only decide which recognised line counts as a row. Nothing is
   * positioned from them except by way of a box that was read.
   */
  const readSidebar = async () => {
    const shot = await locate.read({ handle })
    const lines = shot.lines ?? []
    const anchor =
      lines
        .filter((line) => key(line.text) === key(anchorText))
        .sort((a, b) => a.x - b.x)[0] ?? null
    if (anchor === null) return { anchor: null, column: [] }

    const below = lines.filter((line) => centreOf(line).y > centreOf(anchor).y)
    const edges = [...new Set(below.map((line) => Math.round(line.x)))].sort((a, b) => a - b)
    let boundary = edges.length > 0 ? edges[edges.length - 1] : anchor.x
    let widest = 0
    for (let i = 1; i < edges.length; i += 1) {
      if (edges[i] - edges[i - 1] > widest) {
        widest = edges[i] - edges[i - 1]
        boundary = edges[i - 1]
      }
    }
    return { anchor, column: below.filter((line) => line.x <= boundary) }
  }

  // Walk the list until the row shows up; if that direction runs out, walk back the other way.
  let row = null
  let direction = step
  let signature = null
  let flipped = false

  for (let attempt = 0; attempt <= maxSteps; attempt += 1) {
    const { anchor, column } = await readSidebar()
    if (anchor === null) {
      throw new Error(`读不到侧边栏标题「${anchorText}」：DSH 窗口不在前台，或者界面文字变了。`)
    }

    const hit = column.find((line) => key(line.text) === key(workspace))
    if (hit !== undefined) {
      row = hit
      break
    }
    if (attempt === maxSteps) break

    // The wheel goes on a row, never on the title: the title is outside the list that scrolls.
    const top = column.map((line) => ({ ...centreOf(line), line })).sort((a, b) => a.y - b.y)[0]
    if (top === undefined) {
      mark('列表是空的', `侧边栏列里一行都没有，step=${direction}`)
      break
    }

    const current = column.map((line) => key(line.text)).sort().join('|')
    if (signature !== null && current === signature) {
      if (flipped) {
        mark('到底', '两个方向都没有再移动')
        break
      }
      flipped = true
      direction = -direction
      signature = null
      mark('到头', `反向再找一遍：step=${direction}`)
      continue
    }
    signature = current

    await mouse.scroll({ notches: direction, at: { x: top.x, y: top.y } })
    mark(`滚动 ${direction}`, `在行「${String(top.line.text).trim()}」上 ${top.x},${top.y}`)
    await sleep(350)
  }

  if (row === null) {
    throw new Error(`侧边栏里找不到整行等于「${workspace}」的行：两个方向都走过了。`)
  }
  const rowCentre = centreOf(row)
  mark('找到该行', `「${String(row.text).trim()}」@ ${rowCentre.x},${rowCentre.y}`)

  // Hover it: the `+` button does not exist in the window until the pointer rests on the row.
  await mouse.move({ x: rowCentre.x, y: rowCentre.y })
  await sleep(500)

  const picture = await locate.image({ template: templatePath, handle, minScore: threshold, imageScale })
  const matches = picture.matches ?? []
  // Accept only a `+` sitting on this row: to the right of its label and within the row's own height
  // of it. The filter decides which measured box is the button; the click uses that box as read.
  const onTheRow = matches.filter((match) => match.x > rowCentre.x && Math.abs(match.y - rowCentre.y) <= row.height)
  mark('找 + 按钮', `全屏匹配 ${matches.length} 处，落在该行上的 ${onTheRow.length} 处`)
  if (onTheRow.length === 0) {
    throw new Error(
      `悬停「${workspace}」之后没有在该行上找到 + 按钮的图片（全屏匹配 ${matches.length} 处，下限 ${threshold}）。什么都不点。`,
    )
  }
  const plus = onTheRow.sort((a, b) => Math.abs(a.y - rowCentre.y) - Math.abs(b.y - rowCentre.y))[0]

  if (args.dryRun === true) {
    mark('dryRun', `不点 +（它现在在 ${plus.x},${plus.y}），到此为止`)
    return { dryRun: true, workspace, row: rowCentre, plus: { x: plus.x, y: plus.y }, score: plus.score, timeline }
  }

  await mouse.click({ x: plus.x, y: plus.y, handle })
  mark('点 +', `${plus.x},${plus.y}  score ${Number(plus.score).toFixed(3)}`)
  await sleep(700)

  // The new session must be visible before a character is typed. An existing session shows its
  // transcript where a new one shows a placeholder, and typing into the wrong one cannot be undone.
  const landing = await locate.find({ needle: ['描述你想要构建的内容', '调用指令', '文件或对话'] })
  if (!landing.found) {
    throw new Error('点了 + 之后没有出现新会话的编辑框（找不到它的占位文字）。一个字都没有输入。')
  }
  const box = landing.matches[0]
  const composer = {
    x: Math.max(0, box.left - box.height),
    y: Math.max(0, box.top - box.height),
    width: box.width + box.height * 2,
    height: box.height * 3,
  }
  mark('编辑框就位', `占位文字 @ ${box.x},${box.y}`)

  // Click the box that was just measured. Recognising the placeholder a second time in order to click
  // it would be a second chance for the same engine to miss the thing it read a moment ago — measured,
  // it did exactly that — and it buys nothing: the box is already in hand.
  const field = await mouse.click({ x: box.x, y: box.y, handle })
  mark('聚焦编辑框', `${field.x},${field.y}`)

  await keyboard.type({ text, handle })
  await sleep(300)
  const readBack = await locate.read({ region: composer })
  const seen = readBack.text ?? (readBack.lines ?? []).map((line) => line.text).join(' ')
  if (!key(seen).includes(key(text))) {
    throw new Error(`文字没有落进编辑框：读回来的是「${String(seen).trim()}」。没有按回车。`)
  }
  mark('输入并读回', String(seen).trim())

  if (args.send === false) {
    return { workspace, row: rowCentre, plus: { x: plus.x, y: plus.y }, typed: text, sent: false, timeline }
  }

  await keyboard.key({ chord: '{ENTER}', handle })
  await sleep(900)
  const after = await locate.read({ region: composer })
  const remains = key(after.text ?? (after.lines ?? []).map((line) => line.text).join(' ')).includes(key(text))
  mark('回车', remains ? '编辑框里还留着这段文字' : '编辑框已清空')
  return {
    workspace,
    row: rowCentre,
    plus: { x: plus.x, y: plus.y },
    typed: text,
    sent: !remains,
    timeline,
    elapsedMs: Date.now() - started,
  }
}
