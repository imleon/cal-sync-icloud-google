import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashIcs, prepareForWrite, uidOf } from '../src/ics.ts';
import { plan, SafetyAbort, type Item, type Row } from '../src/sync.ts';

const ev = (extra: string) =>
  `BEGIN:VCALENDAR\r\nPRODID:x\r\nBEGIN:VEVENT\r\nUID:u1\r\nDTSTAMP:20260101T000000Z\r\n${extra}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

test('hash ignores server-rewritten props and line order', async () => {
  const a = await hashIcs(ev('DTSTART:20260101T100000Z\r\nSUMMARY:x'));
  const b = await hashIcs(ev('SUMMARY:x\r\nDTSTART:20260101T100000Z').replace('PRODID:x', 'PRODID:google').replace('20260101T000000Z', '20261231T000000Z'));
  assert.equal(a, b);
  assert.notEqual(a, await hashIcs(ev('DTSTART:20260101T100000Z\r\nSUMMARY:y')));
});

test('prepareForWrite strips invitations and adds DTEND', () => {
  const out = prepareForWrite(ev('DTSTART;VALUE=DATE:20260131\r\nATTENDEE:mailto:a@b\r\nORGANIZER:mailto:c@d').replace('PRODID:x', 'METHOD:REQUEST'));
  assert.ok(!/ATTENDEE|ORGANIZER|METHOD/.test(out));
  assert.match(out, /DTEND;VALUE=DATE:20260201\r\nEND:VEVENT/);
  assert.equal(uidOf(out), 'u1');
  const timed = prepareForWrite(ev('DTSTART;TZID=Asia/Shanghai:20260101T100000'));
  assert.match(timed, /DTEND;TZID=Asia\/Shanghai:20260101T100000/);
});

test('prepareForWrite folds long lines', () => {
  const out = prepareForWrite(ev('DTSTART:20260101T100000Z\r\nDTEND:20260101T110000Z\r\nDESCRIPTION:' + '中'.repeat(60)));
  for (const line of out.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75);
  assert.match(out.replace(/\r\n /g, ''), /DESCRIPTION:中{60}/);
});

const row = (ident: string, ha = 'h', hb = 'h'): Row => ({ ident, href_a: `/a/${ident}`, etag_a: 'e', hash_a: ha, href_b: `/b/${ident}`, etag_b: 'e', hash_b: hb });
const item = (ident: string, side: 'a' | 'b', hash = 'h'): [string, Item] => [ident, { href: `/${side}/${ident}`, etag: 'e', hash }];
const run = (rows: Row[], a: [string, Item][], b: [string, Item][], skip: string[] = []) =>
  plan({ rows: new Map(rows.map((r) => [r.ident, r])), a: new Map(a), b: new Map(b), skip: new Set(skip), allowMassDelete: false });

test('decision table', () => {
  // new on one side -> copy
  assert.deepEqual(run([], [item('x', 'a')], []), [{ kind: 'copy', ident: 'x', from: 'a' }]);
  // first sync, identical on both -> record only
  assert.deepEqual(run([], [item('x', 'a')], [item('x', 'b')]), [{ kind: 'record', ident: 'x' }]);
  // changed on b only -> copy from b
  assert.deepEqual(run([row('x')], [item('x', 'a')], [item('x', 'b', 'h2')]), [{ kind: 'copy', ident: 'x', from: 'b' }]);
  // conflict -> iCloud (a) wins
  assert.deepEqual(run([row('x')], [item('x', 'a', 'h1')], [item('x', 'b', 'h2')]), [{ kind: 'copy', ident: 'x', from: 'a' }]);
  // unchanged -> nothing
  assert.deepEqual(run([row('x')], [item('x', 'a')], [item('x', 'b')]), []);
  // deleted on a, unchanged on b -> delete on b
  const rows = ['x', 'y', 'z', 'w'].map((i) => row(i));
  const keep = (s: 'a' | 'b') => ['y', 'z', 'w'].map((i) => item(i, s));
  assert.deepEqual(run(rows, keep('a'), [...keep('b'), item('x', 'b')]), [{ kind: 'delete', ident: 'x', side: 'b' }]);
  // deleted on a, modified on b -> modification wins
  assert.deepEqual(run(rows, keep('a'), [...keep('b'), item('x', 'b', 'h2')]), [{ kind: 'copy', ident: 'x', from: 'b' }]);
  // deleted on both -> forget
  assert.deepEqual(run(rows, keep('a'), keep('b')), [{ kind: 'forget', ident: 'x' }]);
  // skipped idents are never touched
  assert.deepEqual(run(rows, keep('a'), [...keep('b'), item('x', 'b')], ['x']), []);
});

test('safety: an empty side never deletes the other side', () => {
  assert.throws(() => run([row('x')], [], [item('x', 'b')]), SafetyAbort);
  assert.throws(() => run([row('x')], [item('x', 'a')], []), SafetyAbort);
  assert.throws(() => run([row('x')], [], []), SafetyAbort);
  const empty = { rows: new Map([['x', row('x')]]), a: new Map(), b: new Map([item('x', 'b')]), skip: new Set<string>() };
  assert.throws(() => plan({ ...empty, allowMassDelete: true }), SafetyAbort, 'ALLOW_MASS_DELETE does not bypass');
});

test('safety: mass delete aborts', () => {
  const rows = ['1', '2', '3', '4', '5', '6'].map((i) => row(i));
  const b = rows.map((r) => item(r.ident, 'b'));
  assert.throws(() => run(rows, [item('1', 'a')], b), SafetyAbort);
});
