/**
 * Pure helpers for dsh-token-summary: config normalization, usage accounting,
 * transcript shaping, prompt framing, and Markdown rendering.
 *
 * No Harness imports — everything here is plain data in, plain data out, so the
 * module can be unit-tested and exercised outside a live Host.
 *
 * @module dsh-token-summary/logic
 */

/** Default runtime configuration. Every field is optional in `cordis.patch.yml`. */
export const DEFAULT_CONFIG = Object.freeze({
  /** Token budget of one summary batch. Crossing it produces one Markdown file. */
  intervalTokens: 500_000,
  /** Absolute output directory; empty selects `<session cwd>/.dsh-summaries`. */
  outputDir: '',
  /** Provider route override; must be given together with `model`. */
  provider: '',
  /** Exact model id override; must be given together with `provider`. */
  model: '',
  /** Provider generation cap for the summary call. */
  maxSummaryOutputTokens: 8192,
  /** UTF-8 character ceiling for the replayed transcript handed to the model. */
  maxTranscriptChars: 400_000,
  /** End-to-end deadline for one summary request. */
  timeoutMs: 180_000,
  /** Whether to leave a durable notice in the session that crossed the batch. */
  notifyInSession: true,
  /**
   * Reasoning effort for the handoff call. Writing a document is transcription,
   * not problem solving: on reasoning models the hidden reasoning tokens share
   * the output budget with the document, so a high effort truncates it. Low
   * effort keeps the budget for the text. Empty string uses the model default.
   */
  reasoningEffort: 'low',
  /**
   * Comma-separated env vars that mark this Host as a secondary Harness process.
   * When any is set the plugin stands down, because another process is already
   * counting and archiving the same conversations.
   */
  standDownEnv: 'DSH_PHONE_AS_MINTER',
  /** Master switch. */
  enabled: true,
});

/** A positive safe integer, or the fallback. */
function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * Normalize an untrusted Loader config block.
 * @param config - the row's `config`, possibly absent or partially populated.
 * @returns a complete, validated configuration, plus collected warnings.
 */
export function normalizeConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {};
  const warnings = [];
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : '';
  const model = typeof raw.model === 'string' ? raw.model.trim() : '';
  if ((provider === '') !== (model === '')) {
    warnings.push('provider/model must be set together; both ignored, falling back to the session route');
  }
  const route = provider === '' || model === '' ? { provider: '', model: '' } : { provider, model };
  return {
    config: {
      intervalTokens: positiveInteger(raw.intervalTokens, DEFAULT_CONFIG.intervalTokens),
      outputDir: typeof raw.outputDir === 'string' ? raw.outputDir.trim() : DEFAULT_CONFIG.outputDir,
      provider: route.provider,
      model: route.model,
      maxSummaryOutputTokens: positiveInteger(raw.maxSummaryOutputTokens, DEFAULT_CONFIG.maxSummaryOutputTokens),
      maxTranscriptChars: positiveInteger(raw.maxTranscriptChars, DEFAULT_CONFIG.maxTranscriptChars),
      timeoutMs: positiveInteger(raw.timeoutMs, DEFAULT_CONFIG.timeoutMs),
      reasoningEffort: typeof raw.reasoningEffort === 'string' ? raw.reasoningEffort.trim() : DEFAULT_CONFIG.reasoningEffort,
      standDownEnv: typeof raw.standDownEnv === 'string' ? raw.standDownEnv.trim() : DEFAULT_CONFIG.standDownEnv,
      notifyInSession: raw.notifyInSession !== false,
      enabled: raw.enabled !== false,
    },
    warnings,
  };
}

/**
 * Read one model-call usage record as the tokens it billed.
 * @param usage - a `TokenUsage` value from an `assistant/message` event.
 * @returns the counted tokens; `0` when nothing usable was reported.
 */
export function usageTokens(usage) {
  if (usage === null || typeof usage !== 'object') return 0;
  // Count NEW text the model actually processed, not the replayed context.
  //
  // Providers report cached prefix reads separately, and they usually dominate a
  // long conversation (`totalTokens` can be 26,192 where 23,296 of it is cache
  // reads and the genuinely new text is only 2,896). Measuring `totalTokens`
  // therefore inflates the counter by an order of magnitude and makes a
  // "500K token" threshold fire after a handful of turns.
  //
  // So: input + output only. Cache reads/writes are deliberately excluded.
  const n = (value) => (Number.isFinite(value) && value > 0 ? value : 0);
  return Math.floor(n(usage.inputTokens) + n(usage.outputTokens));
}

/**
 * Extract the text of one content-block list, ignoring non-text blocks.
 * @param content - model-facing blocks.
 * @returns concatenated text, trimmed.
 */
export function textOf(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'tool-call') parts.push(`〔调用工具 ${String(block.name ?? 'unknown')}〕`);
  }
  return parts.join('\n').trim();
}

