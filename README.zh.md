# dsh-notify

[English](README.md) | 中文

为 DeepSeek Harness 提供 Windows 11 原生 toast 通知。

工作在你看着别处的时候仍在继续。一个回合被授权请求卡住、因报错而死掉、或者悄悄不再产出进展，看起来和一个正在思考的回合完全一样。这个插件把每一种转变都变成一条 Windows 通知，点击通知即可把 DSH 窗口切回前台。

| 情况 | 通知 |
|---|---|
| 工具调用在等你授权 | **DSH 需要你的授权** — 工具名与原因，带 *打开 DSH* / *知道了* 按钮 |
| DSH 在等你回答提问 | **DSH 需要你的选择** — 问题标题与问题本身 |
| 某个回合或会话失败 | **DSH 出错了** — 错误原文 |
| 账号需要登录 | **DSH 账号需要处理** |
| 运行超过 `minRunSeconds` 的回合结束了 | **DSH 已完成** — 用时多久 |
| 运行中的回合静默超过 `stallSeconds` | **DSH 可能卡住了** — 已经静默多久 |

授权与提问使用长驻留通知，会留在通知中心，所以你错过的请求回来时还在。

上面的文案是出厂默认（`locale: zh`）。设 `locale: en` 可换成英文；表格只是在说明哪些事件会发通知，不代表语言。

## 出厂策略：只提醒必须你处理的事

默认只在**一种**情况下打断你 —— **工作卡在你身上**：授权请求、提问、需要登录的账号、或者失败。上表最后两行已实现并测试，但**默认关闭**：

```yaml
notifyOnIdle: false    # 长任务跑完了
notifyOnStall: false   # 运行中的回合不再有进展
```

如果你更希望知道长任务*跑完了*、或者它安静了，把两者都打开：

```yaml
notifyOnIdle: true
notifyOnStall: true
minRunSeconds: 20      # 更短的回合保持安静
stallSeconds: 240      # 触发"可能卡住"提示前的静默时长
```

阻断类通知如果一直没人理会，还可以再催一次：

```yaml
escalateAfterSeconds: 90   # 0 为关闭，这也是默认值
```

这次催促会用 `reminder` 提示音和一个「仍未处理」标题**重画同一条**通知，所以通知中心里那个请求始终只有一条，而不是堆出一串提醒。

## 命令

```
/notify mute [分钟]   # 静音；不带分钟数则直到 unmute
/notify unmute
/notify status        # 静音状态 + 传输统计
/notify test          # 立刻发一条自检通知
```

静音是一个**时刻**而不是一项设置，所以它做成命令而不是配置项：它必须在会议开始那一刻生效、在结束时结束。静音只拦截新的打断；它不会阻止"把你已经答复过的通知标记为已处理"那次重画，因为让一条过期通知留在屏幕上，比它本会造成的打扰更糟。

`/notify test` 与 `/notify status` 也是你在没有真实事件时检查传输通路的方式。

## 合批与进度

两个可选行为改变的是**什么时候**告诉你，所以两者都默认关闭 —— 出厂策略是一有事就立刻说。

```yaml
aggregateWindowSeconds: 20   # 一波突发合成一条通知，并写明条数
progressAfterSeconds: 120    # 长回合主动告知"还在跑"
progressRefreshSeconds: 60   # ……并持续更新已用时长
```

一波突发汇总到该类别自己的 tag 上，所以后续突发会**替换**前一条而不是堆叠，汇总里带最新的细节和条数。**阻断类请求永不进入这个窗口**：需要你回答的东西立刻出现，无论同时来了多少条。

进度通知带一个不确定进度条，因为一个 agent 回合没有已知的完成比例 —— 诚实的信号是"还在跑"，加上已经跑了多久。它是静音的，在自己的 tag 下刷新，并在回合结束时被改写为*已结束*，而不是留在那里假装工作还在继续。由于焦点门控同样作用于它，你在看屏幕时被抑制的那次刷新会在下一个周期重试，所以等你转开视线时它已经出现了。

## 你在看屏幕时保持安静

当 DSH 窗口占据前台时，通知会被抑制，因为提醒你已经看着的东西只是噪音。这个判断直接向 Win32 询问（`GetForegroundWindow` + `GetWindowThreadProcessId`），由本来就要画 toast 的那个 PowerShell 进程完成，所以不额外多一次进程启动。

它的失败方向是**放行**。一个"永远回答 focused"的探测会静默吞掉所有通知，而这个插件绝不能有这种故障，所以这项能力在激活时被验证一次：如果探测无法给出前台 pid，门控就直接关闭、所有通知无条件发出。插件会记录 `focus gate on` 或 `focus gate off` 及原因，并且这个探测可以在不画任何通知的前提下双向测试：

