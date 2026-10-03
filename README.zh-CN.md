# Codex Goal Kernel

[English](README.md) | [简体中文](README.zh-CN.md)

一个独立的 TypeScript 项目，通过重复验收和持久化进度，让 Codex CLI 在有限轮次内
持续推进任务。它是面向单个本地目标的实验性执行器，拥有独立的状态、CLI 和测试，
不依赖 LoopX 的安装或仓库，也不调用 Codex 原生 Goal API。

## 为什么这样设计

内核持续呈现同一个目标，在实际工作区中重新检查验收条件，并且每个检查点只计
一次进度。这些选择针对两类问题：已经失效的成果仍被当作成功，以及重复活动被
当作有效进度。设计原因、取舍和证据边界见[设计说明](docs/design.zh-CN.md)
（[English](docs/design.md)）。

## 运行项目

需要 Node 22.22.3 或更新版本、可用且已登录的 `codex` 命令。示例中的验收命令还
需要 Python 3。在仓库根目录执行：

```bash
npm ci
npm run typecheck
npm test
PROJECT_DIR="$(mktemp -d)"
node --experimental-strip-types src/cli.ts init --project "$PROJECT_DIR" --id greeting --spec ./examples/greeting/spec.json
node --experimental-strip-types src/cli.ts run --project "$PROJECT_DIR" --id greeting --turns 6
node --experimental-strip-types src/cli.ts status --project "$PROJECT_DIR" --id greeting
node --experimental-strip-types src/cli.ts view --project "$PROJECT_DIR" --id greeting
```

目标声明、状态、执行记录和文本视图保存在所选项目的 `.goal-kernel/` 目录。本仓库
已经忽略该目录；使用其他 Git 项目时，需要把它加入那个项目的忽略规则。重复执行
`init` 会被拒绝，以免抹掉现有目标的预算和验收状态。新实验使用新 id；JSON 声明的
`goal_id` 必须与 `--id` 一致。

默认沙箱策略为 `workspace-write`。只读检查任务可使用 `--sandbox read-only`。
显式传入 `--sandbox danger-full-access` 会让子进程获得当前用户的文件系统权限；
常规沙箱不可用时，仅在可信、可丢弃的环境中使用。项目不会修改 Codex 的登录、
模型、全局设置或调度配置。
[Codex 身份验证文档](https://developers.openai.com/codex/auth) 说明了 CLI 的登录
存储方式。应在实际运行本项目的环境中执行 `codex login status`；继承的另一套
配置目录可能对应不同的登录状态。

停止使用时，停止调用 `run`，并移除自己创建的外部定时任务。项目不安装常驻进程。
可以保留目标目录供检查，也可以随可丢弃的测试项目一起删除。删除本仓库不会修改
Codex 或其配置。

## 验收与进度

使用者提供 `objective`、`predicates`、`policy.max_turns` 和
`policy.max_idle_turns`。两个限制都必须是正整数，验收条件的 id 必须唯一。
支持 `file_exists`、`file_sha256`、`command` 和 `owner` 四种检查，定义见
[`src/types.ts`](src/types.ts) 和[示例](examples/greeting/spec.json)。

执行前，内核检查声明指纹、待办引用、文件假设和待确认的目标修订，再根据实际
工作区更新验收状态，让续跑的会话看到已经失效的成果。执行后会再次检查声明，
重新运行全部自动验收，更新待办并判定本轮结果。验收命令必须可信、有执行边界、
可重复运行且只读；它们在轮次前后运行于所选项目中，不继承模型子进程的沙箱。

`verified_predicates` 保存当前快照。自动检查失败会移除过去的通过结果，并重新
打开由该条件关闭的待办。检查点首次通过才算新进度；新增待办、重复报告通过，
或修复已经计过进度的检查点，都不再获得新的进度计数。
`credited_predicates` 跨进程重启保存这份历史。读取缺少该可选字段的早期 v1 状态
时，原先通过的 id 会被视为已经计过进度；读取过程不会改写日志或历史执行记录。

全部验收通过优先于刚刚达到的轮次或空转上限。声明完整性、过期假设和使用者待决
事项仍然优先于完成判定。未完成的目标在达到配置上限时停止。运行失败也会消耗
一次尝试轮次；缺少执行方用量数据不意味着这次调用没有成本。

待办引用了合法的验收 id，并不证明工作在语义上相关。应当让验收检查和中间检查点
反映真正需要的结果；缺少可检查中间成果的大任务，可能需要更大的空转容忍值。
提示词哈希只标识明确生成的提示词，不代表 Codex 的完整会话历史、工具输入、工作区，
也不足以重放执行。

## 查看状态与使用者操作

`status` 和 `view` 显示最近记录的验收快照。对已完成的目标调用 `run`，会在不调用
模型的情况下重新检查。发现成果失效时，状态变为 `stopped`，原因为
`acceptance_regressed`；系统不会静默返回成功，也不会自动开始新的工作。
退出码 `0` 表示本次有限操作成功，目标仍可能处于运行中；`3` 表示停止；`1` 表示
用法或未捕获的运行错误。使用 `status` 区分运行中与已完成。

只有 `owner` 类型的验收条件可以通过
`accept --predicate ID --note TEXT` 接受，模型的完成声明不能代替该操作。
这是可信本地环境中的操作约定，不是在人类和具有同等文件系统权限的智能体之间
建立了身份认证隔离。

模型提出目标修订后，执行会停止。`amend --confirm` 接受修订，`amend --reject`
继续使用原目标。当前原型只更新目标描述，不更新验收定义；改变验收或预算需要
创建新目标。停止后的通用恢复尚未自动化：应先检查停止原因，再在修正声明或
运行环境后使用新目标。

## 验证与尚未证明的能力

```bash
npm test
npm run typecheck
npm run test:live -- --sandbox workspace-write
```

离线测试包括验收的正反例、重复计进度、预算边界、执行期间修改目标、重启后读取
状态、使用者待决事项、旧状态兼容和真实 CLI 行为。真实 smoke 会在可丢弃的合成
项目中消耗模型 token：它通过五个独立内核进程续跑一个 Codex 会话，验证外部修改
后的修复、最后一轮完成，以及拒绝过期的已完成结果。任务明确要求每轮只完成一个
检查点，用来测试续跑。

这个 smoke 不能证明数小时运行的可靠性，也不能证明模型质量得到改善。当前没有
并发隔离、跨日志与状态的事务、自动网络重试、通用恢复命令，也不能保证超时后
回收所有后代进程。token 计数仅用于观察；执行方统计的是累计值还是增量值，以及
实际成本，都尚未完成验证。具有工作区写入权限的智能体可以接触状态和验收文件。
系统没有沙箱隔离的独立裁判，也不保证消除语义偏移。

下一步应在匹配的真实任务和预算上，固定原生 Codex 与内核版本做对照，检查独立
最终验收、恢复能力、空转消耗、人工介入和不确定性。当前的机制检查不构成性能
提升或生产可用性的证明。
