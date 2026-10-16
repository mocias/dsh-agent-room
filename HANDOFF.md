# HANDOFF

交接文档：给下一个接手 `dsh-agent-room` 的人（或 agent）。本文只写**当前状态、边界和坑**，
不重复 README 与 commit message 已经写清楚的内容。

- 仓库用途与安装：见 [README.md](README.md)
- 本次改造的完整说明：见 commit `d6b3220` "Replace the generic acp backend with per-harness agents"
- 更早的两个 commit：`e701260`（MIT 许可）、`c90f0a5`（初版）

---

## 1. 当前状态

| 项 | 值 |
| --- | --- |
| 分支 | `master`，与 `origin/master` 同步 |
| 仓库可见性 | private |
| 纳入版本控制的文件 | 18 个（`lib/`、`public/`、README、LICENSE、配置） |
| 离线测试 | 25/25 通过（约 25 秒） |
| 变异测试 | 45/45 全杀，0 跳过 |

已注册的 harness（也就是「添加成员」下拉框里的选项）：

| backend | protocol | 启动方式 |
| --- | --- | --- |
| `codex` | `codex-app-server` | 本机 codex 可执行文件 |
| `dsh` | `acp` | DSH 自带的 `--profile acp`（自己就在 DSH 里，或本机找到已安装的桌面端） |
| `qoder` | `acp` | `qoder --acp` |

---

## 2. 核心设计：协议 ≠ 产品

这是整个改造的立足点，改任何 harness 相关代码前必须先理解：

> `acp` 说明**怎么**跟一个 agent 对话，不说明**它是哪个** agent。

改造前「添加成员」只有一个 `acp` 选项，把协议和产品混为一谈：所有支持 ACP 的产品塌缩成
同一个选项，而某个具体产品的启动行只能手写。

现在每个产品一个 backend id，各自一条注册表条目。**代码里只有两种协议实现**：

- `codex-app-server` → `lib/codex-pool.cjs`
- `acp` → `lib/acp-backend.cjs`

**加一个 harness = 加一条描述，不是加一条代码路径。** 注册表在 `lib/harnesses.cjs` 的
`HARNESSES` 数组里。

### 后端抽象

`lib/room.cjs` 每个 backend 名一个 pool（`this.pools: Map`）。每个 pool 必须提供同一套方法面：
`start`/`stop`/`pid`、`modelCapabilities`、`openThread`/`getThread`/`closeThread`、`runTurn`、
`interrupt`，可选 `steer`。

### 分层规则（只写在 `mergeLaunch` 一处）

**逐 key 覆盖：配置赢。唯一例外是 `env`，它合并。** 原因：某个 harness 可能需要
`ELECTRON_RUN_AS_NODE` 才能算一个能跑的 node，用户配置里多加一个变量不能把它挤掉。

`launchOptions(id, configured)` 返回**未经合并的默认层**；未知 harness 返回 `{}`，
让 pool 自己的「no ACP agent configured」错误浮上来。

### `enabled === null` 的语义

`lib/harnesses.cjs` 的 `HarnessStore`：

- `null` = **自动**：探测到什么就提供什么，`codex` 永远兜底。
- 存了数组 = **用户决定**，逐字遵从。显式 `[]` 是合法选择，必须存活。

注意：codex 兜底**只属于自动模式**。存了列表就不要再塞 codex 进去，否则等于无视用户。

---

## 3. 可运行入口

```powershell
# 离线全套（安全，不花额度）
node test/run-all.cjs

# ⚠️ 绝不要跑 --online：会起真实 codex，消耗机主的 ChatGPT 额度
# node test/run-all.cjs --online

# 单个测试
node test/harnesses.cjs
```

变异测试（`_research/mutate-harnesses.cjs`，不发布）：

```powershell
node _research/mutate-harnesses.cjs
```

**变异测试是新断言的验收标准。** 每加一条断言，都要问「把它测的代码改坏，这条断言会红吗」。
本轮就是靠它抓出了一个真实 bug（见 §5）。

---

## 4. 环境与路径

用**打包的 node**，它有 `zlib.zstdDecompressSync`，系统 node 没有：

```
<DSH_RUNTIME>/dependencies/node/bin/node.exe    # v24.21.0（用它）
C:\Program Files\nodejs\node.exe                # v24.13.0
```

本文档不写本机绝对路径。实际位置：

