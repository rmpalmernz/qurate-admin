'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'

export type Settings = {
  briefingTime: string
  focusStart: string
  focusEnd: string
  timezone: string
  vipCompanies: string[]      // manual list, user-editable
  vipCompaniesAuto: string[]  // synced from SharePoint by sync-vips Edge Function (read-only here)
  vipCompaniesAutoSyncedAt: string | null
}

export const DEFAULT_SETTINGS: Settings = {
  briefingTime: '08:00',
  focusStart: '09:00',
  focusEnd: '12:00',
  timezone: 'Australia/Sydney',
  vipCompanies: ['Think Water', 'Land of Plenty', 'Therefore', 'Providence', 'Armillary', 'Alstonville'],
  vipCompaniesAuto: [],
  vipCompaniesAutoSyncedAt: null,
}

const DB_KEY: Record<keyof Settings, string> = {
  briefingTime: 'briefing_time',
  focusStart: 'focus_start',
  focusEnd: 'focus_end',
  timezone: 'timezone',
  vipCompanies: 'vip_companies',
  vipCompaniesAuto: 'vip_companies_auto',
  vipCompaniesAutoSyncedAt: 'vip_companies_auto_synced_at',
}

const LEGACY_LS_KEY: Partial<Record<keyof Settings, string>> = {
  briefingTime: 'pref_briefing_time',
  focusStart: 'pref_focus_start',
  focusEnd: 'pref_focus_end',
  vipCompanies: 'pref_vip_contacts',
}

const SETTING_KEYS = Object.keys(DB_KEY) as Array<keyof Settings>

export function useUserSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function load() {
      const { data, error } = await supabase
        .from('user_preferences')
        .select('key, value')
        .in('key', Object.values(DB_KEY))

      if (error) {
        console.error('useUserSettings load:', error)
        if (!cancelled) setLoading(false)
        return
      }

      const dbKeys = new Set<string>((data ?? []).map(r => r.key))
      const next: Settings = { ...DEFAULT_SETTINGS }
      for (const row of data ?? []) {
        const k = SETTING_KEYS.find(s => DB_KEY[s] === row.key)
        if (k) (next as Record<string, unknown>)[k] = row.value
      }

      // One-time localStorage migration: if a legacy key exists and no DB row covers it,
      // push to DB and clear localStorage.
      const toMigrate: Array<{ key: string; value: unknown }> = []
      for (const k of SETTING_KEYS) {
        const lsKey = LEGACY_LS_KEY[k]
        if (!lsKey) continue
        if (dbKeys.has(DB_KEY[k])) {
          localStorage.removeItem(lsKey)
          continue
        }
        const raw = typeof window !== 'undefined' ? localStorage.getItem(lsKey) : null
        if (raw === null) continue
        try {
          const value = k === 'vipCompanies' ? JSON.parse(raw) : raw
          ;(next as Record<string, unknown>)[k] = value
          toMigrate.push({ key: DB_KEY[k], value })
        } catch {
          // malformed legacy entry — drop it
          localStorage.removeItem(lsKey)
        }
      }

      if (toMigrate.length > 0) {
        const { error: upsertErr } = await supabase
          .from('user_preferences')
          .upsert(toMigrate, { onConflict: 'key' })
        if (upsertErr) {
          console.error('useUserSettings migrate:', upsertErr)
        } else {
          for (const k of SETTING_KEYS) {
            const lsKey = LEGACY_LS_KEY[k]
            if (lsKey) localStorage.removeItem(lsKey)
          }
        }
      }

      if (!cancelled) {
        setSettings(next)
        setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [])

  const save = useCallback(async (patch: Partial<Settings>) => {
    // Refuse to save auto-managed keys via the user-facing save() — those are populated
    // server-side by the sync-vips Edge Function only.
    const filtered = Object.fromEntries(
      Object.entries(patch).filter(([k]) => k !== 'vipCompaniesAuto' && k !== 'vipCompaniesAutoSyncedAt')
    ) as Partial<Settings>
    if (Object.keys(filtered).length === 0) return

    setSettings(prev => ({ ...prev, ...filtered }))
    const rows = (Object.entries(filtered) as Array<[keyof Settings, unknown]>).map(([k, v]) => ({
      key: DB_KEY[k],
      value: v,
      updated_at: new Date().toISOString(),
    }))
    const { error } = await supabase.from('user_preferences').upsert(rows, { onConflict: 'key' })
    if (error) console.error('useUserSettings save:', error)
  }, [])

  // Effective VIP list = manual ∪ synced (deduped, case-insensitive). This is what every
  // VIP-aware consumer in the dashboard should read.
  const vipCompaniesMerged = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const name of [...settings.vipCompanies, ...settings.vipCompaniesAuto]) {
      const k = name.toLowerCase()
      if (seen.has(k)) continue
      seen.add(k)
      out.push(name)
    }
    return out
  }, [settings.vipCompanies, settings.vipCompaniesAuto])

  return { settings, save, loading, vipCompaniesMerged }
}
