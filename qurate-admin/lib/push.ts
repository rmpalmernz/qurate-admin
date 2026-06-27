'use client'

// Client-side Web Push helpers (Epic C foundation).
// The service worker (public/sw.js) handles the `push` + `notificationclick` events;
// this module registers the browser subscription and persists it via /api/push/subscribe.

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || ''

export type PushState = 'unknown' | 'unsupported' | 'denied' | 'subscribed' | 'unsubscribed'

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

export async function pushStatus(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  try {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    return sub ? 'subscribed' : 'unsubscribed'
  } catch {
    return 'unsubscribed'
  }
}

// Requests permission, subscribes via the VAPID key, and saves the subscription server-side.
// iOS note: only works when the PWA is installed to the home screen (iOS 16.4+).
export async function enablePush(): Promise<{ ok: boolean; error?: string }> {
  if (!pushSupported()) return { ok: false, error: 'Push not supported on this device/browser. On iPhone, install the app to your home screen first.' }
  if (!VAPID_PUBLIC_KEY) return { ok: false, error: 'VAPID public key not configured (NEXT_PUBLIC_VAPID_PUBLIC_KEY).' }

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return { ok: false, error: 'Notification permission was not granted.' }

  const reg = await navigator.serviceWorker.ready
  let sub = await reg.pushManager.getSubscription()
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    })
  }

  const res = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: sub.toJSON(), userAgent: navigator.userAgent }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, error: `Could not save subscription (${res.status}). ${text}`.trim() }
  }
  return { ok: true }
}
