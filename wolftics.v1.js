(function () {
  // ============================================================
  // CONFIGURAÇÃO BÁSICA
  // ============================================================

  var DEFAULT_ENDPOINT = "https://api.wolftics.com/collect"; // ajuste se necessário
  var SESSION_TIMEOUT_MINUTES = 30;

  // ============================================================
  // UTILITÁRIOS
  // ============================================================

  function nowTs() {
    return Date.now();
  }

  function getTimezone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch (e) {
      return null;
    }
  }

  function getDeviceType() {
    var w = window.innerWidth || document.documentElement.clientWidth;
    if (w <= 768) return "mobile";
    if (w <= 1024) return "tablet";
    return "desktop";
  }

  function getScreenSize() {
    return (window.screen.width || 0) + "x" + (window.screen.height || 0);
  }

  function parseQuery(queryString) {
    var params = {};
    if (!queryString) return params;
    queryString
      .replace(/^\?/, "")
      .split("&")
      .forEach(function (part) {
        if (!part) return;
        var s = part.split("=");
        var key = decodeURIComponent(s[0] || "");
        var val = decodeURIComponent(s[1] || "");
        if (!key) return;
        params[key] = val;
      });
    return params;
  }

  function getUtmParams() {
    var params = parseQuery(window.location.search || "");
    return {
      utm_source: params.utm_source || null,
      utm_medium: params.utm_medium || null,
      utm_campaign: params.utm_campaign || null,
      utm_term: params.utm_term || null,
      utm_content: params.utm_content || null
    };
  }

  function tryLocalStorageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function tryLocalStorageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (e) {
      // ignore
    }
  }

  function uuid4() {
    // simples e suficiente para identidades de visitante/sessão
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0,
        v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function findCurrentScript() {
    // Tenta document.currentScript, fallback para query
    if (document.currentScript) return document.currentScript;
    var scripts = document.getElementsByTagName("script");
    for (var i = scripts.length - 1; i >= 0; i--) {
      if (scripts[i].getAttribute("data-wolftics") === "true") {
        return scripts[i];
      }
    }
    return scripts[scripts.length - 1] || null;
  }

  // ============================================================
  // ESTADO INTERNO
  // ============================================================

  var scriptTag = findCurrentScript();
  if (!scriptTag) {
    console.warn("[Wolftics] Script tag não encontrado.");
    return;
  }

  var PROPERTY_KEY =
    scriptTag.getAttribute("data-key") ||
    scriptTag.getAttribute("data-property-key") ||
    null;

  if (!PROPERTY_KEY) {
    console.warn("[Wolftics] data-key não informado no script.");
    return;
  }

  var CUSTOM_ENDPOINT = scriptTag.getAttribute("data-endpoint");
  var ENDPOINT = CUSTOM_ENDPOINT || DEFAULT_ENDPOINT;

  var AUTO_PAGEVIEW = scriptTag.getAttribute("data-auto-pageview");
  var AUTO_SPA = scriptTag.getAttribute("data-spa");

  AUTO_PAGEVIEW = AUTO_PAGEVIEW === "false" ? false : true;
  AUTO_SPA = AUTO_SPA === "true";

  var STORAGE_VISITOR_KEY = "wolftics:visitorId";
  var STORAGE_SESSION_ID = "wolftics:sessionId";
  var STORAGE_SESSION_TS = "wolftics:sessionLastTs";
  var STORAGE_USER_ID = "wolftics:userId";
  var STORAGE_USER_TRAITS = "wolftics:userTraits";

  var visitorId = tryLocalStorageGet(STORAGE_VISITOR_KEY);
  if (!visitorId) {
    visitorId = uuid4();
    tryLocalStorageSet(STORAGE_VISITOR_KEY, visitorId);
  }

  // Carregar userId / traits, se existirem
  var currentUserId = tryLocalStorageGet(STORAGE_USER_ID);
  var currentUserTraitsRaw = tryLocalStorageGet(STORAGE_USER_TRAITS);
  var currentUserTraits = null;
  if (currentUserTraitsRaw) {
    try {
      currentUserTraits = JSON.parse(currentUserTraitsRaw);
    } catch (e) {
      currentUserTraits = null;
    }
  }

  // Sessão
  function ensureSession() {
    var sessionId = tryLocalStorageGet(STORAGE_SESSION_ID);
    var lastTs = tryLocalStorageGet(STORAGE_SESSION_TS);
    var now = nowTs();

    var shouldStartNewSession = false;

    if (!sessionId || !lastTs) {
      shouldStartNewSession = true;
    } else {
      var diffMinutes = (now - parseInt(lastTs, 10)) / 1000 / 60;
      if (diffMinutes > SESSION_TIMEOUT_MINUTES) {
        shouldStartNewSession = true;
      }
    }

    if (shouldStartNewSession) {
      sessionId = uuid4();
    }

    tryLocalStorageSet(STORAGE_SESSION_ID, sessionId);
    tryLocalStorageSet(STORAGE_SESSION_TS, String(now));
    return sessionId;
  }

  var sessionId = ensureSession();

  function refreshSessionActivity() {
    sessionId = ensureSession();
  }

  // ============================================================
  // FILA / ENVIO
  // ============================================================

  var eventQueue = [];
  var isSending = false;

  function sendPayload(payload, useBeacon) {
    // Tenta sendBeacon para eventos em unload
    if (useBeacon && navigator && navigator.sendBeacon) {
      try {
        var blob = new Blob([JSON.stringify(payload)], {
          type: "application/json"
        });
        return navigator.sendBeacon(ENDPOINT, blob);
      } catch (e) {
        // fallback
      }
    }

    return fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify(payload)
    });
  }

  function processQueue() {
    if (isSending) return;
    if (!eventQueue.length) return;
    isSending = true;

    var batch = eventQueue.slice(0, 10); // batch de até 10 eventos
    var body = {
      propertyKey: PROPERTY_KEY,
      batch: batch
    };

    sendPayload(body, false)
      .then(function (resp) {
        if (!resp || (resp.status && resp.status >= 400)) {
          // falha, não consome a fila (tentará depois)
          isSending = false;
          return;
        }
        // remove eventos enviados
        eventQueue = eventQueue.slice(batch.length);
        isSending = false;
        if (eventQueue.length) processQueue();
      })
      .catch(function () {
        // falha, mantém fila
        isSending = false;
      });
  }

  function enqueueEvent(evt) {
    eventQueue.push(evt);
    refreshSessionActivity();
    // dispatch assíncrono leve
    if (document.visibilityState === "visible") {
      setTimeout(processQueue, 100);
    }
  }

  // ============================================================
  // CONSTRUÇÃO DOS EVENTOS
  // ============================================================

  function baseEvent(eventType, payload) {
    var loc = window.location;
    var utm = getUtmParams();

    return {
      eventType: eventType,
      payload: payload || {},
      context: {
        url: loc.href,
        path: loc.pathname,
        title: document.title || null,
        referrer: document.referrer || null,
        utm: utm,
        language: navigator.language || null,
        timezone: getTimezone(),
        device: getDeviceType(),
        screen: getScreenSize(),
        userAgent: navigator.userAgent || null
      },
      identity: {
        visitorId: visitorId,
        sessionId: sessionId,
        userId: currentUserId || null,
        userTraits: currentUserTraits || null
      },
      ts: nowTs()
    };
  }

  function trackEvent(name, payload) {
    if (!name || typeof name !== "string") {
      console.warn("[Wolftics] track chamado sem nome de evento válido.");
      return;
    }
    var evt = baseEvent(name, payload);
    enqueueEvent(evt);
  }

  function trackPageView(extraPayload) {
    var payload = extraPayload || {};
    trackEvent("page_view", payload);
  }

  function identifyUser(userId, traits) {
    if (!userId) {
      console.warn("[Wolftics] identify chamado sem userId.");
      return;
    }
    currentUserId = String(userId);

    if (traits && typeof traits === "object") {
      currentUserTraits = traits;
      tryLocalStorageSet(STORAGE_USER_TRAITS, JSON.stringify(traits));
    }

    tryLocalStorageSet(STORAGE_USER_ID, currentUserId);

    // Envia um evento de identify para o backend, se quiser
    var evt = baseEvent("identify", {
      userId: currentUserId,
      traits: currentUserTraits
    });
    enqueueEvent(evt);
  }

  // ============================================================
  // SUPORTE A SPA (opcional)
  // ============================================================

  function hookSpaNavigation() {
    if (!AUTO_SPA) return;
    // Monkey patch do history.pushState e replaceState
    var _pushState = history.pushState;
    var _replaceState = history.replaceState;

    function onRouteChange() {
      // pequeno debounce
      setTimeout(function () {
        trackPageView();
      }, 50);
    }

    history.pushState = function () {
      _pushState.apply(history, arguments);
      onRouteChange();
    };

    history.replaceState = function () {
      _replaceState.apply(history, arguments);
      onRouteChange();
    };

    window.addEventListener("popstate", onRouteChange);
  }

  // ============================================================
  // EXPOSIÇÃO PÚBLICA
  // ============================================================

  var api = {
    track: trackEvent,
    page: trackPageView,
    identify: identifyUser,
    getVisitorId: function () {
      return visitorId;
    },
    getSessionId: function () {
      return sessionId;
    },
    _debugQueue: function () {
      return eventQueue.slice();
    }
  };

  // Evitar conflito se já existir
  if (!window.wolftics) {
    window.wolftics = api;
  } else {
    console.warn("[Wolftics] window.wolftics já definido. Não sobrescrevendo.");
  }

  // ============================================================
  // EVENTOS DE CICLO DE VIDA
  // ============================================================

  // Pageview automático
  if (AUTO_PAGEVIEW) {
    trackPageView();
  }

  // SPA
  hookSpaNavigation();

  // Tentar enviar fila em mudanças de visibilidade (aba perde foco, fecha etc.)
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible") {
      if (eventQueue.length) {
        var body = {
          propertyKey: PROPERTY_KEY,
          batch: eventQueue.slice(0)
        };
        // tenta beacon, se não der, simplesmente deixa a fila (não é crítico)
        sendPayload(body, true);
        eventQueue = [];
      }
    } else {
      // Quando volta a ficar visível, tenta reenviar se ainda houver eventos
      if (eventQueue.length) {
        processQueue();
      }
    }
  });
})();
