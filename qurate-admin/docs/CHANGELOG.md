# Operational Changelog

Records non-code changes made directly to the live Supabase project (`btzlkiwmdegubbvzbmyo`). Code changes are tracked in git as usual.

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
