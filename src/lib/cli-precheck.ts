/**
 * Pre-spawn CLI health check.
 *
 * Runs before each CLI subprocess spawn (doer or reviewer) to short-circuit
 * three classes of doomed runs:
 *   1. Quota already exhausted (cli-health.ts has a recent resetAt in the
 *      future). Spawning would just hit the same wall in 5–10 seconds and
 *      burn UI time.
 *   2. CLI not logged in / cred file missing. Spawning would emit either a
 *      cold_start_timeout or token_refresh_lost from the pane scraper after
 *      we already paid the spawn tax (~3-5s for tmux/headless boot).
 *   3. CLI binary not present (handled at boot by `cli-detect`; we just
 *      mention it here for completeness — not re-checked per spawn).
 *
 * Deliberately cheap: no network calls. We check filesystem state + the
 * existing health record. A real network probe (ping `/v1/models` with the
 * stored bearer to confirm token validity) is the natural next layer; for
 * v0.7 the file-existence check catches "user logged out 3 days ago" which
 * is the highest-frequency failure mode.
 *
 * Returns:
 *   - { ok: true } → proceed with spawn
 *   - { ok: false, reason, cta } → skip spawn, runner emits cli_warning
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { getHealth, type CliLineage } from './cli-health';

export type PrecheckFailReason =
  | 'quota_exhausted'
  | 'auth_missing'
  | 'auth_unreadable';

export type PrecheckResult =
  | { ok: true }
  | { ok: false; reason: PrecheckFailReason; message: string; cta: string; resetAt?: number };

/**
 * Per-lineage credential file we treat as "user is logged in." Each CLI
 * stores its OAuth bearer somewhere different; if the file doesn't exist
 * the user almost certainly hasn't run the CLI's login command. False
 * positives are possible (some users move credential dirs via env), so we
 * only fail-closed when the file is *missing or unreadable* — never on
 * shape mismatches inside the file.
 */
const CRED_PATHS: Record<CliLineage, () => string[]> = {
  anthropic: () => [
    path.join(os.homedir(), '.claude', '.credentials.json'),
    path.join(os.homedir(), '.config', 'anthropic', 'claude.json'),
  ],
  openai: () => [
    path.join(os.homedir(), '.codex', 'auth.json'),
  ],
  google: () => [
    path.join(os.homedir(), '.gemini', 'oauth_creds.json'),
    path.join(os.homedir(), '.config', 'gemini', 'oauth_creds.json'),
  ],
  opencode: () => [
    path.join(os.homedir(), '.opencode', 'auth.json'),
    path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json'),
  ],
  moonshot: () => [
    path.join(os.homedir(), '.kimi', 'auth.json'),
    // OpenCode stores its auth in two places depending on install path. The
    // kimi shim delegates to `opencode --model opencode-go/kimi-k2.6` when
    // the requested model carries the opencode-go/ prefix, so a moonshot
    // voice routed via opencode is actually authed by opencode's creds —
    // not the kimi-cli ones. Both opencode candidates accepted here.
    path.join(os.homedir(), '.opencode', 'auth.json'),
    path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json'),
  ],
  // OpenRouter has no on-disk credential file — its API key lives in
  // the secrets table. The shim itself returns auth_missing when the
  // key is unset, which surfaces the same UX without a file probe.
  openrouter: () => [],
};

/**
 * Env-var credentials each lineage's CLI accepts INSTEAD OF an on-disk
 * credential file. When one of these is set the CLI authenticates directly
 * from the environment — there is no `login` command to run and no file to
 * probe — so the file/Keychain check below would fail-closed on perfectly
 * valid auth.
 *
 * This is exactly how the orchestrator session pods authenticate: the pod
 * exports ANTHROPIC_AUTH_TOKEN (+ ANTHROPIC_BASE_URL) to point the `claude`
 * CLI at the GLM/z.ai endpoint, with no `claude login` and no
 * `.credentials.json`. The main agent runs on that auth successfully, so the
 * reviewers spawned in the same pod must accept it too — otherwise the review
 * engine reports "not logged in (no credential file found)" and returns
 * no_review despite working credentials sitting in the environment.
 */
const ENV_AUTH_VARS: Record<CliLineage, readonly string[]> = {
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  openai: ['OPENAI_API_KEY'],
  google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  // ZAI_CODING_TOKEN: a custom opencode provider (OPENCODE_CONFIG) can
  // authenticate via `{env:ZAI_CODING_TOKEN}` in its headers (the z.ai
  // coding-plan gateway) — no auth.json involved. Without recognizing it,
  // precheck rejects the zai/glm voice as auth_missing even though the
  // provider works ("opencode models" lists it fine).
  opencode: ['OPENCODE_API_KEY', 'ZAI_CODING_TOKEN'],
  moonshot: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
};

