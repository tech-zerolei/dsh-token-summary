/**
 * 真实效果演示：用一个真实的模型调用跑完整归档流程。
 *
 * 与 e2e.mjs 的区别：这里的 llm.stream() 真的打到网络模型，
 * 摘要正文由模型生成，而不是桩数据。
 *
 * 运行：node demo.mjs
 */
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { apply } from './index.js';

const OUT = '/root/.dsh/out/token-summary-demo';

// 演示用会话：模拟一个真实的长任务片段
const sessionEvents = [
  { type: 'user/message', data: { content: [{ type: 'text', text: '把缓存层从内存 LRU 换成两级缓存，降低 P99 延迟。要求：L1 进程内、L2 用 Redis，要有降级方案。' }] } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '我先看一下现有的缓存实现和调用点。' }] }, usage: { totalTokens: 3200 } } },
  { type: 'tool/call', data: { name: 'grep', arguments: '{"pattern":"cache"}' } },
  { type: 'tool/result', data: { message: { content: [] }, error: { name: 'TimeoutError' } } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '现有实现是 `src/cache/index.ts` 里的单层 LRU，被 12 处调用。我决定保留 `get/set/del` 签名不变，内部换成两级，这样调用点零改动。Redis 选型上放弃 Memcached，因为我们需要 TTL 和 pipeline 批量操作。' }] }, usage: { totalTokens: 4100 } } },
  { type: 'user/message', data: { content: [{ type: 'text', text: '降级方案具体怎么做？Redis 挂了不能整个服务不可用。' }] } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'L2 失败时直接穿透到 L1 并记录熔断计数，连续 5 次失败打开熔断器 30 秒，期间只走 L1。这样 Redis 完全宕机时服务降级为原来的单层 LRU，不影响可用性。已改完 `src/cache/index.ts` 和 `src/cache/redis.ts`，压测还没跑。' }] }, usage: { totalTokens: 2800 } } },
];

const notices = [];
const logs = [];
const ctx = {
  logger: () => ({
    info: (m) => logs.push(['info', m]),
    warn: (m) => logs.push(['warn', m]),
    error: (m) => logs.push(['error', m]),
    debug: () => {},
  }),
  on(_event, handler) { this._handler = handler; return () => {}; },
  get(key) {
    if (key === 'sessionTitle') return { get: () => ({ title: '缓存层两级化改造' }) };
    return undefined;
  },
  // 真实模型调用：走 DeepSeek Harness 配置的 openai-responses 兼容端点
  llm: {
    stream(options) {
      const { model, messages, maxTokens, signal } = options;
      return (async function* () {
        const baseURL = process.env.DEMO_BASE_URL;
        const apiKey = process.env.DEMO_API_KEY;
        const res = await fetch(`${baseURL}/responses`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            input: messages.map((m) => m.content.map((b) => b.text ?? '').join('')).join('\n\n'),
            max_output_tokens: maxTokens,
          }),
          signal,
        });
        if (!res.ok) {
          const body = await res.text();
          yield { type: 'finish', reason: { kind: 'error', failure: { message: `HTTP ${res.status}: ${body.slice(0, 200)}` } } };
          return;
        }
        const json = await res.json();
        // openai-responses: output 是条目数组，文本在 message 类型的 content 里
        let text = '';
        for (const item of json.output ?? []) {
          if (item.type === 'message') {
            for (const c of item.content ?? []) if (c.type === 'output_text') text += c.text;
          }
        }
        if (text === '') {
          const reason = json.incomplete_details?.reason ?? json.status ?? '空输出';
          yield { type: 'finish', reason: { kind: 'error', failure: { message: `模型未返回文本（${reason}）` } } };
          return;
        }
        yield { type: 'text-delta', index: 0, text };
        const u = json.usage ?? {};
        yield { type: 'usage', usage: { inputTokens: u.input_tokens, outputTokens: u.output_tokens, totalTokens: u.total_tokens } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  },
};

const session = {
  id: 'session-demo-cache',
  header: { cwd: '/root/work/demo-project' },
  ownEvents: () => sessionEvents,
  requestHeader: () => ({ config: { provider: 'api23', model: 'deepseek-flash' } }),
};
ctx.get = ((orig) => (key) => {
  if (key === 'agents') return { list: () => [{ id: 'session-demo-cache', inject: (m) => notices.push(m) }] };
  return orig(key);
})(ctx.get);

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

// 阈值设成 10000，用第一条 usage（3200）不触发，累计后触发
apply(ctx, {
  intervalTokens: 10000,
  outputDir: OUT,
  notifyInSession: true,
  maxTranscriptChars: 50000,
});

console.log('▶ 插件已激活，阈值 10,000 token\n');

// 逐步喂入 usage，展示累计过程
const steps = [
  ['第一轮模型响应', 3200],
  ['第二轮模型响应', 4100],
  ['第三轮模型响应', 2800], // 累计 10100 → 跨过 10000
];
let total = 0;
for (const [label, tokens] of steps) {
  total += tokens;
  console.log(`   ${label}: +${tokens.toLocaleString()} → 累计 ${total.toLocaleString()}`);
  ctx._handler(session, { type: 'assistant/message', data: { usage: { totalTokens: tokens } } });
}

console.log('\n⏳ 等待模型生成摘要...\n');
await new Promise((r) => setTimeout(r, 45000));

const files = await readdir(OUT);
console.log('📁 产出文件:', files.join(', '));

let ok = true;
for (const f of files.filter((x) => x.startsWith('summary-'))) {
  const body = await readFile(join(OUT, f), 'utf8');
  console.log('\n' + '='.repeat(70));
  console.log('📄 ' + f);
  console.log('='.repeat(70) + '\n');
  console.log(body);
  if (body.includes('摘要模型调用失败')) ok = false;
}

const idx = await readFile(join(OUT, 'README.md'), 'utf8');
console.log('=' .repeat(70));
console.log('📑 README.md（索引）');
console.log('='.repeat(70) + '\n');
console.log(idx);

console.log('\n💬 会话内通知:');
for (const n of notices) console.log('   • ' + n.content[0].text);

console.log('\n📊 插件日志:');
for (const [lvl, m] of logs) console.log(`   [${lvl}] ${m}`);

process.exitCode = ok ? 0 : 1;