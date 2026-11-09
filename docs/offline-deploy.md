# dsh-controller 离线版

一份**不联网**就能安装、就能跑的 `dsh-controller`。

这个插件与同族的 `dsh-computer-use` / `dsh-ocr` 不一样：它**本来就没有可打包的二进制**。它不 import 任何
第三方包（只 import `node:` 内置模块），桌面回退用的是它自带的 PowerShell 脚本，宿主能力全部在运行期
用 `ctx.get(name)` 现取、取不到就退回磁盘或明确报错。所以「离线版」在这里要补的不是依赖，而是三件
别的东西：**一份可以直接安装的包**、**一份能逐字节核对交付内容的清单**、以及**一个能就地重打包的脚本**。

## 目录结构

```
dsh-controller-offline\
  dsh-controller\               → 插件包本体，直接可装（目录名不要改）
    index.mjs                   插件入口：config 归一化 + bundle 装载
    src\host\                   宿主适配、路径、会话日志、重启计划、优雅退出
    src\tools\                  五个工具的注册表与动作（registry.mjs 是 prose 的唯一来源）
    src\ui\                     桌面自动化回退（desktop.mjs + desktop.ps1）
    scripts\dsh-new-conversation.mjs
                                cwd 建会话那条腿用的脚本（config.create.scriptDir 默认就指这儿）
    tests\                      离线自证的用例（不碰真实宿主）
    selftest.mjs                不开 DSH 也能跑：磁盘回退 + 服务探测 + 找窗口（只观察）
    package.json cordis.patch.yml LICENSE README.md
  README-OFFLINE.md             本文档
  manifest.json                 交付的每个文件的大小与 SHA-256，以及 7z 的信息
  SHA256SUMS.txt                同样的哈希，sha256sum 格式（`sha256sum -c` 可直接用）
  verify-offline.mjs            零依赖核对脚本（见下）
  rebuild-offline.ps1           就地重新打包
  dsh-controller-offline.<日期>.7z   整个包的 7z 副本（有 7-Zip 时才有）
```

`dsh-controller\` 与包根是**分开的两件事**：前者是 `package.json` 的 `files` 所描述的那个包，安装的就是
它；后者只在交付时存在，用来解释和核对这次打包，不会被装进制。

## 安装

### 方式一：link（推荐，零拷贝）

在 profile 目录（默认 `%USERPROFILE%\.dsh\profiles\desktop`）的 `package.json` 里，把**插件目录**链成
依赖，并把包名加进 bundle 列表：

```jsonc
{
  "dependencies": {
    "dsh-controller": "link:C:/Users/Admin/Desktop/dsh-controller-offline/dsh-controller"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ……原有条目……
        "dsh-controller"
      ]
    }
  }
}
```

然后在 profile 目录跑一次 `pnpm install`（或直接重启 DSH）。`link:` 只是软链，改动立刻对文件系统可见。

### 方式二：dsh_plugins install

```
dsh_plugins { action: "install", spec: "C:\\Users\\Admin\\Desktop\\dsh-controller-offline\\dsh-controller", confirm: true }
```

这一条需要宿主里有 `pluginManager` 服务；没有就用方式一。

### 方式三：手工拷进 profile

把 `dsh-controller\` 整个目录拷成 `<profile>\node_modules\dsh-controller`，再把包名写进 `bundles`。等价，
只是以后升级要自己再拷一次。

三种方式都不需要网络。装完运行中的桌面应用会重载 profile 配置并把 `dsh_*` 工具注册进来——**不需要重启
应用**（实测：包名写进 `bundles` 后，同一轮对话的下一次请求就看到了那五个工具）。

## 核对

```powershell
cd C:\Users\Admin\Desktop\dsh-controller-offline
node verify-offline.mjs
```

它会做这些事，任何一条不过就以非零码退出：

- 按 `manifest.json` 逐个文件重新算 SHA-256，**同时比大小**——哈希只证明内容，大小顺便证明没被截断；
- 找出清单之外的文件（默认只报告，加 `--strict` 就让它失败）；
- 交叉核对 `SHA256SUMS.txt` 与 `manifest.json`，两份清单不可能各说各话；
- 检查插件包自己是否还自洽：`package.json` 能解析、包名与目录名及 bundle patch 一致、`files` 里列的
  每一项都存在、`.` 导出的入口文件真实存在；
- **扫一遍插件源码里的 import**，出现任何既不是 `./` 也不是 `node:` 的裸说明符就失败——那是「离线」
  这句话唯一可能被悄悄破坏的方式。

`--json` 给机器读，`--dir <包根>` 可以从包外核对。想用系统工具也行：

```powershell
sha256sum -c SHA256SUMS.txt        # Git for Windows / MSYS2 自带
```

（`manifest.json` 与 `*.7z` 不在清单里：前者不能包含自己的哈希，后者包含全部哈希，两者都在
`excluded` 字段里写明了。）

## 重新打包

```powershell
# 从插件仓库刷一份新的到桌面
powershell -File tools\build-offline.ps1

