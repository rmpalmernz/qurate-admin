# Infrastructure Reference

Snapshot of the live Supabase project as of **2026-08-06** (re-audited via MCP). The previous
snapshot was 2026-05-02 and had drifted badly: four Edge Functions and five cron jobs had been
added straight to the project without ever appearing here, and the row counts were three months old.

> **Read this first — what is actually broken right now.** See
> [Known-broken](#known-broken-as-of-2026-08-06) at the foot of this document. Short version:
> `ms-outlook-folders` has returned HTTP 500 on every run since late July, so no Outlook email
> has become a task since 2026-07-26, and the cron that calls it reports `succeeded` regardless.

## Supabase project

| Field | Value |
|---|---|
| Name | qurate-ea |
| Project ref | `btzlkiwmdegubbvzbmyo` |
| Region | ap-southeast-1 |
| Postgres | 17.6.1 |
| Org | zbeqwbkjiflciirqzexs |

There are two other projects under the same org (`qurate-qvos-main`, `alstonvilleplants-core`) — not used by this app.

---

## Edge Functions (20 deployed — 2 deprecated stubs, 18 active)

> **Source-control gap:** four deployed functions have no source in this repo —
> `spend-guard`, `nudge-engine`, `auto-handled-digest`, `send-push`. They were deployed
> straight to the project on 2026-06-27, after Epic 3 closed. Epic 3's guarantee ("every
> back-of-house change reviewable and revertable via git") does not currently hold for them.
> Pull them in before touching any of the four.

All AI calls are now Anthropic Claude only. Lovable AI Gateway is fully removed.

| Slug | verify_jwt | Triggered by | Notes |
|---|---|---|---|
| `ms-auth` | no | dashboard, other Edge Functions | OAuth orchestration. Refresh token stored encrypted in **Supabase Vault** (`microsoft_refresh_token` secret). **Access tokens are NEVER persisted** — every default invocation refreshes from Vault and returns a fresh access token to the caller. **Source in `supabase/functions/ms-auth/`.** Scopes: Calendars.Read, Mail.ReadWrite, Sites.Read.All, Files.Read.All, offline_access |
| `ms-calendar` | no | (no callers found) | Pulls Graph calendarview, upserts `calendar_events` |
| `ms-outlook-folders` | no | **pg_cron `sync-outlook-matrix` (every 15 min)**, manual | Reads 4 mapped Outlook folders → AI-extracts tasks (Claude Haiku 4.5) → inserts into `eisenhower_tasks`. **BROKEN — HTTP 500 on every run since ~2026-07-26. See [Known-broken](#known-broken-as-of-2026-08-06).** **Source in `supabase/functions/ms-outlook-folders/`.** |
| `delete-outlook-email` | no | dashboard | Deletes a Graph message |
| `fetch-email` | no | dashboard | Fetches one Graph message by id |
| `reimport-emails` | no | manual | Re-classification pass |
| `chat` | yes | dashboard | Conversational EA assistant. Claude Sonnet 4.5. Brief generation moved to morning-brief. **Source in `supabase/functions/chat/`.** |
| `draft-reply` | yes | dashboard | AI email reply generation. Claude Sonnet 4.5. |
| `improve-prompt` | no | manual | Iterates on a prompt |
| `active-prompt` | no | unknown | Returns active prompt from `ai_prompts` |
| `sender-history` | no | unknown | Sender history lookup |
| `follow-ups` | no | unknown | Populates `follow_ups` table |
| `sync-vips` | no | **pg_cron `sync-vips-daily` (19:00 UTC daily)**, Settings tab "Sync now" button | Reads SharePoint `quratepty.sharepoint.com/sites/QurateClient/02. Work in Progress + 01. Archive` and personal OneDrive `1. Own - Engagements`. Extracts company names, dedupes, writes `user_preferences.vip_companies_auto`. **Source in `supabase/functions/sync-vips/`.** |
| `morning-brief` | no | **pg_cron `morning-brief-daily` (20:30 UTC weekdays = 06:30 AEST)**, dashboard BriefingTab | Single source of truth for the daily brief. Body `{force?, send?, context?}`. Generates via Claude Sonnet 4.5, fetches today's calendar from Graph (cron path), persists to `ai_daily_briefs`, optionally renders markdown→HTML and emails via Graph `/me/sendMail`. **Source in `supabase/functions/morning-brief/`.** |
| `daily-brief` | no | none | **DEPRECATED 2026-05-03.** 410 stub — body of original Lovable Gemini implementation removed. Replaced by `morning-brief`. Safe to delete from Supabase once unused for >7 days. |
| `send-brief` | no | none | **DEPRECATED 2026-05-03.** 410 stub. Replaced by `morning-brief` with `{send:true}`. Safe to delete from Supabase once unused for >7 days. |
| `spend-guard` | no | **pg_cron `spend-guard` (every 13 min)** | Reads `ai_spend_today_aest()` against a $2/day ceiling; flips `spend_guard_state.paused`. Last tripped 2026-06-27, currently `paused=false`. **No source in repo.** |
| `nudge-engine` | yes | **pg_cron `nudge-engine-30min`** | Push nudges; skips outside working hours (returns `{"skipped":"quiet_hours"}`). Writes `nudge_log` (0 rows). **No source in repo.** |
| `auto-handled-digest` | yes | **pg_cron `auto-handled-digest-weekly` (Sun 21:00 UTC)** | Weekly digest of auto-handled email. **No source in repo.** |
| `send-push` | yes | `nudge-engine` | Web-push delivery. `push_subscriptions` is empty, so nothing is delivered. **No source in repo.** |

### Folder-to-quadrant mapping (used by `ms-outlook-folders`)

```
"1.  Urgent and Important (Do)"             → do
"2.  Not Urgent Important (Plan)"           → schedule
"3.  Urgent not Important (Delegate)"       → delegate
"4.  Not Important Not Urgent (Elimination)" → eliminate
```

These are Outlook subfolders under Inbox. Names are sensitive to whitespace — note the double-space after "1." etc.

---

## pg_cron jobs

All nine are active as of 2026-08-06.

| Job | Schedule | `timeout_ms` | Calls |
|---|---|---|---|
| `sync-outlook-matrix` | `*/15 * * * *` | **unset → 5 000 (too low)** | `ms-outlook-folders`. The function takes 9–14 s, so pg_net aborts every call at 5 s. |
| `sync-calendar-30min` | `*/30 * * * *` | 30 000 | `ms-calendar?persist=true` for now → now+14d |
| `nudge-engine-30min` | `*/30 * * * *` | unset → 5 000 | `nudge-engine` (returns fast; the low timeout doesn't bite) |
| `spend-guard` | `*/13 * * * *` | 60 000 | `spend-guard` |
| `sync-vips-daily` | `0 19 * * *` (06:00 AEST) | unset → 5 000 | `sync-vips` |
| `morning-brief-daily` | `30 20 * * 1-5` (06:30 AEST) | 60 000 | `morning-brief` `{"send":true}` |
| `evening-brief-daily` | `30 7 * * 1-5` (17:30 AEST) | unset → 5 000 | `morning-brief` `{"variant":"endofday","send":true}` |
| `auto-handled-digest-weekly` | `0 21 * * 0` | unset → 5 000 | `auto-handled-digest` `{"send":true}` |
| `daily_retention_sweep` | `0 17 * * *` | n/a (plain SQL) | `SELECT run_data_retention_sweep()` |

### `cron.job_run_details.status` does not mean the function succeeded

`net.http_post` returns a request id as soon as the request is **queued**. pg_cron then records
`succeeded` — for the enqueue, not the HTTP call. A function returning 500 on every single run
shows up here as an unbroken wall of green. To see what actually happened you have to join
against `net._http_response`:

```sql
-- Real outcomes of the last 2 days of scheduled HTTP calls
SELECT status_code, count(*), max(created) AS newest,
       left(coalesce(error_msg, content), 120) AS detail
FROM net._http_response
WHERE created > now() - interval '2 days'
GROUP BY 1, 4
ORDER BY 3 DESC;
```

`status_code IS NULL` rows are timeouts — `error_msg` carries the detail. Any cron whose target
can run longer than 5 s needs an explicit `timeout_milliseconds`; four of the jobs above don't have one.

The cron command stores the Supabase anon key as plaintext in the `cron.job` table. Public anon key = low risk but inelegant.

### `ms-outlook-folders` dedup bug (root cause of the runaway)

The function builds an `existingIds` set from this query:
```ts
const { data: existingTasks } = await sb
  .from("eisenhower_tasks")
  .select("source_email_id, source_email_ids")
  .eq("source_type", "email");
```
Supabase's PostgREST defaults to **1000 rows per page** unless you explicitly paginate. With 227k tasks this returned only the first 1000, so any messageId not in those first 1000 looked "new" and got re-inserted — every 15 minutes.

**Fix when you're ready to re-enable the cron:** query specifically for the messageIds being checked, not all-then-filter:
```ts
const { data: existingTasks } = await sb
  .from("eisenhower_tasks")
  .select("source_email_id")
  .eq("source_type", "email")
  .in("source_email_id", messageIds);
```
The unique partial index `ux_eisenhower_tasks_source_email_id` is now also in place as a defence-in-depth — even if the application-layer dedup misses something, the database will reject the duplicate INSERT.

### Inspecting cron runs

`cron.job_run_details` is restricted on hosted Supabase but readable via SQL editor. Quickest health check:

```sql
-- Last 5 runs of each active cron, with status + duration
SELECT j.jobname, r.status, r.start_time, r.end_time,
       extract(epoch from (r.end_time - r.start_time)) AS seconds,
       left(coalesce(r.return_message, ''), 80) AS msg
FROM cron.job j
JOIN cron.job_run_details r ON r.jobid = j.jobid
WHERE j.active
ORDER BY r.start_time DESC
LIMIT 20;
```

Things to watch for:
- `morning-brief-daily`: should appear at ~20:30 UTC weekdays, status `succeeded`. If status `failed` or `morning-brief` itself returned 500, you'll also receive a failure-alert email (see `supabase/functions/morning-brief/index.ts` `notifyFailure`).
- `sync-outlook-matrix`: ~96 runs/day. Expected to succeed silently. Failures don't email — check this query.
- `sync-vips-daily`: 1 run/day at 19:00 UTC.

### Health endpoint

`GET /api/health` (Next.js) returns JSON with each check + overall status. Returns HTTP 503 if anything's degraded so any uptime monitor (UptimeRobot / BetterStack / Cron-job.org) treats it as down. Checks:
- Supabase reachable
- Today's brief row exists in `ai_daily_briefs`
- Brief was emailed (only flagged after 07:00 AEST on weekdays)

---

## Tables (25 in `public` schema)

See `docs/BRD.md` §3 for the table-by-table breakdown. Row counts and freshness as at 2026-08-06:

| Table | Rows | Newest row | Note |
|---|---:|---|---|
| `eisenhower_tasks` | 1,392 (1,384 open) | **2026-07-26** | All `source_type = 'email'`; no manual rows survive. Stalled — see Known-broken. |
| `email_processing_history` | 759 | **2026-07-31** | AI classification feed; also stalled. |
| `calendar_events` | 364 | 2026-08-05 | Synced every 30 min — but **invisible to the anon key** (see RLS below). |
| `ai_daily_briefs` | 7 | 2026-08-05 06:30 AEST | Morning + evening briefs generating and emailing normally. |
| `api_cost_log` | 778 | 2026-08-05 | Only `morning_brief` / `evening_brief` / `auto_handled_digest` since 2026-07-19 — no `email_task_extraction` entries, which is the cost-side fingerprint of the broken sync. |
| `strategy_rocks` | 7 | **2026-02-21** | All labelled `Q1 2025`, all `percent_complete = 0`. Rendered on the Briefing tab. |
| `core_clients` / `core_deliverables` / `core_decisions` | 15 / 10 / 10 | 2026-07-29 → 08-04 | Maintained. |
| `retention_log` | 720 | — | Written by `run_data_retention_sweep()`. **RLS disabled.** |
| `follow_ups`, `personal_items`, `chat_*`, `email_drafts`, `vip_contacts`, `briefing_sections`, `teams_messages`, `push_subscriptions`, `nudge_log` | 0 | — | Empty. The Briefing tab's Follow-ups panel reads `follow_ups`. |
| `spend_guard_state`, `function_alert_state` | 1 each | 2026-06-27 | **RLS disabled.** |
| `microsoft_oauth_tokens` | — | — | DROPPED 2026-05-02. Refresh token lives in `vault.secrets` as `microsoft_refresh_token`; access tokens are never persisted. |

### PostgREST returns at most 1000 rows

Confirmed against this project: an unbounded `select` on `eisenhower_tasks` answers
`HTTP 206` with `Content-Range: 0-999/1384`. 206 is `res.ok` in `fetch`, so an
unpaginated client silently drops everything past the first thousand. Any read of a table
that can exceed 1000 rows must page with `Range` headers.

---

## Secrets (Edge Function env)

Required:
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` — auto-injected
- `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` — Microsoft OAuth
- `ANTHROPIC_API_KEY` — Claude API. Used by `morning-brief`, `chat`, `draft-reply`, `ms-outlook-folders`.

Optional:
- `CRM_SUPABASE_URL`, `CRM_SUPABASE_ANON_KEY` — second Supabase project for CRM data (clients, deals, revenue). When set, `morning-brief` and `chat` enrich responses with this data.

Deprecated (safe to remove from Supabase secrets):
- `LOVABLE_API_KEY` — no remaining code references. Removed from `daily-brief`, `ms-outlook-folders` on 2026-05-03.

---

## RLS posture

- **3 tables have RLS switched off entirely** — `retention_log`, `spend_guard_state`,
  `function_alert_state`. Anyone holding the anon key can read *and write* every row, including
  flipping `spend_guard_state.paused` to disable the AI spend ceiling. All three were created
  after the last audit. Remediation is `ALTER TABLE … ENABLE ROW LEVEL SECURITY`, but enabling
  it without policies will block the service-role-adjacent readers too — decide the policy first.
- 2 tables locked down (RLS on, no policies): `calendar_events`, `teams_messages`. Service-role
  writes only. **This is why the dashboard's calendar cache never engages** — `loadCalendar`
  reads `calendar_events` with the anon key, gets an empty `200`, treats the cache as cold and
  falls back to a live Graph pull on every single load. The 30-minute sync populates a table
  nothing reads. Fix is a `SELECT` policy for `anon`, or move the read behind an Edge Function.
- 14 tables with permissive `USING(true) WITH CHECK(true)` policies. Open to any holder of the anon key. Acceptable for single-user MVP, **must tighten before multi-user** (Epic 7).
- Several SELECT-only policies on `core_*`, `personal_items`, `strategy_rocks` (read for `public`, no write).

---

## Known-broken as of 2026-08-06

### 1. `ms-outlook-folders` — 500 on every run, 10 days of no new tasks

**Symptom.** No email has become a task since 2026-07-26. `eisenhower_tasks` is frozen at 1,392
rows while the four mapped Outlook folders hold 494 messages. Every 15-minute run logs
`POST | 500 | .../ms-outlook-folders` after 9–14 s.

**What still works** (verified end to end): `ms-auth` returns a valid Graph access token; Graph
returns the Inbox, all four mapped child folders and their message lists; `ai_daily_briefs`,
`ms-calendar`, `sync-vips` and `spend-guard` are all healthy.

**Where it fails.** Between the dedup `SELECT` and the `INSERT`. The api logs show four
identical `GET /rest/v1/eisenhower_tasks?...source_email_id=in.(…)` requests per run, ~1 s / 2 s
/ 4 s apart — a client-side retry-and-backoff — and then no `POST /rest/v1/eisenhower_tasks`
ever. That `in.()` list carries up to 100 Graph message ids at ~150 chars each: a request line
of roughly 17 KB.

**Why nobody noticed.** Two independent silencers:
1. The catch block read `error instanceof Error ? error.message : "Unknown error"`. supabase-js
   rejects with a `PostgrestError`, which is a plain object, not an `Error` — so every database
   failure rendered as the literal string `Unknown error`, with no code, detail or hint.
2. `cron.job_run_details` said `succeeded` throughout, because that reflects the enqueue (see above).

**Fixed in code:** the dedup query is now chunked at 25 ids per request, and `describeError()`
preserves `message | code | details | hint` so the next failure names itself.

**Still needs an operator:** the cron's 5-second pg_net timeout. Every call is aborted at 5 s
regardless of the fix, so the function's own result is never observed:

```sql
SELECT cron.unschedule('sync-outlook-matrix');
SELECT cron.schedule('sync-outlook-matrix', '*/15 * * * *', $$
  SELECT net.http_post(
    url     := 'https://btzlkiwmdegubbvzbmyo.supabase.co/functions/v1/ms-outlook-folders',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer <anon key>"}'::jsonb,
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
$$);
```

The same one-line omission applies to `evening-brief-daily`, `sync-vips-daily` and
`auto-handled-digest-weekly`.

### 2. AI extraction was already failing a week before the 500s

`api_cost_log` has no `email_task_extraction` row since **2026-07-19**, yet tasks kept being
created until 07-26. `callAi()` swallowed a non-OK Anthropic response — it logged and returned
`{content: null}`, and the caller fell back to using the raw email subject as the task title.
So there is a window of tasks created with no AI involvement at all.

**Two things this is *not*.** The `ANTHROPIC_API_KEY` secret is valid and funded — `morning-brief`
and `evening-brief` bill against the same key every weekday and logged a charge as recently as
2026-08-05. And `claude-haiku-4-5-20251001` is the current, active dated snapshot for Haiku 4.5,
not a retired ID. Neither is the cause; don't start there.

The actual error text was only ever written to the function's console log. `callAi()` now
collects failures and returns them on the response (`ai_failures`, `ai_failure_count`), and a
run that creates tasks without AI says so in its `summary` instead of looking like a success.
`/api/health` gained an `ai_extraction` check on the same signal. Trigger one run after
deploying and read `ai_failures` — that is the diagnosis.

### 3. The retention sweep is quietly draining the task backlog

`run_data_retention_sweep()` (pg_cron `daily_retention_sweep`, 17:00 UTC) is working exactly as
written — and that is the problem while the sync is down. Step 2 cancels any open task untouched
for 60 days; step 1 deletes cancelled tasks 30 days after that. With `ms-outlook-folders` dead
since 2026-07-26, nothing refreshes a task's `updated_at`, so the existing backlog is ageing into
auto-cancellation with no new tasks replacing it: 21 cancelled on 08-03, 9 on 08-04, 1 on 08-05,
and **378 open tasks are already past the 30-day mark**. The 484 currently-cancelled rows are
mid-way through their 30-day hold and will delete themselves on a rolling basis — there is no
manual cleanup to do, but the table will empty itself over the next two months if the sync stays
broken.

### 4. Stale data reaching the Briefing tab

- `strategy_rocks` — 7 rows labelled `Q1 2025`, untouched since 2026-02-21, all at 0%,
  rendered under the heading "Quarterly Rocks" with no indication of age. The tab now warns
  when nothing matches the current quarter, but the underlying data still needs owning.
- The brief was fetched as "newest row, any date". A brief from days ago rendered identically
  to this morning's. The tab now shows which date it is displaying.
- The Follow-ups panel printed the sentence "No overdue follow-ups" unconditionally, without
  ever reading `follow_ups`. It now reads the table.

## How to refresh this doc

When edge functions change or tables get added, re-run an audit:

1. `mcp__supabase__list_edge_functions` — confirm count + slugs, and diff against
   `supabase/functions/` so newly hand-deployed functions get caught
2. `mcp__supabase__list_tables` — confirm row counts
3. `mcp__supabase__get_advisors --type=security` — confirm RLS state
4. `mcp__supabase__execute_sql 'SELECT jobname, schedule, command FROM cron.job'` — confirm cron
   jobs *and* that each `command` sets `timeout_milliseconds`
5. Query `net._http_response` (see above) for the real outcome of scheduled calls — never trust
   `cron.job_run_details.status` alone
6. Check freshness, not just row counts: `max(created_at)` per table tells you whether a
   pipeline is alive. A healthy row count on a dead pipeline looks exactly like a working one.
7. Update tables above, bump the timestamp at the top
