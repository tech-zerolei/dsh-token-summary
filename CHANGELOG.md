# Changelog

本项目所有值得记录的变更都会写在这里。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本 SemVer 2.0.0](https://semver.org/lang/zh-CN/)。

## [Unreleased]

<!-- 下一次发布前把内容归入新的版本小节 -->

## [1.1.0] - 2026-11-04

让较短的归档间隔真正可用。此前把 `intervalTokens` 调小（如 256K）会瞬间产出
大量近乎重复的垃圾文件：实测 54 份里后 5 份只有 74–296 字符。

### Added

- **增量归档**：每份只总结「自上次归档之后产生的事件」，不再重复总结全部历史。
  在此之前，阈值一调小，第 N 份就包含前 N-1 份的全部内容——在 256K 间隔下单次实测
  第 5 份有 **80% 与第 4 份重复**，归档价值几乎为零。
- **次级进程停摆**：一台机器可能同时跑两个 Harness 进程（`dsh-phone-remote` 会拉起
  一个带 `DSH_PHONE_AS_MINTER` 标记的 cookie minter），两者各自累计 token 会为每个
  批次写出**两份**归档。插件现在识别该标记并主动停摆，把归档留给主进程。
  标记列表可通过 `standDownEnv` 配置，适配其他双进程场景。
- `standby-check.mjs`：用真实子进程验证「次级停摆、主进程正常归档」。

### Changed

- **默认阈值 1000 万 → 200 万**。依据实际会话规模：本机真实转录为 8K–82K 字符
  （中位 25K），而 256K token 约等于 655K 字符，远超单次会话长度，实际永远够不到；
  200 万对应一次深度开发会话大致归档 1–2 次。

### Fixed

- **一次触发写 N 份重复文件**：跨 N 个边界时原先写 N 份内容相同的归档。
  现在合并为**一份**，文件内记录「跨越区间数」，通知也标明覆盖了几个区间。
- **游标推进过早**：增量游标曾在摘要调用前就推进，导致调用失败时那段对话被永久丢弃。
  现在**只在文件写成功后才提交游标**，失败时下次触发会重试该段内容。
- **空内容归档**：自上次归档后若无新对话，不再产出空壳文件，边界保留到下次触发。

## [1.0.3] - 2026-11-04

第二轮审计（独立代码审查）发现的 P1/P2 问题，全部已复现并修复。

### Fixed

- **【P1】批次会永久丢失**：`nextThreshold` 在写盘**之前**推进，因此
  `writeSummary` 内任何未被捕获的异常（转录读取、渲染、磁盘故障）都会把该边界
  静默吃掉——下一次跨阈值直接跳过它，除了日志里一行「批次生成失败」没有任何提示。
  实测：5 个边界全部丢失，之后直接跳到第 60 批。
  现在边界保持 pending，**写成功后才推进游标**，失败则在下一次触发时重试。

- **【P1】索引 read-modify-write 竞态**：批次文件已有 `wx` 原子保护，但索引
  `README.md` 仍是「读全文 → 写全文」。并发时后写者覆盖前者的条目；索引不存在时
  每个写者都以为自己是第一个，各自写头，结果头部丢失。实测 12 并发 → 只有 5 条记录
  且无头部。改为 **append-only**：头部用 `wx` 独占标记只写一次，条目用 `appendFile` 追加。

- **【P1】单次跨 N 个边界重复调用模型**：同一份转录被发送 N 次、产出 N 份几乎相同的
  摘要。现在「取料」（转录 + 模型调用）提升到循环外只做一次，循环内只做渲染与落盘。

- **【P1】转录预算断崖**：单条消息超过 `maxTranscriptChars` 时被**整行丢弃**，
  导致转录为空、摘要基于空输入生成。实测 `maxChars=4000` 且单条 9000 字符时保留 0 字符。
  现在超预算时**裁剪该行**而非丢弃，保证最新内容始终有代表。

- **【P2】"丢弃最旧"实际丢的是最新**：注释说从尾部向前压预算、丢弃更老的轮次，
  实现却是最新行先被跳过。修 P1 裁剪后此问题一并解决，注释也已更正。

- **【P2】批次号跨目录串联**：`batch` 曾作为所有输出目录的公共下界，导致全新的
  输出目录（默认为每个会话 cwd 一个）继承无关项目的编号，标题「第 N 批」错位。
  改为**按目录分桶计数**。

- **【P2】`max-tokens` 截断被当成成功**：`FinishReason` 的 `max-tokens` 表示输出被
  截断，但插件只识别 `error`/`aborted`，于是半句话被当作完整摘要归档。已用真实模型
  确认 provider 确实会返回半句可读文本（`status: incomplete`）。现在识别该原因，
  **保留已生成的正文**并加截断提示（丢弃正文反而浪费已付的调用）。

### Added

- e2e 新增两条回归：边界失败后必须重试（旧版会跳到 20、30 而丢掉 10）、
  多边界只调用一次模型（旧版跨 3 边界调 3 次）。
- selftest 新增转录裁剪用例（3000/4000/5000 预算下均非空且在预算内）。

### Changed

- `package.json` 的 `files` 补齐测试与文档（此前 `npm test` 对下载用户不可用），
  并排除 `demo.mjs`（含本机硬编码路径）。

- 仓库清理：移除了误提交的 `300/` 测试产物目录（该目录恰好是索引竞态的现场证据：
  30 个批次文件 vs 28 条索引记录、且头部缺失）。

## [1.0.2] - 2026-11-04

### Fixed

- **【P0】归档通知会永久损坏被归档的会话**：`agent.inject()` 传入的消息只有
  `content` 和 `source`，缺少 `id` 与 `role: 'user'`。`Session.append()` 只做部分
  结构校验，畸形消息被**静默接受**；但会话重新加载走
  `validateStoredEvents → adoptSessionEvent → assertMessageEventShape` 时会抛
  `SessionPersistenceCorruptionError: session event at seq N lacks an identified message`，
  该会话此后 resume / fork / replay 全部失败。

  触发条件是**默认配置**（`notifyInSession: true` + 每跨一个批次），即
  「第一次归档成功 = 当次会话报废」，与本插件「归档以免丢失」的目的完全相反。

  现在通知带完整 `id`（会话 id + 时间戳 + 单调序号，兼作收件箱去重键）与 `role`。

- **【P1】多进程批次号竞态导致归档被静默覆盖**：v1.0.1 改为扫描目录推导编号，
  但「读目录 → 写文件」之间仍是 TOCTOU 窗口，两个进程可以读到同一个最高编号，
  后写者覆盖先写者、归档文件丢失。现改为用 `open(path, 'wx')` 独占创建占位文件
  **原子地抢占编号**，失败则顺延下一个候选，写完释放占位。

  另修复：目录不存在时 `open(..., 'wx')` 抛 `ENOENT` 而非 `EEXIST`，
  曾被误判为"无法抢占"而降级到扫描结果，导致并发下仍会重号。

- **【P1】写入失败却报告"已写入"**：目标不可写时，通知与日志仍输出
  「第 N 批已写入 xxx.md」，而实际零文件产出。现在区分三种结局
  （成功 / 摘要失败但有文件 / 写入失败），写入失败记 error 日志且通知改说「写入失败」。

- **【P2】缓存 token 未计入**：`usageTokens` 在缺少 `totalTokens` 时只算
  `input + output`，漏掉 `cacheReadTokens` / `cacheWriteTokens`。现按 Harness
  官方 `dsh-token-meter` 口径改为 `input + cacheRead + cacheWrite + output`，
  避免缓存命中多的轮次被低估一个数量级。

- **【P2】Markdown 表格未转义**：会话标题、工作目录、模型 id 含 `|` 会撑出多余列，
  含换行可注入伪造表格行。新增 `tableCell()` 转义。

### Added

- `persist-check.mjs`：把插件真实产出的通知写进真实 `Session`，再用真实
  `validateStoredEvents` 校验，防止 P0 复发。
- `concurrency-check.mjs`：用 `child_process` **真正 spawn 多个独立进程**抢同一
  输出目录（既有的 e2e 并发用例是同进程串行，天然避开竞态，因此漏掉了 P1）。
  实测 v1.0.1 下 5 轮全部失败（丢失 2、重号 12），本版本 5 轮 × 6 进程全绿。

### Changed

- `npm test` 现在会跑全部四个套件：逻辑、端到端、持久化、跨进程并发。

## [1.0.1] - 2026-11-04

### Fixed

- **批次号在多进程下重复**：批次号原先只来自进程内计数器，同一台机器跑两个
  Harness 进程（或进程重启）时，每个实例都从 0 开始，导致同一输出目录出现两份
  `summary-0001-*`、索引出现两条「第 1 批」，无法区分先后。
  现在写入前扫描目标目录，取已有编号最大值 +1，使批次号成为归档的属性而非
  进程的属性；跨进程与重启后保持单调递增。编号在摘要完成后才申请，同一进程内
  的并发写入也不会抢到同一号。
- **e2e 测试时间戳偶合**：原实现用正则匹配共享目录里的批次文件，文件名中内嵌的
  ISO 时间戳（如 `13-28-20-318Z`）会误命中，导致断言随当前时间时通时不通。
  改为每个场景使用独立子目录。

### Added

- 回归测试：两个独立插件实例写同一目录时，第二个必须得到批次 2。
  已验证该用例在旧实现下失败、在新实现下通过。

### Changed

- 文档：补充 `outputDir` 的两种落盘策略（跟随会话工作目录 / 绝对路径集中存放），
  并说明切换 `outputDir` 不会搬动已有归档、索引中的路径是写入时快照。

## [1.0.0] - 2026-11-04

首个稳定版本。

### Added

- **全局 token 计数**：监听 `session/event`，仅统计 `assistant/message` 的 provider `usage`，
  这是唯一反映真实计费的记录；压缩、重放历史、工具结果都不会虚增计数。
- **阈值归档**：累计量跨过 `intervalTokens`（默认 10,000,000）时，自动对该会话生成一份摘要。
- **边界绝对锚定**：边界固定在 `intervalTokens` 的整数倍上（`0 → 9,999,999`、`10,000,000 → 19,999,999` …），
  单次调用跨过多个边界时为每个边界各生成一份报告，避免超调导致后续批次永久漂移。
- **模型生成摘要**：通过 `ctx.llm.stream()` 请求自然语言总结，输出包含
  任务目标 / 已完成 / 关键决策 / 未完成 / 风险 等小节。
- **Markdown 落盘**：写入 `summary-<批次>-<边界>-<时间戳>.md`，
  并在同目录维护 `README.md` 归档索引（时间、批次、累计 token、会话 ID、文件链接）。
- **转录预算**：`maxTranscriptChars`（默认 120,000 字符）限制送入模型的历史长度，
  超出时**从最早的对话开始丢弃**，保留最近的上下文。
- **会话通知**：归档完成后通过 `agent.inject()` 留一行通知，
  刻意不唤醒空闲 agent，因此不会凭空开启一个 turn。
- **失败兜底**：模型调用失败（无路由 / 上游错误 / 超时）时仍写出文件，
  正文降级为统计信息并附失败原因，保证批次记录不丢失。
- **并发安全**：多会话同时跨阈值时用 promise 队列串行化，避免同一批次互相覆盖。
- **配置项**：`intervalTokens`、`outputDir`、`provider`、`model`、
  `maxSummaryOutputTokens`、`maxTranscriptChars`、`timeoutMs`、`notifyInSession`、`enabled`。
- **零 Harness 依赖**：`index.js` 仅使用 Node 内置模块与自身 `logic.js`，
  Harness 服务经 `ctx` 按名获取，保证在 `link:` 安装与版本升级下均可工作。
- **测试**：`selftest.mjs`（13 项纯逻辑单测）与 `e2e.mjs`（桩上下文端到端测试）。
- **插件元数据**：`locale/zh.json`、`locale/en.json` 本地化标题与描述，原创 `icon.svg` 图标。

### Design notes

- 不向会话日志写入任何插件自有事件类型。DSH 只容忍带 `ignorable: true` 的未知事件，
  而运行时 `append()` 无法设置该标记，写入会导致会话无法重新打开。
  因此计数器保存在内存中，随进程重启归零。
- v1.0.0 不含 UI 面板：归档产物是文件，需求本体在文件上，面板收益低于维护成本。

[Unreleased]: https://github.com/tech-zerolei/dsh-token-summary/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/tech-zerolei/dsh-token-summary/compare/v1.0.3...v1.1.0
[1.0.3]: https://github.com/tech-zerolei/dsh-token-summary/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/tech-zerolei/dsh-token-summary/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/tech-zerolei/dsh-token-summary/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/tech-zerolei/dsh-token-summary/releases/tag/v1.0.0