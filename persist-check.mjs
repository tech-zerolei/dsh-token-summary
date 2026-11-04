/**
 * 回归测试：通知消息必须是可持久化的合法 UserMessage。
 *
 * 这是 P0 缺陷的守护测试。`Session.append()` 不校验 message 的 id/role，
 * 所以畸形通知当场"成功"，直到重新打开会话才炸——
 * `validateStoredEvents` → `assertMessageEventShape` 报
 * "lacks an identified message"，整个会话报废。
 *
 * 本测试直接调用插件的 notify 路径，把产出的消息过一遍真实的
 * Session 与持久化校验，确保归档不会毒化被归档的会话。
 *
 * 依赖 Harness 安装路径；找不到时跳过而不是假装通过。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from './index.js';

const DSH = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
let Session, SessionId, validateStoredEvents;
try {
  ({ Session, SessionId } = await import(`${DSH}/dsh-session/lib/index.js`));
  ({ validateStoredEvents } = await import(`${DSH}/dsh-session-persistence/lib/index.js`));
} catch {
  console.log('persist-check: 跳过（当前环境没有 Harness 安装）');
  process.exit(0);
}

const out = await mkdtemp(join(tmpdir(), 'persist-'));
const captured = [];

const ctx = {
  logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  on(_e, h) { this._h = h; return () => {}; },
  get(k) {
    if (k === 'agents') return { list: () => [{ id: 'sess-persist', inject: (m) => captured.push(m) }] };
    return undefined;
  },
  llm: { stream: () => (async function* () {
    yield { type: 'text-delta', index: 0, text: '摘要' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })() },
};

const session = {
  id: 'sess-persist',
  header: { cwd: out },
  ownEvents: () => [{ type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }] } }],
  requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
};

apply(ctx, { intervalTokens: 10, outputDir: out, notifyInSession: true });
ctx._h(session, { type: 'assistant/message', data: { usage: { totalTokens: 15 } } });
await new Promise((r) => setTimeout(r, 200));

if (captured.length === 0) {
  console.error('✗ 没有捕获到通知，无法校验');
  await rm(out, { recursive: true, force: true });
  process.exit(1);
}

// 把通知真实写进 Session，再走一遍重新打开的校验
const sid = SessionId('sess-persist');
const s = Session.create(sid);
s.append('user/message', { id: 'msg-1', role: 'user', content: [{ type: 'text', text: '真实用户消息' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
for (const notice of captured) s.append('user/message', notice, { surfaceOp: 'append' });

const events = structuredClone([...s.snapshotEvents()]);
try {
  validateStoredEvents({ id: sid }, events, 'persist-check');
  console.log(`✓ ${captured.length} 条通知全部可持久化，会话可重新打开`);
} catch (error) {
  console.error('✗ 通知毒化了会话：' + error.message);
  await rm(out, { recursive: true, force: true });
  process.exit(1);
}

await rm(out, { recursive: true, force: true });
