# Loser Survivor

A private NFL "loser survivor" pool. Each entrant is provisioned a number of **picks**; every
week, each surviving pick is assigned to one team the entrant thinks will **lose**. A pick on a
team that wins *or ties* is eliminated permanently. Last entrant with a live pick wins.

Built to `SPEC.md`, one phase at a time.

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Scaffold, schema + migrations, `LEAGUE_CONFIG`, admin provisioning, seed | **complete** |
| 2 | Rules engine, auto-assignment, validation, end-of-season logic | not started |
| 3 | ESPN provider + the four jobs | not started |
| 4 | Auth and Make Picks | not started |
| 5 | League Board, Week Results, My Picks History | not started |
| 6 | Audit log end to end, then the admin panel | not started |
| 7 | Deploy, cron, prior-season dry run | not started |

## Getting started

```bash
npm install
cp .env.example .env.local
npm run db:seed      # migrates, then seeds a full fixture season
npm run dev
```

No database server is required. `DATABASE_URL` defaults to embedded
[PGlite](https://pglite.dev) (Postgres 16 compiled to WASM) at `./.pglite`. Point it at a real
Postgres and everything switches over — the SQL and the migrations are identical:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/loser_survivor
```

`docker-compose.yml` is provided for a local server; Neon needs only the connection string.

### Scripts

| Command | What it does |
|---|---|
| `npm run db:migrate` | Apply checked-in migrations (idempotent) |
| `npm run db:seed` | Truncate, migrate, and seed the fixture season |
| `npm run db:reset` | Delete every row |
| `npm run test` | Vitest, against throwaway in-memory databases |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run provision -- roster` | The §4 admin reconciliation table |

### Seeding options

```bash
npm run db:seed                    # results through week 10 (default)
npm run db:seed -- --through 18    # whole regular season
npm run db:seed -- --through 23    # complete season including the Super Bowl
npm run db:seed -- --no-anomalies  # omit the canceled and postponed games
```

`--through` takes a `display_ordinal`: 1–18 regular season, 19–23 postseason. Weeks before it
are graded, the week itself is locked and awaiting grading, the next one is open.

The seed is deterministic — same PRNG seed, same schedule, same scores, same picks on every run.

### Provisioning

Payment is collected offsite, so pick slots are created by an admin action, never at signup
(§4). Until Phase 4 brings auth, that action lives on the CLI and calls the same service
functions the Phase 6 admin panel will:

```bash
npm run provision -- add-user --email dave@example.com --name "Dave" --reason "Joined"
npm run provision -- set-picks --email dave@example.com --picks 8 --reason "Paid $80 Venmo"
npm run provision -- set-payment --email dave@example.com --status paid --note "$80 Venmo 9/3" --reason "Recording payment"
```

Every mutating command requires a non-empty `--reason`, rejected server-side rather than in the
client (§7.6). After `picksFrozenAt`, changes additionally require `--override`.

## Layout

```
lib/config/      LEAGUE_CONFIG: the single source of truth for every setting and default
lib/db/schema/   Drizzle schema, one file per table
lib/week/        Week identity and ordering (§2.1, §3.1) — pure, no I/O
lib/admin/       §4 provisioning services
lib/audit/       The §7 port that Phase 6 implements
scripts/seed/    Fixture season generator
drizzle/         Checked-in migrations
tests/           Vitest
```

## Decisions taken in Phase 1

Things the spec left open, or that the environment forced. Each is annotated in the code.

- **`week_state` carries `season_year`.** The spec's field list omits it while `game` has it, and
  Phase 7 replays a completed prior season. Without it two seasons of week rows collide.
  `selection` and `game` key on `week_state_id` rather than `(season_type, week_number)`, which
  is the spec's constraint with the year folded in.
- **`display_ordinal` runs 1–23:** regular 1–18, Wild Card 19, Divisional 20, Conference 21,
  **Pro Bowl 22 (`skipped`)**, Super Bowl 23. The Pro Bowl gets a real row holding a real ordinal
  so "the previous played week" steps over it by status rather than by arithmetic. §3.1 numbering
  is **unverified** — Phase 3 must confirm it against a recorded scoreboard fixture.
- **Eliminated slots count toward `picks_purchased`.** The invariant is
  `count(pick_slot) == picks_purchased` all season; alive/eliminated counts are always derived.
- **Slot numbers are never reused or renumbered.** A reduction removes the highest-numbered
  *removable* slots (alive, zero selections) and leaves gaps — Pick 1, Pick 2, Pick 5 is a legal
  state — so a slot's history never shifts under it.
- **Config enums contain only values the spec names.** `lockPolicy` includes `per_game` because
  §5.3 references it. Single-member unions (`teamReuse`, `tieResult`, `missedPick`,
  `finalTieRule`) get widened when a phase needs a second value rather than inventing options now.
- **`requireSecondAdminForSelfActions`** (§7.6) is in `LEAGUE_CONFIG` though the §0 table omits it.
- **Two connection strings from the start.** `DATABASE_URL` (app) and `DATABASE_URL_MIGRATOR`
  (owner). §7.3 requires the app to run as a restricted role that cannot `UPDATE`/`DELETE`
  `audit_log`; separating them now means that migration is not a plumbing retrofit.
- **Users are deactivated, never deleted**, so audit entries and pick slots keep resolving to a
  real person.
- **No auth tables yet.** Phase 4 picks the magic-link approach and adds its own migration rather
  than having one guessed into the initial one.
- **America/Chicago** (§11) is a single exported constant, not a `LEAGUE_CONFIG` key, since §0
  does not list it.

## Deferred deliberately

- **The §7 audit log is Phase 6**, by decision. Provisioning already emits fully formed audit
  events through `lib/audit/port.ts`; Phase 1 discards them. Phase 6 implements that one
  interface over the hash-chained insert-only writer and changes nothing in `lib/admin`.
  Acceptance test 9's rejection is covered now; its audit-entry assertion arrives with test 23.
- The seed applies §5.1 outcomes directly to fixture selections to produce a realistic mix of
  graded weeks and live entrants. **That shortcut is not the rules engine** and must not grow
  into one — it handles only win/loss/tie/canceled. Phase 2 owns `gradeWeek()`.

## Known issues

- `npm audit` reports 4 moderate advisories, all in `drizzle-kit`'s `@esbuild-kit` dev
  dependency chain. Dev-only, and `npm audit fix --force` downgrades `drizzle-kit` past a major
  version, so they are left alone.
