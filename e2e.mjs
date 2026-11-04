/**
 * End-to-end check of the installed plugin's apply() against a stub Host
 * context: no Harness process, no network, no model cost.
 *
 * Run: node e2e.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, inject, name } from './index.js';

const outdir = await mkdtemp(join(tmpdir(), 'token-summary-e2e-'));

/** A minimal Cordis-shaped context recording everything the plugin registers. */
function makeContext() {
  const listeners = new Map();
  const logs = [];
  const llmCalls = [];
  const logger = (tag) => ({
    info: (m) => logs.push(['info', m]),
    warn: (m) => logs.push(['warn', m]),
    error: (m) => logs.push(['error', m]),
    debug: (m) => logs.push(['debug', m]),
  });
  const ctx = {
    logger,
    on(event, handler) {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
      return () => {
        const current = listeners.get(event) ?? [];
        listeners.set(event, current.filter((h) => h !== handler));
      };
    },
    get(key) {
      if (key === 'agents') return { list: () => injectedAgents };
      if (key === 'sessionTitle') return { get: () => ({ title: '演示会话' }) };
      return undefined;
    },
    llm: {
      stream(options) {
        llmCalls.push(options);
        return (async function* () {
          // Yield the microtask queue first: a real model call is never
          // synchronous, and the concurrent-ordinal test needs the writers to
          // interleave the way they do in production.
          await new Promise((r) => setTimeout(r, 5));
          yield { type: 'text-delta', index: 0, text: '## 任务目标\n\n' };
          yield { type: 'text-delta', index: 0, text: '完成一个插件的交付。' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      },
    },
    /** Deliver one session event to every registered listener. */
    emit(event, session) {
      for (const handler of listeners.get('session/event') ?? []) handler(session, event);
    },
  };
  const injectedAgents = [];
  return { ctx, logs, llmCalls, injectedAgents, emit: ctx.emit };
}

/** A session stub exposing only what the plugin reads. */
function makeSession(id, cwd) {
  const events = [
    { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: '给我做一个 token 总结插件' }] } },
    { type: 'assistant/message', seq: 2, time: 2, data: { message: { content: [{ type: 'text', text: '先看现有插件结构。' }] }, usage: { inputTokens: 30, outputTokens: 10 } } },
    { type: 'tool/call', seq: 3, time: 3, data: { name: 'bash', arguments: '{}' } },
  ];
  return {
    id,
    header: { cwd },
    ownEvents: () => events,
    /**
     * Append a fresh exchange, the way a real conversation grows between two
     * threshold crossings. Archiving is incremental, so a crossing with no new
     * events correctly files nothing; tests that expect a second batch must add
     * content first.
     */
    appendTurn: (text) => {
      const seq = events.length + 1;
      events.push({ type: 'user/message', seq, time: seq, data: { content: [{ type: 'text', text }] } });
      events.push({ type: 'assistant/message', seq: seq + 1, time: seq + 1, data: { message: { content: [{ type: 'text', text: `回应：${text}` }] }, usage: { inputTokens: 8, outputTokens: 2 } } });
    },
    requestHeader: () => ({ config: { provider: 'dp', model: 'deepseek-v4.1-flash-1017' } }),
  };
}

const host = makeContext();
const session = makeSession('session-e2e', outdir);
const agent = { id: 'session-e2e', options: { provider: 'dp', model: 'deepseek-v4.1-flash-1017' }, inject: (msg) => host.injectedAgents.push(msg) };
host.injectedAgents.push(agent);

apply(host.ctx, { intervalTokens: 100, outputDir: outdir, maxTranscriptChars: 50_000, notifyInSession: true });

assert.equal(name, 'token-summary');
assert.deepEqual(inject, ['llm']);
assert.ok(host.logs.some(([, m]) => /每累计 .* 新增 token/.test(m)), "activation logs the batch size and destination");

// Below the threshold: nothing fires.
host.emit({ type: 'assistant/message', data: { usage: { inputTokens: 60, outputTokens: 0 } } }, session);
await new Promise((r) => setTimeout(r, 30));
assert.equal(host.injectedAgents.length, 1, 'no notice below the threshold');

// Crossing it: the model is asked once, a file appears, a notice is injected.
host.emit({ type: 'assistant/message', data: { usage: { inputTokens: 60, outputTokens: 0 } } }, session);
await new Promise((r) => setTimeout(r, 120));

