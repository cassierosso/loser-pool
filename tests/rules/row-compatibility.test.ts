import { describe, expect, it } from "vitest";

import type { GameRow, PickSlotRow, SelectionRow, WeekStateRow } from "@/lib/db/schema";
import type { RuleGame, RulePickSlot, RuleSelection, RuleWeek } from "@/lib/rules/types";

/**
 * The rules engine performs no I/O, but it is meant to be fed straight from the
 * database with no mapping layer in between. These assertions are the proof: if
 * a column is renamed or a status enum drifts apart from the engine's view of
 * it, `npm run typecheck` fails here rather than in Phase 3, halfway through
 * wiring up the jobs.
 *
 * Each constant below is only assignable to `true` while the row type still
 * satisfies the rule type, so tsc is doing the real work.
 */
type Satisfies<Row, Rule> = Row extends Rule ? true : false;

const gameRowIsARuleGame: Satisfies<GameRow, RuleGame> = true;
const weekRowIsARuleWeek: Satisfies<WeekStateRow, RuleWeek> = true;
const pickSlotRowIsARulePickSlot: Satisfies<PickSlotRow, RulePickSlot> = true;
const selectionRowIsARuleSelection: Satisfies<SelectionRow, RuleSelection> = true;

describe("database rows satisfy the rules-engine types", () => {
  it("is enforced by the compiler, not at runtime", () => {
    expect([
      gameRowIsARuleGame,
      weekRowIsARuleWeek,
      pickSlotRowIsARulePickSlot,
      selectionRowIsARuleSelection,
    ]).toEqual([true, true, true, true]);
  });
});
