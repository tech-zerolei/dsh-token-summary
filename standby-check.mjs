/**
 * 次级进程守护测试。
 *
 * 一台机器可能同时跑两个 Harness 进程（例如 dsh-phone-remote 拉起的 minter），
 * 两者都会加载本插件并各自累计 token，于是每个批次被归档两次。
 * 插件必须在被标记为次级进程时主动停摆。
 *
 * 本测试用子进程设置标记变量后加载插件，断言它不产生任何归档。
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MARKER = 'DSH_PHONE_AS_MINTER';
const root = await mkdtemp(join(tmpdir(), 'standby-'));

const worker = `
import { apply } from ${JSON.stringify(new URL('./index.js', import.meta.url).href)};
const dir = process.argv[1];
let fired = false;
const listeners = new Map();
const ctx = {
  logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  on(e, h) { const l = listeners.get(e) ?? []; l.push(h); listeners.set(e, l); return () => {}; },
  get(k) { return k === 'agents' ? { list: () => [{ id: 's', inject() {} }] } : undefined; },
  llm: { stream: () => (async function* () {
    fired = true;
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
for (const h of listeners.get('session/event') ?? []) {
  h(session, { type: 'assistant/message', data: { usage: { totalTokens: 15 } } });
}
await new Promise((r) => setTimeout(r, 300));
// Report the observation, let the parent decide what it means.
process.exit(fired ? 1 : 0);
`;

const run = (label, env) =>
  new Promise((resolve, reject) => {
    const dir = join(root, label);
    const child = spawn(process.execPath, ['--input-type=module', '-e', worker, dir], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, ...env },
    });
    let err = '';
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, dir, err }));
  });

// 1) 次级进程：必须完全不归档，也不能调用模型
const sec = await run('secondary', { [MARKER]: '1' });
const secFiles = (await readdir(sec.dir).catch(() => [])).filter((f) => f.startsWith('summary-'));
if (sec.code === 1) throw new Error('secondary process called the model; it must stand down');
if (secFiles.length !== 0) throw new Error(`secondary process filed archives: ${secFiles.join(', ')}`);

// 2) 主进程：不带标记时必须正常归档，证明停摆是标记导致的而非逻辑坏了
const pri = await run('primary', {});
const priFiles = (await readdir(pri.dir).catch(() => [])).filter((f) => f.startsWith('summary-'));
if (pri.code !== 1) throw new Error(`primary process must call the model, exit ${pri.code}: ${pri.err.slice(0, 200)}`);
if (priFiles.length !== 1) throw new Error(`primary must file exactly one archive, got ${priFiles.join(', ')}`);

await rm(root, { recursive: true, force: true });
console.log('✓ 次级进程停摆、主进程正常归档');
