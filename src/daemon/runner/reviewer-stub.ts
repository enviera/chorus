/**
 * Stub-answer detection and single-cell retry for headless reviewers.
 *
 * A reviewer cell can "complete" with an answer that carries a verdict and
 * nothing else — `## Findings` is `(none)` and the only prose is a note that a
 * verification command could not run (`tsc: not found`, "could not execute").
 * Downstream that reads as a clean approve, and a panel rule that treats a
 * repeated stub as a structural failure then discards every other cell's
 * work. The cheap remedy is to re-run just the stub cell, once, before it
 * counts as submitted; a second stub is kept but marked DEGRADED so nothing
 * mistakes it for a considered review.
 */
import * as fs from 'fs';
import * as path from 'path';

export const DEFAULT_REVIEWER_STUB_MAX_BYTES = 600;
export const DEFAULT_REVIEWER_STUB_RETRIES = 1;

/** Phrases that, with no findings, mean the reviewer stopped at a failed verification step. */
const VERIFICATION_FAILURE_MARKERS = [
  'not installed',
  'could not execute',
  'command not found',
  'no such file',
];

function positiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number.parseInt(trimmed, 10);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** Bytes below which a findings-free answer counts as a stub. */
export function resolveStubMaxBytes(env: Record<string, string | undefined> = process.env): number {
  const n = positiveInt(env.CHORUS_REVIEWER_STUB_MAX_BYTES);
  return n !== undefined && n > 0 ? n : DEFAULT_REVIEWER_STUB_MAX_BYTES;
}

/** How many times a stub cell is re-run before it is accepted as degraded. */
export function resolveStubRetries(env: Record<string, string | undefined> = process.env): number {
  const n = positiveInt(env.CHORUS_REVIEWER_STUB_RETRIES);
  return n !== undefined ? n : DEFAULT_REVIEWER_STUB_RETRIES;
}