- `DSH_RUNTIME`：DSH 的 runtime 目录
- `DSH_HOME`：默认 `%USERPROFILE%\.dsh`
- `PROFILE_DIR`：本机是 `$DSH_HOME\profiles\desktop`。
  **注意**：它等于 `DSH_PROFILE_DIR` 的值，但**不等于** host 里能读到的环境变量——
  该变量只注入给子进程，host 自己没有。插件通过 Cordis 的 `profileContext` 拿它，见 §7。

profile 层的现状（**不在仓库里**，属于机主个人配置）：

- `cordis.patch.yml` 里 `workspaceDirs` 有 `codex` 与 `dsh` 两项。
  原先手写的 `backends.acp` 整块已删除，因为 `launchDsh` 会推导出逐字节相同的一行。
- `dsh-peer-account-route.yml`：账号路由补丁。**个人文件，刻意不进仓库**，
  `peerAccountPatch()` 只在 profile 目录里发现它。见 §7。

---

## 5. 已经踩过的坑（照做，别重蹈）

### 5.1 绝不要用 PowerShell 文本 cmdlet 改源码

本机 PowerShell 是 5.1 Desktop，`[System.Text.Encoding]::Default` 是 **gb2312**。
`Get-Content -Raw` + `Set-Content` 会把 UTF-8 当 GBK 读，每个多字节字符塌缩成 `?`
**并吃掉后面一个字节**。

这真实发生过：`lib/harnesses.cjs` 被毁掉 35 处、22292 → 22257 字节，还吃掉一个换行。
当时该文件未被 git 跟踪，没有干净副本。

- 改文件只用 `read`/`write`/`edit` 工具，或 Node 的 `fs.readFileSync`/`writeFileSync`（显式 `'utf8'`）。
- `test/encoding.cjs` 就是为此存在的守卫：对 `lib/`、`public/`、`test/` 做严格 UTF-8 解码。
- `_research/mutate-harnesses.cjs` 全程走 Node 读写字，并有 `finally` 还原 + 逐字节校验。

### 5.2 Windows 上 spawn 一个 npm 安装的 harness

已实测（结论是决定性的）：

- `spawn('npx')` / `spawn('qoder')` → **ENOENT**。Node v24 **不做 PATHEXT 查找**。
- `spawn('<绝对路径>.cmd')` → **同步抛 EINVAL**（Node 20+）。
- `shell: true` 能跑，但报 `DEP0190` 弃用警告，且会弄坏带空格/元字符的参数。
- `cmd.exe /d /s /c <shim.cmd> <args>`：带空格的 shim 路径会失败，`&`/`|`/`"` 也会失败。

**干净路线：`node <pkg>/bin/<entry>.js <args>`，走 pipes。**

所以 `lib/harnesses.cjs` 里的处理是：

- 解析 `.cmd` shim，取出它真正要跑的 `.js` 入口。
- **Windows 上跳过无扩展名的 PATH 命中**——npm 会在每个 `.cmd` 旁边放一个 POSIX shell 脚本
  （`codex`，无扩展名），那个文件在 Windows 上不可执行。返回它只会得到一个必定失败的启动器，
  比报「未找到」更糟。
- 拒绝 `.ps1`。

### 5.3 `canonicalBackend` 的原型链泄漏

`LEGACY_BACKENDS` 若是普通对象字面量，`LEGACY_BACKENDS['constructor']` 会返回 `Object`
**构造函数**，`['__proto__']` 返回一个对象。一个叫 `constructor` 的 backend 名会变成 pool key，
然后在离病因很远的地方炸掉。

现在：`Object.create(null)` 建表 + `typeof mapped === 'string'` 双重守卫。变异测试里
「两个防线同时拆掉」是必杀项——只拆一个测不出来，因为两重防御彼此冗余。

### 5.4 其它

- `which()` 返回**单个路径或 `null`**，不是数组。
- `launchableFrom()` 返回 `{binary, argv, env, via}`，不是 `{command, args}`。
- `git grep --cached`：正确写法是 `git grep --cached -n -I -E <pat>`（`--cached` 在子命令后）。
  退出码 1 = 无匹配。
