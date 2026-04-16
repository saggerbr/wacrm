# WaCRM — WhatsApp CRM

A self-hosted CRM for WhatsApp Business, built on Next.js 16 (App Router) and Supabase.

## Features

- **Inbox** — real-time WhatsApp conversations with reply, status tracking, and a 24-hour session timer
- **Contacts** — CRUD with tags, custom fields, notes, and CSV import
- **Broadcasts** — 4-step wizard to send approved templates to an audience (all contacts / tag-filtered / CSV upload)
- **Pipelines** — Kanban board for deals linked to contacts and conversations
- **Dashboard** — analytics overview (contacts, open conversations, messages today, active deals)
- **Media** — inbound images/video/audio/documents proxied through the app so they stay authenticated
- **Auth & RLS** — Supabase Auth with row-level security; encrypted Meta access tokens at rest (AES-256-CBC)

## Stack

- **Next.js 16** (App Router, Server Components, Route Handlers)
- **TypeScript**
- **Supabase** (Postgres + Auth + Realtime)
- **Tailwind CSS + shadcn/ui** (Radix primitives)
- **Meta WhatsApp Cloud API** (`graph.facebook.com/v21.0`)

## Project layout

```
src/
├── app/
│   ├── (auth)/              # login, signup, forgot-password
│   ├── (dashboard)/         # protected CRM pages
│   │   ├── inbox/
│   │   ├── contacts/
│   │   ├── broadcasts/
│   │   ├── pipelines/
│   │   ├── dashboard/
│   │   └── settings/
│   └── api/whatsapp/        # Meta integration endpoints
│       ├── config/          # save / test credentials
│       ├── webhook/         # Meta webhook receiver
│       ├── send/            # outbound text/media
│       ├── broadcast/       # bulk template send
│       └── media/[mediaId]/ # auth proxy for inbound media
├── components/              # UI by feature area
├── hooks/                   # auth provider, realtime, broadcast sending
├── lib/
│   ├── supabase/            # browser + server clients
│   └── whatsapp/            # Meta API helpers, encryption, phone utils
├── middleware.ts            # auth + protected-route redirect
└── types/
supabase/
└── migrations/              # SQL schema, RLS, triggers, realtime
```

## Setup

### 1. Prerequisites

- Node.js 18+
- A Supabase project (free tier works)
- A Meta developer app with the WhatsApp Business product enabled

### 2. Clone and install

```bash
git clone https://github.com/ArnasDon/wacrm.git
cd wacrm
npm install
```

### 3. Create the database schema

Run `supabase/migrations/001_initial_schema.sql` against your Supabase project:

- **Dashboard:** paste into SQL Editor → Run
- **CLI:** `supabase db push` (if linked)
- **GitHub integration:** Supabase will apply automatically on push to `main`

The migration is idempotent — safe to re-run.

### 4. Configure environment variables

Copy the example and fill in:

```bash
cp .env.local.example .env.local
```

```
NEXT_PUBLIC_SUPABASE_URL=https://<your-project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key from Supabase Settings → API>
SUPABASE_SERVICE_ROLE_KEY=<service role key — used by webhook, keep secret>
ENCRYPTION_KEY=<64-char hex string>
```

Generate the encryption key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> **Important:** use the **same** `ENCRYPTION_KEY` across every environment (local, Vercel, Hostinger). Tokens encrypted with one key can't be decrypted with another — that's why the reset flow in Settings exists to recover from mismatched keys.

### 5. Run locally

```bash
npm run dev
```

Open http://localhost:3000 and sign up. A profile row is auto-created via the `handle_new_user` trigger.

## Meta WhatsApp setup

1. Go to **Meta Developer Portal** → your app → **WhatsApp** → **API Setup**
2. Copy your **Phone Number ID** and **WhatsApp Business Account ID**
3. Create a **System User Permanent Access Token** (Business Settings → System Users)
4. In the CRM: **Settings → WhatsApp Config** → paste credentials → **Save Configuration**
5. The **Webhook Callback URL** is shown on the same page — copy it
6. Meta Developer Portal → **WhatsApp → Configuration → Webhook** → paste the callback URL, set the **Verify Token** to the same one you entered in the CRM, click **Verify and save**
7. Subscribe to the **`messages`** field (required for inbound messages to arrive)

### Sandbox note

While your app is in sandbox, Meta only delivers to pre-registered test numbers. The CRM auto-retries sends with phone-number variants (inserting/removing a trunk `0` after the country code) to compensate for format mismatches against Meta's allowed list.

## Deployment

### Vercel (recommended)

1. Import the repo on Vercel
2. Add the four env vars under **Settings → Environment Variables**
3. Deploy — Next.js middleware and API routes just work

### Other platforms

Any host that supports a long-running Node.js server will work (Render, Fly, a VPS, etc.). Static-only hosts will **not** — the webhook, media proxy, and auth middleware all require a Node runtime.

## Architecture notes

### Why an options object for Meta helpers

Every Meta API helper (`sendTextMessage`, `verifyPhoneNumber`, `getMediaUrl`, etc.) takes a single `{ ... }` options object instead of positional arguments. Positional args with the same type (`string`) let TypeScript happily accept swapped calls — that bug hit four separate routes during development. Named params make it a compile-time error.

### Why the media proxy

Meta's media CDN URLs are short-lived and require the Bearer token. We can't put them straight into `<img src>`. `/api/whatsapp/media/[mediaId]` authenticates the request, resolves the media ID with Meta, downloads the binary, and streams it back with the correct `Content-Type`. The DB only stores the proxy URL, so it stays valid indefinitely.

### Why the phone-variant retry

Meta's sandbox sometimes stores a recipient's number with a domestic trunk prefix (e.g. Lithuanian `+37063949836` registered as `370063949836`). On send, if Meta returns `#131030 "not in allowed list"`, the route retries with a `0` inserted/removed after the country code. If one wins, the contact's stored phone is updated to the working format so the next send is a single API call.

### Why we use getSession() on the client

`supabase.auth.getUser()` makes a network round-trip to Supabase. Calling it on every page mount meant ~300ms of latency per navigation, plus lock contention across components. The dashboard uses a single `AuthProvider` Context that calls `getSession()` (localStorage read, synchronous inside the SDK) once. API routes and middleware still use `getUser()` because those are the real authorization boundaries; the client is only deciding what UI to show.

## License

Private — not licensed for redistribution.
