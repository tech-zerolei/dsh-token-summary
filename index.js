/**
 * dsh-token-summary — Host half.
 *
 * Counts every token the harness bills across ALL sessions in this process (one
 * global counter), and whenever another `intervalTokens` (default 10,000,000)
 * has been consumed it asks the model for a natural-language summary of the
 * session that crossed the threshold, writes that summary to a Markdown file on
 * disk, and leaves a one-line notice in that session.
 *
 * Design constraints kept deliberately:
 *  - Imports are Node builtins plus this package's own `./logic.js`. Harness
 *    services are reached through `ctx` by name, never imported, so a Harness
 *    upgrade cannot break module resolution here.
 *  - No durable plugin state. The only log write is one producer-attributed
 *    `user/message` notice, so fork/resume/replay stay reconstructable.
 *  - Counters are in memory and restart with the process; a batch in progress
 *    at shutdown is not carried over.
 *
 * @module dsh-token-summary
 */

import { mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  buildNotice,
  buildPrompt,
  buildTranscript,
  clip,
  formatNumber,
  normalizeConfig,
  renderIndexEntry,
  renderMarkdown,
  usageTokens,
} from './logic.js';

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'token-summary';

/** Host services this plugin needs; without them it stays inactive. */
export const inject = ['llm'];

/**
 * Assemble text from one model stream, keeping no reasoning blocks.
 * @param stream - chunks from `ctx.llm.stream()`.
 * @returns the concatenated text plus the terminal failure, when there is one.
 */
async function collectText(stream) {
  let text = '';
  let failure;
  for await (const chunk of stream) {
    if (chunk === null || typeof chunk !== 'object') continue;
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text;
    } else if (chunk.type === 'block-end') {
      const block = chunk.block;
      if (block?.type === 'text' && text === '') text = String(block.text ?? '');
    } else if (chunk.type === 'finish') {
      const reason = chunk.reason;
      if (reason?.kind === 'error') failure = reason.failure?.message ?? '模型返回错误';
      else if (reason?.kind === 'aborted') failure = reason.failure?.message ?? '请求被中止';
    }
  }
  return { text: text.trim(), failure };
}

/**
 * Choose the provider/model route for one summary request.
 *
 * Configured route first, then the session's own logged request header, then the
 * live agent's options. Returns `undefined` when the session has never made a
 * routed call, which is the only case where a summary cannot be produced.
 *
 * @param config - normalized plugin configuration.
 * @param session - the session that crossed the threshold.
 * @param agent - its live agent, when one exists.
 * @returns the route, or `undefined`.
 */
function resolveRoute(config, session, agent) {
  if (config.provider !== '' && config.model !== '') {
    return { provider: config.provider, model: config.model };
  }
  const logged = session.requestHeader()?.config;
  if (logged !== undefined && logged.provider !== '' && logged.model !== '') {
    return { provider: logged.provider, model: logged.model };
  }
  const options = agent?.options;
  if (typeof options?.provider === 'string' && typeof options?.model === 'string') {
    return { provider: options.provider, model: options.model };
  }
  return undefined;
}

/**
 * Count billed tokens process-wide, summarize at each threshold, and write one
 * Markdown file per summary batch.
 *
 * @param ctx - plugin context; listeners are disposed with it.
 * @param rawConfig - the Loader row's `config` block.
 */
