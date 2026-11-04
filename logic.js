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
  intervalTokens: 10_000_000,
  /** Absolute output directory; empty selects `<session cwd>/.dsh-summaries`. */
  outputDir: '',
  /** Provider route override; must be given together with `model`. */
  provider: '',
  /** Exact model id override; must be given together with `provider`. */
  model: '',
  /** Provider generation cap for the summary call. */
  maxSummaryOutputTokens: 2048,
  /** UTF-8 character ceiling for the replayed transcript handed to the model. */
  maxTranscriptChars: 120_000,
  /** End-to-end deadline for one summary request. */
  timeoutMs: 180_000,
  /** Whether to leave a durable notice in the session that crossed the batch. */
  notifyInSession: true,
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
  if (Number.isFinite(usage.totalTokens) && usage.totalTokens > 0) return Math.floor(usage.totalTokens);
  // No provider total: reconstruct it the way the Harness's own token meter does
  // (`pressureFrom` / the fold in dsh-token-meter):
  //   input + cacheRead + cacheWrite + output
  // Omitting the cache buckets would undercount a cache-heavy turn by an order
  // of magnitude, since cached input is billed too.
  const n = (value) => (Number.isFinite(value) && value > 0 ? value : 0);
  return Math.floor(
    n(usage.inputTokens) + n(usage.cacheReadTokens) + n(usage.cacheWriteTokens) + n(usage.outputTokens),
  );
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
  '你是一名会话归档员。请把下面这段 DeepSeek Harness 编程会话整理成一份 Markdown 总结。',
  '',
  '要求：',
  '- 只输出 Markdown 正文，不要代码围栏包裹整篇，不要任何前后寒暄。',
  '- 使用二级标题分节，建议包含：任务目标、已完成的工作、关键决策与原因、涉及的文件与路径、未完成与后续步骤、风险与注意事项。',
  '- 忠实于对话内容；不确定的信息标注「未提及」，不要猜测或虚构文件名、命令、数字。',
  '- 保留仍然有效的具体事实：路径、命令、版本号、配置值、错误信息。',
  '- 简洁克制：不超过 800 字，条目化表达优先于长段落。',
].join('\n');

/**
 * Frame the summarizer request input.
 * @param transcript - folded conversation text.
 * @returns the final user-message text.
 */
export function buildPrompt(transcript) {
  return `${SUMMARY_INSTRUCTION}\n\n---\n\n# 会话记录\n\n${transcript}\n`;
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
  } = input;
  const rows = [
    ['生成时间', new Date(finishedAt).toISOString()],
    ['会话 ID', `\`${sessionId}\``],
    ['会话标题', sessionTitle === undefined || sessionTitle === '' ? '（未命名）' : sessionTitle],
    ['工作目录', cwd === undefined || cwd === '' ? '（无）' : `\`${cwd}\``],
    ['本批序号', `第 ${batch} 批`],
    ['本批区间', `${formatNumber(startedAt)} → ${formatNumber(totalTokens - 1)} token`],
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
    `# 会话总结 · 第 ${batch} 批（每 ${formatNumber(intervalTokens)} token 一次）`,
    '',
    table,
    '',
    '## 摘要',
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
  return `- ${stamp} · 第 ${input.batch} 批 · 累计 ${formatNumber(input.totalTokens)} token · [${input.fileName}](${encodeURI(input.fileName)}) · \`${input.sessionId}\``;
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
    head = `每 ${formatNumber(input.intervalTokens)} token 归档：第 ${input.batch} 批写入失败`;
    tail = '（未生成文件，详见日志）';
  } else if (input.failure === undefined) {
    head = `每 ${formatNumber(input.intervalTokens)} token 归档：第 ${input.batch} 批总结已写入 ${input.fileName}`;
    tail = `（累计 ${formatNumber(input.totalTokens)} token）`;
  } else {
    head = `每 ${formatNumber(input.intervalTokens)} token 归档：第 ${input.batch} 批已写入 ${input.fileName}`;
    tail = '（摘要模型调用失败，文件内为统计兜底）';
  }
  const text = `${head}${tail}`;
  const points = [...text];
  return points.length <= 120 ? text : `${points.slice(0, 119).join('')}…`;
}