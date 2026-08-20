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
| 3 | ESPN provider + the four jobs | **complete** |
| 4 | Auth and Make Picks | **complete** |
| 5 | League Board, Week Results, My Picks History | not started |
| 6 | Audit log end to end, then the admin panel | not started |
| 7 | Deploy, cron, prior-season dry run | not started |

## Getting started

```bash
npm install
cp .env.example .env.local     # then set DATABASE_URL (see below)
npm run db:seed                # migrates, then seeds a full fixture season
npm run dev
```

Sign in at `/signin` with any seeded address — `dana@example.com` is the admin. There is no
password: the magic link is **printed to the terminal** by the console mailer, so local
development needs no email account, no API key, and no verified domain.

### The database

**Use a real Postgres.** `DATABASE_URL` is a normal connection string:

```
DATABASE_URL=postgres://user@localhost:5432/loser_survivor
```

If you have no Postgres, `npm run db:serve` gives you one with nothing to install — it hosts an
embedded PGlite database over the real Postgres wire protocol on port 5432, and accepts any
username and password.

> **Do not point the app directly at a `pglite://` path.** PGlite is a *single-process* embedded
> database. It works fine for scripts and tests, but the Next dev server opens it more than once
> — hot reload, plus separate bundles for server components and route handlers — and the WASM
> instance aborts. The failure is nasty rather than obvious: a row written by one request reads
> back as missing from the next, so a freshly issued magic link reports "not valid". That is what
> `db:serve` exists to prevent.

Tests are unaffected: each suite builds its own **in-memory** PGlite, one instance per process,
which is fast and perfectly isolated. Migrations are plain Postgres and have been applied to both
PGlite and PostgreSQL 15 with identical results.

### Scripts

| Command | What it does |
|---|---|
| `npm run db:migrate` | Apply checked-in migrations (idempotent) |
| `npm run db:seed` | Truncate, migrate, and seed the fixture season |
| `npm run db:reset` | Delete every row |
| `npm run test` | Vitest, against throwaway in-memory databases |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run provision -- roster` | The §4 admin reconciliation table |
| `npm run job -- <name>` | Run a §8 job by hand |
| `npm run db:serve` | Local Postgres with nothing to install |

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
lib/providers/   §3 the ESPN provider — the only code that knows its response shape
lib/jobs/        §8 the four jobs, as plain functions over a JobContext
fixtures/espn/   Recorded real ESPN responses; tests never call the network
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

## External data and jobs (§3, §8)

### §3.1 postseason numbering — CONFIRMED

The spec said not to trust the postseason week numbers from memory, and to check them against a
real recorded response. Done, against the completed 2024 season. **The spec's numbering is
correct exactly as written:**

| `seasontype=3` week | Round | Games |
|---|---|---|
| 1 | Wild Card | 6 |
| 2 | Divisional | 4 |
| 3 | Conference Championship | 2 |
| **4** | **Pro Bowl Games** | 1 — never opened, never graded |
| 5 | Super Bowl | 1 |

There is a second, independent reason to skip week 4 that the spec doesn't mention: the Pro Bowl's
two "teams" are ESPN ids **31 (AFC)** and **32 (NFC)**, which are not NFL franchises. Even if the
week were synced, no game could be inserted — those ids match nothing in the `team` table. The
sync skips unknown team ids and reports a warning rather than inventing rows.

### Things about ESPN worth knowing

All confirmed against recorded responses, not documentation — there isn't any.

- **ESPN returns 403 to any request with no `User-Agent`.** Node's `fetch` sends none by default,
  so this works from curl and fails from a server. Found by running the job against the live API;
  no fixture could have caught it. `lib/providers/espn.ts` sets one, and a test asserts it.
- **Scores are strings** (`"36"`, not `36`).
- **A canceled game reports `state: "post"` with `completed: false`.** Mapping `state === "post"`
  to final would mark a game that never happened as finished and grade picks against it, so
  `status.type.name` is checked first.
- **Overtime finals are `STATUS_FINAL` with `detail: "Final/OT"`**, not a distinct status name.
- **`/teams` carries no conference or division.** The provider leaves those undefined and the sync
  preserves what it already holds, rather than overwriting with null.
- The 32 team ids, abbreviations, names, and logo URLs in `fixtures/teams.json` — hand-written in
  Phase 1 — were **verified against the live `/teams` response and all 32 match exactly**.

### Fixtures

`fixtures/espn/` holds real recorded responses: the full 2024 postseason (weeks 1–5), a 2024
regular-season week, a real tie (2022 week 1, IND @ HOU 20–20), and a real cancellation
(2022 week 17, BUF @ CIN).

One file is **synthetic and says so in its own `_note` field**:
`scoreboard-2022-reg-week17-postponed-SYNTHETIC.json`. A postponed game cannot be recorded from
history — ESPN rewrites the event to `STATUS_FINAL` once it is replayed — so that one status is
reproduced by hand-editing a real response.

### Running jobs

```bash
npm run job -- syncSchedule
npm run job -- syncResults --ordinal 10
npm run job -- lockWeek
npm run job -- gradeWeek --ordinal 10
```

Or over HTTP, which is what the Phase 7 cron will hit:

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/jobs/syncSchedule
```