- 本机跑 `.ps1` 文件被执行策略挡住（未签名），把逻辑写在 `pwsh -Command` 里跑。
- `pwsh` 里的相对路径按会话工作目录解析，**不是** `cd` 之后的目录；用绝对路径。
- PowerShell heredoc 写 commit message 会坏，改成写 `%TEMP%` 文件再 `git commit -F`。
- `gh api ... --jq` 会被 PowerShell 弄坏 jq，去掉 `--jq` 再 `ConvertFrom-Json`。
- `git push` 曾因代理失败（WinINET 代理 `gh` 认、`git` 不认）。若复现：
  `git config --local http.proxy <proxy>`。

### 5.5 输入框的文本要立刻消失，不能等 agent 回话

**症状**：打完字点发送，文本在输入框里挂着不走，等某个 agent 发言之后才消失。

**根因**是 `POST /say` 的**响应时机**，不是渲染问题：

```
send() -> await post('/say') -> server.cjs:768 -> room.say()
       -> L1622 await this._serveNow(mentions)   <-- 这里
       -> _preempt -> _deliver -> _runSegment    <-- 整整一个模型回合
```

`say()` 在**消息落库之后**并不返回，而是等被唤醒的成员把这一回合跑完。所以「等
`await post()` 再清空输入框」= 把输入框绑在房间里最慢的那件事上。本机实测 32 秒
（`room-mv91bu9a-1idg.log.jsonl`：`16:11:05.418` 发出 → `16:11:37.793` 第一个 agent 回复）。

有一个**不对称**容易把人带偏：不带 `@` 的消息（且不是房间第一条）走
`delivered = []` 立即返回，agent 下一个 tick 才被服务——所以随手发一句反而"正常"；
一带 `@`，`_serveNow` 就会阻塞，文本就挂住。

**修法**：客户端**乐观清空**——`clearComposer()` 放在 `await` 之前，失败时用
`setComposerText(raw)` 还回去。`delivered` 这个字段 UI 根本没消费（消息靠 SSE 回来），
所以不需要动服务端契约（`say()` 返回 `delivered` 被 `prewarm` / `backend-death` /
`thread-reuse` / `member-api` 断言，动它会连累一片）。

三个**容易漏掉的边界**，都补了断言与变异项：

1. 还回去的必须是**原文**，不是 `trim()` 过的（发送用 trimmed，原文只有这里还留着）。
2. 失败时**不能覆盖**用户在等待期间新打的草稿——否则就是同一个 bug 的反面。
3. 失败时附件**保持暂存**（原有的合同，别打破）。

**顺带修掉一个一直存在的死代码**：发送按钮的启用状态原本写在 `renderTray()` 的**末尾**，
而它前面有 `if (empty) return`——于是"托盘为空"（最常见的情况）时那行永远不执行，
按钮一直是可点的死控件。现在抽成 `syncSend()`，在 `if (empty)` **之前**调用。

**所有赋值 `.value` 的地方都必须手动 `syncSend()`**，因为赋值不触发 `input` 事件。
一共 5 处，全部已接线（少任何一处，按钮就会停在错误的状态上）：

| 位置 | 场景 |
| --- | --- |
| `inputEl.oninput` | 用户打字 —— 发送后"重新武装"按钮的唯一途径 |
| 成员 chip 的 `onclick` | 点 chip 插入 `@id` |
| 添加成员成功后 | 新成员自动插入 `@id`（L743，容易漏） |
| `switchRoom` | 切房间清空输入框（L558，容易漏） |
| `mount` 初始化 | 标记里按钮默认是可点的，而空输入框没什么可发 |

> 后两处是**变异测试逼出来的**：第一次只上前三处，两个变异体活了下来——chip 点击留下的
> `@codex` 让按钮一直是"已武装"，把"添加成员"那条断言的因果遮住了。断言之前必须先把
> 状态**清干净**（`el('input').value = ''` + `oninput()`），否则它测的是上一步的残留。

> **为什么原来的测试全绿却漏掉了它**：`test/ui-attachments.cjs` 的 `/say` stub 是**同步
> resolve** 的，`await` 一次都不让出，清空看起来是瞬时的。回归测试必须用一个**测试自
> 己控制的 deferred**（`gateSend()`）把请求挂住，然后在"回合仍在进行"的时刻断言输入框
> 已经空了。任何"改了时序才暴露"的 bug，都要先问一句：我的 stub 会不会把它抹平？

