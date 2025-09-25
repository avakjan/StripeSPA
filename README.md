## Stripe SPA - Setup and Security Notes

### Setup
- Requirements: Node 18+, Stripe account, Stripe CLI (optional for local webhooks)
- Install deps: `npm i`
- Create a `.env` file:
```
STRIPE_SECRET_KEY=sk_test_xxx
STRIPE_PUBLISHABLE_KEY=pk_test_xxx
ADMIN_USER=change-me
ADMIN_PASS=change-me
ADMIN_KEY=your-secret-admin-key
STRIPE_WEBHOOK_SECRET=whsec_xxx
PORT=4242
DATABASE_URL=postgres://USER:PASSWORD@HOST:PORT/DBNAME
DATABASE_SSL=true
```
- Start: `npm start`
- Admin UI: `http://localhost:4242/admin.html` (Basic Auth + optional `x-admin-key` for inventory writes)

### Webhooks (local)
- Run: `stripe listen --forward-to http://localhost:4242/webhook`
- Copy the signing secret and set `STRIPE_WEBHOOK_SECRET` in `.env`, then restart.

### Security Checklist (before pushing to GitHub)
- Secrets in code:
  - No secrets should be hardcoded in source. All keys come from `.env`.
  - `.env` is gitignored via `.gitignore`.
- Database:
  - Managed Postgres via `DATABASE_URL` (Neon/Supabase/Render/Railway). The server creates tables on boot.
- Admin UI:
  - Protect `admin.html` with `ADMIN_USER`/`ADMIN_PASS` (basic auth). Keep strong values in `.env`.
  - Inventory writes require `x-admin-key` matching `ADMIN_KEY`.
- Webhook security:
  - Set `STRIPE_WEBHOOK_SECRET` and keep it private.
- CORS / Exposure:
  - This sample serves static files and API on the same origin; avoid exposing admin in public deployments or add network restrictions.