/** Text of a `## Heading` section up to the next `## ` heading. */
function section(text: string, heading: RegExp): string | undefined {
  const lines = text.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (heading.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return undefined;
  const body: string[] = [];
  for (let i = start; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join('\n').trim();
}

function hasFindings(text: string): boolean {
  const findings = section(text, /^##\s*Findings\b/i);
  if (findings === undefined) {
    // No Findings section at all: treat prose length as the signal.
    return false;
  }
  const stripped = findings
    .replace(/\(none\)/gi, '')
    .replace(/^none\.?$/gim, '')
    .replace(/[-*]\s*$/gm, '')
    .trim();
  return stripped.length > 0;
}

/**
 * True when the answer is a verdict-only stub: a verdict is present, the
 * findings section is empty, and either the remaining body is shorter than
 * the byte threshold or it names a failed verification step. An answer with
 * findings is never a stub, however short; an answer without a verdict is not
 * a stub either (it is an ordinary failure the existing paths handle).
 */
export function isStubReviewerAnswer(
  text: string,
  opts: { maxBytes?: number } = {},
): boolean {
  if (!text || text.trim().length === 0) return false;
  if (/##\s*REVIEWER (FAILED|DEGRADED)/i.test(text)) return false;
  const verdict = section(text, /^##\s*Verdict\b/i);
  if (verdict === undefined || verdict.length === 0) return false;
  if (hasFindings(text)) return false;

  // Body minus the mechanical sections: verification log, verdict, findings.
  const body = text
    .replace(/^##\s*Verification steps run\b[\s\S]*?(?=^##\s|(?![\s\S]))/im, '')
    .replace(/^##\s*Verdict\b[\s\S]*?(?=^##\s|(?![\s\S]))/im, '')
    .replace(/^##\s*Findings\b[\s\S]*?(?=^##\s|(?![\s\S]))/im, '')
    .replace(/^##\s*DONE\s*$/im, '')
    .trim();

  const maxBytes = opts.maxBytes ?? resolveStubMaxBytes();
  if (Buffer.byteLength(body, 'utf-8') < maxBytes) return true;
  const lower = body.toLowerCase();
  return VERIFICATION_FAILURE_MARKERS.some((m) => lower.includes(m));
}

export interface StubRetryContext {
  answerFile: string;
  reviewerDir: string;
  round: number;
  lineage: string;
  model?: string;
  /** e.g. `codex-cli-1`, used in log lines. */
  agent: string;
  chatId: string;
  retries?: number;
  maxBytes?: number;
  /** Optional hook for a `cli_warning`-style notification per retry. */
  onStubRetry?: (attempt: number, remaining: number) => void;
}

function appendAttempt(reviewerDir: string, row: Record<string, unknown>): void {
  try {
    fs.appendFileSync(
      path.join(reviewerDir, '_attempts.jsonl'),
      JSON.stringify(row) + '\n',
    );
  } catch {
    /* best-effort diagnostics */
  }
}

function readAnswer(answerFile: string): string {
  try {
    return fs.existsSync(answerFile) ? fs.readFileSync(answerFile, 'utf-8') : '';
  } catch {
    return '';
  }
}

/**
 * Run one reviewer cell, re-running it while its answer is a stub and retries
 * remain. Every stub attempt is recorded in `_attempts.jsonl` as
 * `errorKind: "stub_answer"` and the stub text is preserved as
 * `answer.stub-<n>.md` so the retry's fresh answer.md does not erase the
 * evidence. If the last attempt is still a stub, its answer is kept and a
 * `## REVIEWER DEGRADED` block (no `## DONE`) is appended so the verdict is
 * read as degraded rather than as a clean review. The verdict result of the
 * final attempt is returned unchanged; quorum logic is not touched here.
 */
export async function runReviewerWithStubRetry<T>(
  runOnce: () => Promise<T>,
  ctx: StubRetryContext,
): Promise<T> {
  const retries = ctx.retries ?? resolveStubRetries();
  const maxBytes = ctx.maxBytes ?? resolveStubMaxBytes();
  let result = await runOnce();
  let attempt = 0;
  for (;;) {
    const text = readAnswer(ctx.answerFile);
    if (!isStubReviewerAnswer(text, { maxBytes })) return result;
    attempt += 1;
    const sizeBytes = Buffer.byteLength(text, 'utf-8');
    appendAttempt(ctx.reviewerDir, {
      ts: Date.now(),
      round: ctx.round,
      lineage: ctx.lineage,
      model: ctx.model ?? null,
      errorKind: 'stub_answer',
      errorMessage: `verdict-only answer (${sizeBytes} bytes, no findings)`,
      attempt,
      retried: attempt <= retries,
    });
    if (attempt > retries) {
      // Out of retries: keep the stub but say so where the verdict is read.
      if (!/##\s*REVIEWER DEGRADED/i.test(text)) {
        const stripped = text.replace(/\n##\s*DONE\s*\n?$/i, '\n');
        try {
          fs.writeFileSync(
            ctx.answerFile,
            (stripped.endsWith('\n') ? stripped : stripped + '\n') +
              `\n## REVIEWER DEGRADED\n` +
              `**Kind:** stub_answer\n` +
              `**Lineage:** ${ctx.lineage}\n` +
              `**Model:** ${ctx.model ?? '(default)'}\n` +
              `\nThe reviewer returned a verdict with no findings ${attempt} time(s); ` +
              `the last answer is kept above but should not be read as a considered review.\n`,
          );
        } catch {
          /* best-effort */
        }
      }
      console.warn(
        `[reviewer] stub answer kept as degraded chat=${ctx.chatId} round=${ctx.round} ` +
          `slot=${ctx.agent} lineage=${ctx.lineage} model=${ctx.model ?? '(default)'} attempts=${attempt}`,
      );
      return result;
    }
    // Preserve the stub, then re-run the same cell with a fresh answer file.
    try {
      fs.copyFileSync(ctx.answerFile, path.join(ctx.reviewerDir, `answer.stub-${attempt}.md`));
    } catch {
      /* best-effort */
    }
    console.warn(
      `[reviewer] stub answer retry chat=${ctx.chatId} round=${ctx.round} ` +
        `slot=${ctx.agent} lineage=${ctx.lineage} model=${ctx.model ?? '(default)'} ` +
        `attempt=${attempt} remaining=${retries - attempt}`,
    );
    ctx.onStubRetry?.(attempt, retries - attempt);
    result = await runOnce();
  }
}