/** A terminal control and directional-control scrubber for durable text. */
const UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Clip untrusted text to a character budget without splitting a code point.
 * @param text - source text.
 * @param limit - maximum characters.
 * @returns the clipped text.
 */
export function clip(text, limit) {
  const clean = String(text).replace(UNSAFE, '');
  const points = [...clean];
  if (points.length <= limit) return clean;
  return `${points.slice(0, Math.max(0, limit - 1)).join('')}…`;
}

/**
 * Fold one session log into a transcript the summarizer can read.
 *
 * The most recent part of the conversation is what a summary needs, so the
 * budget is spent from the tail backwards: older turns are dropped first.
 *
 * @param events - the session's events in `seq` order.
 * @param limits - character budget and per-message clip.
 * @returns transcript text, plus counters describing what was folded.
 */
export function buildTranscript(events, limits) {
  const maxChars = positiveInteger(limits?.maxChars, DEFAULT_CONFIG.maxTranscriptChars);
  const perMessage = positiveInteger(limits?.perMessageChars, 4_000);
  const candidates = [];
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let toolFailures = 0;

  for (const event of events) {
    let line;
    switch (event.type) {
      case 'user/message': {
        const text = textOf(event.data.content);
        if (text === '') break;
        userMessages += 1;
        line = `\n### 用户\n${clip(text, perMessage)}\n`;
        break;
      }
      case 'assistant/message': {
        const text = textOf(event.data.message.content);
        if (text === '') break;
        assistantMessages += 1;
        line = `\n### 助手\n${clip(text, perMessage)}\n`;
        break;
      }
      case 'tool/call': {
        toolCalls += 1;
        line = `\n（工具调用：${clip(String(event.data.name), 120)}）\n`;
        break;
      }
      case 'tool/result': {
        if (event.data.error === undefined) break;
        toolFailures += 1;
        line = `\n（工具失败：${clip(String(event.data.error.name), 120)}）\n`;
        break;
      }
      default:
        line = undefined;
    }
    if (line !== undefined) candidates.push(line);
  }

  // Spend the budget from the most recent line backwards: a summary of a long
  // span is about where the work ended up, so older turns are dropped first and
  // the newest content survives.
  const kept = [];
  let used = 0;
  let dropped = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const line = candidates[index];
    if (used + line.length <= maxChars) {
      used += line.length;
      kept.push(line);
      continue;
    }
    // Over budget. Dropping the whole line is what made a small
    // `maxTranscriptChars` produce an *empty* transcript (the newest message is
    // often the only one that matters, and a single message can exceed the whole
    // budget). Clip it to the remaining room instead, so the newest content is
    // always represented; only genuinely older lines are dropped whole.
    const room = maxChars - used;
    if (kept.length === 0 && room > 1) {
      const points = [...line];
      const clipped = `${points.slice(0, room - 1).join('')}…`;
      used += clipped.length;
      kept.push(clipped);
    }
    dropped += 1;
  }
  kept.reverse();

  return {
    text: kept.join('').trim(),
    chars: used,
    dropped,
    userMessages,
    assistantMessages,
    toolCalls,
    toolFailures,
  };
}

/** The instruction handed to the summarizer model. */
export const SUMMARY_INSTRUCTION = [
  '你是一名资深工程交接文档撰写者。请把下面这段 DeepSeek Harness 编程会话，整理成一份**可以直接交给另一个 AI 编程助手接着干**的详细交接文档。',
  '',
  '读者是一个没有任何上下文的新 Agent。它读完这份文档后，必须能够无缝继续工作，不需要回头翻原始对话。',
  '',
  '## 输出结构（严格按此顺序，每节都要有；无内容写「（无）」）',
  '',
  '### 1. 任务全景',
  '- 用户最初的目标，以及目标随对话如何演变（逐条，保留用户的原始措辞要点）。',
  '',
  '### 2. 当前状态',
  '- 现在进行到哪一步；哪些已完成、哪些进行中、哪些待开始。',
  '',
  '### 3. 已完成的工作（逐项）',
  '- 每一项：做了什么、改了哪个文件、为什么这么做。',
  '- 涉及具体代码时，给出关键片段（函数签名、配置片段、命令），不要只写「修改了某文件」。',
  '',
  '### 4. 关键决策与理由',
  '- 每个决策：选了什么、放弃了什么备选、为什么。',
  '- 特别记录用户明确表达过的偏好、纠正和否决。',
  '',
  '### 5. 文件与路径清单',
  '- 精确路径 + 该文件的作用 + 当前状态（新建/修改/待改）。',
  '',
  '### 6. 命令、配置与数据',
  '- 执行过的关键命令、写入的配置值、版本号、端口、环境变量。',
  '- 精确到可以直接复制粘贴。',
  '',
  '### 7. 遇到的问题与解决',
  '- 报错原文（保留完整错误串）、根因、解决办法、是否已验证。',
  '',
  '### 8. 未完成事项与下一步',
  '- 明确列出还没做完的事；',
  '- 给出**下一个具体动作**（不是泛泛的「继续开发」）。',
  '',
  '### 9. 风险与注意',
  '- 已知的坑、脆弱点、未验证的假设、需要小心的地方。',
  '',
  '## 写作要求',
  '- 详细优先：宁可长，不要漏。目标 1500–4000 字，信息密度高。',
  '- 保留所有精确事实：文件路径、命令、错误串、标识符、数字、函数签名。',
  '- 不确定的信息写「未提及」，**绝不虚构**文件名、命令或数字。',
  '- 用条目而非大段散文；每条自成一体，可单独理解。',
  '- 只输出 Markdown 正文，不要代码围栏包裹整篇，不要前言或结语。',
  '- 不要说「本次会话」「在上面的对话中」这类指代——文档要能脱离原对话独立阅读。',
].join('\n');