```powershell
# 报告前台 pid，以及给定 pid 是否与之匹配
$payload = @{ focusCheck = @{ pids = @(1234, 999999) } } | ConvertTo-Json -Compress
```

设 `quietWhenFocused: false` 可不看焦点一律通知，或用 `focusPid` 指定与宿主父进程之外的对象比较。

## 通知中心里的行为

授权或提问通知在**被答复之后**会被重画为 **已处理 / Answered**。一条持续索要你已经做过的决定的通知，比没有通知更糟。

重画是唯一可用的机制。`ToastNotificationManager.History` 绑定的是调用进程的包标识，而宿主没有 —— 从这里调用 `GetHistory` 只会得到空历史，每次 `Remove` 都以 `0x80070490 Element not found` 失败。这个结论是**探测出来的**而不是从 API 表面推断的：发一条带 tag 的通知、等待、再查询对应分组。无包标识进程*能*做的是发出一条 tag 与分组都已被通知中心持有的通知，那会替换掉旧的。所以一个已了结的请求是靠重画来退场的，静音而短暂，而不是被删除。

两个值得知道的后果：已处理的那条通知会短暂地再弹一次横幅；而**未答复**的通知永远不会被移除 —— 它会一直留到你处理它或关掉它。设 `settleResolvedToasts: false` 可保留原通知不动。

这里**刻意没有通知历史功能**。读取或清空通知中心需要 `ToastNotificationManager.History`，而它绑定调用进程的包标识；从无包标识的宿主调用时 `GetHistory` 什么都返回不了、`Remove` 直接失败。通知中心本身就是历史，而阻断类通知使用 `duration: long`，正是为了你回来时它还在。

tag 是**派生**出来的而不是嵌进去的，因为 Windows 把 `Tag` 和 `Group` 都限制在 64 字符，设置更长的值会在通知显示**之前**抛异常 —— 超长 tag 丢掉的是整条通知，不只是它的标识。一个会话 id 自身就有 44 字符，所以 tag 是一个 11 字符的 `<类别>-<哈希>` 组合：每条通知稳定、跨会话不撞、也不可能超出上限。

## 点击通知会发生什么

通知正文会打开 `openUri`，而 Desktop 外壳把它解析为唯一一件事：**把主窗口抬到前台** —— 最小化就还原，已销毁就重建。它**不会**跳转到触发该通知的会话。外壳把 `second-instance` 接在一个零参数回调上，所以承载 URI 的命令行被丢弃；而它唯一识别的 URI 是 `dsh://open`。因此由后台会话或子代理会话发出的通知，只是把你带回 DSH，而不是带回那个会话。

要精准落到那个会话，需要 Desktop 外壳支持带会话的深链接。任何宿主插件都做不到：点击事件来自 Windows 而不是渲染进程，插件没有任何可以拦截的环节。

### 是哪个会话在问

因为点击无法跳转，每条通知都在页脚写明自己的会话：`<项目目录> · <会话 id 前 8 位>` —— 例如 `default-workspace · 97217b96`。项目目录未知的会话会写成 `会话 <id 尾段>`，所以裸的 44 字符会话 id 永远不出现在通知上。Windows 本来就会根据 AUMID 注册在通知上方打印应用名，这就是页脚用来放这个信息、而不是重复应用名的原因。

设 `attribution` 可用固定文本覆盖页脚。

## 安装

这个 bundle 安装进当前 profile，并在重启后保留：

```
plugin_manager  action: install_bundle  target: <本目录>
```

然后确认这一行是活的：

```
cordis_inspect_query  provider: Config  method: listConfigs  input: { name: "dsh-notify" }
```

## 它会写入的 Windows 注册项

桌面应用只能在 shell 认可的 Application User Model ID 下发通知，而这需要两半：

1. 一个携带该 AUMID 的开始菜单快捷方式 —— **DeepSeek Harness 安装包已经写了这一半**（`com.deepseek.dsh`，表现为快捷方式的 `System.AppUserModel.ID`），以及
2. `HKCU\Software\Classes\AppUserModelId\com.deepseek.dsh` —— **另一半没人写**，缺了它 `CreateToastNotifier` 会以 `0x80073D54: The process has no package identity` 失败。

激活时插件会补写缺失的那一半（若不存在），这样通知会带上 DeepSeek Harness 的名字。当已记录的值已经正确时写入会被跳过，且仅影响当前用户。

