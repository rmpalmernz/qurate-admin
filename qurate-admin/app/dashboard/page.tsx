'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { SUPABASE_FUNCTIONS_URL } from '@/lib/supabase'

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
  quadrant: 'do' | 'schedule' | 'delegate' | 'eliminate'
  client_name?: string
  due_date?: string
  status: string
  estimated_minutes?: number
  notes?: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmt = (d: string) => new Date(d).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })
const fmtDate = (d: string) => new Date(d).toLocaleDateString('en-AU', { weekday: 'short', month: 'short', day: 'numeric' })
const timeAgo = (d: string) => {
  const diff = Date.now() - new Date(d).getTime()
  const h = Math.floor(diff / 3600000)
  if (h < 1) return `${Math.floor(diff / 60000)}m ago`
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

async function getMsToken(): Promise<string | null> {
  try {
    const res = await authFetch(`${SUPABASE_FUNCTIONS_URL}/ms-auth`)
    const data = await res.json()
    return data.access_token || null
  } catch {
    return null
  }
}

const VIP_CLIENTS = ['Think Water', 'Therefore', 'Providence', 'Armillary', 'Alstonville']
const VIP_DOMAINS  = ['thinkwater', 'therefore', 'providence', 'armillary', 'alstonville']

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

function emailCategory(email: Email): 'vip' | 'partner' | 'tools' | 'other' {
  const addr = email.from.address.toLowerCase()
  const cn   = email.ai_client_name || ''
  if (VIP_CLIENTS.some(c => cn.toLowerCase().includes(c.toLowerCase())) || VIP_DOMAINS.some(d => addr.includes(d))) return 'vip'
  if (addr.includes('noreply') || addr.includes('no-reply') || addr.includes('notifications') ||
      addr.includes('sharepoint') || addr.includes('teams') || addr.includes('n8n') || addr.includes('microsoft')) return 'tools'
  return 'other'
}

const quadrantConfig = {
  do:        { label: 'Do First',  color: '#ef4444', bg: 'rgba(239,68,68,0.08)',   border: 'rgba(239,68,68,0.2)' },
  schedule:  { label: 'Schedule',  color: '#3AAFA9', bg: 'rgba(58,175,169,0.08)',  border: 'rgba(58,175,169,0.2)' },
  delegate:  { label: 'Delegate',  color: '#C9A96E', bg: 'rgba(201,169,110,0.08)', border: 'rgba(201,169,110,0.2)' },
  eliminate: { label: 'Eliminate', color: '#6b7280', bg: 'rgba(107,114,128,0.08)', border: 'rgba(107,114,128,0.2)' },
}

// ─── Shared styles ────────────────────────────────────────────────────────────
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 14px', background: '#0f1117', border: '1px solid #2a2f45',
  borderRadius: 8, color: '#e8eaf0', fontSize: 13, outline: 'none',
  fontFamily: "'DM Sans', sans-serif", boxSizing: 'border-box',
}
const primaryBtnStyle: React.CSSProperties = {
  padding: '10px 20px', background: 'linear-gradient(135deg, #3AAFA9, #2E9E98)',
  color: '#fff', border: 'none', borderRadius: 8, fontSize: 13,
  fontWeight: 500, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
}
const secondaryBtnStyle: React.CSSProperties = {
  padding: '10px 20px', background: 'transparent', color: '#6b7280',
  border: '1px solid #2a2f45', borderRadius: 8, fontSize: 13,
  cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
}

// ─── UI Primitives ────────────────────────────────────────────────────────────
function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      padding: '8px 14px', borderRadius: 8, border: 'none',
      background: active ? 'rgba(58,175,169,0.15)' : 'transparent',
      color: active ? '#3AAFA9' : '#6b7280', fontWeight: active ? 600 : 400,
      fontSize: 13, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
      transition: 'all 0.15s', whiteSpace: 'nowrap',
    }}>{children}</button>
  )
}

function Card({ children, style = {} }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ background: '#1a1d27', border: '1px solid #2a2f45', borderRadius: 12, padding: 20, ...style }}>{children}</div>
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
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40, color: '#3AAFA9', gap: 10 }}>
      <span style={{ display: 'inline-block', width: 20, height: 20, border: '2px solid rgba(58,175,169,0.2)', borderTopColor: '#3AAFA9', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      Loading...
    </div>
  )
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 24 }} onClick={onClose}>
      <div style={{ background: '#1a1d27', border: '1px solid #2a2f45', borderRadius: 16, padding: 28, maxWidth: 560, width: '100%', maxHeight: '90vh', overflow: 'auto' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: '#e8eaf0' }}>{title}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 22, lineHeight: 1, padding: 0 }}>&#x2715;</button>
        </div>
        {children}
      </div>
    </div>
  )
}

