'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { SUPABASE_FUNCTIONS_URL } from '@/lib/supabase'
import { useUserSettings, DEFAULT_SETTINGS } from './_hooks/useUserSettings'
import { enablePush, pushStatus, type PushState } from '@/lib/push'

const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!

const authFetch = (url: string, opts: RequestInit = {}) =>
  fetch(url, { ...opts, headers: { ...(opts.headers || {}), apikey: ANON_KEY, 'Content-Type': 'application/json' } })

// ─── Types ────────────────────────────────────────────────────────────────────
interface Email {
  id: string
  subject: string
  from: { name: string; address: string }
  receivedDateTime: string
  bodyPreview: string
  isRead: boolean
  ai_category?: string
  ai_priority_level?: string
  ai_client_name?: string
  ai_original_email_summary?: string
  ai_quadrant?: 'do' | 'schedule' | 'delegate' | 'eliminate'
}

interface CalendarEvent {
  id: string
  subject: string
  start: { dateTime?: string; date?: string }
  end: { dateTime?: string; date?: string }
  isAllDay?: boolean
  location?: { displayName: string }
  organizer?: { emailAddress: { name: string } }
  bodyPreview?: string
}

interface EisenhowerTask {
  id: string
  title: string
  description?: string
  quadrant: 'do' | 'schedule' | 'delegate' | 'eliminate'
  ai_suggested_quadrant?: 'do' | 'schedule' | 'delegate' | 'eliminate' | null
  quadrant_override?: boolean
  client_name?: string
  due_date?: string
  status: string
  estimated_minutes?: number
  notes?: string
  source_email_ids?: string[]
  delegated_to?: string
  delegation_channel?: string
  source_type?: string
  tags?: string[]
  priority_score?: number
  created_at?: string
  updated_at?: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
// MS Graph returns dateTime strings without a timezone suffix (e.g. "2026-02-24T09:00:00.0000000").
// Without 'Z', JS parses them as LOCAL time — wrong. Force UTC by appending 'Z' when no offset is present.
const msToDate = (d: string) => new Date(/Z$|[+\-]\d{2}:\d{2}$/.test(d) ? d : d + 'Z')
const fmt = (d: string) => msToDate(d).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })
const fmtDate = (d: string) => msToDate(d).toLocaleDateString('en-AU', { weekday: 'short', month: 'short', day: 'numeric' })
const timeAgo = (d: string) => {
  const diff = Date.now() - new Date(d).getTime()
  const h = Math.floor(diff / 3600000)
  if (h < 1) return `${Math.floor(diff / 60000)}m ago`
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

// Distinguishes the two failure modes that used to be collapsed into a bare null:
//   - 'disconnected': ms-auth answered but there's no usable token (no refresh token stored)
//   - 'auth_failed' : ms-auth errored (refresh exchange failed) or was unreachable
// Callers use this to tell "nothing to show" apart from "couldn't look".
type MsTokenResult = { token: string | null; error?: 'disconnected' | 'auth_failed' }
async function getMsToken(): Promise<MsTokenResult> {
  try {
    const res = await authFetch(`${SUPABASE_FUNCTIONS_URL}/ms-auth`)
    if (!res.ok) {
      // ms-auth returns 500 + {error} when the stored refresh token is invalid/expired.
      return { token: null, error: 'auth_failed' }
    }
    const data = await res.json()
    if (data.access_token) return { token: data.access_token }
    return { token: null, error: 'disconnected' }
  } catch {
    return { token: null, error: 'auth_failed' }
  }
}

// Lowercase + strip non-alphanumerics → matches against email domain substrings.
// "Think Water" → "thinkwater"
function vipDomainMatcher(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function emailToQuadrant(email: Email): 'do' | 'schedule' | 'delegate' | 'eliminate' {
  if (email.ai_quadrant) return email.ai_quadrant
  const pri = email.ai_priority_level?.toLowerCase() || ''
  const cat = email.ai_category?.toLowerCase() || ''
  if (pri === 'high') return 'do'
  if (cat.includes('marketing') || cat.includes('newsletter') || cat.includes('notification')) return 'eliminate'
  if (pri === 'medium') return 'schedule'
  if (pri === 'low') return 'delegate'
  return 'schedule'
}

function emailCategory(email: Email, vipCompanies: string[]): 'vip' | 'partner' | 'tools' | 'other' {
  const addr = (email.from?.address || '').toLowerCase()
  const cn   = email.ai_client_name || ''
  const vipNameHit   = vipCompanies.some(c => cn.toLowerCase().includes(c.toLowerCase()))
  const vipDomainHit = vipCompanies.some(c => addr.includes(vipDomainMatcher(c)))
  if (vipNameHit || vipDomainHit) return 'vip'
  if (addr.includes('noreply') || addr.includes('no-reply') || addr.includes('notifications') ||
      addr.includes('sharepoint') || addr.includes('teams') || addr.includes('n8n') || addr.includes('microsoft')) return 'tools'
  return 'other'
}

const quadrantConfig = {
  do:        { label: 'Do First',  color: '#C0392B', bg: 'rgba(192,57,43,0.08)',   border: 'rgba(192,57,43,0.2)' },
  schedule:  { label: 'Schedule',  color: '#C19131', bg: 'rgba(193,145,49,0.08)',  border: 'rgba(193,145,49,0.2)' },
  delegate:  { label: 'Delegate',  color: '#D9D2BE', bg: 'rgba(217,210,190,0.08)', border: 'rgba(217,210,190,0.2)' },
  eliminate: { label: 'Eliminate', color: '#D9D2BE', bg: 'rgba(107,114,128,0.08)', border: 'rgba(107,114,128,0.2)' },
}

// ─── Brand constants ─────────────────────────────────────────────────────────
const NAVY        = '#2E3D49'
const NAVY_LIGHT  = '#374857'
const NAVY_BORDER = 'rgba(217,210,190,0.15)'
const GOLD        = '#C19131'
const BEIGE       = '#D9D2BE'
const WHITE       = '#FFFFFF'
const RED         = '#C0392B'

// ─── Shared styles ────────────────────────────────────────────────────────────
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 14px', background: NAVY, border: `1px solid ${NAVY_BORDER}`,
  borderRadius: 8, color: WHITE, fontSize: 13, outline: 'none',
  fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif", fontWeight: 300, boxSizing: 'border-box',
}
const primaryBtnStyle: React.CSSProperties = {
  padding: '10px 20px', background: GOLD,
  color: NAVY, border: 'none', borderRadius: 8, fontSize: 13,
  fontWeight: 500, cursor: 'pointer', fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif",
}
const secondaryBtnStyle: React.CSSProperties = {
  padding: '10px 20px', background: 'transparent', color: BEIGE,
  border: `1px solid ${NAVY_BORDER}`, borderRadius: 8, fontSize: 13,
  cursor: 'pointer', fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif",
}

// ─── UI Primitives ────────────────────────────────────────────────────────────
function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      padding: '8px 14px', borderRadius: 8, border: 'none',
      background: active ? 'rgba(193,145,49,0.12)' : 'transparent',
      color: active ? GOLD : BEIGE, fontWeight: active ? 500 : 300,
      fontSize: 13, cursor: 'pointer', fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif",
      transition: 'all 0.15s', whiteSpace: 'nowrap',
    }}>{children}</button>
  )
}

function Card({ children, style = {} }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ background: NAVY_LIGHT, border: `1px solid ${NAVY_BORDER}`, borderRadius: 8, padding: 20, ...style }}>{children}</div>
}

function Badge({ text, color }: { text: string; color: string }) {
  return <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4, background: `${color}20`, color, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{text}</span>
}

function QuadrantBadge({ quadrant }: { quadrant: 'do' | 'schedule' | 'delegate' | 'eliminate' }) {
  const labels = { do: 'Q1', schedule: 'Q2', delegate: 'Q3', eliminate: 'Q4' }
  return <Badge text={labels[quadrant]} color={quadrantConfig[quadrant].color} />
}

