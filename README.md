# dsh-approval-audit

简体中文 · [English（精简版）](README.en.md)

> **风险警告：装上它 = 关掉审批闸门。**
>
> - 装上它以后，**每个活动会话**都会被强制切到权限预设 `danger-full-access`（沙箱 `danger-full-access` + 审批策略 `never`）。审批不会再找你 —— 意思是**没有任何人再替你确认任何操作**：删文件、覆盖路径、跑任意命令，都直接执行。
> - **手动切回「仅可查看」不是回退。** 同一会话里不会被立刻改回去，但只要插件还挂载着，重启 Harness 或会话重建后的第一个会话事件就会把它再切一次 —— 别指望手动设置能保持。真要恢复审批：卸载插件（手动挂载的就删掉那段 insert），重启。
> - 它会把审批事件和**工具调用参数**追加写进本机 JSONL（默认 `$DSH_HOME/audit/approvals.jsonl`）。不上传、不联网，但内容可能带敏感信息（命令、路径、路径里的凭据），分享日志前自己看一遍。
> - **只适合**机器上不跑不可信代码、且你明确知道自己要它干什么的场景。别装在会用来自动处理陌生代码、网页、输入的机器上。
> - 后果自负。没有撤销按钮，也没有"小心模式"。

Host 侧插件：把每个活动会话切到完全权限（免审批），并把审批与工具调用逐条写成本机审计 JSONL。没有界面 —— 装上之后唯一可见的产物就是审计文件。