**前端文件是在启动时一次读进内存的，改完必须重启 DSH**：`lib/index.js` 的 `STATIC` 在
`apply()` 里就把 `public/room-ui.js` `readFileSync` 进 `staticFiles`（L234），
`/app.js` 只是把内存里那份 `sendText` 出去（`server.cjs:716-721`），**没有 Cache-Control**。
所以刷页面没用，要重启宿主。

---

## 6. 未完成 / 可继续的

### 6.1 待你确认：设置行需要重启 DSH 才可见

`设置 → 通用 → Agent 群聊可用后端` 这一行**已写进代码并已提交**，但宿主模块代码在 DSH
**启动时**载入，所以当前运行中的服务仍对 `/agent-room/harnesses` 返回 404。

**重启 DSH 后才会出现。** 这是重启边界，不是故障。

接口层已在**进程内**跑通（真实路由 handler + 真实 socket）：自动模式、手动选择、强制开启标记、
持久化、`?refresh=1`。但**没有在真实 GUI 里目视确认那一行的渲染**——重启后请过一眼。

### 6.2 有意没做的 harness

用户明确决定**先不做**（原话：「先不做这三个，后面再慢慢补充」）：

- `claude`（`@agentclientprotocol/claude-agent-acp`）
- `gemini`（`gemini --acp`）
- `codebuddy`

加它们只是在 `HARNESSES` 里加一条描述，约 10 行。三个 ACP 启动形态：

- `--acp` 旗标：gemini、qoder、cline、copilot、codebuddy
- `acp` 子命令：bob、devin、goose、kilo、kimi、opencode、cursor 等
- 无参专用二进制：claude-agent-acp、codex-acp、amp-acp 等

ACP harness 权威注册表：<https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json>（42 个 agent）。

注意：`@zed-industries/claude-code-acp` 已**弃用**，现行是 `@agentclientprotocol/claude-agent-acp`。

### 6.3 WorkBuddy：实证否定

`@workbuddy/cli-vnext` 里 "acp" 出现 **0 次**。接不了，且按用户决定**完全没有出现在代码里**，
也没有用 codebuddy 顶替。

### 6.4 codex 的原生协议不是 ACP

codex 走自己的 `app-server` JSON-RPC。不要试图把它挪到 ACP 实现上。

### 6.5 ACP 成员仍是纯文本（有意为之）

`lib/acp-backend.cjs` 刻意忽略 `options.attachments`；图片路径是塞进 prompt 文本里的。
codex 拿到的是真实的 `{type:'localImage', path}` 条目。**这个不对称是设计，不要「修」它。**

---

## 7. 个人配置：不进仓库

上轮清理已把个人/开发残留移出仓库（用户已批准）：

- `FEASIBILITY.md`、`REQUIREMENTS.md` → `_research/design-docs/`（不发布）
- `dsh-peer-account-route.yml` → **从仓库删除**。profile 层有一份逐字节相同的副本，
  且只有 profile 那份真正生效。

**为什么这个账号路由补丁是必需的**：`dsh --profile acp` 默认走
`provider: deepseek-official`（API key 路线），而桌面端登录的是 `deepseek-account` 路线。
没有这个 overlay，ACP peer 每一轮都会失败：

```
llm-deepseek: no API key for provider route "deepseek-official"
```

补丁**怎么被找到**：`lib/harnesses.cjs` 的 `launchDsh` 推导 launch line 时，若在
profile 目录里发现 `dsh-peer-account-route.yml`，就追加 `--patch <该文件>`。

### profile 目录从哪来（曾经在这里出过大事故）

**`DSH_PROFILE_DIR` 只注入给子进程，从不写进 host 自己的 `process.env`。**
`@deepseek-ai/dsh-shell-env` 的 `collect()` 把 `DSH_PROFILE_DIR`
（以及 `DSH_SESSION_ID`、`DSH_PROFILE`）塞进**模型可见的 shell 工具**和 DSH 派生的子进程。
于是这个变量在 DSH 终端里存在、在从终端跑的测试里也存在，**唯独在 host 里不存在**。

早期版本正是用 `process.env.DSH_PROFILE_DIR` 找 profile 目录。后果：

- 从 shell 里做的「推导行 == 手写行」逐字节比对**通过**了——因为 shell 里有这个变量；
- 真实 host 里拿不到，`--patch` 被静默丢掉，ACP peer 起得来但每轮都 `-32603`；
- 同一个变量还决定名册目录，于是名册掉进 `process.cwd()` 下的回退目录，
  cwd 一变名册就像「消失了」。

