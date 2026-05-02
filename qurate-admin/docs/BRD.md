# BRD — Qurate Admin Agent (v2, post Supabase audit)

> **Supersedes the v1 BRD entirely.** v1 was based only on the Next.js repo and missed the entire backend pipeline. This version reflects ground truth from a 2026-05-02 audit of project `btzlkiwmdegubbvzbmyo` (qurate-ea).

---

## Headline finding: this is two products glued together

There are **two parallel data flows**, and they barely talk to each other:

```
                ┌────────────────────────────────────┐
                │       Microsoft 365 (Graph)        │
                └────────────────┬───────────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                                     ▼
   ┌───────────────────────┐           ┌────────────────────────┐
   │   FRONT-OF-HOUSE      │           │     BACK-OF-HOUSE      │
   │   (Next.js Dashboard) │           │ (Edge Fns + pg_cron)   │
   │                       │           │                        │
   │ • Reads emails &      │           │ • Auto-fetches mail    │
   │   calendar live from  │           │   from 4 Outlook       │
   │   Graph on every load │           │   folders (every 15m)  │
   │ • Writes nothing to   │           │ • AI-classifies via    │
   │   the populated       │           │   Lovable Gateway      │
   │   tables              │           │   (gemini-2.5-flash)   │
   │ • Uses anon key       │           │ • Writes 12+ tables    │
   │ • Hardcoded "Richard" │           │ • Uses service role    │
   └─────────┬─────────────┘           └───────┬────────────────┘
             │                                 │
             ▼                                 ▼
   ┌─────────────────────┐    ┌──────────────────────────────────┐
   │  eisenhower_tasks   │    │ email_processing_history (2,343) │
   │  ai_daily_briefs    │    │ calendar_events (0 — broken)     │
   │  (read+write)       │    │ follow_ups, briefing_sections,   │
   │                     │    │ vip_contacts, user_preferences,  │
   │                     │    │ core_clients, strategy_rocks ... │
   └─────────────────────┘    └──────────────────────────────────┘
        ▲                                     │
        │                                     │
        └─────── duplication, no dashboard read ┘
```

The Next.js repo only knows about flow A. The dashboard ignores most of the schema even though the back-of-house has been actively populating it. The classified email pipeline exists but the dashboard's Email tab uses Graph live and falls through to heuristic categorisation. The daily brief reads the back-of-house tables but is invoked manually from the dashboard.

---

## 🚨 Urgent — runaway pg_cron job

A pg_cron job named `sync-outlook-matrix` runs every 15 minutes and calls `ms-outlook-folders`. It's creating ~6,000–8,000 duplicate tasks per day from ~100–130 distinct emails.

| Metric | Value |
|---|---|
| Total `eisenhower_tasks` rows | **227,407** |
| Distinct titles | 1,401 |
| Duplication factor | **~160×** |
| Tasks open / done | 227,372 / 34 |
| Latest task created | 30 seconds ago |
| AI calls per cron tick | tens (gemini-2.5-flash via Lovable) |

The function has dedup logic (`existingIds` set built from a `SELECT source_email_id, source_email_ids FROM eisenhower_tasks WHERE source_type='email'`), but it's clearly failing in production. Likely causes:
1. Concurrent runs of the cron racing the dedup check
2. The dedup query times out at 227k rows and the function silently proceeds
3. `source_email_id` is being normalised differently between insert and check

**This is bleeding Lovable API credits every 15 minutes and corrupting the task table.** Action: pause `sync-outlook-matrix` cron immediately, diagnose, then resume.

---

## 1. Product Summary (corrected)

**Pitch:** A Chief-of-Staff style executive admin agent. Pulls from MS 365 (mail, calendar, optional Teams). Classifies emails into the Eisenhower matrix, tracks Q1 rocks (EOS framework), generates daily executive briefs, stores chat history, drafts replies, and tracks delegate / follow-up risk.

**Primary user:** "Richard" — single-user. Hardcoded into prompts; no user_id column.

**Two product surfaces today:**
- The **dashboard** (mobile PWA) — what Richard interacts with
- The **back-of-house pipeline** (Edge Functions + cron) — what the data team / agent has been building, mostly invisible to Richard

The win for the next 1–2 sessions is **bridging these**.

---

## 2. Edge Functions (13 deployed)

