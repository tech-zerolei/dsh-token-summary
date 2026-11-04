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
apply(failing.ctx, { intervalTokens: 10, outputDir: outdir, notifyInSession: true });
failing.emit({ type: 'assistant/message', data: { usage: { totalTokens: 25 } } }, session2);
await new Promise((r) => setTimeout(r, 150));
// 25 tokens cross both the 10 and the 20 boundary, so one report is filed per
// boundary instead of a single shifted batch.
const failFiles = (await readdir(outdir)).filter((f) => /-10-|-20-/.test(f) && f.startsWith('summary-'));
assert.equal(failFiles.length, 2, `one report per boundary, got ${failFiles.join(', ')}`);
const failFile = failFiles.find((f) => f.includes('-10-'));
const failMd = await readFile(join(outdir, failFile), 'utf8');
assert.match(failMd, /摘要模型调用失败/);
assert.match(failMd, /上游 502/);
assert.match(failing.injectedAgents.at(-1).content[0].text, /统计兜底/);

// A session with no routed call cannot be summarized, but the batch still files
// a report rather than silently dropping the crossing.
const unrouted = makeContext();
const session3 = makeSession('session-noroute', outdir);
session3.requestHeader = () => undefined;
unrouted.injectedAgents.push({ id: 'session-noroute', inject: (m) => unrouted.injectedAgents.push(m) });
apply(unrouted.ctx, { intervalTokens: 10, outputDir: outdir });
unrouted.emit({ type: 'assistant/message', data: { usage: { totalTokens: 12 } } }, session3);
await new Promise((r) => setTimeout(r, 120));
assert.equal(unrouted.llmCalls.length, 0, 'no model call without a route');
const allFiles = await readdir(outdir);
let unroutedReport;
for (const candidate of allFiles.filter((f) => f.startsWith('summary-'))) {
  const body = await readFile(join(outdir, candidate), 'utf8');
  if (body.includes('session-noroute')) unroutedReport = body;
}
assert.ok(unroutedReport, 'an unroutable crossing still files its report');
assert.match(unroutedReport, /无法确定摘要路由/);

await rm(outdir, { recursive: true, force: true });
console.log('e2e: all checks passed');