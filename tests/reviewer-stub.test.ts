/**
 * Stub-answer detection and single-cell retry for headless reviewers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  isStubReviewerAnswer,
  resolveStubMaxBytes,
  resolveStubRetries,
  runReviewerWithStubRetry,
  DEFAULT_REVIEWER_STUB_MAX_BYTES,
  DEFAULT_REVIEWER_STUB_RETRIES,
} from '../src/daemon/runner/reviewer-stub';

const STUB = `## Verification steps run
- **Files read:** \`(none — diff only)\`
- **Shell commands run:** \`npm run typecheck\`
- **Worktree access status:** verified

## Verdict
agreed

## Findings
(none)

## Notes for the reviewer
The typecheck command was attempted but could not execute because \`tsc\` is not installed in the checkout (\`sh: 1: tsc: not found\`); this is an environment limitation, not a source finding.

## DONE
`;

const REAL = `## Verification steps run
- **Files read:** src/a.ts, src/b.ts

## Verdict
request_changes

## Findings

### Fix before merge
- \`src/a.ts:12\` — the device-limit check reads capacity before the transaction, so two requests can both pass with one order remaining. **Fix:** reserve inside the transaction.

## DONE
`;

const SHORT_REAL_APPROVE = `## Verdict
agreed

## Findings
- \`src/a.ts:40\` — nit: unused import, harmless.

## DONE
`;

let tmp: string;
let reviewerDir: string;
let answerFile: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-stub-'));
  reviewerDir = path.join(tmp, 'reviewer-codex-cli-1');
  fs.mkdirSync(reviewerDir, { recursive: true });
  answerFile = path.join(reviewerDir, 'answer.md');
  delete process.env.CHORUS_REVIEWER_STUB_MAX_BYTES;
  delete process.env.CHORUS_REVIEWER_STUB_RETRIES;
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.CHORUS_REVIEWER_STUB_MAX_BYTES;
  delete process.env.CHORUS_REVIEWER_STUB_RETRIES;
});

describe('isStubReviewerAnswer', () => {
  it('flags a verdict-only answer whose findings are (none) and whose note names a failed verification', () => {
    expect(isStubReviewerAnswer(STUB)).toBe(true);
  });

  it('flags a verdict-only answer that is simply short', () => {
    expect(isStubReviewerAnswer('## Verdict\nagreed\n\n## Findings\n(none)\n\n## DONE\n')).toBe(true);
  });

  it('does not flag an answer with findings, however short', () => {
    expect(isStubReviewerAnswer(SHORT_REAL_APPROVE)).toBe(false);
    expect(isStubReviewerAnswer(REAL)).toBe(false);
  });

  it('does not flag an approve with real prose reasoning and no verification-failure phrase', () => {
    const prose = 'The change is a rename with no behavioural effect; every call site was traced. '.repeat(12);
    const text = `## Verdict\nagreed\n\n## Findings\n(none)\n\n## Notes for the reviewer\n${prose}\n\n## DONE\n`;
    expect(isStubReviewerAnswer(text)).toBe(false);
  });

  it('does not flag FAILED or DEGRADED answers, or answers without a verdict', () => {
    expect(isStubReviewerAnswer('## REVIEWER FAILED\n\n**Kind:** x\n')).toBe(false);
    expect(isStubReviewerAnswer('## Findings\n(none)\n')).toBe(false);
    expect(isStubReviewerAnswer('')).toBe(false);
  });

  it('honours the byte threshold from the env and ignores garbage values', () => {
    expect(resolveStubMaxBytes({})).toBe(DEFAULT_REVIEWER_STUB_MAX_BYTES);
    expect(resolveStubMaxBytes({ CHORUS_REVIEWER_STUB_MAX_BYTES: '50' })).toBe(50);
    expect(resolveStubMaxBytes({ CHORUS_REVIEWER_STUB_MAX_BYTES: '0' })).toBe(DEFAULT_REVIEWER_STUB_MAX_BYTES);
    expect(resolveStubMaxBytes({ CHORUS_REVIEWER_STUB_MAX_BYTES: '2junk' })).toBe(DEFAULT_REVIEWER_STUB_MAX_BYTES);
    const prose = 'x'.repeat(100);
    const text = `## Verdict\nagreed\n\n## Findings\n(none)\n\n## Notes\n${prose}\n`;
    expect(isStubReviewerAnswer(text, { maxBytes: 50 })).toBe(false);
    expect(isStubReviewerAnswer(text, { maxBytes: 200 })).toBe(true);
  });

  it('resolves retries from the env, allowing zero', () => {
    expect(resolveStubRetries({})).toBe(DEFAULT_REVIEWER_STUB_RETRIES);
    expect(resolveStubRetries({ CHORUS_REVIEWER_STUB_RETRIES: '3' })).toBe(3);
    expect(resolveStubRetries({ CHORUS_REVIEWER_STUB_RETRIES: '0' })).toBe(0);
    expect(resolveStubRetries({ CHORUS_REVIEWER_STUB_RETRIES: 'many' })).toBe(DEFAULT_REVIEWER_STUB_RETRIES);
  });
});

describe('runReviewerWithStubRetry', () => {
  const ctx = () => ({
    answerFile,
    reviewerDir,
    round: 1,
    lineage: 'openai',
    model: 'gpt-5.5',
    agent: 'codex-cli-1',
    chatId: 'test-chat',
  });

  it('re-runs a stub cell once and returns the retry result when it is a real answer', async () => {
    const answers = [STUB, REAL];
    const results = [true, false];
    let calls = 0;
    const retries: number[] = [];
    const out = await runReviewerWithStubRetry(
      async () => {
        fs.writeFileSync(answerFile, answers[calls]);
        return results[calls++];
      },
      { ...ctx(), onStubRetry: (a) => retries.push(a) },
    );
    expect(calls).toBe(2);
    expect(out).toBe(false);
    expect(retries).toEqual([1]);
    expect(fs.readFileSync(answerFile, 'utf-8')).toBe(REAL);
    expect(fs.existsSync(path.join(reviewerDir, 'answer.stub-1.md'))).toBe(true);
    const rows = fs
      .readFileSync(path.join(reviewerDir, '_attempts.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ errorKind: 'stub_answer', attempt: 1, retried: true, lineage: 'openai', model: 'gpt-5.5' });
  });

  it('keeps the last stub and stamps REVIEWER DEGRADED without DONE when the retry is also a stub', async () => {
    let calls = 0;
    const out = await runReviewerWithStubRetry(
      async () => {
        fs.writeFileSync(answerFile, STUB);
        calls++;
        return true;
      },
      ctx(),
    );
    expect(calls).toBe(2);
    expect(out).toBe(true);
    const written = fs.readFileSync(answerFile, 'utf-8');
    expect(written).toContain('## REVIEWER DEGRADED');
    expect(written).toContain('**Kind:** stub_answer');
    expect(written).not.toMatch(/##\s*DONE/);
    const rows = fs
      .readFileSync(path.join(reviewerDir, '_attempts.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(rows.map((r) => r.attempt)).toEqual([1, 2]);
    expect(rows[1].retried).toBe(false);
  });

  it('leaves a real answer alone and runs the cell exactly once', async () => {
    let calls = 0;
    const out = await runReviewerWithStubRetry(
      async () => {
        fs.writeFileSync(answerFile, REAL);
        calls++;
        return false;
      },
      ctx(),
    );
    expect(calls).toBe(1);
    expect(out).toBe(false);
    expect(fs.existsSync(path.join(reviewerDir, '_attempts.jsonl'))).toBe(false);
  });

  it('does not touch another cell answer file', async () => {
    const otherDir = path.join(tmp, 'reviewer-claude-code-0');
    fs.mkdirSync(otherDir);
    const otherFile = path.join(otherDir, 'answer.md');
    fs.writeFileSync(otherFile, REAL);
    await runReviewerWithStubRetry(
      async () => {
        fs.writeFileSync(answerFile, STUB);
        return true;
      },
      ctx(),
    );
    expect(fs.readFileSync(otherFile, 'utf-8')).toBe(REAL);
    expect(fs.existsSync(path.join(otherDir, '_attempts.jsonl'))).toBe(false);
  });

  it('honours CHORUS_REVIEWER_STUB_RETRIES=0 (no retry, straight to DEGRADED)', async () => {
    process.env.CHORUS_REVIEWER_STUB_RETRIES = '0';
    let calls = 0;
    await runReviewerWithStubRetry(
      async () => {
        fs.writeFileSync(answerFile, STUB);
        calls++;
        return true;
      },
      ctx(),
    );
    expect(calls).toBe(1);
    expect(fs.readFileSync(answerFile, 'utf-8')).toContain('## REVIEWER DEGRADED');
  });
});
