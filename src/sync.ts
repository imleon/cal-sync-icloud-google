// Two-way sync between side "a" (iCloud, wins conflicts) and side "b" (Google).
// Algorithm follows vdirsyncer: per-ident status with href/etag/hash for each
// side, "changed" = content hash differs from that side's last known hash.

import { CalDav, HttpError } from './dav.ts';
import { hashIcs, hasVevent, prepareForWrite, uidOf } from './ics.ts';

export type Side = 'a' | 'b';

export interface Row {
  ident: string;
  href_a: string;
  etag_a: string | null; // null = written by us, content not yet observed
  hash_a: string;
  href_b: string;
  etag_b: string | null;
  hash_b: string;
}

export interface Item {
  href: string;
  etag: string | null;
  hash: string;
  ics?: string; // present when fetched this run (always the case for changed items)
}

export type Action =
  | { kind: 'record'; ident: string }
  | { kind: 'copy'; ident: string; from: Side }
  | { kind: 'delete'; ident: string; side: Side }
  | { kind: 'forget'; ident: string };

export class SafetyAbort extends Error {}

export interface PlanInput {
  rows: Map<string, Row>;
  a: Map<string, Item>;
  b: Map<string, Item>;
  skip: Set<string>; // idents with unreadable content this run: never act on them
  allowMassDelete: boolean;
}

const other = (s: Side): Side => (s === 'a' ? 'b' : 'a');

export function plan({ rows, a, b, skip, allowMassDelete }: PlanInput): Action[] {
  // A side yielding zero events, even from a well-formed 207, is far more likely
  // a broken listing (auth, wrong URL, outage) than a user deleting everything.
  // Counted after parsing, so "items listed but none usable" counts as empty too.
  // Not overridable by ALLOW_MASS_DELETE.
  if (rows.size > 0 && (a.size === 0 || b.size === 0)) {
    throw new SafetyAbort(`a side has no events (a=${a.size}, b=${b.size}) but ${rows.size} were synced before; nothing deleted`);
  }

  const actions: Action[] = [];
  const idents = new Set([...rows.keys(), ...a.keys(), ...b.keys()]);
  for (const ident of idents) {
    if (skip.has(ident)) continue;
    const row = rows.get(ident);
    const ia = a.get(ident);
    const ib = b.get(ident);
    const changed = (s: Side, it: Item) => !row || it.hash !== row[`hash_${s}`];

    if (ia && ib) {
      const ca = changed('a', ia);
      const cb = changed('b', ib);
      if (ca && cb) {
        actions.push(ia.hash === ib.hash ? { kind: 'record', ident } : { kind: 'copy', ident, from: 'a' });
      } else if (ca) {
        actions.push({ kind: 'copy', ident, from: 'a' });
      } else if (cb) {
        actions.push({ kind: 'copy', ident, from: 'b' });
      } else if (ia.href !== row!.href_a || ia.etag !== row!.etag_a || ib.href !== row!.href_b || ib.etag !== row!.etag_b) {
        actions.push({ kind: 'record', ident });
      }
    } else if (ia || ib) {
      const s: Side = ia ? 'a' : 'b';
      // Modification wins over deletion; an unchanged survivor follows the deletion.
      actions.push(changed(s, (ia ?? ib)!) ? { kind: 'copy', ident, from: s } : { kind: 'delete', ident, side: s });
    } else {
      actions.push({ kind: 'forget', ident });
    }
  }

  if (!allowMassDelete) {
    for (const side of ['a', 'b'] as const) {
      const n = actions.filter((x) => x.kind === 'delete' && x.side === side).length;
      if (n > 3 && n > rows.size * 0.3) {
        throw new SafetyAbort(`refusing to delete ${n} of ${rows.size} items on side ${side}; set ALLOW_MASS_DELETE=1 if intended`);
      }
    }
  }
  return actions;
}

// ---- execution -----------------------------------------------------------

export interface Store {
  rows(): Promise<Row[]>;
  put(row: Row): Promise<void>;
  remove(ident: string): Promise<void>;
}

export interface RunOptions {
  dryRun: boolean;
  maxWrites: number;
  allowMassDelete: boolean;
  log: (msg: string) => void;
}

export interface RunResult {
  actions: number;
  writes: number;
  failures: number;
  complete: boolean; // false if some actions failed or were deferred by the write budget
}

const SAFE_NAME = /^[A-Za-z0-9_.-]+$/;
const contentHash = (ics: string) => hashIcs(prepareForWrite(ics));

