// Scenario test against the real sync-test calendars (Node 22+, writes data!).
// Seeds events through CalDAV, runs sync() until quiet, and checks results.
//   set -a; . ./.dev.vars; set +a; NODE_USE_ENV_PROXY=1 node scripts/scenario.ts
// Refuses to run unless both calendars are named sync-test.
import { basicAuth, CalDav, googleAccessToken } from '../src/dav.ts';
import { sync, type Row, type Store } from '../src/sync.ts';

const env = (k: string) => process.env[k] ?? (() => { throw new Error(`missing env ${k}`); })();

const token = await googleAccessToken(env('GOOGLE_CLIENT_ID'), env('GOOGLE_CLIENT_SECRET'), env('GOOGLE_REFRESH_TOKEN'));
const dav = {
  a: new CalDav(env('ICLOUD_CALENDAR_URL'), basicAuth(env('ICLOUD_USERNAME'), env('ICLOUD_APP_PASSWORD'))),
  b: new CalDav(env('GOOGLE_CALENDAR_URL'), 'Bearer ' + token),
};
for (const side of ['a', 'b'] as const) {
  const name = await dav[side].displayName();
  if (name !== 'sync-test') throw new Error(`scenario.ts writes test data; ${side} calendar is "${name}", not "sync-test"`);
}

const state: Record<string, Row> = {};
const store: Store = {
  rows: async () => Object.values(state).map((r) => ({ ...r })),
  put: async (r) => { state[r.ident] = { ...r }; },
  remove: async (i) => { delete state[i]; },
};

const RUN = Date.now().toString(36);
const uid = (n: string) => `cst-${RUN}-${n}`;
const ics = (id: string, body: string) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//cal-sync-test//EN\r\nBEGIN:VEVENT\r\nUID:${id}\r\nDTSTAMP:20261102T000000Z\r\n${body}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

async function all(side: 'a' | 'b') {
  const listed = await dav[side].list();
  const got = await dav[side].multiget(listed.map((l) => l.href));
  return [...got.values()];
}
const find = async (side: 'a' | 'b', id: string) => (await all(side)).find((f) => f.ics.includes(`UID:${id}`));
const prop = (s: string | undefined, p: string) => s?.replace(/\r?\n[ \t]/g, '').match(new RegExp(`^${p}[;:](.*)$`, 'm'))?.[0];

async function settle(label: string) {
  for (let i = 1; i <= 6; i++) {
    const r = await sync(dav, store, { dryRun: false, maxWrites: 20, allowMassDelete: false, log: (m) => console.log(`   ${m}`) });
    if (r.writes === 0 && r.failures === 0) {
      console.log(`[${label}] quiet after ${i} run(s)`);
      return;
    }
    if (i === 6) throw new Error(`[${label}] did not converge`);
  }
}

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failed++;
};

// Baseline: adopt whatever already exists.
await settle('baseline');

// 1. create on each side, incl. all-day, recurring with override, attendee, no DTEND
await dav.a.put(`${uid('timed')}.ics`, ics(uid('timed'), 'DTSTART;TZID=Asia/Shanghai:20261110T100000\r\nDTEND;TZID=Asia/Shanghai:20261110T110000\r\nSUMMARY:icloud timed'), 'create');
await dav.a.put(`${uid('allday')}.ics`, ics(uid('allday'), 'DTSTART;VALUE=DATE:20261111\r\nDTEND;VALUE=DATE:20261112\r\nSUMMARY:icloud allday'), 'create');
await dav.a.put(`${uid('invite')}.ics`, ics(uid('invite'), 'DTSTART:20261112T020000Z\r\nDTEND:20261112T030000Z\r\nSUMMARY:icloud with attendee\r\nORGANIZER:mailto:nobody@example.invalid\r\nATTENDEE;CN=X:mailto:nobody2@example.invalid'), 'create');
await dav.b.put(`${uid('noend')}.ics`, ics(uid('noend'), 'DTSTART:20261113T020000Z\r\nSUMMARY:google no dtend'), 'create');
const rec = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//cal-sync-test//EN\r\nBEGIN:VEVENT\r\nUID:${uid('weekly')}\r\nDTSTAMP:20261102T000000Z\r\nDTSTART;TZID=Asia/Shanghai:20261116T090000\r\nDTEND;TZID=Asia/Shanghai:20261116T093000\r\nRRULE:FREQ=WEEKLY;COUNT=6\r\nSUMMARY:weekly\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:${uid('weekly')}\r\nDTSTAMP:20261102T000000Z\r\nRECURRENCE-ID;TZID=Asia/Shanghai:20261123T090000\r\nDTSTART;TZID=Asia/Shanghai:20261123T150000\r\nDTEND;TZID=Asia/Shanghai:20261123T153000\r\nSUMMARY:weekly (moved)\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
await dav.a.put(`${uid('weekly')}.ics`, rec, 'create');
await settle('create');

