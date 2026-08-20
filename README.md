# Loser Survivor

A private NFL "loser survivor" pool. Each entrant is provisioned a number of **picks**; every
week, each surviving pick is assigned to one team the entrant thinks will **lose**. A pick on a
team that wins *or ties* is eliminated permanently. Last entrant with a live pick wins.

Built to `SPEC.md`, one phase at a time.

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Scaffold, schema + migrations, `LEAGUE_CONFIG`, admin provisioning, seed | **complete** |
| 2 | Rules engine, auto-assignment, validation, end-of-season logic | **complete** |
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
lib/rules/       §5 grading, auto-assignment, validation; §6 end of season — pure, no I/O
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

## The rules engine (§5, §6)

`lib/rules/` is pure: no I/O, no clock, no randomness. `now` is an input where time
matters. Database rows are structurally assignable to the engine's types, so Phase 3 can feed
it query results with no mapping layer — `tests/rules/row-compatibility.test.ts` fails the
typecheck if that ever stops being true.

| Function | Spec | Does |
|---|---|---|
| `gradeWeek` | §5.1 | Grades every selection in a week |
| `autoAssignWeek` | §5.2 | Resolves alive slots that missed the deadline |
| `validateSelection` | §5.3 | Server-side submit validation |
| `evaluateSeasonEnd` | §6 | Decides champion / co-champions / next week / pending admin |

### Decisions taken in Phase 2

- **A week grades whole or not at all.** §5.1 says a postponed game means the week "cannot be
  graded yet", so `gradeWeek` returns `canGrade: false` with `blockedBy` naming the offending
  games and both update lists empty. Nothing is half-applied.
- **Idempotence comes from diffing, not from a flag.** An update is emitted only where the
  computed outcome differs from what the row already says, and a slot update only where the slot
  is still alive. A second run over the first run's output returns empty lists and records no
  audit entry (test 14).
- **`auto_underdog` uses the worst record among the teams playing** — fewest wins, then most
  losses, then team id for determinism. v1 has no betting odds by design (§12), so this is a
  proxy rather than a probability, and it is the one function to replace if the league ever
  wants real odds. Calling it without standings throws rather than guessing.
- **"Previous played week" skips voided selections as well as skipped weeks.** §5.2 says to skip
  "any `skipped` or `void` weeks"; a selection voided by a canceled game is not a decision anyone
  made, so the lookup reaches further back for a real one.
- **`validateSelection` takes more than §5.3 lists.** The spec's input list cannot perform the
  spec's own checks — rejecting a locked week needs the week's status and `lock_at`, and
  rejecting someone else's slot needs the requesting user. Added: `week`, `requestingUserId`,
  `user`, `now`.
- **Validation returns badges on success.** §5.3 requires team reuse and two-slots-one-team to be
  surfaced but never blocked, so `{ ok: true, info: [...] }` carries them to the UI.
- **`evaluateSeasonEnd` needs the entrants who were alive *entering* the week**, not just those
  alive after it — the wipeout rule crowns exactly that set (test 19).
- **`tieResult` is handled by an exhaustive switch**, so adding a second value to the union is a
  compile error rather than a silent fall-through to "survived".

## Acceptance tests

Tests 1–21 pass (§13). Coverage by file:

| Tests | Where |
|---|---|
| 1, 2, 14, 15, 16 | `tests/rules/grade.test.ts` |
| 3, 4, 5, 6, 7 (submit) | `tests/rules/validate.test.ts` |
| 10, 11, 12, 13, 20, 21 | `tests/rules/auto-assign.test.ts` |
| 17, 18, 19 | `tests/rules/season.test.ts` |
| 7 (slots), 8, 9 | `tests/provisioning.test.ts` |
| 20, 21 (ordering) | `tests/week-ordinal.test.ts`, `tests/seed.test.ts` |

Tests 22–30 cover the API and audit log, and arrive with Phases 5 and 6.

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
