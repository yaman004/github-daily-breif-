// ─────────────────────────────────────────────────────────────────────────────
// Node:  Log Fallback
// Type:  Code (JavaScript) — Mode: "Run Once for All Items"
// Runs on the FALSE branch of "Stars > 1000?" (top repository has 1,000 stars or fewer).
// No Telegram notification is sent; instead a structured log entry is written to the
// n8n server console AND returned as the node output so it is visible in the
// execution view (useful as a screenshot for the assessment).
// ─────────────────────────────────────────────────────────────────────────────

const THRESHOLD = 1000; // must match the IF node's right-hand value

const input = $input.first().json;
const top = input.topRepo || {};

const entry = {
  level: 'INFO',
  event: 'digest_suppressed_below_threshold',
  message:
    'Top repository "' + (top.fullName || 'unknown') + '" has ' + (top.stars ?? 'unknown') +
    ' stars, which is not more than ' + THRESHOLD + '. No Telegram digest was sent.',
  threshold: THRESHOLD,
  topRepo: {
    fullName: top.fullName || null,
    stars: top.stars ?? null,
    language: top.language || null,
    url: top.url || null,
  },
  readmeStatus: input.readme ? input.readme.status : 'unknown',
  checkedAt: new Date().toISOString(),
};

console.log('[GitHub Daily Brief] ' + JSON.stringify(entry));

return [{ json: entry }];