| Function | Verify JWT | What it does | Cron-driven? | Status |
|---|---|---|---|---|
| `ms-auth` | no | OAuth flow + token storage in `microsoft_oauth_tokens`. Refreshes if <5 min to expiry. Service-role writes. | no | works, but token table is empty (see §4) |
| `ms-calendar` | no | Pulls Graph `/me/calendarview`, upserts to `calendar_events` | no | dashboard never calls this — `calendar_events` has 0 rows |
| `ms-outlook-folders` | no | Reads 4 mapped Outlook folders → AI-extracts tasks (Lovable / gemini-2.5-flash) → consolidates per-sender → inserts into `eisenhower_tasks` | **yes (every 15 min)** | **runaway, see §0** |
| `delete-outlook-email` | no | Deletes a Graph message | no | wired |
| `fetch-email` | no | Fetches one Graph message by id (subject/body/from/to/cc) | no | wired |
| `reimport-emails` | no | Re-classification pass | no | unknown |
| `daily-brief` | no | "Gate 5 v2" — reads 12 tables, calls Lovable (gemini-2.5-flash), upserts into `ai_daily_briefs` keyed by date. Caches per day. | no | **works, but never sends email & isn't scheduled** |
| `chat` | yes | Conversational assistant | no | wired to dashboard |
| `draft-reply` | yes | AI email reply generation | no | wired to dashboard |
| `improve-prompt` | no | Prompt iteration tool | no | unknown |
| `active-prompt` | no | Returns active prompt from `ai_prompts` | no | unknown |
| `sender-history` | no | Sender history lookup | no | unknown |
| `follow-ups` | no | Populates `follow_ups` table (emails sent >48h with no reply) | no | unknown — `follow_ups` empty |

**AI provider is Lovable AI Gateway** (`https://ai.gateway.lovable.dev/v1/chat/completions`) using `google/gemini-2.5-flash`. Not Anthropic. The earlier BRD was wrong on this.

---

## 3. Data Model (full picture)

| Table | Rows | Read by dashboard? | Written by | Purpose |
|---|---|---|---|---|
| `eisenhower_tasks` | **227,407 (corrupted)** | yes (CRUD) | `ms-outlook-folders`, dashboard | tasks |
| `email_processing_history` | 2,343 | no | unknown (likely n8n or external) | classified emails — has `ai_category`, `ai_priority_level`, `ai_client_name`, `ai_outlook_folder`, `ai_todo_list`, `ai_planner_task_title`, `ai_actions_suggested`, `manual_review_*` |
| `ai_prompts` | 4 | no | `improve-prompt` | versioned system prompts |
| `api_cost_log` | 3,340 | no | every Edge Fn that calls AI | spend tracking by `operation` and `model` |
| `chat_conversations` | 12 | no (yet) | `chat` | persistent chat history |
| `chat_messages` | 32 | no (yet) | `chat` | per-message tokens & cost |
| `ai_daily_briefs` | 1 | yes (read) | `daily-brief` | one row per `brief_date`, with `checksum` and `source_gate` |
| `briefing_sections` | 0 | no | designed for `daily-brief` to write per-section data | unused |
| `vip_contacts` | 0 | no | designed for VIP UI | unused |
| `user_preferences` | 0 | no | designed for settings | unused — **dashboard uses localStorage instead** |
| `microsoft_oauth_tokens` | **0** | no | `ms-auth` | **empty — see §4** |
| `calendar_events` | **0** | no | `ms-calendar` | empty — function never called by dashboard |
| `teams_messages` | 0 | no | designed for Teams sync | unused |
| `follow_ups` | 0 | no | `follow-ups` | unused |
| `email_drafts` | 0 | no | designed for draft-reply approval flow | unused |
| `core_clients` | 0 | no | manual | EOS / Chief-of-Staff module |
| `core_deliverables` | 0 | no | manual | EOS / Chief-of-Staff module |
| `core_decisions` | 0 | no | manual | EOS / Chief-of-Staff module |
| `strategy_rocks` | 7 | no | manual | Q1 rocks |
| `eos_annual_goals` | 6 | no | manual | FY26 goals |
| `personal_items` | 0 | no | manual | personal todos |

**The dashboard reads from 2 tables (`eisenhower_tasks`, `ai_daily_briefs`) out of 21.** Everything else is orphaned from the user's perspective.

---

## 4. Authentication — actual state

- `ms-auth` Edge Function holds the full OAuth flow including refresh token persistence
- The Next.js callback (`app/api/auth/callback/route.ts`) DOES call `ms-auth?action=callback` correctly
- BUT `microsoft_oauth_tokens` has **0 rows**
- And: the dashboard considers a user "connected" purely on the `ms_auth_connected=1` cookie, regardless of whether tokens are actually stored

