/**
 * Offline self-check for dsh-token-summary/logic.js.
 * Run: node selftest.mjs
 */
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  buildNotice,
  buildPrompt,
  buildTranscript,
  clip,
  formatNumber,
  normalizeConfig,
  renderIndexEntry,
  renderMarkdown,
  tableCell,
  usageTokens,
} from './logic.js';

let checks = 0;
const ok = (label, fn) => {
  fn();
  checks += 1;
  console.log(`ok ${checks} - ${label}`);
};

ok('defaults survive an absent config', () => {
  const { config, warnings } = normalizeConfig(undefined);
  assert.equal(config.intervalTokens, DEFAULT_CONFIG.intervalTokens);
  assert.equal(config.enabled, true);
  assert.deepEqual(warnings, []);
});

ok('an unpaired route is ignored with a warning, a small interval is kept', () => {
  const { config, warnings } = normalizeConfig({ provider: 'dp', intervalTokens: 5 });
  assert.equal(config.provider, '');
  assert.equal(warnings.length, 1);
  // A small interval stays legal so the plugin can be exercised quickly.
  assert.equal(config.intervalTokens, 5);
  assert.equal(normalizeConfig({ intervalTokens: -5 }).config.intervalTokens, DEFAULT_CONFIG.intervalTokens);
  assert.equal(normalizeConfig({ intervalTokens: 1.5 }).config.intervalTokens, DEFAULT_CONFIG.intervalTokens);
});

ok('a paired route is kept', () => {
  const { config, warnings } = normalizeConfig({ provider: 'dp', model: 'deepseek-v4' });
  assert.equal(config.provider, 'dp');
  assert.equal(config.model, 'deepseek-v4');
  assert.deepEqual(warnings, []);
});

ok('usage counts new text only, never the cached prefix', () => {
  // A real provider sample: totalTokens is dominated by cache reads, so counting
  // it would inflate the counter roughly tenfold.
  assert.equal(
    usageTokens({ inputTokens: 2686, outputTokens: 210, totalTokens: 26192, cacheReadTokens: 23296 }),
    2896,
  );
  assert.equal(usageTokens({ inputTokens: 10, outputTokens: 5 }), 15);
  // totalTokens alone is not new text; without input/output there is nothing to count.
  assert.equal(usageTokens({ totalTokens: 99 }), 0);
  assert.equal(usageTokens(undefined), 0);
  assert.equal(usageTokens({ inputTokens: -3, outputTokens: 4 }), 4);
});

ok('cache buckets are excluded from the counter', () => {
  // Deliberate: the threshold measures NEW text. Replayed cache reads are the
  // same context being re-sent, so counting them makes a 500K threshold fire
  // after a handful of turns.
  assert.equal(usageTokens({ inputTokens: 10, outputTokens: 10, cacheReadTokens: 1000 }), 20);
  assert.equal(usageTokens({ inputTokens: 10, outputTokens: 10, cacheWriteTokens: 5 }), 20);
  assert.equal(usageTokens({ inputTokens: 10, outputTokens: 10, totalTokens: 999, cacheReadTokens: 1000 }), 20);
});

ok('table cells escape pipes and fold newlines', () => {
  assert.equal(tableCell('a|b'), 'a\\|b');
  assert.equal(tableCell('a\nb'), 'a b');
  assert.equal(tableCell('a\r\nb'), 'a b');
});

ok('the default output budget leaves room for a nine-section document', () => {
  // Reasoning models spend hidden reasoning tokens out of the SAME output budget.
  // Measured on a 176K-char real transcript: max_output_tokens=8192 produced a
  // 735-char reply with ZERO sections; 16384 produced all nine. The default must
  // stay above the point where a long transcript still yields a full document.
  assert.ok(DEFAULT_CONFIG.maxSummaryOutputTokens >= 16384,
    `default maxSummaryOutputTokens is ${DEFAULT_CONFIG.maxSummaryOutputTokens}, too small for a full handoff`);
});

ok('the notice distinguishes write failure from summary failure', () => {
  const base = { batch: 1, intervalTokens: 100, totalTokens: 100, fileName: 'x.md' };
  assert.match(buildNotice(base), /交接文档已更新/);
  assert.match(buildNotice({ ...base, failure: 'boom' }), /已更新.*统计兜底/);
  const wf = buildNotice({ ...base, failure: 'boom', writeFailed: true });
  assert.match(wf, /写入失败/);
  assert.doesNotMatch(wf, /已更新/, 'a write failure must never claim the document was updated');
});

ok('clip never splits a surrogate pair and strips controls', () => {
  assert.equal(clip('你好😀世界', 3), '你好…');
  assert.equal(clip('a\u0000b', 10), 'ab');
  assert.equal(clip('short', 10), 'short');
});

const events = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'user/message', data: { content: [{ type: 'text', text: '帮我写一个插件' }] } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好的，先看目录' }] }, usage: { totalTokens: 120 } } },
  { type: 'tool/call', data: { name: 'bash' } },
  { type: 'tool/result', data: { message: { content: [] }, error: { name: 'BashError' } } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '完成了' }] }, usage: { totalTokens: 80 } } },
];

