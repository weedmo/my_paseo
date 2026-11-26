// Ticket DAG from blockedBy, ported from the matt-graph mod (model.mjs).
// The mod throws on a cycle or an unknown dependency; a panel cannot show
// anything after a throw, so here every problem becomes an error string and
// the offending edge is dropped. The result always terminates.

export interface DagTicket {
  id: string;
  blockedBy?: unknown;
}

export interface DagResult {
  /** ticket id -> level (0 = no dependencies). */
  levels: Map<string, number>;
  errors: string[];
}

export function ticketLevels(tickets: readonly DagTicket[]): DagResult {
  const errors: string[] = [];
  const byId = new Map<string, DagTicket>();
  for (const t of tickets) {
    if (!t.id) {
      errors.push("Ticket without an id");
      continue;
    }
    if (byId.has(t.id)) {
      errors.push(`Duplicate ticket id: ${t.id}`);
      continue;
    }
    byId.set(t.id, t);
  }
  const levels = new Map<string, number>();
  const visiting: string[] = [];
  const reported = new Set<string>();

  const deps = (id: string): string[] => {
    const raw = byId.get(id)?.blockedBy;
    if (raw == null) return [];
    if (!Array.isArray(raw)) {
      errors.push(`Invalid blockedBy: ${id}`);
      return [];
    }
    return raw.filter((d): d is string => typeof d === "string");
  };

  const level = (id: string): number => {
    const known = levels.get(id);
    if (known !== undefined) return known;
    visiting.push(id);
    let n = 0;
    for (const dep of deps(id)) {
      if (!byId.has(dep)) {
        const key = `unknown:${id}:${dep}`;
        if (!reported.has(key)) {
          reported.add(key);
          errors.push(`Unknown dependency: ${id} is blocked by ${dep}`);
        }
        continue;
      }
      const at = visiting.indexOf(dep);
      if (at >= 0) {
        const cycle = [...visiting.slice(at), dep];
        const key = `cycle:${[...cycle].sort().join(",")}`;
        if (!reported.has(key)) {
          reported.add(key);
          errors.push(`Dependency cycle: ${cycle.join(" → ")}`);
        }
        continue; // drop the back edge
      }
      n = Math.max(n, level(dep) + 1);
    }
    visiting.pop();
    levels.set(id, n);
    return n;
  };

  for (const id of byId.keys()) level(id);
  return { levels, errors };
}
