/* One-Tap Ride — shared ride storage & deep-link builder.
   Loaded by both index.html (home screen) and config.html (manage rides). */
(function (global) {
  "use strict";

  var RIDES_KEY = "one-tap-ride:rides";
  var FAMILY_PHONE_KEY = "one-tap-ride:family-phone";
  var LEGACY_TRIP_KEY = "one-tap-ride:trip";
  var HINT_KEY = "one-tap-ride:hint-dismissed";

  var RIDE_TYPES = [
    { id: "auto", label: "Auto" },
    { id: "bike", label: "Bike" },
    { id: "mini", label: "Car (Mini/Go)" },
    { id: "premier", label: "Car (Premier)" }
  ];

  function rideTypeMeta(id) {
    for (var i = 0; i < RIDE_TYPES.length; i++) {
      if (RIDE_TYPES[i].id === id) return RIDE_TYPES[i];
    }
    return RIDE_TYPES[0];
  }

  function uid() {
    return "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function validLatLng(lat, lng) {
    if (isNaN(lat) || isNaN(lng)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat: lat, lng: lng };
  }

  // Accepts either "12.9784, 77.6408" or a full Google Maps URL and returns
  // {lat, lng, name} (name only when the URL carries one) or null if nothing usable found.
  function parseLocation(value) {
    var text = String(value || "").trim();
    if (!text) return null;

    var plain = text.split(",").map(function (s) { return parseFloat(s.trim()); });
    if (plain.length === 2 && /^[-+\d.\s,]+$/.test(text)) {
      var p = validLatLng(plain[0], plain[1]);
      return p ? { lat: p.lat, lng: p.lng, name: "" } : null;
    }

    var decoded = text;
    try { decoded = decodeURIComponent(text); } catch (e) { /* keep raw */ }
    var num = "(-?\\d+(?:\\.\\d+)?)";
    // Most exact first: the pinned place (!3d..!4d..), then explicit query params, then map centre (@lat,lng).
    var patterns = [
      new RegExp("!3d" + num + "!4d" + num),
      new RegExp("[?&](?:q|ll|query|destination|daddr|saddr)=" + num + ",\\s*" + num),
      new RegExp("@" + num + ",\\s*" + num)
    ];
    for (var i = 0; i < patterns.length; i++) {
      var m = decoded.match(patterns[i]);
      if (m) {
        var pt = validLatLng(parseFloat(m[1]), parseFloat(m[2]));
        if (pt) {
          var nm = decoded.match(/\/maps\/place\/([^\/@?]+)/);
          var name = nm ? nm[1].replace(/\+/g, " ").split(",")[0].trim() : "";
          return { lat: pt.lat, lng: pt.lng, name: name };
        }
      }
    }
    return null;
  }

  function parseLatLng(value) {
    var loc = parseLocation(value);
    return loc ? { lat: loc.lat, lng: loc.lng } : null;
  }

  function migrateLegacyTrip() {
    try {
      var raw = localStorage.getItem(LEGACY_TRIP_KEY);
      if (!raw) return null;
      var t = JSON.parse(raw);
      if (!t || typeof t.pickupLat !== "number" || typeof t.dropLat !== "number") return null;

      var ride = {
        id: uid(),
        name: t.dropName || "My Ride",
        rideType: "auto",
        sourceLabel: t.pickupName || "Pickup",
        sourceLat: t.pickupLat,
        sourceLng: t.pickupLng,
        targetLabel: t.dropName || "Drop-off",
        targetLat: t.dropLat,
        targetLng: t.dropLng
      };

      if (t.phone) {
        try { localStorage.setItem(FAMILY_PHONE_KEY, t.phone); } catch (e) { /* ignore */ }
      }

      saveRides([ride]);
      return ride;
    } catch (e) {
      return null;
    }
  }

  function loadRides() {
    var rides = [];
    try {
      var raw = localStorage.getItem(RIDES_KEY);
      if (raw) rides = JSON.parse(raw) || [];
    } catch (e) {
      rides = [];
    }

    if (!rides || rides.length === 0) {
      var migrated = migrateLegacyTrip();
      if (migrated) rides = [migrated];
    }
    return rides;
  }

  function saveRides(rides) {
    try { localStorage.setItem(RIDES_KEY, JSON.stringify(rides)); } catch (e) { /* ignore */ }
  }

  function loadFamilyPhone() {
    try { return localStorage.getItem(FAMILY_PHONE_KEY) || ""; } catch (e) { return ""; }
  }

  function saveFamilyPhone(phone) {
    try { localStorage.setItem(FAMILY_PHONE_KEY, phone || ""); } catch (e) { /* ignore */ }
  }

  // Builds an Uber Universal Link deep link for a ride. No API key/token needed —
  // this hands off to the visiting phone's own Uber app with pickup/drop-off prefilled.
  // Note: Uber's public deep-link scheme has no portable "select this vehicle type"
  // parameter (that needs a real per-city product_id from Uber's gated API), so
  // rideType currently drives only the label/badge shown in this app — Uber will
  // still show its own default suggestion and the rider may need to tap to switch
  // to Auto once inside the Uber app.
  function buildDeepLink(ride) {
    var params = new URLSearchParams();
    params.set("action", "setPickup");
    params.set("pickup[latitude]", String(ride.sourceLat));
    params.set("pickup[longitude]", String(ride.sourceLng));
    if (ride.sourceLabel) params.set("pickup[nickname]", ride.sourceLabel);
    params.set("dropoff[latitude]", String(ride.targetLat));
    params.set("dropoff[longitude]", String(ride.targetLng));
    if (ride.targetLabel) params.set("dropoff[nickname]", ride.targetLabel);
    if (ride.productId) params.set("product_id", ride.productId);
    return "https://m.uber.com/ul/?" + params.toString();
  }

  global.OneTapRideStore = {
    RIDES_KEY: RIDES_KEY,
    FAMILY_PHONE_KEY: FAMILY_PHONE_KEY,
    HINT_KEY: HINT_KEY,
    RIDE_TYPES: RIDE_TYPES,
    rideTypeMeta: rideTypeMeta,
    uid: uid,
    parseLatLng: parseLatLng,
    parseLocation: parseLocation,
    loadRides: loadRides,
    saveRides: saveRides,
    loadFamilyPhone: loadFamilyPhone,
    saveFamilyPhone: saveFamilyPhone,
    buildDeepLink: buildDeepLink
  };
})(window);
