# Short-link resolver

Tiny Cloudflare Worker that turns a `maps.app.goo.gl/...` short link into the full
Google Maps URL, so One-Tap Ride can read the coordinates when you save a ride.
It only accepts Google Maps hosts.

## Deploy (one time, free tier)

```
cd worker
npx wrangler login
npx wrangler deploy
```

Wrangler prints a URL like `https://one-tap-ride-resolver.<your-subdomain>.workers.dev`.
(Or paste `worker.js` into a new Worker in the Cloudflare dashboard.)

The app ships with a default resolver URL (`DEFAULT_RESOLVER_URL` in `rides.js`). To use a different worker, paste its URL into **Short-link resolver** on **Manage rides** and Save.
The override is stored in that browser only. The worker only answers browsers on the origins listed in `ALLOWED_ORIGINS` in `worker.js`; add yours there if you host the app elsewhere.

## Check it

```
curl "https://one-tap-ride-resolver.<your-subdomain>.workers.dev/?url=https://maps.app.goo.gl/XXXX"
# -> {"lat":12.97,"lng":77.64,"name":"Place"}
# add &debug=1 to also see the expanded URL
```
