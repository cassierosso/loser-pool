# Deployment

Everything here needs an account or a credential, so it is written as steps for you to run
rather than something the app can do for itself.

## 1. Database (Neon)

Create a Neon project. From the dashboard copy the **connection string** — it looks like
`postgresql://user:password@ep-something.us-east-2.aws.neon.tech/neondb?sslmode=require`.

Put it in `.env.local`, which is gitignored. **Do not paste it into a chat, a commit, or an
issue** — it contains a password.

```
DATABASE_URL_MIGRATOR=postgresql://…   # the owner; runs migrations
DATABASE_URL=postgresql://…            # what the app connects as
```

Then apply the schema:

```bash
npm run db:migrate
```

You do **not** need Neon Auth, Neon Identity, or any other add-on. Authentication is §10's
passwordless magic link, implemented in `lib/auth/` — Neon Auth would bring a second identity
system and a second users table to fight with `app_user`.

### The restricted role (§7.3 layer 2)

Migration `0004` creates a `loser_survivor_app` role holding `INSERT, SELECT` on `audit_log` and
nothing else, so the application cannot update or delete an audit entry even if it tried. To
actually get that protection the app must *connect* as that role, which needs a password Neon
does not set for you:

```sql
ALTER ROLE loser_survivor_app WITH LOGIN PASSWORD 'something-long-and-random';
GRANT USAGE ON SCHEMA public TO loser_survivor_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO loser_survivor_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO loser_survivor_app;
-- audit_log stays INSERT/SELECT only; 0004 already revoked the rest.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM loser_survivor_app;
```

Then point `DATABASE_URL` at that role and leave `DATABASE_URL_MIGRATOR` as the owner. **Skipping
this still leaves the append-only trigger in place**, which refuses updates and deletes for
everyone including the owner — the role is defence in depth, not the only defence.

## 2. Vercel

Import the repository. Set these environment variables:

| Variable | Value |
|---|---|
| `DATABASE_URL` | the restricted role's connection string |
| `DATABASE_URL_MIGRATOR` | the owner's connection string |
| `APP_URL` | `https://your-app.vercel.app` — used in magic links |
| `CRON_SECRET` | `openssl rand -hex 32` |
| `RESEND_API_KEY` | from resend.com |
| `MAIL_FROM` | `Loser Survivor <noreply@yourdomain>` |
| `GITHUB_TOKEN` | fine-grained token, `contents: write` on this repo |
| `GITHUB_REPOSITORY` | `cassierosso/loser-pool` |

Resend only delivers to arbitrary addresses from a **verified domain**. Without one it will send
only to the account owner's own address, which means magic links never reach the league.

## 3. GitHub Actions

Add two repository secrets (Settings → Secrets and variables → Actions):

- `APP_URL` — the same value as above
- `CRON_SECRET` — **the same string** as in Vercel, or every job returns 401

The workflows in `.github/workflows/` then run the §8 schedule. Each can also be run by hand from
the Actions tab, and every job is idempotent, so a manual run alongside a scheduled one is safe.

Two things about GitHub cron worth knowing: it is **UTC with no daylight saving**, which is why
the `syncResults` windows are widened rather than exact; and scheduled runs are **best effort**
and can be delayed under load. Nothing depends on punctuality — `lockWeek` decides for itself
whether a week is due, and late locking cannot let anyone submit late, because
`validateSelection` refuses on the deadline regardless of which jobs have run.

Actions also **disables schedules on repositories with no activity for 60 days**. In an off-season
that will happen. Re-enable them before Week 1.

## 4. First admin

There is no way to promote yourself through the UI, by design. Seed the first admin directly:

```bash
npm run provision -- add-user --email you@example.com --name "Your Name" --reason "First admin"
```

then set `role = 'admin'` on that row once, in the database. Every later role change goes through
the admin panel and is logged.

## 5. Check it works

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://your-app.vercel.app/api/jobs/syncSchedule
```

Then sign in, open **League Log**, and confirm the chain badge is green. That badge is the thing
to look at after any deploy: it verifies the whole log on every League Board load.
