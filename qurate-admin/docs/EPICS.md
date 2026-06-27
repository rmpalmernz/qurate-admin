# Epics — Path to Production (v3, ambient-EA pivot)

> Replaces v2. The v2 roadmap completed the critical path: the daily brief is generated and emailed, the runaway cron is fixed and the data cleaned, settings persist, and the back-of-house is fully source-controlled. Those epics are preserved below as the **shipped record**.
>
> The 2026-06-27 product review (see `docs/BRD.md` v4) found that, even after those fixes, the dashboard had effectively **recreated Outlook** — a second inbox and a read-only calendar — while the genuine assistant value (brief, chat) was underdeveloped and the computed intelligence (follow-ups, sender patterns, 2,343 classified emails) sat unused. v3 pivots the product to an **ambient executive assistant**: the brief email, push nudges, chat, and a thin approval queue, with Mail/Calendar removed and the intelligence promoted to the engine.
>
> The active roadmap is now **Epics A → B → C → D → E**. They map 1:1 to `docs/BRD.md` §17.

Critical path to "trustworthy ambient EA in production": **Epic A → Epic B → Epic C → Epic D → Epic E.**

---

# Active roadmap (v4 ambient pivot)

## Epic A — Bulletproof + richer brief ✅ shipped

> **Status 2026-06-27:** HealthBanner + failure-alert, end-of-day variant + cron, and the REVENUE TRACKER section in morning-brief all live. Remaining nicety: richer brief→queue deep-links.

> The brief is now the primary surface. In an ambient model the user stops checking the inbox, so a missed brief is invisible — delivery reliability is non-negotiable.

**Why:** Today the 06:30 send can silently stop (paused cron, or an invalidated Microsoft Vault token → no Graph → no brief). The self-alert email exists (Epic 6) but token failure still degrades quietly.

**Scope**
1. **Make delivery unmissable.** Harden the `morning-brief-daily` cron + `ms-auth` token path so the brief always sends; on token failure raise a **loud, user-visible alert** (self-email + in-app banner), never a silent skip.
2. **End-of-day brief variant** — summarises what got handled and what rolls over.
3. **Deep-links from the brief** — each surfaced item links into the Action Queue (to approve a drafted reply) or out to Outlook/CRM for the full artifact.

**Acceptance criteria**
- Brief lands weekday mornings; a token/cron failure produces a visible alert within the hour.
- End-of-day variant sends and reflects the day's queue activity.
- Brief items are tappable into the queue / source.

**Dependencies:** valid Microsoft Vault token (re-auth if invalidated). **Estimate:** 1–2 sessions.

---

## Epic B — The Action Queue ✅ shipped

> **Status 2026-06-27:** Today tab is the Action Queue — follow-ups, Q1 emails, Q1 tasks, with approve/edit/dismiss/snooze and the explicit "Nothing needs you" empty state.

> Re-scope of the old Epic 1 "bridge dashboard ↔ back-of-house". Instead of wiring intelligence into tab widgets, the intelligence becomes a single prioritised queue of things needing approval.

**Why:** The moat is the computed intelligence. `email_processing_history` (2,343 rows, ~22 consumed) and `follow_ups` (computed, shown as a hardcoded "none") are the obvious starting fuel.

**Scope**
1. New **Today** tab = the Action Queue. Priority-ordered items, each with: one-line AI summary, classification tag, the drafted artifact inline (where relevant), and an "Open in Outlook/CRM" deep-link.
2. **Item types:** drafted reply to approve (`draft-reply` + `fetch-email` for the body) · follow-up to send/snooze (`follow_ups`) · task to confirm/re-file (`eisenhower_tasks`, replacing the manual board) · stalled-deal flag · meeting prep.
3. **Actions:** Approve (executes via the relevant Edge Function — send via Graph, archive via `delete-outlook-email`) · Edit (inline) · Dismiss · Snooze.
4. **Consume the intelligence fully** — close the `email_processing_history` gap; surface `follow_ups`; feed `sender-history` confidence into prioritisation.

**Acceptance criteria**
- Queue shows real items from the live intelligence (not heuristics), prioritised.
- Approving a drafted reply sends + archives; dismiss/snooze behave.
- `follow_ups` rows surface as queue items (no more hardcoded "none").

**Dependencies:** Epic A (brief deep-links into the queue). **Estimate:** 3–4 sessions.

---