/** Instruction used when extending an existing handoff document with new material. */
export const EXTEND_INSTRUCTION = [
  '你正在维护一份**工程交接文档**。下面会给你「已有文档」和「此后新增的对话」。',
  '',
  '你的任务：把新增内容合并进已有文档，输出**完整的、合并后的新文档**（不是补丁，是全文）。',
  '',
  '## 合并规则',
  '- 保留已有文档中**所有仍然成立**的事实、决策、路径、命令、错误串。',
  '- 新增内容按其性质并入对应小节（新完成的工作并入「已完成」、新决策并入「关键决策」等）。',
  '- 已过时或被推翻的内容：不要直接删，改为在原文后标注「（已被后续推翻：原因）」。',
  '- 「当前状态」「未完成事项与下一步」这两节**以最新进展为准重写**，因为它们描述的是现在。',
  '- 不要在文档里写「新增」「本次更新」之类的字样，最终文档要像一次写成的那样连贯。',
  '',
  '## 输出要求',
  '- 输出完整的合并后文档，保持与已有文档相同的结构与小节顺序。',
  // The model will happily "summarize" a merge down to a stub unless told
  // explicitly that shrinking is a failure. Observed: a correct merge of a
  // 300-char document came back as 499 chars, dropping whole sections.
  '- **只增不减**：输出必须不短于「已有文档」。如果你发现写出来比原文短，说明漏了内容，必须补回去。',
  '- 逐节检查：已有文档的每一个小节都必须在输出里出现，且该节原有的事实、路径、命令、数字一条都不能少。',
  '- 宁可重复也不要遗漏；宁可变长也不要压缩。',
  '- 精确保留文件路径、命令、错误串、标识符、数字。',
  '- 只输出 Markdown 正文，不要前言、结语或代码围栏包裹整篇。',
].join('\n');

/**
 * Frame the summarizer request input.
 *
 * With no previous document this asks for a complete handoff document; with one
 * it asks for the merged, longer document, which is what makes the archive a
 * growing handoff artifact rather than a pile of disjoint slices.
 *
 * @param transcript - folded conversation text for this span.
 * @param previousDocument - the previous handoff document, when extending it.
 * @returns the final user-message text.
 */
export function buildPrompt(transcript, previousDocument) {
  // First handoff: write the whole document from the conversation.
  if (previousDocument === undefined || previousDocument.trim() === '') {
    return `${SUMMARY_INSTRUCTION}\n\n---\n\n# 会话记录\n\n${transcript}\n`;
  }
  // Later handoffs: merge the new span into the document that already exists, so
  // the deliverable keeps growing instead of being replaced by a fresh stub.
  return [
    EXTEND_INSTRUCTION,
    '',
    '---',
    '',
    '# 已有文档',
    '',
    previousDocument.trim(),
    '',
    '---',
    '',
    '# 此后新增的对话',
    '',
    transcript,
    '',
  ].join('\n');
}

/** Render an integer with thousands separators. */
export function formatNumber(value) {
  return Number(value).toLocaleString('en-US');
}

/**
 * Render one value safe for a Markdown table cell.
 *
 * A raw `|` would be read as a column separator and a newline would end the row,
 * so session titles, working directories, and model ids — all caller-controlled
 * text — must be escaped rather than trusted.
 *
 * @param value - cell text.
 * @returns the escaped single-line cell text.
 */
export function tableCell(value) {
  return String(value).replace(/\r\n|\r|\n/g, ' ').replace(/\|/g, '\\|');
}

/**
 * Render the human-facing Markdown document for one completed batch.
 * @param input - batch facts, transcript statistics, and the summary body.
 * @returns the Markdown file body.
 */
