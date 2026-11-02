// Local runner (Node 22+): same sync() as the Worker, state in a JSON file.
// Useful where the Worker runtime cannot reach the network (e.g. behind a proxy).
//   set -a; . ./.dev.vars; set +a
//   NODE_USE_ENV_PROXY=1 DRY_RUN=1 node scripts/local.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { basicAuth, CalDav, googleAccessToken } from '../src/dav.ts';
import { sync, type Row, type Store } from '../src/sync.ts';

const env = (k: string) => process.env[k] ?? (() => { throw new Error(`missing env ${k}`); })();
const stateFile = process.env.STATE_FILE ?? '.local-state.json';

const load = (): Record<string, Row> => {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    return {};
  }
};
const state = load();
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2));
const store: Store = {
  rows: async () => Object.values(state).map((r) => ({ ...r })),
  put: async (r) => { state[r.ident] = { ...r }; save(); },
  remove: async (i) => { delete state[i]; save(); },
};

const token = await googleAccessToken(env('GOOGLE_CLIENT_ID'), env('GOOGLE_CLIENT_SECRET'), env('GOOGLE_REFRESH_TOKEN'));
const dav = {
  a: new CalDav(env('ICLOUD_CALENDAR_URL'), basicAuth(env('ICLOUD_USERNAME'), env('ICLOUD_APP_PASSWORD'))),
  b: new CalDav(env('GOOGLE_CALENDAR_URL'), 'Bearer ' + token),
};
const res = await sync(dav, store, {
  dryRun: process.env.DRY_RUN === '1',
  maxWrites: Number(process.env.MAX_WRITES ?? 20),
  allowMassDelete: process.env.ALLOW_MASS_DELETE === '1',
  log: console.log,
});
console.log('done', res);
