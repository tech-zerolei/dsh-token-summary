/**
 * 跨进程并发回归测试。
 *
 * e2e.mjs 里的并发用例在同一个进程内串行执行，天然避开了
 * 「读目录 → 写文件」之间的 TOCTOU 窗口，因此掩盖了真实的多进程竞态。
 * 本测试用 child_process 真正 spawn 多个独立 Node 进程，让它们在同一时刻
 * 抢同一个输出目录的批次号。
 *
 * 期望：每个进程都产出自己的文件，编号互不相同，无任何丢失。
 * 运行：node concurrency-check.mjs [进程数]
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORKERS = Number(process.argv[2] ?? 6);
const ROUNDS = 5;
const root = await mkdtemp(join(tmpdir(), 'conc-'));

/** 一个子进程：加载插件、触发一次跨阈值、退出。 */
const workerSource = `
import { apply } from ${JSON.stringify(new URL('./index.js', import.meta.url).href)};
const dir = process.argv[1];
let fired = false;
const ctx = {
  logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  on(_e, h) { this._h = h; return () => {}; },
  get(k) { return k === 'agents' ? { list: () => [{ id: 's', inject() {} }] } : undefined; },
  llm: { stream: () => (async function* () {
    await new Promise((r) => setTimeout(r, 5));
    yield { type: 'text-delta', index: 0, text: '摘要' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })() },
};
const session = {
  id: 's', header: { cwd: dir },
  ownEvents: () => [{ type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }] } }],
  requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
};
apply(ctx, { intervalTokens: 10, outputDir: dir, notifyInSession: false });
// 等待所有 worker 大致同时起跑，再触发
await new Promise((r) => setTimeout(r, Number(process.argv[2])));
ctx._h(session, { type: 'assistant/message', data: { usage: { totalTokens: 15 } } });
await new Promise((r) => setTimeout(r, 400));
process.exit(0);
`;

let totalLost = 0;
let totalDup = 0;

for (let round = 1; round <= ROUNDS; round += 1) {
  const dir = join(root, `round-${round}`);
  const startDelay = 300;   // 让所有子进程都完成启动后再同一时刻触发
  await Promise.all(
    Array.from({ length: WORKERS }, () =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', workerSource, dir, String(startDelay)], {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let err = '';
        child.stderr.on('data', (c) => { err += c; });
        child.on('error', reject);
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${err.slice(0, 300)}`))));
      }),
    ),
  );

  const files = (await readdir(dir).catch(() => [])).filter((f) => f.startsWith('summary-')).sort();
  const ordinals = files.map((f) => f.split('-')[1]);
  const unique = new Set(ordinals);
  const lost = WORKERS - files.length;
  const dup = ordinals.length - unique.size;
  totalLost += Math.max(0, lost);
  totalDup += Math.max(0, dup);
  const ok = lost === 0 && dup === 0;
  console.log(`  第 ${round} 轮: ${files.length}/${WORKERS} 文件, 唯一编号 ${unique.size}, 丢失 ${Math.max(0, lost)}, 重复 ${dup} ${ok ? '✅' : '❌'}`);
}

const leftovers = (await readdir(join(root, `round-${ROUNDS}`), { withFileTypes: false }).catch(() => []))
  .filter((f) => f.startsWith('.claim-'));

await rm(root, { recursive: true, force: true });

console.log(`\n总计: 丢失 ${totalLost}, 重复 ${totalDup}`);
if (leftovers.length > 0) console.log(`⚠️  残留占位文件 ${leftovers.length} 个`);
if (totalLost > 0 || totalDup > 0) {
  console.error('✗ 跨进程并发存在丢失或重号');
  process.exit(1);
}
console.log(`✓ ${ROUNDS} 轮 × ${WORKERS} 进程并发：无丢失、无重号`);