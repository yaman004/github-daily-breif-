// Generates github-daily-brief.workflow.json from the code/*.js files.
// Usage: node tools/build-workflow.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const readCode = (f) => fs.readFileSync(path.join(root, 'code', f), 'utf8');

// Deterministic UUID per node name so rebuilding does not churn the JSON.
const uid = (name) => {
  const h = crypto.createHash('sha1').update('github-daily-brief:' + name).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const GH_HEADERS = {
  sendHeaders: true,
  headerParameters: {
    parameters: [
      { name: 'Accept', value: 'application/vnd.github+json' },
      { name: 'X-GitHub-Api-Version', value: '2022-11-28' },
      { name: 'User-Agent', value: 'n8n-github-daily-brief' },
    ],
  },
};

const TELEGRAM_CRED = { telegramApi: { id: 'REPLACE_WITH_YOUR_CREDENTIAL', name: 'Telegram account' } };

const nodes = [
  {
    parameters: {
      content:
        '## GitHub Daily Brief — manual setup\n' +
        '1. Create a **Telegram API** credential (BotFather token) and select it on BOTH Telegram nodes.\n' +
        '2. Replace `YOUR_TELEGRAM_CHAT_ID` on BOTH Telegram nodes.\n' +
        '3. Click **Execute workflow** to test (the Schedule Trigger runs hourly once the workflow is Active).\n\n' +
        'No secrets are stored in this JSON.',
      height: 220,
      width: 460,
    },
    type: 'n8n-nodes-base.stickyNote',
    typeVersion: 1,
    position: [-80, 40],
    name: 'Setup Notes',
  },
  {
    parameters: {
      rule: { interval: [{ field: 'hours', hoursInterval: 1 }] },
    },
    type: 'n8n-nodes-base.scheduleTrigger',
    typeVersion: 1.2,
    position: [0, 300],
    name: 'Schedule Trigger',
  },
  {
    parameters: {
      method: 'GET',
      url: 'https://api.github.com/search/repositories',
      sendQuery: true,
      queryParameters: {
        parameters: [
          { name: 'q', value: 'topic:artificial-intelligence is:public' },
          { name: 'sort', value: 'stars' },
          { name: 'order', value: 'desc' },
          { name: 'per_page', value: '30' },
        ],
      },
      ...GH_HEADERS,
      options: { timeout: 15000 },
    },
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [260, 300],
    name: 'Search GitHub Repos',
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 3000,
    onError: 'continueErrorOutput',
  },
  {
    parameters: { mode: 'runOnceForAllItems', jsCode: readCode('transform-repos.js') },
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [520, 300],
    name: 'Transform Repos',
    onError: 'continueErrorOutput',
  },
  {
    parameters: {
      method: 'GET',
      url: '=https://api.github.com/repos/{{ $json.topRepo.owner }}/{{ $json.topRepo.repo }}/readme',
      ...GH_HEADERS,
      options: {
        timeout: 15000,
        response: { response: { fullResponse: true, neverError: true } },
      },
    },
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [780, 300],
    name: 'Fetch README',
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 2000,
    onError: 'continueRegularOutput',
  },
  {
    parameters: { mode: 'runOnceForAllItems', jsCode: readCode('build-digest.js') },
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [1040, 300],
    name: 'Build Digest',
    onError: 'continueErrorOutput',
  },
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: uid('stars-condition'),
            leftValue: '={{ $json.topRepo.stars }}',
            rightValue: 1000,
            operator: { type: 'number', operation: 'gt' },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position: [1300, 300],
    name: 'Stars > 1000?',
  },
  {
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: 'YOUR_TELEGRAM_CHAT_ID',
      text: '={{ $json.telegramText }}',
      additionalFields: { parse_mode: 'HTML', appendAttribution: false },
    },
    type: 'n8n-nodes-base.telegram',
    typeVersion: 1.2,
    position: [1560, 200],
    name: 'Send Daily Digest',
    credentials: TELEGRAM_CRED,
    onError: 'continueErrorOutput',
  },
  {
    parameters: { mode: 'runOnceForAllItems', jsCode: readCode('log-fallback.js') },
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [1560, 420],
    name: 'Log Fallback',
  },
  {
    parameters: { mode: 'runOnceForAllItems', jsCode: readCode('format-error.js') },
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [1040, 640],
    name: 'Format Error',
  },
  {
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: 'YOUR_TELEGRAM_CHAT_ID',
      text: '={{ $json.telegramText }}',
      additionalFields: { appendAttribution: false },
    },
    type: 'n8n-nodes-base.telegram',
    typeVersion: 1.2,
    position: [1300, 640],
    name: 'Send Error Alert',
    credentials: TELEGRAM_CRED,
  },
].map((n) => ({ ...n, id: uid(n.name) }));

const link = (node) => ({ node, type: 'main', index: 0 });

const connections = {
  'Schedule Trigger': { main: [[link('Search GitHub Repos')]] },
  'Search GitHub Repos': { main: [[link('Transform Repos')], [link('Format Error')]] },
  'Transform Repos': { main: [[link('Fetch README')], [link('Format Error')]] },
  'Fetch README': { main: [[link('Build Digest')]] },
  'Build Digest': { main: [[link('Stars > 1000?')], [link('Format Error')]] },
  'Stars > 1000?': { main: [[link('Send Daily Digest')], [link('Log Fallback')]] },
  'Send Daily Digest': { main: [[], [link('Format Error')]] },
  'Format Error': { main: [[link('Send Error Alert')]] },
};

const workflow = {
  name: 'GitHub Daily Brief Automation',
  nodes,
  connections,
  active: false,
  settings: {
    executionOrder: 'v1',
    timezone: 'Asia/Kolkata',
    saveDataErrorExecution: 'all',
    saveDataSuccessExecution: 'all',
    saveManualExecutions: true,
  },
  pinData: {},
};

const out = path.join(root, 'github-daily-brief.workflow.json');
fs.writeFileSync(out, JSON.stringify(workflow, null, 2) + '\n');
console.log('Wrote', out, '(' + nodes.length + ' nodes)');
