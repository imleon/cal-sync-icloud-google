// End-to-end sync() against in-memory CalDAV servers (stubbed fetch).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CalDav, HttpError } from '../src/dav.ts';
import { sync, SafetyAbort, type Row, type Store } from '../src/sync.ts';

class FakeServer {
  files = new Map<string, { ics: string; etag: string }>();
  n = 0;
  fail: number | null = null;
  // Simulates a server that rewrites content on PUT (e.g. Google adding PRODID).
  rewrite = (ics: string) => ics;
  base: string;
  constructor(base: string) {
    this.base = base;
  }

  set(name: string, ics: string) {
    this.files.set(new URL(name, this.base).pathname, { ics, etag: `"${++this.n}"` });
  }

  handle(method: string, url: URL, headers: Headers, body: string): Response {
    if (this.fail) return new Response('bad gateway', { status: this.fail });
    const ms = (rs: string[]) => new Response(`<d:multistatus xmlns:d="DAV:">${rs.join('')}</d:multistatus>`, { status: 207 });
    if (method === 'PROPFIND' && headers.get('Depth') === '0') {
      return ms([`<d:response><d:href>${url.pathname}</d:href><cs:getctag>${this.n}</cs:getctag></d:response>`]);
    }
    if (method === 'PROPFIND') {
      return ms([
        `<d:response><d:href>${url.pathname}</d:href><d:resourcetype><d:collection/></d:resourcetype></d:response>`,
        ...[...this.files].map(([h, f]) => `<d:response><d:href>${h}</d:href><d:getetag>${f.etag}</d:getetag><d:resourcetype/></d:response>`),
      ]);
    }
    if (method === 'REPORT') {
      const hrefs = [...body.matchAll(/<d:href>(.*?)<\/d:href>/g)].map((m) => m[1]);
      return ms(hrefs.filter((h) => this.files.has(h)).map((h) => {
        const f = this.files.get(h)!;
        return `<d:response><d:href>${h}</d:href><d:getetag>${f.etag}</d:getetag><c:calendar-data>${f.ics.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</c:calendar-data></d:response>`;
      }));
    }
    const f = this.files.get(url.pathname);
    if (method === 'PUT') {
      if (headers.get('If-None-Match') === '*' && f) return new Response(null, { status: 412 });
      if (headers.get('If-Match') && headers.get('If-Match') !== f?.etag) return new Response(null, { status: 412 });
      this.files.set(url.pathname, { ics: this.rewrite(body), etag: `"${++this.n}"` });
      return new Response(null, { status: f ? 204 : 201 });
    }
    if (method === 'DELETE') {
      this.files.delete(url.pathname);
      this.n++;
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 405 });
  }
}

const A = new FakeServer('https://icloud.test/cal/');
const B = new FakeServer('https://google.test/cal/');
globalThis.fetch = (async (input: string, init: RequestInit) => {
  const url = new URL(input);
  const srv = url.host === 'icloud.test' ? A : B;
  return srv.handle(init.method!, url, new Headers(init.headers), (init.body as string) ?? '');
}) as typeof fetch;

const rows = new Map<string, Row>();
const store: Store = {
  rows: async () => [...rows.values()].map((r) => ({ ...r })),
  put: async (r) => void rows.set(r.ident, { ...r }),
  remove: async (i) => void rows.delete(i),
};
const dav = { a: new CalDav(A.base, 'x'), b: new CalDav(B.base, 'x') };
const go = () => sync(dav, store, { dryRun: false, maxWrites: 40, allowMassDelete: false, log: () => {} });
const ev = (uid: string, summary: string) =>
  `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART:20260101T100000Z\r\nDTEND:20260101T110000Z\r\nSUMMARY:${summary}\r\nATTENDEE:mailto:x@y\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
const summaryOn = (s: FakeServer, uid: string) => [...s.files.values()].find((f) => f.ics.includes(`UID:${uid}`))?.ics.match(/SUMMARY:(.*)/)?.[1]?.trim();

test('two-way sync converges and stays quiet', async () => {
  B.rewrite = (ics) => ics.replace('BEGIN:VEVENT', 'PRODID:-//Google//EN\r\nBEGIN:VEVENT');
  for (let i = 1; i <= 5; i++) A.set(`a${i}.ics`, ev(`a${i}`, 'icloud'));
  B.set('g1.ics', ev('g1', 'google'));

  await go();
  assert.equal(B.files.size, 6);
  assert.equal(A.files.size, 6);
  const copied = [...B.files.values()].filter((f) => f.ics.includes('UID:a'));
  assert.ok(copied.length === 5 && !copied.some((f) => f.ics.includes('ATTENDEE')), 'invitations are stripped');

  // Next run adopts what servers stored; the one after must do nothing.
  await go();
  const before = A.n + B.n;
  const r = await go();
  assert.equal(r.writes, 0);
  assert.equal(A.n + B.n, before, 'no ping-pong despite server rewrites');
});

test('edits, conflicts and deletions propagate', async () => {
  B.set('g1.ics', ev('g1', 'google-edit'));
  await go();
  assert.equal(summaryOn(A, 'g1'), 'google-edit');

  A.set('a1.ics', ev('a1', 'icloud-wins'));
  const bHref = [...B.files].find(([, f]) => f.ics.includes('UID:a1'))![0];
  B.files.set(bHref, { ics: ev('a1', 'google-loses'), etag: `"${++B.n}"` });
  await go();
  assert.equal(summaryOn(B, 'a1'), 'icloud-wins');

  A.files.delete(new URL('a2.ics', A.base).pathname);
  await go();
  assert.equal(summaryOn(B, 'a2'), undefined);
  await go();
  await go();
  assert.equal((await go()).writes, 0);
});

test('502 aborts without touching anything', async () => {
  const snapshot = JSON.stringify([...A.files, ...B.files, ...rows]);
  B.fail = 502;
  await assert.rejects(go(), (e) => e instanceof HttpError && e.status === 502);
  B.fail = null;
  assert.equal(JSON.stringify([...A.files, ...B.files, ...rows]), snapshot);
});

test('well-formed but empty listing never deletes the other side', async () => {
  for (const [empty, other] of [[A, B], [B, A]]) {
    const saved = new Map(empty.files);
    const before = JSON.stringify([...other.files]);
    empty.files.clear(); // still answers 207, just with zero items
    await assert.rejects(go(), SafetyAbort);
    assert.equal(JSON.stringify([...other.files]), before);
    // Listing only non-event items (e.g. a VTODO) is treated the same.
    empty.set('todo.ics', 'BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:t\r\nEND:VTODO\r\nEND:VCALENDAR\r\n');
    await assert.rejects(go(), SafetyAbort);
    assert.equal(JSON.stringify([...other.files]), before);
    empty.files = saved;
  }
  assert.equal((await go()).writes, 0);
});
