/* One-Tap Ride — short-link resolver (Cloudflare Worker).
   GET /?url=https://maps.app.goo.gl/xxxx  ->  { "url": "<final long Google Maps URL>" }
   Only Google Maps hosts are accepted, so this can't be used as a general open proxy. */

const ALLOWED_HOSTS = [
  "maps.app.goo.gl",
  "goo.gl",
  "g.co",
  "maps.google.com",
  "google.com",
  "www.google.com",
  "consent.google.com"
];
const MAX_HOPS = 6;
// A desktop UA makes Google redirect to the full /maps/place/... URL.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json" }, CORS)
  });
}

function allowed(u) {
  return u.protocol === "https:" && ALLOWED_HOSTS.indexOf(u.hostname) !== -1;
}

async function resolve(startUrl, fetchImpl) {
  let current = new URL(startUrl);
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (!allowed(current)) throw new Error("Host not allowed: " + current.hostname);

    // EU consent wall: the real destination is in ?continue=
    if (current.hostname === "consent.google.com" && current.searchParams.get("continue")) {
      current = new URL(current.searchParams.get("continue"));
      continue;
    }

    const res = await fetchImpl(current.toString(), {
      redirect: "manual",
      headers: { "User-Agent": UA, "Accept-Language": "en" }
    });
    const loc = res.headers.get("Location");
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current);
      continue;
    }
    return current.toString();
  }
  throw new Error("Too many redirects");
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "GET") return json({ error: "GET only" }, 405);

    const target = new URL(request.url).searchParams.get("url");
    if (!target) return json({ error: "Missing ?url=" }, 400);

    let parsed;
    try { parsed = new URL(target); } catch (e) { return json({ error: "Invalid URL" }, 400); }
    if (!allowed(parsed)) return json({ error: "Only Google Maps links are supported" }, 400);

    try {
      return json({ url: await resolve(parsed.toString(), fetch) });
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 502);
    }
  }
};