**Hypothesis:** either (a) the user has been disconnecting / re-connecting recently, (b) the token-store insert is silently failing, or (c) `storeTokens` deletes existing rows then inserts and the insert errored. Easy to verify by walking through one fresh login while watching `microsoft_oauth_tokens`.

This matters for Epic 2 (scheduled brief): the cron will need a refresh token to call Graph without a user session. If the token table is empty, the brief can't pull email/calendar.

---

## 5. Security findings (Supabase advisor)

- **3 tables have RLS enabled with no policies** — locked down except for service role: `calendar_events`, `microsoft_oauth_tokens`, `teams_messages`. This is fine; only Edge Functions write to these.
- **14 tables have `USING (true) WITH CHECK (true)`** policies — effectively no row-level security. Anyone with the anon key can write. Acceptable for a single-user MVP, **not acceptable for production or multi-tenant** (Epic 7).
- **The pg_cron job stores the public anon key as plaintext in the database** (low risk since it's the public key, but bad hygiene).

---

## 6. The Next.js repo — what it actually does

| Surface | File | What it actually does |
|---|---|---|
| Login | `app/page.tsx` | Calls `ms-auth?action=login` for an OAuth URL, redirects |
| Callback | `app/api/auth/callback/route.ts` | Posts code to `ms-auth?action=callback`, sets cookie, redirects to /dashboard |
| Dashboard | `app/dashboard/page.tsx` (~2,300 lines) | All 7 tabs in one component. Reads emails + calendar **directly from Graph**, not from Supabase tables. Tasks via Supabase. Briefing via Edge Function. |
| Route guard | `middleware.ts` | Cookie check on /dashboard/* |
| Settings | inside `page.tsx` | localStorage only — `pref_briefing_time`, `pref_focus_start`, `pref_focus_end`, `pref_vip_contacts`. **VIP edits don't propagate** — rest of the app uses hardcoded `VIP_CLIENTS` constant. |

---

## 7. What's good about the as-built

- **Solid Edge Function ecosystem**: ms-auth correctly handles refresh token rotation, ms-outlook-folders has smart per-sender consolidation logic, daily-brief's Gate 5 prompt is well-structured
- **AI cost is tracked per call** in `api_cost_log` (3,340 rows). Easy to graph spend
- **EOS / Chief-of-Staff schema is in place** — just unused. When you're ready to add rocks/decisions/clients views, the tables exist
- **Schema is generally well-designed** with sensible enums, checks, FKs

## 8. What's broken or dangerous

| # | Issue | Severity |
|---|---|---|
| 1 | Runaway `sync-outlook-matrix` cron creating duplicate tasks | **🔴 critical — costing money + corrupting data** |
| 2 | `microsoft_oauth_tokens` empty — token persistence may be broken | 🟡 high |
| 3 | `calendar_events` empty — `ms-calendar` exists but no caller | 🟡 high (daily-brief's "Today's calendar" section is always empty) |
| 4 | Settings only in localStorage; VIP edits don't propagate | 🟡 medium |
| 5 | Dashboard ignores `email_processing_history` — already-classified emails not surfaced in UI | 🟡 medium |
| 6 | No `supabase/` folder in repo — Edge Function source + migrations not version-controlled | 🟡 medium |
| 7 | "Richard" hardcoded into prompts and frontend | 🟢 low (single-user) |
| 8 | Permissive RLS policies | 🟢 low (single-user) |

---

## 9. Recommended Roadmap (replaces v1 EPICS — see `EPICS.md`)

The v1 epics were planned as if the back-of-house didn't exist. They need re-ordering. Headline changes:

- **NEW Epic 0** — Stop the runaway cron + clean the duplicate tasks (urgent)
- **NEW Epic 1** — Bridge dashboard ↔ back-of-house: dashboard reads `email_processing_history` for classification, `calendar_events` for events, `follow_ups` for risk
- **NEW Epic 2** — Schedule the existing `daily-brief` function + add email delivery (the brief itself is built; only delivery and scheduling are missing)
- **NEW Epic 3** — Pull Edge Functions + migrations into a `supabase/` folder in this repo so the back-of-house is version-controlled
- **OLD Epic 4** — Settings persistence shrinks: `user_preferences` table exists; just wire it up + propagate VIP across the app
- Old Epic 1 (build classification pipeline) is **DELETED** — it exists, just not wired
- Old Epic 5 (decompose dashboard) and Epic 6 (tests / observability) carry forward unchanged
- Old Epic 7 (multi-tenant) deferred until Richard wants to onboard a second user

See `docs/EPICS.md` for full re-prioritised plan.