async function observe(dav: CalDav, side: Side, rows: Row[], log: RunOptions['log']) {
  const listed = await dav.list();
  const byHref = new Map(rows.map((r) => [r[`href_${side}`], r]));
  const items = new Map<string, Item>();
  const toFetch: string[] = [];

  for (const l of listed) {
    const row = byHref.get(l.href);
    if (row && l.etag !== null && row[`etag_${side}`] === l.etag) {
      items.set(row.ident, { href: l.href, etag: l.etag, hash: row[`hash_${side}`] });
    } else {
      toFetch.push(l.href);
    }
  }

  const fetched = await dav.multiget(toFetch);
  let unreadable = 0;
  for (const href of toFetch) {
    const f = fetched.get(href);
    const row = byHref.get(href);
    if (!f) {
      // Listed but unreadable (seen on Google, vdirsyncer #1095).
      log(`${side}: cannot read ${href}, skipping`);
      unreadable++;
      continue;
    }
    if (!hasVevent(f.ics)) continue; // tasks/journals are not synced
    const uid = uidOf(f.ics);
    if (!uid) {
      log(`${side}: ${href} has no UID, skipping`);
      continue;
    }
    if (items.has(uid)) throw new SafetyAbort(`${side}: UID ${uid} appears twice; fix the calendar first`);
    const hash = await contentHash(f.ics);
    // First look at content we wrote ourselves: adopt the server's version as
    // baseline so server-side rewrites never bounce back as "changes".
    // ponytail: an edit made on this side within the minute after our write is
    // adopted too and only propagates on its next edit; needs a stored written-hash to fix.
    // Matched by ident, not href: the server may store our PUT under another href.
    const mine = rows.find((r) => r.ident === uid && r[`etag_${side}`] === null);
    if (mine) mine[`hash_${side}`] = hash;
    items.set(uid, { href, etag: f.etag ?? listed.find((x) => x.href === href)!.etag, hash, ics: f.ics });
  }
  return { items, unreadable };
}

export async function sync(dav: Record<Side, CalDav>, store: Store, opt: RunOptions): Promise<RunResult> {
  const rowList = await store.rows();
  const oa = await observe(dav.a, 'a', rowList, opt.log);
  const ob = await observe(dav.b, 'b', rowList, opt.log);
  const rows = new Map(rowList.map((r) => [r.ident, r]));
  // We cannot tell which ident an unreadable item belongs to, so on that side
  // "absent" proves nothing: leave every synced ident missing there untouched.
  const skip = new Set<string>();
  for (const o of [oa, ob]) {
    if (o.unreadable > 0) for (const id of rows.keys()) if (!o.items.has(id)) skip.add(id);
  }
  const actions = plan({
    rows,
    a: oa.items,
    b: ob.items,
    skip,
    allowMassDelete: opt.allowMassDelete,
  });
  const items = { a: oa.items, b: ob.items };

  let writes = 0;
  let failures = 0;
  let deferred = 0;
  for (const act of actions) {
    const desc = JSON.stringify(act);
    if (opt.dryRun) {
      opt.log(`dry-run: ${desc}`);
      continue;
    }
    if (act.kind === 'copy' || act.kind === 'delete') {
      if (writes >= opt.maxWrites) {
        deferred++;
        continue;
      }
      writes++;
    }
    try {
      if (act.kind === 'record') {
        const ia = items.a.get(act.ident)!;
        const ib = items.b.get(act.ident)!;
        await store.put({ ident: act.ident, href_a: ia.href, etag_a: ia.etag, hash_a: ia.hash, href_b: ib.href, etag_b: ib.etag, hash_b: ib.hash });
      } else if (act.kind === 'forget') {
        await store.remove(act.ident);
      } else if (act.kind === 'delete') {
        const it = items[act.side].get(act.ident)!;
        await dav[act.side].delete(it.href, it.etag);
        await store.remove(act.ident);
        opt.log(`deleted ${act.ident} on ${act.side}`);
      } else {
        const src = items[act.from].get(act.ident)!;
        const to = other(act.from);
        const dst = items[to].get(act.ident);
        const href = dst?.href ?? new URL((SAFE_NAME.test(act.ident) ? act.ident : crypto.randomUUID()) + '.ics', dav[to].collectionUrl).pathname;
        await dav[to].put(href, prepareForWrite(src.ics!), dst ? { etag: dst.etag } : 'create');
        // The written side's etag is stored as null: next run re-reads it and
        // adopts whatever the server actually stored as the new baseline.
        const written = { href, etag: null, hash: src.hash };
        const ia = act.from === 'a' ? src : written;
        const ib = act.from === 'b' ? src : written;
        await store.put({ ident: act.ident, href_a: ia.href, etag_a: ia.etag, hash_a: ia.hash, href_b: ib.href, etag_b: ib.etag, hash_b: ib.hash });
        opt.log(`copied ${act.ident} ${act.from} -> ${to}`);
      }
    } catch (e) {
      // Status stays untouched for this ident; the next run retries it.
      // 412 means the target changed concurrently; that is picked up next run too.
      failures++;
      opt.log(`failed ${desc}: ${e instanceof Error ? e.message : e}`);
      if (e instanceof HttpError && (e.status === 429 || e.status === 503)) {
        opt.log('rate limited, stopping this run');
        break;
      }
    }
  }
  return { actions: actions.length, writes, failures, complete: failures === 0 && deferred === 0 && skip.size === 0 };
}
