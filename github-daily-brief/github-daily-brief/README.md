# GitHub Daily Brief Automation (n8n)

An n8n workflow that runs hourly (for testing), finds the most-starred public GitHub repositories for the topic `artificial-intelligence`, summarises the README of the top one, and sends a formatted digest to Telegram. Failures are reported to Telegram instead of failing silently.

## Files

| File | Purpose |
|---|---|
| `github-daily-brief.workflow.json` | Importable n8n workflow (11 nodes, no secrets) |
| `code/transform-repos.js` | Code node: sort, top 5, clean |
| `code/build-digest.js` | Code node: README handling, summary, Telegram message |
| `code/log-fallback.js` | Code node: logging for the False branch |
| `code/format-error.js` | Code node: turns errors into readable alerts |
| `tools/build-workflow.js` | Regenerates the JSON from `code/*.js` (`node tools/build-workflow.js`) |
| `tests/run-tests.js` | Offline tests (mock data, no network): `node tests/run-tests.js` |

## Flow

```
Schedule Trigger (1 h)
  └─> Search GitHub Repos ──(error)──────────────┐
        └─> Transform Repos ──(error)────────────┤
              └─> Fetch README (never fails)     │
                    └─> Build Digest ──(error)───┤
                          └─> Stars > 1000?      │
                                ├─ true  ─> Send Daily Digest ──(error)─┤
                                └─ false ─> Log Fallback                │
                                                                        ▼
                                              Format Error ─> Send Error Alert
```

## Node configuration

| # | Node | Type (version) | Key settings |
|---|---|---|---|
| 1 | Schedule Trigger | `scheduleTrigger` 1.2 | Interval: every 1 hour |
| 2 | Search GitHub Repos | `httpRequest` 4.2 | **GET** `https://api.github.com/search/repositories`; query: `q=topic:artificial-intelligence is:public`, `sort=stars`, `order=desc`, `per_page=30`; headers: `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `User-Agent: n8n-github-daily-brief`; timeout 15 s; Retry On Fail 3 tries / 3 s; On Error: *Continue (using error output)* |
| 3 | Transform Repos | `code` 2 | Run Once for All Items; JavaScript in `code/transform-repos.js`; On Error: *Continue (using error output)* |
| 4 | Fetch README | `httpRequest` 4.2 | **GET** `https://api.github.com/repos/{{ $json.topRepo.owner }}/{{ $json.topRepo.repo }}/readme`; same headers; options: Include Response Headers and Status = on, Never Error = on; Retry On Fail 3 tries; On Error: *Continue (regular output)* |
| 5 | Build Digest | `code` 2 | `code/build-digest.js`; On Error: *Continue (using error output)* |
| 6 | Stars > 1000? | `if` 2.2 | Number: `{{ $json.topRepo.stars }}` **is greater than** `1000` |
| 7 | Send Daily Digest | `telegram` 1.2 | Send Message; Chat ID `YOUR_TELEGRAM_CHAT_ID`; Text `{{ $json.telegramText }}`; Parse Mode HTML; Append n8n attribution off; On Error: *Continue (using error output)* |
| 8 | Log Fallback | `code` 2 | `code/log-fallback.js` (False branch) |
| 9 | Format Error | `code` 2 | `code/format-error.js` |
| 10 | Send Error Alert | `telegram` 1.2 | Same chat; Text `{{ $json.telegramText }}`; deliberately **no** Continue On Fail, so a broken alert channel shows as a failed execution |

## APIs used

| Purpose | Method + URL | Auth |
|---|---|---|
| Search repositories | `GET https://api.github.com/search/repositories?q=topic:artificial-intelligence is:public&sort=stars&order=desc&per_page=30` | None (public data) |
| Get README | `GET https://api.github.com/repos/{owner}/{repo}/readme` | None |
| Send message | Telegram `sendMessage` via the n8n Telegram node | Bot token in an n8n credential |

Fields used from the search response: `name`, `full_name`, `owner.login`, `description`, `stargazers_count`, `language`, `html_url`, `pushed_at`. The README response returns the file as base64 in `content`, which the Build Digest node decodes.

Unauthenticated GitHub search allows about 10 requests per minute, which is ample for one call per hour. See "Optional" below for a token.

## Transformation (Transform Repos)