## Epic C — Proactive nudges / push notifications ✅ shipped (code)

> **Status 2026-06-27:** Web Push channel (push_subscriptions, service-worker handlers, /api/push/subscribe, send-push Edge Function, Settings toggle) + nudge-engine (cold follow-ups, Q1 tasks, stalled deals, overdue revenue) with quiet hours, focus-block suppression, cooldowns (nudge_log), per-run cap, and a 30-min cron. Pending: live activation (VAPID secrets, migrations, deploy) + iOS device test. Approve-from-notification actions are a follow-up.

> **Reverses the old v2 stance** ("push notifications replaced by email"). An ambient EA needs to reach the user at the moment something becomes actionable.

**Scope**
1. **Web Push channel** for the installed PWA (single-user subscription). Validate iOS PWA push constraints; email/Teams fallback if unreliable.
2. **Nudge engine** — rules over the intelligence: new VIP/Q1 email with a drafted reply, follow-up threshold crossed, deal stalled, meeting imminent with prep ready.
3. **Approve-from-notification** where the platform supports notification actions; otherwise deep-link to the queue.
4. **Fatigue controls** — batching, severity thresholds, quiet hours bound to focus blocks (`user_preferences`). Suppressed items still appear in the queue + next brief (nothing dropped silently).

**Acceptance criteria**
- A qualifying event produces a nudge with an action; approving acts without a full app visit.
- Quiet hours + batching demonstrably suppress noise without losing items.

