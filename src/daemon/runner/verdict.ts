/**
 * Reviewer-text → verdict heuristic.
 *
 * Reviewers don't return a structured boolean; they write English. This
 * tries to extract `approve / request-changes / null` from their final
 * answer.md, scanning the tail first (where verdicts typically live)
 * before falling back to the whole text. Word-boundary regex matches
 * avoid false positives like "approached" → approve.
 *
 * Returns:
 *   true   = reviewer approved
 *   false  = reviewer disagreed / requested changes
 *   null   = ambiguous (caller should treat as failed/inconclusive)
 *
 * The 80-char floor protects against `## DONE`-only answers being
 * counted as ambiguous-empty rather than auto-failures upstream.
 */
export function verdictFromReviewerText(content: string): boolean | null {
  const stripped = content.replace(/##\s*DONE\s*$/i, '').trim();

  // Contractions matter: a reviewer writing "don't approve" or "can't
  // approve" would slip past the spaced-out forms below if we only matched
  // `do not approve` / `cannot approve`. Both spellings are common in real
  // reviews. The optional `['’]?t` segment catches both straight (') and
  // typographic (’) apostrophes — LLMs emit the latter often.
  // "disagree(?:d|s|ing)?": the bare \bdisagree\b failed to match the past
  // tense — "disagreed" has no word boundary before the trailing d, so a
  // reviewer writing "I disagreed with this approach" parsed as ambiguous.
  const negatives =
    /\b(request changes|requesting changes|disagree(?:d|s|ing)?|reject(?:ed|ing)?|blocker|(?:do not|don['’]?t) (?:approve|merge)|(?:cannot|can['’]?t) (?:approve|merge)|nack)\b/;
  // "agree(?:d|s)?": the review templates describe the quorum as reviewers
  // AGREEING ("2-of-3 must agree…"), so reviewers write `## Verdict\nagreed`
  // — which the old list didn't contain. Result: every "agreed" verdict
  // parsed null → tallied as FAILED → a unanimous panel (approve + agreed +
  // agreed) produced verdict=request_changes below quorum (observed
  // 2026-07-21, appfrontend#312 panel). Negatives run first, and "disagreed"
  // can't false-positive here: \b before "agree" fails mid-word.
  const positives =
    /\b(approve(?:d|s)?|agree(?:d|s)?|lgtm|looks good to me|no concerns|ship it|ack)\b/;

  // An explicit `## Verdict` heading is authoritative — judge ONLY the
  // line(s) right under it, before any keyword scanning. Keyword scans over
  // prose are negation-blind: a review ending "…do not treat as a blocker.
  // approve" tripped \bblocker\b in the negatives (checked first) and
  // flipped an explicit approval to request_changes (observed 2026-07-21:
  // a real claude review approving with a "not a blocker" aside was
  // tallied as disagreement, dropping a unanimous panel below quorum).
  const verdictHeading = /##\s*Verdict:?\s*\n+\s*([^\n]{1,80})/i.exec(stripped);
  if (verdictHeading) {
    const line = verdictHeading[1].toLowerCase();
    if (negatives.test(line)) return false;
    if (positives.test(line)) return true;
    // Heading present but the line under it matches nothing — fall through
    // to the scans below rather than guessing.
  }

  // Neutralize NEGATED negative-phrases before scanning prose, so "no
  // blockers", "not a blocker", "zero blockers", "without blockers", "do
  // not treat (it/this) as a blocker" don't read as change-requests. The
  // replacement runs on the scan copies only — never on the stored answer.
  const neutralize = (s: string): string =>
    s.replace(
      /\b(?:no|not a|zero|without|do(?:es)? not treat (?:it |this )?as a)\s+blockers?\b/g,
      ' ',
    );

  // Check verdict keywords FIRST — a terse but explicit reply like
  // "approve ## DONE" (15 chars after sentinel strip) is unambiguous and
  // shouldn't be filtered out by the length floor. Tail wins over whole
  // so an analytical review mentioning "good practice" mid-paragraph
  // doesn't get auto-approved without an explicit verdict at the end.
  const tail = neutralize(stripped.slice(-400).toLowerCase());
  if (negatives.test(tail)) return false;
  if (positives.test(tail)) return true;

  const whole = neutralize(stripped.toLowerCase());
  if (negatives.test(whole)) return false;
  if (positives.test(whole)) return true;

  // No verdict keyword anywhere — return null (ambiguous). The 20-char
  // floor was previously applied BEFORE the regex, which dropped valid
  // terse approvals like "approve ## DONE". It's no longer needed: short
  // replies without a keyword still resolve to null here.
  return null;
}
