// Oura integration — Cloudflare Pages Function (catch-all for /oura/*)
//
// Why this lives on the server and not in the app:
//   1. Oura deprecated personal access tokens in Dec 2025. It's OAuth2 only, which
//      needs a client secret — and a secret in a phone app isn't a secret.
//   2. Oura's API doesn't send CORS headers, so a browser can't call it directly.
//
// ROUTES
//   GET  /oura/start     -> bounces you to Oura's consent screen
//   GET  /oura/callback  -> swaps the code for tokens, hands them back to the app
//   POST /oura/refresh   -> renews an expired access token
//   POST /oura/session   -> heart rate + workout + daily activity for one session
//
// SETUP (once)
//   1. cloud.ouraring.com -> Developer -> Create a new application
//         Redirect URI:  https://<your-site>.pages.dev/oura/callback
//   2. Cloudflare Pages -> your project -> Settings -> Environment variables:
//         OURA_CLIENT_ID       = <from Oura>
//         OURA_CLIENT_SECRET   = <from Oura>  (mark as "Encrypt")
//   3. Redeploy. In the app: Oura -> Connect.
//
// The client secret never leaves Cloudflare. Your access token is held on your
// phone and posted back here only to make the call Oura requires.

const OURA_AUTH  = 'https://cloud.ouraring.com/oauth/authorize';
const OURA_TOKEN = 'https://api.ouraring.com/oauth/token';
const OURA_API   = 'https://api.ouraring.com/v2/usercollection';
const SCOPES     = 'personal daily heartrate workout';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
const say = (msg, status) =>
  new Response(msg, { status, headers: { ...cors, 'Content-Type': 'text/plain' } });

export const onRequestOptions = () => new Response(null, { status: 204, headers: cors });

// ---------------------------------------------------------------- GET
export const onRequestGet = async ({ request, params, env }) => {
  const route = (params.path || [])[0] || '';
  const url = new URL(request.url);

  if (!env.OURA_CLIENT_ID || !env.OURA_CLIENT_SECRET) {
    return say(
      'Oura isn\'t configured on this deployment. Set OURA_CLIENT_ID and ' +
      'OURA_CLIENT_SECRET in Cloudflare Pages -> Settings -> Environment variables, then redeploy.',
      501
    );
  }

  if (route === 'start') {
    const redirect = new URL('/oura/callback', url.origin).toString();
    const auth = new URL(OURA_AUTH);
    auth.searchParams.set('response_type', 'code');
    auth.searchParams.set('client_id', env.OURA_CLIENT_ID);
    auth.searchParams.set('redirect_uri', redirect);
    auth.searchParams.set('scope', SCOPES);
    auth.searchParams.set('state', crypto.randomUUID());
    return Response.redirect(auth.toString(), 302);
  }

  if (route === 'callback') {
    const code = url.searchParams.get('code');
    const err = url.searchParams.get('error');
    if (err) return say(`Oura declined the connection: ${err}`, 400);
    if (!code) return say('Oura sent no authorization code.', 400);

    const redirect = new URL('/oura/callback', url.origin).toString();
    const res = await fetch(OURA_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirect,
        client_id: env.OURA_CLIENT_ID,
        client_secret: env.OURA_CLIENT_SECRET,
      }),
    });
    if (!res.ok) return say(`Oura rejected the token exchange (${res.status}).`, 502);

    const t = await res.json();
    const payload = {
      a: t.access_token,
      r: t.refresh_token || '',
      e: Date.now() + (t.expires_in || 86400) * 1000,
    };
    // Hand the tokens back in the URL *fragment*. Fragments are never sent to a
    // server, so the token stays out of every access log between here and the phone.
    const back = new URL('/', url.origin);
    back.hash = 'oura=' + encodeURIComponent(JSON.stringify(payload));
    return Response.redirect(back.toString(), 302);
  }

  return say('Oura relay is live. Routes: /oura/start, /oura/callback.', 200);
};

// ---------------------------------------------------------------- POST
export const onRequestPost = async ({ request, params, env }) => {
  const route = (params.path || [])[0] || '';

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Expected a JSON body.' }, 400); }

  if (route === 'refresh') {
    if (!body.refresh) return json({ error: 'No refresh token supplied.' }, 400);
    const res = await fetch(OURA_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: body.refresh,
        client_id: env.OURA_CLIENT_ID,
        client_secret: env.OURA_CLIENT_SECRET,
      }),
    });
    if (!res.ok) return json({ error: 'reauth', status: res.status }, 401);
    const t = await res.json();
    return json({
      a: t.access_token,
      r: t.refresh_token || body.refresh,
      e: Date.now() + (t.expires_in || 86400) * 1000,
    });
  }

  if (route === 'session') {
    const { token, start, end, date } = body;
    if (!token) return json({ error: 'Not connected to Oura.' }, 401);
    if (!date)  return json({ error: 'No date given.' }, 400);

    const auth = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    const get = async (path, qs) => {
      const u = new URL(`${OURA_API}/${path}`);
      Object.entries(qs).forEach(([k, v]) => v && u.searchParams.set(k, v));
      const r = await fetch(u.toString(), { headers: auth });
      if (r.status === 401) throw new Error('reauth');
      if (!r.ok) return { data: [] };
      return r.json();
    };

    try {
      // Heart rate is only fetched for the window the session actually spanned —
      // that's what makes it a workout number rather than a whole-day average.
      const [hr, workouts, activity] = await Promise.all([
        start && end
          ? get('heartrate', { start_datetime: start, end_datetime: end })
          : Promise.resolve({ data: [] }),
        get('workout', { start_date: date, end_date: date }),
        get('daily_activity', { start_date: date, end_date: date }),
      ]);

      const bpm = (hr.data || []).map(p => p.bpm).filter(Number.isFinite);
      const day = (activity.data || [])[0] || null;

      return json({
        hr: bpm.length
          ? {
              avg: Math.round(bpm.reduce((a, b) => a + b, 0) / bpm.length),
              max: Math.max(...bpm),
              n: bpm.length,
            }
          : null,
        workouts: (workouts.data || []).map(w => ({
          activity: w.activity,
          label: w.label || null,
          intensity: w.intensity,
          calories: w.calories != null ? Math.round(w.calories) : null,
          distance: w.distance != null ? Math.round(w.distance) : null, // metres
          start: w.start_datetime,
          end: w.end_datetime,
        })),
        activity: day && {
          score: day.score ?? null,
          steps: day.steps ?? null,
          active_calories: day.active_calories ?? null,
          total_calories: day.total_calories ?? null,
        },
      });
    } catch (e) {
      if (e.message === 'reauth') return json({ error: 'reauth' }, 401);
      return json({ error: 'Could not reach Oura.' }, 502);
    }
  }

  return json({ error: 'Unknown route.' }, 404);
};