assert.equal(host.llmCalls.length, 1, 'exactly one summary call');
const call = host.llmCalls[0];
assert.equal(call.provider, 'dp');
assert.equal(call.model, 'deepseek-v4.1-flash-1017');
assert.equal(call.sessionId, 'session-e2e');
assert.match(call.messages[0].content[0].text, /交接文档/);
assert.ok(call.messages[0].content[0].text.includes('给我做一个 token 总结插件'));
assert.equal(host.injectedAgents.length, 2, 'one notice injected');
const notice = host.injectedAgents[1];
assert.equal(notice.source.kind, 'token-summary');
assert.equal(notice.source.form, 'notice');
assert.ok([...notice.source.summary].length <= 120);
assert.match(notice.content[0].text, /第 1 版/);

const files = await readdir(outdir);
const batchFile = files.find((f) => /^handoff-.*?-0001-\d+-/.test(f));
assert.ok(batchFile, `batch file written, got ${files.join(', ')}`);
const markdown = await readFile(join(outdir, batchFile), 'utf8');
assert.match(markdown, /^# 工程交接文档 · 第 1 版/);
assert.match(markdown, /完成一个插件的交付。/);
assert.match(markdown, /演示会话/);
assert.match(markdown, /dp \/ deepseek-v4\.1-flash-1017/);

const index = await readFile(join(outdir, 'README.md'), 'utf8');
assert.match(index, /^# 工程交接文档索引/);
assert.match(index, /第 1 版/);
assert.ok(index.includes(batchFile), 'index links the batch file');

// A second crossing writes a second, separately named batch and appends to the index.
session.appendTurn('第二轮的进展：插件已能落盘。');
host.emit({ type: 'assistant/message', data: { usage: { inputTokens: 120, outputTokens: 0 } } }, session);
await new Promise((r) => setTimeout(r, 150));
const files2 = await readdir(outdir);
const batches = files2.filter((f) => f.startsWith('handoff-'));
assert.equal(batches.length, 2, `two batches, got ${batches.join(', ')}`);
assert.equal(host.llmCalls.length, 2);
const index2 = await readFile(join(outdir, 'README.md'), 'utf8');
assert.equal((index2.match(/# 工程交接文档索引/g) ?? []).length, 1, "the index header is written once");
assert.equal((index2.match(/第 [12] 版/g) ?? []).length, 2, 'both batches are indexed');

// A failing model call still produces a file, with a failure banner.
const failing = makeContext();
const session2 = makeSession('session-fail', outdir);
failing.injectedAgents.push({ id: 'session-fail', inject: (m) => failing.injectedAgents.push(m) });
failing.ctx.llm.stream = () => (async function* () {
  yield { type: 'finish', reason: { kind: 'error', failure: { message: '上游 502' } } };
})();
// Each scenario gets its own output directory: matching batch files by name
// would otherwise collide with the ISO timestamp embedded in the filename.
const failDir = join(outdir, 'fail');
apply(failing.ctx, { intervalTokens: 10, outputDir: failDir, notifyInSession: true });
failing.emit({ type: 'assistant/message', data: { usage: { inputTokens: 25, outputTokens: 0 } } }, session2);
await new Promise((r) => setTimeout(r, 150));
// 25 tokens cross both the 10 and the 20 boundary. One crossing files exactly
// ONE report spanning both, recording the span in its range and 跨越区间数.
const failFiles = (await readdir(failDir)).filter((f) => f.startsWith('handoff-'));
assert.equal(failFiles.length, 1, `one crossing, one report, got ${failFiles.join(', ')}`);
const failFile = failFiles[0];
const failMd = await readFile(join(failDir, failFile), 'utf8');
assert.match(failMd, /摘要模型调用失败/);
assert.match(failMd, /上游 502/);
assert.match(failing.injectedAgents.at(-1).content[0].text, /统计兜底/);

// A session with no routed call cannot be summarized, but the batch still files
// a report rather than silently dropping the crossing.
const unrouted = makeContext();
const session3 = makeSession('session-noroute', outdir);
session3.requestHeader = () => undefined;
unrouted.injectedAgents.push({ id: 'session-noroute', inject: (m) => unrouted.injectedAgents.push(m) });
const unroutedDir = join(outdir, 'unrouted');
apply(unrouted.ctx, { intervalTokens: 10, outputDir: unroutedDir });
unrouted.emit({ type: 'assistant/message', data: { usage: { inputTokens: 12, outputTokens: 0 } } }, session3);
await new Promise((r) => setTimeout(r, 120));
assert.equal(unrouted.llmCalls.length, 0, 'no model call without a route');
const unroutedFiles = (await readdir(unroutedDir)).filter((f) => f.startsWith('handoff-'));
assert.equal(unroutedFiles.length, 1, `one report, got ${unroutedFiles.join(', ')}`);
const unroutedReport = await readFile(join(unroutedDir, unroutedFiles[0]), 'utf8');
assert.match(unroutedReport, /无法确定摘要路由/);

// Regression: two independent plugin instances (two Host processes, or a
// restart) writing the same directory must not both file "第 1 批". The ordinal
// is derived from the archive, not from each process's private counter.
const sharedDir = join(outdir, 'shared');
const first = makeContext();
const firstSession = makeSession('session-shared', outdir);
first.injectedAgents.push({ id: 'session-shared', inject: () => {} });
apply(first.ctx, { intervalTokens: 10, outputDir: sharedDir, notifyInSession: false });
first.emit({ type: 'assistant/message', data: { usage: { inputTokens: 15, outputTokens: 0 } } }, firstSession);
await new Promise((r) => setTimeout(r, 120));

const second = makeContext();
// Same session id: this is the real dual-process case (two Hosts, one session).
const secondSession = makeSession('session-shared', outdir);
second.injectedAgents.push({ id: 'session-shared', inject: () => {} });
apply(second.ctx, { intervalTokens: 10, outputDir: sharedDir, notifyInSession: false });
second.emit({ type: 'assistant/message', data: { usage: { inputTokens: 15, outputTokens: 0 } } }, secondSession);
await new Promise((r) => setTimeout(r, 120));

const sharedFiles = (await readdir(sharedDir)).filter((f) => f.startsWith('handoff-')).sort();
assert.equal(sharedFiles.length, 2, `both instances filed, got ${sharedFiles.join(', ')}`);
assert.match(sharedFiles[0], /^handoff-.*?-0001-\d+-/, 'first file keeps ordinal 1');
assert.match(sharedFiles[1], /^handoff-.*?-0002-\d+-/, `second instance must not reuse ordinal 1, got ${sharedFiles[1]}`);

// Regression: archiving is INCREMENTAL. Each batch must summarize only the span
// produced since the previous batch. Re-summarizing the whole history made every
// file a near-copy of the last (at a 256K interval the fifth file was ~80%
// identical to the fourth).
const incDir = join(outdir, 'incremental');
const inc = makeContext();
inc.injectedAgents.push({ id: 'session-inc', inject: () => {} });
const incSession = makeSession('session-inc', outdir);
apply(inc.ctx, { intervalTokens: 10, outputDir: incDir, notifyInSession: false });
for (const [round, text] of [[1, '第一轮独有的内容'], [2, '第二轮独有的内容'], [3, '第三轮独有的内容']]) {
  incSession.appendTurn(text);
  inc.emit({ type: 'assistant/message', data: { usage: { inputTokens: 15, outputTokens: 0 } } }, incSession);
  await new Promise((r) => setTimeout(r, 150));
}
assert.equal(inc.llmCalls.length, 3, `three crossings, three model calls, got ${inc.llmCalls.length}`);
for (const [index, own] of ['第一轮独有的内容', '第二轮独有的内容', '第三轮独有的内容'].entries()) {
  const prompt = inc.llmCalls[index].messages[0].content[0].text;
  assert.ok(prompt.includes(own), `batch ${index + 1} must contain its own span`);
  // Only batch 1 sees the session's opening event; later batches must not repeat it.
  if (index > 0) {
    assert.ok(!prompt.includes('给我做一个 token 总结插件'), `batch ${index + 1} must not re-send the whole history`);
  }
}

// Regression: a boundary must survive a failure inside writeSummary. The old
// code advanced the threshold cursor before the write committed, so one throw
// silently consumed the boundary and the next crossing jumped past it.
const failDir2 = join(outdir, 'boundary-loss');
const lost = makeContext();
lost.injectedAgents.push({ id: 'session-lost', inject: () => {} });
const lostSession = makeSession('session-lost', outdir);
// Make the transcript read throw, which happens outside writeSummary's own try.
let calls = 0;
lostSession.ownEvents = () => {
  calls += 1;
  if (calls === 1) throw new Error('transcript read exploded');
  return [{ type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }] } }];
};
apply(lost.ctx, { intervalTokens: 10, outputDir: failDir2, notifyInSession: false });
lost.emit({ type: 'assistant/message', data: { usage: { inputTokens: 15, outputTokens: 0 } } }, lostSession); // boundary 10
await new Promise((r) => setTimeout(r, 150));
// The failure must not have burned boundary 10: the next crossing retries it.
// Both the span 0-9 (whose archive failed) and the events arriving in between
// are still unconsumed, so the retry covers everything up to boundary 30.
lost.emit({ type: 'assistant/message', data: { usage: { inputTokens: 15, outputTokens: 0 } } }, lostSession); // total 30
await new Promise((r) => setTimeout(r, 250));
const lossFiles = (await readdir(failDir2)).filter((f) => f.startsWith('handoff-')).sort();
assert.equal(lossFiles.length, 1, `the retry files one report, got ${lossFiles.join(', ')}`);
// It must cover all three pending boundaries, proving 10 was not skipped.
assert.match(lossFiles[0], /-30-/, `the retry must span up to boundary 30, got ${lossFiles[0]}`);
const retryMd = await readFile(join(failDir2, lossFiles[0]), 'utf8');
assert.match(retryMd, /\| 跨越区间数 \| 3 \|/, 'the retry records the three intervals it caught up on');
// The archived transcript is what was SENT to the model (the file holds the
// model's summary, not the raw conversation).
const retryPrompt = lost.llmCalls.at(-1).messages[0].content[0].text;
assert.match(retryPrompt, /hi/, 'the retry re-sends the unconsumed span to the model');

// Regression: a multi-boundary crossing summarizes once, not once per boundary.
const multiDir = join(outdir, 'multi');
const multi = makeContext();
multi.injectedAgents.push({ id: 'session-multi', inject: () => {} });
apply(multi.ctx, { intervalTokens: 10, outputDir: multiDir, notifyInSession: false });
multi.emit({ type: 'assistant/message', data: { usage: { inputTokens: 35, outputTokens: 0 } } }, makeSession('session-multi', outdir));
await new Promise((r) => setTimeout(r, 400));
const multiFiles = (await readdir(multiDir)).filter((f) => f.startsWith('handoff-'));
// 35 tokens cross the 10/20/30 boundaries at once: one file covering all three,
// and exactly one model call for the single transcript.
assert.equal(multiFiles.length, 1, `one crossing, one report, got ${multiFiles.join(', ')}`);
assert.equal(multi.llmCalls.length, 1, `one transcript means one model call, got ${multi.llmCalls.length}`);
const multiMd = await readFile(join(multiDir, multiFiles[0]), 'utf8');
assert.match(multiMd, /\| 跨越区间数 \| 3 \|/, 'the file records how many intervals it spans');

// Regression: sequential instances are not enough. Two instances that fire at
// the *same* instant race between reading the directory and writing the file
// (TOCTOU); before the atomic claim every loser silently overwrote a winner, so
// N concurrent crossings produced fewer than N files with duplicated ordinals.
const burstDir = join(outdir, 'burst');
const BURST = 8;
const burst = Array.from({ length: BURST }, () => makeContext());
for (const host of burst) {
  host.injectedAgents.push({ id: 'session-burst', inject: () => {} });
  apply(host.ctx, { intervalTokens: 10, outputDir: burstDir, notifyInSession: false });
}
const burstSession = makeSession('session-burst', outdir);
for (const host of burst) {
  host.emit({ type: 'assistant/message', data: { usage: { inputTokens: 15, outputTokens: 0 } } }, burstSession);
}
await new Promise((r) => setTimeout(r, 600));
const burstFiles = (await readdir(burstDir)).filter((f) => f.startsWith('handoff-')).sort();
assert.equal(burstFiles.length, BURST, `no batch may be lost, expected ${BURST}, got ${burstFiles.join(', ')}`);
// The ordinal is the 4-digit run, now that file names carry a session tag too.
const burstOrdinals = burstFiles.map((f) => /-(\d{4,})-\d+-[\dTZ:.-]+\.md$/.exec(f)[1]);
assert.equal(new Set(burstOrdinals).size, BURST, `ordinals must be unique, got ${burstOrdinals.join(', ')}`);
// No reservation placeholder may survive a completed write.
const leftovers = (await readdir(burstDir)).filter((f) => f.startsWith('.claim-'));
assert.deepEqual(leftovers, [], `claim placeholders must be released, got ${leftovers.join(', ')}`);

await rm(outdir, { recursive: true, force: true });
console.log('e2e: all checks passed');