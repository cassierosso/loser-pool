import type { PickSlotRow } from "@/lib/db/schema";

/**
 * Turns an aggregate allocation ("2 on Dallas, 1 on Tampa Bay") into concrete
 * per-slot selections.
 *
 * Entrants think in totals: I have five picks, I want two of them on Dallas.
 * The model underneath is not aggregate at all -- a pick_slot is a persistent
 * entity with its own history, and SS5.2 repeats *that slot's* last team when
 * someone misses a deadline. So something has to decide which slot gets which
 * team, and that decision has consequences a week later.
 *
 * The rule here is minimum churn: a slot that already holds a team still being
 * allocated keeps it. Only genuinely new allocations land on free slots, lowest
 * slot number first. Re-submitting the same allocation therefore changes
 * nothing at all, and nobody's history gets shuffled underneath them.
 *
 * Pure: no I/O. The counts come from the client, but the slots come from the
 * database and are matched up here on the server -- the client never names a
 * slot, so it cannot aim a pick at one that isn't the entrant's.
 */

export interface Allocation {
  teamId: string;
  count: number;
}

export interface AllocationResult {
  /** Slots that should end up holding a selection. */
  assignments: Array<{ slotId: string; teamId: string }>;
  /** Slots that should end up with NO selection this week. */
  cleared: string[];
}

export type AllocateOutcome =
  | { ok: true; result: AllocationResult }
  | { ok: false; code: "too_many_picks" | "negative_count"; message: string };

export function allocateSlots(input: {
  /** Alive slots, in any order; sorted here by slot number for stability. */
  aliveSlots: PickSlotRow[];
  /** This week's existing selections: slot id -> team id. */
  existingBySlotId: Record<string, string>;
  allocations: Allocation[];
}): AllocateOutcome {
  const slots = [...input.aliveSlots].sort((a, b) => a.slotNumber - b.slotNumber);

  const wanted = new Map<string, number>();
  for (const allocation of input.allocations) {
    if (!Number.isInteger(allocation.count) || allocation.count < 0) {
      return {
        ok: false,
        code: "negative_count",
        message: "A pick count must be a whole number of zero or more.",
      };
    }
    if (allocation.count === 0) continue;
    wanted.set(allocation.teamId, (wanted.get(allocation.teamId) ?? 0) + allocation.count);
  }

  const total = [...wanted.values()].reduce((sum, count) => sum + count, 0);
  if (total > slots.length) {
    return {
      ok: false,
      code: "too_many_picks",
      message: `You allocated ${total} pick${total === 1 ? "" : "s"} but only have ${slots.length} alive.`,
    };
  }

  const remaining = new Map(wanted);
  const assignments: Array<{ slotId: string; teamId: string }> = [];
  const takenSlotIds = new Set<string>();

  // Pass 1 -- keep what is already there, so long as it is still wanted.
  for (const slot of slots) {
    const current = input.existingBySlotId[slot.id];
    if (!current) continue;

    const outstanding = remaining.get(current) ?? 0;
    if (outstanding > 0) {
      assignments.push({ slotId: slot.id, teamId: current });
      remaining.set(current, outstanding - 1);
      takenSlotIds.add(slot.id);
    }
  }

  // Pass 2 -- place the rest on free slots. Teams are walked in a fixed order
  // rather than the order the client happened to send, so the same allocation
  // always produces the same mapping.
  const freeSlots = slots.filter((slot) => !takenSlotIds.has(slot.id));
  let cursor = 0;

  for (const teamId of [...remaining.keys()].sort()) {
    let outstanding = remaining.get(teamId) ?? 0;
    while (outstanding > 0) {
      const slot = freeSlots[cursor];
      if (!slot) break;
      cursor += 1;
      assignments.push({ slotId: slot.id, teamId });
      takenSlotIds.add(slot.id);
      outstanding -= 1;
    }
  }

  return {
    ok: true,
    result: {
      assignments,
      // Anything left holding a selection it should no longer have gets it
      // removed; those slots are then auto-assigned at lock like any other
      // blank (SS5.2), which the screen says plainly.
      cleared: slots
        .filter((slot) => !takenSlotIds.has(slot.id) && input.existingBySlotId[slot.id])
        .map((slot) => slot.id),
    },
  };
}


/**
 * Games where an allocation backs BOTH teams.
 *
 * Checked over the whole allocation rather than pick by pick, so the entrant is
 * told which two teams clash instead of getting a complaint about one slot.
 * Pure: the caller supplies the week's games.
 */
export function findBothSidesConflicts(input: {
  allocations: Allocation[];
  games: ReadonlyArray<{ id: string; homeTeamId: string; awayTeamId: string }>;
}): Array<{ gameId: string; homeTeamId: string; awayTeamId: string }> {
  const placed = new Set(
    input.allocations.filter((entry) => entry.count > 0).map((entry) => entry.teamId),
  );

  return input.games
    .filter((game) => placed.has(game.homeTeamId) && placed.has(game.awayTeamId))
    .map((game) => ({ gameId: game.id, homeTeamId: game.homeTeamId, awayTeamId: game.awayTeamId }));
}