它记录的图标来自 `process.execPath`，而它只有在宿主跑在 Electron 下时才是桌面应用本体。从命令行启动、或从 `tools/verify-live.mjs` 启动时，那个路径是 node 可执行文件；此时插件**宁可不写图标也不写一个错的**，Windows 会继续沿用开始菜单快捷方式所声明的图标。可用 `iconUri` 显式钉住。

要撤销这项注册：

```powershell
Remove-Item 'HKCU:\Software\Classes\AppUserModelId\com.deepseek.dsh' -Recurse
```

设 `registerAppId: false` 可完全退出这项写入（那样除非你自己注册了 AUMID，否则通知会失败）。

## 为什么用 Windows PowerShell 而不是 PowerShell 7

插件**先**探测 Windows PowerShell、之后才试 `pwsh`，这是有意的：

- **PowerShell 7** 跑在 .NET (Core) 上，而 .NET Core 移除了内置的 WinRT 类型投影。`Windows.Data.Xml.Dom.XmlDocument` 与 `Windows.UI.Notifications.*` 在那里根本无法解析，连通知都构造不出来。
- **Windows PowerShell 5.1** 跑在 .NET Framework 上，它的 WinRT 投影是系统自带的。这才是能发通知的那个 PowerShell。

`shell: auto` 会在激活时跑一遍探测并记录谁胜出。把 `shell:` 指向绝对的 `pwsh.exe` 或 `powershell.exe` 可显式选择；探测失败时插件会带着记录下来的原因保持惰性，而不是变成一个静默坏掉的发送器。

## 设置

插件自带设置页面，由浏览器半边提供。它出现在**两处**，所以不打开设置也能够到这些控件，同时 Plugins 里那一行仍保留自己的配置入口：

- 侧边栏的**图标**（`sidebar.panellist`），点击打开一个**主页面板**（`main`，key 为 `dsh-notify`）—— 与 token-ledger 插件相同的一套配对；以及
- Plugins 里的 **`plugins.row.config`** 行，key 为 `dsh-notify#dsh-notify`，即 Plugins 页为某个 bundle 的某一行派发的位置。

两个界面消费的契约并不相同，改动前需要知道这一点。Plugins 那一行是**被递进来**一个 `ConfigPageForm` —— `{ state, mutate }`，一个状态值和一个写入函数 —— 而主页面板没有 owner，所以它自己去解析该条目的 scope（`ctx.configForms.get`）并适配成那一行期望的形状。两者渲染同一个组件。`npm run lint` 会检查侧边栏行与它的面板共用一个 id（外壳会拒绝没有任何 `main` 条目认领的 key），以及两半拼写的设置命名空间一致。

**光有 `Config` schema 并不会产生表单。** `dsh-settings` 的文档写明：*表单只暴露 volatile 字段*、普通配置仍然只能改文件、以及自动生成的表单*目前没有任何客户端实现*。让这个页面真正成立的是三件事：

- **在可编辑字段上标 `.volatile()`。** 只有这些字段会被投影进表单。与之对应的活读取器是 `VOLATILE_SPECS` 表；`npm run lint` 会双向检查两者一致，因为"声明了却冻结"的字段是在承诺一个永远到不了的编辑，而"有活读取器却没有声明"的字段则永远不会出现在界面上。
- **`configure({ auto: false }, ctx.fiber)`**，通过一个可选的 `ctx.inject(['settings'], …)` 子上下文声明，这样宿主不会再去尝试生成页面，同时插件在没有 Settings 服务的 profile 里也照常工作。
- **浏览器半边**（`lib/client.js` 加 manifest 的 `dsh.client`），控件归它所有。它不能 require Harness 的客户端包 —— 共享设置表单的行为是重新实现的 —— 并且只用 `--dsw-alias-*` 主题 token 做样式，这一条 `npm run lint` 同样会强制。

写入是即时的：一个控件、一次编辑、一次携带所读 `revision` 的 `scope.mutate`，所以过期的写入会被拒绝而不是覆盖别人。宿主是"是否被接受"的唯一权威，因此结果是从 scope 读回来的。

插件在**使用时**读取的字段可以实时编辑。在激活时决定的字段 —— `focusPid`、`stallCheckSeconds`、`maxInFlight`、`timeoutMs`、`selfTest` —— 在页面上标为**（需重载）**并且只能改文件，因为对它们承诺实时生效等于说谎。

它依赖两件事：