// ─── BRIEFING TAB ─────────────────────────────────────────────────────────────
function BriefingTab({ events, tasks, emails }: { events: CalendarEvent[]; tasks: EisenhowerTask[]; emails: Email[] }) {
  const [brief, setBrief] = useState('')
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)

  useEffect(() => {
    fetch(`${SUPABASE_URL}/rest/v1/ai_daily_briefs?select=brief_text&order=created_at.desc&limit=1`, { headers: { apikey: ANON_KEY } })
      .then(r => r.json())
      .then(data => { if (data?.[0]) setBrief(data[0].brief_text); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  async function generateBrief() {
    setGenerating(true)
    try {
      const res = await authFetch(`${SUPABASE_FUNCTIONS_URL}/chat`, {
        method: 'POST',
        body: JSON.stringify({ message: "Generate my morning briefing for today. Include today's calendar, top Q1 tasks, email priority summary, and recommended Q2 focus blocks.", history: [] }),
      })
      const data = await res.json()
      setBrief(data.response || data.message || 'Brief generated.')
    } catch { setBrief('Error generating brief.') }
    setGenerating(false)
  }

  const today      = new Date()
  const hour       = today.getHours()
  const greeting   = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  const todayStr   = today.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' })
  const todayEvts  = events
                           .filter(e => (e.start?.dateTime || e.start?.date) && localDateKey(evtStart(e)) === localDateKey(today))
                           .sort((a, b) => evtStart(a).getTime() - evtStart(b).getTime())
  const q1Tasks    = tasks.filter(t => t.quadrant === 'do')
  const q2Tasks    = tasks.filter(t => t.quadrant === 'schedule')
  const q1Emails   = emails.filter(e => emailToQuadrant(e) === 'do')
  const unread     = emails.filter(e => !e.isRead).length

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: '#e8eaf0', letterSpacing: '-0.5px' }}>{greeting}, Richard</h2>
          <span style={{ color: '#6b7280', fontSize: 13 }}>{todayStr}</span>
        </div>
        <button onClick={generateBrief} disabled={generating} style={{ padding: '7px 14px', background: 'rgba(201,169,110,0.12)', color: '#C9A96E', border: '1px solid rgba(201,169,110,0.25)', borderRadius: 8, fontSize: 12, fontWeight: 500, cursor: generating ? 'not-allowed' : 'pointer', fontFamily: "'DM Sans', sans-serif" }}>
          {generating ? 'Generating...' : 'Generate Brief'}
        </button>
      </div>

      {(q1Tasks.length > 0 || q1Emails.length > 0 || unread > 0) && (
        <div style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 12, padding: '12px 16px', display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'center' }}>
          {q1Tasks.length > 0 && <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ width: 7, height: 7, borderRadius: '50%', background: '#ef4444', flexShrink: 0 }} /><span style={{ fontSize: 13, color: '#e8eaf0', fontWeight: 500 }}>{q1Tasks.length} Q1 task{q1Tasks.length !== 1 ? 's' : ''} need action today</span></div>}
          {q1Emails.length > 0 && <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ width: 7, height: 7, borderRadius: '50%', background: '#ef4444', flexShrink: 0 }} /><span style={{ fontSize: 13, color: '#e8eaf0', fontWeight: 500 }}>{q1Emails.length} urgent email{q1Emails.length !== 1 ? 's' : ''} require response</span></div>}
          {unread > 0 && <span style={{ fontSize: 12, color: '#6b7280' }}>{unread} unread total</span>}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Card>
          <h3 style={{ margin: '0 0 14px', fontSize: 13, fontWeight: 600, color: '#3AAFA9', textTransform: 'uppercase', letterSpacing: '0.8px' }}>Today&apos;s Calendar</h3>
          {todayEvts.length === 0 ? <p style={{ color: '#6b7280', fontSize: 13, margin: 0 }}>No meetings today — clear day ahead.</p> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {todayEvts.map(e => (
                <div key={e.id} style={{ display: 'flex', gap: 14, padding: '10px 12px', background: '#22263a', borderRadius: 8 }}>
                  <div style={{ minWidth: 68, color: '#3AAFA9', fontSize: 12, fontWeight: 600, paddingTop: 2 }}>{(e.isAllDay || !e.start.dateTime) ? 'All day' : fmt(e.start.dateTime)}</div>
                  <div>
                    <div style={{ fontWeight: 500, color: '#e8eaf0', fontSize: 14, marginBottom: 2 }}>{e.subject}</div>
                    {e.location?.displayName && <div style={{ color: '#6b7280', fontSize: 12 }}>@ {e.location.displayName}</div>}
                    {e.organizer?.emailAddress?.name && <div style={{ color: '#6b7280', fontSize: 12 }}>with {e.organizer.emailAddress.name}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <h3 style={{ margin: '0 0 14px', fontSize: 13, fontWeight: 600, color: '#ef4444', textTransform: 'uppercase', letterSpacing: '0.8px' }}>Q1 — Do First</h3>
          {q1Tasks.length === 0 ? <p style={{ color: '#6b7280', fontSize: 13, margin: 0 }}>No urgent tasks — great start!</p> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {q1Tasks.slice(0, 6).map(t => (
                <div key={t.id} style={{ padding: '8px 10px', background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.15)', borderRadius: 8 }}>
                  <p style={{ margin: '0 0 2px', fontSize: 13, color: '#e8eaf0', fontWeight: 500 }}>{t.title}</p>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {t.client_name && <span style={{ fontSize: 11, color: '#3AAFA9' }}>{t.client_name}</span>}
                    {t.due_date && <span style={{ fontSize: 11, color: '#6b7280' }}>{fmtDate(t.due_date)}</span>}
                  </div>
                </div>
              ))}
              {q1Tasks.length > 6 && <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>+{q1Tasks.length - 6} more in Matrix tab</p>}
            </div>
          )}
        </Card>
      </div>

      {q2Tasks.length > 0 && (
        <Card>
          <h3 style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 600, color: '#3AAFA9', textTransform: 'uppercase', letterSpacing: '0.8px' }}>Recommended Focus Blocks — Q2 Work</h3>
          <p style={{ margin: '0 0 12px', fontSize: 13, color: '#6b7280' }}>{q2Tasks.length} scheduled item{q2Tasks.length !== 1 ? 's' : ''} — protect 2-3 hours today for deep advisory work.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {q2Tasks.slice(0, 3).map(t => (
              <div key={t.id} style={{ padding: '9px 12px', background: 'rgba(58,175,169,0.06)', border: '1px solid rgba(58,175,169,0.15)', borderRadius: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <span style={{ fontSize: 13, color: '#e8eaf0', fontWeight: 500 }}>{t.title}</span>
                  {t.client_name && <span style={{ fontSize: 11, color: '#3AAFA9', marginLeft: 10 }}>{t.client_name}</span>}
                </div>
                {t.estimated_minutes && <span style={{ fontSize: 11, color: '#6b7280' }}>{t.estimated_minutes}m</span>}
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card>
        <h3 style={{ margin: '0 0 14px', fontSize: 13, fontWeight: 600, color: '#C9A96E', textTransform: 'uppercase', letterSpacing: '0.8px' }}>AI Daily Brief</h3>
        {loading ? <Spinner /> : brief ? (
          <div style={{ color: '#b0b8cc', fontSize: 14, lineHeight: 1.75, whiteSpace: 'pre-wrap' }}>{brief}</div>
        ) : (
          <div>
            <p style={{ color: '#6b7280', fontSize: 13, margin: '0 0 8px' }}>No brief generated yet for today.</p>
            <p style={{ color: '#3d4258', fontSize: 12, margin: 0 }}>Click Generate Brief above to create your morning briefing.</p>
          </div>
        )}
      </Card>
    </div>
  )
}

// ─── EMAIL TAB ────────────────────────────────────────────────────────────────
function EmailTab({ emails, loading, onRefresh }: { emails: Email[]; loading: boolean; onRefresh: () => void }) {
  const [selected, setSelected]       = useState<Email | null>(null)
  const [drafting, setDrafting]       = useState(false)
  const [draft, setDraft]             = useState('')
  const [filter, setFilter]           = useState<'all'|'q1'|'vip'|'tools'|'other'>('all')
  const [archived, setArchived]       = useState<Set<string>>(new Set())
  const [composeOpen, setComposeOpen] = useState(false)
  const [composeTo, setComposeTo]     = useState('')
  const [composeSubj, setComposeSubj] = useState('')
  const [composeBody, setComposeBody] = useState('')
  const [sendConfirm, setSendConfirm] = useState(false)
  const [sending, setSending]         = useState(false)
  const [msToken, setMsToken]         = useState<string | null>(null)
  const draftFnRef = useRef<(e: Email) => void>(() => {})

  useEffect(() => { getMsToken().then(setMsToken) }, [])

  useEffect(() => {
    function handleKey(ev: KeyboardEvent) {
      const tag = (ev.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (!selected) return
      if (ev.key === 'e' || ev.key === 'E') archiveEmail(selected.id)
      else if (ev.key === 'r' || ev.key === 'R') draftFnRef.current(selected)
      else if (ev.key === 'Escape') { setSelected(null); setDraft('') }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [selected])

  function archiveEmail(id: string) {
    setArchived(prev => { const s = new Set(prev); s.add(id); return s })
    if (selected?.id === id) { setSelected(null); setDraft('') }
  }

  async function draftReply(email: Email) {
    setDrafting(true); setDraft('')
    try {
      const res = await authFetch(`${SUPABASE_FUNCTIONS_URL}/draft-reply`, {
        method: 'POST',
        body: JSON.stringify({ email_id: email.id, subject: email.subject, from_name: email.from.name, from_email: email.from.address, body_preview: email.bodyPreview }),
      })
      const data = await res.json()
      setDraft(data.draft || data.body_text || 'Could not generate draft.')
    } catch { setDraft('Error generating draft.') }
    setDrafting(false)
  }
  draftFnRef.current = draftReply

  async function sendEmail() {
    if (!msToken) { alert('No Microsoft token — please reconnect.'); return }
    setSending(true)
    const toAddr = selected ? selected.from.address : composeTo
    const subj   = selected ? `Re: ${selected.subject}` : composeSubj
    const body   = draft || composeBody
    try {
      await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
        method: 'POST',
        headers: { Authorization: `Bearer ${msToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { subject: subj, body: { contentType: 'Text', content: body }, toRecipients: [{ emailAddress: { address: toAddr } }] } }),
      })
      setSendConfirm(false); setDraft('')
      setComposeOpen(false); setComposeTo(''); setComposeSubj(''); setComposeBody('')
    } catch { alert('Failed to send. Please try again.') }
    setSending(false)
  }

  const visible = emails.filter(e => {
    if (archived.has(e.id)) return false
    if (filter === 'all')   return true
    if (filter === 'q1')    return emailToQuadrant(e) === 'do'
    if (filter === 'vip')   return emailCategory(e) === 'vip'
    if (filter === 'tools') return emailCategory(e) === 'tools'
    if (filter === 'other') return emailCategory(e) === 'other'
    return true
  })

  const counts = {
    all:   emails.filter(e => !archived.has(e.id)).length,
    q1:    emails.filter(e => !archived.has(e.id) && emailToQuadrant(e) === 'do').length,
    vip:   emails.filter(e => !archived.has(e.id) && emailCategory(e) === 'vip').length,
    tools: emails.filter(e => !archived.has(e.id) && emailCategory(e) === 'tools').length,
    other: emails.filter(e => !archived.has(e.id) && emailCategory(e) === 'other').length,
  }

  const pc = (p?: string) => p === 'high' ? '#ef4444' : p === 'medium' ? '#C9A96E' : '#6b7280'

  const pill = (key: typeof filter, label: string) => (
    <button key={key} onClick={() => setFilter(key)} style={{ padding: '5px 12px', borderRadius: 20, border: 'none', fontSize: 12, background: filter === key ? 'rgba(58,175,169,0.15)' : 'transparent', color: filter === key ? '#3AAFA9' : '#6b7280', fontWeight: filter === key ? 600 : 400, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>
      {label} <span style={{ opacity: 0.6 }}>({counts[key]})</span>
    </button>
  )

  return (
    <div style={{ display: 'grid', gridTemplateColumns: selected ? '1fr 1fr' : '1fr', gap: 16, alignItems: 'start' }}>

      {/* List column */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            {pill('all', 'All')} {pill('q1', 'Urgent')} {pill('vip', 'VIP')} {pill('tools', 'Tools')} {pill('other', 'Other')}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onRefresh} style={{ padding: '6px 12px', background: 'transparent', color: '#6b7280', border: '1px solid #2a2f45', borderRadius: 8, fontSize: 12, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>Refresh</button>
            <button onClick={() => setComposeOpen(true)} style={{ padding: '6px 14px', background: 'rgba(58,175,169,0.12)', color: '#3AAFA9', border: '1px solid rgba(58,175,169,0.3)', borderRadius: 8, fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>+ Compose</button>
          </div>
        </div>

        <div style={{ fontSize: 11, color: '#3d4258', paddingLeft: 2 }}>
          Shortcuts:&nbsp;
          <kbd style={{ background: '#22263a', padding: '1px 5px', borderRadius: 3, fontSize: 10, color: '#6b7280' }}>E</kbd> archive&nbsp;&nbsp;
          <kbd style={{ background: '#22263a', padding: '1px 5px', borderRadius: 3, fontSize: 10, color: '#6b7280' }}>R</kbd> reply&nbsp;&nbsp;
          <kbd style={{ background: '#22263a', padding: '1px 5px', borderRadius: 3, fontSize: 10, color: '#6b7280' }}>Esc</kbd> close
        </div>

        {loading ? <Spinner /> : visible.length === 0 ? (
          <Card><p style={{ color: '#6b7280', margin: 0, fontSize: 13 }}>No emails in this view.</p></Card>
        ) : visible.map(email => {
          const q    = emailToQuadrant(email)
          const qCfg = quadrantConfig[q]
          const sel  = selected?.id === email.id
          return (
            <div key={email.id} onClick={() => { setSelected(sel ? null : email); if (!sel) setDraft('') }}
              style={{ background: sel ? '#22263a' : '#1a1d27', border: `1px solid ${sel ? '#3AAFA9' : '#2a2f45'}`, borderLeft: `3px solid ${qCfg.color}`, borderRadius: 10, padding: '11px 14px', cursor: 'pointer', transition: 'all 0.15s' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 3 }}>
                <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
                  {!email.isRead && <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#3AAFA9', flexShrink: 0 }} />}
                  <span style={{ fontWeight: email.isRead ? 400 : 600, fontSize: 13, color: '#e8eaf0' }}>{email.from.name}</span>
                  <QuadrantBadge quadrant={q} />
                  {email.ai_client_name && <Badge text={email.ai_client_name} color="#3AAFA9" />}
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0, marginLeft: 8 }}>
                  <span style={{ color: '#6b7280', fontSize: 11 }}>{timeAgo(email.receivedDateTime)}</span>
                  <button onClick={ev => { ev.stopPropagation(); archiveEmail(email.id) }} title="Archive (E)" style={{ background: 'none', border: 'none', color: '#3d4258', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 2px' }}>&#x2715;</button>
                </div>
              </div>
              <div style={{ fontWeight: email.isRead ? 400 : 500, fontSize: 13, color: '#c0c8d8', marginBottom: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{email.subject}</div>
              {email.ai_original_email_summary
                ? <div style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.5 }}>AI: {email.ai_original_email_summary.slice(0, 110)}...</div>
                : <div style={{ fontSize: 12, color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{email.bodyPreview?.slice(0, 100)}</div>}
            </div>
          )
        })}
      </div>

      {/* Detail panel */}
      {selected && (
        <Card style={{ position: 'sticky', top: 72, alignSelf: 'start', maxHeight: 'calc(100vh - 96px)', overflow: 'auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14, gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600, color: '#e8eaf0', lineHeight: 1.4 }}>{selected.subject}</h3>
              <p style={{ margin: 0, fontSize: 12, color: '#6b7280' }}>From: {selected.from.name} &lt;{selected.from.address}&gt;</p>
              <p style={{ margin: '3px 0 0', fontSize: 11, color: '#3d4258' }}>{new Date(selected.receivedDateTime).toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</p>
            </div>
            <button onClick={() => { setSelected(null); setDraft('') }} style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 20, flexShrink: 0 }}>&#x2715;</button>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
            <QuadrantBadge quadrant={emailToQuadrant(selected)} />
            {selected.ai_category && <Badge text={selected.ai_category} color="#3AAFA9" />}
            {selected.ai_priority_level && <Badge text={selected.ai_priority_level} color={pc(selected.ai_priority_level)} />}
          </div>

          {selected.ai_original_email_summary && (
            <div style={{ background: 'rgba(58,175,169,0.06)', border: '1px solid rgba(58,175,169,0.15)', borderRadius: 8, padding: '10px 12px', marginBottom: 14 }}>
              <p style={{ margin: '0 0 4px', fontSize: 11, fontWeight: 600, color: '#3AAFA9', textTransform: 'uppercase', letterSpacing: '0.5px' }}>AI Summary</p>
              <p style={{ margin: 0, fontSize: 13, color: '#b0b8cc', lineHeight: 1.6 }}>{selected.ai_original_email_summary}</p>
            </div>
          )}

          <p style={{ fontSize: 13, color: '#8892a4', lineHeight: 1.75, marginBottom: 16 }}>{selected.bodyPreview}</p>

          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <button onClick={() => draftReply(selected)} disabled={drafting} style={{ flex: 1, padding: '9px 14px', background: 'rgba(58,175,169,0.12)', color: '#3AAFA9', border: '1px solid rgba(58,175,169,0.3)', borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: drafting ? 'not-allowed' : 'pointer', fontFamily: "'DM Sans', sans-serif" }}>
              {drafting ? 'Drafting...' : 'Draft AI Reply'}
            </button>
            <button onClick={() => archiveEmail(selected.id)} style={{ padding: '9px 14px', background: 'transparent', color: '#6b7280', border: '1px solid #2a2f45', borderRadius: 8, fontSize: 13, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>Archive</button>
          </div>

          {draft && (
            <div style={{ background: '#22263a', border: '1px solid #2a2f45', borderRadius: 8, padding: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <p style={{ margin: 0, fontSize: 11, fontWeight: 600, color: '#C9A96E', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Draft Reply</p>
                <button onClick={() => setSendConfirm(true)} style={{ padding: '5px 12px', background: 'linear-gradient(135deg, #3AAFA9, #2E9E98)', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>Send</button>
              </div>
              <textarea value={draft} onChange={e => setDraft(e.target.value)} style={{ width: '100%', minHeight: 130, background: 'transparent', border: 'none', color: '#b0b8cc', fontSize: 13, lineHeight: 1.6, resize: 'vertical', outline: 'none', fontFamily: "'DM Sans', sans-serif" }} />
            </div>
          )}
        </Card>
      )}

      {/* Compose modal */}
      {composeOpen && (
        <Modal title="New Email" onClose={() => setComposeOpen(false)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <input value={composeTo} onChange={e => setComposeTo(e.target.value)} placeholder="To: email@example.com" style={inputStyle} />
            <input value={composeSubj} onChange={e => setComposeSubj(e.target.value)} placeholder="Subject" style={inputStyle} />
            <textarea value={composeBody} onChange={e => setComposeBody(e.target.value)} placeholder="Write your message..." rows={8} style={{ ...inputStyle, resize: 'vertical', minHeight: 160 }} />
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setComposeOpen(false)} style={secondaryBtnStyle}>Cancel</button>
              <button onClick={() => { setDraft(composeBody); setSendConfirm(true) }} disabled={!composeTo || !composeSubj || !composeBody} style={{ ...primaryBtnStyle, opacity: (!composeTo || !composeSubj || !composeBody) ? 0.5 : 1 }}>Review &amp; Send</button>
            </div>
          </div>
        </Modal>
      )}

      {/* Send confirmation modal */}
      {sendConfirm && (
        <Modal title="Confirm Send" onClose={() => setSendConfirm(false)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ background: '#0f1117', border: '1px solid #2a2f45', borderRadius: 8, padding: 14 }}>
              <p style={{ margin: '0 0 6px', fontSize: 12, color: '#6b7280' }}>To: <strong style={{ color: '#e8eaf0' }}>{selected ? selected.from.address : composeTo}</strong></p>
              <p style={{ margin: '0 0 10px', fontSize: 12, color: '#6b7280' }}>Subject: <strong style={{ color: '#e8eaf0' }}>{selected ? `Re: ${selected.subject}` : composeSubj}</strong></p>
              <p style={{ margin: 0, fontSize: 13, color: '#b0b8cc', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{(draft || composeBody).slice(0, 300)}{(draft || composeBody).length > 300 ? '...' : ''}</p>
            </div>
            <p style={{ margin: 0, fontSize: 12, color: '#C9A96E' }}>This will send immediately. Please review before confirming.</p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setSendConfirm(false)} style={secondaryBtnStyle}>Cancel</button>
              <button onClick={sendEmail} disabled={sending} style={{ ...primaryBtnStyle, opacity: sending ? 0.7 : 1 }}>{sending ? 'Sending...' : 'Send Now'}</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ─── MATRIX TAB ───────────────────────────────────────────────────────────────
function MatrixTab({ tasks, onRefresh }: { tasks: EisenhowerTask[]; onRefresh: () => void }) {
  const [addOpen, setAddOpen]           = useState(false)
  const [completing, setCompleting]     = useState<string | null>(null)
  const [taskTitle, setTaskTitle]       = useState('')
  const [taskQuadrant, setTaskQuadrant] = useState<'do'|'schedule'|'delegate'|'eliminate'>('do')
  const [taskClient, setTaskClient]     = useState('')
  const [taskDue, setTaskDue]           = useState('')
  const [taskMins, setTaskMins]         = useState('')
  const [taskNotes, setTaskNotes]       = useState('')
  const [saving, setSaving]             = useState(false)

  function resetForm() {
    setTaskTitle(''); setTaskQuadrant('do'); setTaskClient('')
    setTaskDue(''); setTaskMins(''); setTaskNotes('')
  }

  async function createTask() {
    if (!taskTitle.trim()) return
    setSaving(true)
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/eisenhower_tasks`, {
        method: 'POST',
        headers: { apikey: ANON_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({
          title: taskTitle.trim(),
          quadrant: taskQuadrant,
          client_name: taskClient || null,
          due_date: taskDue || null,
          estimated_minutes: taskMins ? parseInt(taskMins) : null,
          notes: taskNotes || null,
          status: 'pending',
        }),
      })
      setAddOpen(false)
      resetForm()
      onRefresh()
    } catch { alert('Failed to create task. Please try again.') }
    setSaving(false)
  }

  async function completeTask(id: string) {
    setCompleting(id)
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/eisenhower_tasks?id=eq.${id}`, {
        method: 'PATCH',
        headers: { apikey: ANON_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'done' }),
      })
      onRefresh()
    } catch { alert('Failed to update task.') }
    setCompleting(null)
  }

  const quadrants = ['do', 'schedule', 'delegate', 'eliminate'] as const
  const q1Count   = tasks.filter(t => t.quadrant === 'do').length

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#e8eaf0' }}>Eisenhower Matrix</h3>
        <button onClick={() => setAddOpen(true)} style={{ padding: '7px 14px', background: 'rgba(58,175,169,0.12)', color: '#3AAFA9', border: '1px solid rgba(58,175,169,0.3)', borderRadius: 8, fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>+ Add Task</button>
      </div>

      {q1Count > 8 && (
        <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 10, padding: '10px 16px', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 16 }}>&#9888;</span>
          <span style={{ fontSize: 13, color: '#ef4444', fontWeight: 500 }}>Q1 overload: {q1Count} urgent tasks. Consider delegating or rescheduling some items.</span>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {quadrants.map(q => {
          const cfg    = quadrantConfig[q]
          const qTasks = tasks.filter(t => t.quadrant === q)
          return (
            <div key={q} style={{ background: cfg.bg, border: `1px solid ${cfg.border}`, borderRadius: 12, padding: 16, minHeight: 160 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: cfg.color }} />
                <span style={{ fontSize: 12, fontWeight: 700, color: cfg.color, textTransform: 'uppercase', letterSpacing: '0.6px' }}>{cfg.label}</span>
                <span style={{ marginLeft: 'auto', fontSize: 11, color: '#6b7280' }}>{qTasks.length}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {qTasks.length === 0 ? <p style={{ color: '#3d4258', fontSize: 12, margin: 0 }}>No tasks</p> : qTasks.map(t => (
                  <div key={t.id} style={{ background: '#1a1d27', border: '1px solid #2a2f45', borderRadius: 8, padding: '8px 10px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                      <p style={{ margin: '0 0 2px', fontSize: 13, color: '#e8eaf0', fontWeight: 500, flex: 1 }}>{t.title}</p>
                      <button
                        onClick={() => completeTask(t.id)}
                        disabled={completing === t.id}
                        title="Mark complete"
                        style={{ width: 22, height: 22, borderRadius: '50%', border: `1.5px solid ${cfg.color}`, background: 'transparent', color: cfg.color, cursor: completing === t.id ? 'not-allowed' : 'pointer', fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, opacity: completing === t.id ? 0.5 : 1, padding: 0 }}
                      >&#10003;</button>
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {t.client_name && <span style={{ fontSize: 11, color: '#3AAFA9' }}>{t.client_name}</span>}
                      {t.due_date && <span style={{ fontSize: 11, color: '#6b7280' }}>{fmtDate(t.due_date)}</span>}
                      {t.estimated_minutes && <span style={{ fontSize: 11, color: '#6b7280' }}>{t.estimated_minutes}m</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {addOpen && (
        <Modal title="Add Task" onClose={() => { setAddOpen(false); resetForm() }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <input value={taskTitle} onChange={e => setTaskTitle(e.target.value)} placeholder="Task title *" style={inputStyle} autoFocus />
            <select value={taskQuadrant} onChange={e => setTaskQuadrant(e.target.value as typeof taskQuadrant)} style={{ ...inputStyle, cursor: 'pointer' }}>
              <option value="do">Q1 — Do First (urgent + important)</option>
              <option value="schedule">Q2 — Schedule (important, not urgent)</option>
              <option value="delegate">Q3 — Delegate (urgent, not important)</option>
              <option value="eliminate">Q4 — Eliminate (not urgent, not important)</option>
            </select>
            <input value={taskClient} onChange={e => setTaskClient(e.target.value)} placeholder="Client name (optional)" style={inputStyle} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <input type="date" value={taskDue} onChange={e => setTaskDue(e.target.value)} style={inputStyle} />
              <input type="number" value={taskMins} onChange={e => setTaskMins(e.target.value)} placeholder="Est. minutes" min={1} style={inputStyle} />
            </div>
            <textarea value={taskNotes} onChange={e => setTaskNotes(e.target.value)} placeholder="Notes (optional)" rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => { setAddOpen(false); resetForm() }} style={secondaryBtnStyle}>Cancel</button>
              <button onClick={createTask} disabled={!taskTitle.trim() || saving} style={{ ...primaryBtnStyle, opacity: !taskTitle.trim() || saving ? 0.5 : 1 }}>{saving ? 'Saving...' : 'Add Task'}</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ─── CALENDAR TAB ─────────────────────────────────────────────────────────────
// Helper: local YYYY-MM-DD string from a Date (avoids UTC/timezone boundary issues)
function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Helper: get a sortable Date from a calendar event (handles both timed + all-day)
function evtStart(e: CalendarEvent): Date {
  return e.start.dateTime ? new Date(e.start.dateTime) : new Date(e.start.date + 'T00:00:00')
}
function evtEnd(e: CalendarEvent): Date {
  return e.end.dateTime ? new Date(e.end.dateTime) : new Date(e.end.date + 'T23:59:59')
}

function CalendarTab({ events }: { events: CalendarEvent[] }) {
  const [view, setView] = useState<'agenda'|'week'>('agenda')

  const now       = new Date()
  const todayKey  = localDateKey(now)
  const tomorrow  = new Date(now); tomorrow.setDate(now.getDate() + 1)
  const tmrwKey   = localDateKey(tomorrow)
  const todayMid  = new Date(now); todayMid.setHours(0, 0, 0, 0)

  // Upcoming events sorted by start time (includes all-day events)
  const upcoming = [...events]
    .filter(e => (e.start?.dateTime || e.start?.date) && evtEnd(e).getTime() >= todayMid.getTime())
    .sort((a, b) => evtStart(a).getTime() - evtStart(b).getTime())

  // Group events by local YYYY-MM-DD key (no re-parsing needed)
  type DayGroup = { label: string; isToday: boolean; events: CalendarEvent[] }
  const byDay: Record<string, DayGroup> = {}
  upcoming.forEach(e => {
    const d   = evtStart(e)
    const key = localDateKey(d)
    if (!byDay[key]) {
      const isToday    = key === todayKey
      const isTomorrow = key === tmrwKey
      const label      = isToday ? 'Today' : isTomorrow ? 'Tomorrow' : d.toLocaleDateString('en-AU', { weekday: 'short', month: 'short', day: 'numeric' })
      byDay[key] = { label, isToday, events: [] }
    }
    byDay[key].events.push(e)
  })

  // Mon–Sun for current week
  const weekDays = (() => {
    const dow = now.getDay()
    const mon = new Date(now); mon.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1)); mon.setHours(0, 0, 0, 0)
    return Array.from({ length: 7 }, (_, i) => { const x = new Date(mon); x.setDate(mon.getDate() + i); return x })
  })()

  const viewToggleBtn = (v: 'agenda'|'week', label: string) => (
    <button key={v} onClick={() => setView(v)} style={{ padding: '5px 14px', borderRadius: 6, border: 'none', fontSize: 12, background: view === v ? 'rgba(58,175,169,0.15)' : 'transparent', color: view === v ? '#3AAFA9' : '#6b7280', fontWeight: view === v ? 600 : 400, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>{label}</button>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#e8eaf0' }}>Calendar</h3>
        <div style={{ display: 'flex', gap: 2, background: '#1a1d27', border: '1px solid #2a2f45', borderRadius: 8, padding: 3 }}>
          {viewToggleBtn('agenda', 'Agenda')}
          {viewToggleBtn('week', 'Week')}
        </div>
      </div>

      {view === 'agenda' ? (
        upcoming.length === 0
          ? <Card><p style={{ color: '#6b7280', margin: 0, fontSize: 13 }}>No upcoming events.</p></Card>
          : <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {Object.entries(byDay).slice(0, 14).map(([key, group]) => (
                <div key={key}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: group.isToday ? '#3AAFA9' : '#6b7280', textTransform: 'uppercase', letterSpacing: '0.6px' }}>{group.label}</span>
                    <div style={{ flex: 1, height: 1, background: '#2a2f45' }} />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {group.events.map(e => (
                      <Card key={e.id} style={{ padding: '12px 14px' }}>
                        <div style={{ display: 'flex', gap: 14 }}>
                          <div style={{ minWidth: 90, color: '#3AAFA9', fontSize: 12, fontWeight: 600, paddingTop: 2, flexShrink: 0 }}>
                            {(e.isAllDay || !e.start.dateTime) ? 'All day' : `${fmt(e.start.dateTime)} \u2013 ${fmt(e.end.dateTime!)}`}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 500, color: '#e8eaf0', fontSize: 14, marginBottom: 3 }}>{e.subject}</div>
                            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                              {e.location?.displayName && <span style={{ fontSize: 12, color: '#6b7280' }}>@ {e.location.displayName}</span>}
                              {e.organizer?.emailAddress?.name && <span style={{ fontSize: 12, color: '#6b7280' }}>with {e.organizer.emailAddress.name}</span>}
                            </div>
                            {e.bodyPreview && <p style={{ margin: '5px 0 0', fontSize: 12, color: '#3d4258', lineHeight: 1.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.bodyPreview.slice(0, 140)}</p>}
                          </div>
                        </div>
                      </Card>
                    ))}
                  </div>
                </div>
              ))}
            </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 8 }}>
          {weekDays.map(day => {
            const dayKey  = localDateKey(day)
            const isToday = dayKey === todayKey
            const dayEvts = events
              .filter(e => (e.start?.dateTime || e.start?.date) && localDateKey(evtStart(e)) === dayKey)
              .sort((a, b) => evtStart(a).getTime() - evtStart(b).getTime())
            return (
              <div key={dayKey} style={{ background: isToday ? 'rgba(58,175,169,0.06)' : '#1a1d27', border: `1px solid ${isToday ? 'rgba(58,175,169,0.3)' : '#2a2f45'}`, borderRadius: 10, padding: '10px 8px', minHeight: 140 }}>
                <div style={{ textAlign: 'center', marginBottom: 10 }}>
                  <div style={{ fontSize: 10, fontWeight: 600, color: isToday ? '#3AAFA9' : '#6b7280', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{day.toLocaleDateString('en-AU', { weekday: 'short' })}</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: isToday ? '#3AAFA9' : '#e8eaf0', lineHeight: 1.3 }}>{day.getDate()}</div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {dayEvts.length === 0
                    ? <p style={{ color: '#2a2f45', fontSize: 11, margin: 0, textAlign: 'center' }}>&#8212;</p>
                    : dayEvts.map(e => (
                        <div key={e.id} style={{ background: 'rgba(58,175,169,0.1)', borderLeft: '2px solid #3AAFA9', borderRadius: 4, padding: '3px 6px' }}>
                          <div style={{ fontSize: 10, color: '#3AAFA9', fontWeight: 600 }}>{(e.isAllDay || !e.start.dateTime) ? 'All day' : fmt(e.start.dateTime)}</div>
                          <div style={{ fontSize: 11, color: '#c0c8d8', lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.subject}</div>
                        </div>
                      ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── CLIENTS TAB ──────────────────────────────────────────────────────────────
function ClientsTab({ emails, tasks }: { emails: Email[]; tasks: EisenhowerTask[] }) {
  const clientList = VIP_CLIENTS.map((name, i) => {
    const domain       = VIP_DOMAINS[i]
    const clientEmails = emails.filter(e => {
      const cn   = (e.ai_client_name || '').toLowerCase()
      const addr = e.from.address.toLowerCase()
      return cn.includes(name.toLowerCase()) || addr.includes(domain)
    })
    const clientTasks  = tasks.filter(t => (t.client_name || '').toLowerCase().includes(name.toLowerCase()))
    const sorted       = [...clientEmails].sort((a, b) => new Date(b.receivedDateTime).getTime() - new Date(a.receivedDateTime).getTime())
    const lastEmail    = sorted[0]
    const urgentCount  = clientTasks.filter(t => t.quadrant === 'do').length
    const unreadCount  = clientEmails.filter(e => !e.isRead).length
    return { name, emails: clientEmails, tasks: clientTasks, lastEmail, urgentCount, unreadCount }
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#e8eaf0' }}>Client Pipeline</h3>
        <span style={{ fontSize: 12, color: '#6b7280' }}>{clientList.length} VIP clients tracked</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {clientList.map(c => (
          <Card key={c.name}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
              <div>
                <h4 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600, color: '#e8eaf0' }}>{c.name}</h4>
                {c.lastEmail
                  ? <p style={{ margin: 0, fontSize: 11, color: '#6b7280' }}>Last contact: {timeAgo(c.lastEmail.receivedDateTime)}</p>
                  : <p style={{ margin: 0, fontSize: 11, color: '#3d4258' }}>No recent email</p>}
              </div>
              {c.urgentCount > 0 && (
                <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 4, background: 'rgba(239,68,68,0.12)', color: '#ef4444', flexShrink: 0 }}>{c.urgentCount} urgent</span>
              )}
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              {[
                { val: c.emails.length, label: 'emails',  color: '#3AAFA9' },
                { val: c.tasks.length,  label: 'tasks',   color: '#C9A96E' },
                { val: c.unreadCount,   label: 'unread',  color: c.unreadCount > 0 ? '#ef4444' : '#6b7280' },
              ].map(({ val, label, color }) => (
                <div key={label} style={{ flex: 1, background: '#0f1117', borderRadius: 8, padding: '8px 6px', textAlign: 'center' }}>
                  <div style={{ fontSize: 20, fontWeight: 700, color }}>{val}</div>
                  <div style={{ fontSize: 11, color: '#6b7280' }}>{label}</div>
                </div>
              ))}
            </div>

            {c.tasks.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <p style={{ margin: '0 0 6px', fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Active tasks</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {c.tasks.slice(0, 3).map(t => (
                    <div key={t.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 8px', background: '#0f1117', borderRadius: 6 }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: quadrantConfig[t.quadrant].color, flexShrink: 0 }} />
                      <span style={{ fontSize: 12, color: '#b0b8cc', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                    </div>
                  ))}
                  {c.tasks.length > 3 && <p style={{ margin: 0, fontSize: 11, color: '#3d4258' }}>+{c.tasks.length - 3} more</p>}
                </div>
              </div>
            )}

            {c.lastEmail && (
              <div style={{ padding: '8px 10px', background: '#0f1117', borderRadius: 8 }}>
                <p style={{ margin: '0 0 2px', fontSize: 11, color: '#6b7280' }}>{c.lastEmail.from.name}</p>
                <p style={{ margin: 0, fontSize: 12, color: '#8892a4', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.lastEmail.subject}</p>
              </div>
            )}

            {!c.lastEmail && c.tasks.length === 0 && (
              <p style={{ margin: 0, fontSize: 12, color: '#3d4258' }}>No recent activity</p>
            )}
          </Card>
        ))}
      </div>
    </div>
  )
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
      const res = await authFetch(`${SUPABASE_FUNCTIONS_URL}/chat`, { method: 'POST', body: JSON.stringify({ message: userMsg, history: messages }) })
      const data = await res.json()
      setMessages(m => [...m, { role: 'assistant', content: data.response || data.message || JSON.stringify(data) }])
    } catch {
      setMessages(m => [...m, { role: 'assistant', content: 'Sorry, I encountered an error. Please try again.' }])
    }
    setLoading(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 180px)' }}>
      {messages.length <= 1 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          {quickActions.map(qa => (
            <button key={qa.label} onClick={() => send(qa.msg)} style={{ padding: '7px 14px', background: '#1a1d27', color: '#8892a4', border: '1px solid #2a2f45', borderRadius: 20, fontSize: 12, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>
              {qa.label}
            </button>
          ))}
        </div>
      )}
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 16 }}>
        {messages.map((m, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
            <div style={{ maxWidth: '75%', padding: '10px 14px', borderRadius: m.role === 'user' ? '12px 12px 4px 12px' : '12px 12px 12px 4px', background: m.role === 'user' ? 'linear-gradient(135deg, #3AAFA9, #2E9E98)' : '#1a1d27', border: m.role === 'assistant' ? '1px solid #2a2f45' : 'none', color: '#e8eaf0', fontSize: 14, lineHeight: 1.6 }}>
              {m.content}
            </div>
          </div>
        ))}
        {loading && (
          <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
            <div style={{ padding: '10px 14px', background: '#1a1d27', border: '1px solid #2a2f45', borderRadius: '12px 12px 12px 4px', color: '#6b7280', fontSize: 14 }}>Thinking...</div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && !e.shiftKey && send()} placeholder="Ask me anything about your day..." style={{ flex: 1, padding: '12px 16px', background: '#1a1d27', border: '1px solid #2a2f45', borderRadius: 10, color: '#e8eaf0', fontSize: 14, outline: 'none', fontFamily: "'DM Sans', sans-serif" }} />
        <button onClick={() => send()} disabled={loading || !input.trim()} style={{ padding: '12px 20px', background: loading || !input.trim() ? '#22263a' : 'linear-gradient(135deg, #3AAFA9, #2E9E98)', color: loading || !input.trim() ? '#3d4258' : '#fff', border: 'none', borderRadius: 10, cursor: loading || !input.trim() ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 500, fontFamily: "'DM Sans', sans-serif" }}>Send</button>
      </div>
    </div>
  )
}

// ─── SETTINGS TAB ─────────────────────────────────────────────────────────────
function SettingsTab({ connected, onDisconnect }: { connected: boolean; onDisconnect: () => void }) {
  const [briefingTime, setBriefingTime] = useState('08:00')
  const [focusStart, setFocusStart]     = useState('09:00')
  const [focusEnd, setFocusEnd]         = useState('12:00')
  const [vipContacts, setVipContacts]   = useState<string[]>([...VIP_CLIENTS])
  const [newContact, setNewContact]     = useState('')
  const [saved, setSaved]               = useState(false)

  // Read localStorage after mount (SSR-safe)
  useEffect(() => {
    setBriefingTime(localStorage.getItem('pref_briefing_time') || '08:00')
    setFocusStart(localStorage.getItem('pref_focus_start')    || '09:00')
    setFocusEnd(localStorage.getItem('pref_focus_end')        || '12:00')
    try {
      const raw = localStorage.getItem('pref_vip_contacts')
      if (raw) setVipContacts(JSON.parse(raw))
    } catch {}
  }, [])

  function savePrefs() {
    localStorage.setItem('pref_briefing_time',  briefingTime)
    localStorage.setItem('pref_focus_start',    focusStart)
    localStorage.setItem('pref_focus_end',      focusEnd)
    localStorage.setItem('pref_vip_contacts',   JSON.stringify(vipContacts))
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  function addContact() {
    const c = newContact.trim()
    if (c && !vipContacts.includes(c)) { setVipContacts(p => [...p, c]); setNewContact('') }
  }

  async function disconnect() {
    await authFetch(`${SUPABASE_FUNCTIONS_URL}/ms-auth?action=disconnect`)
    onDisconnect()
  }

  const archiveRules = [
    { label: 'No-reply senders',       pattern: 'noreply@*,  no-reply@*' },
    { label: 'Notification services',  pattern: 'notifications@*' },
    { label: 'SharePoint / Teams',     pattern: '*@sharepoint.com, *@teams.microsoft.com' },
    { label: 'n8n automation',         pattern: '*@n8n.io' },
    { label: 'Microsoft system mail',  pattern: '*@microsoft.com' },
  ]

  const labelStyle: React.CSSProperties = { fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 6 }

  return (
    <div style={{ maxWidth: 600, display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Briefing Preferences */}
      <Card>
        <h3 style={{ margin: '0 0 16px', fontSize: 13, fontWeight: 600, color: '#3AAFA9', textTransform: 'uppercase', letterSpacing: '0.8px' }}>Briefing Preferences</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={labelStyle}>Daily Briefing Time</label>
            <input type="time" value={briefingTime} onChange={e => setBriefingTime(e.target.value)} style={{ ...inputStyle, maxWidth: 160 }} />
          </div>
          <div>
            <label style={labelStyle}>Focus Block Window</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input type="time" value={focusStart} onChange={e => setFocusStart(e.target.value)} style={{ ...inputStyle, maxWidth: 140 }} />
              <span style={{ color: '#6b7280', fontSize: 13 }}>to</span>
              <input type="time" value={focusEnd}   onChange={e => setFocusEnd(e.target.value)}   style={{ ...inputStyle, maxWidth: 140 }} />
            </div>
          </div>
        </div>
      </Card>

      {/* VIP Clients */}
      <Card>
        <h3 style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 600, color: '#C9A96E', textTransform: 'uppercase', letterSpacing: '0.8px' }}>VIP Clients</h3>
        <p style={{ margin: '0 0 12px', fontSize: 12, color: '#6b7280' }}>Treated as VIP in Email and Clients tabs. Changes apply on next page load.</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
          {vipContacts.map(name => (
            <div key={name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 10px', background: '#0f1117', border: '1px solid #2a2f45', borderRadius: 7 }}>
              <span style={{ fontSize: 13, color: '#e8eaf0' }}>{name}</span>
              <button onClick={() => setVipContacts(p => p.filter(c => c !== name))} style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 2px' }}>&#x2715;</button>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={newContact} onChange={e => setNewContact(e.target.value)} onKeyDown={e => e.key === 'Enter' && addContact()} placeholder="Add client name..." style={{ ...inputStyle, flex: 1 }} />
          <button onClick={addContact} disabled={!newContact.trim()} style={{ ...primaryBtnStyle, opacity: newContact.trim() ? 1 : 0.5 }}>Add</button>
        </div>
      </Card>

      {/* Auto-archive Rules */}
      <Card>
        <h3 style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 600, color: '#3AAFA9', textTransform: 'uppercase', letterSpacing: '0.8px' }}>Auto-archive Rules</h3>
        <p style={{ margin: '0 0 12px', fontSize: 12, color: '#6b7280' }}>Emails matching these patterns are routed to the Tools filter automatically.</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {archiveRules.map(r => (
            <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px', background: '#0f1117', border: '1px solid #2a2f45', borderRadius: 7 }}>
              <span style={{ fontSize: 13, color: '#e8eaf0' }}>{r.label}</span>
              <span style={{ fontSize: 11, color: '#3d4258', fontFamily: 'monospace' }}>{r.pattern}</span>
            </div>
          ))}
        </div>
      </Card>

      {/* Save */}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={savePrefs} style={{ ...primaryBtnStyle, minWidth: 140 }}>
          {saved ? 'Saved &#10003;' : 'Save Preferences'}
        </button>
      </div>

      {/* Microsoft Connection */}
      <Card>
        <h3 style={{ margin: '0 0 14px', fontSize: 13, fontWeight: 600, color: '#3AAFA9', textTransform: 'uppercase', letterSpacing: '0.8px' }}>Microsoft Connection</h3>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <p style={{ margin: '0 0 4px', fontSize: 14, color: '#e8eaf0' }}>{connected ? 'Connected to Microsoft 365' : 'Not connected'}</p>
            <p style={{ margin: 0, fontSize: 12, color: '#6b7280' }}>{connected ? 'Your email and calendar are syncing.' : 'Connect to access email and calendar data.'}</p>
          </div>
          {connected && <button onClick={disconnect} style={{ padding: '8px 14px', background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontFamily: "'DM Sans', sans-serif" }}>Disconnect</button>}
        </div>
      </Card>

      {/* About */}
      <Card>
        <h3 style={{ margin: '0 0 14px', fontSize: 13, fontWeight: 600, color: '#3AAFA9', textTransform: 'uppercase', letterSpacing: '0.8px' }}>About</h3>
        <p style={{ margin: 0, fontSize: 13, color: '#6b7280', lineHeight: 1.6 }}>
          Qurate Admin Agent v1.0<br />
          Stack: Next.js, Supabase, Microsoft Graph, Claude API (Haiku + Sonnet)
        </p>
      </Card>
    </div>
  )
}

// ─── MAIN DASHBOARD ───────────────────────────────────────────────────────────
export default function Dashboard() {
  const [tab, setTab]           = useState<'briefing'|'email'|'calendar'|'matrix'|'clients'|'chat'|'settings'>('briefing')
  const [emails, setEmails]     = useState<Email[]>([])
  const [events, setEvents]     = useState<CalendarEvent[]>([])
  const [tasks, setTasks]       = useState<EisenhowerTask[]>([])
  const [emailLoading, setEmailLoading] = useState(false)
  const [connected, setConnected] = useState(true)

  const loadEmails = useCallback(async () => {
    setEmailLoading(true)
    try {
      const token = await getMsToken()
      if (!token) { setEmailLoading(false); return }
      const r = await fetch('https://graph.microsoft.com/v1.0/me/messages?$top=50&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,bodyPreview,isRead', { headers: { Authorization: `Bearer ${token}` } })
      const data = await r.json()
      if (data.value) setEmails(data.value)
    } catch (e) { console.error('Email load error:', e) }
    setEmailLoading(false)
  }, [])

  const loadCalendar = useCallback(async () => {
    try {
      const res  = await authFetch(`${SUPABASE_FUNCTIONS_URL}/ms-calendar`)
      const data = await res.json()
      if (data.events) setEvents(data.events)
      else if (Array.isArray(data)) setEvents(data)
    } catch (e) { console.error('Calendar load error:', e) }
  }, [])

  const loadTasks = useCallback(async () => {
    try {
      const res  = await fetch(`${SUPABASE_URL}/rest/v1/eisenhower_tasks?select=*&status=neq.done&order=created_at.desc`, { headers: { apikey: ANON_KEY } })
      const data = await res.json()
      if (Array.isArray(data)) setTasks(data)
    } catch (e) { console.error('Tasks load error:', e) }
  }, [])

  useEffect(() => { loadEmails(); loadCalendar(); loadTasks() }, [loadEmails, loadCalendar, loadTasks])

  const unread       = emails.filter(e => !e.isRead).length
  const todayEvtCount = events.filter(e => (e.start?.dateTime || e.start?.date) && localDateKey(evtStart(e)) === localDateKey(new Date())).length

  return (
    <div style={{ minHeight: '100vh', background: '#0f1117', fontFamily: "'DM Sans', sans-serif" }}>
      <div style={{ background: '#1a1d27', borderBottom: '1px solid #2a2f45', padding: '0 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 56, position: 'sticky', top: 0, zIndex: 100 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 28, height: 28, background: 'linear-gradient(135deg, #3AAFA9, #C9A96E)', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, color: '#fff' }}>Q</div>
          <span style={{ fontSize: 15, fontWeight: 600, color: '#e8eaf0' }}>Admin Agent</span>
        </div>
        <div style={{ display: 'flex', gap: 2, overflowX: 'auto' }}>
          <TabBtn active={tab === 'briefing'} onClick={() => setTab('briefing')}>Briefing</TabBtn>
          <TabBtn active={tab === 'email'}    onClick={() => setTab('email')}>Email{unread > 0 ? ` (${unread})` : ''}</TabBtn>
          <TabBtn active={tab === 'calendar'} onClick={() => setTab('calendar')}>Calendar{todayEvtCount > 0 ? ` (${todayEvtCount})` : ''}</TabBtn>
          <TabBtn active={tab === 'matrix'}   onClick={() => setTab('matrix')}>Matrix{tasks.filter(t => t.quadrant === 'do').length > 0 ? ` (${tasks.filter(t => t.quadrant === 'do').length})` : ''}</TabBtn>
          <TabBtn active={tab === 'clients'}  onClick={() => setTab('clients')}>Clients</TabBtn>
          <TabBtn active={tab === 'chat'}     onClick={() => setTab('chat')}>Chat</TabBtn>
          <TabBtn active={tab === 'settings'} onClick={() => setTab('settings')}>Settings</TabBtn>
        </div>
        <div style={{ fontSize: 12, color: '#6b7280' }}>{new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}</div>
      </div>

      <div style={{ padding: '24px', maxWidth: 1200, margin: '0 auto' }}>
        {tab === 'briefing'  && <BriefingTab events={events} tasks={tasks} emails={emails} />}
        {tab === 'email'     && <EmailTab emails={emails} loading={emailLoading} onRefresh={loadEmails} />}
        {tab === 'calendar'  && <CalendarTab events={events} />}
        {tab === 'matrix'    && <MatrixTab tasks={tasks} onRefresh={loadTasks} />}
        {tab === 'clients'   && <ClientsTab emails={emails} tasks={tasks} />}
        {tab === 'chat'      && <ChatTab />}
        {tab === 'settings'  && <SettingsTab connected={connected} onDisconnect={() => { setConnected(false); window.location.href = '/' }} />}
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #2a2f45; border-radius: 3px; }
      `}</style>
    </div>
  )
}