function Spinner() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40, color: GOLD, gap: 10 }}>
      <span style={{ display: 'inline-block', width: 20, height: 20, border: `2px solid rgba(193,145,49,0.2)`, borderTopColor: GOLD, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      <span style={{ fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif", fontWeight: 300, color: BEIGE }}>Loading...</span>
    </div>
  )
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-sheet" onClick={e => e.stopPropagation()}>
        <div className="modal-handle" />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: WHITE, fontFamily: "'Gujarati Sangam MN', 'DM Sans', serif" }}>{title}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: BEIGE, cursor: 'pointer', fontSize: 22, lineHeight: 1, padding: 0, touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}>&#x2715;</button>
        </div>
        {children}
      </div>
    </div>
  )
}

// Honest failure banner — shown when a data source couldn't be loaded, so an
// empty screen is never mistaken for a genuinely quiet day. Depth via colour +
// border only (no drop shadow), per the design system.
function ErrorBanner({ messages, onRetry }: { messages: string[]; onRetry?: () => void }) {
  if (messages.length === 0) return null
  return (
    <div role="alert" style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', marginBottom: 12,
      background: 'rgba(192,57,43,0.1)', border: '1px solid rgba(192,57,43,0.3)', borderRadius: 8,
    }}>
      <span style={{ color: RED, fontSize: 16, lineHeight: 1, flexShrink: 0 }}>&#9888;</span>
      <span style={{ flex: 1, fontSize: 13, color: BEIGE, fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif" }}>{messages.join(' · ')}</span>
      {onRetry && (
        <button onClick={onRetry} style={{ ...secondaryBtnStyle, padding: '5px 12px', fontSize: 12, flexShrink: 0 }}>Retry</button>
      )}
    </div>
  )
}

// ─── Health banner ──────────────────────────────────────────────────────────
// Surfaces SERVER-SIDE silent failures (today's brief never generated/emailed,
// the database unreachable) by polling /api/health. Distinct from ErrorBanner,
// which only reports this browser session's live data-load failures.
//
// Epic A / BRD §13 "Trust requires recall": an ambient EA must fail LOUDLY. Once
// the user stops checking a Mail tab, a brief that silently didn't send is
// invisible — so the most likely root cause (an invalidated Microsoft token)
// gets a plain-language explanation and a one-tap Reconnect.
type HealthCheck = { ok: boolean; detail?: string }
type HealthResponse = { status: 'ok' | 'degraded'; checks?: Record<string, HealthCheck> }