- **第一次需要重启一次**，此后改动宿主半边也需要：宿主缓存 ES 模块代，所以开关 bundle 只会重新应用该行的 `config`，不会重新 import 代码。浏览器半边随页面刷新加载 —— 客户端插件的 HMR 接收器只有在 `pnpm run dev:web` 运行时才能免刷新重载。
- **`@deepseek-ai/schemastery` 能从本目录解析。** DSH 自带的那份在安装目录里，而用 `link:` 安装的 bundle 够不到：Node 按真实路径解析链接包，profile 的 `node_modules` 和安装目录都不在那条路径上。因此这个包是本项目的真实依赖，装在这里。进程里存在两份副本是安全的 —— schemastery 把内部实现注册在 `Symbol.for("schemastery")` 与 `globalThis.__schemastery_*` 上，这些按设计就是进程全局的。万一 import 失败，插件会记录 `settings page unavailable` 并继续通知：设置页面从来不是承重结构。

## 配置

每一项都是可选的。可以在设置页里改，也可以直接改 `cordis.patch.yml` 中该行的 `config` —— 后者仍然是设置激活期字段的唯一途径。

| 键 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关。 |
| `appId` | `com.deepseek.dsh` | 通知使用的 AUMID。 |
| `displayName` | `DeepSeek Harness` | Windows 在通知上方显示的应用名。 |
| `registerAppId` | `true` | 补写 AUMID 注册项中缺失的那一半。 |
| `shell` | `auto` | `auto`，或显式指定 PowerShell 可执行文件。 |
| `shellArgs` | `[]` | 放在 `-File` 之前的附加参数。 |
| `openUri` | `dsh://open` | 点击通知正文时打开的 URI。 |
| `locale` | `zh` | 内置文案语言：`zh` 或 `en`。 |
| `attribution` | 会话上下文 | 正文下方的页脚行。默认 `<项目> · <短会话 id>`；`tools/verify-live.mjs` 会改写它，使自检通知不可能被误认。 |
| `iconUri` | DSH 可执行文件 | AUMID 声明的图标，`file://` URI。 |
| `settleResolvedToasts` | `true` | 已答复的授权/提问通知重画为已处理。 |
| `escalateAfterSeconds` | `0` | 阻断通知多久未答复后更醒目地重画。默认关闭。 |
| `escalateSound` | `reminder` | 升级重画使用的提示音。 |
| `quietWhenFocused` | `true` | DSH 窗口占据前台时保持安静。 |
| `focusPid` | 宿主的父进程 | 焦点门控所比较的进程。 |
| `aggregateWindowSeconds` | `0` | 把非阻断突发汇总为一条通知的窗口长度。 |
| `progressAfterSeconds` | `0` | 回合运行多久后显示进度通知。 |
| `progressRefreshSeconds` | `60` | 该通知的刷新间隔。 |
| `notifyOnApproval` | `true` | 授权请求。 |
| `notifyOnQuestion` | `true` | 结构化提问。 |
| `notifyOnError` | `true` | `agent/error` 与 `api-session/error`。 |
| `notifyOnAccount` | `true` | 需要登录、会话过期。 |
| `notifyOnIdle` | `false` | 运行足够久的回合结束了。需开启。 |
| `notifyOnStall` | `false` | 运行中的回合不再有进展。需开启。 |
| `notifyOnWorkflowEnd` | `false` | 工作流运行结束。 |
| `includeSubagents` | `false` | 子代理会话也发通知。 |
| `minRunSeconds` | `20` | 更短的回合不报完成。 |
| `stallSeconds` | `240` | 运行中回合的静默时长阈值。 |
| `stallCheckSeconds` | `15` | 看门狗采样周期。 |
| `sounds` | 按类别 | `default`、`silent`、`alarm`、`im`、`mail`、`reminder`。 |
| `durations` | 按类别 | `short` 或 `long`。 |
| `maxInFlight` | `3` | 并发的通知进程数，其余排队。 |
| `timeoutMs` | `15000` | 超过此限的通知进程会被杀掉。 |
| `selfTest` | `false` | 激活时发一条探针通知。 |

## 什么算作"有进展"

仅在 `notifyOnStall` 开启时相关。看门狗把三件事当作回合仍存活的证据：实时的 assistant token（`agent/assistant-stream`）、已提交的会话事件（`session/event`）、以及状态跃迁。**一次长时间的工具调用三者都不会产生**，所以这条提示的措辞是*无可观测进展*，而不是"出错"。把 `stallSeconds` 设得比最长正常工具调用或模型等待更长，就能让它保持安静。

## 验证一次改动