[![version](https://img.shields.io/badge/version-1.1.0-blue)](https://github.com/wojiao42/dsh-approval-audit/releases)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

## 截图

这个插件**没有界面，也没有截图可放**：它是 Host 侧插件（没有 `dsh.client`、没有客户端包），工作方式只有两件事 —— 听会话事件、往 JSONL 追加行。

装好之后你能看到的结果就是审计文件多出来的行。怎么验证见「自测」。

## 快速上手

1. **装**：图形界面（桌面端）设置（Ctrl+,）→ 插件市场 → 自定义安装 → 填 `github:wojiao42/dsh-approval-audit` → 重启 DSH；或命令行（见「安装」）`dsh plugin --profile web add github:wojiao42/dsh-approval-audit`。
2. **装上就自动挂载、立刻开始切权限，没有二次确认环节。** 重启那一刻插件就在跑了。
3. 让 agent 随便跑一次工具调用，然后看 `$DSH_HOME/audit/approvals.jsonl`（或 `DSH_APPROVAL_AUDIT_LOG` 指的位置）是不是多了行。

## 功能

### 免审批：把每个活动会话切到完全权限

插件监听会话事件流（`session/event`）。某个会话的第一个事件到达后，它调用 `permissionPresets.set(session, 'danger-full-access')`，把这个会话切到「完全权限」预设：

- 沙箱 `danger-full-access`
- 审批策略 `never`

**包括已经存在的会话** —— 这是它和「profile 默认预设」的区别：默认预设只对之后新建的会话生效，已经开着的会话不会动；这个插件在不重启会话的前提下把它们也切过去。

几个实现细节（都可以对照源码核实）：

- 切换发生在事件派发之外的 `queueMicrotask` 里，避免在提交事件的同时再写事件。
- 每个会话对象只切一次（内存里的 `WeakSet` 记录）。已经切过的会话不会反复写入。
- 如果会话本来就已经是目标预设（例如 profile 默认预设就是 `danger-full-access`），切换直接跳过，**不会**写 `auto-preset` 行 —— 这不是故障。
- 切换目标写死在 `index.js` 顶部的 `PRESET = 'danger-full-access'`。改成 `'workspace-write'` 就是保留沙箱限制（询问与否取决于宿主那档预设怎么配的）。
- 切换失败（宿主没有这个预设、会话对象异常等）只记一条 `auto-preset-failed`，不重试、不弹提示，会话按原预设继续。

### 审计：把审批与工具调用写进本机 JSONL

每行一条 JSON，字段是 `{ at, kind, session, type, data }`（`auto-preset` / `auto-preset-failed` 两类没有 `type`，改带 `preset` / `error`）。

记录的事件类型（源码里的 `WATCHED` 白名单，其余事件一律不写，避免日志被 token 流淹没）：

| 事件 | 说明 |
|---|---|
| `approval/asked` | 谁问的审批、哪个工具、理由 |
| `approval/decided` | 结果：`allowed-once` / `rejected` / `cancelled` / `unavailable` |
| `approval/policy` | 审批策略变更（`ask` ↔ `never`） |
| `sandbox/mode` | 沙箱模式变更 |
| `permission/preset` | 权限预设选择 |
| `tool/call` / `tool/result` | 工具调用与结果（参数截断 300 字符） |
| `turn/end` | 回合结束 |

另外两类是本插件自己的记录：

| kind | 说明 |
|---|---|
| `auto-preset` | 本插件把哪个会话切到了哪个预设 |
| `auto-preset-failed` | 切换失败的会话，以及错误信息 |

载荷会截断：工具参数 300 字符、`tool/result` 的 `meta` 200 字符、其余事件数据 400 字符。`tool/result` 只记 `error` 与 `meta`，不记完整结果。

审计是**追加写**（`appendFileSync`），**不轮转、不压缩**。删掉文件后下一次写入会自动重新创建。

## 口径与安全设计

### 它改什么

只有三件事：

1. 调用 `permissionPresets.set()` 改会话的权限预设 —— 这会由宿主产生 `permission/preset` 事件，是插件唯一的"改状态"动作。
2. 向审计文件追加行。
3. 审计文件的父目录不存在时，`mkdirSync(..., { recursive: true })` 建出来。

### 它不做什么（可对照源码逐条核实）

| 主张 | 怎么自己核实 |
|---|---|
| **不改会话事件** | 唯一的订阅是 `ctx.on('session/event', ...)`，回调里只读 `event.type` / `event.data`，不返回、不写入。 |
| **不碰工作文件** | 唯一的写路径是审计 JSONL（源码里的 `LOG_PATH`）；没有别的 `appendFileSync` / `writeFileSync`。 |
| **不联网** | `import` 只有 `node:fs` 与 `node:path`；全文没有 `fetch` / `http` / `https` / `net` / socket。 |
| **不执行命令** | 没有 `child_process`，也没有 `spawn` / `exec`。 |
| **不删、不改名** | 没有 `unlink` / `rm` / `rename` / `chmod`。审计文件只能你自己删。 |
| **写失败不影响会话** | `log()` 整段包在 `try/catch` 里：落盘失败只丢这一条记录，会话照常跑 —— 也就是说**审计失败是静默的**。 |
| **只记白名单事件** | `WATCHED` 集合之外的事件（token 流等）不写。 |

### 审计本身也是风险

- **工具调用参数会进日志。** 参数里可能有 token、密码、私有路径、命令内容。文件在本机、不上传，但它是一份明文 JSONL。
- **它不防篡改。** 就是普通文本，谁都能改、能删。它的作用是"事后能看见"，不是"防抵赖"。
- **它不判断危险。** 插件不区分一条命令是 `ls` 还是 `rm -rf`，也不判断该不该放行 —— 放行是权限预设的事，插件只负责照着预设走 + 记账。
- **审计路径不跟工作区走。** 优先级：`DSH_APPROVAL_AUDIT_LOG` → `$DSH_HOME/audit/approvals.jsonl` → `~/.dsh/audit/approvals.jsonl`。写不进去是静默的，见「安装」。

### 设计取舍

它解决的是"不想每次都被拉去点同意，但事后要能查到底放行了什么"。所以它把两件对立的取向捆在一起：**放行自动化**（切换预设，人不再介入）+ **事后留账**（JSONL）。

代价必须说清楚：一旦装上，审批这道人工闸门就没了，审计只能事后看、而且能被改。它不是安全机制，是"我知道我在干什么"的机器上的便利工具。

## 安装

### 装完就生效

从 v1.1.0 起这个插件可以一键安装：`package.json` 里有 `dsh.bundle.patch`（指向仓库里的 `cordis.patch.yml`），插件市场 / `dsh plugin add` 装包时会把它带进 profile 的 patch 层 —— **装完重启 DSH 就挂载好了，不用再手工改 profile 的 patch 文件**。

也正因为这样：**装上就自动挂载、立刻开始切权限，没有二次确认环节。** 误装的代价是这台机器上所有活动会话的审批闸门都没了 —— 装之前先看顶部风险警告。

### 1. 装包

图形界面（桌面端，推荐）：设置（Ctrl+,）→ 插件市场 → 自定义安装 → 填 `github:wojiao42/dsh-approval-audit` → 重启 DSH。

命令行：

```bash
# 桌面端（DSH Desktop）
dsh plugin --profile desktop add github:wojiao42/dsh-approval-audit

# 浏览器版（DSH Web）
dsh plugin --profile web add github:wojiao42/dsh-approval-audit
```

> 桌面端的 profile 由应用托管：直接跑 `dsh plugin --profile desktop add` 可能被拒绝，遇到就走上一步图形界面。

### 2. 不想自动挂载：手动 patch 层插入

bundle 自动挂载开箱即用。如果你要自己控制挂载（例如从本地源码目录直接跑、或想先审一遍 patch 内容再启用），可以在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 末尾追加一段 insert（`<profile>` 即 `desktop` / `web`）。

包名写法（包已经装进 profile 时用）：

```yaml
- insert:
    - id: approval-audit
      name: 'dsh-approval-audit'
```

本机绝对路径写法（不装包、直接把入口指到源码目录也行；Windows 路径用正斜杠）：

```yaml
- insert:
    - id: approval-audit
      name: '<插件目录>/index.js'
```

两种写法二选一，`id` 保持 `approval-audit` 即可。

### 3. 选审计路径（可选）

默认落在 `$DSH_HOME/audit/approvals.jsonl`（没有 `DSH_HOME` 时退到 `~/.dsh/audit/approvals.jsonl`）。想放别处就设环境变量：

```bash
# macOS / Linux
export DSH_APPROVAL_AUDIT_LOG="/path/to/approvals.jsonl"
# Windows PowerShell
$env:DSH_APPROVAL_AUDIT_LOG = "D:/somewhere/approvals.jsonl"
```

环境变量在插件加载时读取，改完要重启 DSH。目录写不进去（盘符不存在、没权限）时 `mkdirSync` / `appendFileSync` 抛错被吞掉，**审计静默失效**，你什么都看不到 —— 先按「自测」里的手工步骤确认。

### 4. 重启 DSH

Host 插件在启动时加载。装完包、或改完 patch 层 / 环境变量，都必须重启 DSH；窗口里只刷新页面不够。

### 卸载

- **一键装的（bundle 自动挂载）**：`dsh plugin --profile <profile> remove dsh-approval-audit`（或在插件市场里卸载），重启 DSH。
- **手动挂的**：删掉 `cordis.patch.yml` 里那段 insert（或把该行改成 `disabled: true`），重启 DSH。
- 两种都要检查有没有残留的「新会话默认完全权限」类 profile 配置，有就一起恢复，否则新会话仍然免审批。
- 审计文件保留，不会自动删除 —— 想清掉自己删。

## 自测

**没有自动化测试。** 仓库里没有测试文件，`package.json` 里也没有 `scripts.test`。行为验证只能手工。

唯一能自动跑的是语法检查：

```bash
node --check index.js
```

手工验证（装完立刻能做的三步）：

1. 重启 DSH，新开一个会话，让 agent 跑任意一次工具调用（例如「列一下当前目录」）。
2. 打开审计文件：`$DSH_HOME/audit/approvals.jsonl`（或 `DSH_APPROVAL_AUDIT_LOG` 指定的路径）。
3. 应该看到新行：`"kind":"session-event"`、`"type":"tool/call"` 与 `"type":"tool/result"`。如果这个会话不是一开始就是完全权限，还会有一条 `"kind":"auto-preset"`。

看不到新行时，依次查：

- 审计目录能不能写（写失败是静默的），默认在 `$DSH_HOME/audit/`；
- 宿主有没有名为 `danger-full-access` 的权限预设（切换失败只记 `auto-preset-failed`）；
- 插件行有没有真的被加载（patch 层语法错会让整段不生效）。

## 兼容

- **位置**：Host 侧插件，没有客户端界面、没有客户端包（不声明 `dsh.client`）。桌面端、Web 端、headless profile 通用 —— 只要那个 profile 能加载 Host 插件。
- **包名**：`dsh-approval-audit`（v1.1.0 之前是 `@local/dsh-approval-audit`）。
- **挂载**：两种都支持 —— 优先用 `package.json` 的 `dsh.bundle.patch`（指向仓库里的 `cordis.patch.yml`）自动挂载；也可以手动在 profile 用户 patch 层 insert（见「安装」）。两种方式都需要**支持 cordis patch 的 DSH**（当前版本支持；更老的版本不一定）。
- **宿主服务**：`inject = ['permissionPresets']`，依赖 DSH 的权限预设服务（`dsh-permission-presets`）。
- **预设名**：写死 `danger-full-access`，宿主必须存在同名权限预设，否则切换失败。
- **依赖**：只用 Node 内置模块 `node:fs`、`node:path`、`node:os`；无第三方包，没有 `peerDependencies`。
- **Node**：`package.json` 没有 `engines`。源码只用到 `appendFileSync` / `mkdirSync` / `queueMicrotask` 和可选链，版本以 Harness 自带运行时为准。

## 已知边界

1. **每个会话对象只切一次。** 手动切回「仅可查看」后，同一会话里不会被立刻覆盖；但重启 Harness 或会话重建后的第一个事件会再切一次。真正的回退是卸载插件（手动挂载的就删掉那段 insert）。
2. **审计不轮转。** 追加写，文件只会变大；自己删（删后下一次写入自动重建）。
3. **审计路径不跟工作区走。** 默认 `$DSH_HOME/audit/approvals.jsonl`，可用 `DSH_APPROVAL_AUDIT_LOG` 覆盖；写失败被静默吞掉。
4. **改 `PRESET` 要重启。** Host 代码的模块热重载默认关闭，改完 `index.js` 顶部的 `PRESET` 必须重启 Harness。
5. **切换失败不重试、不提示。** 只有一条 `auto-preset-failed` 审计记录。
6. **日志会截断。** 工具参数 300 字符、`tool/result` 的 `meta` 200 字符、其余数据 400 字符；`tool/result` 不记完整结果。
7. **不区分会话来源。** 不按工作区、不按来源过滤，凡是活动会话一律切。
8. **装上即挂载生效，没有「先装后启」的缓冲。** v1.1.0 起装包自带 `dsh.bundle.patch`，装完重启那一刻插件就在跑，不会留给你一个"先装上、之后再决定启用"的中间状态；想反悔只能卸载。

## 版本

- **v1.1.0**（2026-11-08）：加 `dsh.bundle.patch`，可经插件市场/GitHub 一键安装（自动挂载）；包名由 `@local/dsh-approval-audit` 改为 `dsh-approval-audit`。审计路径同时改为可配置：`DSH_APPROVAL_AUDIT_LOG` → `$DSH_HOME/audit/approvals.jsonl` → `~/.dsh/audit/approvals.jsonl`（不再硬编码作者本机路径）。
- **v1.0.0**（2026-11-08）：首个公开版本。功能与作者自用版本一致：免审批切换（`permissionPresets.set` 到 `danger-full-access`）+ 本机审批/工具调用审计 JSONL。当时没有 `dsh.bundle.patch`，装它得先装包、再手工在 profile 的 patch 层插一行。

## 收录状态

尚未投稿：没有 PR 号，也不在 awesome-dsh-plugin / dsh-plugin.org 的目录里。投稿后在这里补 PR 与收录日期。

## 许可

MIT，全文见 [LICENSE](./LICENSE)。
