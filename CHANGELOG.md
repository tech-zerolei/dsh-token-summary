# Changelog

本项目所有值得记录的变更都会写在这里。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本 SemVer 2.0.0](https://semver.org/lang/zh-CN/)。

## [Unreleased]

<!-- 下一次发布前把内容归入新的版本小节 -->

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

[Unreleased]: https://github.com/tech-zerolei/dsh-token-summary/compare/v1.0.2...HEAD
[1.0.2]: https://github.com/tech-zerolei/dsh-token-summary/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/tech-zerolei/dsh-token-summary/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/tech-zerolei/dsh-token-summary/releases/tag/v1.0.0