# Operational Changelog

Records non-code changes made directly to the live Supabase project (`btzlkiwmdegubbvzbmyo`). Code changes are tracked in git as usual.

---

## 2026-05-03 — Epic 1: bridge dashboard ↔ back-of-house

**Why:** Dashboard was reading 2 of 21 tables. Rich AI classification in `email_processing_history`, cached calendar events in `calendar_events`, and the EOS strategy rocks in `strategy_rocks` were all invisible to the user. Epic 1 wires the bridge.

**Landed:**
- New pg_cron `sync-calendar-30min` (`*/30 * * * *`) — calls `ms-calendar?persist=true` for `now()` through `now() + 14 days`, populating `calendar_events`.
- Dashboard `loadCalendar` now reads `calendar_events` first; falls back to live Graph if cache empty or > 2 hours stale.
- Dashboard `loadEmails` enriches with `email_processing_history` (already in main from earlier work) — preserving AI category + client mapping.
- Tasks tab `moveTask` records `quadrant_override = true` and captures `ai_suggested_quadrant` whenever the user drags a task between quadrants. Cards show "↻ override" badge.
- Briefing tab now renders Strategy Rocks (read from `strategy_rocks`, 7 rows) and a data-snapshot footer ("Brief built from: X Q1 · Y Q2 · Z events").
- `ms-calendar` source pulled into `supabase/functions/ms-calendar/` (Epic 3 progress).

**Pre-flight blocker (separate from PR):** ms-auth currently reports "Not connected to Microsoft" — the Vault `microsoft_refresh_token` has been invalidated. User must re-sign in via the dashboard before `sync-calendar-30min` and `morning-brief-daily` can pull Graph data again.

---

## 2026-05-03 — Epic 1 (partial): dashboard reads email_processing_history; Epic 6 closed (Sentry wired)

**Epic 1 — data wiring landed:**
- Dashboard `loadEmails()` now enriches the Graph fetch with a Supabase JOIN against `email_processing_history` keyed by `email_id` = Graph message id. Maps DB `ai_category` (`do|plan|delegate|eliminate`) onto dashboard `Email.ai_quadrant` (`do|schedule|delegate|eliminate`) with `plan → schedule`. Passes `ai_client_name` through. The existing `emailToQuadrant()` and `emailCategory()` helpers consume these naturally — no UI work required.
- Briefing tab now shows a tiny footer: `N of M emails AI-classified · K heuristic` so the user can see classification coverage.
- Defensive: enrichment failures (RLS, network, timeout) silently fall through to heuristic — no user-visible regression. With `email_processing_history` currently at 22 rows, most of the inbox still uses heuristic; coverage grows as the n8n classifier feeds more rows.

**Epic 1 — deferred to a follow-up PR after external UX/UI design process:**
- New tabs/sidebar: Follow-ups, Decisions, Rocks, Annual goals (data is live but new UI surfaces should match the design refresh)
- Tasks tab `quadrant_override` toggle
- Calendar tab cache from `calendar_events` (table empty; needs `ms-calendar` cron wiring)

**Epic 6 — closed:** `@sentry/nextjs` v10.51 wired across browser, server, and edge runtimes. Init configs gated on `NEXT_PUBLIC_SENTRY_DSN` (graceful no-op if missing). Tunnel route at `/monitoring` to bypass ad-blockers. **User must add `NEXT_PUBLIC_SENTRY_DSN` to Vercel env vars (all 3 environments) for production capture.**

---

## 2026-05-03 — Epic 6 (partial): observability — cron failure alerts + /api/health

**Why:** With Epic 0 + 2 + 4 in production and an unattended cron driving the daily brief, silent failures became the highest-leverage risk. Richard wakes up, no email, no signal anything is wrong.

**Landed in this PR:**
- `morning-brief` `notifyFailure(err, where)` helper. Best-effort path: Graph token → user email → red-themed HTML email with timestamp + error + stack hint. Wraps the main handler's catch block so any error during brief generation, persistence, or email delivery emits a loud failure email. Inner try ensures a broken alert path can never mask the original error.
- `/api/health` Next.js route. GET returns `{ status, timestamp, today_aest, checks }`. Checks: Supabase reachable, today's brief row exists, brief emailed (only flagged degraded after 07:00 AEST on weekdays). Returns HTTP 503 on degraded so external uptime monitors treat as down.
- `INFRASTRUCTURE.md` updated with cron-runs SQL audit query and health-endpoint reference.

**Deferred to a follow-up Epic 6 PR:**
- Sentry wiring — needs DSN.
- Playwright smoke tests — high setup cost, lower marginal value.
- ms-outlook-folders failure alerts — runs every 15 min, would be too noisy without rate-limiting; revisit if the SQL audit query shows ongoing failures.

---