现在按优先级取：

1. **Cordis `ctx.get('profileContext').dir`** —— `profile-boot` 在
   **加载插件之前**就 `provide` 了它，所以 `apply` 时一定可取到。这是正解。
2. `process.env.DSH_PROFILE_DIR`（普通 `node` 运行、嵌入方的后路）。
3. **扫自己的命令行**，兼容两种形态：
   - `--profile <name>` → `$DSH_HOME/profiles/<name>`（ACP 子进程自己的形态）；
   - 一个**位置参数**且恰好是 `$DSH_HOME/profiles/` 下的目录
     （**桌面端 host 的真实形态**：`... dsh-host/lib/index.js <asar> <profileDir> <runtime>`）。
     位置参数必须做「正好在 `profiles/` 下一层」的精确包含判断，
     否则任何路径参数都会被误认成 profile。

> **验证这条链路时，必须把 `DSH_PROFILE_DIR` 显式 unset，或在真实 Electron host 里跑。**
> 在有这个变量的 shell 里验证等于什么都没验证——这正是当初漏掉它的原因。
> 回归测试见 `test/harnesses.cjs`（profile 段）、`test/host-entry.cjs`（host 形态 + 旧名册收养）、
> `test/acp-room.cjs`（端到端 launch line）与 `test/room-registry.cjs`（RoomApi 透传）；
> 变异项见 `_research/mutate-profile-dir.cjs`（45 个变异全部被杀，0 跳过）。

### 「本机有没有 DSH」不能靠猜（这里出过第二次事故）

`detectDsh()` 现在有**四个分支**，缺任何一个都会以「静默失败」的方式暴露：

| # | 条件 | 说明 |
| --- | --- | --- |
| 1 | **自己就在 DSH 里** | `isDshDesktopHost()`：Electron **且** 自己的 `app.asar` 里真有 DSH host |
| 2 | **本机装着 DSH 桌面端** | `discoverDshInstall()`：注册表 → PATH 同级目录 → 常见安装路径 |
| 3 | **PATH 上有 `dsh`** | 只对 CLI 安装有效 |
| 4 | 都没有 | 明确说「未检测到」，而不是含糊的 false |

**分支 1 曾经写成「是 Electron 且有 `resourcesPath` 就算 DSH」。** 这个条件在
**本插件自己的独立桌面版**（`Agent Room.exe`，同样是 Electron）里也成立，于是：

- 它宣称「当前进程即 DSH」；
- `launchDsh` 拿**自己的** `process.execPath` 和**自己的** `resources/app.asar` 拼 launch line；
- 那个 asar 里没有 `dsh/.../cli.js`，**参数指向一个不存在的文件**；
- 成员起不来，而错误信息完全指不到原因。

**判据必须是 asar 的内容，不是「这是个 Electron」。** `asarHasDshHost(asarPath)`
走 `dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js` 这条路径，并且**按
asar 在当前进程里的形态选探针**：

- **文件**（普通 `node`：测试套件、你自己跑的脚本）→ 读 Electron 头部：前 16 字节是
  preamble，其中 **offset 12 的 u32 = 紧随其后的 JSON 目录长度**，读出目录并逐层走
  `files`。此时 `existsSync('<asar>/dsh/...')` **必然为假**——对操作系统来说 asar 就是个文件。
- **已挂载的目录**（Electron 里）→ `statSync` 报 `isDirectory: true, size: 0`，内层路径
  `existsSync` 为真，而**读它自己的字节会 ENOENT**。

两种形态**互补**，所以由 `statSync` 的结果决定用哪个探针，而**不是**看
`process.versions.electron`：前者描述「这个 asar 现在是什么」，后者只描述运行时，
测试里 stub 运行时时会选错探针。

