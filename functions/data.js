// Cloud backup — Cloudflare Pages Function + KV.
//
//   GET  /data   -> returns the stored log (or 204 if there's nothing yet)
//   PUT  /data   -> stores the log
//
// Both require an X-Sync-Key header: a passphrase you choose in the app. It's
// never sent in a URL (so it stays out of access logs) and never stored here in
// the clear — we keep a SHA-256 of it and use that as the storage key. Someone
// with the KV dashboard sees a hash and a blob; someone with your passphrase
// sees your training log. Choose a real passphrase, not "gym".
//
// SETUP (once, free)
//   1. Cloudflare -> Storage & Databases -> KV -> Create namespace: "training"
//   2. Pages -> your project -> Settings -> Bindings -> Add -> KV namespace
//         Variable name: SYNC      Namespace: training
//   3. Redeploy.
//
// Free tier is 100k reads and 1k writes a day. This app writes a handful of
// times per session. You will not get near it.

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Key',
};
const say = (msg, status) =>
  new Response(msg, { status, headers: { ...cors, 'Content-Type': 'text/plain' } });

export const onRequestOptions = () => new Response(null, { status: 204, headers: cors });

// The passphrase is hashed, so what lands in KV can't be read back into it.
async function keyFor(request) {
  const pass = request.headers.get('X-Sync-Key');
  if (!pass || pass.length < 8) return null;
  const bytes = new TextEncoder().encode('training-log:' + pass);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  return 'log:' + hex;
}

export const onRequestGet = async ({ request, env }) => {
  if (!env.SYNC) return say('Backup isn\'t configured: bind a KV namespace called SYNC in Pages settings.', 501);

  const key = await keyFor(request);
  if (!key) return say('Missing or too-short sync key (8 characters minimum).', 401);

  const body = await env.SYNC.get(key);
  if (!body) return new Response(null, { status: 204, headers: cors });

  return new Response(body, {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};

export const onRequestPut = async ({ request, env }) => {
  if (!env.SYNC) return say('Backup isn\'t configured: bind a KV namespace called SYNC in Pages settings.', 501);

  const key = await keyFor(request);
  if (!key) return say('Missing or too-short sync key (8 characters minimum).', 401);

  const text = await request.text();
  if (text.length > 20_000_000) return say('That log is too large to store (20 MB limit).', 413);

  let parsed;
  try { parsed = JSON.parse(text); }
  catch { return say('Body must be JSON.', 400); }
  if (!parsed || typeof parsed !== 'object' || !parsed.logs) {
    return say('That doesn\'t look like a training log.', 400);
  }

  await env.SYNC.put(key, text);
  return new Response(JSON.stringify({ ok: true, savedAt: new Date().toISOString() }), {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
};