## 2026-05-03 — Epic 0 closed: cron resumed

After the morning-brief consolidation landed, the only remaining Epic 0 task was unpausing `sync-outlook-matrix`. Pre-flight verification:

- `eisenhower_tasks`: 0 email-source rows (was 227,407 pre-cleanup), 35 manual.
- Partial unique index `ux_eisenhower_tasks_source_email_id` already in place.
- New `ms-outlook-folders` (Claude Haiku 4.5) deployed earlier today.

Manual trigger #1: HTTP 200, created 57 tasks from 75 emails (13 consolidated). 22 Do, 18 Schedule, 17 Delegate.
Manual trigger #2 (idempotency check): HTTP 200, created 0 — every email already synced.

Cron re-enabled at the original `*/15 * * * *` cadence. Recreated via `cron.unschedule('sync-outlook-matrix')` + `cron.schedule(...)` because direct `UPDATE cron.job SET active = true` is permission-denied on the hosted Supabase plan.

---

## 2026-05-03 — Brief consolidation + Lovable kill

**Why:** Three overlapping brief paths (`daily-brief`, `chat` brief mode, `send-brief`) wrote to the same `ai_daily_briefs` table from different prompts and models. The email path was broken because `daily-brief` (Lovable Gemini) had no API key set. User wants Claude across the board.

**Architecture change:**
- New `morning-brief` Edge Function — single source of truth for brief generation, persistence, and email delivery. Body: `{force?, send?, context?}`. Calls Anthropic Claude Sonnet 4.5. Cron path fetches today's calendar from Graph for richer context. Source in `supabase/functions/morning-brief/`.
- pg_cron `send-brief-daily` unscheduled. New `morning-brief-daily` (`30 20 * * 1-5`) calls morning-brief with `{"send": true}`.
- Dashboard `BriefingTab` now POSTs to `/morning-brief` (was `/chat`).
- `chat` Edge Function refactored — brief mode removed, now a pure conversational assistant (still Claude Sonnet 4.5, still uses CRM + EA context).
- `ms-outlook-folders` migrated from Lovable Gemini to Claude Haiku 4.5 (cost log entries updated).
- `daily-brief` and `send-brief` overwritten with 410 Gone stubs. Safe to delete from Supabase once unused for >7 days.
- `LOVABLE_API_KEY` env var no longer referenced by any deployed code.

**First live morning-brief test:** generated a 3,100-char brief with Sonnet 4.5 using 3 calendar events + 15 Q1 tasks + 13 Q2 tasks + 1 Q3 task + 0 follow-ups. Email arrived in `richard.palmer@qurate.com.au` at `2026-05-03T00:26:40Z`.

**Cost model:**
- morning-brief / chat / draft-reply: Claude Sonnet 4.5 — $3 in / $15 out per MTok
- ms-outlook-folders: Claude Haiku 4.5 — $1 in / $5 out per MTok

---

## 2026-05-02 — Epic 2: scheduled email brief

**What:** New `send-brief` Edge Function (v1) plus pg_cron `send-brief-daily` (`30 20 * * 1-5`, weekdays at 06:30 AEST / 07:30 AEDT). Pipeline:

1. Calls existing `daily-brief` Edge Function (returns cached or generates fresh).
2. Skip if `ai_daily_briefs.sent_at` is already set for today (override with `{force:true}`).
3. Gets MS Graph access token via `ms-auth` (Vault-stored refresh token).
4. Looks up user email via `/me`.
5. Renders the brief markdown to HTML with `marked@13`.
6. Posts to Graph `/me/sendMail` with high importance + saved to Sent Items.
7. Updates `ai_daily_briefs.sent_at`.

Migration `ai_daily_briefs_sent_at` adds the new `sent_at timestamptz` column.

**Required to make the cron functional end-to-end:**
- The user must be re-logged into Microsoft (refresh token in Vault). Otherwise step 3 fails with "Not connected to Microsoft".
- `LOVABLE_API_KEY` env var must be set in Supabase Edge Functions secrets (Dashboard → Project Settings → Edge Functions → Secrets). As of this commit it's unset, which is why a manual smoke test of `send-brief` returns: `daily-brief 500: LOVABLE_API_KEY is not configured`.

**Verified:** Function deploys and is reachable; smoke test returns the expected error from the missing AI key, proving the wiring is correct end-to-end.

---

## 2026-05-02 — Microsoft OAuth refresh token moved to Vault

**Why:** The previous design persisted both the refresh token and the access token in plaintext in `public.microsoft_oauth_tokens`. A database leak or an over-permissive RLS change would have handed an attacker bearer credentials. Moving to Vault encrypts the refresh token at rest and removes access-token storage entirely.