**Dependencies:** Epic B (the queue is the nudge's destination + action backend). **Estimate:** 2–3 sessions.

---

## Epic D — Remove Mail & Calendar; collapse Tasks/Clients ✅ shipped

> **Status 2026-06-27:** In-app IA reduced to **Today · Chat · Settings**. Mail, Calendar, Briefing, Tasks (matrix) and Clients tabs removed; page.tsx shrank ~3043 → ~1264 lines. Tasks/Clients now surface via the Today queue + the daily brief; Outlook remains the system of record (deep-link out).

> Done **after** B + C land, so the user never loses the ability to act on email during the transition.

**Scope**
1. **Remove the Mail tab** — Outlook is the inbox; the act-on-email path lives in the queue/nudges; deep-link to Outlook for full threads.
2. **Remove the Calendar tab** — the brief carries today's schedule + meeting-prep nudges; full calendar opens in Outlook.
3. **Collapse Tasks** — retire the drag-drop Eisenhower board; tasks surface as brief lines + "task-to-confirm" queue items.
4. **Collapse Clients** — replace the widget with a brief section ("who's gone quiet") + a chat query.
5. Reduce in-app IA to **Today · Chat · Settings**.

**Acceptance criteria**
- No Mail/Calendar tabs; no regression in the ability to reply/archive (now via the queue).
- The dashboard file shrinks materially (this *is* most of the old "decompose the monolith" work).

**Dependencies:** Epics B + C. **Estimate:** 1–2 sessions.

---

## Epic E — Trust & recall safety net 🟡 partial

> **Status 2026-06-27:** Auto-handled digest (weekly, with low-confidence flags + API spend vs budget) and the explicit "Nothing needs you" empty state are shipped. Remaining: recall-tuning (surface low-confidence classifications into the queue) and the in-app correction feedback loop (review_status + sender-history are the hooks).

> The counterweight that makes removing the Mail tab safe. Without a second inbox to double-check, a miss is invisible — see `docs/BRD.md` §13.

**Scope**
1. **High recall over precision** — when unsure, surface; low-confidence classifications go to the queue for review, never dropped.
2. **Explicit empty states** — "Nothing needs you" is a designed, affirmative state.
3. **Auto-handled digest** — periodic "here's what I auto-archived/deprioritised" so the user can audit and correct.
4. **Correctable intelligence** — marking a queue item's classification wrong feeds back (`email_processing_history` review fields / `sender-history`) so recall improves.

**Acceptance criteria**
- Auto-archive decisions are auditable, not invisible.
- Correcting a classification measurably changes future surfacing.

**Dependencies:** Epics B + D. **Estimate:** 2 sessions.

---

## Small carry-forwards (reconciled from Task Master, 2026-06-27)

> The Feb-2026 Task Master backlog (10 tasks, `.taskmaster/`) was reconciled against this v4 BRD + the code and **retired** — 4 done, 4 cancelled as superseded by the ambient pivot. Two items carried forward as small enhancements (not the original full-feature scope):

1. **Revenue status line in the brief** (was BR-09 "Revenue Tracker"). The standalone dashboard is obsolete (no Clients tab in v4); the live need is a one-line "$500k progress" status in the daily brief. Folds into **Epic A** brief enrichment.
2. **Surface API cost in the auto-handled digest** (was ST-07 "API Cost Dashboard"). `api_cost_log` is already populated by `chat` + `morning-brief`; no Settings dashboard needed — fold a spend line into the **Epic E** auto-handled digest.

Also noted (non-blocking): Action Queue snooze is in-memory only; persisting it across reload is a tiny optional follow-up to **Epic B**.

---

## Suggested order

```
PHASE 1 — make the brief unmissable, make the intelligence actionable
  Epic A  — Bulletproof + richer brief        (~1–2 sessions)
  Epic B  — The Action Queue                  (~3–4 sessions)

PHASE 2 — go ambient
  Epic C  — Proactive nudges / push           (~2–3 sessions)
  Epic D  — Remove Mail/Calendar; collapse    (~1–2 sessions)

PHASE 3 — earn the trust the model requires
  Epic E  — Trust & recall safety net         (~2 sessions)

LATER
  Multi-tenant (deferred — see shipped record below)
```

---

## Out of scope (revised for v4)

- Rebuilding Outlook's inbox or calendar in-app (the whole point of the pivot — deep-link instead)
- Inbox search UI (Outlook owns it)
- Calendar event creation / RSVP (Outlook owns it)
- Task recurrence
- Building a new email classifier (`email_processing_history` already classifies — Epic B consumes it)
- Multi-tenant (deferred)

*(Note: "push notifications" is no longer out of scope — it returns as Epic C.)*

---

# Shipped record (v2 roadmap — completed 2026-05-03 → 05-04)

Condensed; full detail in `docs/CHANGELOG.md`. Some of this is now superseded by the v4 pivot — flagged inline.

| Epic | Outcome | v4 status |
|---|---|---|
| **0 — Stop the runaway, clean data** ✅ | Paused/fixed the `sync-outlook-matrix` cron; dedup root cause + partial unique index `ux_eisenhower_tasks_source_email_id`; cleaned 227,407 → distinct rows; migrated classifier to Claude Haiku 4.5; cron re-enabled. | Foundational — carries. |
| **1 — Bridge dashboard ↔ back-of-house** ✅ (partial) | Mail tab enriched from `email_processing_history` (~22 rows consumed); `calendar_events` caching + `sync-calendar-30min`; tasks `quadrant_override`; briefing data-snapshot footer; Strategy Rocks display. | **Superseded by Epic B** — the bridge becomes the Action Queue. Mail/Calendar wiring removed in Epic D. |
| **2 — Daily brief generated + emailed** ✅ | `morning-brief` (Claude Sonnet 4.5) owns generate→persist→email; pg_cron `morning-brief-daily` 06:30 AEST weekdays; `ai_daily_briefs.sent_at`. | **Extended by Epic A** (reliability + end-of-day + deep-links). |
| **3 — Version-control the back-of-house** ✅ | All 16 Edge Functions source-controlled; Lovable fully removed (last Gemini callers migrated to Claude). | Carries. |
| **4 — Settings to Supabase + VIP propagation** ✅ | Settings/VIP lists persisted to `user_preferences`; `vipCompaniesMerged` (manual ∪ SharePoint-synced); localStorage migrated. | Carries (focus hours now also drive nudge quiet hours, Epic C). |
| **5 — Dashboard decomposition** | Planned split of the ~2,300-line `page.tsx`. | **Downgraded** — the v4 shrink (Epic D) absorbs most of it. |
| **6 — Quality & observability** ✅ (partial) | `morning-brief` failure-alert email; `/api/health` (503 on degraded); Sentry wired (browser/server/edge), gated on `NEXT_PUBLIC_SENTRY_DSN`. | Carries; Playwright + structured logs still pending. |
| **7 — Multi-tenant** | Add `user_id`, RLS via `auth.uid()`, dynamic prompts, onboarding. | Still **deferred**. |

**Standing pre-flight note:** if `ms-auth` reports "Not connected to Microsoft", the Vault `microsoft_refresh_token` has been invalidated — re-sign-in via the dashboard before crons can pull Graph data. Epic A makes this failure loud.