ok('the transcript folds roles and counts tools', () => {
  const result = buildTranscript(events, { maxChars: 10_000 });
  assert.equal(result.userMessages, 1);
  assert.equal(result.assistantMessages, 2);
  assert.equal(result.toolCalls, 1);
  assert.equal(result.toolFailures, 1);
  assert.match(result.text, /### 用户/);
  assert.match(result.text, /工具调用：bash/);
  assert.ok(result.chars > 0);
});

ok('an undersized budget drops the oldest lines first', () => {
  const result = buildTranscript(events, { maxChars: 30 });
  assert.ok(result.dropped > 0);
  assert.ok(result.chars <= 30);
  assert.match(result.text, /完成了/);
  assert.doesNotMatch(result.text, /帮我写一个插件/);
});

ok('an oversized message is clipped, not dropped, so the transcript is never empty', () => {
  // A single message can exceed the whole budget. Dropping it produced an empty
  // transcript and a summary built on nothing at all.
  const big = { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'x'.repeat(9000) }] } } };
  const old = { type: 'user/message', data: { content: [{ type: 'text', text: 'OLDEST' }] } };
  for (const maxChars of [3000, 4000, 5000]) {
    const r = buildTranscript([old, big], { maxChars });
    assert.ok(r.text !== '', `maxChars=${maxChars} must not yield an empty transcript`);
    assert.ok(r.chars <= maxChars, `maxChars=${maxChars} must stay within budget, got ${r.chars}`);
    assert.ok(r.text.includes('x'), 'the newest line must survive');
  }
});

ok('the first prompt asks for a full handoff document', () => {
  const prompt = buildPrompt('会话文本');
  assert.match(prompt, /交接文档/);
  assert.match(prompt, /无缝继续工作/);
  // The structure a resuming agent needs must be spelled out.
  for (const section of ['任务全景', '当前状态', '已完成的工作', '关键决策与理由',
    '文件与路径清单', '命令、配置与数据', '遇到的问题与解决', '未完成事项与下一步', '风险与注意']) {
    assert.ok(prompt.includes(section), `prompt must ask for section: ${section}`);
  }
  assert.match(prompt, /# 会话记录/);
  assert.ok(prompt.includes('会话文本'));
  // It must not cap the length: a short summary is useless as a handoff.
  assert.doesNotMatch(prompt, /不超过\s*\d+\s*字/);
});

ok('a later prompt hands the model the previous document to merge into', () => {
  const prompt = buildPrompt('新增片段', '# 已有文档\n## 任务全景\n- 早先的目标');
  assert.match(prompt, /# 已有文档/);
  assert.ok(prompt.includes('早先的目标'));
  assert.match(prompt, /# 此后新增的对话/);
  assert.ok(prompt.includes('新增片段'));
  assert.match(prompt, /完整的合并后/);
  // Extending must never discard accumulated detail.
  assert.match(prompt, /只增不减/);
});

ok('markdown renders the stats table and the summary body', () => {
  const md = renderMarkdown({
    batch: 1,
    intervalTokens: 10_000_000,
    totalTokens: 10_000_000,
    startedAt: 0,
    finishedAt: Date.UTC(2026, 10, 4, 12, 0, 0),
    sessionId: 'session-abc',
    sessionTitle: '插件开发',
    cwd: '/root/work',
    route: { provider: 'dp', model: 'deepseek-v4' },
    stats: { userMessages: 2, assistantMessages: 3, toolCalls: 4, toolFailures: 1, chars: 100 },
    summaryText: '## 任务目标\n\n做一个插件。',
    transcriptChars: 100,
  });
  assert.match(md, /^# 工程交接文档 · 第 1 版/);
  assert.match(md, /\| 累计 token \| 10,000,000 \|/);
  assert.match(md, /dp \/ deepseek-v4/);
  assert.match(md, /## 任务目标/);
  assert.match(md, /dsh-token-summary/);
});

ok('markdown shows a failure banner instead of an empty body', () => {
  const md = renderMarkdown({
    batch: 2,
    intervalTokens: 10_000_000,
    totalTokens: 20_000_000,
    startedAt: 10_000_000,
    finishedAt: Date.UTC(2026, 10, 4, 12, 0, 0),
    sessionId: 'session-abc',
    stats: { userMessages: 0, assistantMessages: 0, toolCalls: 0, toolFailures: 0, chars: 0 },
    summaryText: '',
    failure: '模型返回错误',
    transcriptChars: 0,
  });
  assert.match(md, /摘要模型调用失败/);
  assert.match(md, /模型返回错误/);
});

ok('the notice stays within the durable bound', () => {
  const notice = buildNotice({
    batch: 3,
    intervalTokens: 10_000_000,
    totalTokens: 30_000_000,
    fileName: 'summary-0003-30000000-2026-11-04T12-00-00-000Z.md',
  });
  assert.ok([...notice].length <= 120);
  assert.match(notice, /第 3 版/);
  assert.match(notice, /30,000,000/);
});

ok('the index entry links the batch file', () => {
  const entry = renderIndexEntry({
    batch: 1,
    totalTokens: 10_000_000,
    fileName: 'summary-0001-10000000-x.md',
    sessionId: 'session-abc',
    finishedAt: Date.UTC(2026, 10, 4, 12, 0, 0),
  });
  assert.match(entry, /^- 2026-11-04 12:00:00/);
  assert.match(entry, /\(summary-0001-10000000-x\.md\)/);
});

ok('numbers group with thousands separators', () => {
  assert.equal(formatNumber(10_000_000), '10,000,000');
});

console.log(`\n${checks} checks passed`);