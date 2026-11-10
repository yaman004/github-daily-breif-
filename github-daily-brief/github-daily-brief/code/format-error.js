// ─────────────────────────────────────────────────────────────────────────────
// Node:  Format Error
// Type:  Code (JavaScript) — Mode: "Run Once for All Items"
// Receives items from the ERROR outputs of:
//   • Search GitHub Repos   • Transform Repos   • Build Digest   • Send Daily Digest
// and turns them into a clear, secret-free message for "Send Error Alert".
// ─────────────────────────────────────────────────────────────────────────────

// Which node did this error come from? ($prevNode is provided by n8n.)
const stage =
  typeof $prevNode !== 'undefined' && $prevNode && $prevNode.name ? $prevNode.name : 'unknown node';

// Never leak a Telegram bot token if it ever shows up inside an error string.
const redact = (s) => String(s).replace(/bot\d{6,}:[A-Za-z0-9_-]{20,}/g, 'bot<redacted>');

function extract(raw) {
  const e = raw && raw.error !== undefined ? raw.error : raw;
  if (typeof e === 'string') return { message: e };
  if (e && typeof e === 'object') {
    return {
      message: e.message || e.description || 'Unknown error',
      description: e.description && e.description !== e.message ? e.description : '',
      status: e.httpCode || e.statusCode || e.status || (e.cause && (e.cause.status || e.cause.statusCode)) || null,
      code: e.code || (e.cause && e.cause.code) || null,
    };
  }
  return { message: 'Unknown error (no error details were provided).' };
}

function hint(stageName, status, message) {
  const m = String(message).toLowerCase();
  const st = Number(status);
  // The Telegram nodes are named "Send Daily Digest" / "Send Error Alert" (no "telegram" in the name).
  const isTelegram = /^Send (Daily Digest|Error Alert)$/.test(stageName) || /telegram|chat not found/i.test(m);

  if (isTelegram) {
    if (m.includes('chat not found')) return 'Chat ID is wrong, or you have not sent /start to the bot yet.';
    if (st === 401 || m.includes('unauthorized')) return 'Telegram bot token is invalid or revoked. Re-create the Telegram credential in n8n.';
    if (st === 400) return 'Telegram rejected the request (bad chat ID or message formatting).';
    return 'Check the Telegram credential and Chat ID on the Telegram node.';
  }
  if (st === 429 || (st === 403 && (m.includes('rate limit') || m.includes('forbidden') || m.includes('too many')))) {
    return 'GitHub API rate limit probably reached (unauthenticated search = 10 requests/min). Wait a minute, or add a GitHub token (see README).';
  }
  if (st === 401) return 'GitHub rejected the credentials. Remove or fix the Authorization header.';
  if (st === 404) return 'GitHub endpoint or resource not found. Check the request URL.';
  if (st === 422) return 'GitHub rejected the search query. Check the `q` parameter.';
  if (st >= 500) return 'GitHub API is having problems. It is safe to retry later.';
  if (/enotfound|econnrefused|econnreset|etimedout|timeout|timed out|getaddrinfo/.test(m)) {
    return 'Network problem reaching the API (DNS / connection / timeout). Check connectivity from the n8n host.';
  }
  if (m.includes('returned 0 repositories') || m.includes('no "items"')) {
    return 'The search query returned no usable data. Check the topic in the `q` parameter.';
  }
  return 'Open the failed execution in n8n and inspect the node named above.';
}

let executionId = 'n/a';
try {
  executionId = $execution.id || 'n/a';
} catch (e) {
  /* $execution not available — ignore */
}

const out = $input.all().map((item) => {
  const d = extract(item.json);
  const status = d.status || (String(d.message).match(/\b([45]\d{2})\b/) || [])[1] || null;
  const message = redact(d.message);
  const timestamp = new Date().toISOString();
  const tip = hint(stage, status, message);

  const lines = [
    '⚠️ GitHub Daily Brief FAILED',
    'Stage: ' + stage,
    'Error: ' + message.slice(0, 600),
  ];
  if (status) lines.push('HTTP status: ' + status);
  if (d.code) lines.push('Code: ' + d.code);
  if (d.description) lines.push('Details: ' + redact(d.description).slice(0, 300));
  lines.push('Hint: ' + tip);
  lines.push('Execution ID: ' + executionId);
  lines.push('Time (UTC): ' + timestamp);

  const telegramText = lines.join('\n');
  console.error('[GitHub Daily Brief] ' + telegramText.replace(/\n/g, ' | '));

  return {
    json: { stage, errorMessage: message, httpStatus: status, code: d.code || null, hint: tip, executionId, timestamp, telegramText },
  };
});

return out;
