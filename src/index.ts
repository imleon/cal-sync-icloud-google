import { basicAuth, CalDav, googleAccessToken } from './dav.ts';
import { SafetyAbort, sync, type Row, type Store } from './sync.ts';

export interface Env {
  DB: D1Database;
  ICLOUD_CALENDAR_URL: string;
  GOOGLE_CALENDAR_URL: string;
  ICLOUD_USERNAME: string;
  ICLOUD_APP_PASSWORD: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REFRESH_TOKEN: string;
  DRY_RUN?: string;
  ALLOW_MASS_DELETE?: string;
  MAX_WRITES?: string;
}

const LOCK_TTL_MS = 5 * 60 * 1000;

function d1Store(db: D1Database): Store {
  return {
    rows: async () => (await db.prepare('SELECT * FROM items').all<Row>()).results,
    put: async (r) => {
      await db
        .prepare(
          `INSERT OR REPLACE INTO items (ident, href_a, etag_a, hash_a, href_b, etag_b, hash_b)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(r.ident, r.href_a, r.etag_a, r.hash_a, r.href_b, r.etag_b, r.hash_b)
        .run();
    },
    remove: async (ident) => {
      await db.prepare('DELETE FROM items WHERE ident = ?').bind(ident).run();
    },
  };
}

async function getMeta(db: D1Database, key: string): Promise<string | null> {
  return (await db.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first<string>('value')) ?? null;
}

async function setMeta(db: D1Database, key: string, value: string) {
  await db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').bind(key, value).run();
}

export async function run(env: Env, log: (m: string) => void) {
  const db = env.DB;
  const now = Date.now();
  // Cron may start a new run while the previous one is still writing.
  const lock = await db
    .prepare(`INSERT INTO meta (key, value) VALUES ('lock', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(meta.value AS INTEGER) < ?`)
    .bind(String(now), now - LOCK_TTL_MS)
    .run();
  if (lock.meta.changes === 0) {
    log('previous run still holds the lock, skipping');
    return;
  }
  try {
    const dav = {
      a: new CalDav(env.ICLOUD_CALENDAR_URL, basicAuth(env.ICLOUD_USERNAME, env.ICLOUD_APP_PASSWORD)),
      b: new CalDav(
        env.GOOGLE_CALENDAR_URL,
        // Fresh token every run: avoids expiry landing mid-run (vdirsyncer #575).
        'Bearer ' + (await googleAccessToken(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REFRESH_TOKEN)),
      ),
    };
    const dryRun = env.DRY_RUN === '1';

    // Cheap change check: skip the full listing when neither calendar changed.
    const ctag = `${await dav.a.ctag()}|${await dav.b.ctag()}`;
    if (!dryRun && !ctag.includes('null') && ctag === (await getMeta(db, 'ctag'))) return;

    const res = await sync(dav, d1Store(db), {
      dryRun,
      maxWrites: Number(env.MAX_WRITES ?? 20),
      allowMassDelete: env.ALLOW_MASS_DELETE === '1',
      log,
    });
    log(`done: ${JSON.stringify(res)}`);
    // Only remember the ctag once everything converged; otherwise retry next minute.
    // Our own writes change the ctag, so a run with writes is followed by one verifying run.
    if (!dryRun && res.complete && res.writes === 0) await setMeta(db, 'ctag', ctag);
  } catch (e) {
    if (e instanceof SafetyAbort) log(`SAFETY ABORT: ${e.message}`);
    throw e;
  } finally {
    await db.prepare(`DELETE FROM meta WHERE key = 'lock'`).run();
  }
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(run(env, console.log));
  },
  // Local testing only: `wrangler dev` then GET /run returns the run's log.
  // Disabled when deployed (workers.dev route is turned off in wrangler.jsonc).
  async fetch(req: Request, env: Env) {
    if (new URL(req.url).pathname !== '/run') return new Response('not found', { status: 404 });
    const lines: string[] = [];
    try {
      await run(env, (m) => lines.push(m));
    } catch (e) {
      lines.push(`ERROR: ${e instanceof Error ? e.message : e}`);
    }
    return new Response(lines.join('\n') + '\n');
  },
} satisfies ExportedHandler<Env>;
