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
// Google serves a JavaScript interstitial (HTTP 200, no redirect) to desktop browsers, but a real
// 302 to non-browser clients, so try those first and only then fall back to a browser UA.
const USER_AGENTS = [
  "curl/8.4.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
];

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

// Follow redirects by hand with one user-agent. Returns { url, body, status } for the last response.
async function follow(startUrl, ua, fetchImpl) {
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
      headers: { "User-Agent": ua, "Accept-Language": "en" }
    });
    const loc = res.headers.get("Location");
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current);
      continue;
    }
    return { url: current.toString(), status: res.status, body: res.status === 200 ? await res.text() : "" };
  }
  throw new Error("Too many redirects");
}

// Last resort: the interstitial page often embeds the destination as an escaped URL in its HTML/JS.
function findMapsUrlInBody(body) {
  const text = body
    .replace(/\\u003d/gi, "=").replace(/\\u0026/gi, "&").replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/").replace(/&amp;/g, "&");
  const m = text.match(/https?:\/\/(?:www\.)?google\.[a-z.]+\/maps[^"'\s<>\\]*/i)
    || text.match(/https?:\/\/maps\.google\.[a-z.]+\/[^"'\s<>\\]*/i);
  return m ? m[0] : null;
}

async function resolve(startUrl, fetchImpl, debug) {
  const tried = [];
  for (const ua of USER_AGENTS) {
    const r = await follow(startUrl, ua, fetchImpl);
    tried.push({ ua: ua.slice(0, 20), status: r.status, url: r.url });
    if (r.url !== startUrl) return debug ? { url: r.url, tried } : { url: r.url };

    const fromBody = findMapsUrlInBody(r.body);
    if (fromBody) return debug ? { url: fromBody, tried, via: "body" } : { url: fromBody };
    if (debug) tried[tried.length - 1].bodyHead = r.body.slice(0, 300);
  }
  // Nothing expanded: report that instead of echoing the short link back as if it worked.
  const err = new Error("Google didn't redirect this link to a map location");
  err.tried = tried;
  throw err;
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "GET") return json({ error: "GET only" }, 405);

    const params = new URL(request.url).searchParams;
    const target = params.get("url");
    const debug = params.get("debug") === "1";
    if (!target) return json({ error: "Missing ?url=" }, 400);

    let parsed;
    try { parsed = new URL(target); } catch (e) { return json({ error: "Invalid URL" }, 400); }
    if (!allowed(parsed)) return json({ error: "Only Google Maps links are supported" }, 400);

    try {
      return json(await resolve(parsed.toString(), fetch, debug));
    } catch (e) {
      return json({ error: String(e && e.message || e), tried: debug && e && e.tried ? e.tried : undefined }, 502);
    }
  }
};