> **实测（真实独立应用 `D:\agents-group\dsh-agent-room\dist\win-unpacked\Agent Room.exe`，
> `ELECTRON_RUN_AS_NODE=1`，加载的正是本仓库的 `lib/harnesses.cjs`）：**
>
> | 代码 | `own asar is DSH` | dsh 行 | 是否自我指向 |
> | --- | --- | --- | --- |
> | 修复前（HEAD `7db8d57`） | false | `found:true`「当前进程即 DSH」 | **是** ← 事故 |
> | 独立应用自己那份 `lib/` | false | `found:false`（看不见真装的 DSH） | 否 ← 反向事故 |
> | 本仓库修复后 | false | `found:true` → `D:\DeepSeek Harness` | 否 |
>
> 复现脚本：`_research/standalone-probe.cjs`（用 `AR_HARNESSES` 指向不同版本，可三方对比）。
> 这个对比也说明**「收紧」和「发现」必须一起做**：只收紧会从「误报」变成「漏报」。

#### 分支 2：怎么找到一个「不是自己」的 DSH

关键是**注册表**，因为安装器**不写 `dsh` 命令**，所以 PATH 永远看不见桌面端：

```
HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\<guid>
    DisplayName      REG_SZ    DeepSeek Harness 0.2.0-rc.2
    InstallLocation  REG_SZ    D:\DeepSeek Harness
    DisplayIcon      REG_SZ    D:\DeepSeek Harness\DeepSeek Harness.exe,0
```

- 用 **`reg query <hive> /s /f "DeepSeek Harness" /d`**（带 `/f` 过滤：**20ms / 526 字符**，
  不加过滤是 **87ms / 16604 字符**）。三个 hive：HKCU、HKLM、HKLM WOW6432Node。
- **`/f` 匹配的是「值」，不是「键名」**，所以 `DisplayName` 必须**在块内**再校验一次，
  否则一个「注释里提到 DeepSeek Harness」的无关程序会被当成安装目录去探测。
- `InstallLocation` 优先，没有就用 `DisplayIcon` 的 `dirname`。
- **`DisplayIcon` 的 `,0` 资源索引在引号外面**，所以必须先去掉索引再去引号；
  顺序反了会得到 `"E:\Apps\DSH`（前引号还在、路径被截断）。
- `discoverDshInstall()` **故意不做模块级缓存**：设置行有个「重新检测」按钮，它的全部意义
  就是让用户装完 DSH 后能立刻看到——在这里 memo 化会让那个按钮变成谎话。
  昂贵的那步（注册表查询）在调用点已经有 5 秒缓存，那是唯一知道 UI 能容忍多旧答案的层。

`discoverDshInstall(candidates)` 和 `detectDsh(candidates)` 都接受一个**显式候选列表**，
只为测试存在：否则「找到一个安装 → 检测行这么报 → 启动行这么拼」这条链路就只能依赖
**跑测试那台机器上恰好装了什么**，而它恰恰是最容易静默断掉的一段（变异测试证明：
删掉分支 2 的**接线**时，只断言 `discoverDshInstall` 的测试**全绿**）。

#### ⚠️ 打包会把 `lib/` 复制进 asar —— 改了正典 ≠ 改了已发布的独立应用

**独立桌面版把 `lib/` 整个打进自己的 `app.asar`。** 已发布的
`D:\agents-group\dsh-agent-room\dist\win-unpacked\resources\app.asar` 里有一份
**自己的** `lib/harnesses.cjs`（23198 字节），**不随本仓库更新**。

实测（在真实 `Agent Room.exe` 里 `require` 它自己 asar 内那份）：

```
library   ...\resources\app.asar\lib\harnesses.cjs
dsh  found:false  "未检测到 dsh（本机 PATH 上没有 dsh，且当前进程不是 DSH 桌面端）"
```

也就是说：**本仓库修好之后，DSH 插件（走 junction）立刻受益，但独立应用的既有用户
仍然是旧检测**，必须**移植 + 重新打包**才生效。

> **验证「修复是否真的到了用户手里」，必须查 asar 内那份，而不是本仓库那份。**
> 用 `_research/probe-shipped-standalone.cjs`（在 `Agent Room.exe` 里跑），
> 它会报这个 build 到底有没有 `asarHasDshHost` / `discoverDshInstall`。
> 本会话的对照实验（`_research/standalone-probe.cjs`，可用 `AR_HARNESSES` 指向任意版本）
> 证明：**只加载本仓库那份会让「已修好」看起来成立**，而打包产物仍是旧的。

### 旧名册目录会被收养（别把这行删了）

上面那个 bug 还有个**遗留后果**：旧版看不到 profile 目录，于是名册落到
`<cwd>/.agent-room-rooms`；而桌面端 host 的 cwd **就是** profile 目录，
所以那次事故留下的真实名册在 `<profile>/.agent-room-rooms`（**带点**）。

