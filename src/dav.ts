// Minimal CalDAV client on fetch. Workers has no DOMParser, so responses are
// read with a small namespace-agnostic tag matcher; we only need a few props.

export class HttpError extends Error {
  status: number;
  constructor(status: number, method: string, url: string) {
    super(`${method} ${url} -> ${status}`);
    this.status = status;
  }
}

export interface Listed {
  href: string;
  etag: string | null;
}

export interface Fetched {
  href: string;
  etag: string | null;
  ics: string;
}

const PROPFIND_CTAG = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/"><d:prop><cs:getctag/></d:prop></d:propfind>`;

const PROPFIND_LIST = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:resourcetype/></d:prop></d:propfind>`;

function decodeXml(s: string): string {
  return s
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// All inner texts of <prefix:name ...>...</prefix:name>, any or no prefix.
export function tags(xml: string, name: string): string[] {
  const re = new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'g');
  return [...xml.matchAll(re)].map((m) => m[1]);
}

function tag(xml: string, name: string): string | null {
  const t = tags(xml, name)[0];
  return t === undefined ? null : decodeXml(t.trim());
}

function hasTag(xml: string, name: string): boolean {
  return new RegExp(`<(?:[\\w-]+:)?${name}[\\s/>]`).test(xml);
}

export class CalDav {
  collectionUrl: string;
  private auth: string;
  constructor(collectionUrl: string, auth: string) {
    this.collectionUrl = collectionUrl;
    this.auth = auth;
  }

  url(href: string): string {
    return new URL(href, this.collectionUrl).toString();
  }

  private async req(method: string, url: string, headers: Record<string, string>, body?: string) {
    // A hung request would otherwise keep the run (and its lock) alive.
    return fetch(url, { method, headers: { Authorization: this.auth, ...headers }, body, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  }

  // Multistatus requests must answer exactly 207; anything else (502, an HTML
  // error page with 200, a redirect to a login page) aborts the whole run.
  private async multistatus(method: string, depth: string, body: string, url = this.collectionUrl) {
    const res = await this.req(method, url, { Depth: depth, 'Content-Type': 'application/xml; charset=utf-8' }, body);
    if (res.status !== 207) throw new HttpError(res.status, method, url);
    const xml = await res.text();
    if (!hasTag(xml, 'multistatus')) throw new Error(`${method} ${url}: not a multistatus body`);
    return tags(xml, 'response');
  }

  async ctag(): Promise<string | null> {
    const [r] = await this.multistatus('PROPFIND', '0', PROPFIND_CTAG);
    return r === undefined ? null : tag(r, 'getctag');
  }

  // Used by scripts/scenario.ts to refuse running against a non-test calendar.
  async displayName(): Promise<string | null> {
    const [r] = await this.multistatus('PROPFIND', '0',
      '<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>');
    return r === undefined ? null : tag(r, 'displayname');
  }

  async list(): Promise<Listed[]> {
    const self = new URL(this.collectionUrl).pathname.replace(/\/$/, '');
    const out: Listed[] = [];
    for (const r of await this.multistatus('PROPFIND', '1', PROPFIND_LIST)) {
      const href = tag(r, 'href');
      if (!href || new URL(href, this.collectionUrl).pathname.replace(/\/$/, '') === self) continue;
      if (hasTag(tag(r, 'resourcetype') ?? '', 'collection')) continue;
      out.push({ href, etag: tag(r, 'getetag') });
    }
    return out;
  }

  // Hrefs missing from the result could not be fetched (listed-but-unreadable,
  // vdirsyncer #1095); callers must treat them as unknown, never as deleted.
  async multiget(hrefs: string[]): Promise<Map<string, Fetched>> {
    const out = new Map<string, Fetched>();
    if (hrefs.length === 0) return out;
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
<d:prop><d:getetag/><c:calendar-data/></d:prop>
${hrefs.map((h) => `<d:href>${esc(h)}</d:href>`).join('\n')}
</c:calendar-multiget>`;
    for (const r of await this.multistatus('REPORT', '1', body)) {
      const href = tag(r, 'href');
      const ics = tag(r, 'calendar-data');
      if (href && ics) out.set(href, { href, etag: tag(r, 'getetag'), ics });
    }
    // Servers may echo hrefs in a different encoding; map them back to ours.
    const byPath = new Map([...out.values()].map((f) => [new URL(f.href, this.collectionUrl).pathname, f]));
    const result = new Map<string, Fetched>();
    for (const h of hrefs) {
      const f = byPath.get(new URL(h, this.collectionUrl).pathname);
      if (f) result.set(h, { ...f, href: h });
    }
    return result;
  }

  // Returns the new ETag (may be null) or throws HttpError (412 = concurrent change).
  async put(href: string, ics: string, mode: 'create' | { etag: string | null }): Promise<string | null> {
    const cond: Record<string, string> =
      mode === 'create' ? { 'If-None-Match': '*' } : mode.etag ? { 'If-Match': mode.etag } : {};
    const url = this.url(href);
    const res = await this.req('PUT', url, { 'Content-Type': 'text/calendar; charset=utf-8', ...cond }, ics);
    if (!res.ok) throw new HttpError(res.status, 'PUT', url);
    return res.headers.get('ETag');
  }

  async delete(href: string, etag: string | null): Promise<void> {
    const url = this.url(href);
    const res = await this.req('DELETE', url, etag ? { 'If-Match': etag } : {});
    if (!res.ok && res.status !== 404 && res.status !== 410) throw new HttpError(res.status, 'DELETE', url);
  }

  // Discovery is only used by scripts/discover.ts; the Worker uses fixed URLs.
  async calendars(): Promise<{ url: string; name: string | null; vevent: boolean }[]> {
    const [p] = await this.multistatus('PROPFIND', '0',
      '<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>');
    const principal = tag(tag(p, 'current-user-principal') ?? '', 'href');
    if (!principal) throw new Error('no current-user-principal');
    const [h] = await this.multistatus('PROPFIND', '0',
      '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>',
      this.url(principal));
    const home = tag(tag(h, 'calendar-home-set') ?? '', 'href');
    if (!home) throw new Error('no calendar-home-set');
    const homeUrl = new URL(home, this.url(principal)).toString();
    const rs = await this.multistatus('PROPFIND', '1',
      '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/></d:prop></d:propfind>',
      homeUrl);
    return rs
      .filter((r) => hasTag(tag(r, 'resourcetype') ?? '', 'calendar'))
      .map((r) => ({
        url: new URL(tag(r, 'href')!, homeUrl).toString(),
        name: tag(r, 'displayname'),
        vevent: !hasTag(r, 'supported-calendar-component-set') || /name=["']VEVENT["']/.test(r),
      }));
  }
}

export function basicAuth(user: string, password: string): string {
  return 'Basic ' + btoa(`${user}:${password}`);
}

export async function googleAccessToken(clientId: string, clientSecret: string, refreshToken: string): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`google token refresh -> ${res.status} ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}
