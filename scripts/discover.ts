// One-off local helper (Node 22+): obtains a Google refresh token and lists
// calendar collection URLs on both sides.
//   node scripts/discover.ts google-token   # needs GOOGLE_CLIENT_ID/SECRET
//   node scripts/discover.ts calendars      # needs all credentials
import { createServer } from 'node:http';
import { basicAuth, CalDav, googleAccessToken } from '../src/dav.ts';

const env = (k: string) => process.env[k] ?? (() => { throw new Error(`missing env ${k}`); })();

async function googleToken() {
  const port = 8765;
  const redirect = `http://127.0.0.1:${port}`;
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.search = new URLSearchParams({
    client_id: env('GOOGLE_CLIENT_ID'),
    redirect_uri: redirect,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/calendar',
    access_type: 'offline',
    prompt: 'consent',
  }).toString();
  // Code from the redirect URL pasted as argv[3] (browser on another machine),
  // otherwise wait for the browser to hit the local callback.
  const pasted = process.argv[3];
  const code = pasted
    ? new URL(pasted).searchParams.get('code')!
    : await new Promise<string>((resolve) => {
        console.log(`Open in a browser:\n${auth}\n\nIf the browser runs elsewhere, copy the final 127.0.0.1 URL and rerun:\n  node scripts/discover.ts google-token '<url>'\n`);
        const srv = createServer((req, res) => {
          const c = new URL(req.url!, redirect).searchParams.get('code');
          res.end(c ? 'OK, you can close this tab.' : 'no code');
          if (c) { srv.close(); resolve(c); }
        }).listen(port);
      });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env('GOOGLE_CLIENT_ID'),
      client_secret: env('GOOGLE_CLIENT_SECRET'),
      redirect_uri: redirect,
      grant_type: 'authorization_code',
    }),
  });
  const body = (await res.json()) as { refresh_token?: string };
  if (!body.refresh_token) throw new Error(`no refresh_token: ${JSON.stringify(body)}`);
  console.log(`GOOGLE_REFRESH_TOKEN=${body.refresh_token}`);
}

async function calendars() {
  const icloud = new CalDav('https://caldav.icloud.com/', basicAuth(env('ICLOUD_USERNAME'), env('ICLOUD_APP_PASSWORD')));
  const token = await googleAccessToken(env('GOOGLE_CLIENT_ID'), env('GOOGLE_CLIENT_SECRET'), env('GOOGLE_REFRESH_TOKEN'));
  const google = new CalDav('https://apidata.googleusercontent.com/caldav/v2/', 'Bearer ' + token);
  for (const [name, dav] of [['iCloud', icloud], ['Google', google]] as const) {
    console.log(`\n${name}:`);
    for (const c of await dav.calendars()) if (c.vevent) console.log(`  ${c.name}\t${c.url}`);
  }
}

const cmd = process.argv[2];
if (cmd === 'google-token') await googleToken();
else if (cmd === 'calendars') await calendars();
else console.log('usage: node scripts/discover.ts google-token|calendars');