export function renderMarkdown(input) {
  const {
    batch,
    intervalTokens,
    totalTokens,
    startedAt,
    finishedAt,
    sessionId,
    sessionTitle,
    cwd,
    route,
    stats,
    summaryText,
    failure,
    truncated,
    transcriptChars,
    spanned,
    coveredEvents,
  } = input;
  const rows = [
    ['生成时间', new Date(finishedAt).toISOString()],
    ['会话 ID', `\`${sessionId}\``],
    ['会话标题', sessionTitle === undefined || sessionTitle === '' ? '（未命名）' : sessionTitle],
    ['工作目录', cwd === undefined || cwd === '' ? '（无）' : `\`${cwd}\``],
    ['本批序号', `第 ${batch} 批`],
    ['本批区间', `${formatNumber(startedAt)} → ${formatNumber(totalTokens - 1)} token`],
    ['跨越区间数', String(spanned ?? 1)],
    // Recorded so a restarted process resumes exactly where this one stopped:
    // the in-memory cursor is lost on restart, and guessing produced empty
    // documents that repeated forever.
    ['已覆盖事件数', String(coveredEvents ?? 0)],
    ['批大小', `${formatNumber(intervalTokens)} token`],
    ['累计 token', formatNumber(totalTokens)],
    ['摘要模型', route === undefined ? '（未解析）' : `${route.provider} / ${route.model}`],
    ['用户消息', String(stats.userMessages)],
    ['助手消息', String(stats.assistantMessages)],
    ['工具调用', String(stats.toolCalls)],
    ['工具失败', String(stats.toolFailures)],
    ['摘要输入字符', formatNumber(transcriptChars)],
  ];
  const table = ['| 项目 | 值 |', '| --- | --- |', ...rows.map(([k, v]) => `| ${tableCell(k)} | ${tableCell(v)} |`)].join('\n');
  const body = truncated === true && summaryText.trim() !== ''
    // Truncated but usable: keep the text, and say plainly that it is partial so
    // nobody mistakes a cut-off summary for a complete one.
    ? `${summaryText.trim()}\n\n> ⚠️ 该摘要因输出达到 maxSummaryOutputTokens 上限而被截断，内容不完整。`
    : failure === undefined
    ? summaryText.trim()
    : [
      '> ⚠️ 摘要模型调用失败，以下为统计兜底。原始记录仍在会话日志中，可重新生成。',
      '',
      '```text',
      clip(failure, 800),
      '```',
    ].join('\n');
  return [
    `# 工程交接文档 · 第 ${batch} 版（每累计 ${formatNumber(intervalTokens)} token 更新）`,
    '',
    table,
    '',
    '## 交接正文',
    '',
    body,
    '',
    '---',
    '',
    `由 \`dsh-token-summary\` 自动生成 · 生成时间 ${new Date(finishedAt).toLocaleString('sv-SE')}`,
    '',
  ].join('\n');
}

/**
 * Render one line of the rolling index file.
 * @param input - batch identity and output location.
 * @returns a Markdown list item.
 */
export function renderIndexEntry(input) {
  const stamp = new Date(input.finishedAt).toISOString().replace('T', ' ').slice(0, 19);
  return `- ${stamp} · 第 ${input.batch} 版 · 累计 ${formatNumber(input.totalTokens)} token · [${input.fileName}](${encodeURI(input.fileName)}) · \`${input.sessionId}\``;
}

/**
 * Build the one-line durable notice a summary leaves in its session.
 * @param input - batch identity, token totals, and output file name.
 * @returns a bounded single-line notice.
 */
export function buildNotice(input) {
  // Three distinct outcomes, three distinct messages. Collapsing them into one
  // sentence is how a failed write ends up reported as "已写入".
  let head;
  let tail;
  if (input.writeFailed) {
    head = `每 ${formatNumber(input.intervalTokens)} token 更新交接文档：第 ${input.batch} 版写入失败`;
    tail = '（未生成文件，详见日志）';
  } else if (input.failure === undefined) {
    // `spanned` > 1 means one crossing covered several intervals at once; say so
    // instead of pretending the batch was a single interval.
    const span = input.spanned !== undefined && input.spanned > 1 ? `，覆盖 ${input.spanned} 个区间` : '';
    head = `交接文档已更新（第 ${input.batch} 版）：${input.fileName}`;
    tail = `（累计 ${formatNumber(input.totalTokens)} token${span}）`;
  } else {
    const span = input.spanned !== undefined && input.spanned > 1 ? `，覆盖 ${input.spanned} 个区间` : '';
    head = `交接文档已更新（第 ${input.batch} 版）：${input.fileName}`;
    tail = `（摘要模型调用失败，文件内为统计兜底${span}）`;
  }
  const text = `${head}${tail}`;
  const points = [...text];
  return points.length <= 120 ? text : `${points.slice(0, 119).join('')}…`;
}