# Epics — Path to Production

Source of truth: `docs/BRD.md`. This file converts the BRD's gap analysis into prioritised, scoped epics with clear acceptance criteria so we can build them one at a time.

**Scope assumption:** "Production" here means "reliable enough that Richard depends on it daily, runs unattended, and survives an MS token expiry, a Vercel deploy, and a week of inattention." Multi-tenant SaaS is called out separately as Epic 7 (optional for v1).

Order is value × leverage. Epics 1–4 are the critical path. 5–6 are quality hardening. 7 is a product decision.

---

## Epic 1 — Email Intelligence Pipeline

**Why:** The single biggest hole in the product. The UI consumes `ai_quadrant`, `ai_priority_level`, `ai_category`, `ai_client_name` on every email but **nothing in the codebase writes them**. Today, triage falls back to a domain-substring heuristic in `emailCategory()`. Without this epic, the agent isn't actually intelligent — it's a styled inbox.

**Scope**
- New Supabase Edge Function `/classify-email` (Claude Haiku):
  - Input: a Graph email object (id, subject, from, body preview)
  - Output: `{ ai_quadrant, ai_priority_level, ai_category, ai_client_name }`
- New table `email_classifications` keyed by Graph `message.id` (string PK), with `user_id`, the four AI fields, `classified_at`, `model_version`
- Inbox loader (`loadEmails()` in `app/dashboard/page.tsx`) does a join: for each fetched message, look up its classification row; if missing, fire-and-forget call to `/classify-email` and update on next refresh
- Migration adds `email_classifications` table with RLS

**Acceptance criteria**
- Open Email tab → every email shows a quadrant chip without falling through to heuristics
- Inspect `emails[0]` in browser console → `ai_quadrant` etc. populated from DB, not from `emailCategory()` fallback
- Re-render is fast: classification is async, doesn't block first paint
- Costs: log token usage per call, expect ~$0.0002 per email at Haiku rates

**Dependencies:** none. Can ship standalone.

**Estimate:** 1–2 sessions.

---

## Epic 2 — Scheduled Daily Brief via Email

**Why:** The brief today only runs when Richard remembers to click the button. A scheduled brief landing in his inbox every morning is the autonomous-EA promise of the product. This is the user's refined plan — restated here for the record.

**Hard constraint** that drives the design: MS access tokens are short-lived (~1 hour) and live only in the Edge Function's runtime. A cron has no session, so we must persist a **refresh token** to mint access tokens server-side.

**Scope**
- Schema: `user_tokens` table (single row per user — `user_id`, `refresh_token`, `expires_at`, `updated_at`)
- `ms-auth` Edge Function: persist `refresh_token` on OAuth callback (~5 line addition)
- New Edge Function `/send-brief`:
  1. Read refresh token → exchange for access token via Azure AD
  2. Fetch `/me/messages` + `/me/calendarView` (same as dashboard)
  3. Call Claude (same prompt as `BriefingTab` uses)
  4. Insert into `ai_daily_briefs`
  5. Send via Graph `/me/sendMail` to user's own address with high-priority flag
- New Next.js route `/api/cron/brief` (cron-secret protected) → POSTs to `/send-brief`
- `vercel.json` cron entry pointing at `/api/cron/brief`

**What is NOT in scope** (deliberately)
- No new UI
- No changes to existing Edge Functions besides the refresh-token persist line
- No multi-recipient logic, no opt-in/opt-out flows (single user)

**Acceptance criteria**
- Brief lands in Richard's inbox at the configured local time, every weekday
- Manual `curl` to `/send-brief` with valid auth header generates and sends a brief in <30s
- A row appears in `ai_daily_briefs` for every send
- Killing and restarting the Vercel deployment doesn't break the schedule

**Decisions needed before build** (see chat)
1. Send time (UTC)
2. Brief prompt: reuse vs. tuned-for-email
3. Email format: HTML vs. plain text
4. Cron secret name + storage

**Dependencies:** Epic 1 is *not* required (the brief works on raw emails) but the brief's quality improves significantly once classifications exist. Reasonable to ship Epic 2 first if you want the unblock-the-loop win sooner.

**Estimate:** 1–2 sessions.

---

## Epic 3 — Email → Task Extraction

**Why:** Today, Eisenhower task creation is purely manual. The most common workflow ("this email needs an action — capture it") requires retyping. A one-click "extract tasks from this email" turns inbox triage into matrix progress and closes the email→task loop the BRD calls out.

**Scope**
- New Edge Function `/extract-tasks` (Claude Haiku):
  - Input: email id, subject, from, body
  - Output: array of `{ title, description, quadrant, due_date?, estimated_minutes? }`
- New button in email detail panel: "Extract tasks"
- For each returned task, insert into `eisenhower_tasks` with `email_ids` set to source email
- UX: brief inline confirmation showing how many tasks were created, with link to Matrix tab

**Acceptance criteria**
- Open an email with action items → click "Extract tasks" → tasks appear in Matrix tab within 5s
- `eisenhower_tasks.email_ids` correctly references the source email
- Clicking a task in Matrix can navigate back to its source email (via `email_ids`)
- Idempotency: re-clicking on the same email doesn't double-create (dedupe on `(email_id, title)` or last-extraction timestamp on the email row)

**Dependencies:** none, but quality benefits from Epic 1.

**Estimate:** 1 session.

---

## Epic 4 — Settings Persistence + Multi-Device