# 从包里就地重打（源码与目标相同，只刷新清单与归档）
powershell -File rebuild-offline.ps1

# 换目录、允许覆盖、跳过归档或测试
powershell -File rebuild-offline.ps1 -OutDir D:\pack -Force -NoArchive -SkipTests
```

打包脚本在封存清单**之前**会在包内跑：全部 `.mjs` 的 `node --check`，以及五个不碰真实宿主的测试文件
（`config` / `paths` / `tools` / `sessionlog` / `restart`）。清单写完之后它还会**再跑一次本包的
`verify-offline.mjs`**——一个写坏或写截断的文件会在打包这一步就让构建失败，而不是等到目标机器上。
`tests\facts.test.mjs` 会起替身进程并**真的收掉一棵进程树**，`tests\services.test.mjs` 会打到活的宿主
服务，两者都不适合放进打包步骤，所以不在这里跑。

## 装完之后：哪些能力依赖兄弟插件

插件本身在没有任何兄弟插件时**照样工作**：五个工具都在，磁盘回退、会话管理、插件管理、重启编排全部
可用。只有两条路会去借 `dsh-computer-use`，而且借不到时都退化成一条**写在结果里**的替代路径，不会
静默失败：

| 能力 | 有 `dsh-computer-use` | 没有它时 |
| --- | --- | --- |
| `dsh_sessions {action:"create"}` 带 `cwd` | 交给它的脚本库跑 `scripts/dsh-new-conversation.mjs`：按整行文字找到工作区行、悬停、用图片模板认出 `+`、点开、把第一条消息打进编辑框并读回确认——会话落在**指定工作区**，中文进得去（`method: "computer-script"`） | 退到点「新会话」按钮那条腿；那条腿不行再整条退 API。会话仍然建得成，只是不一定落在指定工作区，中文那条腿也走它自己的 SendKeys/API 路 |
| `dsh_host {action:"restart"}` 的优雅退出 | 右键托盘图标 → 点「退出」，让应用**自己**退（`capability: "script"`） | 进程外的看门狗到点收掉整棵进程树再拉起 exe。**重启照样发生**，只是不走优雅那一腿 |

第二条值得说清楚：优雅退出是**加分项，不是前提**。四条找路顺序（脚本 → 兄弟插件的核心 → 老一代能力
→ 强杀）里，最后一条永远在，所以「没有兄弟插件」不会让重启失败。这也是本包**不**捆绑
`dsh-computer-use` 的原因：为了一个可选路径再带一份约 340 MB 的包，比它买到的那点优雅更贵，而且那个
包有自己的离线版。

同理，`scripts\` 里除了 `dsh-new-conversation.mjs` 还带着一个 `dsh-new-conversation.plus.png`：那是脚本
用来在工作区行里认出 `+` 按钮的**图片模板**，它是运行时从实拍裁出来的派生物（所以在本仓库里不入库——
`.gitignore` 那条规则管的是「别把派生物提交进源码库」），但打包脚本按目录整体拷贝，它就跟着过来了。
这是好事：模板在包里的含义是**这个副本第一次跑就快**。包里没有它也能工作——脚本会先截图、逐点悬停找到
那个 `+`，再把它裁下来当模板（实测第一次约 52–96 秒），下一次才走匹配（分数 1.000）。所以换一台机器、
或者界面上那个按钮长得不一样时，删掉这个 png 让脚本重新学一份就是正确做法。

## 已知边界

- **`dsh_host {action:"restart"}` 只认桌面壳。** 跑在 headless 的 `dsh` CLI 里时它会明确拒绝（那时关了
  回不来），而不是赌一把。退出与重新拉起都由进程外的延时脚本完成（`<DSH home>\controller\`）。
- **`dsh_ui` 动的是真机器**：`click` / `type` / `key` / `scroll` 会抢焦点、覆盖剪贴板（中文走粘贴）。没确认
  前台就拒绝发输入，这是它唯一的一条硬规则。
- **重启与中止是破坏性的**：被中止的那一轮以 `aborted` 收口，未完成的工作不会重来；重启后的「继续」
  是一次新的模型调用，会真的花钱花时间，所以有 `restart.maxResume` 上限。
- **插件源码改动需要重启应用才生效**（HMR 默认只监听配置，不监听模块）。
- **`node --test` 会跑 `tests\facts.test.mjs`**，而它包含两条真机集成用例（替身进程 + 真的收树拉起）。
  离线核对只要 `node verify-offline.mjs`；要跑完整套件请在真机上、并且知道自己按了什么。

## 许可

MIT。插件本体见 `dsh-controller\LICENSE`。