export function apply(ctx, rawConfig) {
  const { config, warnings } = normalizeConfig(rawConfig);
  const logger = ctx.logger('token-summary');
  for (const warning of warnings) logger.warn(warning);
  if (!config.enabled) {
    logger.info('disabled by config; nothing is counted');
    return;
  }

  /** Running total across every session in this process. */
  let totalTokens = 0;
  /** The threshold a summary fires at; advances with each completed batch. */
  let nextThreshold = config.intervalTokens;
  /** Completed batches, numbered in the Markdown file names. */
  let batch = 0;
  /** Serializes boundary handling so two sessions never write the same batch. */
  let queue = Promise.resolve();
  /** Monotonic tie-breaker so two notices in the same millisecond still differ. */
  let noticeSeq = 0;

  /**
   * A service this plugin may use but does not depend on.
   *
   * Accessed through `ctx.get()` rather than the property: reading an absent
   * service through `ctx.<name>` throws, and these are optional capabilities
   * (a slim profile may mount neither the agent registry nor session titles).
   */
  const optional = (key) => {
    try {
      return ctx.get(key);
    } catch {
      return undefined;
    }
  };

  /** The live agent behind a session, when this process still has one. */
  const agentOf = (session) => {
    try {
      return optional('agents')?.list?.().find((candidate) => candidate.id === session.id);
    } catch {
      return undefined;
    }
  };

  /** Resolve the Markdown output directory for one session. */
  const outputDirFor = (session, agent) => {
    if (config.outputDir !== '') return resolve(config.outputDir);
    const cwd = session.header.cwd ?? agent?.session?.header?.cwd ?? process.cwd();
    return join(cwd, '.dsh-summaries');
  };

  /** Read the session's title without requiring the title service to be mounted. */
  const titleOf = (session) => {
    try {
      const snapshot = optional('sessionTitle')?.get?.(session);
      return typeof snapshot?.title === 'string' ? snapshot.title : undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * Ask the model for one natural-language summary.
   * @param session - session to summarize.
   * @param transcript - its folded text and counters.
   * @param route - resolved provider/model route, or `undefined`.
   * @returns the summary text and, when the call failed, the failure reason.
   */
  const summarize = async (session, transcript, route) => {
    if (route === undefined) {
      return {
        text: '',
        failure: '该会话还没有发出过模型请求，无法确定摘要路由；请在插件配置里填写 provider 与 model。',
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const prompt = buildPrompt(transcript.text === '' ? '（这一段没有可读的对话文本）' : transcript.text);
      const stream = ctx.llm.stream({
        provider: route.provider,
        model: route.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: config.maxSummaryOutputTokens,
        sessionId: session.id,
        signal: controller.signal,
      });
      const collected = await collectText(stream);
      if (collected.failure !== undefined) return { text: '', failure: collected.failure };
      if (collected.text === '') return { text: '', failure: '摘要模型返回了空内容' };
      return { text: collected.text, failure: undefined };
    } catch (error) {
      return { text: '', failure: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * Decide the next batch ordinal from what is already on disk.
   *
   * The in-memory counter cannot be trusted as the only source: several Host
   * processes (or a restart) each start from zero, and two of them would
   * otherwise both write "第 1 批". Scanning the directory makes the ordinal a
   * property of the archive, so numbering stays monotonic across processes.
   *
   * Scanning alone is not enough, though: read-then-write is a TOCTOU race, and
   * two instances that start at the same moment can read the same "highest" and
   * then pick the same number — the second file silently overwrites the first,
   * losing an archived summary. So the number is *claimed* atomically with an
   * exclusive-create placeholder (`wx`), and a loser retries the next candidate.
   *
   * @param dir - output directory that will receive the batch file.
   * @returns the claimed ordinal and the placeholder path that reserves it.
   */
  const nextOrdinal = async (dir) => {
    batch += 1;
    let candidate = batch;
    // The claim below needs the directory to exist: `open(..., 'wx')` on a
    // missing directory reports ENOENT, which is not a lost race and must not be
    // mistaken for one.
    await mkdir(dir, { recursive: true }).catch(() => {});
    try {
      for (const entry of await readdir(dir)) {
        const match = /^summary-(\d+)-/.exec(entry);
        if (match === null) continue;
        const seen = Number(match[1]);
        if (Number.isSafeInteger(seen) && seen >= candidate) candidate = seen + 1;
      }
    } catch {
      // A missing directory simply means no batch has been filed there yet.
    }
    // Try candidates until one exclusive create succeeds. A concurrent writer
    // that grabbed the same number leaves its claim file behind, so we move on.
    for (let attempt = 0; attempt < 10_000; attempt += 1) {
      if (candidate > batch) batch = candidate;
      const claimPath = join(dir, `.claim-${String(candidate).padStart(4, '0')}`);
      try {
        const handle = await open(claimPath, 'wx');
        await handle.close();
        return { ordinal: candidate, claimPath };
      } catch (error) {
        if (error?.code === 'EEXIST') {
          candidate += 1;
          continue;
        }
        // Not a lost race (read-only directory, exhausted handles, ...): keep the
        // scanned number rather than failing the batch outright.
        return { ordinal: candidate, claimPath: undefined };
      }
    }
    return { ordinal: candidate, claimPath: undefined };
  };

  /**
   * Build and write the Markdown deliverable for one completed batch.
   * @param session - session that crossed the threshold.
   * @param boundary - the running total that crossed it.
   * @returns the written file's name and any failure text.
   */
  const writeSummary = async (session, boundary) => {
    const finishedAt = Date.now();
    const agent = agentOf(session);
    const transcript = buildTranscript(session.ownEvents(), { maxChars: config.maxTranscriptChars });
    const route = resolveRoute(config, session, agent);
    const { text: summaryText, failure: summaryFailure } = await summarize(session, transcript, route);

    const dir = outputDirFor(session, agent);
    // Claim the ordinal only after the await above, so two concurrent writers
    // in this process cannot reserve the same number either.
    const { ordinal, claimPath } = await nextOrdinal(dir);
    const stamp = new Date(finishedAt).toISOString().replace(/[:.]/g, '-');
    const fileName = `summary-${String(ordinal).padStart(4, '0')}-${boundary}-${stamp}.md`;
    const filePath = join(dir, fileName);
    const markdown = renderMarkdown({
      batch: ordinal,
      intervalTokens: config.intervalTokens,
      totalTokens: boundary,
      startedAt: boundary - config.intervalTokens,
      finishedAt,
      sessionId: String(session.id),
      sessionTitle: titleOf(session),
      cwd: session.header.cwd ?? agent?.session?.header?.cwd,
      route,
      stats: transcript,
      summaryText,
      failure: summaryFailure,
      transcriptChars: transcript.chars,
    });

    let failure = summaryFailure;
    // Track a write failure separately: "the summary call failed" and "nothing
    // reached the disk" are different outcomes, and reporting the former as
    // "已写入" tells the user a file exists when it does not.
    let writeFailed = false;
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(filePath, markdown, 'utf8');
      // The rolling index is a convenience: a failure to maintain it never
      // invalidates the batch file that was just written.
      const index = join(dir, 'README.md');
      const entry = renderIndexEntry({
        batch: ordinal,
        totalTokens: boundary,
        fileName,
        sessionId: String(session.id),
        finishedAt,
      });
      try {
        // `a+` creates the file when absent; the header must only lead the very
        // first entry, so its presence is measured rather than assumed.
        const existing = await readFile(index, 'utf8').catch(() => undefined);
        await writeFile(
          index,
          existing === undefined ? `${indexHeader(dir)}${entry}\n` : `${existing}${entry}\n`,
          'utf8',
        );
      } catch {
        // ignore: index maintenance is best-effort
      }
    } catch (error) {
      writeFailed = true;
      failure ??= `写入 ${filePath} 失败：${error instanceof Error ? error.message : String(error)}`;
    } finally {
      // Release the reservation: the real file now carries this number, and a
      // leftover claim would make the next scan skip it needlessly.
      if (claimPath !== undefined) await rm(claimPath, { force: true }).catch(() => {});
    }
    return { ordinal, fileName, filePath, failure, writeFailed };
  };

  /**
   * The index file's fixed preamble, written the first time a file appears there.
   * @param dir - output directory, shown for context.
   * @returns the Markdown preamble.
   */
  const indexHeader = (dir) => [
    '# 会话总结索引',
    '',
    '由 `dsh-token-summary` 自动维护：进程内累计 token 每跨过一个批次就归档一份 Markdown 总结。',
    '',
    `输出目录：\`${dir}\``,
    '',
    '## 归档记录',
    '',
    '',
  ].join('\n');

  /**
   * Leave one durable, producer-attributed notice in the session.
   *
   * `inject` deliberately does not wake an idle agent: this is background work
   * and must not open a turn by itself. A session with no live agent (or a
   * profile without the agent registry) simply gets no notice — the Markdown
   * file is the deliverable.
   *
   * The message MUST be a complete `UserMessage`: `id` and `role` are not
   * optional. `Session.append()` does not check them, so a malformed notice is
   * accepted silently, but the reload path (`validateStoredEvents` →
   * `assertMessageEventShape`) rejects it with "lacks an identified message",
   * which makes the whole session unopenable — the archive would destroy the
   * very session it archived. `id` also carries inbox de-duplication, so a
   * missing one can make a second pending notice throw.
   */
  const notify = (session, text) => {
    if (!config.notifyInSession) return;
    const agent = agentOf(session);
    if (agent === undefined || typeof agent.inject !== 'function') return;
    try {
      agent.inject({
        id: `token-summary-${session.id}-${Date.now().toString(36)}-${(noticeSeq += 1).toString(36)}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: name, form: 'notice', summary: clip(text, 120) },
      });
    } catch (error) {
      logger.debug(`notice skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** Handle one threshold crossing, serialized against other sessions. */
  const onThreshold = (session) => {
    // Boundaries are absolute multiples of the batch size, so a session that
    // overshoots cannot shift every later batch. A single call may cross more
    // than one boundary, so one report is filed per boundary crossed.
    const boundaries = [];
    while (totalTokens >= nextThreshold) {
      boundaries.push(nextThreshold);
      nextThreshold += config.intervalTokens;
    }
    queue = queue
      .then(async () => {
        for (const boundary of boundaries) {
          const written = await writeSummary(session, boundary);
          // Never claim a write that did not happen: the log line and the notice
          // are the only feedback a user gets, so they must describe the real
          // outcome.
          if (written.writeFailed) {
            logger.error(`第 ${written.ordinal} 批写入失败：${written.failure ?? '未知原因'}`);
          } else {
            logger.info(`第 ${written.ordinal} 批已写入 ${written.filePath}`);
          }
          notify(session, buildNotice({
            batch: written.ordinal,
            intervalTokens: config.intervalTokens,
            totalTokens: boundary,
            fileName: written.fileName,
            failure: written.failure,
            writeFailed: written.writeFailed,
          }));
        }
      })
      .catch((error) => {
        logger.error(`批次生成失败: ${error instanceof Error ? error.message : String(error)}`);
      });
  };

  // One global fold. `session/event` is a post-commit emit feed, so the event is
  // already durable when this runs; only `assistant/message` carries provider
  // usage, which is the only figure that reflects what was actually billed.
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'assistant/message' || event.data.usage === undefined) return;
    const delta = usageTokens(event.data.usage);
    if (delta <= 0) return;
    totalTokens += delta;
    if (totalTokens >= nextThreshold) onThreshold(session);
  });

  logger.info(
    `全局累计，每 ${formatNumber(config.intervalTokens)} token 归档一份 Markdown 总结`,
  );
}