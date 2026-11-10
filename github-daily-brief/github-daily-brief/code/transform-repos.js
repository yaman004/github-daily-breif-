// ─────────────────────────────────────────────────────────────────────────────
// Node:  Transform Repos
// Type:  Code (JavaScript) — Mode: "Run Once for All Items"
// Input: ONE item from "Search GitHub Repos" → { total_count, incomplete_results, items: [...] }
// Output: ONE item → { generatedAt, topic, totalCount, topRepos: [5 cleaned repos], topRepo }
// Errors: throws a descriptive Error; the node's "On Error → Continue (using error output)"
//         setting routes it to the "Format Error" branch instead of failing silently.
// ─────────────────────────────────────────────────────────────────────────────

const TOP_N = 5;          // how many repositories to keep
const DESC_MAX = 200;     // max description length stored per repository
const TOPIC = 'artificial-intelligence'; // keep in sync with the `q` parameter of "Search GitHub Repos"

// ── 1. Validate the API response ─────────────────────────────────────────────
const first = $input.first();
const response = first ? first.json : null;

if (!response || typeof response !== 'object') {
  throw new Error('Transform Repos received no data from "Search GitHub Repos".');
}
if (!Array.isArray(response.items)) {
  throw new Error(
    'GitHub search response has no "items" array. Received keys: [' +
      Object.keys(response).join(', ') +
      ']. GitHub message: ' + (response.message || 'n/a')
  );
}
if (response.items.length === 0) {
  throw new Error(
    'GitHub search returned 0 repositories for topic "' + TOPIC + '". ' +
      'Check the `q` query parameter on "Search GitHub Repos".'
  );
}

// ── 2. Helpers ───────────────────────────────────────────────────────────────
const cleanText = (value, max) => {
  if (value === null || value === undefined) return '';
  let text = String(value)
    .replace(/[\u0000-\u001F\u007F]+/g, ' ') // strip control chars / newlines
    .replace(/\s+/g, ' ')                     // collapse whitespace
    .trim();
  if (max && text.length > max) {
    text = text.slice(0, max - 1).trimEnd() + '…';
  }
  return text;
};

// ── 3. Clean + normalise each repository ─────────────────────────────────────
const repos = response.items
  .filter((r) => r && r.full_name && r.html_url) // drop malformed entries
  .map((r) => ({
    name: r.name,
    fullName: r.full_name,
    owner: r.owner && r.owner.login ? r.owner.login : String(r.full_name).split('/')[0],
    repo: r.name || String(r.full_name).split('/')[1],
    description: cleanText(r.description, DESC_MAX) || 'No description provided',
    stars: Number.isFinite(Number(r.stargazers_count)) ? Number(r.stargazers_count) : 0,
    language: r.language || 'Not specified',
    url: r.html_url,
    lastPush: r.pushed_at || null,
  }));

if (repos.length === 0) {
  throw new Error('All repositories in the GitHub response were malformed (missing full_name / html_url).');
}

// ── 4. Sort by stars (desc, stable tie-break on name) and keep the top N ─────
repos.sort((a, b) => b.stars - a.stars || a.fullName.localeCompare(b.fullName));

const topRepos = repos.slice(0, TOP_N).map((r, i) => ({ rank: i + 1, ...r }));

// ── 5. Output a single item (keeps the rest of the flow linear) ──────────────
return [
  {
    json: {
      generatedAt: new Date().toISOString(),
      topic: TOPIC,
      totalCount: typeof response.total_count === 'number' ? response.total_count : null,
      topRepos,
      topRepo: topRepos[0], // highest-ranked → used by "Fetch README" and the IF node
    },
  },
];
