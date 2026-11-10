// ─────────────────────────────────────────────────────────────────────────────
// Node:  Build Digest
// Type:  Code (JavaScript) — Mode: "Run Once for All Items"
// Input: ONE item from "Fetch README". That node uses "Include Response Headers and
//        Status" + "Never Error", so the item looks like:
//          { statusCode: 200, body: { content: '<base64>', encoding: 'base64', ... } }
//        or, for a missing README: { statusCode: 404, body: { message: 'Not Found' } }
//        or, for a network failure (Continue On Fail): { error: ... }
// Output: ONE item → { topRepo, topRepos, readme: {...}, telegramText, ... }
// The repository data itself is read from "Transform Repos" because the README
// response replaces the item's JSON.
// ─────────────────────────────────────────────────────────────────────────────

const TELEGRAM_LIMIT = 4000;   // Telegram's hard limit is 4096 characters
const README_SUMMARY_MAX = 350;

const data = $('Transform Repos').first().json;
const res = $input.first() ? $input.first().json || {} : {};

// ── 1. Work out what happened with the README request ────────────────────────
const readme = { available: false, status: 'unknown', httpStatus: null, summary: '', note: '' };

const errorToText = (e) => {
  if (!e) return 'unknown error';
  if (typeof e === 'string') return e;
  return e.message || e.description || JSON.stringify(e).slice(0, 200);
};

const decodeContent = (body) => {
  if (!body || typeof body.content !== 'string') return null;
  if (body.encoding === 'base64') {
    return Buffer.from(body.content, 'base64').toString('utf-8');
  }
  return body.content;
};

try {
  if (res.error) {
    // Network error / timeout after retries (Continue On Fail output)
    readme.status = 'request_failed';
    readme.note = 'README request failed: ' + errorToText(res.error);
  } else if (res.statusCode !== undefined) {
    readme.httpStatus = res.statusCode;
    if (res.statusCode === 200) {
      const markdown = decodeContent(res.body);
      if (markdown && markdown.trim()) {
        readme.available = true;
        readme.status = 'ok';
        readme.summary = summarizeMarkdown(markdown, README_SUMMARY_MAX);
        if (!readme.summary) {
          readme.note = 'README exists but no readable text could be extracted.';
        }
      } else {
        readme.status = 'empty';
        readme.note = 'README exists but is empty.';
      }
    } else if (res.statusCode === 404) {
      readme.status = 'not_found';
      readme.note = 'This repository has no README file.';
    } else if (res.statusCode === 403 || res.statusCode === 429) {
      readme.status = 'rate_limited';
      readme.note = 'README unavailable: GitHub API rate limit or access restriction (HTTP ' + res.statusCode + ').';
    } else {
      readme.status = 'http_error';
      readme.note = 'README unavailable: GitHub returned HTTP ' + res.statusCode + '.';
    }
  } else if (typeof res.content === 'string') {
    // Defensive: response format without fullResponse
    const markdown = decodeContent(res);
    readme.available = !!markdown;
    readme.status = markdown ? 'ok' : 'empty';
    readme.summary = markdown ? summarizeMarkdown(markdown, README_SUMMARY_MAX) : '';
  } else {
    readme.status = 'unexpected_response';
    readme.note = 'README response had an unexpected shape.';
  }
} catch (err) {
  readme.available = false;
  readme.status = 'parse_error';
  readme.note = 'README could not be processed: ' + err.message;
}

// ── 2. Markdown → short plain-text summary ───────────────────────────────────
function summarizeMarkdown(md, maxLen) {
  let t = String(md).replace(/\r\n/g, '\n');
  t = t
    .replace(/<!--[\s\S]*?-->/g, ' ')            // HTML comments
    .replace(/```[\s\S]*?```/g, ' ')              // fenced code blocks
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/<[^>]+>/g, ' ')                     // raw HTML tags
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')        // images / badges
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')      // [text](url) → text
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');    // [text][ref] → text

  const paragraphs = t
    .split(/\n\s*\n/)
    .map((p) =>
      p
        .split('\n')
        .filter((line) => {
          const l = line.trim();
          return l && !/^#{1,6}\s/.test(l) && !/^[|=\-_*]{3,}$/.test(l) && !/^\|/.test(l) && !/^\[[^\]]+\]:\s/.test(l);
        })
        .join(' ')
        .replace(/[*_`>#]+/g, '')                 // leftover markdown markers
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter((p) => p.length >= 40 && p.split(' ').length >= 6); // skip nav lines / one-word fragments

  if (paragraphs.length === 0) return '';

  let summary = paragraphs[0];
  for (let i = 1; i < paragraphs.length && summary.length < maxLen * 0.6; i++) {
    summary += ' ' + paragraphs[i];
  }
  if (summary.length > maxLen) {
    summary = summary.slice(0, maxLen - 1);
    summary = summary.replace(/\s+\S*$/, '').trimEnd() + '…'; // cut on a word boundary
  }
  return summary;
}

// ── 3. Build the Telegram message (parse_mode = HTML) ────────────────────────
const esc = (s) =>
  String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const fmt = (n) => Number(n).toLocaleString('en-US');
const clip = (s, max) => (s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s);

function buildMessage(descMax, readmeMax) {
  let dateLabel;
  try {
    dateLabel = $now.toFormat('dd LLL yyyy, HH:mm');
  } catch (e) {
    dateLabel = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }

  const lines = [];
  lines.push('📰 <b>GitHub Daily Brief</b>');
  lines.push('Topic: ' + esc(data.topic) + ' · ' + esc(dateLabel));
  lines.push('');
  lines.push('🏆 <b>Top ' + data.topRepos.length + ' repositories by stars</b>');

  for (const r of data.topRepos) {
    lines.push('');
    lines.push('<b>' + r.rank + '. ' + esc(r.fullName) + '</b>');
    lines.push('⭐ ' + fmt(r.stars) + '  ·  💻 ' + esc(r.language));
    lines.push(esc(clip(r.description, descMax)));
    lines.push('🔗 ' + esc(r.url));
  }

  lines.push('');
  lines.push('📖 <b>README summary — ' + esc(data.topRepo.fullName) + '</b>');
  if (readme.available && readme.summary) {
    lines.push(esc(clip(readme.summary, readmeMax)));
  } else {
    lines.push('<i>' + esc(readme.note || 'README summary not available.') + '</i>');
  }
  return lines.join('\n');
}

// Try normal sizes first, then progressively shorter if Telegram's limit would be exceeded.
let telegramText = buildMessage(140, README_SUMMARY_MAX);
if (telegramText.length > TELEGRAM_LIMIT) telegramText = buildMessage(80, 220);
if (telegramText.length > TELEGRAM_LIMIT) telegramText = buildMessage(50, 120);

// ── 4. Output ────────────────────────────────────────────────────────────────
return [
  {
    json: {
      generatedAt: data.generatedAt,
      topic: data.topic,
      topRepo: data.topRepo,       // IF node checks topRepo.stars
      topRepos: data.topRepos,
      readme,
      telegramText,
      telegramTextLength: telegramText.length,
    },
  },
];