1. Validates the response: throws a descriptive error if there is no `items` array or it is empty (includes GitHub's own `message`).
2. Drops malformed entries (no `full_name`/`html_url`).
3. Cleans text: strips control characters, collapses whitespace, truncates descriptions to 200 characters, falls back to `No description provided` / `Not specified` for null description/language.
4. Sorts by stars descending (tie-break on name) and keeps the top 5, adding a `rank`.
5. Emits one item containing `topRepos` (5 items) and `topRepo` (rank 1), which drives the README request and the IF node.

## README handling (Fetch README + Build Digest)

The request uses Never Error + full response, so a 404 does not stop the flow. Build Digest then maps the outcome:

| Outcome | Result |
|---|---|
| 200 with content | Markdown stripped (badges, HTML, code blocks, links, tables) and shortened to a ~350-character summary |
| 404 | "This repository has no README file." |
| 403 / 429 | Rate-limit note |
| Other HTTP status | `README unavailable: GitHub returned HTTP <code>` |
| Network failure | `README request failed: <message>` |
| Empty README | "README exists but is empty." |

In every case the digest is still sent, with the note in place of the summary.

## Conditional logic

`Stars > 1000?` checks the highest-ranked repository (`topRepo.stars`).
- **True:** `Send Daily Digest` sends the Telegram message.
- **False:** `Log Fallback` writes a structured entry to the n8n console and the execution output, stating why nothing was sent. No Telegram message.

With the topic `artificial-intelligence` the true branch is the normal outcome. To exercise the false branch, temporarily set the IF threshold very high (e.g. `10000000`).

## Error handling

- **HTTP failures:** Search GitHub Repos retries 3 times, then routes to its error output, which goes to Format Error. README failures never crash the flow (above).
- **Code failures:** Transform Repos, Build Digest and Send Daily Digest route their error outputs to Format Error.
- **Format Error** builds a message with the failing stage, error text, HTTP status, a hint (e.g. rate limit, bad chat ID, DNS/timeout), execution ID and UTC time. It redacts anything resembling a Telegram bot token.
- **Send Error Alert** sends that message to Telegram. If this final step fails, the execution is marked failed and is visible in the Executions list.
- Workflow settings save both successful and failed executions.

## Credentials (nothing is hardcoded)

1. In Telegram, open **@BotFather** → `/newbot` → copy the token.
2. Send any message (e.g. `/start`) to your new bot.
3. Get your chat ID: message **@userinfobot**, or open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and read `message.chat.id` (do not share this URL or screenshot it).
4. In n8n: **Credentials → Create credential → Telegram API**, paste the token as *Access Token*, save (n8n validates it).
5. Open **Send Daily Digest** and **Send Error Alert** and choose that credential on both.
6. Replace `YOUR_TELEGRAM_CHAT_ID` on both nodes with your chat ID.

### Manual configuration required
- Telegram credential selection on both Telegram nodes (the imported credential ID is a placeholder).
- Chat ID on both Telegram nodes.

### Optional
For a higher GitHub rate limit, create a fine-grained token with no extra permissions, store it as an n8n **Header Auth** credential (`Authorization: Bearer <token>`), and attach it to both GitHub HTTP nodes. Not required for this assessment.

## Import and test

1. n8n → **Workflows → ⋯ / Import from File** → select `github-daily-brief.workflow.json`. (Requires a reasonably recent n8n: IF node v2.2 and Schedule Trigger v1.2 need roughly n8n 1.6x or later.)
2. Complete the credential setup above.
3. Click **Execute workflow** (manual run; the Schedule Trigger fires immediately). Check each node's output and confirm the Telegram message arrives.
4. **Test the README fallback:** edit Fetch README's URL to `.../repos/octocat/does-not-exist/readme`; the digest should still send with the "no README" note. Revert afterwards.
5. **Test the False branch:** set the IF threshold to `10000000`; Log Fallback should run and no Telegram message is sent. Revert.
6. **Test error handling:** change the search URL to `https://api.github.com/search/repositoriez`; Format Error → Send Error Alert should deliver an alert with stage and hint. Revert.
7. **Test activation:** toggle the workflow **Active**; it will then run every hour.

## Offline tests

`node tests/run-tests.js` runs the four Code nodes against **synthetic** GitHub-shaped data with mocked n8n globals and statically checks the workflow JSON (connections, node types, no secrets, embedded code matches `code/`). This is not an n8n execution and does not contact GitHub or Telegram.

## Screenshots to capture for submission

Take these from your own n8n instance after running it. Hide your bot token and chat ID.

- [ ] Full canvas showing all nodes and connections
- [ ] Schedule Trigger settings (every 1 hour)
- [ ] Search GitHub Repos: parameters, headers, and Settings tab (retry + error output)
- [ ] Search GitHub Repos output (items with stars, language, URL)
- [ ] Transform Repos: code and output (5 sorted repos)
- [ ] Fetch README: parameters (Never Error / full response) and output
- [ ] Build Digest: output showing `readme` status and `telegramText`
- [ ] IF node configuration (`> 1000`) with true/false branches
- [ ] Telegram credential screen (token masked)
- [ ] Send Daily Digest node settings
- [ ] Telegram chat showing the received digest
- [ ] Successful execution view with green nodes (Executions tab)
- [ ] False-branch run showing Log Fallback output
- [ ] README-missing (404) run showing the graceful note
- [ ] Error test: Format Error output and the Telegram error alert
- [ ] Workflow toggled Active