**What changed:**
- Migration `ms_auth_vault_refactor` created four SECURITY DEFINER wrappers (`set_ms_refresh_token`, `get_ms_refresh_token`, `delete_ms_refresh_token`, `has_ms_refresh_token`) that proxy `vault.secrets` operations. Granted `EXECUTE` to `service_role` only.
- Dropped `public.microsoft_oauth_tokens` (was already empty so no data lost).
- `ms-auth` v46 deployed: callback writes only the refresh token (to Vault); default action always exchanges the stored refresh token for a fresh access token at Microsoft and returns it to the caller. Access tokens never persist anywhere.

**Operational impact:**
- Every Graph-token request now incurs ~300–500ms for the Microsoft refresh round-trip (was ~50ms when serving cached tokens).
- Microsoft refresh-token rotation is handled — if MS returns a new refresh token, it's written to Vault.
- **Richard must re-login** through Microsoft to re-establish the refresh token in Vault. The `ms_auth_connected` cookie is stale; visiting the dashboard will hit the broken state and a Sign-in click takes care of it.

**Verified:** `ms-auth?action=status` returns `{connected: false}` (no token in Vault), with a 200 status — the wrappers and Vault are wired.

---

## 2026-05-02 — VIP auto-sync from SharePoint

**What:** New Edge Function `sync-vips` plus pg_cron `sync-vips-daily` (`0 19 * * *`, 06:00 AEDT). Pulls company names from:
- SharePoint site `quratepty.sharepoint.com/sites/QurateClient` → `02.  Work in Progress` + `01.  Archive` (folders matching `Qurate Clients - <NAME>`)
- Personal OneDrive `1. Own - Engagements` (folders matching `<N>.  <NAME>`, with abbreviation map for `LoP` → "Land of Plenty" and `Thinkwater` → "Think Water")

Result is upserted into `user_preferences.vip_companies_auto`. The dashboard's `useUserSettings` hook merges this with the user-editable `vip_companies` (case-insensitive) and exposes a single `vipCompaniesMerged` for VIP detection across Email, Clients, and Briefing tabs.

**`ms-auth` redeployed** with new OAuth scopes: added `Sites.Read.All` + `Files.Read.All`. The `prompt=consent` query param now forces re-consent on login so newly-added scopes get granted explicitly.

**First sync run:** 9 clients found — Belco, Clipex, Forza Capital, Hedx, Land of Plenty, OnTalent, PWAG, Think Water, Vee Design.

**Source code now version-controlled** in `qurate-admin/supabase/functions/{ms-auth,sync-vips}/index.ts`. Future changes go through PR review.

---

## 2026-05-02 — Epic 0: stop the runaway cron + dedupe

**Trigger:** Audit revealed `eisenhower_tasks` had grown to 227,406 rows with only 2,056 distinct `source_email_id` values — ~110× duplication caused by a buggy dedup check in `ms-outlook-folders` running every 15 minutes via `sync-outlook-matrix` pg_cron.

**Actions taken (in order):**

1. **Paused the cron** via `cron.alter_job(jobid, active := false)`. Direct `UPDATE cron.job` was permission-denied; `alter_job` is the supported path.
2. **Deduped `eisenhower_tasks`**: kept one row per `source_email_id`, prioritising rows that had been touched (status != 'open' → quadrant_override → multi-source consolidated → earliest by `created_at`). Result: 227,406 → 2,056 rows. All 34 user-touched rows preserved. All 12 multi-source consolidated tasks preserved.
3. **Added a partial unique index** as defence-in-depth (`ux_eisenhower_tasks_source_email_id` — partial, scoped to `source_email_id IS NOT NULL AND source_type = 'email'`). Migration `add_unique_index_eisenhower_tasks_source_email_id`.

**Verification:**
- `SELECT * FROM cron.job WHERE jobname = 'sync-outlook-matrix'` → `active = false` ✓
- `SELECT count(*), count(DISTINCT source_email_id) FROM eisenhower_tasks WHERE source_type='email'` → `2056, 2056` ✓
- `SELECT indexname FROM pg_indexes WHERE indexname = 'ux_eisenhower_tasks_source_email_id'` → present ✓

**What still needs doing before resuming the cron:**
- Fix `ms-outlook-folders` dedup query — replace the fetch-all-then-filter pattern with `.in('source_email_id', messageIds)`. See `INFRASTRUCTURE.md` for the patched snippet.
- Once the function is patched and deployed, resume with `SELECT cron.alter_job(jobid, active := true) FROM cron.job WHERE jobname = 'sync-outlook-matrix'`.
- Consider lowering frequency from `*/15 * * * *` to hourly or moving to a Graph webhook trigger.

**Reversal path (if needed):** the deletion is not reversible without a backup. Supabase's PITR (Point-in-Time Recovery) is available on Pro plans and could restore to a state before this cleanup if rollback ever becomes necessary.