| 层 | 命令 | 证明什么 |
|---|---|---|
| 单元 | `npm test` | 纯逻辑（`test/pure.test.mjs`）：tag、标签、时长、配置下限、活值语义、注册表解析 |
| 渲染 | `npm test` | 浏览器半边能渲染（`test/client.test.mjs`）：模块以自己的槽位 key 注册、页面在真实 React 下不抛异常、两种语言下每个字符串都能解析 |
| 写入 | `npm test` | 浏览器半边能编辑（`test/client-dom.test.mjs`）：在真实 DOM 里，控件写出的 op 是 scope 期望的形状 —— `{op:'set',path:[field],value}` 或 `{op:'unset'}` —— 携带它读到的 revision，拒绝非法草稿，并上报宿主拒绝的写入 |
| 一致性 | `npm run lint` | 默认值、设置 schema、volatile 声明、以及上表描述的是同一批键；页面样式只用主题 token |
| 载荷 | `npm run verify:dry` | 每个监听器都会触发、每条通知都正确构造 —— 但不显示任何东西 |
| 投递 | `npm run verify:live` | 同样的流程走真实的 PowerShell 与 Windows；每条通知都标注为自检 |

`npm run check` 一起跑语法、单元、渲染、lint 与 dry 载荷。真实投递刻意分开，因为它会**故意**往你桌面上弹通知。

渲染这一层存在的原因是：没有浏览器控制的机器打不开那个页面，而一个抛异常的组件会把它的槽位条目变空白，只留下 console 里一行。它用一个替身模块加载器加载 `lib/client.js`，通过 `react-dom/server` 驱动注册出来的组件，断言控件数量、取值、只读状态，以及**没有 locale key 被原样回显** —— `translate` 在字典缺键时会返回键名本身，所以没展平的键会出现在标记里。这样渲染需要 `getServerSnapshot`，组件已提供。

写入这一层单独存在，是因为渲染与编辑会独立失败：一个什么都不写的控件，从外面看和正常控件一模一样。它把页面挂进 jsdom、派发真实事件，并断言那个 *op* —— 形状、路径、值，以及编辑时读到的 `revision` —— 而不是"某个回调被调用了"。它同时覆盖两种静默失败：非法草稿必须完全不写；被宿主拒绝的写入必须浮出水面而不是消失。

有两类缺陷只会在真实投递层出现：超出 64 字符平台上限的 tag，以及由此产生的、会直接丢掉整条通知的 `Tag` 设置异常。dry 模式替换了渲染进程，所以任何被 Windows 本身拒绝的东西在那里都不可见 —— 这也是载荷层同时断言平台自身限制的原因（`every tag and group fits the 64-character ceiling`）。

## 排障

- **完全没有通知。** 检查 Windows *设置 → 系统 → 通知*：通知必须开启，且专注助手不能把它过滤掉。然后读下面的激活轨迹：它能区分"从未激活"和"激活了但很安静"。
- **日志里出现 `0x80073D54`。** AUMID 注册项缺失且 `registerAppId` 为 `false`，或者开始菜单快捷方式那一半没了。若快捷方式缺失，重新运行 DeepSeek Harness 安装包。
- **通知出现了但点击没反应。** 点击依赖桌面应用安装的 `dsh:` 协议处理器；检查 `HKCU\Software\Classes\dsh\shell\open\command`。注意外壳在应用尚未进入工作区时是刻意不做任何事的。
- **通知太多。** 出厂默认已经是安静策略；如果你打开了 `notifyOnIdle` 或 `notifyOnStall`，调大 `minRunSeconds` 或 `stallSeconds`，或者把它们关回去。

## 为什么它不通知我？

通知插件的故障形态就是安静，所以激活过程会被记进 `%TEMP%\dsh-notify-trace.log`（其他平台为 `$TMPDIR`）。这份轨迹有上限、同步写、且绝不会把异常抛进插件。

| 轨迹最后一行 | 含义 |
|---|---|
| 完全没有 | 模块从未激活 |
| 停在 `apply finished` 之前 | 激活中途停止；最后一行就是它走到的里程碑 |
| `apply threw before finishing:` | 抛出异常及其信息 |
| 有 `apply finished` 但没有 `event …` 行 | 它是活的且安静 —— 没有匹配的事件到达 |
| 有 `event user-questions/request` 却没有通知 | 监听器触发了，是传输端丢掉了它 |

删除该文件可重新开始记录；在下一次激活之前它不会被重建。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。本插件是一个独立的 bundle：它不携带 DeepSeek Harness 的任何代码，只依赖 `@deepseek-ai/schemastery`，并从自己的目录解析它。
