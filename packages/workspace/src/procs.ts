import { lstat, readdir, readFile } from 'node:fs/promises';

/** One entry of /proc, reduced to what the run supervisor needs. */
export interface ProcInfo {
  pid: number;
  ppid: number;
  pgrp: number;
  state: string;
  comm: string;
  /** Start time in clock ticks since boot (field 22 of /proc/<pid>/stat). */
  start: number;
  rssBytes: number;
  uid: number;
}

/** USER_HZ of the Linux /proc interface (always 100 for userspace). */
const CLK_TCK = 100;
const PAGE = 4096;

/** Clock ticks since boot, comparable with `ProcInfo.start`; `null` without /proc. */
export async function nowTicks(): Promise<number | null> {
  try {
    const up = await readFile('/proc/uptime', 'utf8');
    return Math.floor(Number(up.split(' ')[0]) * CLK_TCK);
  } catch {
    return null;
  }
}

/** Parses /proc/<pid>/stat; the command name may contain spaces and parentheses. */
export function parseStat(pid: number, stat: string): Omit<ProcInfo, 'uid'> | null {
  const open = stat.indexOf('(');
  const close = stat.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const rest = stat.slice(close + 2).split(' ');
  // rest[0] state, [1] ppid, [2] pgrp, [19] starttime, [21] rss (pages)
  const start = Number(rest[19]);
  if (!Number.isFinite(start)) return null;
  return {
    pid,
    comm: stat.slice(open + 1, close),
    state: rest[0] ?? '?',
    ppid: Number(rest[1]),
    pgrp: Number(rest[2]),
    start,
    rssBytes: Math.max(0, Number(rest[21]) || 0) * PAGE,
  };
}

/** Snapshot of all processes visible in /proc; empty where /proc is unavailable. */
export async function listProcs(): Promise<Map<number, ProcInfo>> {
  const out = new Map<number, ProcInfo>();
  let names: string[];
  try {
    names = await readdir('/proc');
  } catch {
    return out;
  }
  await Promise.all(
    names
      .filter((n) => /^\d+$/.test(n))
      .map(async (n) => {
        try {
          const pid = Number(n);
          const [stat, st] = await Promise.all([
            readFile(`/proc/${n}/stat`, 'utf8'),
            lstat(`/proc/${n}`),
          ]);
          const p = parseStat(pid, stat);
          if (p) out.set(pid, { ...p, uid: st.uid });
        } catch {
          /* process ended */
        }
      }),
  );
  return out;
}

/** Parents that adopt orphans: init and the usual container/session reapers. */
const ADOPTER = /^(systemd|init|tini|dumb-init|docker-init|catatonit|s6-svscan|runit)$/;

export interface VictimQuery {
  /** The directly spawned test process (its group id equals its pid). */
  childPid: number | undefined;
  /** `nowTicks()` taken before the spawn; `null` disables the orphan sweep. */
  startTicks: number | null;
  /** Processes of the server itself (self and ancestors) are never touched. */
  protect: ReadonlySet<number>;
  uid: number;
}

/**
 * Every live process that belongs to a test run: members of its process group, all descendants of
 * the test process, and orphans (re-parented to init or a reaper by a double fork or `setsid`)
 * of the same UID that were started after the run began. Zombies are excluded (already dead).
 */
export function findVictims(procs: ReadonlyMap<number, ProcInfo>, q: VictimQuery): ProcInfo[] {
  const byParent = new Map<number, number[]>();
  for (const p of procs.values()) {
    const list = byParent.get(p.ppid) ?? [];
    list.push(p.pid);
    byParent.set(p.ppid, list);
  }
  const ids = new Set<number>();
  if (q.childPid !== undefined) {
    const queue = [q.childPid];
    while (queue.length > 0) {
      const id = queue.pop()!;
      if (ids.has(id)) continue;
      ids.add(id);
      queue.push(...(byParent.get(id) ?? []));
    }
    for (const p of procs.values()) if (p.pgrp === q.childPid) ids.add(p.pid);
  }
  if (q.startTicks !== null) {
    for (const p of procs.values()) {
      if (p.uid !== q.uid || p.start < q.startTicks) continue;
      const parent = procs.get(p.ppid);
      if (p.ppid <= 1 || (parent && ADOPTER.test(parent.comm))) ids.add(p.pid);
    }
  }
  const out: ProcInfo[] = [];
  for (const id of ids) {
    const p = procs.get(id);
    if (p && p.state !== 'Z' && p.state !== 'X' && !q.protect.has(id)) out.push(p);
  }
  return out;
}

/** The server itself and its ancestors. */
export function protectedPids(procs: ReadonlyMap<number, ProcInfo>): Set<number> {
  const out = new Set<number>([process.pid]);
  let id = procs.get(process.pid)?.ppid ?? process.ppid;
  while (id > 1 && !out.has(id)) {
    out.add(id);
    id = procs.get(id)?.ppid ?? 0;
  }
  return out;
}
