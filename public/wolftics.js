(function () {
  "use strict";

  var DEFAULT_ENDPOINT = "https://api.wolftics.com/collect";
  var SESSION_TIMEOUT_MINUTES = 30;
  var MAX_QUEUE_SIZE = 500;
  var MAX_PERSISTED_EVENTS = 800;
  var BATCH_SIZE = 20;
  var FLUSH_INTERVAL_MS = 2000;
  var REQUEST_TIMEOUT_MS = 8000;
  var MAX_RETRY_DELAY_MS = 30000;
  var INITIAL_RETRY_DELAY_MS = 1000;
  var HEARTBEAT_SECONDS = 15;
  var ENABLE_SCROLL_DEPTH = true;
  var ENABLE_HEARTBEAT = true;
  var ENABLE_EXIT_EVENT = true;

  var EVENTS = {
    PAGE_VIEW: "page_view",
    VIEW_PRODUCT: "view_product",
    ADD_TO_CART: "add_to_cart",
    BEGIN_CHECKOUT: "begin_checkout",
    PURCHASE: "purchase",
    IDENTIFY: "identify",
    SCROLL_DEPTH: "scroll_depth",
    TIME_ON_PAGE: "time_on_page",
    CTA_CLICK: "cta_click",
    EXIT_PAGE: "exit_page",
    CAMPAIGN_VIEW: "campaign_view"
  };

  var ALLOWED_EVENTS = Object.values(EVENTS);

  function nowTs() { return Date.now(); }

  function uuid4() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function tryGetLS(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }
  function trySetLS(key, value) {
    try { localStorage.setItem(key, value); } catch (_) {}
  }
  function tryRemoveLS(key) {
    try { localStorage.removeItem(key); } catch (_) {}
  }

  function assert(condition, message) {
    if (!condition) {
      console.warn("[Wolftics][ASSERT]", message);
      return false;
    }
    return true;
  }

  function safeString(v, maxLen) {
    try {
      if (v == null) return null;
      var s = String(v);
      if (maxLen && s.length > maxLen) return s.slice(0, maxLen);
      return s;
    } catch (_) {
      return null;
    }
  }

  var script = document.currentScript;
  if (!script) {
    var scripts = document.getElementsByTagName("script");
    script = scripts && scripts.length ? scripts[scripts.length - 1] : null;
  }
  if (!script) {
    console.warn("[Wolftics] Script tag not found");
    return;
  }

  var PROPERTY_KEY = script.getAttribute("data-id");
  if (!PROPERTY_KEY) {
    console.warn("[Wolftics] data-id is required");
    return;
  }

  var ENDPOINT = script.getAttribute("data-endpoint") || DEFAULT_ENDPOINT;
  var AUTO_PAGEVIEW = script.getAttribute("data-auto-pageview") !== "false";
  var IS_SPA = script.getAttribute("data-spa") === "true";
  var VISITOR_KEY = "wolftics:visitor";
  var SESSION_KEY = "wolftics:session";
  var SESSION_TS_KEY = "wolftics:session_ts";
  var USER_KEY = "wolftics:user";
  var QUEUE_PERSIST_KEY = "wolftics:q:" + PROPERTY_KEY;
  var visitorId = tryGetLS(VISITOR_KEY) || uuid4();

  trySetLS(VISITOR_KEY, visitorId);

  function ensureSession() {
    var now = nowTs();
    var lastTs = parseInt(tryGetLS(SESSION_TS_KEY) || "0", 10);
    var sessionId = tryGetLS(SESSION_KEY);

    if (!sessionId || (now - lastTs) / 60000 > SESSION_TIMEOUT_MINUTES) { sessionId = uuid4(); }

    trySetLS(SESSION_KEY, sessionId);
    trySetLS(SESSION_TS_KEY, String(now));
    return sessionId;
  }

  var sessionId = ensureSession();

  function getTimezone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; }
    catch (_) { return null; }
  }

  function getDeviceType() {
    try {
      var w = Math.min(window.screen.width, window.screen.height);
      if (w <= 767) return "mobile";
      if (w <= 1024) return "tablet";
      return "desktop";
    } catch (_) {
      return "desktop";
    }
  }

  function extractUTMs() {
    try {
      var params = new URLSearchParams(location.search);
      return {
        source: params.get("utm_source"),
        medium: params.get("utm_medium"),
        campaign: params.get("utm_campaign"),
        term: params.get("utm_term"),
        content: params.get("utm_content")
      };
    } catch (_) {
      return { source: null, medium: null, campaign: null, term: null, content: null };
    }
  }

  function hasAnyUtm(c) { return !!(c && (c.source || c.medium || c.campaign || c.term || c.content)); }

  function buildContext() {
    var campaign = extractUTMs();
    return {
      url: safeString(location.href, 2048),
      path: safeString(location.pathname, 512),
      referrer: safeString(document.referrer || null, 2048),
      title: safeString(document.title || null, 256),
      language: safeString(navigator.language || null, 32),
      timezone: safeString(getTimezone(), 64),
      screen: {
        w: window.screen && window.screen.width ? window.screen.width : null,
        h: window.screen && window.screen.height ? window.screen.height : null
      },
      device: {
        type: getDeviceType(),
        platform: safeString(navigator.platform || null, 64)
      },
      page: {
        isSpa: !!IS_SPA,
        route: null
      },
      campaign: {
        source: safeString(campaign.source, 128),
        medium: safeString(campaign.medium, 128),
        campaign: safeString(campaign.campaign, 256),
        term: safeString(campaign.term, 256),
        content: safeString(campaign.content, 256)
      }
    };
  }

  var queue = [];
  var sending = false;
  var retryDelay = INITIAL_RETRY_DELAY_MS;
  var nextFlushAt = 0;

  function loadPersistedQueue() {
    var raw = tryGetLS(QUEUE_PERSIST_KEY);
    if (!raw) return [];
    try {
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (_) {
      return [];
    }
  }

  function persistQueue() {
    var trimmed = queue.slice(-MAX_PERSISTED_EVENTS);
    trySetLS(QUEUE_PERSIST_KEY, JSON.stringify(trimmed));
  }

  function clearPersistedQueue() { tryRemoveLS(QUEUE_PERSIST_KEY); }

  (function bootstrapQueue() {
    var persisted = loadPersistedQueue();
    if (persisted.length) {
      queue = persisted.slice(-MAX_QUEUE_SIZE);
    }
  })();

  function enqueue(evt) {
    if (queue.length >= MAX_QUEUE_SIZE) { queue.shift(); }
    queue.push(evt);
    persistQueue();
  }

  function requeueFront(batch) {
    try {
      queue = batch.concat(queue);
      if (queue.length > MAX_QUEUE_SIZE) { queue = queue.slice(-MAX_QUEUE_SIZE); }
      persistQueue();
    } catch (_) {}
  }

  function jitter(ms) {
    var delta = Math.floor(ms * 0.2);
    return ms + (Math.floor(Math.random() * (delta * 2 + 1)) - delta);
  }

  function isTransientHttp(status) {
    if (status === 408 || status === 429) return true;
    if (status >= 500 && status <= 599) return true;
    return false;
  }

  function shouldRetryRejectedReason(reason) { return reason === "PUBLISH_FAILED"; }

  function fetchWithTimeout(url, opts, timeoutMs) {
    var controller = null;
    var t = null;

    if (typeof AbortController !== "undefined") {
      controller = new AbortController();
      opts.signal = controller.signal;
      t = setTimeout(function () {
        try { controller.abort(); } catch (_) {}
      }, timeoutMs);
    }

    return fetch(url, opts).finally(function () {
      if (t) clearTimeout(t);
    });
  }

  function isSameOriginEndpoint(url) {
    try {
      return new URL(url, location.href).origin === location.origin;
    } catch (_) {
      return false;
    }
  }

  function flush(options) {
    options = options || {};
    var force = !!options.force;
    var useBeacon = !!options.beacon;

    if (useBeacon && !isSameOriginEndpoint(ENDPOINT)) { useBeacon = false; }

    if (sending) return;
    if (queue.length === 0) {
      clearPersistedQueue();
      retryDelay = INITIAL_RETRY_DELAY_MS;
      return;
    }

    var now = nowTs();
    if (!force && now < nextFlushAt) return;

    sending = true;

    var batch = queue.splice(0, BATCH_SIZE);
    persistQueue();

    var payload = JSON.stringify({
      propertyKey: PROPERTY_KEY,
      batch: batch
    });

    if (useBeacon && navigator.sendBeacon) {
      try {
        var blob = new Blob([payload], { type: "application/json" });
        var ok = navigator.sendBeacon(ENDPOINT, blob);
        if (!ok) {
          requeueFront(batch);
          scheduleRetry();
        } else {
          retryDelay = INITIAL_RETRY_DELAY_MS;
        }
      } catch (_) {
        requeueFront(batch);
        scheduleRetry();
      } finally {
        sending = false;
      }
      return;
    }

    fetchWithTimeout(ENDPOINT, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: payload
    }, REQUEST_TIMEOUT_MS)
      .then(function (res) {
        if (!res) {
          requeueFront(batch);
          scheduleRetry();
          return;
        }

        if (!res.ok) {
          if (isTransientHttp(res.status)) {
            requeueFront(batch);
            scheduleRetry();
          } else {
            retryDelay = INITIAL_RETRY_DELAY_MS;
          }
          return;
        }

        return res.json().then(function (data) {
          if (!data || !data.rejections || !Array.isArray(data.rejections) || data.rejections.length === 0) {
            retryDelay = INITIAL_RETRY_DELAY_MS;
            return;
          }

          var toRetry = [];
          for (var i = 0; i < data.rejections.length; i++) {
            var r = data.rejections[i];
            if (!r) continue;

            var idx = r.index;
            var reason = r.reason;

            if (typeof idx === "number" && idx >= 0 && idx < batch.length) {
              if (shouldRetryRejectedReason(reason)) {
                toRetry.push(batch[idx]);
              }
            }
          }

          if (toRetry.length) {
            requeueFront(toRetry);
            scheduleRetry();
          } else {
            retryDelay = INITIAL_RETRY_DELAY_MS;
          }
        }).catch(function () {
          retryDelay = INITIAL_RETRY_DELAY_MS;
        });
      })
      .catch(function () {
        requeueFront(batch);
        scheduleRetry();
      })
      .finally(function () {
        sending = false;
        if (queue.length >= BATCH_SIZE) { setTimeout(function () { flush({ force: true }); }, 0); }
      });
  }

  function scheduleRetry() {
    var d = Math.min(MAX_RETRY_DELAY_MS, retryDelay);
    nextFlushAt = nowTs() + jitter(d);
    retryDelay = Math.min(MAX_RETRY_DELAY_MS, retryDelay * 2);
  }

  var flushTimer = setInterval(function () {
    flush();
  }, FLUSH_INTERVAL_MS);

  window.addEventListener("online", function () {
    retryDelay = INITIAL_RETRY_DELAY_MS;
    nextFlushAt = 0;
    flush({ force: true });
  });

  function buildEvent(type, payload) {
    if (!assert(ALLOWED_EVENTS.includes(type), "Invalid eventType: " + type)) return null;

    sessionId = ensureSession();

    return {
      eventId: uuid4(),
      eventType: type,
      payload: payload || {},
      context: buildContext(),
      identity: {
        visitorId: visitorId,
        sessionId: sessionId,
        userId: tryGetLS(USER_KEY)
      },
      ts: nowTs()
    };
  }

  function track(type, payload) {
    var evt = buildEvent(type, payload);
    if (!evt) return;

    enqueue(evt);

    if (queue.length >= BATCH_SIZE) flush({ force: true });
  }

  function identify(userId, meta) {
    if (!assert(userId, "identify requires userId")) return;

    trySetLS(USER_KEY, String(userId));

    var payload = { userId: String(userId) };
    if (meta && typeof meta === "object") {
      if (meta.email) payload.email = safeString(meta.email, 150);
      if (meta.phone) payload.phone = safeString(meta.phone, 50);
    }
    track(EVENTS.IDENTIFY, payload);
  }

  function page(route) {
    var evt = buildEvent(EVENTS.PAGE_VIEW, {});
    if (!evt) return;

    if (route) evt.context.page.route = safeString(route, 512);
    enqueue(evt);

    if (hasAnyUtm(evt.context.campaign)) { track(EVENTS.CAMPAIGN_VIEW, {}); }

    if (queue.length >= BATCH_SIZE) flush({ force: true });
  }

  if (AUTO_PAGEVIEW) page(null);

  var sentScrollPercents = {};
  function handleScrollDepth() {
    if (!ENABLE_SCROLL_DEPTH) return;

    try {
      var doc = document.documentElement || document.body;
      var scrollTop = window.pageYOffset || doc.scrollTop || 0;
      var scrollHeight = doc.scrollHeight || 1;
      var clientHeight = doc.clientHeight || window.innerHeight || 1;

      var total = Math.max(scrollHeight - clientHeight, 1);
      var pct = Math.floor((scrollTop / total) * 100);

      var thresholds = [25, 50, 75, 100];
      for (var i = 0; i < thresholds.length; i++) {
        var t = thresholds[i];
        if (pct >= t && !sentScrollPercents[t]) {
          sentScrollPercents[t] = true;
          track(EVENTS.SCROLL_DEPTH, { percent: t });
        }
      }
    } catch (_) {}
  }

  if (ENABLE_SCROLL_DEPTH) {
    window.addEventListener("scroll", handleScrollDepth, { passive: true });
  }

  document.addEventListener("click", function (e) {
    try {
      var el = e.target;
      while (el && el !== document.documentElement) {
        if (el.getAttribute && el.getAttribute("data-wolf-cta")) {
          var ctaId = el.getAttribute("data-wolf-cta");
          var text = el.textContent ? el.textContent.trim() : null;
          var href = el.getAttribute("href") || null;

          track(EVENTS.CTA_CLICK, {
            ctaId: safeString(ctaId, 128),
            text: safeString(text, 120),
            href: safeString(href, 512)
          });
          break;
        }
        el = el.parentNode;
      }
    } catch (_) {}
  });

  var pageStartTs = nowTs();
  var lastHeartbeatSeconds = 0;

  function heartbeat() {
    if (!ENABLE_HEARTBEAT) return;

    var elapsed = Math.floor((nowTs() - pageStartTs) / 1000);
    if (elapsed <= 0) return;

    if (elapsed - lastHeartbeatSeconds >= HEARTBEAT_SECONDS) {
      lastHeartbeatSeconds = elapsed;
      track(EVENTS.TIME_ON_PAGE, { seconds: elapsed });
    }
  }

  var heartbeatTimer = null;
  if (ENABLE_HEARTBEAT) {
    heartbeatTimer = setInterval(heartbeat, 1000);
  }

  function onExit(reason) {
    try {
      if (ENABLE_EXIT_EVENT) {
        var elapsed = Math.floor((nowTs() - pageStartTs) / 1000);
        if (elapsed > 0) track(EVENTS.TIME_ON_PAGE, { seconds: elapsed });
        track(EVENTS.EXIT_PAGE, { reason: reason || "unload" });
      }
    } catch (_) {}

    flush({ force: true, beacon: true });
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible") onExit("hidden");
  });

  window.addEventListener("pagehide", function () { onExit("pagehide"); });

  window.addEventListener("beforeunload", function () { onExit("unload"); });

  window.wolftics = {
    track: track,
    page: page,
    identify: identify,
    events: EVENTS,
    flush: function () { flush({ force: true }); }
  };
})();