The endpoint **fails closed**: if `CRON_SECRET` is unset it refuses everything with 503 rather
than running unauthenticated, and a job that could not complete returns 409 so a cron run goes
visibly red instead of returning a 200 nobody reads.

### Decisions taken in Phase 3

- **`season_status` and `season_outcome` added to `league`** (migration `0001`). §6's outcomes had
  nowhere to live — a closed season, a set of co-champions, and the frozen `pending_admin` state
  all need to survive a restart.
- **Auto-assigned selections record the slot's owner as `submitted_by_user_id`.** Nobody submitted
  them, but the column is `NOT NULL` and the row must still resolve to a person in history and in
  the audit log; `was_auto_assigned` is what marks them as the system's doing.
- **Locking a week *is* the reveal.** There is no `hidden` column: selection visibility is derived
  from the week's status at query time, which is what makes acceptance test 22 achievable — other
  entrants' picks are absent from the response before lock, not merely hidden in the UI.
- **A completed game with no winner flag but unequal scores is not treated as a tie.** That is ESPN
  being inconsistent; the winner is derived from the scoreboard, because recording a tie would
  eliminate every pick on both teams.
- **`gradeWeek` only opens a week that is still `upcoming`**, so a re-run can never reopen a week
  that has already been played.

## Auth and Make Picks (§10, §9)

### Auth

Passwordless magic links, implemented directly rather than with a library: Auth.js v5 is still
beta, v4 predates the App Router, and Lucia is deprecated in favour of exactly this approach.

- **Neither table stores a usable credential.** `login_token` and `session` hold only
  `sha256(token)`. The raw value exists in the emailed URL and in the cookie, nowhere else, so a
  database dump yields nothing anyone can sign in with.
- Links are **single-use and expire in 15 minutes**, and single use is enforced by the database —
  the `UPDATE` matches only unconsumed rows, so two simultaneous clicks cannot both win. Signing
  in also invalidates any other outstanding links for that account.
- The sign-in form **does not reveal who is in the league**: an unknown address with no invite
  code gets the same "if that address belongs to the league…" response as a real member. A wrong
  *invite code* is reported, because someone typing one needs to know they mistyped it.
- Session cookies are `httpOnly`, `sameSite=lax`, and `secure` outside development.
- Joining with the league invite code creates an account with **`picks_purchased = 0`** (§4) —
  an account, not picks. An admin provisions those once they have seen the money.

Email goes through a small `Mailer` port: the console in development, Resend when
`RESEND_API_KEY` and `MAIL_FROM` are set. Phase 6b's weekly digest will use the same interface.

### Make Picks

Entrants think in totals, not in slots — *"I have five picks, put two on Dallas"* — so the screen
is one list of the week's games with a **+/− stepper on every team** and a running budget at the
top: `5/10 picks placed · 5 still spare`. Confirming shows the full recap:

