// Calendar relay — Cloudflare Pages Function.
//
// Cloudflare Pages turns every file in /functions into a route automatically.
// This file lives at functions/ics.js, so it is served at:
//
//     https://<your-site>.pages.dev/ics?url=<calendar link>
//
// The app looks for exactly that path on its own origin, so once this is
// deployed there is nothing to configure — no Relay URL, no CORS.
//
// Why it exists: Apple's calendar servers don't send CORS headers, so a browser
// refuses to read the feed. A server has no such restriction.

const ALLOWED = ['icloud.com', 'calendar.google.com'];

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const say = (msg, status) =>
  new Response(msg, { status, headers: { ...cors, 'Content-Type': 'text/plain' } });

export const onRequestOptions = () => new Response(null, { status: 204, headers: cors });

export const onRequestGet = async ({ request }) => {
  const target = new URL(request.url).searchParams.get('url');
  if (!target) return say('Relay is live. Append ?url=<your calendar link> to use it.', 200);

  let feed;
  try {
    feed = new URL(target.replace(/^webcal:/, 'https:'));
  } catch {
    return say('That is not a valid calendar link.', 400);
  }

  // This endpoint is public. Restricting the destination keeps it from becoming
  // an open relay that will fetch anything on the internet for anyone.
  const host = feed.hostname.toLowerCase();
  const allowed =
    feed.protocol === 'https:' && ALLOWED.some(d => host === d || host.endsWith('.' + d));
  if (!allowed) return say('Only iCloud or Google calendar links are allowed.', 403);

  try {
    const res = await fetch(feed.toString(), {
      headers: { 'User-Agent': 'training-log/1.0' },
      redirect: 'follow',
    });
    if (!res.ok) {
      return say(
        `The calendar server replied ${res.status}. Make sure this is the Public Calendar ` +
        `link from Share Calendar, not a private invite link.`, 502);
    }
    const body = await res.text();
    if (!/BEGIN:VCALENDAR/i.test(body)) return say('That link did not return a calendar.', 502);

    return new Response(body, {
      status: 200,
      headers: {
        ...cors,
        'Content-Type': 'text/calendar; charset=utf-8',
        'Cache-Control': 'public, max-age=900', // bookings don't change by the second
      },
    });
  } catch {
    return say('Could not reach the calendar server.', 502);
  }
};
