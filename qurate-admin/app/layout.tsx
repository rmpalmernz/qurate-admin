import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Qurate Admin Agent',
  description: 'AI-powered executive administration dashboard for M&A advisory',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet" />
        {/* Viewport — must come first for mobile */}
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        {/* PWA meta tags */}
        <meta name="theme-color" content="#3AAFA9" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Qurate" />
        <meta name="mobile-web-app-capable" content="yes" />
        {/* Manifest and icons */}
        <link rel="manifest" href="/manifest.json" />
        <link rel="apple-touch-icon" href="/icons/icon-192.png" />
        <link rel="icon" type="image/svg+xml" href="/icons/icon.svg" />
      </head>
      <body>{children}</body>
    </html>
  )
}
