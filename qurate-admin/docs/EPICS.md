# Epics — Path to Production (v2, post Supabase audit)

> Replaces v1. The v1 epics treated the project as if only the Next.js repo existed. After auditing the live Supabase project we now know:
> - The classification pipeline already exists (it just isn't wired to the dashboard)
> - The daily brief already exists (it just isn't scheduled or emailed)
> - There's a runaway cron quietly burning money
>
> See `docs/BRD.md` for the full ground-truth picture.

Critical path to "scheduled email brief in production": **Epic 0 → Epic 4 → Epic 2 → Epic 6**.

---

## Epic 0 — Stop the runaway, clean up the data ✅ shipped 2026-05-03

> Cron `sync-outlook-matrix` resumed at `*/15 * * * *` after the safety net is in place.

**What landed:**
1. Cron paused at the start of audit work (active=false).
2. Dedup root cause fixed: new `ms-outlook-folders` queries `eisenhower_tasks` with `.in("source_email_id", messageIds)` instead of fetching the whole table and filtering in memory (PR #39 / #40 / consolidation).
3. Partial unique index created: `ux_eisenhower_tasks_source_email_id ON eisenhower_tasks (source_email_id) WHERE source_email_id IS NOT NULL AND source_type = 'email'`. The DB itself now rejects duplicates.
4. Historical duplicates removed — table went from 227,407 email-source rows to 0 (only manual rows survived). Then a fresh sync repopulated 57 distinct email tasks from 75 emails (13 consolidated by sender).
5. AI provider migrated: Lovable Gemini → Anthropic Claude Haiku 4.5 (cheaper, more reliable, source-controlled).
6. Idempotency confirmed via two consecutive manual triggers — second run created 0 tasks.
7. Cron re-enabled 2026-05-03.

---

## Epic 1 — Bridge dashboard ↔ back-of-house ✅ shipped 2026-05-03

> Dashboard now reads the back-of-house schema instead of treating Graph as the single source of truth.

**Landed:**
- **Mail tab AI classification** — `loadEmails` enriches Graph results with `email_processing_history.ai_category` (mapping DB values `do|plan|delegate|eliminate` onto dashboard `Email.ai_quadrant` `do|schedule|delegate|eliminate`, `plan → schedule`). Passes `ai_client_name` through. Existing `emailToQuadrant()` and `emailCategory()` consume the populated fields naturally. Defensive: enrichment failures fall through silently — Mail tab still renders with heuristic categorisation, no regression. Briefing footer shows "N of M emails AI-classified · K heuristic".
- **Calendar caching** — `loadCalendar` reads `calendar_events` first (window: today through today+14, freshness < 2 hours). Falls back to live Graph when the cache is empty/stale (e.g. fresh OAuth, missed cron). New pg_cron `sync-calendar-30min` calls `ms-calendar?persist=true` for the 14-day window every 30 min. `ms-calendar` source pulled into `supabase/functions/ms-calendar/` (Epic 3 progress).
- **Tasks `quadrant_override`** — `moveTask` sets `quadrant_override = true` on every manual drag and captures `ai_suggested_quadrant` (preserving the AI's original guess) the first time the user overrides. Cards display an `↻ override` badge with tooltip "AI originally suggested Q…".
- **Briefing data-snapshot footer** — renders `data_snapshot` returned by `morning-brief` (`X Q1 · Y Q2 · Z events · …`) so the user sees what the brief was built from.
- **Strategy Rocks (EOS)** — Briefing tab now displays the 7 rows in `strategy_rocks` with status pill (on track / at risk / off track) and percent-complete.
- **Clients tab** — already done as part of Epic 4 (`vipCompaniesMerged` = manual ∪ SharePoint-synced; `vip_contacts` table is unused and can be dropped in a future cleanup).

**Skipped (deferred until design refresh comes back from external UX/UI process):**
- New tabs for **Follow-ups** (`follow_ups`, 0 rows) and **Decisions** (`core_decisions`, 0 rows) — no data + IA changes conflict with the in-flight redesign.
- **Annual goals** display (`eos_annual_goals`, 6 rows) — same rationale as above.

**Pre-flight blocker (separate from this PR):** `ms-auth` currently reports "Not connected to Microsoft" — the Vault `microsoft_refresh_token` has been invalidated. User must re-sign-in via the dashboard before `sync-calendar-30min` and `morning-brief-daily` can pull Graph data again. Code changes here still ship cleanly because the cache-read path degrades gracefully.

---

## Epic 2 — Daily brief, generated and emailed by Claude ✅ shipped 2026-05-03

> Single Edge Function `morning-brief` (Claude Sonnet 4.5) owns the whole pipeline: pulls EA + CRM + calendar data, generates the brief, persists to `ai_daily_briefs`, optionally renders to HTML and emails via Graph. pg_cron `morning-brief-daily` fires weekday mornings at 06:30 AEST. See `docs/CHANGELOG.md` (2026-05-03 entry) for the consolidation story and `supabase/functions/morning-brief/index.ts` for the source.

**Why:** `daily-brief` already exists and works (the Gate 5 prompt is sophisticated). Two things are missing: (a) it's only triggered by the dashboard, never on a schedule; (b) it stores the brief but never delivers it.

**Scope**
1. **Verify `microsoft_oauth_tokens` populates correctly.** Currently empty — see BRD §4. Do a fresh OAuth flow and confirm a row appears. If not, fix `ms-auth` `storeTokens`.
2. **Add a `send-brief` Edge Function** that:
   - Calls existing `daily-brief` (with `forceRefresh: false` so we use today's cache if it exists)
   - Converts the markdown brief to HTML (use `marked` or similar)
   - Calls Graph `/me/sendMail` to send to Richard's address (uses `ms-auth` to get token)
   - Marks the brief as sent (new `sent_at` column on `ai_daily_briefs`)
3. **Add pg_cron entry**:
   ```sql
   SELECT cron.schedule('daily-brief-send', '30 19 * * 1-5',  -- 06:30 Sydney AEST = 20:30 UTC
     $$ SELECT net.http_post(url := '<send-brief-url>', headers := ..., body := '{}') $$);
   ```
4. **Settings UI** to control send time + days-of-week (writes to `user_preferences` after Epic 4).

**What is NOT in scope:** redesigning the brief itself. The Gate 5 prompt is good.

**Acceptance criteria**
- Brief lands in Richard's inbox at the configured time, weekdays only
- Manual `curl` to `/send-brief` returns success in <30s with brief in body
- `ai_daily_briefs.sent_at` populated
- Skipping a day (e.g. weekend or paused) doesn't double-send

**Dependencies:** Epic 0 (don't build on broken data), confirmed working `microsoft_oauth_tokens`.

**Estimate:** 1–2 sessions.

---

## Epic 3 — Version-control the back-of-house

**Why:** 13 Edge Functions and 38 migrations live only in Supabase. If the project is deleted or someone trips a delete, recovery is hard. Also: making changes via the dashboard is opaque; PRs against `supabase/functions/<name>/index.ts` are reviewable.

**Scope**
1. Create `supabase/` folder in the repo
2. `supabase/functions/<slug>/index.ts` for each of the 13 Edge Functions (pull current source via MCP)
3. `supabase/migrations/<timestamp>_<name>.sql` for each migration (pull via MCP)
4. `supabase/seed.sql` for the seed data (clients, vips, prompts)
5. Add Supabase CLI to dev dependencies + `npm run supabase:db-push`, `npm run supabase:functions-deploy` scripts
6. Document in README how to deploy

**Acceptance criteria**
- `supabase functions deploy --no-verify-jwt <slug>` deploys identical-to-prod source from the repo
- Schema diff between repo and Supabase is empty
- A new contributor can clone the repo and bring up an empty Supabase project that matches prod

**Estimate:** 1 session (mostly mechanical pulling and committing).

---

## Epic 4 — Settings to Supabase + VIP propagation (shrunk)

**Why:** Settings (briefing time, focus block, VIP list) live in `localStorage` so:
- They don't survive a device switch
- The cron in Epic 2 can't read them
- Editing the VIP list does nothing (the rest of the app uses the hardcoded `VIP_CLIENTS` constant)

The `user_preferences` table (key/value, RLS open) and `vip_contacts` table both exist already.

**Scope**
1. Refactor SettingsTab to load/save from `user_preferences` (keys: `briefing_time`, `briefing_timezone`, `focus_start`, `focus_end`)
2. Migrate VIP list to `vip_contacts` table
3. Move `VIP_CLIENTS` constant out — replace with a `useVipContacts()` hook used by `emailCategory()`, `ClientsTab`, briefing prompt context
4. One-time localStorage → Supabase migration on first dashboard load

**Acceptance criteria**
- Open Settings on different device → values match
- Add a new VIP → reflected immediately in Email tab and Clients tab
- localStorage `pref_*` keys cleared after migration

**Dependencies:** none.

**Estimate:** 1 session.

---

## Epic 5 — Dashboard decomposition (carry forward)

Unchanged from v1. ~2,300-line `app/dashboard/page.tsx` → split each tab into its own file under `app/dashboard/_components/`, hooks under `app/dashboard/_hooks/`. No behavioural changes. Lands the prerequisite for parallel feature work and proper testing.

**Estimate:** 1 session.

---

## Epic 6 — Quality & observability ✅ shipped 2026-05-03

**Landed:**
- `morning-brief` failure-alert email (silent failures are now loud). Wraps the main catch block, sends a red-themed HTML email to the user via Graph. Inner try/catch so a broken alert can never mask the original error.
- `/api/health` Next.js route — JSON status of Supabase + today's brief + brief email delivery. HTTP 503 when degraded, suitable for any external uptime monitor.
- `INFRASTRUCTURE.md` cron-runs audit query (`cron.job_run_details`).
- **Sentry wired** for browser, server, and edge runtimes via `@sentry/nextjs` v10.51 (`instrumentation.ts`, `sentry.{client,server,edge}.config.ts`, `withSentryConfig` in `next.config.js`). Tunnel route `/monitoring` to bypass ad-blockers. DSN read from `NEXT_PUBLIC_SENTRY_DSN` env var; missing DSN → SDK no-ops gracefully.

**Carried forward to Epic 5:**
- Playwright smoke tests — better introduced after dashboard decomposition so tests target stable component boundaries.
- `ms-outlook-folders` failure alerts — runs every 15 min, would need rate-limiting before adding.
- Structured Edge Function logs — `console.log` is fine until volume grows.

---

## Epic 7 — Multi-tenant (deferred)

Unchanged from v1. Only relevant if you want a second user. Most epics above will need revisiting (add `user_id` everywhere, switch RLS to `auth.uid()`, dynamic prompts, onboarding flow).

---

## Out of scope

- Calendar event creation / RSVP
- Inbox search UI
- Task recurrence
- Push notifications (replaced by email in Epic 2)
- Rebuilding the brief itself (Gate 5 is good)
- Building a new email classifier (`email_processing_history` already does this — Epic 1 just consumes it)

---

## Suggested order

```
WEEK 1
  Epic 0  — Stop the runaway (urgent, ~1 session)
  Epic 4  — Settings persistence (~1 session)
  Epic 2  — Scheduled email brief (~1–2 sessions)

WEEK 2
  Epic 1  — Bridge dashboard ↔ back-of-house (~2–3 sessions)
  Epic 3  — Version-control back-of-house (~1 session)

WEEK 3+ (as needed)
  Epic 5  — Decompose dashboard
  Epic 6  — Tests + observability

LATER
  Epic 7  — Multi-tenant
```