```
2 × Arizona Cardinals to LOSE (a tie eliminates)
2 × Seattle Seahawks   to LOSE (a tie eliminates)
1 × Tampa Bay Buccaneers to LOSE (a tie eliminates)
5 picks placed across 3 teams.
5 picks left spare. At lock they would repeat last week's team where it is playing.
```

The copy works hard on the one rule everyone gets wrong: you are picking teams **to lose**, and a
tie kills the pick too. It appears on the heading, on every allocated team, and again in the recap.

**Which slot gets which team is decided on the server**, in `lib/picks/allocate.ts`. That is not an
implementation detail: a `pick_slot` is a persistent entity with its own history, and §5.2 repeats
*that slot's* last team when someone misses a deadline. The rule is minimum churn — a slot already
holding a team that is still allocated keeps it, and only genuinely new picks land on free slots.
Re-submitting an identical allocation therefore changes nothing and logs nothing. Reducing a count
removes the surplus pick, and that slot is simply blank again.

A useful consequence: **the request contains no slot id at all**, only counts per team. There is
nothing in it to aim at another entrant's slots.

Other behaviour:

- A live countdown to lock; once it passes, the form says so and refuses to submit.
- Teams not playing this week are absent, so a team on bye cannot be chosen.
- Each game is headed by the matchup and its kickoff time — *Green Bay Packers vs New York
  Giants · SUN, NOV 17, 11:00 AM CST* — with the away team first, so the boxes below need only
  the team's own name.
- **You cannot back both teams in one game.** Picking both sides is a hedge: one of those picks
  survives no matter who wins, and only a tie takes both. Adding a team greys out its opponent
  with the reason, and the server refuses the allocation naming both teams. This is a league rule
  added after the spec, so it lives in `LEAGUE_CONFIG` as `bothSidesOfGame` (`"block"` by
  default, `"allow"` to permit hedging) rather than being hardcoded, per §0.

  It deliberately does **not** narrow §5.3, which covers something else: stacking several picks
  on *one* team and reusing a team week after week both remain unrestricted under
  `teamReuse: "unlimited"`, and acceptance test 4 still passes.
- **No team-usage badge.** §9 asks for one ("how many times this slot has already used each
  team"); the league asked for it to be dropped as clutter, so this is a deliberate departure.
  The data is still computed for My Picks History. Nothing is blocked either way: under
  `teamReuse: "unlimited"` you may stack as many picks on one team as you like.
- Leave picks spare and the recap says what happens to them at lock — and warns loudly when the
  answer is elimination — computed by the real §5.2 engine so it cannot drift from `lockWeek`.

### Decisions taken in Phase 4

- **The whole form saves or none of it does.** §9 says save all slots in one submit; a partial
  save would leave an entrant believing they had picked when they had not.
- **Picks are allocated by team, not by slot**, with the slot mapping done server-side and
  optimised for stability so that §5.2's repeat-last-week keeps following the same slot.
- **`bothSidesOfGame` blocks hedging a single game**, checked over the whole allocation so the
  error names the two clashing teams rather than blaming one slot. Auto-assignment (§5.2) is
  *not* subject to it — see below.
- **The Make Picks query never loads another entrant's selections.** Not filtered on render —
  never fetched. That is what makes acceptance test 22 true of the payload rather than of the UI.
- **The session cookie is set on the redirect response itself.** Setting it through the `cookies()`
  store does not attach it to a `NextResponse.redirect()`, so the callback sent users to a page
  that immediately bounced them back to sign in, holding a perfectly valid session they never
  received. Found by clicking a real link; no test would have caught it.
- **The database handle is cached on `globalThis`**, not in a module variable, so hot reload does
  not build a second connection pool per edit.

## Open questions

- **Should auto-assignment respect `bothSidesOfGame`?** Today it does not. If an entrant misses
  the deadline and §5.2 repeats their previous team, that team may be the opponent of one they
  already hold — producing a hedge they could not have chosen themselves. The alternative is to
  treat it as "no team to repeat" and fall through to `missedPickFallback`, which by default
  means **elimination** for a clash the entrant never chose. Punishing a missed deadline that
  harshly seemed worse than tolerating a rare accidental hedge, but it is a league decision, not
  a technical one.

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
