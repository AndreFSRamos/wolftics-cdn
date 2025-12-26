(function () {
  "use strict";

  // ============================================================
  // CONFIGURAÇÕES
  // ============================================================

  var DEFAULT_ENDPOINT = "https://api.wolftics.com/collect";
  var SESSION_TIMEOUT_MINUTES = 30;
  var MAX_QUEUE_SIZE = 50;
  var BATCH_SIZE = 10;

  // ============================================================
  // EVENT SPEC v1 (NORMALIZADO)
  // ============================================================

  var EVENTS = {
    PAGE_VIEW: "page_view",
    VIEW_PRODUCT: "view_product",
    ADD_TO_CART: "add_to_cart",
    BEGIN_CHECKOUT: "begin_checkout",
    PURCHASE: "purchase",
    IDENTIFY: "identify"
  };

  var ALLOWED_EVENTS = Object.values(EVENTS);

  // ============================================================
  // UTILITÁRIOS
  // ============================================================

  function nowTs() {
    return Date.now();
  }

  function assert(condition, message) {
    if (!condition) {
      console.warn("[Wolftics][ASSERT]", message);
      return false;
    }
    return true;
  }

  function uuid4() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function tryGetLS(key) {
    try {
      return localStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  function trySetLS(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (_) {}
  }

  // ============================================================
  // SCRIPT CONFIG
  // ============================================================

  var script = document.currentScript;
  if (!script) {
    console.warn("[Wolftics] Script tag not found");
    return;
  }

  var PROPERTY_KEY = script.getAttribute("data-id");
  if (!PROPERTY_KEY) {
    console.warn("[Wolftics] data-id (scriptToken) is required");
    return;
  }

  var ENDPOINT = script.getAttribute("data-endpoint") || DEFAULT_ENDPOINT;

  // ============================================================
  // IDENTIDADE
  // ============================================================

  var VISITOR_KEY = "wolftics:visitor";
  var SESSION_KEY = "wolftics:session";
  var SESSION_TS_KEY = "wolftics:session_ts";
  var USER_KEY = "wolftics:user";

  var visitorId = tryGetLS(VISITOR_KEY) || uuid4();
  trySetLS(VISITOR_KEY, visitorId);

  function ensureSession() {
    var now = nowTs();
    var lastTs = parseInt(tryGetLS(SESSION_TS_KEY) || "0", 10);
    var sessionId = tryGetLS(SESSION_KEY);

    if (!sessionId || (now - lastTs) / 60000 > SESSION_TIMEOUT_MINUTES) {
      sessionId = uuid4();
    }

    trySetLS(SESSION_KEY, sessionId);
    trySetLS(SESSION_TS_KEY, String(now));
    return sessionId;
  }

  var sessionId = ensureSession();

  // ============================================================
  // FILA DE EVENTOS
  // ============================================================

  var queue = [];
  var sending = false;

  function enqueue(evt) {
    if (queue.length >= MAX_QUEUE_SIZE) {
      console.warn("[Wolftics] Queue limit reached, dropping event");
      return;
    }
    queue.push(evt);
    if (!sending) flush();
  }

  function flush() {
    if (!queue.length) return;

    sending = true;

    var batch = queue.splice(0, BATCH_SIZE);

    fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify({
        propertyKey: PROPERTY_KEY,
        batch: batch
      })
    })
      .then(function (res) {
        if (!res.ok) {
          console.warn("[Wolftics] Failed to send events", res.status);
          queue.unshift.apply(queue, batch);
        }
      })
      .catch(function () {
        queue.unshift.apply(queue, batch);
      })
      .finally(function () {
        sending = false;
        if (queue.length) setTimeout(flush, 200);
      });
  }

  // ============================================================
  // CONSTRUÇÃO DE EVENTO
  // ============================================================

  function buildEvent(type, payload) {
    if (!assert(ALLOWED_EVENTS.includes(type), "Invalid eventType: " + type)) {
      return null;
    }

    sessionId = ensureSession();

    return {
      eventType: type,
      payload: payload || {},
      context: {
        url: location.href,
        path: location.pathname,
        referrer: document.referrer || null,
        language: navigator.language || null,
        userAgent: navigator.userAgent || null
      },
      identity: {
        visitorId: visitorId,
        sessionId: sessionId,
        userId: tryGetLS(USER_KEY)
      },
      ts: nowTs()
    };
  }

  // ============================================================
  // API PÚBLICA
  // ============================================================

  function track(type, payload) {
    var evt = buildEvent(type, payload);
    if (evt) enqueue(evt);
  }

  function identify(userId) {
    if (!assert(userId, "identify requires userId")) return;
    trySetLS(USER_KEY, String(userId));
    track(EVENTS.IDENTIFY, { userId: userId });
  }

  function page() {
    track(EVENTS.PAGE_VIEW);
  }

  // ============================================================
  // AUTO EVENTS
  // ============================================================

  page();

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible") {
      flush();
    }
  });

  // ============================================================
  // EXPOSIÇÃO GLOBAL
  // ============================================================

  window.wolftics = {
    track: track,
    page: page,
    identify: identify,
    events: EVENTS
  };
})();
