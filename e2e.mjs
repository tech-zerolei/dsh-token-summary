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
    { type: 'assistant/message', seq: 2, time: 2, data: { message: { content: [{ type: 'text', text: '先看现有插件结构。' }] }, usage: { totalTokens: 40 } } },
    { type: 'tool/call', seq: 3, time: 3, data: { name: 'bash', arguments: '{}' } },
  ];
  return {
    id,
    header: { cwd },
    ownEvents: () => events,
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
assert.ok(host.logs.some(([, m]) => /全局累计/.test(m)), 'activation logs the batch size');

// Below the threshold: nothing fires.
host.emit({ type: 'assistant/message', data: { usage: { totalTokens: 60 } } }, session);
await new Promise((r) => setTimeout(r, 30));
assert.equal(host.injectedAgents.length, 1, 'no notice below the threshold');

// Crossing it: the model is asked once, a file appears, a notice is injected.
host.emit({ type: 'assistant/message', data: { usage: { totalTokens: 60 } } }, session);
await new Promise((r) => setTimeout(r, 120));

assert.equal(host.llmCalls.length, 1, 'exactly one summary call');
const call = host.llmCalls[0];
assert.equal(call.provider, 'dp');
assert.equal(call.model, 'deepseek-v4.1-flash-1017');
assert.equal(call.sessionId, 'session-e2e');
assert.match(call.messages[0].content[0].text, /会话归档员/);
assert.ok(call.messages[0].content[0].text.includes('给我做一个 token 总结插件'));
assert.equal(host.injectedAgents.length, 2, 'one notice injected');
const notice = host.injectedAgents[1];
assert.equal(notice.source.kind, 'token-summary');
assert.equal(notice.source.form, 'notice');
assert.ok([...notice.source.summary].length <= 120);
assert.match(notice.content[0].text, /第 1 批/);

const files = await readdir(outdir);
const batchFile = files.find((f) => f.startsWith('summary-0001-'));
assert.ok(batchFile, `batch file written, got ${files.join(', ')}`);
const markdown = await readFile(join(outdir, batchFile), 'utf8');
assert.match(markdown, /^# 会话总结 · 第 1 批/);
assert.match(markdown, /完成一个插件的交付。/);
assert.match(markdown, /演示会话/);
assert.match(markdown, /dp \/ deepseek-v4\.1-flash-1017/);

const index = await readFile(join(outdir, 'README.md'), 'utf8');
assert.match(index, /^# 会话总结索引/);
assert.match(index, /第 1 批/);
assert.ok(index.includes(batchFile), 'index links the batch file');

// A second crossing writes a second, separately named batch and appends to the index.
host.emit({ type: 'assistant/message', data: { usage: { totalTokens: 120 } } }, session);
await new Promise((r) => setTimeout(r, 150));
const files2 = await readdir(outdir);
const batches = files2.filter((f) => f.startsWith('summary-'));
assert.equal(batches.length, 2, `two batches, got ${batches.join(', ')}`);
assert.equal(host.llmCalls.length, 2);
const index2 = await readFile(join(outdir, 'README.md'), 'utf8');
assert.equal((index2.match(/# 会话总结索引/g) ?? []).length, 1, 'the index header is written once');
assert.equal((index2.match(/第 [12] 批/g) ?? []).length, 2, 'both batches are indexed');

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
failing.emit({ type: 'assistant/message', data: { usage: { totalTokens: 25 } } }, session2);
await new Promise((r) => setTimeout(r, 150));
// 25 tokens cross both the 10 and the 20 boundary, so one report is filed per
// boundary instead of a single shifted batch.
const failFiles = (await readdir(failDir)).filter((f) => f.startsWith('summary-'));
assert.equal(failFiles.length, 2, `one report per boundary, got ${failFiles.join(', ')}`);
const failFile = failFiles.find((f) => /^summary-\d{4}-10-/.test(f));
assert.ok(failFile, `the batch for the 10 boundary exists, got ${failFiles.join(', ')}`);
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
unrouted.emit({ type: 'assistant/message', data: { usage: { totalTokens: 12 } } }, session3);
await new Promise((r) => setTimeout(r, 120));
assert.equal(unrouted.llmCalls.length, 0, 'no model call without a route');
const unroutedFiles = (await readdir(unroutedDir)).filter((f) => f.startsWith('summary-'));
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
first.emit({ type: 'assistant/message', data: { usage: { totalTokens: 15 } } }, firstSession);
await new Promise((r) => setTimeout(r, 120));

const second = makeContext();
const secondSession = makeSession('session-shared', outdir);
second.injectedAgents.push({ id: 'session-shared', inject: () => {} });
apply(second.ctx, { intervalTokens: 10, outputDir: sharedDir, notifyInSession: false });
second.emit({ type: 'assistant/message', data: { usage: { totalTokens: 15 } } }, secondSession);
await new Promise((r) => setTimeout(r, 120));

const sharedFiles = (await readdir(sharedDir)).filter((f) => f.startsWith('summary-')).sort();
assert.equal(sharedFiles.length, 2, `both instances filed, got ${sharedFiles.join(', ')}`);
assert.match(sharedFiles[0], /^summary-0001-/, 'first file keeps batch 1');
assert.match(sharedFiles[1], /^summary-0002-/, `second instance must not reuse batch 1, got ${sharedFiles[1]}`);

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
  host.emit({ type: 'assistant/message', data: { usage: { totalTokens: 15 } } }, burstSession);
}
await new Promise((r) => setTimeout(r, 600));
const burstFiles = (await readdir(burstDir)).filter((f) => f.startsWith('summary-')).sort();
assert.equal(burstFiles.length, BURST, `no batch may be lost, expected ${BURST}, got ${burstFiles.join(', ')}`);
const burstOrdinals = burstFiles.map((f) => f.split('-')[1]);
assert.equal(new Set(burstOrdinals).size, BURST, `ordinals must be unique, got ${burstOrdinals.join(', ')}`);
// No reservation placeholder may survive a completed write.
const leftovers = (await readdir(burstDir)).filter((f) => f.startsWith('.claim-'));
assert.deepEqual(leftovers, [], `claim placeholders must be released, got ${leftovers.join(', ')}`);

await rm(outdir, { recursive: true, force: true });
console.log('e2e: all checks passed');