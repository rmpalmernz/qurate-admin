# Infrastructure Reference

Snapshot of the live Supabase project as of 2026-05-02. Auto-generated from MCP audit; refresh whenever Edge Functions or migrations change.

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

## Edge Functions (15 — 2 deprecated stubs, 13 active)

All AI calls are now Anthropic Claude only. Lovable AI Gateway is fully removed.

| Slug | verify_jwt | Triggered by | Notes |
|---|---|---|---|
| `ms-auth` | no | dashboard, other Edge Functions | OAuth orchestration. Refresh token stored encrypted in **Supabase Vault** (`microsoft_refresh_token` secret). **Access tokens are NEVER persisted** — every default invocation refreshes from Vault and returns a fresh access token to the caller. **Source in `supabase/functions/ms-auth/`.** Scopes: Calendars.Read, Mail.ReadWrite, Sites.Read.All, Files.Read.All, offline_access |
| `ms-calendar` | no | (no callers found) | Pulls Graph calendarview, upserts `calendar_events` |
| `ms-outlook-folders` | no | **pg_cron `sync-outlook-matrix` (every 15 min)**, manual | Reads 4 mapped Outlook folders → AI-extracts tasks (Claude Haiku 4.5) → inserts into `eisenhower_tasks`. **Cron paused — see below.** **Source in `supabase/functions/ms-outlook-folders/`.** |
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

| Job | Schedule | Active | Calls |
|---|---|---|---|
| `sync-outlook-matrix` | `*/15 * * * *` (every 15 min) | active (resumed 2026-05-03) | `ms-outlook-folders` (Anthropic Haiku 4.5) |
| `sync-calendar-30min` | `*/30 * * * *` (every 30 min) | active | `ms-calendar?persist=true` for now → now+14d |
| `sync-vips-daily` | `0 19 * * *` (19:00 UTC = 06:00 AEDT) | active | `sync-vips` |
| `morning-brief-daily` | `30 20 * * 1-5` (20:30 UTC weekdays = 06:30 AEST / 07:30 AEDT) | active | `morning-brief` with body `{"send":true}` |

Paused via `cron.alter_job(..., active := false)` after producing 225,350 duplicate `eisenhower_tasks` rows. **Do not resume** until the dedup bug in `ms-outlook-folders` is fixed (see below) — without that fix, every cron tick will now fail with unique-index violations rather than duplicating, but it'll still burn Lovable AI calls before hitting the constraint.

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

## Tables (21 in `public` schema)

See `docs/BRD.md` §3 for the table-by-table breakdown. Highlights:

- **`eisenhower_tasks`** — 227,407 rows, ~160× duplicated. Cleanup needed.
- **`email_processing_history`** — 2,343 rows. Rich AI classification, but the dashboard ignores it.
- **`microsoft_oauth_tokens`** — DROPPED 2026-05-02. Refresh token now stored in `vault.secrets` as `microsoft_refresh_token`; access tokens are no longer persisted at all.
- **`calendar_events`** — 0 rows. Function exists, no caller.
- **`ai_daily_briefs`** — 1 row. The brief generator works.
- **`api_cost_log`** — 3,340 rows. Solid AI cost tracking already in place.

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

- 2 tables locked down (no policies): `calendar_events`, `teams_messages`. Only service-role writes. (`microsoft_oauth_tokens` was dropped on 2026-05-02 — refresh token is in Vault now.)
- 14 tables with permissive `USING(true) WITH CHECK(true)` policies. Open to any holder of the anon key. Acceptable for single-user MVP, **must tighten before multi-user** (Epic 7).
- Several SELECT-only policies on `core_*`, `personal_items`, `strategy_rocks` (read for `public`, no write).

---

## How to refresh this doc

When edge functions change or tables get added, re-run an audit:

1. `mcp__supabase__list_edge_functions` — confirm count + slugs
2. `mcp__supabase__list_tables` — confirm row counts
3. `mcp__supabase__get_advisors --type=security` — confirm RLS state
4. `mcp__supabase__execute_sql 'SELECT * FROM cron.job'` — confirm cron jobs
5. Update tables above, bump the timestamp at the top
