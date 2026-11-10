// Offline tests for the Code nodes + static checks of the workflow JSON.
// IMPORTANT: this uses SYNTHETIC (mock) data and mocked n8n globals. It is NOT an n8n execution
// and does not call GitHub or Telegram. Run:  node tests/run-tests.js
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

let passed = 0;
let failed = 0;
const check = (name, cond, extra) => {
  if (cond) {
    passed++;
    console.log('  ✓ ' + name);
  } else {
    failed++;
    console.log('  ✗ ' + name + (extra ? '\n      ' + extra : ''));
  }
};

// ── Mock n8n runtime for Code nodes ──────────────────────────────────────────
async function runCode(file, { items = [], nodes = {}, prevNode = { name: 'Test' } } = {}) {
  const code = fs.readFileSync(path.join(root, 'code', file), 'utf8');
  const wrap = (arr) => ({ first: () => arr[0], last: () => arr[arr.length - 1], all: () => arr });
  const $input = wrap(items);
  const $ = (name) => {
    if (!(name in nodes)) throw new Error('Mock: node "' + name + '" has no data');
    return wrap([{ json: nodes[name] }]);
  };
  const $now = { toFormat: () => '09 Nov 2026, 22:54' };
  const $execution = { id: 'mock-123' };
  const logs = [];
  const mockConsole = { log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) };
  const fn = new AsyncFunction('$input', '$', '$now', '$prevNode', '$execution', 'console', code);
  const result = await fn($input, $, $now, prevNode, $execution, mockConsole);
  return { result, logs };
}
const throwsMsg = async (p) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e.message;
  }
};

// ── Synthetic GitHub search response (shape follows GitHub's documented schema) ──
function mockSearchResponse() {
  const items = [];
  const starValues = [152, 98000, 4300, 1001, 1000, 77, 250000, 15000, 999, 31000, 560, 12];
  starValues.forEach((s, i) => {
    items.push({
      id: i + 1,
      name: 'repo-' + i,
      full_name: 'owner' + i + '/repo-' + i,
      owner: { login: 'owner' + i },
      html_url: 'https://github.com/owner' + i + '/repo-' + i,
      description: i === 6 ? 'A <b>great</b> & "tricky"\n\ndescription ' + 'x'.repeat(400) : i === 1 ? null : 'Description ' + i,
      stargazers_count: s,
      language: i === 2 ? null : 'Python',
      pushed_at: '2026-11-01T10:00:00Z',
    });
  });
  items.push({ id: 99, name: 'broken', full_name: 'x/broken', stargazers_count: 5 }); // malformed: no html_url
  return { total_count: 123456, incomplete_results: false, items };
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/(.{60})/g, '$1\n'); // GitHub wraps base64 with \n

const SAMPLE_README = `<h1 align="center"><img src="logo.png"></h1>
<p align="center"><a href="x"><img src="badge.svg"></a></p>

[![Build](https://img.shields.io/b.svg)](https://ci) [![License](https://img.shields.io/l.svg)](LICENSE)

# Awesome AI Toolkit

## Table of Contents
- [Install](#install)

**Awesome AI Toolkit** is a *fast*, modular library for building machine-learning pipelines, with first-class support for [transformers](https://example.com) and <b>vector search</b>.

It ships with batteries included: tokenizers, trainers, evaluation tools and a plugin system for custom components.

\`\`\`bash
pip install awesome-ai
\`\`\`

| col | col |
|-----|-----|
| a   | b   |
`;

