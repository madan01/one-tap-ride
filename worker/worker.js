/* One-Tap Ride — short-link resolver (Cloudflare Worker).
   GET /?url=https://maps.app.goo.gl/xxxx
     ->  { "lat": 12.93, "lng": 77.52, "name": "Place" }
   Add &debug=1 to also see the expanded URL and what was tried.
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

// Browsers may only call this from the app's own origins. Requests with no Origin header
// (curl, address bar) are still served, so the worker stays easy to test.
const ALLOWED_ORIGINS = [
  "https://madan01.github.io",
  "https://localhost",          // Android (Capacitor/TWA wrapper)
  "capacitor://localhost"       // iOS wrapper
];
function originAllowed(origin) {
  return ALLOWED_ORIGINS.indexOf(origin) !== -1 || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function corsHeaders(origin) {
  const h = {
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
  if (origin && originAllowed(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json" }, corsHeaders(origin))
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

// Pull coordinates (and a place name when present) out of a full Google Maps URL.
// Most exact first: the pinned place (!3d..!4d..), then explicit query params, then map centre (@lat,lng).
function extractLocation(rawUrl) {
  let text = rawUrl;
  try { text = decodeURIComponent(rawUrl); } catch (e) { /* keep raw */ }
  const num = "(-?\\d+(?:\\.\\d+)?)";
  const patterns = [
    new RegExp("!3d" + num + "!4d" + num),
    new RegExp("[?&](?:q|ll|query|destination|daddr|saddr|center)=\\+?" + num + ",\\s*\\+?" + num),
    new RegExp("/maps/(?:place|search|dir)/(?:[^/]*/)?\\+?" + num + ",\\s*\\+?" + num + "(?:[/?@]|$)"),
    new RegExp("@" + num + ",\\s*" + num)
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
    const nm = text.match(/\/maps\/place\/([^\/@?]+)/);
    let name = nm ? nm[1].replace(/\+/g, " ").split(",")[0].trim() : "";
    if (/^[-+\d.\s]+$/.test(name)) name = "";
    return { lat, lng, name };
  }
  return null;
}

function result(url, debug, tried) {
  const loc = extractLocation(url);
  if (!loc) {
    const err = new Error("The expanded link has no coordinates");
    err.tried = tried;
    err.url = url;
    throw err;
  }
  const out = { lat: loc.lat, lng: loc.lng, name: loc.name };
  if (debug) { out.url = url; out.tried = tried; }
  return out;
}

async function resolve(startUrl, fetchImpl, debug) {
  const tried = [];
  for (const ua of USER_AGENTS) {
    const r = await follow(startUrl, ua, fetchImpl);
    tried.push({ ua: ua.slice(0, 20), status: r.status, url: r.url });
    if (r.url !== startUrl) return result(r.url, debug, tried);

    const fromBody = findMapsUrlInBody(r.body);
    if (fromBody) return result(fromBody, debug, tried);
    if (debug) tried[tried.length - 1].bodyHead = r.body.slice(0, 300);
  }
  // Nothing expanded: report that instead of echoing the short link back as if it worked.
  const err = new Error("Google didn't redirect this link to a map location");
  err.tried = tried;
  throw err;
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin");
    if (origin && !originAllowed(origin)) return json({ error: "Origin not allowed" }, 403, origin);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (request.method !== "GET") return json({ error: "GET only" }, 405, origin);

    const params = new URL(request.url).searchParams;
    const target = params.get("url");
    const debug = params.get("debug") === "1";
    if (!target) return json({ error: "Missing ?url=" }, 400, origin);

    let parsed;
    try { parsed = new URL(target); } catch (e) { return json({ error: "Invalid URL" }, 400, origin); }
    if (!allowed(parsed)) return json({ error: "Only Google Maps links are supported" }, 400, origin);

    try {
      return json(await resolve(parsed.toString(), fetch, debug), 200, origin);
    } catch (e) {
      return json({
        error: String(e && e.message || e),
        url: debug ? e.url : undefined,
        tried: debug && e && e.tried ? e.tried : undefined
      }, 502, origin);
    }
  }
};
