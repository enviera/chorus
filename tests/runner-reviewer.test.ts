/**
 * Integration tests for runReviewerHeadless.
 *
 * Same shape as the doer tests but the reviewer returns boolean | null
 * (the verdict) instead of {content, full}. Verifies that approve / disagree
 * text is correctly extracted from streamed deltas and that empty / errored
 * paths fail closed (null).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runReviewerHeadless } from '../src/daemon/runner';
import { _resetDbForTests } from '../src/lib/db/connection';
import type { StandardPhase } from '../src/lib/template-schema';
import type { RunnerEvent } from '../src/daemon/runner';
import { makeFakeShim, happyPathEvents } from './helpers/fake-agent-shim';

let tmp: string;
let reviewerDir: string;
let answerFile: string;
let events: RunnerEvent[];
let dbPath: string;

beforeEach(async () => {
  // Each test gets a unique DB so parallel vitest workers don't race
  // on a shared ~/.chorus/chorus.db (CI hit SQLITE_BUSY otherwise).
  dbPath = path.join(os.tmpdir(), `chorus-runner-reviewer-${randomUUID()}.db`);
  process.env.CHORUS_DB_PATH = dbPath;
  await _resetDbForTests();

  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-reviewer-'));
  reviewerDir = path.join(tmp, 'reviewer-codex-0');
  fs.mkdirSync(reviewerDir, { recursive: true });
  answerFile = path.join(reviewerDir, 'answer.md');
  events = [];
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.CHORUS_DB_PATH;
});

const fixturePhase: StandardPhase = {
  id: 'review',
  kind: 'review',
  title: 'Code Review',
  description: '',
  doer: { lineage: 'anthropic', models: ['claude-opus-4-7'] },
  reviewer: {
    require: 1,
    crossLineage: true,
    candidates: [{ lineage: 'openai', models: ['gpt-5.5'] }],
  },
  inputs: { include: [], exclude: [] },
  iterate: {
    maxRounds: 1,
    onDisagreement: 'continue',
    shareSessionAcrossRounds: false,
    shareSessionAcrossPhases: false,
  },
} as unknown as StandardPhase;

const PADDING =
  'lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(3);

const callReviewer = (shimHandle: ReturnType<typeof makeFakeShim>) =>
  runReviewerHeadless({
    shim: shimHandle.shim,
    chatId: 'test-chat',
    phase: fixturePhase,
    round: 1,
    reviewerIdx: 0,
    candidateLineage: 'openai',
    candidateModel: 'gpt-5.5',
    agentName: 'codex-cli',
    askContent: 'review the doer output',
    answerFile,
    reviewerDir,
    abortSignal: new AbortController().signal,
    onEvent: (e) => events.push(e),
  });

describe('runReviewerHeadless', () => {
  it('forwards phase.timeoutMs to the shim spawn options', async () => {
    const handle = makeFakeShim({
      events: happyPathEvents(`${PADDING}\nlgtm\n## DONE`),
    });
    const phaseWithTimeout: StandardPhase = { ...fixturePhase, timeoutMs: 45_000 };
    await runReviewerHeadless({
      shim: handle.shim,
      chatId: 'test-chat',
      phase: phaseWithTimeout,
      round: 1,
      reviewerIdx: 0,
      candidateLineage: 'openai',
      candidateModel: 'gpt-5.5',
      agentName: 'codex-cli',
      askContent: 'review the doer output',
      answerFile,
      reviewerDir,
      abortSignal: new AbortController().signal,
      onEvent: (e) => events.push(e),
    });
    expect(handle.calls).toHaveLength(1);
    expect(handle.calls[0].options.timeoutMs).toBe(45_000);
  });

  it('falls back to the default phase timeout when phase.timeoutMs is unset', async () => {
    const handle = makeFakeShim({
      events: happyPathEvents(`${PADDING}\nlgtm\n## DONE`),
    });
    await callReviewer(handle);
    expect(handle.calls[0].options.timeoutMs).toBe(10 * 60 * 1000);
  });

  // Turn cap resolution: phase override → CHORUS_REVIEWER_MAX_TURNS → default.
  // The default was a fixed 50, which a reviewer with worktree access
  // exhausted on a 58-file diff before writing a finding.
  describe('reviewer turn cap', () => {
    afterEach(() => {
      delete process.env.CHORUS_REVIEWER_MAX_TURNS;
    });

    it('defaults to DEFAULT_REVIEWER_MAX_TURNS (120)', async () => {
      const handle = makeFakeShim({ events: happyPathEvents(`${PADDING}\nlgtm\n## DONE`) });
      await callReviewer(handle);
      expect(handle.calls[0].options.maxTurns).toBe(120);
    });

    it('honours CHORUS_REVIEWER_MAX_TURNS and ignores a non-integer value', async () => {
      process.env.CHORUS_REVIEWER_MAX_TURNS = '200';
      let handle = makeFakeShim({ events: happyPathEvents(`${PADDING}\nlgtm\n## DONE`) });
      await callReviewer(handle);
      expect(handle.calls[0].options.maxTurns).toBe(200);

      process.env.CHORUS_REVIEWER_MAX_TURNS = '2junk';
      handle = makeFakeShim({ events: happyPathEvents(`${PADDING}\nlgtm\n## DONE`) });
      await callReviewer(handle);
      expect(handle.calls[0].options.maxTurns).toBe(120);

      process.env.CHORUS_REVIEWER_MAX_TURNS = '0';
      handle = makeFakeShim({ events: happyPathEvents(`${PADDING}\nlgtm\n## DONE`) });
      await callReviewer(handle);
      expect(handle.calls[0].options.maxTurns).toBe(120);
    });

    it('lets phase.reviewerMaxTurns beat the env var', async () => {
      process.env.CHORUS_REVIEWER_MAX_TURNS = '200';
      const handle = makeFakeShim({ events: happyPathEvents(`${PADDING}\nlgtm\n## DONE`) });
      const phaseWithCap: StandardPhase = { ...fixturePhase, reviewerMaxTurns: 33 };
      await runReviewerHeadless({
        shim: handle.shim,
        chatId: 'test-chat',
        phase: phaseWithCap,
        round: 1,
        reviewerIdx: 0,
        candidateLineage: 'openai',
        candidateModel: 'gpt-5.5',
        agentName: 'codex-cli',
        askContent: 'review the doer output',
        answerFile,
        reviewerDir,
        abortSignal: new AbortController().signal,
        onEvent: (e) => events.push(e),
      });
      expect(handle.calls[0].options.maxTurns).toBe(33);
    });
  });

  // A reviewer that streamed real findings and THEN died (turn cap, API
  // error) must keep those findings on disk with a DEGRADED block and no
  // `## DONE`, and still count as a failed slot (null verdict).
  it('keeps streamed findings and stamps REVIEWER DEGRADED when the run errors after content', async () => {
    const findings = `## Findings\n- ${PADDING}\n- ${PADDING}\n- ${PADDING}\n- ${PADDING}\n- request changes: missing null check\n`;
    const handle = makeFakeShim({
      events: [
        { type: 'text_delta', text: findings },
        { type: 'error', kind: 'claude_result_error', message: 'error_max_turns: Claude reported error' },
      ],
    });
    const verdict = await callReviewer(handle);
    // Existing semantics: streamed content still yields a text verdict
    // (here "request changes" → false); only a content-less error is null.
    expect(verdict).toBe(false);
    const written = fs.readFileSync(answerFile, 'utf-8');
    expect(written).toContain('missing null check');
    expect(written).toContain('## REVIEWER DEGRADED');
    expect(written).toContain('**Kind:** claude_result_error');
    expect(written).toContain('error_max_turns');
    expect(written).not.toContain('## REVIEWER FAILED');
    expect(/##\s*DONE/i.test(written)).toBe(false);
  });

  it('still writes the FAILED stub when the run errors before any content', async () => {
    const handle = makeFakeShim({
      events: [{ type: 'error', kind: 'claude_result_error', message: 'error_max_turns: Claude reported error' }],
    });
    await callReviewer(handle);
    const written = fs.readFileSync(answerFile, 'utf-8');
    expect(written).toContain('## REVIEWER FAILED');
    expect(written).not.toContain('## REVIEWER DEGRADED');
  });

  it('returns true when reviewer text approves at the tail', async () => {
    const text = `${PADDING}\nThis change handles divide-by-zero correctly. lgtm.\n## DONE`;
    const handle = makeFakeShim({ events: happyPathEvents(text) });
    const verdict = await callReviewer(handle);
    expect(verdict).toBe(true);
  });

  it('emits participant_done after message_done so the cockpit can flip the card without polling lag', async () => {
    const text = `${PADDING}\nlgtm.\n## DONE`;
    const handle = makeFakeShim({ events: happyPathEvents(text) });
    await callReviewer(handle);
    const done = events.filter((e) => e.type === 'participant_done');
    expect(done).toHaveLength(1);
    expect(done[0].payload).toMatchObject({
      role: 'reviewer',
      agent: 'codex-cli-0',
      round: 1,
    });
  });

  it('does NOT emit participant_done when the run errors before message_done', async () => {
    const handle = makeFakeShim({
      events: [{ type: 'error', kind: 'quota_exhausted', message: 'limit hit' }],
    });
    await callReviewer(handle);
    expect(events.some((e) => e.type === 'participant_done')).toBe(false);
  });

  it('returns false when reviewer requests changes', async () => {
    const text = `${PADDING}\nMissing input validation; request changes.\n## DONE`;
    const handle = makeFakeShim({ events: happyPathEvents(text) });
    const verdict = await callReviewer(handle);
    expect(verdict).toBe(false);
  });

  it('returns null on ambiguous text (no positive/negative match)', async () => {
    const text = `${PADDING} ${PADDING} the code seems consistent with the rest of the codebase.\n## DONE`;
    const handle = makeFakeShim({ events: happyPathEvents(text) });
    const verdict = await callReviewer(handle);
    expect(verdict).toBeNull();
  });

  it('returns null when stream errors with no content', async () => {
    const handle = makeFakeShim({
      events: [{ type: 'error', kind: 'quota_exhausted', message: 'limit hit' }],
    });
    const verdict = await callReviewer(handle);
    expect(verdict).toBeNull();
  });

  it('returns null when stream is silent (no message_done, no deltas)', async () => {
    const handle = makeFakeShim({ events: [] });
    const verdict = await callReviewer(handle);
    expect(verdict).toBeNull();
  });

  it('preserves streamed deltas to disk when finalText is empty', async () => {
    const text = `${PADDING}\nlgtm — ship it`;
    const handle = makeFakeShim({
      events: [
        { type: 'text_delta', text },
        { type: 'message_done', finalText: '' },
      ],
    });
    const verdict = await callReviewer(handle);
    const written = fs.readFileSync(answerFile, 'utf-8');
    expect(written).toContain('lgtm');
    expect(verdict).toBe(true);
  });

  // This test forces an EACCES on the writer's appendFileSync via chmod
  // 0o444. Root bypasses POSIX permission bits on Linux, so the test only
  // works when the test process runs as a non-root user. CI and `pnpm test`
  // (without sudo) are non-root and validate the behavior; `sudo pnpm test`
  // skips with a clear note instead of silently failing. Mocking `fs` at
  // the module level isn't an option here — Node 20+ marks fs exports
  // non-configurable, so vi.spyOn(fs, 'appendFileSync') throws.
  const isRoot =
    typeof process.getuid === 'function' && process.getuid() === 0;
  (isRoot ? it.skip : it)(
    'emits cli_warning when answer.md write fails (StreamFileWriter dies mid-stream)',
    async () => {
      // Run AFTER runReviewerHeadless's initial fs.writeFileSync(answerFile,'').
      async function* hostileStream(): AsyncIterable<{
        type: 'text_delta' | 'message_done';
        text?: string;
        finalText?: string;
      }> {
        fs.chmodSync(answerFile, 0o444);
        // Buffer crosses the flush threshold (4KB) so the synchronous
        // appendFileSync fails with EACCES, flipping the writer dead.
        yield { type: 'text_delta', text: 'x'.repeat(8192) };
        yield { type: 'message_done', finalText: '' };
      }
      const fakeShim = makeFakeShim({ events: [] });
      fakeShim.shim.runHeadless = () => hostileStream() as never;

      await callReviewer(fakeShim);

      // Restore perms so afterEach rmSync can clean up.
      try {
        fs.chmodSync(answerFile, 0o644);
      } catch {
        /* best-effort */
      }

      const warning = events.find(
        (e) =>
          e.type === 'cli_warning' &&
          (e.payload as { reason?: string }).reason === 'stream_writer_dead',
      );
      expect(warning).toBeDefined();
      const payload = warning!.payload as { role?: string; agent?: string };
      expect(payload.role).toBe('reviewer');
      expect(payload.agent).toBe('codex-cli-0');
    },
  );
});