function HealthBanner() {
  const [health, setHealth] = useState<HealthResponse | null>(null)

  useEffect(() => {
    let cancelled = false
    const check = async () => {
      try {
        const res = await fetch('/api/health', { cache: 'no-store' })
        const data = (await res.json()) as HealthResponse
        if (!cancelled) setHealth(data)
      } catch {
        // The health endpoint itself being unreachable is usually a flaky
        // network, not a real outage — stay quiet rather than crying wolf.
        // Genuine live-data failures are already covered by ErrorBanner.
      }
    }
    check()
    const id = setInterval(check, 5 * 60 * 1000) // re-check every 5 min
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  if (!health || health.status !== 'degraded') return null

  const checks = health.checks ?? {}
  const dbBroken = checks.supabase?.ok === false
  // A missing OR un-emailed brief almost always traces back to a dropped
  // Microsoft connection (the cron can't get a Graph token).
  const briefBroken = checks.todays_brief?.ok === false || checks.brief_sent?.ok === false

  const messages: string[] = []
  if (dbBroken) messages.push("Can't reach the database")
  if (checks.todays_brief?.ok === false) messages.push("Today's brief wasn't generated")
  else if (checks.brief_sent?.ok === false) messages.push("Today's brief wasn't emailed")

  return (
    <div role="alert" style={{
      display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 14px', marginBottom: 12,
      background: 'rgba(192,57,43,0.16)', border: '1px solid rgba(192,57,43,0.45)', borderRadius: 8,
    }}>
      <span style={{ color: RED, fontSize: 18, lineHeight: 1.2, flexShrink: 0 }}>&#9888;</span>
      <div style={{ flex: 1 }}>
        <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: WHITE, fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif" }}>
          {messages.join(' · ') || 'Something needs attention'}
        </p>
        {briefBroken && (
          <p style={{ margin: '3px 0 0', fontSize: 12, color: BEIGE, lineHeight: 1.5, fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif" }}>
            This usually means your Microsoft connection has dropped. Reconnect to restore your daily brief.
          </p>
        )}
      </div>
      {briefBroken && (
        <a href="/" style={{ ...primaryBtnStyle, background: RED, color: WHITE, padding: '7px 14px', fontSize: 12, textDecoration: 'none', flexShrink: 0, whiteSpace: 'nowrap' }}>Reconnect</a>
      )}
    </div>
  )
}

// ─── Section heading (Gujarati Sangam Bold) ─────────────────────────────────
function SectionHeading({ children, color = GOLD }: { children: React.ReactNode; color?: string }) {
  return (
    <h3 style={{
      margin: 0, fontSize: 13, fontWeight: 700, color,
      textTransform: 'uppercase', letterSpacing: '1px',
      fontFamily: "'Gujarati Sangam MN', 'DM Sans', serif",
    }}>{children}</h3>
  )
}

// ─── TODAY TAB — the Action Queue ─────────────────────────────────────────────
// Epic B (BRD v4 §5.3): the thin app's home. One prioritised list of things that
// need the user, each pre-classified with a recommended action. Replaces inbox
// triage with approve / edit / dismiss / snooze. Sources today: overdue
// follow-ups, Q1 ("Do") emails needing a reply, and Q1 tasks. Drafted replies
// come from the draft-reply Edge Function; sends go via Graph; nothing auto-sends.
interface FollowUp {
  id: string
  subject?: string
  recipient?: string
  recipient_name?: string
  days_overdue?: number
  sent_date?: string
}

type QueueKind = 'followup' | 'reply' | 'task' | 'review'
// Epic E recall/correction: a low-confidence classification the EA auto-filed but
// wants confirmed, so nothing is silently mis-filed. Confirm/Correct writes back to
// email_processing_history.review_status (the feedback hook sender-history reads).
interface ReviewItem {
  id: string
  email_id?: string
  subject?: string
  sender_name?: string
  sender_email?: string
  ai_category?: string
  ai_confidence_score?: number
}
interface QueueItem {
  key: string
  kind: QueueKind
  title: string
  subtitle: string
  tag: string
  tagColor: string
  detail?: string
  email?: Email
  task?: EisenhowerTask
  followUp?: FollowUp
  review?: ReviewItem
}

const todayISO = () => new Date().toLocaleDateString('en-CA')

function QueueCard({ item, msTokenAvailable, onDraft, onSend, onComplete, onDismiss, onSnooze }: {
  item: QueueItem
  msTokenAvailable: boolean
  onDraft: (item: QueueItem) => Promise<string>
  onSend: (item: QueueItem, text: string) => Promise<void>
  onComplete: (item: QueueItem) => Promise<void>
  onDismiss: (item: QueueItem) => void
  onSnooze: (key: string) => void
}) {
  const [phase, setPhase] = useState<'idle' | 'drafting' | 'editing' | 'sending' | 'working'>('idle')
  const [text, setText] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const canReply = item.kind === 'reply' || item.kind === 'followup'

  async function startDraft() {
    setErr(null); setPhase('drafting')
    try { const d = await onDraft(item); setText(d); setPhase('editing') }
    catch { setErr('Could not generate a draft.'); setPhase('idle') }
  }
  async function doSend() {
    if (!text.trim()) return
    setErr(null); setPhase('sending')
    try { await onSend(item, text) } // success removes the card from the list
    catch { setErr('Send failed — nothing was sent.'); setPhase('editing') }
  }
  async function doComplete() {
    setErr(null); setPhase('working')
    try { await onComplete(item) } // success removes the card
    catch { setErr('Action failed.'); setPhase('idle') }
  }

  const busy = phase === 'drafting' || phase === 'sending' || phase === 'working'
  const actBtn: React.CSSProperties = { ...secondaryBtnStyle, padding: '7px 14px', fontSize: 12 }

  return (
    <div style={{ background: NAVY_LIGHT, border: `1px solid ${NAVY_BORDER}`, borderLeft: `3px solid ${item.tagColor}`, borderRadius: 8, padding: 16, marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: item.tagColor, textTransform: 'uppercase', letterSpacing: '0.6px', background: 'rgba(255,255,255,0.04)', border: `1px solid ${item.tagColor}55`, borderRadius: 4, padding: '2px 6px' }}>{item.tag}</span>
            <span style={{ fontSize: 12, color: BEIGE, fontWeight: 300 }}>{item.subtitle}</span>
          </div>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: WHITE, lineHeight: 1.4 }}>{item.title}</p>
          {item.detail && <p style={{ margin: '4px 0 0', fontSize: 12, color: BEIGE, fontWeight: 300, lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{item.detail}</p>}
        </div>
      </div>

      {phase === 'editing' && (
        <div style={{ marginTop: 12 }}>
          <textarea value={text} onChange={e => setText(e.target.value)} rows={6}
            style={{ width: '100%', background: NAVY, color: WHITE, border: `1px solid ${NAVY_BORDER}`, borderRadius: 8, padding: 10, fontSize: 13, fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif", resize: 'vertical' }} />
        </div>
      )}
      {err && <p style={{ margin: '8px 0 0', fontSize: 12, color: RED }}>{err}</p>}

      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        {canReply && phase !== 'editing' && (
          <button onClick={startDraft} disabled={busy} style={{ ...primaryBtnStyle, padding: '7px 14px', fontSize: 12, opacity: busy ? 0.6 : 1 }}>
            {phase === 'drafting' ? 'Drafting…' : item.kind === 'followup' ? 'Draft chase' : 'Draft reply'}
          </button>
        )}
        {phase === 'editing' && (
          <>
            <button onClick={doSend} disabled={phase !== 'editing' || !msTokenAvailable} title={msTokenAvailable ? '' : 'Reconnect Microsoft to send'} style={{ ...primaryBtnStyle, padding: '7px 14px', fontSize: 12, opacity: msTokenAvailable ? 1 : 0.5 }}>Approve &amp; send</button>
            <button onClick={() => setPhase('idle')} style={actBtn}>Cancel</button>
          </>
        )}
        {item.kind === 'task' && (
          <button onClick={doComplete} disabled={busy} style={{ ...primaryBtnStyle, padding: '7px 14px', fontSize: 12, opacity: busy ? 0.6 : 1 }}>{phase === 'working' ? 'Completing…' : 'Complete'}</button>
        )}
        {item.kind === 'review' && phase !== 'editing' && (
          <>
            <button onClick={doComplete} disabled={busy} style={{ ...primaryBtnStyle, padding: '7px 14px', fontSize: 12, opacity: busy ? 0.6 : 1 }}>{phase === 'working' ? 'Saving…' : 'Looks right'}</button>
            <button onClick={() => onDismiss(item)} disabled={busy} style={actBtn}>Not for me</button>
          </>
        )}
        {phase !== 'editing' && item.kind !== 'review' && (
          <>
            {item.kind === 'followup' && <button onClick={doComplete} disabled={busy} style={actBtn}>Mark done</button>}
            {item.kind === 'reply' && <button onClick={() => onDismiss(item)} disabled={busy} style={actBtn}>Archive</button>}
            <button onClick={() => onSnooze(item.key)} disabled={busy} style={actBtn}>Snooze</button>
          </>
        )}
      </div>
    </div>
  )
}

function TodayTab({ emails, tasks, onCompleteTask }: {
  emails: Email[]
  tasks: EisenhowerTask[]
  onCompleteTask: (id: string) => Promise<void> | void
}) {
  const [followUps, setFollowUps] = useState<FollowUp[]>([])
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([])
  const [snoozed, setSnoozed] = useState<Set<string>>(new Set())
  const [removed, setRemoved] = useState<Set<string>>(new Set())
  const [msToken, setMsToken] = useState<string | null>(null)
  const VISIBLE_CAP = 25

  useEffect(() => { getMsToken().then(({ token }) => setMsToken(token)) }, [])

  useEffect(() => {
    fetch(`${SUPABASE_URL}/rest/v1/follow_ups?resolved_at=is.null&select=id,subject,recipient,recipient_name,days_overdue,sent_date&order=days_overdue.desc`, { headers: { apikey: ANON_KEY } })
      .then(r => r.ok ? r.json() : [])
      .then(d => { if (Array.isArray(d)) setFollowUps(d) })
      .catch(() => {})
  }, [])

  // Epic E recall: surface low-confidence auto-classifications so nothing is silently mis-filed.
  useEffect(() => {
    fetch(`${SUPABASE_URL}/rest/v1/email_processing_history?review_status=eq.pending&ai_confidence_score=lt.0.6&select=id,email_id,subject,sender_name,sender_email,ai_category,ai_confidence_score&order=processed_at.desc&limit=15`, { headers: { apikey: ANON_KEY } })
      .then(r => r.ok ? r.json() : [])
      .then(d => { if (Array.isArray(d)) setReviewItems(d) })
      .catch(() => {})
  }, [])

  // Confirm or correct a low-confidence classification — feeds review_status, which
  // sender-history reads to improve future surfacing.
  async function patchReview(id: string, status: 'confirmed' | 'corrected') {
    await fetch(`${SUPABASE_URL}/rest/v1/email_processing_history?id=eq.${id}`, {
      method: 'PATCH', headers: { apikey: ANON_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ review_status: status }),
    })
  }

  // Archive an email via the same Edge Function the Mail tab uses.
  async function archiveEmail(id: string) {
    try { await authFetch(`${SUPABASE_FUNCTIONS_URL}/delete-outlook-email`, { method: 'POST', body: JSON.stringify({ messageId: id }) }) }
    catch { /* best-effort; the item is already removed from the queue optimistically */ }
  }

  // Build the prioritised queue: follow-ups → Q1 emails → overdue tasks → due-soon tasks.
  const { items, q1TaskTotal } = useMemo(() => {
    const today = todayISO()
    const out: QueueItem[] = []

    followUps.forEach(f => out.push({
      key: `fu-${f.id}`, kind: 'followup', tag: 'Follow-up', tagColor: RED,
      title: `Chase: ${f.subject || '(no subject)'}`,
      subtitle: `${f.recipient_name || f.recipient || 'recipient'} · ${f.days_overdue ?? 0}d overdue`,
      detail: 'You sent this and have had no reply.', followUp: f,
    }))

    emails.filter(e => emailToQuadrant(e) === 'do').forEach(e => out.push({
      key: `em-${e.id}`, kind: 'reply', tag: 'Q1 email', tagColor: GOLD,
      title: e.subject || '(no subject)',
      subtitle: `${e.from?.name || e.from?.address || 'unknown'}${e.isRead ? '' : ' · unread'}`,
      detail: e.bodyPreview, email: e,
    }))

    const q1Tasks = tasks.filter(t => t.quadrant === 'do' && t.status !== 'done' && t.status !== 'cancelled')
    const overdue = q1Tasks.filter(t => t.due_date && t.due_date < today)
    const dueSoon = q1Tasks.filter(t => !(t.due_date && t.due_date < today))
    const byDue = (a: EisenhowerTask, b: EisenhowerTask) => (a.due_date || '9999').localeCompare(b.due_date || '9999')
    overdue.sort(byDue); dueSoon.sort(byDue)
    const taskItem = (t: EisenhowerTask, od: boolean): QueueItem => ({
      key: `tk-${t.id}`, kind: 'task', tag: od ? 'Overdue task' : 'Q1 task', tagColor: od ? RED : GOLD,
      title: t.title,
      subtitle: [t.client_name, t.due_date ? (od ? `was due ${t.due_date}` : `due ${t.due_date}`) : null, t.estimated_minutes ? `${t.estimated_minutes}m` : null].filter(Boolean).join(' · ') || 'no due date',
      detail: t.description, task: t,
    })
    overdue.forEach(t => out.push(taskItem(t, true)))
    dueSoon.forEach(t => out.push(taskItem(t, false)))

    // Low-confidence classifications to confirm — lowest priority, after the real work.
    reviewItems.forEach(r => out.push({
      key: `rv-${r.id}`, kind: 'review', tag: 'Review', tagColor: '#3AAFA9',
      title: r.subject || '(no subject)',
      subtitle: `${r.sender_name || r.sender_email || 'unknown'} · I filed this as ${r.ai_category || 'unsorted'} — right?`,
      review: r,
    }))

    const filtered = out.filter(i => !snoozed.has(i.key) && !removed.has(i.key))
    return { items: filtered, q1TaskTotal: q1Tasks.length }
  }, [followUps, emails, tasks, reviewItems, snoozed, removed])

  const visible = items.slice(0, VISIBLE_CAP)
  const hiddenCount = items.length - visible.length

  function snooze(key: string) { setSnoozed(prev => new Set(prev).add(key)) }
  function remove(key: string) { setRemoved(prev => new Set(prev).add(key)) }

  async function onDraft(item: QueueItem): Promise<string> {
    const payload = item.kind === 'reply'
      ? { email_id: item.email!.id, subject: item.email!.subject, from_name: item.email!.from?.name, from_email: item.email!.from?.address, body_preview: item.email!.bodyPreview }
      : { subject: item.followUp!.subject, from_name: item.followUp!.recipient_name, from_email: item.followUp!.recipient, body_preview: `Awaiting reply — ${item.followUp!.days_overdue ?? 0} days overdue. Write a short, warm chase.` }
    const res = await authFetch(`${SUPABASE_FUNCTIONS_URL}/draft-reply`, { method: 'POST', body: JSON.stringify(payload) })
    const data = await res.json()
    return data.draft || data.body_text || ''
  }

  async function onSend(item: QueueItem, body: string): Promise<void> {
    if (!msToken) throw new Error('no token')
    const to = item.kind === 'reply' ? item.email!.from?.address : item.followUp!.recipient
    const subject = `Re: ${(item.kind === 'reply' ? item.email!.subject : item.followUp!.subject) || ''}`
    const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
      method: 'POST',
      headers: { Authorization: `Bearer ${msToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { subject, body: { contentType: 'Text', content: body }, toRecipients: [{ emailAddress: { address: to } }] } }),
    })
    if (!res.ok) throw new Error(`sendMail ${res.status}`)
    if (item.kind === 'reply') archiveEmail(item.email!.id)
    else await resolveFollowUp(item.followUp!.id)
    remove(item.key)
  }

  async function resolveFollowUp(id: string) {
    await fetch(`${SUPABASE_URL}/rest/v1/follow_ups?id=eq.${id}`, {
      method: 'PATCH', headers: { apikey: ANON_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ resolved_at: new Date().toISOString() }),
    })
  }

  async function onComplete(item: QueueItem): Promise<void> {
    if (item.kind === 'task') await onCompleteTask(item.task!.id)
    else if (item.kind === 'followup') await resolveFollowUp(item.followUp!.id)
    else if (item.kind === 'review') await patchReview(item.review!.id, 'confirmed')
    remove(item.key)
  }

  function onDismiss(item: QueueItem) {
    if (item.kind === 'reply') archiveEmail(item.email!.id)
    else if (item.kind === 'review') patchReview(item.review!.id, 'corrected')
    remove(item.key)
  }

  return (
    <div style={{ animation: 'fadeIn 0.35s' }}>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 22, fontWeight: 700, color: WHITE, fontFamily: "'Gujarati Sangam MN', 'DM Sans', serif" }}>Today</h2>
        <p style={{ margin: 0, fontSize: 13, color: BEIGE, fontWeight: 300 }}>
          {items.length === 0 ? 'Nothing needs you right now — clear queue.' : `${items.length} ${items.length === 1 ? 'thing needs' : 'things need'} you.`}
        </p>
      </div>

      {items.length === 0 ? (
        <div style={{ background: NAVY_LIGHT, border: `1px solid ${NAVY_BORDER}`, borderRadius: 8, padding: '32px 16px', textAlign: 'center' }}>
          <p style={{ margin: 0, fontSize: 14, color: BEIGE }}>Nothing needs you right now.</p>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: 'rgba(217,210,190,0.5)' }}>Follow-ups, urgent emails, and due tasks will appear here.</p>
        </div>
      ) : (
        <>
          {visible.map(item => (
            <QueueCard key={item.key} item={item} msTokenAvailable={!!msToken}
              onDraft={onDraft} onSend={onSend} onComplete={onComplete} onDismiss={onDismiss} onSnooze={snooze} />
          ))}
          {hiddenCount > 0 && (
            <p style={{ margin: '8px 4px 0', fontSize: 12, color: 'rgba(217,210,190,0.6)' }}>
              + {hiddenCount} more not shown. Your Q1 “Do” quadrant holds {q1TaskTotal} tasks — it’s overloaded and needs triage in Tasks.
            </p>
          )}
        </>
      )}
    </div>
  )
}

// ─── BRIEFING TAB ─────────────────────────────────────────────────────────────
type BriefSnapshot = {
  q1Tasks?: number; q2Tasks?: number; q3Tasks?: number; overdueTasks?: number;
  followUps?: number; clients?: number; prospects?: number; openDeals?: number; calendarEvents?: number;
}
type StrategyRock = {
  id: string; rock_name: string; owner: string | null;
  status: 'on_track' | 'at_risk' | 'off_track' | string;
  percent_complete: number | null; quarter: string | null;
}

// ─── Markdown renderer ────────────────────────────────────────────────────────
function renderMarkdown(text: string): string {
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const inline = (s: string) =>
    escape(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code style="background:rgba(217,210,190,0.15);padding:1px 5px;border-radius:3px;font-size:12px">$1</code>')

  const lines = text.split('\n')
  const out: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Table block
    if (line.trim().startsWith('|')) {
      const tLines: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('|')) { tLines.push(lines[i]); i++ }
      out.push('<table style="border-collapse:collapse;width:100%;margin:8px 0;font-size:13px">')
      tLines.forEach((tl, ti) => {
        if (ti === 1) return // separator row
        const cells = tl.split('|').slice(1, -1)
        const tag = ti === 0 ? 'th' : 'td'
        const bg = ti === 0 ? '#3f5262' : ti % 2 === 0 ? 'rgba(217,210,190,0.1)' : 'transparent'
        out.push(`<tr style="background:${bg}">`)
        cells.forEach(c => out.push(`<${tag} style="padding:5px 10px;border:1px solid rgba(217,210,190,0.15);text-align:left">${inline(c.trim())}</${tag}>`))
        out.push('</tr>')
      })
      out.push('</table>')
      continue
    }

    // Headings
    if (line.startsWith('### ')) { out.push(`<h3 style="margin:10px 0 4px;font-size:13px;font-weight:600;color:#C19131">${inline(line.slice(4))}</h3>`); i++; continue }
    if (line.startsWith('## '))  { out.push(`<h2 style="margin:12px 0 5px;font-size:14px;font-weight:600;color:#C19131">${inline(line.slice(3))}</h2>`); i++; continue }
    if (line.startsWith('# '))   { out.push(`<h1 style="margin:14px 0 6px;font-size:15px;font-weight:700;color:#C19131">${inline(line.slice(2))}</h1>`); i++; continue }

    // Bullet list
    if (/^[-*] /.test(line)) {
      out.push('<ul style="margin:4px 0;padding-left:18px">')
      while (i < lines.length && /^[-*] /.test(lines[i])) { out.push(`<li style="margin:2px 0">${inline(lines[i].slice(2))}</li>`); i++ }
      out.push('</ul>')
      continue
    }

    // Numbered list
    if (/^\d+\. /.test(line)) {
      out.push('<ol style="margin:4px 0;padding-left:18px">')
      while (i < lines.length && /^\d+\. /.test(lines[i])) { out.push(`<li style="margin:2px 0">${inline(lines[i].replace(/^\d+\. /, ''))}</li>`); i++ }
      out.push('</ol>')
      continue
    }

    // Blank line
    if (line.trim() === '') { i++; continue }

    // Paragraph
    out.push(`<p style="margin:3px 0">${inline(line)}</p>`)
    i++
  }

  return out.join('')
}

// ─── CHAT TAB ─────────────────────────────────────────────────────────────────
function ChatTab() {
  const [messages, setMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([
    { role: 'assistant', content: "Hi Richard, I'm your Admin Agent. I can help you manage emails, tasks, and calendar. What would you like to do today?" }
  ])
  const [input, setInput]   = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  const quickActions = [
    { label: 'Morning briefing',  msg: 'Generate my morning briefing for today' },
    { label: 'Triage inbox',      msg: 'What are my most urgent emails to respond to today?' },
    { label: "Today's schedule",  msg: 'What does my schedule look like today?' },
    { label: 'Q1 tasks',          msg: 'What are my most urgent Q1 tasks right now?' },
    { label: 'Weekly review',     msg: 'Help me do a weekly review of my Eisenhower matrix' },
    { label: 'Focus block',       msg: 'What Q2 work should I schedule a focus block for this week?' },
  ]

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, loading])

  async function send(message?: string) {
    const userMsg = (message || input).trim()
    if (!userMsg || loading) return
    setInput('')
    setMessages(m => [...m, { role: 'user', content: userMsg }])
    setLoading(true)
    try {
      // Build full conversation array (Claude API format) — edge function expects `messages`
      const conversationMessages = [
        ...messages.filter(m => m.role === 'user' || m.role === 'assistant'),
        { role: 'user' as const, content: userMsg },
      ]
      const res = await authFetch(`${SUPABASE_FUNCTIONS_URL}/chat`, {
        method: 'POST',
        body: JSON.stringify({ message: userMsg, messages: conversationMessages }),
      })
      const data = await res.json()
      setMessages(m => [...m, { role: 'assistant', content: data.response || data.message || JSON.stringify(data) }])
    } catch {
      setMessages(m => [...m, { role: 'assistant', content: 'Sorry, I encountered an error. Please try again.' }])
    }
    setLoading(false)
  }

  return (
    <div className="chat-container">
      {messages.length <= 1 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          {quickActions.map(qa => (
            <button key={qa.label} onClick={() => send(qa.msg)} style={{ padding: '7px 14px', background: '#374857', color: '#D9D2BE', border: '1px solid rgba(217,210,190,0.15)', borderRadius: 20, fontSize: 12, cursor: 'pointer', fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif" }}>
              {qa.label}
            </button>
          ))}
        </div>
      )}
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 16 }}>
        {messages.map((m, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
            {m.role === 'user' ? (
              <div style={{ maxWidth: '75%', padding: '10px 14px', borderRadius: '12px 12px 4px 12px', background: '#C19131', color: '#FFFFFF', fontSize: 14, lineHeight: 1.6 }}>
                {m.content}
              </div>
            ) : (
              <div
                dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }}
                style={{ maxWidth: '85%', padding: '10px 14px', borderRadius: '12px 12px 12px 4px', background: '#374857', border: '1px solid rgba(217,210,190,0.15)', color: '#FFFFFF', fontSize: 14, lineHeight: 1.6 }}
              />
            )}
          </div>
        ))}
        {loading && (
          <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
            <div style={{ padding: '10px 14px', background: '#374857', border: '1px solid rgba(217,210,190,0.15)', borderRadius: '12px 12px 12px 4px', color: '#D9D2BE', fontSize: 14 }}>Thinking...</div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && !e.shiftKey && send()} placeholder="Ask me anything about your day..." style={{ flex: 1, padding: '12px 16px', background: '#374857', border: '1px solid rgba(217,210,190,0.15)', borderRadius: 10, color: '#FFFFFF', fontSize: 14, outline: 'none', fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif" }} />
        <button onClick={() => send()} disabled={loading || !input.trim()} style={{ padding: '12px 20px', background: loading || !input.trim() ? '#3f5262' : '#C19131', color: loading || !input.trim() ? 'rgba(217,210,190,0.4)' : '#fff', border: 'none', borderRadius: 10, cursor: loading || !input.trim() ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 500, fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif" }}>Send</button>
      </div>
    </div>
  )
}

// ─── SETTINGS TAB ─────────────────────────────────────────────────────────────
function SettingsTab({ connected, onDisconnect, settings, save, loading }: {
  connected: boolean
  onDisconnect: () => void
  settings: ReturnType<typeof useUserSettings>['settings']
  save: ReturnType<typeof useUserSettings>['save']
  loading: boolean
}) {
  const [briefingTime, setBriefingTime] = useState(DEFAULT_SETTINGS.briefingTime)
  const [focusStart, setFocusStart]     = useState(DEFAULT_SETTINGS.focusStart)
  const [focusEnd, setFocusEnd]         = useState(DEFAULT_SETTINGS.focusEnd)
  const [vipContacts, setVipContacts]   = useState<string[]>([...DEFAULT_SETTINGS.vipCompanies])
  const [newContact, setNewContact]     = useState('')
  const [saved, setSaved]               = useState(false)
  const [saving, setSaving]             = useState(false)
  const [syncing, setSyncing]           = useState(false)
  const [syncMessage, setSyncMessage]   = useState<string | null>(null)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [pushState, setPushState] = useState<PushState>('unknown')
  const [pushBusy, setPushBusy] = useState(false)
  const [pushMsg, setPushMsg]   = useState<string | null>(null)

  useEffect(() => { pushStatus().then(setPushState) }, [])

  async function enableNotifications() {
    setPushBusy(true)
    setPushMsg(null)
    const r = await enablePush()
    if (r.ok) {
      setPushState('subscribed')
      setPushMsg('Notifications enabled on this device.')
    } else {
      setPushMsg(r.error || 'Could not enable notifications.')
    }
    setPushBusy(false)
  }

  async function triggerVipSync() {
    setSyncing(true)
    setSyncMessage(null)
    try {
      const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/sync-vips`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY, 'Content-Type': 'application/json' },
      })
      const data = await res.json()
      if (!res.ok || data?.success === false) {
        setSyncMessage(`Sync failed: ${data?.error || res.statusText}`)
      } else {
        setSyncMessage(`Synced ${data.count ?? 0} clients from SharePoint. Reload to see them.`)
      }
    } catch (e) {
      setSyncMessage(`Sync failed: ${e instanceof Error ? e.message : 'Unknown error'}`)
    }
    setSyncing(false)
  }

  // Hydrate local form state once settings have loaded from Supabase.
  useEffect(() => {
    if (loading) return
    setBriefingTime(settings.briefingTime)
    setFocusStart(settings.focusStart)
    setFocusEnd(settings.focusEnd)
    setVipContacts(settings.vipCompanies)
  }, [loading, settings])

  async function savePrefs() {
    setSaving(true)
    await save({
      briefingTime,
      focusStart,
      focusEnd,
      vipCompanies: vipContacts,
    })
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  function addContact() {
    const c = newContact.trim()
    if (c && !vipContacts.includes(c)) { setVipContacts(p => [...p, c]); setNewContact('') }
  }

  function disconnect() {
    onDisconnect()
  }

  const archiveRules = [
    { label: 'No-reply senders',       pattern: 'noreply@*,  no-reply@*' },
    { label: 'Notification services',  pattern: 'notifications@*' },
    { label: 'SharePoint / Teams',     pattern: '*@sharepoint.com, *@teams.microsoft.com' },
    { label: 'n8n automation',         pattern: '*@n8n.io' },
    { label: 'Microsoft system mail',  pattern: '*@microsoft.com' },
  ]

  const labelStyle: React.CSSProperties = { fontSize: 12, color: '#D9D2BE', display: 'block', marginBottom: 6 }

  return (
    <div style={{ maxWidth: 600, display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Briefing Preferences */}
      <Card>
        <h3 style={{ margin: '0 0 16px', fontSize: 13, fontWeight: 600, color: '#C19131', textTransform: 'uppercase', letterSpacing: '0.8px' }}>Briefing Preferences</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={labelStyle}>Daily Briefing Time</label>
            <input type="time" value={briefingTime} onChange={e => setBriefingTime(e.target.value)} style={{ ...inputStyle, maxWidth: 160 }} />
          </div>
          <div>
            <label style={labelStyle}>Focus Block Window</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input type="time" value={focusStart} onChange={e => setFocusStart(e.target.value)} style={{ ...inputStyle, maxWidth: 140 }} />
              <span style={{ color: '#D9D2BE', fontSize: 13 }}>to</span>
              <input type="time" value={focusEnd}   onChange={e => setFocusEnd(e.target.value)}   style={{ ...inputStyle, maxWidth: 140 }} />
            </div>
          </div>
        </div>
      </Card>

      {/* Notifications */}
      <Card>
        <h3 style={{ margin: '0 0 16px', fontSize: 13, fontWeight: 600, color: '#C19131', textTransform: 'uppercase', letterSpacing: '0.8px' }}>Notifications</h3>
        <p style={{ margin: '0 0 14px', fontSize: 13, color: BEIGE, fontWeight: 300, lineHeight: 1.5 }}>
          Push nudges for urgent items — follow-ups gone cold, VIP emails, stalled deals.
          {' '}On iPhone, install this app to your home screen first (Share → Add to Home Screen).
        </p>
        {pushState === 'unsupported' && (
          <p style={{ margin: 0, fontSize: 12, color: RED }}>Not supported on this browser. Open the installed app on your iPhone home screen.</p>
        )}
        {pushState === 'denied' && (
          <p style={{ margin: 0, fontSize: 12, color: RED }}>Notifications are blocked. Enable them for this app in your device settings, then reload.</p>
        )}
        {pushState === 'subscribed' && (
          <p style={{ margin: 0, fontSize: 13, color: '#3AAFA9' }}>✓ Notifications enabled on this device.</p>
        )}
        {(pushState === 'unsubscribed' || pushState === 'unknown') && (
          <button onClick={enableNotifications} disabled={pushBusy || pushState === 'unknown'} style={{ ...primaryBtnStyle, opacity: pushBusy ? 0.6 : 1 }}>
            {pushBusy ? 'Enabling…' : 'Enable notifications'}
          </button>
        )}
        {pushMsg && <p style={{ margin: '12px 0 0', fontSize: 12, color: BEIGE }}>{pushMsg}</p>}
      </Card>

      {/* VIP Clients — Manual */}
      <Card>
        <h3 style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 600, color: '#C19131', textTransform: 'uppercase', letterSpacing: '0.8px' }}>VIP Clients (Manual)</h3>
        <p style={{ margin: '0 0 12px', fontSize: 12, color: '#D9D2BE' }}>Treated as VIP in Email and Clients tabs. Combined with SharePoint-synced clients below.</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
          {vipContacts.map(name => (
            <div key={name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 10px', background: '#2E3D49', border: '1px solid rgba(217,210,190,0.15)', borderRadius: 7 }}>
              <span style={{ fontSize: 13, color: '#FFFFFF' }}>{name}</span>
              <button onClick={() => setVipContacts(p => p.filter(c => c !== name))} style={{ background: 'none', border: 'none', color: '#D9D2BE', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 2px' }}>&#x2715;</button>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={newContact} onChange={e => setNewContact(e.target.value)} onKeyDown={e => e.key === 'Enter' && addContact()} placeholder="Add client name..." style={{ ...inputStyle, flex: 1 }} />
          <button onClick={addContact} disabled={!newContact.trim()} style={{ ...primaryBtnStyle, opacity: newContact.trim() ? 1 : 0.5 }}>Add</button>
        </div>
      </Card>

      {/* VIP Clients — SharePoint synced */}
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 6 }}>
          <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#C19131', textTransform: 'uppercase', letterSpacing: '0.8px' }}>SharePoint Clients (Auto)</h3>
          <button
            onClick={triggerVipSync}
            disabled={syncing}
            style={{ ...primaryBtnStyle, padding: '6px 12px', fontSize: 12, opacity: syncing ? 0.6 : 1 }}
          >
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
        <p style={{ margin: '0 0 12px', fontSize: 12, color: '#D9D2BE' }}>
          Read-only. Pulled from <code style={{ fontSize: 11, color: '#D9D2BE' }}>quratepty.sharepoint.com/sites/QurateClient</code> + your <code style={{ fontSize: 11, color: '#D9D2BE' }}>1. Own - Engagements</code> OneDrive.
          {settings.vipCompaniesAutoSyncedAt
            ? <> Last synced {timeAgo(settings.vipCompaniesAutoSyncedAt)}.</>
            : <> Never synced.</>}
        </p>
        {syncMessage && (
          <p style={{ margin: '0 0 10px', fontSize: 12, color: syncMessage.startsWith('Sync failed') ? '#C0392B' : '#D9D2BE' }}>{syncMessage}</p>
        )}
        {settings.vipCompaniesAuto.length === 0 ? (
          <p style={{ margin: 0, fontSize: 12, color: 'rgba(217,210,190,0.5)' }}>No SharePoint clients yet. Hit Sync now to fetch them.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {settings.vipCompaniesAuto.map(name => (
              <div key={name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 10px', background: '#2E3D49', border: '1px solid rgba(217,210,190,0.15)', borderRadius: 7 }}>
                <span style={{ fontSize: 13, color: '#FFFFFF' }}>{name}</span>
                <span style={{ fontSize: 10, color: 'rgba(217,210,190,0.5)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>SharePoint</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Auto-archive Rules */}
      <Card>
        <h3 style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 600, color: '#C19131', textTransform: 'uppercase', letterSpacing: '0.8px' }}>Auto-archive Rules</h3>
        <p style={{ margin: '0 0 12px', fontSize: 12, color: '#D9D2BE' }}>Emails matching these patterns are routed to the Tools filter automatically.</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {archiveRules.map(r => (
            <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px', background: '#2E3D49', border: '1px solid rgba(217,210,190,0.15)', borderRadius: 7 }}>
              <span style={{ fontSize: 13, color: '#FFFFFF' }}>{r.label}</span>
              <span style={{ fontSize: 11, color: 'rgba(217,210,190,0.4)', fontFamily: 'monospace' }}>{r.pattern}</span>
            </div>
          ))}
        </div>
      </Card>

      {/* Save */}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          onClick={savePrefs}
          disabled={saving || loading}
          style={{ ...primaryBtnStyle, minWidth: 140, opacity: (saving || loading) ? 0.6 : 1 }}
        >
          {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save Preferences'}
        </button>
      </div>

      {/* Microsoft Connection */}
      <Card>
        <h3 style={{ margin: '0 0 14px', fontSize: 13, fontWeight: 600, color: '#C19131', textTransform: 'uppercase', letterSpacing: '0.8px' }}>Microsoft Connection</h3>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <p style={{ margin: '0 0 4px', fontSize: 14, color: '#FFFFFF' }}>{connected ? 'Connected to Microsoft 365' : 'Not connected'}</p>
            <p style={{ margin: 0, fontSize: 12, color: '#D9D2BE' }}>{connected ? 'Your email and calendar are syncing.' : 'Connect to access email and calendar data.'}</p>
          </div>
          {connected && <button onClick={() => setConfirmDisconnect(true)} style={{ padding: '8px 14px', background: 'rgba(192,57,43,0.1)', color: '#C0392B', border: '1px solid rgba(192,57,43,0.2)', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif" }}>Disconnect</button>}
        </div>
      </Card>

      {confirmDisconnect && (
        <Modal title="Disconnect Microsoft?" onClose={() => setConfirmDisconnect(false)}>
          <p style={{ margin: '0 0 20px', fontSize: 14, color: BEIGE, lineHeight: 1.6 }}>
            This revokes access to your email and calendar and signs you out. You&apos;ll need to sign in with Microsoft again to reconnect.
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button onClick={() => setConfirmDisconnect(false)} style={secondaryBtnStyle}>Cancel</button>
            <button onClick={() => { setConfirmDisconnect(false); disconnect() }} style={{ ...primaryBtnStyle, background: RED, color: WHITE }}>Disconnect</button>
          </div>
        </Modal>
      )}

      {/* About */}
      <Card>
        <h3 style={{ margin: '0 0 14px', fontSize: 13, fontWeight: 600, color: '#C19131', textTransform: 'uppercase', letterSpacing: '0.8px' }}>About</h3>
        <p style={{ margin: 0, fontSize: 13, color: '#D9D2BE', lineHeight: 1.6 }}>
          Qurate Admin Agent v1.0<br />
          Stack: Next.js, Supabase, Microsoft Graph, Claude API (Haiku + Sonnet)
        </p>
      </Card>
    </div>
  )
}

// ─── MAIN DASHBOARD ───────────────────────────────────────────────────────────
const TAB_TITLES: Record<string, string> = {
  today: 'Today', chat: 'AI Chat', settings: 'Settings',
}

// v4 ambient pivot (Epic D): in-app IA reduced to Today (Action Queue) · Chat · Settings.
// Mail/Calendar removed (Outlook is the system of record); Tasks/Clients collapsed into
// the Today queue and the daily brief.
type Tab = 'today'|'chat'|'settings'

// Simple SVG icons for bottom nav
function NavIcon({ name }: { name: Tab }) {
  const s = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 }
  if (name === 'today')    return <svg {...s} strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>
  if (name === 'chat')     return <svg {...s} strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
  /* settings */           return <svg {...s} strokeLinecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v2m0 16v2M4.22 4.22l1.42 1.42m12.72 12.72l1.42 1.42M2 12h2m16 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
}
export default function Dashboard() {
  const [tab, setTab]           = useState<Tab>('today')
  const [emails, setEmails]     = useState<Email[]>([])
  const [events, setEvents]     = useState<CalendarEvent[]>([])
  const [tasks, setTasks]       = useState<EisenhowerTask[]>([])
  const [emailLoading, setEmailLoading] = useState(false)
  const [connected, setConnected] = useState(false)
  // Per-source load errors. Presence of a value means that source failed to load —
  // the UI uses this to show an honest "couldn't load" instead of an empty "all clear".
  const [loadErrors, setLoadErrors] = useState<{ email?: string; calendar?: string; tasks?: string; auth?: boolean }>({})
  const [confirmSignOut, setConfirmSignOut] = useState(false)
  const userSettings = useUserSettings()
  const { settings, vipCompaniesMerged } = userSettings

  // Verify MS token on mount; redirect to login if missing
  useEffect(() => {
    getMsToken().then(({ token }) => {
      if (token) setConnected(true)
      else window.location.href = '/'
    })
  }, [])

  const loadEmails = useCallback(async () => {
    setEmailLoading(true)
    setLoadErrors(e => ({ ...e, email: undefined }))
    try {
      const { token } = await getMsToken()
      if (!token) { setLoadErrors(e => ({ ...e, auth: true, email: 'auth' })); setEmailLoading(false); return }
      setLoadErrors(e => ({ ...e, auth: false }))
      const r = await fetch('https://graph.microsoft.com/v1.0/me/messages?$top=50&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,bodyPreview,isRead', { headers: { Authorization: `Bearer ${token}` } })
      if (!r.ok) throw new Error(`Graph ${r.status}`)
      const data = await r.json()
      const emails: Email[] = (data.value || []).filter((e: Email) => e.from && e.id && e.receivedDateTime)

      // Enrich with email_processing_history (back-of-house AI classification).
      // The DB uses ai_category values 'do | plan | delegate | eliminate'; the dashboard's
      // ai_quadrant uses 'do | schedule | delegate | eliminate'. Map plan → schedule.
      // If this enrich fails, we silently fall through to heuristic categorisation — no regression.
      if (emails.length > 0) {
        try {
          const ids = emails.map(e => `"${e.id}"`).join(',')
          const enrichRes = await fetch(
            `${SUPABASE_URL}/rest/v1/email_processing_history?select=email_id,ai_category,ai_client_name&email_id=in.(${ids})`,
            { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` } }
          )
          if (enrichRes.ok) {
            const enrichData: Array<{ email_id: string; ai_category?: string; ai_client_name?: string }> = await enrichRes.json()
            const mapQuadrant = (c?: string): Email['ai_quadrant'] | undefined => {
              if (!c) return undefined
              const v = c.toLowerCase()
              if (v === 'plan') return 'schedule'
              if (v === 'do' || v === 'schedule' || v === 'delegate' || v === 'eliminate') return v as Email['ai_quadrant']
              return undefined
            }
            const byId = new Map(enrichData.map(r => [r.email_id, r]))
            for (const email of emails) {
              const ai = byId.get(email.id)
              if (ai) {
                email.ai_quadrant = mapQuadrant(ai.ai_category) ?? email.ai_quadrant
                email.ai_client_name = ai.ai_client_name ?? email.ai_client_name
              }
            }
          }
        } catch (enrichErr) {
          console.warn('Email enrichment from email_processing_history failed (non-fatal):', enrichErr)
        }
      }

      setEmails(emails)
    } catch (e) {
      console.error('Email load error:', e)
      setLoadErrors(prev => ({ ...prev, email: e instanceof Error ? e.message : 'load failed' }))
    }
    setEmailLoading(false)
  }, [])

  const loadCalendar = useCallback(async () => {
    // Strategy: read from calendar_events table first (populated every 30 min by
    // pg_cron sync-calendar-30min calling ms-calendar). Fall back to a live Graph
    // pull only when the cache is empty or stale (>2h old).
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    const end = new Date(start)
    end.setDate(start.getDate() + 14)
    const startIso = start.toISOString()
    const endIso = end.toISOString()

    type CachedEvent = { graph_event_id: string; subject: string; start_time: string; end_time: string; is_all_day: boolean; location?: string; organizer_name?: string; body_preview?: string; synced_at?: string }

    const TWO_HOURS_MS = 2 * 60 * 60 * 1000
    let usedCache = false
    setLoadErrors(e => ({ ...e, calendar: undefined }))

    try {
      const cacheRes = await fetch(
        `${SUPABASE_URL}/rest/v1/calendar_events?select=graph_event_id,subject,start_time,end_time,is_all_day,location,organizer_name,body_preview,synced_at&start_time=gte.${startIso}&start_time=lte.${endIso}&order=start_time.asc&limit=50`,
        { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` } }
      )
      if (cacheRes.ok) {
        const rows: CachedEvent[] = await cacheRes.json()
        const newest = rows.reduce<number>((m, r) => Math.max(m, r.synced_at ? new Date(r.synced_at).getTime() : 0), 0)
        const fresh = rows.length > 0 && (Date.now() - newest) < TWO_HOURS_MS
        if (fresh) {
          const mapped: CalendarEvent[] = rows.map(r => ({
            id: r.graph_event_id,
            subject: r.subject,
            start: { dateTime: r.start_time },
            end: { dateTime: r.end_time },
            isAllDay: r.is_all_day,
            location: r.location ? { displayName: r.location } : undefined,
            organizer: r.organizer_name ? { emailAddress: { name: r.organizer_name } } : undefined,
            bodyPreview: r.body_preview,
          }))
          setEvents(mapped)
          usedCache = true
        }
      }
    } catch (cacheErr) {
      console.warn('calendar_events cache read failed (non-fatal):', cacheErr)
    }

    if (usedCache) return

    // Fallback: live Graph pull. Same endpoint as before — preserves the existing
    // behaviour when the cache is empty or stale (e.g. fresh OAuth, cron missed runs).
    try {
      const { token } = await getMsToken()
      if (!token) { setLoadErrors(e => ({ ...e, calendar: 'auth', auth: true })); return }
      const url = `https://graph.microsoft.com/v1.0/me/calendarView` +
        `?startDateTime=${startIso}&endDateTime=${endIso}` +
        `&$select=id,subject,start,end,location,organizer,bodyPreview,isAllDay` +
        `&$orderby=start/dateTime&$top=50`
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC"' } })
      if (!r.ok) throw new Error(`Graph ${r.status}`)
      const data = await r.json()
      if (data.value) setEvents(data.value)
    } catch (e) {
      console.error('Calendar load error:', e)
      setLoadErrors(prev => ({ ...prev, calendar: e instanceof Error ? e.message : 'load failed' }))
    }
  }, [])

  const loadTasks = useCallback(async () => {
    setLoadErrors(e => ({ ...e, tasks: undefined }))
    try {
      const res  = await fetch(`${SUPABASE_URL}/rest/v1/eisenhower_tasks?select=*&status=neq.done&order=created_at.desc`, { headers: { apikey: ANON_KEY } })
      if (!res.ok) throw new Error(`Supabase ${res.status}`)
      const data = await res.json()
      if (Array.isArray(data)) setTasks(data)
    } catch (e) {
      console.error('Tasks load error:', e)
      setLoadErrors(prev => ({ ...prev, tasks: e instanceof Error ? e.message : 'load failed' }))
    }
  }, [])

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {})
    }
  }, [])

  // Deep-link target (Epic A): briefs/nudges link to /dashboard?tab=today.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get('tab')
    if (p === 'today' || p === 'chat' || p === 'settings') setTab(p)
  }, [])

  useEffect(() => { loadEmails(); loadCalendar(); loadTasks() }, [loadEmails, loadCalendar, loadTasks])

  // (Mail/Calendar/Tasks nav badges removed with their tabs in the v4 IA shrink.)

  const errorMessages = useMemo(() => {
    const m: string[] = []
    if (loadErrors.auth) m.push("Couldn't reach Microsoft — reconnect in Settings if this persists")
    if (loadErrors.email && loadErrors.email !== 'auth') m.push('Inbox failed to load')
    if (loadErrors.calendar && loadErrors.calendar !== 'auth') m.push('Calendar failed to load')
    if (loadErrors.tasks) m.push('Tasks failed to load')
    return m
  }, [loadErrors])
  const reloadAll = useCallback(() => { loadEmails(); loadCalendar(); loadTasks() }, [loadEmails, loadCalendar, loadTasks])

  const calendarHasError = !!(loadErrors.auth || loadErrors.calendar)
  const emailHasError    = !!(loadErrors.auth || loadErrors.email)
  const tasksHasError    = !!loadErrors.tasks

  // "Needs you" badge for the Today queue: Q1 emails + overdue Q1 tasks.
  const todayActionCount = useMemo(() => {
    const today = new Date().toLocaleDateString('en-CA')
    const q1Emails = emails.filter(e => emailToQuadrant(e) === 'do').length
    const overdueTasks = tasks.filter(t => t.quadrant === 'do' && t.status !== 'done' && t.status !== 'cancelled' && t.due_date && t.due_date < today).length
    return q1Emails + overdueTasks
  }, [emails, tasks])

  const completeTaskTop = useCallback(async (id: string) => {
    await fetch(`${SUPABASE_URL}/rest/v1/eisenhower_tasks?id=eq.${id}`, {
      method: 'PATCH', headers: { apikey: ANON_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'done' }),
    })
    loadTasks()
  }, [loadTasks])

  const navItems: Array<{ key: Tab; label: string; badge?: number }> = [
    { key: 'today',     label: 'Today',    badge: todayActionCount || undefined },
    { key: 'chat',      label: 'Chat' },
    { key: 'settings',  label: 'Settings' },
  ]

  return (
    <div style={{ minHeight: '100vh', background: NAVY, fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif", fontWeight: 300 }}>

      {/* Static top header — logo left, tab title centre, logout right */}
      <div className="dash-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 30, height: 30, background: GOLD, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 700, color: NAVY, flexShrink: 0, fontFamily: "'Gujarati Sangam MN', 'DM Sans', serif" }}>Q</div>
          <span style={{ fontSize: 15, fontWeight: 700, color: WHITE, letterSpacing: '-0.3px', fontFamily: "'Gujarati Sangam MN', 'DM Sans', serif" }}>Qurate</span>
        </div>
        <span style={{ fontSize: 15, fontWeight: 400, color: BEIGE, fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif" }}>{TAB_TITLES[tab]}</span>
        <button
          onClick={() => setConfirmSignOut(true)}
          title="Sign out"
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: 'transparent', color: BEIGE, border: `1px solid ${NAVY_BORDER}`, borderRadius: 8, fontSize: 12, cursor: 'pointer', fontFamily: "'Helvetica Neue', 'DM Sans', system-ui, sans-serif", transition: 'all 0.15s' }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = RED; (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(192,57,43,0.4)' }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = BEIGE; (e.currentTarget as HTMLButtonElement).style.borderColor = NAVY_BORDER }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
            <polyline points="16 17 21 12 16 7"/>
            <line x1="21" y1="12" x2="9" y2="12"/>
          </svg>
          Sign out
        </button>
      </div>

      {/* Scrollable content */}
      <div className="main-content">
        <HealthBanner />
        <ErrorBanner messages={errorMessages} onRetry={reloadAll} />
        {tab === 'today'     && <TodayTab emails={emails} tasks={tasks} onCompleteTask={completeTaskTop} />}
        {tab === 'chat'      && <ChatTab />}
        {tab === 'settings'  && <SettingsTab connected={connected} onDisconnect={() => { setConnected(false); window.location.href = '/api/auth/logout' }} settings={userSettings.settings} save={userSettings.save} loading={userSettings.loading} />}
      </div>

      {/* Fixed bottom navigation — Outlook-style */}
      <nav className="bottom-nav">
        {navItems.map(item => (
          <button key={item.key} className={`bottom-nav-item${tab === item.key ? ' active' : ''}`} onClick={() => setTab(item.key)}>
            <NavIcon name={item.key} />
            <span>{item.label}</span>
            {item.badge ? <span className="nav-badge">{item.badge > 99 ? '99+' : item.badge}</span> : null}
          </button>
        ))}
      </nav>

      {confirmSignOut && (
        <Modal title="Sign out?" onClose={() => setConfirmSignOut(false)}>
          <p style={{ margin: '0 0 20px', fontSize: 14, color: BEIGE, lineHeight: 1.6 }}>
            This signs you out and disconnects your Microsoft 365 session. You&apos;ll need to sign in again to access your email and calendar.
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button onClick={() => setConfirmSignOut(false)} style={secondaryBtnStyle}>Cancel</button>
            <button onClick={() => { window.location.href = '/api/auth/logout' }} style={{ ...primaryBtnStyle, background: RED, color: WHITE }}>Sign out</button>
          </div>
        </Modal>
      )}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        * { box-sizing: border-box; }
      `}</style>
    </div>
  )
}
