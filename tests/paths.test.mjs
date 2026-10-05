import { strict as assert } from 'node:assert'
import test from 'node:test'
import { decodeWorkspaceKey, encodeWorkspaceKey, dshHome, profileDir, profileName } from '../src/host/paths.mjs'

test('工作区键按实测规则编码', () => {
  // 这两个例子都是从这台机器的 ~/.dsh/sessions 下抄下来的真实目录名。
  assert.equal(encodeWorkspaceKey('C:\\Users\\Admin\\Documents\\GitHub\\xl-example'), '--C-Users-Admin-Documents-GitHub-xl-example--')
  assert.equal(encodeWorkspaceKey('C:\\Users\\Admin\\Documents\\GitHub\\dsh-plugins'), '--C-Users-Admin-Documents-GitHub-dsh-plugins--')
})

test('非 ASCII 按 UTF-16 码元写成 ~XXXX', () => {
  // 与这台机器上真实存在的目录名同形：
  //   --C-Users-Admin-Documents-deepseek-harness-默认工作区--  →  …-~9ED8~8BA4~5DE5~4F5C~533A--
  const key = encodeWorkspaceKey('C:\\默认工作区')
  assert.equal(key, '--C-~9ED8~8BA4~5DE5~4F5C~533A--')
  assert.equal(decodeWorkspaceKey(key), 'C\\默认工作区')
})

test('解码是有损的，只用于显示，这一点被明确写下来', () => {
  // 连字符既可能是路径分隔符也可能本来就在名字里（xl-example），所以逆变换不唯一。
  // 这不是缺陷而是事实：真正的 cwd 从投影缓存的 identity 里读，解码结果只是兜底提示。
  assert.equal(decodeWorkspaceKey('--C-Users-Admin-no-dashes-here--'), 'C\\Users\\Admin\\no\\dashes\\here')
  assert.equal(decodeWorkspaceKey(encodeWorkspaceKey('C:\\Users\\Admin')), 'C\\Users\\Admin')
  assert.equal(decodeWorkspaceKey('not-a-key'), null)
})

test('路径从环境推导，环境变量优先', () => {
  const saved = { home: process.env.DSH_HOME, profile: process.env.DSH_PROFILE, dir: process.env.DSH_PROFILE_DIR }
  try {
    process.env.DSH_HOME = 'D:\\dsh-home'
    process.env.DSH_PROFILE = 'other'
    delete process.env.DSH_PROFILE_DIR
    assert.equal(dshHome(), 'D:\\dsh-home')
    assert.equal(profileName(), 'other')
    assert.equal(profileDir(), 'D:\\dsh-home\\profiles\\other')
    process.env.DSH_PROFILE_DIR = 'E:\\explicit'
    assert.equal(profileDir(), 'E:\\explicit')
  } finally {
    if (saved.home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved.home
    if (saved.profile === undefined) delete process.env.DSH_PROFILE; else process.env.DSH_PROFILE = saved.profile
    if (saved.dir === undefined) delete process.env.DSH_PROFILE_DIR; else process.env.DSH_PROFILE_DIR = saved.dir
  }
})
