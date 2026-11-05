/*
 * tv-inicio · pantalla de inicio (se carga dentro de TizenBrew).
 * Habla con el servicio del módulo (http://127.0.0.1:8090/local/*) y, para abrir YouTube sin
 * anuncios, con TizenBrew (ws://127.0.0.1:8081), que inyecta TizenTube en youtube.com/tv.
 * ES5 a propósito: el navegador de Tizen 4 es un Chromium de 2017.
 */
(function () {
  'use strict';

  var API = 'http://127.0.0.1:8090';
  var TIZENBREW_WS = 'ws://127.0.0.1:8081';
  var TIZENTUBE = 'npm/@foxreis/tizentube';
  var YOUTUBE_NATIVA = '111299001912';

  var DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  var MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
    'septiembre', 'octubre', 'noviembre', 'diciembre'];
  var FONDOS = [
    ['fondos/01-matterhorn.jpg', 'Matterhorn, Suiza · Liridon · CC BY-SA 4.0'],
    ['fondos/02-matterhorn-atardecer.jpg', 'Matterhorn al atardecer, Suiza · Sam Ferrara · CC0'],
    ['fondos/03-gornergrat.jpg', 'Gornergrat, Zermatt, Suiza · Tobi 87 · CC BY-SA 3.0'],
    ['fondos/04-reine.jpg', 'Reine, Lofoten, Noruega · Ximonic · CC BY-SA 4.0'],
    ['fondos/05-geiranger.jpg', 'Geirangerfjord, Noruega · Diego Delso · CC BY-SA 4.0'],
    ['fondos/06-senja.jpg', 'Ersfjorden, Senja, Noruega · Ximonic · CC BY-SA 3.0'],
    ['fondos/07-peyto.jpg', 'Lago Peyto, Banff, Canadá · Tobi 87 · CC BY-SA 4.0'],
    ['fondos/08-moraine.jpg', 'Lago Moraine, Banff, Canadá · Gorgo · Dominio público']
  ];
  var NOMBRES = {
    youtube: 'YouTube', '11101200001': 'Netflix', '3201512006785': 'Prime Video', tv: 'TV',
    jellyfin: 'Jellyfin', 'org.tizen.browser': 'Navegador', hdmi1: 'Consola', hdmi2: 'HDMI 2',
    hdmi3: 'HDMI 3', ajustes: 'Ajustes'
  };
  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, ESC: 27, BACKSPACE: 8, RED: 403 };

  var state = { night: true, blocked: {}, timer: null, servicio: false, warnDismissed: 0, abriendo: false };
  var screen = document.getElementById('screen');
  var allapps = document.getElementById('allapps');
  var warn = document.getElementById('warn');

  function $(id) { return document.getElementById(id); }
  function toArray(list) { return Array.prototype.slice.call(list); }

  // ---------- Servicio ----------
  function api(ruta, body) {
    var opts = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) };
    return fetch(API + ruta, opts).then(function (r) { return r.json(); });
  }
  function logServicio(msg) {
    try { api('/local/log', { msg: msg }).catch(function () {}); } catch (e) { /* sin servicio */ }
  }
  window.onerror = function (msg, src, line) { logServicio('error JS: ' + msg + ' (' + src + ':' + line + ')'); };

  // ---------- Escalado (por si la tele no da 1920 px de ancho) ----------
  function fit() {
    var k = window.innerWidth / 1920;
    screen.style.transform = k === 1 ? '' : 'scale(' + k + ')';
  }
  window.addEventListener('resize', fit);
  fit();

  // ---------- Reloj ----------
  var lastMinute = -1;
  function dos(n) { return n < 10 ? '0' + n : String(n); }
  function tick() {
    var d = new Date();
    if (d.getMinutes() !== lastMinute) {
      lastMinute = d.getMinutes();
      $('time').textContent = dos(d.getHours()) + ':' + dos(d.getMinutes());
      var dia = DIAS[d.getDay()];
      $('date').innerHTML = dia.charAt(0).toUpperCase() + dia.slice(1) + ' <b>' + d.getDate() + '</b> ' +
        MESES[d.getMonth()].charAt(0).toUpperCase() + MESES[d.getMonth()].slice(1);
    }
    revisarAviso();
  }
  setInterval(tick, 1000);
  tick();

  // ---------- Fondos (se precarga la foto antes del fundido) ----------
  var bgIdx = Math.floor(Math.random() * FONDOS.length), bgFront = $('bgA'), bgBack = $('bgB'), primerFondo = true;
  function showBg(i) {
    var idx = (i + FONDOS.length) % FONDOS.length;
    var img = new Image();
    img.onload = function () {
      bgIdx = idx;
      bgBack.style.backgroundImage = "url('" + FONDOS[idx][0] + "')";
      bgBack.style.transition = primerFondo ? 'none' : '';   // la primera foto sale sin fundido
      primerFondo = false;
      bgBack.className = 'bg show';
      bgFront.className = 'bg';
      var t = bgFront; bgFront = bgBack; bgBack = t;
      $('credit').textContent = FONDOS[idx][1];
    };
    img.src = FONDOS[idx][0];
  }
  showBg(bgIdx);
  setInterval(function () { showBg(bgIdx + 1); }, 60000);

  // ---------- Día / noche ----------
  function aplicarModo(night) {
    state.night = night;
    screen.classList.toggle('day', !night);
    $('modeIcon').innerHTML = '<use xlink:href="#' + (night ? 'i-sun' : 'i-moon') + '"/>';
  }
  function cambiarModo() {
    aplicarModo(!state.night);
    api('/local/modo', { night: state.night }).catch(function () {});
  }

  // ---------- Avisos ----------
  var toastTimer;
  function toast(text) {
    $('toastText').textContent = text;
    $('toast').classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $('toast').classList.remove('show'); }, 5000);
  }

  // ---------- Capas y foco (navegación espacial con el mando) ----------
  function capa() {
    if (warn.classList.contains('show')) return '#warn [data-f]';
    if (allapps.classList.contains('show')) return '#allapps [data-f]';
    return '.top [data-f], .tiles [data-f]';
  }
  function layer() { return toArray(screen.querySelectorAll(capa())); }
  function allFocus() { return toArray(screen.querySelectorAll('[data-f]')); }
  var current = screen.querySelector('.tiles [data-id="youtube"]');
  var lastMain = current;
  function esPrincipal(el) {
    var p = el && el.parentNode && el.parentNode.className;
    return p === 'top' || p === 'tiles';
  }
  function setFocus(el) {
    if (current) current.classList.remove('focus');
    current = el;
    if (el) el.classList.add('focus');
    if (esPrincipal(el)) lastMain = el;
  }
  function centro(el) {
    var r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  function mover(dir) {
    if (!current || layer().indexOf(current) < 0) { setFocus(layer()[0]); return; }
    var c = centro(current), best = null, bestScore = Infinity;
    layer().forEach(function (el) {
      if (el === current) return;
      var p = centro(el), dx = p.x - c.x, dy = p.y - c.y;
      var ok = dir === KEY.RIGHT ? dx > 1 : dir === KEY.LEFT ? dx < -1 : dir === KEY.DOWN ? dy > 1 : dy < -1;
      if (!ok) return;
      var horiz = dir === KEY.RIGHT || dir === KEY.LEFT;
      var score = horiz ? Math.abs(dx) + Math.abs(dy) * 4 : Math.abs(dy) + Math.abs(dx) * 0.6;
      if (score < bestScore) { bestScore = score; best = el; }
    });
    if (best) setFocus(best);
  }
  function limpiarFoco() { allFocus().forEach(function (el) { el.classList.remove('focus'); }); current = null; }

  // ---------- Lista completa de apps ----------
  function pintarApps(apps) {
    var grid = $('agrid');
    grid.innerHTML = '';
    apps.filter(function (a) { return a.name.indexOf('TizenBrew') < 0; }).forEach(function (a) {
      var id = a.id === YOUTUBE_NATIVA ? 'youtube' : a.id;   // YouTube siempre sin anuncios
      var t = document.createElement('div');
      t.className = 'atile' + (state.blocked[id] ? ' blocked' : '');
      t.setAttribute('data-f', '');
      t.setAttribute('data-id', id);
      t.innerHTML = '<span class="mono"></span><span class="name"></span><span class="lock"><svg><use xlink:href="#i-lock"/></svg></span>';
      t.querySelector('.mono').textContent = (a.name.match(/[0-9a-z]/i) || ['?'])[0].toUpperCase();
      t.querySelector('.name').textContent = a.name;
      NOMBRES[id] = NOMBRES[id] || a.name;
      grid.appendChild(t);
    });
  }
  function mostrarApps(on) {
    if (on === allapps.classList.contains('show')) return;
    if (on) {
      lastMain = current;
      api('/local/apps').then(function (apps) {
        pintarApps(apps);
        if (!state.cursor) setFocus(layer()[0]);
      }).catch(function () { toast('No se ha podido leer la lista de apps'); });
    }
    allapps.classList.toggle('show', on);
    screen.classList.toggle('apps-open', on);
    limpiarFoco();
    if (!state.cursor) setFocus(on ? layer()[0] : lastMain);
  }

  // ---------- Abrir ----------
  function abrir(id) {
    if (state.blocked[id]) { toast((NOMBRES[id] || 'Esta app') + ' está bloqueado'); return; }
    if (id === 'youtube') return abrirYoutube();
    if (id === 'jellyfin') { toast('Jellyfin aún no está configurado'); return; }
    if (id.indexOf('hdmi') === 0 || id === 'tv' || id === 'ajustes') toast('Si sale un aviso de «Inicio TV», acéptalo');
    api('/local/abrir', { id: id }).then(function (r) {
      if (r.ok) return;
      if (r.motivo === 'bloqueado') toast((NOMBRES[id] || 'Esta app') + ' está bloqueado');
      else if (r.motivo === 'sin-permiso') toast('La tele no ha dado permiso a «Inicio TV»');
      else toast('No se ha podido abrir ' + (NOMBRES[id] || id));
    }).catch(function () { toast('El servicio de Inicio no responde'); });
  }

  // YouTube sin anuncios: se le pide a TizenBrew que active TizenTube y se navega a YouTube.
  function abrirYoutube() {
    if (state.abriendo) return;
    state.abriendo = true;
    api('/local/evento', { tipo: 'youtube' }).catch(function () {});
    var hecho = false;
    var ws;
    var plan = setTimeout(function () {
      if (hecho) return;
      hecho = true;
      logServicio('TizenBrew no ha respondido: abro YouTube desde el servicio');
      try { ws.close(); } catch (e) { /* ya cerrado */ }
      api('/local/abrir', { id: 'youtube-directo' }).catch(function () { toast('No se ha podido abrir YouTube'); });
      state.abriendo = false;
    }, 5000);
    try {
      ws = new WebSocket(TIZENBREW_WS);
    } catch (e) {
      return;
    }
    ws.onopen = function () { ws.send(JSON.stringify({ type: 4, payload: false })); };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type !== 4 || hecho) return;
      if (!msg.payload) {
        setTimeout(function () { ws.send(JSON.stringify({ type: 4, payload: false })); }, 500);
        return;
      }
      var m = msg.payload.filter(function (x) { return x.fullName === TIZENTUBE; })[0];
      if (!m) return;
      hecho = true;
      clearTimeout(plan);
      ws.send(JSON.stringify({ type: 5, payload: m }));
      setTimeout(function () { location.href = m.appPath; }, 200);
    };
  }

  function activar(el) {
    if (!el) return;
    var accion = el.getAttribute('data-action');
    if (accion === 'modo') return cambiarModo();
    if (accion === 'apps') return mostrarApps(true);
    if (accion === 'mas') {
      api('/local/temporizador/mas', {}).catch(function () {});
      cerrarAviso();
      toast('15 minutos más');
      return;
    }
    if (accion === 'cerrar') return cerrarAviso();
    var id = el.getAttribute('data-id');
    if (id) abrir(id);
  }

  // ---------- Aviso del temporizador ----------
  function revisarAviso() {
    var t = state.timer;
    var falta = t ? t.end - Date.now() : -1;
    var mostrar = !!t && t.notify && falta > 0 && falta <= 60000 && state.warnDismissed !== t.end;
    if (mostrar) {
      $('warnSecs').textContent = Math.ceil(falta / 1000);
      if (!warn.classList.contains('show')) {
        warn.classList.add('show');
        limpiarFoco();
        if (!state.cursor) setFocus(layer()[0]);
      }
    } else if (warn.classList.contains('show')) {
      warn.classList.remove('show');
      limpiarFoco();
      if (!state.cursor) setFocus(lastMain);
    }
  }
  function cerrarAviso() {
    if (state.timer) state.warnDismissed = state.timer.end;
    revisarAviso();
  }

  // ---------- Cursor libre (botón rojo) ----------
  var cur = { x: 960, y: 540 }, held = {}, raf = null, speed = 0;
  state.cursor = false;
  function setCursor(on) {
    state.cursor = on;
    $('cursor').classList.toggle('show', on);
    $('hint').textContent = on ? 'Cursor · OK: pulsar · Rojo: salir' : 'Botón rojo: cursor';
    if (on) { limpiarFoco(); colocarCursor(); return; }
    limpiarFoco();
    setFocus(esPrincipal(layer()[0]) ? lastMain : layer()[0]);
  }
  function enCursor() {
    var r = screen.getBoundingClientRect(), k = r.width / 1920;
    var el = document.elementFromPoint(r.left + (cur.x + 6) * k, r.top + (cur.y + 4) * k);
    return el ? el.closest('[data-f]') : null;
  }
  function colocarCursor() {
    cur.x = Math.max(0, Math.min(1900, cur.x));
    cur.y = Math.max(0, Math.min(1060, cur.y));
    $('cursor').style.transform = 'translate(' + cur.x + 'px,' + cur.y + 'px)';
    var hit = enCursor();
    var visibles = layer();
    allFocus().forEach(function (el) { el.classList.toggle('focus', el === hit && visibles.indexOf(el) >= 0); });
  }
  function bucleCursor() {
    var dx = (held[KEY.RIGHT] ? 1 : 0) - (held[KEY.LEFT] ? 1 : 0);
    var dy = (held[KEY.DOWN] ? 1 : 0) - (held[KEY.UP] ? 1 : 0);
    if (!dx && !dy) { raf = null; speed = 0; return; }
    speed = Math.min(speed + 0.8, 28);
    cur.x += dx * (6 + speed);
    cur.y += dy * (6 + speed);
    colocarCursor();
    raf = requestAnimationFrame(bucleCursor);
  }
  screen.addEventListener('mousemove', function (e) {
    if (!state.cursor) setCursor(true);
    var r = screen.getBoundingClientRect(), k = r.width / 1920;
    cur.x = (e.clientX - r.left) / k;
    cur.y = (e.clientY - r.top) / k;
    colocarCursor();
  });
  screen.addEventListener('click', function () {
    if (state.cursor) { var el = enCursor(); if (el && layer().indexOf(el) >= 0) activar(el); }
  });

  // ---------- Teclas ----------
  function esFlecha(k) { return k === KEY.LEFT || k === KEY.UP || k === KEY.RIGHT || k === KEY.DOWN; }
  document.addEventListener('keydown', function (e) {
    var k = e.keyCode;
    if (esFlecha(k) || k === KEY.ENTER || k === KEY.BACK || k === KEY.BACKSPACE) e.preventDefault();
    if (k === KEY.RED || e.key === 'c') { setCursor(!state.cursor); return; }
    if (e.key === 'n') { showBg(bgIdx + 1); return; }
    if (k === KEY.BACK || k === KEY.ESC || k === KEY.BACKSPACE) {
      if (warn.classList.contains('show')) cerrarAviso();
      else if (allapps.classList.contains('show')) mostrarApps(false);
      else if (state.cursor) setCursor(false);
      return;
    }
    if (esFlecha(k)) {
      if (state.cursor) { held[k] = true; if (!raf) raf = requestAnimationFrame(bucleCursor); }
      else mover(k);
      return;
    }
    if (k === KEY.ENTER) {
      var el = state.cursor ? enCursor() : current;
      if (el && layer().indexOf(el) >= 0) activar(el);
    }
  });
  document.addEventListener('keyup', function (e) { if (esFlecha(e.keyCode)) held[e.keyCode] = false; });

  // ---------- Estado del servicio (cada 2 s) ----------
  function pintarBloqueos() {
    allFocus().forEach(function (el) {
      var id = el.getAttribute('data-id');
      if (id) el.classList.toggle('blocked', !!state.blocked[id]);
    });
  }
  function sondear() {
    api('/local/estado').then(function (e) {
      if (!state.servicio) logServicio('Inicio cargado · ' + navigator.userAgent + ' · tizen=' + typeof window.tizen +
        ' · webapis=' + typeof window.webapis + ' · ' + window.innerWidth + 'x' + window.innerHeight);
      state.servicio = true;
      if (e.night !== state.night) aplicarModo(e.night);
      state.blocked = e.blocked || {};
      state.timer = e.timer;
      pintarBloqueos();
      (e.avisos || []).forEach(function (a) { if (a.tipo !== 'temporizador') toast(a.texto); });
      if (e.accion === 'youtube') abrirYoutube();
    }).catch(function () { state.servicio = false; });
  }
  setInterval(sondear, 2000);
  sondear();

  aplicarModo(true);
  setFocus(current);
})();
