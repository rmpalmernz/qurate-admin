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

## Edge Functions (14)

| Slug | verify_jwt | Triggered by | Notes |
|---|---|---|---|
| `ms-auth` | no | dashboard, other Edge Functions | OAuth orchestration. Refresh token stored encrypted in **Supabase Vault** (`microsoft_refresh_token` secret). **Access tokens are NEVER persisted** — every default invocation refreshes from Vault and returns a fresh access token to the caller. **Source in `supabase/functions/ms-auth/`.** Scopes: Calendars.Read, Mail.ReadWrite, Sites.Read.All, Files.Read.All, offline_access |
| `ms-calendar` | no | (no callers found) | Pulls Graph calendarview, upserts `calendar_events` |
| `ms-outlook-folders` | no | **pg_cron `sync-outlook-matrix` (every 15 min)**, dashboard | Reads 4 mapped Outlook folders → AI-extracts tasks → inserts into `eisenhower_tasks`. **Cron paused — see below.** |
| `delete-outlook-email` | no | dashboard | Deletes a Graph message |
| `fetch-email` | no | dashboard | Fetches one Graph message by id |
| `reimport-emails` | no | manual | Re-classification pass |
| `daily-brief` | no | dashboard | "Gate 5 v2" brief generator. Reads 12 tables, calls Lovable AI Gateway (gemini-2.5-flash), upserts `ai_daily_briefs` |
| `chat` | yes | dashboard | Chat assistant |
| `draft-reply` | yes | dashboard | AI email reply generation |
| `improve-prompt` | no | manual | Iterates on a prompt |
| `active-prompt` | no | unknown | Returns active prompt from `ai_prompts` |
| `sender-history` | no | unknown | Sender history lookup |
| `follow-ups` | no | unknown | Populates `follow_ups` table |
| `sync-vips` | no | **pg_cron `sync-vips-daily` (19:00 UTC daily)**, Settings tab "Sync now" button | Reads SharePoint `quratepty.sharepoint.com/sites/QurateClient/02. Work in Progress + 01. Archive` and personal OneDrive `1. Own - Engagements`. Extracts company names, dedupes, writes `user_preferences.vip_companies_auto`. **Source in `supabase/functions/sync-vips/`.** |
| `send-brief` | no | **pg_cron `send-brief-daily` (20:30 UTC weekdays = 06:30 AEST / 07:30 AEDT)**, future "Send now" UI | Calls `daily-brief` for today's brief, renders markdown → HTML, sends via Graph `/me/sendMail` to the authenticated user's inbox, marks `ai_daily_briefs.sent_at`. Idempotent: skips if already sent today (override with `{force:true}`). **Source in `supabase/functions/send-brief/`.** |

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
| `sync-outlook-matrix` | `*/15 * * * *` (every 15 min) | **paused 2026-05-02** | `ms-outlook-folders` |
| `sync-vips-daily` | `0 19 * * *` (19:00 UTC = 06:00 AEDT) | active | `sync-vips` |
| `send-brief-daily` | `30 20 * * 1-5` (20:30 UTC weekdays = 06:30 AEST / 07:30 AEDT) | active | `send-brief` |

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
- `LOVABLE_API_KEY` — Lovable AI Gateway (used by `daily-brief`, `ms-outlook-folders`). **NB: as of 2026-05-02 this appears to be unset — `daily-brief` returns "LOVABLE_API_KEY is not configured" and therefore `send-brief` cannot generate fresh briefs. Set this in Supabase Dashboard → Project Settings → Edge Functions → Secrets to unblock the cron.**

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
