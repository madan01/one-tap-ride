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
  if (ALLOWED_ORIGINS.indexOf(origin) !== -1) return true;
  // Local dev server, also when opened from a phone on the same Wi-Fi (private LAN addresses).
  return /^http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/.test(origin);
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
      if (current.searchParams.get("ftid") || extractLocation(current.toString())) {
        return { url: current.toString(), status: res.status, body: "" };
      }
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

// Links that carry a place name but no coordinates (?q=Some+Place&ftid=0x..:0x..): Google's place-data
// endpoint returns the exact pin for that ftid as [null,null,LAT,LNG],"<ftid>". One direct request,
// no page and no redirect chain. Returns null if Google refuses (e.g. it throttles some IPs).
async function locationFromFtid(url, ua, fetchImpl, tried) {
  const u = new URL(url);
  const ftid = u.searchParams.get("ftid");
  if (!ftid || !/^0x[0-9a-f]+:0x[0-9a-f]+$/i.test(ftid)) return null;
  const api = "https://www.google.com/maps/preview/place?authuser=0&hl=en&gl=in&pb=" + encodeURIComponent("!1m1!1s" + ftid);
  const res = await fetchImpl(api, { headers: { "User-Agent": ua, "Accept-Language": "en" } });
  if (tried) tried.push({ step: "place-data", status: res.status });
  if (!res.ok) return null;
  const text = await res.text();
  const re = /\[null,null,(-?\d+\.\d+),(-?\d+\.\d+)\],"(0x[0-9a-f]+:0x[0-9a-f]+)"/g;
  let mm;
  while ((mm = re.exec(text))) {
    if (mm[3].toLowerCase() !== ftid.toLowerCase()) continue;   // only the exact place
    const lat = parseFloat(mm[1]), lng = parseFloat(mm[2]);
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat, lng, name: placeNameFromQuery(u) };
  }
  return null;
}

function placeNameFromQuery(u) {
  const q = u.searchParams.get("q") || "";
  return /^[-+\d.,\s]*$/.test(q) ? "" : q.split(",")[0].trim();
}

// Last resort when Google won't give the pin: geocode the place text with OpenStreetMap (Nominatim).
// Fine for well-known buildings, but can land on the neighbourhood, so callers must flag it approximate.
async function geocodeByName(url, fetchImpl, tried) {
  const u = new URL(url);
  const q = u.searchParams.get("q") || "";
  if (!q || /^[-+\d.,\s]*$/.test(q)) return null;
  const parts = q.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  const name = parts[0];
  const variants = [q, name + ", " + parts.slice(-3, -1).join(", "), name].filter(function (v, i, a) { return v && a.indexOf(v) === i; });
  for (const query of variants) {
    const res = await fetchImpl("https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=" + encodeURIComponent(query), {
      headers: { "User-Agent": "one-tap-ride-resolver/1.0 (personal app)", "Accept-Language": "en" }
    });
    if (tried) tried.push({ step: "nominatim", query: query.slice(0, 60), status: res.status });
    if (!res.ok) return null;
    const hits = await res.json();
    if (hits && hits[0]) {
      const lat = parseFloat(hits[0].lat), lng = parseFloat(hits[0].lon);
      if (!isNaN(lat) && !isNaN(lng)) return { lat, lng, name: placeNameFromQuery(u) };
    }
  }
  return null;
}

function output(loc, url, debug, tried, approx) {
  const out = { lat: loc.lat, lng: loc.lng, name: loc.name };
  if (approx) out.approx = true;
  if (debug) { out.url = url; out.tried = tried; }
  return out;
}

async function resolve(startUrl, fetchImpl, debug) {
  const tried = [];
  let lastUrl = startUrl;
  for (const ua of USER_AGENTS) {
    const r = await follow(startUrl, ua, fetchImpl);
    tried.push({ ua: ua.slice(0, 20), status: r.status, url: r.url });
    lastUrl = r.url;

    // 1. coordinates in the URL, 2. exact pin from Google's place data (name-only links),
    // 3. a Maps URL embedded in the page (interstitial), 4. approximate OpenStreetMap match.
    let loc = extractLocation(r.url);
    if (!loc) {
      try { loc = await locationFromFtid(r.url, ua, fetchImpl, tried); } catch (e) { loc = null; }
    }
    if (loc) return output(loc, r.url, debug, tried, false);

    const fromBody = findMapsUrlInBody(r.body);
    loc = fromBody && extractLocation(fromBody);
    if (loc) return output(loc, fromBody, debug, tried, false);

    try { loc = await geocodeByName(r.url, fetchImpl, tried); } catch (e) { loc = null; }
    if (loc) return output(loc, r.url, debug, tried, true);

    if (debug) tried[tried.length - 1].bodyHead = r.body.slice(0, 300);
    if (r.url !== startUrl) break;   // the link did expand; other user-agents won't add coordinates
  }
  const err = new Error("Couldn't find coordinates for that Google Maps link");
  err.tried = tried;
  err.url = lastUrl;
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