**Why:** Briefing time, focus block window, and VIP client list all live in `localStorage`. Switch devices → settings gone. More critically, **Epic 2's cron has no `localStorage`** so it can't read the configured send time. Persisting settings to Supabase is a prerequisite for any autonomous behaviour.

**Scope**
- New table `user_settings` (one row per user): `briefing_time_local`, `briefing_timezone` (IANA), `focus_block_start`, `focus_block_end`, `vip_clients` (text[]), `auto_archive_rules` (jsonb), `updated_at`
- Migrate the SettingsTab's `localStorage` reads/writes to Supabase REST calls
- Migration of existing `localStorage` values on first load (one-time)
- Edge Functions read settings from `user_settings` instead of receiving them as request params

**Acceptance criteria**
- Open Settings on a different device → values match
- Update VIP list → reflected in ClientsTab on a different browser session
- Clear browser storage → settings survive
- `/send-brief` Edge Function reads send time from `user_settings`, not env vars

**Dependencies:** must ship before Epic 2 hits production (cron needs to know what time to send).

**Estimate:** 1 session.

---

## Epic 5 — Dashboard Decomposition

**Why:** `app/dashboard/page.tsx` is ~2,300 lines containing all 7 tabs. It's the single biggest blocker to working on multiple features in parallel and the file most likely to cause merge conflicts. Every future epic gets cheaper after this lands.

**Scope**
- Move each `*Tab` function to its own file under `app/dashboard/_components/`
- Hoist data-fetching hooks (`useEmails`, `useCalendar`, `useTasks`, `useBriefs`) into `app/dashboard/_hooks/`
- Co-locate types in `app/dashboard/_types.ts`
- Tab routing stays in `page.tsx` — but `page.tsx` should drop below ~300 lines
- **No behavioural changes** — pure refactor

**Acceptance criteria**
- `wc -l app/dashboard/page.tsx` returns a number < 300
- Smoke test: every tab still works exactly as before, including drag/drop and AI calls
- No change in bundle size of >5%

**Dependencies:** none, but should land before Epic 6 (tests are easier to write against decomposed code).

**Estimate:** 1 session, no AI calls needed during the work.

---

## Epic 6 — Quality & Observability

**Why:** No tests, no error tracking. With autonomous behaviour added (Epic 2), silent failures become a real risk. Production = you find out when something breaks before Richard does.

**Scope**
- Playwright smoke suite covering: login → dashboard → load emails → generate brief → create task → drag task. ~6 tests, run on Vercel preview deploys.
- Sentry (or similar) wired into both Next.js app and Edge Functions
- Health check endpoint `/api/health` that pings Supabase + Anthropic and returns 200/503
- Edge Function structured logs (request id, user id, latency, token usage) into Supabase `function_logs` table
- Vercel deploy hook to run `npm run build` + Playwright on PRs

**Acceptance criteria**
- Break a fetch URL on a feature branch → CI fails, doesn't merge
- Force a 500 in `/send-brief` → Sentry captures it, you get an alert
- Open `/api/health` → returns dependency status

**Dependencies:** Epic 5 makes test-writing easier but not required.

**Estimate:** 1–2 sessions.

---

## Epic 7 — Multi-Tenant Foundation *(optional for v1)*

**Why:** Today "Richard" is hardcoded into prompts and there is no `user_id` column anywhere. If the product stays personal, this epic can be deferred indefinitely. If you ever want a second user (an exec at Therefore, Armillary, etc.), every epic above gets re-done unless this lands first.

**Strong recommendation:** even if staying single-user, **add `user_id` to all tables now** with `auth.uid()` defaults. The cost is small now and immense later.

**Scope**
- Add Supabase Auth (email magic link or MS SSO mapping)
- `user_id uuid not null default auth.uid()` on `eisenhower_tasks`, `ai_daily_briefs`, `email_classifications`, `user_settings`, `user_tokens`
- RLS policy: `auth.uid() = user_id` on every table
- Replace hardcoded "Richard" in prompts with the authenticated user's display name (from MS Graph `/me`)
- Onboarding: first-time MS OAuth → creates user row + empty settings + redirects to Settings

**Acceptance criteria**
- Two users can log in to the same deployment and see only their own emails/tasks/briefs
- All Edge Functions enforce `user_id` filtering server-side
- No reference to "Richard" remains in code or prompts

**Dependencies:** ideally *all other epics* take `user_id` into account from day one; doing this last means revisiting them.

**Estimate:** 2–3 sessions (mostly migration + auth setup).

---

## Suggested Order

```
Now ──▶ Epic 4 (Settings persistence)        ← unblocks Epic 2
        Epic 2 (Scheduled brief via email)   ← biggest user-facing win
        Epic 1 (Classification pipeline)     ← biggest product-quality win
        Epic 3 (Email → tasks)               ← biggest UX win
        Epic 5 (Decompose dashboard)         ← every future epic gets cheaper
        Epic 6 (Tests + observability)       ← production readiness
Later ─▶ Epic 7 (Multi-tenant)               ← only if/when needed
```

**Critical path to "scheduled email brief in production":** Epic 4 → Epic 2 → Epic 6 (tests for the cron path).

---

## Out of scope (deferred from BRD)

- Calendar event creation / RSVP (BRD §6 D9)
- Inbox search UI (BRD §6 D10)
- Task recurrence
- Push notifications (PWA-based) — replaced by email delivery in Epic 2

These can be added once the agent is reliably autonomous and the platform is stable.