(async () => {
  // ═══ 1. Transform Repos ════════════════════════════════════════════════════
  console.log('\nTransform Repos');
  {
    const { result } = await runCode('transform-repos.js', { items: [{ json: mockSearchResponse() }] });
    const out = result[0].json;
    check('returns exactly one item', result.length === 1);
    check('top 5 repositories returned', out.topRepos.length === 5);
    const stars = out.topRepos.map((r) => r.stars);
    check('sorted by stars descending', JSON.stringify(stars) === JSON.stringify([250000, 98000, 31000, 15000, 4300]), JSON.stringify(stars));
    check('ranks are 1..5', out.topRepos.map((r) => r.rank).join() === '1,2,3,4,5');
    check('topRepo is the highest-starred repo', out.topRepo.fullName === 'owner6/repo-6' && out.topRepo.rank === 1);
    check('malformed entry (no html_url) dropped', !out.topRepos.some((r) => r.fullName === 'x/broken'));
    check('newlines collapsed + description truncated to ≤200 chars', !/\n/.test(out.topRepo.description) && out.topRepo.description.length <= 200);
    check('null description → fallback text', out.topRepos[1].description === 'No description provided');
    check('null language → "Not specified"', out.topRepos.find((r) => r.fullName === 'owner2/repo-2').language === 'Not specified');
    check('owner/repo fields present for README URL', out.topRepo.owner === 'owner6' && out.topRepo.repo === 'repo-6');
    check('stars are numbers', out.topRepos.every((r) => typeof r.stars === 'number'));
    check('totalCount carried through', out.totalCount === 123456);
  }
  {
    const m1 = await throwsMsg(runCode('transform-repos.js', { items: [{ json: { total_count: 0, items: [] } }] }));
    check('empty items → descriptive error', m1 && /0 repositories/.test(m1), m1);
    const m2 = await throwsMsg(runCode('transform-repos.js', { items: [{ json: { message: 'API rate limit exceeded' } }] }));
    check('missing items → descriptive error incl. GitHub message', m2 && /no "items"/.test(m2) && /rate limit/.test(m2), m2);
    const m3 = await throwsMsg(runCode('transform-repos.js', { items: [] }));
    check('no input item → error', !!m3, m3);
  }

  // Build the "Transform Repos" output once for the next tests
  const transformed = (await runCode('transform-repos.js', { items: [{ json: mockSearchResponse() }] })).result[0].json;
  const digestNodes = { 'Transform Repos': transformed };

  // ═══ 2. Build Digest ═══════════════════════════════════════════════════════
  console.log('\nBuild Digest');
  {
    const readmeRes = { statusCode: 200, body: { encoding: 'base64', content: b64(SAMPLE_README) } };
    const { result } = await runCode('build-digest.js', { items: [{ json: readmeRes }], nodes: digestNodes });
    const o = result[0].json;
    check('README 200 → available + status ok', o.readme.available === true && o.readme.status === 'ok');
    check('summary starts with the first real paragraph', /^Awesome AI Toolkit is a fast, modular library/.test(o.readme.summary), o.readme.summary);
    check('summary has no markdown / HTML / badge noise', !/[*`<>\[\]]|shields|pip install|\|/.test(o.readme.summary), o.readme.summary);
    check('summary ≤ 350 chars', o.readme.summary.length <= 350, String(o.readme.summary.length));
    const t = o.telegramText;
    check('message includes all 5 repo names', transformed.topRepos.every((r) => t.includes(r.fullName)));
    check('message includes URLs, stars, language', t.includes('https://github.com/owner6/repo-6') && t.includes('250,000') && t.includes('Python'));
    check('message includes README summary heading', t.includes('README summary'));
    check('HTML special characters escaped', t.includes('A &lt;b&gt;great&lt;/b&gt; &amp; &quot;tricky&quot;') && !/<b>great/.test(t));
    check('message ≤ 4096 chars', t.length <= 4096, String(t.length));
    check('topRepo.stars preserved for IF node', o.topRepo.stars === 250000);
  }
  {
    const { result } = await runCode('build-digest.js', { items: [{ json: { statusCode: 404, body: { message: 'Not Found' } } }], nodes: digestNodes });
    const o = result[0].json;
    check('README 404 → handled gracefully (no throw)', o.readme.status === 'not_found' && o.readme.available === false);
    check('404 note appears in message', o.telegramText.includes('no README'));
    check('digest still contains repo data on 404', o.telegramText.includes('owner6/repo-6'));
  }
  {
    const { result } = await runCode('build-digest.js', { items: [{ json: { statusCode: 403, body: { message: 'rate limit' } } }], nodes: digestNodes });
    check('README 403 → rate_limited note', result[0].json.readme.status === 'rate_limited' && /rate limit/i.test(result[0].json.readme.note));
  }
  {
    const { result } = await runCode('build-digest.js', { items: [{ json: { statusCode: 500, body: {} } }], nodes: digestNodes });
    check('README 500 → http_error note', result[0].json.readme.status === 'http_error' && /HTTP 500/.test(result[0].json.readme.note));
  }
  {
    const { result } = await runCode('build-digest.js', { items: [{ json: { error: { message: 'getaddrinfo ENOTFOUND api.github.com' } } }], nodes: digestNodes });
    check('network failure (Continue On Fail item) → request_failed', result[0].json.readme.status === 'request_failed' && /ENOTFOUND/.test(result[0].json.readme.note));
  }
  {
    const { result } = await runCode('build-digest.js', { items: [{ json: { statusCode: 200, body: { encoding: 'base64', content: '' } } }], nodes: digestNodes });
    check('empty README → status empty', result[0].json.readme.status === 'empty');
  }
  {
    const long = { statusCode: 200, body: { encoding: 'base64', content: b64('Long paragraph text here for testing the limit. '.repeat(100)) } };
    const big = JSON.parse(JSON.stringify(transformed));
    big.topRepos.forEach((r) => (r.description = 'D'.repeat(200)));
    const { result } = await runCode('build-digest.js', { items: [{ json: long }], nodes: { 'Transform Repos': big } });
    check('long content still ≤ 4096 chars', result[0].json.telegramText.length <= 4096, String(result[0].json.telegramText.length));
  }

  // ═══ 3. Log Fallback ═══════════════════════════════════════════════════════
  console.log('\nLog Fallback');
  {
    const lowRepo = { fullName: 'a/b', stars: 800, language: 'Go', url: 'https://github.com/a/b' };
    const { result, logs } = await runCode('log-fallback.js', { items: [{ json: { topRepo: lowRepo, readme: { status: 'ok' } } }] });
    const e = result[0].json;
    check('structured log entry returned', e.event === 'digest_suppressed_below_threshold' && e.topRepo.stars === 800 && e.threshold === 1000);
    check('message explains reason', /800 stars/.test(e.message));
    check('console log written', logs.length === 1 && logs[0].startsWith('[GitHub Daily Brief]'));
  }

  // ═══ 4. Format Error ═══════════════════════════════════════════════════════
  console.log('\nFormat Error');
  {
    const r = (await runCode('format-error.js', { prevNode: { name: 'Search GitHub Repos' }, items: [{ json: { error: { message: 'Forbidden - perhaps check your credentials?', httpCode: '403', description: 'API rate limit exceeded' } } }] })).result[0].json;
    check('stage identified from $prevNode', r.stage === 'Search GitHub Repos');
    check('403 → rate-limit hint', /rate limit/i.test(r.hint));
    check('status captured', String(r.httpStatus) === '403');
    check('alert text has stage, error, hint, execution id', ['Stage: Search GitHub Repos', 'Error: Forbidden', 'Hint:', 'Execution ID: mock-123'].every((s) => r.telegramText.includes(s)));
  }
  {
    const r = (await runCode('format-error.js', { prevNode: { name: 'Transform Repos' }, items: [{ json: { error: 'GitHub search returned 0 repositories for topic "x".' } }] })).result[0].json;
    check('string error handled', r.stage === 'Transform Repos' && /0 repositories/.test(r.errorMessage));
    check('0-repositories hint', /search query/i.test(r.hint));
  }
  {
    const r = (await runCode('format-error.js', { prevNode: { name: 'Send Daily Digest' }, items: [{ json: { error: { message: 'Bad Request: chat not found', httpCode: 400 } } }] })).result[0].json;
    check('Telegram chat-not-found hint', /chat id/i.test(r.hint));
  }
  {
    const r = (await runCode('format-error.js', { prevNode: { name: 'Search GitHub Repos' }, items: [{ json: { error: { message: 'connect ETIMEDOUT 140.82.112.5:443' } } }] })).result[0].json;
    check('network timeout hint', /network/i.test(r.hint));
  }
  {
    const r = (await runCode('format-error.js', { items: [{ json: { error: { message: 'Request failed with status code 502' } } }], prevNode: null })).result[0].json;
    check('missing $prevNode → "unknown node", status parsed from message', r.stage === 'unknown node' && String(r.httpStatus) === '502');
  }
  {
    const r = (await runCode('format-error.js', { prevNode: { name: 'Send Daily Digest' }, items: [{ json: { error: { message: 'failed calling https://api.telegram.org/bot123456789:ABCdefGHIjklMNOpqrsTUVwxyz0123456789/sendMessage' } } }] })).result[0].json;
    check('bot token redacted from error text', !/123456789:ABC/.test(r.telegramText) && /bot<redacted>/.test(r.telegramText));
  }
  {
    const r = (await runCode('format-error.js', { prevNode: { name: 'X' }, items: [{ json: {} }] })).result[0].json;
    check('empty error object → fallback message (no crash)', typeof r.telegramText === 'string' && r.errorMessage.length > 0);
  }

  // ═══ 5. Workflow JSON static checks ════════════════════════════════════════
  console.log('\nWorkflow JSON');
  const raw = fs.readFileSync(path.join(root, 'github-daily-brief.workflow.json'), 'utf8');
  let wf;
  try {
    wf = JSON.parse(raw);
    check('valid JSON', true);
  } catch (e) {
    check('valid JSON', false, e.message);
    process.exit(1);
  }
  const names = wf.nodes.map((n) => n.name);
  check('node names unique', new Set(names).size === names.length);
  check('node ids unique', new Set(wf.nodes.map((n) => n.id)).size === wf.nodes.length);
  check('every node has position [x,y]', wf.nodes.every((n) => Array.isArray(n.position) && n.position.length === 2));
  const targetsOk = Object.entries(wf.connections).every(
    ([src, c]) => names.includes(src) && c.main.every((outs) => outs.every((l) => names.includes(l.node)))
  );
  check('all connection sources/targets exist', targetsOk);

  const node = (n) => wf.nodes.find((x) => x.name === n);
  const allowedTypes = new Set(['n8n-nodes-base.scheduleTrigger', 'n8n-nodes-base.httpRequest', 'n8n-nodes-base.code', 'n8n-nodes-base.if', 'n8n-nodes-base.telegram', 'n8n-nodes-base.stickyNote']);
  check('only known core node types used', wf.nodes.every((n) => allowedTypes.has(n.type)));
  check('trigger is Schedule Trigger, every 1 hour', node('Schedule Trigger').parameters.rule.interval[0].field === 'hours' && node('Schedule Trigger').parameters.rule.interval[0].hoursInterval === 1);
  check('search = GET api.github.com/search/repositories', node('Search GitHub Repos').parameters.method === 'GET' && node('Search GitHub Repos').parameters.url === 'https://api.github.com/search/repositories');
  check('README = GET /repos/{owner}/{repo}/readme', /^=https:\/\/api\.github\.com\/repos\/\{\{ \$json\.topRepo\.owner \}\}\/\{\{ \$json\.topRepo\.repo \}\}\/readme$/.test(node('Fetch README').parameters.url));
  const cond = node('Stars > 1000?').parameters.conditions.conditions[0];
  check('IF = number "gt" 1000 on topRepo.stars', cond.operator.type === 'number' && cond.operator.operation === 'gt' && cond.rightValue === 1000 && /topRepo\.stars/.test(cond.leftValue));
  const ifc = wf.connections['Stars > 1000?'].main;
  check('IF true → Send Daily Digest, false → Log Fallback', ifc[0][0].node === 'Send Daily Digest' && ifc[1][0].node === 'Log Fallback');
  check('HTTP search uses error output (index 1 → Format Error)', node('Search GitHub Repos').onError === 'continueErrorOutput' && wf.connections['Search GitHub Repos'].main[1][0].node === 'Format Error');
  check('README fetch continues on fail', node('Fetch README').onError === 'continueRegularOutput');
  check('Transform / Build Digest / Send Daily Digest route errors to Format Error', ['Transform Repos', 'Build Digest', 'Send Daily Digest'].every((n) => node(n).onError === 'continueErrorOutput' && wf.connections[n].main[1][0].node === 'Format Error'));
  check('Send Error Alert has NO continue-on-fail (failures stay loud)', !node('Send Error Alert').onError && !node('Send Error Alert').continueOnFail);
  check('Telegram nodes reference a credential, none hardcoded', ['Send Daily Digest', 'Send Error Alert'].every((n) => node(n).credentials && node(n).credentials.telegramApi));
  check('no Telegram token / secret patterns in JSON', !/\d{6,}:[A-Za-z0-9_-]{30,}/.test(raw) && !/ghp_|github_pat_|Bearer /.test(raw));
  check('every expression has balanced {{ }}', (raw.match(/\{\{/g) || []).length === (raw.match(/\}\}/g) || []).length);

  // Code in JSON == code on disk, and every Code node compiles
  const codeFiles = { 'Transform Repos': 'transform-repos.js', 'Build Digest': 'build-digest.js', 'Log Fallback': 'log-fallback.js', 'Format Error': 'format-error.js' };
  for (const [n, f] of Object.entries(codeFiles)) {
    const disk = fs.readFileSync(path.join(root, 'code', f), 'utf8');
    check(n + ': embedded code matches code/' + f, node(n).parameters.jsCode === disk);
    let ok = true;
    try {
      new AsyncFunction('$input', '$', '$now', '$prevNode', '$execution', 'console', node(n).parameters.jsCode);
    } catch (e) {
      ok = false;
      console.log('      ' + e.message);
    }
    check(n + ': JavaScript compiles', ok);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