function hasEnvAuth(lineage: CliLineage): boolean {
  const vars = ENV_AUTH_VARS[lineage] ?? [];
  return vars.some((v) => {
    const val = process.env[v];
    return typeof val === 'string' && val.trim().length > 0;
  });
}

const LOGIN_HINT: Record<CliLineage, string> = {
  anthropic: 'Run `claude login` in a terminal.',
  openai: 'Run `codex login` in a terminal.',
  google: 'Run `gemini` once interactively to complete OAuth.',
  opencode: 'Run `opencode auth login` in a terminal.',
  moonshot: 'Run `kimi` once interactively, or set up opencode if you use the kimi-via-opencode transport.',
  openrouter: 'Save an OpenRouter API key on the Connect page.',
};

/**
 * Claude Code v2+ stores OAuth credentials in the macOS Keychain instead of a
 * file on disk. Probe the Keychain for existence only (no `-w` flag — avoids
 * ACL prompts in headless contexts). Returns false on non-macOS platforms.
 */
const KEYCHAIN_SERVICES: Partial<Record<CliLineage, string>> = {
  anthropic: 'Claude Code-credentials',
};

export function hasKeychainEntry(lineage: CliLineage): boolean {
  if (process.platform !== 'darwin') return false;
  const service = KEYCHAIN_SERVICES[lineage];
  if (!service) return false;
  try {
    execFileSync('security', ['find-generic-password', '-s', service], {
      stdio: 'ignore',
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether at least one of the candidate credential paths for `lineage`
 * exists and is readable. Existence-only — we don't parse contents (each CLI
 * has its own JSON shape and bearer-refresh lifecycle, neither of which we
 * want to couple to). Readable-but-empty counts as missing.
 */
function hasCredFile(lineage: CliLineage): { exists: boolean; tried: string[] } {
  const candidates = CRED_PATHS[lineage]();
  for (const p of candidates) {
    try {
      const stat = fs.statSync(p);
      if (stat.isFile() && stat.size > 0) {
        return { exists: true, tried: candidates };
      }
    } catch {
      // ENOENT or perm-denied — try next candidate
    }
  }
  return { exists: false, tried: candidates };
}

export async function precheckLineage(lineage: CliLineage): Promise<PrecheckResult> {
  // Layer 1: quota state from cli-health (populated reactively when the
  // error-detector observes a quota_exhausted pane). If a previous run
  // tripped the limit and the reset hasn't elapsed, skip the spawn.
  const health = await getHealth(lineage);
  if (health.status === 'quota_exhausted') {
    const now = Date.now();
    if (typeof health.resetAt === 'number' && health.resetAt > now) {
      const minsLeft = Math.ceil((health.resetAt - now) / 60_000);
      return {
        ok: false,
        reason: 'quota_exhausted',
        message: `${lineage} quota still exhausted (resets in ~${minsLeft} min).`,
        cta: 'Wait for reset, switch account, or disable this voice.',
        resetAt: health.resetAt,
      };
    }
    // resetAt missing or already past — fall through and let the spawn try.
    // Stale health markers self-clear when a successful run records 'healthy'.
  }

  // OpenRouter has no on-disk creds — the shim itself errors with
  // auth_missing when the secrets-table key is absent. Skip the file probe.
  if (lineage === 'openrouter') {
    return { ok: true };
  }

  // Layer 1.5: env-var auth. If the CLI's API-key / auth-token env var is set,
  // the CLI authenticates straight from the environment — there is no login
  // command and no credential file to find, so the file/Keychain probe below
  // would fail-closed on valid auth. This is how the orchestrator GLM pods
  // run (ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL → GLM endpoint).
  if (hasEnvAuth(lineage)) {
    return { ok: true };
  }

  // Layer 2: credential file presence. Cheap, catches "logged out" without
  // paying the spawn tax. See CRED_PATHS for the per-CLI lookups.
  // Falls back to macOS Keychain for CLIs that store creds there (Claude Code v2+).
  const cred = hasCredFile(lineage);
  if (!cred.exists && !hasKeychainEntry(lineage)) {
    return {
      ok: false,
      reason: 'auth_missing',
      message: `${lineage} CLI is not logged in (no credential file found).`,
      cta: LOGIN_HINT[lineage],
    };
  }

  return { ok: true };
}
