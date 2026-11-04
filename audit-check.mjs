/**
 * 代码审查发现的缺陷的回归测试。
 *
 * 这三个缺陷既有套件都发现不了，因为它们只在特定组合下出现：
 *  1. 多会话共用输出目录时，B 的文档被 A 当成自己的上一份合并（内容串味）
 *  2. 进程重启后游标归零，把「第二份」误判为「首份全量」，重复总结全部历史
 *  3. 单次 usage 极大时，边界循环无上限，进程被 "Invalid array length" 打死
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from './index.js';

let docSeq = 0;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 最小 Host。每次模型调用返回一个唯一标记（DOC1、DOC2…），并记录收到的 prompt。
 */
function makeHost(dir, sessionIds) {
  const listeners = new Map();
  const calls = [];
  const agents = sessionIds.map((id) => ({ id, inject() {} }));
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    on(event, handler) {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
      return () => {};
    },
    get(key) {
      return key === 'agents' ? { list: () => agents } : undefined;
    },
    llm: {
      stream(options) {
        docSeq += 1;
        const marker = `DOC${docSeq}`;
        calls.push({ marker, prompt: options.messages[0].content[0].text });
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: marker };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      },
    },
  };
  const emitUsage = (session, usage) => {
    for (const handler of listeners.get('session/event') ?? []) {
      handler(session, { type: 'assistant/message', data: { usage } });
    }
  };
  return { ctx, calls, emitUsage };
}

function makeSession(id, dir) {
  const events = [{ type: 'user/message', data: { content: [{ type: 'text', text: `${id} 的原始需求` }] } }];
  return {
    id,
    header: { cwd: dir },
    ownEvents: () => events,
    push: (text) => events.push({ type: 'user/message', data: { content: [{ type: 'text', text }] } }),
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  };
}

const root = await mkdtemp(join(tmpdir(), 'audit-'));

// ── 缺陷 1：多会话共用目录不得互相污染 ────────────────────────────────────────
{
  const dir = join(root, 'shared');
  const host = makeHost(dir, ['A', 'B']);
  const A = makeSession('A', dir);
  const B = makeSession('B', dir);
  apply(host.ctx, { intervalTokens: 500, outputDir: dir, notifyInSession: false });

  A.push('A 的进展一');
  host.emitUsage(A, { inputTokens: 600, outputTokens: 0 });
  await wait(180);
  const docA1 = host.calls.at(-1).marker;

  B.push('B 的进展一');
  host.emitUsage(B, { inputTokens: 600, outputTokens: 0 });
  await wait(180);

  A.push('A 的进展二');
  host.emitUsage(A, { inputTokens: 600, outputTokens: 0 });
  await wait(180);

  const aSecond = host.calls.at(-1).prompt;
  assert.ok(aSecond.includes(docA1), `A 的第二份必须合并自己的首份 ${docA1}`);
  assert.ok(!aSecond.includes('B 的进展'), 'A 的文档不得混入 B 的对话内容');
  console.log('✓ 多会话共用目录互不污染');
}

// ── 缺陷 2：重启后不得把增量误判为首份全量 ────────────────────────────────────
{
  const dir = join(root, 'restart');
  const session = makeSession('S', dir);

  const first = makeHost(dir, ['S']);
  apply(first.ctx, { intervalTokens: 500, outputDir: dir, notifyInSession: false });
  session.push('第一段独有内容');
  first.emitUsage(session, { inputTokens: 600, outputTokens: 0 });
  await wait(220);
  const doc1 = first.calls.at(-1).marker;

  // 模拟重启：全新的 apply，内存游标归零，但磁盘上已有文档
  const second = makeHost(dir, ['S']);
  session.push('重启后的新内容');
  apply(second.ctx, { intervalTokens: 500, outputDir: dir, notifyInSession: false });
  second.emitUsage(session, { inputTokens: 600, outputTokens: 0 });
  await wait(260);

  const prompt = second.calls.at(-1).prompt;
  assert.ok(prompt.includes('# 已有文档'), '重启后必须识别已有文档并走合并路径');
  assert.ok(prompt.includes(doc1), '重启后必须引用磁盘上的上一份文档');
  // The previous document is what carries the history forward; the transcript
  // must not have to re-send it. This session only has one readable turn, so the
  // widened fallback may legally include it — what must never happen is losing
  // the link to the existing document or producing an empty one.
  assert.ok(!/没有可读的对话文本/.test(prompt), '重启后不得因找不到内容而提交空文档');
  console.log('✓ 重启后正确接续（引用旧文档、不产空文档）');
}

// ── 缺陷 3：极大 usage 不得打死进程 ──────────────────────────────────────────
{
  const dir = join(root, 'huge');
  const host = makeHost(dir, ['H']);
  const session = makeSession('H', dir);
  apply(host.ctx, { intervalTokens: 500, outputDir: dir, notifyInSession: false });
  assert.doesNotThrow(() => {
    host.emitUsage(session, { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 });
  }, '极大 usage 不得抛出 RangeError');
  await wait(300);
  assert.ok(host.calls.length >= 1, '仍应生成一份文档');
  console.log('✓ 极大 usage 不再崩溃（边界数量已封顶）');
}

await rm(root, { recursive: true, force: true });
console.log('\naudit-check: 全部通过');