修好之后正典位置是 `<profile>/agent-room-rooms`（**不带点**）——**另一个目录**。
若无条件切过去，用户会看到房间成员和聊天记录全部「消失」，观感和插件坏掉一样。

因此 `defaultRoomsDir` 会做一次**只读收养**：

- 正典目录已存在 → 用正典（已迁移的用户不会被拽回旧目录）；
- 否则旧目录存在**且确实是目录** → **就地使用**旧目录（不复制、不删除，不产生重复名册）；
- 旧路径只是个文件 → 不收养（否则名册根是个文件，写入即失败）。

`filesDir` / `themeDir` 是从 `dirname(roomsDir)` 推出来的，两条路都落在 profile 下，
所以上传与主题**不受影响、不会搬家**。收养逻辑的变异项同上（`never adopt` /
`legacy wins over canonical` / `adopt a file` 三个都被杀）。

### 仓库现在的取舍

`test/`（39 个文件）与 `_research/` 都已加进 `.gitignore`：

- **测试仍在磁盘上，仍可运行**（`node test/run-all.cjs`），只是不发布。
- 用户的原话是「测试文件不需要装到仓库中」，本仓库只装插件。

### 一条活着的兼容性约束

本机持久化的名册里，`deepseek` 这个成员的 `backend` 仍是旧的 **`"acp"`**。

`LEGACY_BACKENDS` / `canonicalBackend` 存在的唯一理由就是它：一次天真改名会让
`_createPool` 抛 `unknown backend: acp`，**整间房起不来**。已验证 `acp → dsh` 折叠正常。
改这一块之前请先想清楚这条。

---

## 8. 建议加载的技能（suggested skills）

| 技能 | 什么时候用 |
| --- | --- |
| `diagnose` | 遇到难查的 bug（尤其是 spawn / 进程存活 / 时序类）时，走「复现 → 最小化 → 假设 → 插桩 → 修 → 回归」 |
| `tdd` | 加新 harness 或改 `room.cjs` 行为时，先写红测试 |
| `playwright` | 需要在**真实浏览器**里确认右侧栏 tab、设置行、上传交互的渲染时 |
| `skill-creator` | 想把本仓库的验证套路固化成可复用技能时 |
| `handoff` | 再次交接时 |

另注：本机没有 `code-review` 类技能；代码审查请以「变异测试 + 离线全套」为准。

---

## 9. 首要下一步

**改 `lib/` 后必须重启 DSH**——host 模块代码只在启动时加载一次，HMR 帮不上忙。
`agent-room/` 以 junction 链进 `desktop` profile，所以重启后 `lib/*` 的改动就是生效的。

1. **重启 DSH**，确认「设置 → 通用 → Agent 群聊可用后端」这一行出现且可交互。
2. 在真实 GUI 里加一个 `qoder` 成员（若本机装了 Qoder）或 `dsh` 成员，验证成员真的能起会话。
   注意本机 PATH 上**没有** `dsh`：它现在靠**分支 2**（注册表发现 `D:\DeepSeek Harness`）成立。
   重启前 host 里报的是旧分支 1（「当前进程即 DSH」）——在这台机器上结论**恰好也对**，
   因为宿主确实就是 DSH，所以**从这一行看不出修复是否加载**。要确认加载了新代码，看
   `/agent-room/harnesses` 里 `detail` 是否变成「找到已安装的 DSH 桌面端：…」
   （在 DSH 宿主里仍会优先走分支 1，所以更可靠的是第 3 步）。
3. **验证 `--patch` 真的在活的子进程上**（这正是当初 `-32603` 的根因，且从 shell 里查不出来）：

   ```
   <bundled-node> _research/verify-live-patch.cjs
   ```

   退出码 0 = 所有 ACP 子进程都带 `--patch`；退出码 2 = 当前没有 ACP 子进程
   （先在 GUI 里开一个 `dsh` 会话）；退出码 1 = 还缺 `--patch`，host 仍是旧代码。
4. 若要继续补 harness，见 §6.2——加描述即可，然后补测试与变异项。
5. **独立应用要单独走一遍**：移植 `lib/` 的改动后必须**重新打包**，并用
   `_research/probe-shipped-standalone.cjs` 确认 asar 里那份也带了修复（见 §7 的打包警告）。
