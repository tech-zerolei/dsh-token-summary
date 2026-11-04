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

import { appendFile, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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

/** Env var marking a secondary Harness process that must not archive. */
const SECONDARY_PROCESS_ENV = 'DSH_PHONE_AS_MINTER';

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
  let truncated = false;
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
      // `max-tokens` is a legitimate finish reason meaning the output was cut
      // off mid-sentence. Treating it as success would archive half a summary as
      // if it were complete, so surface it as a (soft) failure instead.
      else if (reason?.kind === 'max-tokens') {
        truncated = true;
        failure = `摘要输出达到 maxSummaryOutputTokens（${config.maxSummaryOutputTokens}）被截断`;
      }
    }
  }
  return { text: text.trim(), failure, truncated };
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
  // A single machine can run more than one Harness process against the same
  // profile: `dsh-phone-remote` spawns a second `dsh web` as a cookie minter and
  // marks it with this variable so its own plugin stands down. Every cooperative
  // process unrolls itself the same way. Without this guard that second process
  // counts the same conversation independently and files a duplicate archive for
  // every batch (two processes = two files per crossing).
  // The marker list is configurable so the same protection covers other
  // dual-process setups (test harnesses, remote bridges) without a code change.
  const secondaryMarkers = (config.standDownEnv === '' ? [SECONDARY_PROCESS_ENV] : config.standDownEnv.split(','))
    .map((name) => name.trim())
    .filter((name) => name !== '');
  const standDown = secondaryMarkers.find((name) => process.env[name] !== undefined);
  if (standDown !== undefined) {
    logger.info(`running as a secondary Harness process (${standDown}); archiving is left to the primary`);
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
  /**
   * Read the most recent handoff document for a session, to extend it.
   *
   * The deliverable is cumulative: each new handoff merges into the previous one
   * so the reader gets one coherent, ever-longer document. Reading it back from
   * disk keeps that state durable — the plugin holds no private copy, and a
   * restart resumes from whatever is already written.
   *
   * @param dir - output directory holding the previous handoff.
   * @returns the document body, or `undefined` when this is the first handoff.
   */
  /**
   * How many of the session's events the previous handoff already covered.
   *
   * Recorded in the document itself so a restarted process can resume exactly
   * where the last one stopped, instead of re-sending history or guessing.
   *
   * @param body - the previous document's full text.
   * @returns the covered event count, or 0 when it is not recorded.
   */
  const coveredBy = (body) => {
    const match = /\| 已覆盖事件数 \| (\d+) \|/.exec(body ?? '');
    return match === null ? 0 : Number(match[1]);
  };

  const readLatestDocument = async (dir, sessionTag) => {
    if (dir === undefined) return undefined;
    try {
      // Only this session's documents. Picking the newest file in a shared
      // directory made a session merge another session's handoff into its own,
      // corrupting both with content from a conversation the reader never had.
      // Match on the stable identity suffix, not the readable title: the title
      // may have changed since the previous handoff was written.
      const identity = `--${sessionTag.split('--').pop()}-`;
      const entries = (await readdir(dir))
        .filter((f) => f.startsWith('handoff-') && f.includes(identity) && /\.md$/.test(f))
        .sort();
      if (entries.length === 0) return undefined;
      const body = await readFile(join(dir, entries[entries.length - 1]), 'utf8');
      // Strip the generated front matter and footer so the model sees only the
      // document itself, not our bookkeeping.
      const start = body.indexOf('## 交接正文');
      const end = body.lastIndexOf('\n---\n');
      const text = start === -1 ? body : body.slice(start + '## 交接正文'.length, end === -1 ? undefined : end).trim();
      return { text, raw: body };
    } catch {
      return undefined;
    }
  };

  /**
   * A filesystem-safe, human-readable tag for one session.
   *
   * Used in handoff file names so a session can find its OWN previous document
   * in a directory shared by every session. Session ids are already safe on this
   * platform, but they are sanitised anyway: this string becomes a path segment.
   *
   * @param session - session whose document is being named.
   * @returns a short tag unique to the session.
   */
  const sessionTagOf = (session) => {
    const raw = String(session.id);
    // A hash keeps ids distinct even when they share a tail.
    // 32-bit FNV-1a: stable across restarts and cheap. Base36 keeps it short but
    // with enough width (6 chars ≈ 2.1e9 values) that two sessions sharing a
    // directory will not collide in practice.
    let hash = 0x811c9dc5;
    for (let i = 0; i < raw.length; i += 1) {
      hash ^= raw.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    const suffix = hash.toString(36).padStart(6, '0').slice(-6);
    // Prefer a readable title, so a directory holding several sessions can be
    // told apart at a glance; fall back to the id when there is no title.
    const title = titleOf(session);
    const slug = typeof title === 'string'
      ? title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 24)
      : '';
    // The title is decoration only: it can change mid-session (auto-generated
    // titles get refined), so lookup must key on the stable hash below. Tag
    // format: <slug|id-fragment>--<hash>. The double dash separates the readable
    // part from the identity part.
    if (slug !== '') return `${slug}--${suffix}`;
    const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '');
    return cleaned === '' ? `session--${suffix}` : `${cleaned.slice(0, 6)}--${suffix}`;
  };

  /** Commit the resume point for one session after its report is durable. */
  const commitCursor = (sessionId, upTo) => {
    if (upTo === undefined) return;
    const current = sessionCursor.get(sessionId) ?? 0;
    if (upTo > current) sessionCursor.set(sessionId, upTo);
  };
  /** Per-session index into `ownEvents()` of the first not-yet-archived event. */
  const sessionCursor = new Map();
  /** Highest ordinal already handed out per output directory. */
  const perDirBatch = new Map();
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
  const summarize = async (session, transcript, route, previousDocument) => {
    if (route === undefined) {
      return {
        text: '',
        failure: '该会话还没有发出过模型请求，无法确定摘要路由；请在插件配置里填写 provider 与 model。',
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const prompt = buildPrompt(
        transcript.text === '' ? '（这一段没有可读的对话文本）' : transcript.text,
        previousDocument,
      );
      const stream = ctx.llm.stream({
        provider: route.provider,
        model: route.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: config.maxSummaryOutputTokens,
        // Handoff writing is a transcription task, not a reasoning task. On
        // reasoning models the hidden reasoning tokens are billed against the
        // same output budget, so a high effort can consume most of it and cut
        // the document off mid-sentence (observed: 1,157 reasoning chars for a
        // 211-char body). A low effort keeps the budget for the document itself.
        ...(config.reasoningEffort === '' ? {} : { reasoningEffort: config.reasoningEffort }),
        sessionId: session.id,
        signal: controller.signal,
      });
      const collected = await collectText(stream);
      // A truncated answer still carries the beginning of a usable summary, so
      // keep the text and report the truncation *as well* — dropping it outright
      // would throw away the only content we managed to generate.
      if (collected.truncated) {
        return { text: collected.text, failure: collected.failure, truncated: true };
      }
      if (collected.failure !== undefined) return { text: '', failure: collected.failure, truncated: false };
      if (collected.text === '') return { text: '', failure: '摘要模型返回了空内容', truncated: false };
      return { text: collected.text, failure: undefined, truncated: false };
    } catch (error) {
      return { text: '', failure: error instanceof Error ? error.message : String(error), truncated: false };
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
    // Per-directory cursor, not a single process-wide counter. `batch` used to
    // act as a lower bound for *every* directory, so a fresh output directory
    // (the default layout is one per session cwd) inherited numbering from
    // unrelated projects and its "第 1 批" title was simply wrong.
    let candidate = (perDirBatch.get(dir) ?? 0) + 1;
    batch += 1;
    // The claim below needs the directory to exist: `open(..., 'wx')` on a
    // missing directory reports ENOENT, which is not a lost race and must not be
    // mistaken for one.
    await mkdir(dir, { recursive: true }).catch(() => {});
    try {
      for (const entry of await readdir(dir)) {
        // Ordinals are global within the directory: every handoff there shares
        // one numbering space, so the timeline is unambiguous no matter which
        // session produced the file. Both shapes are accepted — with and without
        // the session tag — so archives written by older versions still count.
        // Match the ordinal positionally instead of letting an optional tag
        // swallow it: a greedy `(?:[\w-]+-)?` happily ate a tag ending in digits
        // and produced ordinals like 2027. The ordinal is always a 4+ digit run
        // immediately followed by `-<boundary>-<timestamp>.md`.
        // The name is `handoff-<readable>--<hash>-<ordinal>-<boundary>-<stamp>.md`,
        // where <readable> may hold any script (a session title) and `--` marks
        // the boundary to the identity part. Anchor on the invariant tail rather
        // than trying to describe the prefix.
        const match = /-(\d{4,})-(\d+)-[\dTZ:.-]+\.md$/.exec(entry);
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
        perDirBatch.set(dir, candidate);
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
   * Gather everything a batch report needs, including the model summary.
   *
   * Split out from {@link writeSummary} because one threshold crossing can span
   * several boundaries that all describe the same conversation span: the
   * transcript and the (paid) model call are shared, while only the rendering
   * and the file write repeat.
   *
   * @param session - session to summarize.
   * @returns the materialized inputs for one or more batch files.
   */
  const prepareSummary = async (session) => {
    const agent = agentOf(session);
    // First handoff summarizes the WHOLE conversation, because there is nothing
    // to build on yet and the reader needs the full picture. Later handoffs only
    // fold in the span produced since the last one, and merge it into the
    // document that already exists — that is what makes the artifact a growing,
    // resumable handoff document instead of a pile of disjoint slices.
    const events = session.ownEvents();
    const since = sessionCursor.get(session.id) ?? 0;
    const dir = outputDirFor(session, agent);
    // "Is this the first handoff?" is a property of the ARCHIVE, not of this
    // process. Keying it off the in-memory cursor meant a restart (cursor back at
    // 0) re-summarized the entire history as if nothing had been written, and
    // dropped the link to the document already on disk.
    const previous = await readLatestDocument(dir, sessionTagOf(session));
    const isFirst = previous === undefined;
    const coveredByPrevious = isFirst ? 0 : coveredBy(previous?.raw);
    // The span to summarize:
    //  - first handoff        → the whole conversation
    //  - later, cursor known  → exactly what appeared since the last handoff
    //  - later, cursor lost   → the whole conversation MINUS what the previous
    //                           document already covers. The cursor only lives in
    //                           memory, so a restart loses it; guessing "the last
    //                           event" produced a one-event span that was usually
    //                           an assistant usage record with no text, and the
    //                           resulting empty document repeated every few
    //                           seconds because the boundary never advanced.
    let fresh = isFirst
      ? events
      : events.slice(since > 0 ? since : Math.max(0, events.length - coveredByPrevious));
    // Never archive a span with nothing readable in it: if the gate opened on a
    // turn that produced no new messages, wait for the next one instead of
    // filing an empty report.
    let transcript = buildTranscript(fresh, { maxChars: config.maxTranscriptChars });
    // Nothing new to say: do not file an empty report and do not advance the
    // cursor (there is nothing to skip past). The caller checks `empty`.
    // The test is "is there anything readable", not "are there any events": a
    // span made only of tool calls has events but no text, and filing a report
    // for it produced empty documents (0 user messages, 0 transcript chars) that
    // repeated every few seconds because the boundary never advanced.
    // A trailing span can be nothing but usage/bookkeeping events, which carry no
    // readable text. Widen the window backwards until some text appears (or the
    // whole log is exhausted) instead of filing an empty document.
    if (transcript.text === '' && fresh.length > 0 && fresh.length < events.length) {
      fresh = events;
      transcript = buildTranscript(fresh, { maxChars: config.maxTranscriptChars });
    }
    if (transcript.text === '') {
      return {
        empty: true,
        upTo: events.length,
        agent,
        transcript,
        route: undefined,
        summaryText: '',
        summaryFailure: undefined,
        truncated: false,
        sessionTitle: titleOf(session),
      };
    }
    // The cursor is NOT advanced here. It may only move once the report is on
    // disk: consuming the span before the write commits would discard that
    // conversation segment forever if the model call or the write then failed.
    // The caller commits it through `commitCursor` on success.
    const upTo = events.length;
    const route = resolveRoute(config, session, agent);
    const { text: summaryText, failure: summaryFailure, truncated } =
      await summarize(session, transcript, route, previous?.text);
    // Snapshot the title once so every boundary in this crossing agrees.
    const sessionTitle = titleOf(session);
    return { agent, transcript, route, summaryText, summaryFailure, truncated, sessionTitle, upTo, isFirst };
  };

  /**
   * Render and write the Markdown deliverable for one completed batch.
   * @param session - session that crossed the threshold.
   * @param boundary - the running total that crossed it.
   * @param shared - inputs from {@link prepareSummary}, reused across boundaries.
   * @returns the written file's name and any failure text.
   */
  const writeSummary = async (session, boundary, shared, startedAt, spanned) => {
    const finishedAt = Date.now();
    const { agent, transcript, route, summaryText, summaryFailure, truncated, sessionTitle } =
      shared ?? (await prepareSummary(session));

    const dir = outputDirFor(session, agent);
    // Claim the ordinal only after the await above, so two concurrent writers
    // in this process cannot reserve the same number either.
    const { ordinal, claimPath } = await nextOrdinal(dir);
    const stamp = new Date(finishedAt).toISOString().replace(/[:.]/g, '-');
    // The session id is part of the name, not just the front matter: several
    // sessions share one output directory, and the next handoff has to find ITS
    // own previous document instead of whichever file happens to be newest.
    const sessionTag = sessionTagOf(session);
    const fileName = `handoff-${sessionTag}-${String(ordinal).padStart(4, '0')}-${boundary}-${stamp}.md`;
    const filePath = join(dir, fileName);
    const markdown = renderMarkdown({
      batch: ordinal,
      intervalTokens: config.intervalTokens,
      totalTokens: boundary,
      startedAt: startedAt ?? boundary - config.intervalTokens,
      finishedAt,
      sessionId: String(session.id),
      sessionTitle,
      cwd: session.header.cwd ?? agent?.session?.header?.cwd,
      route,
      stats: transcript,
      summaryText,
      failure: summaryFailure,
      truncated,
      transcriptChars: transcript.chars,
      spanned,
      coveredEvents: shared?.upTo,
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
        // Append-only, never read-modify-write. Rewriting the whole file meant
        // two concurrent writers read the same text and the later one silently
        // dropped the other's entry — the index lost rows and, when it did not
        // exist yet, both writers believed themselves first and clobbered the
        // header. A single small `appendFile` is atomic enough to avoid both.
        const headerMarker = join(dir, '.index-header');
        try {
          const handle = await open(headerMarker, 'wx');
          await handle.close();
          await appendFile(index, indexHeader(dir), 'utf8');
        } catch (error) {
          // EEXIST: the header already exists, which is the normal case.
          if (error?.code !== 'EEXIST') throw error;
        }
        await appendFile(index, `${entry}\n`, 'utf8');
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
    '# 工程交接文档索引',
    '',
    '由 `dsh-token-summary` 自动维护：累计新增 token 每跨过一个阈值，就把会话整理成一份',
    '可交给另一个 Agent 接着干的长文档。每份都在前一份基础上合并新增内容，越往后越完整。',
    '',
    `输出目录：\`${dir}\``,
    '',
    '## 归档记录',
    '',
  ].join('\n') + '\n';

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
    //
    // The threshold cursor is NOT advanced here. Doing so before the write
    // commits would let any failure inside `writeSummary` (a throwing
    // transcript read, a render error, a disk fault) silently consume the
    // boundary: the next crossing would jump past it and that archive would be
    // lost with nothing but a log line. Boundaries stay pending until their
    // report is durably written, then the cursor advances.
    const boundaries = [];
    let cursor = nextThreshold;
    // Cap the walk. A single absurd usage figure (a corrupt or hostile provider
    // report) would otherwise push millions of entries and crash the process with
    // "Invalid array length" — observed with MAX_SAFE_INTEGER. Only the first and
    // last boundary actually matter, so the span is what gets reported.
    const MAX_BOUNDARIES = 1000;
    while (totalTokens >= cursor && boundaries.length < MAX_BOUNDARIES) {
      boundaries.push(cursor);
      cursor += config.intervalTokens;
    }
    if (boundaries.length >= MAX_BOUNDARIES) {
      logger.warn(
        `单次用量异常巨大（累计 ${formatNumber(totalTokens)}），批次边界已截断至 ${MAX_BOUNDARIES} 个`,
      );
      cursor = totalTokens + config.intervalTokens;
    }
    queue = queue
      .then(async () => {
        // One transcript and one model call for the whole crossing: every
        // boundary here summarizes the same conversation span, so re-asking the
        // model per boundary would pay N times for identical output.
        const shared = boundaries.length > 0 ? await prepareSummary(session) : undefined;
        // Nothing new to archive since the previous batch: leave the boundaries
        // pending so the next turn that does produce content fills them, rather
        // than filing empty reports or silently skipping the span.
        if (shared?.empty === true) {
          // Nothing readable in this span. Advance past it: leaving the boundary
          // pending made the same threshold fire again on the very next event,
          // which produced a stream of identical empty documents.
          logger.debug(`第 ${boundaries[0]} 批：该区间无对话文本，跳过并推进到下一区间`);
          commitCursor(session.id, shared.upTo);
          const beyond = boundaries[boundaries.length - 1] + config.intervalTokens;
          if (beyond > nextThreshold) nextThreshold = beyond;
          return;
        }
        // One crossing produces exactly ONE report, spanning every boundary it
        // covered. Filing one file per boundary wrote N identical summaries of
        // the same span — pure duplication: a single 4-boundary crossing used to
        // produce four files with the same text and four separate notices.
        const last = boundaries[boundaries.length - 1];
        const written = await writeSummary(
          session, last, shared, boundaries[0] - config.intervalTokens, boundaries.length,
        );
        if (written.writeFailed) {
          logger.error(`第 ${written.ordinal} 批写入失败：${written.failure ?? '未知原因'}`);
        } else {
          logger.info(`第 ${written.ordinal} 批已写入 ${written.filePath}`);
        }
        notify(session, buildNotice({
          batch: written.ordinal,
          intervalTokens: config.intervalTokens,
          totalTokens: last,
          fileName: written.fileName,
          failure: written.failure,
          writeFailed: written.writeFailed,
          spanned: boundaries.length,
        }));
        // Commit both cursors only after the crossing is settled. A failed write
        // leaves the span unconsumed and the boundary pending, so the next
        // trigger retries instead of losing the segment.
        if (!written.writeFailed) {
          commitCursor(session.id, shared.upTo);
          if (last + config.intervalTokens > nextThreshold) {
            nextThreshold = last + config.intervalTokens;
          }
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

  // Say where the files go at startup: an empty `outputDir` writes next to each
  // session's working directory, which is easy to look for in the wrong place.
  const destination = config.outputDir === ''
    ? '每个会话的工作目录下 .dsh-summaries/'
    : config.outputDir;
  logger.info(
    `每累计 ${formatNumber(config.intervalTokens)} 新增 token 生成一份交接文档 → ${destination}`,
  );
}