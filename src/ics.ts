// iCalendar text helpers. Line-based on purpose: we never re-model events,
// we pass the original ICS through and only touch the few lines we must.

// Properties servers rewrite on their own; ignoring them keeps hashes stable
// (same list as vdirsyncer's vobject.py).
const IGNORED = new Set([
  'PRODID', 'METHOD', 'X-RADICALE-NAME', 'X-WR-CALNAME', 'REV',
  'LAST-MODIFIED', 'CREATED', 'DTSTAMP', 'UID',
]);
// Never copied to the other side: we sync for one person, invitations must not be sent.
const STRIPPED = new Set(['METHOD', 'ATTENDEE', 'ORGANIZER']);

const enc = new TextEncoder();

export function unfold(ics: string): string[] {
  return ics.replace(/\r?\n[ \t]/g, '').split(/\r?\n/).filter((l) => l !== '');
}

function propName(line: string): string {
  return line.split(/[;:]/, 1)[0].toUpperCase();
}

function dropComponent(lines: string[], name: string): string[] {
  const out: string[] = [];
  let skipping = false;
  for (const l of lines) {
    if (l === `BEGIN:${name}`) skipping = true;
    if (!skipping) out.push(l);
    if (l === `END:${name}`) skipping = false;
  }
  return out;
}

export function uidOf(ics: string): string | null {
  const line = unfold(ics).find((l) => propName(l) === 'UID');
  return line ? line.slice(line.indexOf(':') + 1).trim() || null : null;
}

export function hasVevent(ics: string): boolean {
  return unfold(ics).includes('BEGIN:VEVENT');
}

export async function hashIcs(ics: string): Promise<string> {
  const norm = dropComponent(unfold(ics), 'VTIMEZONE')
    .filter((l) => !IGNORED.has(propName(l)))
    .map((l) => l.trim())
    .sort()
    .join('\n');
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(norm));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function dtendFrom(dtstart: string): string {
  const i = dtstart.indexOf(':');
  const head = 'DTEND' + dtstart.slice('DTSTART'.length, i);
  let value = dtstart.slice(i + 1);
  // All-day event: RFC 5545 implies one day; DTEND is exclusive.
  if (/^\d{8}$/.test(value)) {
    const d = new Date(Date.UTC(+value.slice(0, 4), +value.slice(4, 6) - 1, +value.slice(6, 8) + 1));
    value = d.toISOString().slice(0, 10).replaceAll('-', '');
  }
  return `${head}:${value}`;
}

export function fold(line: string): string {
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  let n = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    // Continuation lines start with a space that counts toward the 75 octets.
    if (n + b > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      n = 0;
    }
    cur += ch;
    n += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

// Content written to the other side: no invitation data, and every VEVENT
// gets a DTEND (iCloud answers 404 to events without one, vdirsyncer #1200).
export function prepareForWrite(ics: string): string {
  const out: string[] = [];
  let dtstart: string | null = null;
  let hasEnd = false;
  for (const l of unfold(ics)) {
    const name = propName(l);
    if (STRIPPED.has(name)) continue;
    if (l === 'BEGIN:VEVENT') {
      dtstart = null;
      hasEnd = false;
    } else if (name === 'DTSTART') {
      dtstart = l;
    } else if (name === 'DTEND' || name === 'DURATION') {
      hasEnd = true;
    } else if (l === 'END:VEVENT' && dtstart && !hasEnd) {
      out.push(dtendFrom(dtstart));
    }
    out.push(l);
  }
  return out.map(fold).join('\r\n') + '\r\n';
}
