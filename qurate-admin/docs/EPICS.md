# Epics — Path to Production (v2, post Supabase audit)

> Replaces v1. The v1 epics treated the project as if only the Next.js repo existed. After auditing the live Supabase project we now know:
> - The classification pipeline already exists (it just isn't wired to the dashboard)
> - The daily brief already exists (it just isn't scheduled or emailed)
> - There's a runaway cron quietly burning money
>
> See `docs/BRD.md` for the full ground-truth picture.

Critical path to "scheduled email brief in production": **Epic 0 → Epic 4 → Epic 2 → Epic 6**.

---

## Epic 0 — Stop the runaway, clean up the data 🚨

**Why:** A pg_cron job (`sync-outlook-matrix`, every 15 min) calls `ms-outlook-folders` which inserts duplicate `eisenhower_tasks` rows. 227,407 total rows, only 1,401 distinct titles → ~160× duplication. Each tick burns Lovable AI credits classifying emails it has already seen. Until this is fixed, every other epic is operating on corrupted data and the AI bill keeps climbing.

**Scope**
1. **Pause the cron immediately** (`UPDATE cron.job SET active = false WHERE jobname = 'sync-outlook-matrix'`)
2. **Diagnose the dedup failure** in `ms-outlook-folders`. Most likely cause: the `existingIds` set is built from a 227k-row scan that times out or runs concurrently with another cron tick. Verify by checking edge-function logs around the duplicate creation timestamps.
3. **Add a unique index** on `(source_email_id) WHERE source_email_id IS NOT NULL AND source_type = 'email'` so the database itself rejects duplicates. This is the safety net.
4. **Clean existing duplicates**: keep the earliest row per `source_email_id`, delete the rest. Estimate: 226k rows deleted, 1,401 kept.
5. **Reduce cron frequency** to hourly or run on Graph webhook instead.
6. **Resume cron** only once the unique index is in place.

**Acceptance criteria**
- `select count(*), count(distinct source_email_id) from eisenhower_tasks where source_type='email'` returns roughly equal numbers
- Cron runs without creating duplicates (verified by tasks created vs distinct emails over 24h)
- `api_cost_log` for `email_task_extraction` operation drops by ~95%

**Estimate:** 1 session.

---

## Epic 1 — Bridge dashboard ↔ back-of-house

**Why:** The dashboard reads from 2 of 21 tables. The back-of-house has been classifying emails into `email_processing_history` (2,343 rows) and the daily-brief reads it, but the dashboard doesn't. So Richard sees raw Graph emails with heuristic categorisation while a richer classification sits in the database, ignored.

**Scope**
1. **Email tab**: instead of fetching only from Graph, JOIN with `email_processing_history` on `email_id`. Display the AI category, priority level, suggested actions, and client. Heuristic fallback only when the email hasn't been classified yet.
2. **Calendar tab**: switch to reading from `calendar_events` (call `ms-calendar` with `persist=true` first to populate). Falls back to live Graph if table empty.
3. **Tasks tab**: filter `eisenhower_tasks` by `quadrant_override = false` to surface AI suggestions vs human overrides; expose the `quadrant_override` toggle so Richard can correct the AI.
4. **Clients tab**: switch from hardcoded VIP_CLIENTS to reading `vip_contacts` (after Epic 4 populates it).
5. **Briefing tab**: it already reads `ai_daily_briefs` correctly. Add a "what data was used" footer using the `dataSnapshot` field returned by the Edge Function.
6. New tab or sidebar: **Follow-ups** (read from `follow_ups`), **Decisions** (`core_decisions`), **Rocks** (`strategy_rocks`).

**Acceptance criteria**
- Dashboard email categorisation matches `email_processing_history.ai_category` for any email present there
- Calendar shows from cached table if available
- A new task created via the matrix is visible in `eisenhower_tasks` with `quadrant_override = true`

**Dependencies:** Epic 0 (don't build on corrupted task data).

**Estimate:** 2–3 sessions.

---

## Epic 2 — Schedule the daily brief + email delivery

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

## Epic 6 — Quality & observability (carry forward)

Unchanged from v1. Playwright smoke tests, Sentry, `/api/health`, structured Edge Function logs. Becomes critical once Epic 0 is fixed and Epic 2 ships scheduled briefs (silent failures = Richard doesn't get his brief and doesn't know).

**Estimate:** 1–2 sessions.

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