const gTimed = await find('b', uid('timed'));
check('icloud timed -> google', !!gTimed && prop(gTimed.ics, 'SUMMARY') === 'SUMMARY:icloud timed');
const gAll = await find('b', uid('allday'));
check('allday -> google', !!gAll && /DTSTART;VALUE=DATE:20261111/.test(gAll.ics), (gAll?.ics ?? 'missing').split(/\r?\n/).filter((x) => /^DT(START|END)/.test(x)).join(' | '));
const gInvite = await find('b', uid('invite'));
check('attendee stripped on google', !!gInvite && !/ATTENDEE|ORGANIZER/.test(gInvite.ics));
const aNoEnd = await find('a', uid('noend'));
check('google no-DTEND -> icloud', !!aNoEnd, prop(aNoEnd?.ics, 'DTEND') ?? 'no DTEND');
const gWeekly = await find('b', uid('weekly'));
check('recurring + override -> google', !!gWeekly && /RRULE/.test(gWeekly.ics) && /RECURRENCE-ID/.test(gWeekly.ics));

// 2. edits both directions
const aTimed = (await find('a', uid('timed')))!;
await dav.a.put(aTimed.href, aTimed.ics.replace('SUMMARY:icloud timed', 'SUMMARY:icloud timed v2'), { etag: aTimed.etag });
const gAllday = (await find('b', uid('allday')))!;
await dav.b.put(gAllday.href, gAllday.ics.replace(/SUMMARY:.*/, 'SUMMARY:edited on google'), { etag: gAllday.etag });
await settle('edit');
check('icloud edit -> google', prop((await find('b', uid('timed')))?.ics, 'SUMMARY') === 'SUMMARY:icloud timed v2');
check('google edit -> icloud', prop((await find('a', uid('allday')))?.ics, 'SUMMARY') === 'SUMMARY:edited on google');

// 3. conflict: icloud wins
const aT = (await find('a', uid('timed')))!;
const gT = (await find('b', uid('timed')))!;
await dav.a.put(aT.href, aT.ics.replace(/SUMMARY:.*/, 'SUMMARY:conflict icloud'), { etag: aT.etag });
await dav.b.put(gT.href, gT.ics.replace(/SUMMARY:.*/, 'SUMMARY:conflict google'), { etag: gT.etag });
await settle('conflict');
check('conflict: icloud wins', prop((await find('b', uid('timed')))?.ics, 'SUMMARY') === 'SUMMARY:conflict icloud');

// 4. edit recurring on google (vdirsyncer #963: Google may 409 on recurring PUT)
const gW = (await find('b', uid('weekly')))!;
await dav.b.put(gW.href, gW.ics.replace('SUMMARY:weekly\r\n', 'SUMMARY:weekly edited on google\r\n').replace(/SUMMARY:weekly\n/, 'SUMMARY:weekly edited on google\n'), { etag: gW.etag });
await settle('recurring edit on google');
check('google recurring edit -> icloud', /weekly edited on google/.test((await find('a', uid('weekly')))?.ics ?? ''));
const aW = (await find('a', uid('weekly')))!;
await dav.a.put(aW.href, aW.ics.replace('weekly edited on google', 'weekly edited on icloud'), { etag: aW.etag });
await settle('recurring edit on icloud');
check('icloud recurring edit -> google (PUT recurring to Google)', /weekly edited on icloud/.test((await find('b', uid('weekly')))?.ics ?? ''));

// 5. deletes both directions
const aDel = (await find('a', uid('invite')))!;
await dav.a.delete(aDel.href, aDel.etag);
const gDel = (await find('b', uid('noend')))!;
await dav.b.delete(gDel.href, gDel.etag);
await settle('delete');
check('icloud delete -> google', !(await find('b', uid('invite'))));
check('google delete -> icloud', !(await find('a', uid('noend'))));

// Cleanup: delete everything this run created on both sides.
for (const side of ['a', 'b'] as const) {
  for (const f of await all(side)) if (f.ics.includes(`UID:cst-${RUN}-`)) await dav[side].delete(f.href, f.etag);
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exitCode = failed ? 1 : 0;
