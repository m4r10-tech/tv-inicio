/*
 * tv-inicio · servicio de fondo (TizenBrew lo ejecuta en un vm de Node 4.4.3 dentro de la tele).
 *
 * - Sirve el panel web en http://<ip-tele>:8090 (/login, /gestion) con usuario y contraseña.
 * - API local (/local/*, solo desde la propia tele) para la pantalla de inicio.
 * - Mando a distancia: API remota de la tele (wss://127.0.0.1:8002), la tele pide permiso una vez.
 * - Temporizador de apagado, control parental, día/noche y vuelta a Inicio al salir de YouTube.
 *
 * Solo usa módulos nativos de Node: nada de dependencias. ES5 a propósito (Node 4.4.3 no
 * tiene Buffer.from, Array.prototype.includes, desestructuración, etc.).
 */
'use strict';

(function () {
  var http = require('http');
  var tls = require('tls');
  var fs = require('fs');
  var crypto = require('crypto');

  var VERSION = '0.2.0';
  var MODULE = nombreModulo();
  var PORT = 8090;
  var CONFIG_FILE = '/home/owner/share/tv-inicio.json';
  var PKG = tizen.application.getAppInfo().packageId;
  var TB_APP = PKG + '.TizenBrewStandalone';
  var PROXY = 'http://127.0.0.1:8081/module/' + encodeURIComponent(MODULE) + '/';
  var USER = 'admin';
  var SESSION_DAYS = 30;

  // Accesos con nombre propio; el resto de apps se identifican por su appId de Tizen.
  var APPS = {
    youtube: { name: 'YouTube' },
    '11101200001': { name: 'Netflix' },
    '3201512006785': { name: 'Prime Video' },
    'org.tizen.browser': { name: 'Navegador' },
    tv: { name: 'TV', key: 'KEY_TV' },
    hdmi1: { name: 'Consola (HDMI 1)', key: 'KEY_HDMI1' },
    hdmi2: { name: 'HDMI 2', key: 'KEY_HDMI2' },
    hdmi3: { name: 'HDMI 3', key: 'KEY_HDMI3' },
    jellyfin: { name: 'Jellyfin' },
    ajustes: { name: 'Ajustes', key: 'KEY_MENU' }
  };
  var YOUTUBE_NATIVA = '111299001912';
  var TECLAS = ['KEY_UP', 'KEY_DOWN', 'KEY_LEFT', 'KEY_RIGHT', 'KEY_ENTER', 'KEY_RETURN', 'KEY_HOME',
    'KEY_VOLUP', 'KEY_VOLDOWN', 'KEY_MUTE', 'KEY_CHUP', 'KEY_CHDOWN', 'KEY_SOURCE', 'KEY_MENU',
    'KEY_PLAY', 'KEY_PAUSE', 'KEY_STOP', 'KEY_FF', 'KEY_REWIND', 'KEY_POWER', 'KEY_TV',
    'KEY_HDMI1', 'KEY_HDMI2', 'KEY_HDMI3', 'KEY_INFO', 'KEY_EXIT'];

  // Nombre con el que se añadió el módulo en TizenBrew (p. ej. gh/m4r10-tech/tv-inicio@main).
  function nombreModulo() {
    try {
      var tb = JSON.parse(fs.readFileSync('/home/owner/share/tizenbrewConfig.json', 'utf8'));
      var mio = (tb.modules || []).filter(function (m) { return m.indexOf('m4r10-tech/tv-inicio') >= 0; })[0];
      if (mio) return mio;
    } catch (e) { /* sin configuración de TizenBrew */ }
    return 'gh/m4r10-tech/tv-inicio@main';
  }

  // ---------- Registro (se ve en el panel, Diagnóstico) ----------
  var logs = [];
  function log() {
    var line = new Date().toISOString() + ' ' + Array.prototype.slice.call(arguments).join(' ');
    logs.push(line);
    if (logs.length > 300) logs.shift();
    try { console.log('[tv-inicio] ' + line); } catch (e) { /* sin consola */ }
  }

  // ---------- Configuración persistente ----------
  var config = {
    night: true,          // modo noche siempre, salvo que se cambie a mano
    blocked: {},          // id -> true
    timer: null,          // { end: ms, notify: bool }
    pass: null,           // { salt, hash }
    sessions: {},         // sha256(token) -> caducidad (ms)
    rcToken: null         // token de la API remota de la tele
  };
  function loadConfig() {
    try {
      var c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      Object.keys(c).forEach(function (k) { config[k] = c[k]; });
    } catch (e) {
      log('sin configuración previa: se empieza de cero');
    }
  }
  function saveConfig() {
    try {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config), { mode: 384 });  // 0600
    } catch (e) {
      log('error guardando configuración:', e.message);
    }
  }

  // ---------- Utilidades ----------
  function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
  function hashPass(pass, salt) { return crypto.pbkdf2Sync(pass, salt, 20000, 32, 'sha256').toString('hex'); }
  function igual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    var r = 0;
    for (var i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return r === 0;
  }
  function nombreDe(id) {
    if (APPS[id]) return APPS[id].name;
    var a = appsInfo.filter(function (x) { return x.id === id; })[0];
    return a ? a.name : id;
  }

  // ---------- Estado de la tele (apps en marcha, almacenamiento, apps instaladas) ----------
  var running = [];        // appIds en marcha
  var appsInfo = [];       // [{ id, name }]
  var storage = null;      // { free, total }
  var prevRunning = null;  // para detectar apps recién abiertas
  var tbAusente = 0;

  function leerApps() {
    try {
      tizen.application.getAppsInfo(function (list) {
        appsInfo = list.filter(function (a) { return a.show; }).map(function (a) {
          return { id: a.id, name: a.name };
        }).sort(function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1; });
      }, function (e) { log('getAppsInfo:', e.message); });
    } catch (e) { log('getAppsInfo:', e.message); }
  }
  function leerAlmacenamiento() {
    try {
      tizen.systeminfo.getPropertyValue('STORAGE', function (s) {
        var free = 0, total = 0;
        s.units.forEach(function (u) {
          if (!u.isRemovable) { free += u.availableCapacity; total += u.capacity; }
        });
        storage = { free: free, total: total };
      }, function (e) { log('STORAGE:', e.message); });
    } catch (e) { log('STORAGE:', e.message); }
  }

  // ---------- API remota de la tele (mando) ----------
  var rc = { sock: null, ready: false, state: 'desconectado', queue: [], idle: null, send: null };

  function rcConnect() {
    if (rc.sock) return;
    var name = new Buffer('Inicio TV').toString('base64');
    var path = '/api/v2/channels/samsung.remote.control?name=' + name +
      (config.rcToken ? '&token=' + config.rcToken : '');
    rc.state = 'conectando';
    rc.sock = wsConnect(path, function onOpen(send) {
      rc.send = send;
    }, function onMessage(text) {
      var msg;
      try { msg = JSON.parse(text); } catch (e) { return; }
      if (msg.event === 'ms.channel.connect') {
        if (msg.data && msg.data.token && msg.data.token !== config.rcToken) {
          config.rcToken = msg.data.token;
          saveConfig();
        }
        rc.ready = true;
        rc.state = 'ok';
        log('mando: conectado');
        var q = rc.queue; rc.queue = [];
        q.forEach(function (item) { rcSendNow(item.data, item.cb); });
      } else if (msg.event === 'ms.channel.unauthorized') {
        rc.state = 'sin-permiso';
        log('mando: la tele no ha dado permiso a "Inicio TV"');
        rcFail('sin-permiso');
      } else if (msg.event === 'ms.channel.timeOut') {
        rc.state = 'sin-respuesta';
        rcFail('sin-respuesta');
      }
    }, function onClose(reason) {
      if (reason) log('mando: cerrado (' + reason + ')');
      rc.sock = null; rc.ready = false; rc.send = null;
      if (rc.state === 'ok' || rc.state === 'conectando') rc.state = 'desconectado';
      rcFail('desconectado');
    });
  }
  function rcFail(motivo) {
    var q = rc.queue; rc.queue = [];
    q.forEach(function (item) { item.cb({ ok: false, motivo: motivo }); });
    if (rc.sock) { try { rc.sock.destroy(); } catch (e) { /* ya cerrado */ } }
  }
  function rcSendNow(data, cb) {
    try {
      rc.send(JSON.stringify(data));
      cb({ ok: true });
    } catch (e) {
      cb({ ok: false, motivo: e.message });
    }
    clearTimeout(rc.idle);
    rc.idle = setTimeout(function () { if (rc.sock) rc.sock.end(); }, 120000);
  }
  function rcSend(data, cb) {
    cb = cb || function () {};
    if (rc.ready && rc.send) return rcSendNow(data, cb);
    var item = { data: data, cb: cb };
    rc.queue.push(item);
    // La primera vez la tele espera a que alguien acepte el aviso en pantalla.
    setTimeout(function () {
      var i = rc.queue.indexOf(item);
      if (i >= 0) { rc.queue.splice(i, 1); cb({ ok: false, motivo: 'sin-respuesta' }); }
    }, 40000);
    rcConnect();
  }
  function tecla(key, cb) {
    rcSend({ method: 'ms.remote.control',
      params: { Cmd: 'Click', DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' } }, cb);
  }

  // Cliente WebSocket mínimo sobre TLS (Node 4 no trae WebSocket).
  function wsConnect(path, onOpen, onMessage, onClose) {
    var key = crypto.randomBytes(16).toString('base64');
    var buf = new Buffer(0), open = false, closed = false;
    var sock = tls.connect({ host: '127.0.0.1', port: 8002, rejectUnauthorized: false }, function () {
      sock.write('GET ' + path + ' HTTP/1.1\r\nHost: 127.0.0.1:8002\r\nUpgrade: websocket\r\n' +
        'Connection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    function frame(op, data) {
      var payload = typeof data === 'string' ? new Buffer(data, 'utf8') : data;
      var len = payload.length, head;
      if (len < 126) { head = new Buffer(2); head[1] = 0x80 | len; }
      else if (len < 65536) { head = new Buffer(4); head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
      else { head = new Buffer(10); head[1] = 0x80 | 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
      head[0] = 0x80 | op;
      var mask = crypto.randomBytes(4), body = new Buffer(len);
      for (var i = 0; i < len; i++) body[i] = payload[i] ^ mask[i % 4];
      sock.write(Buffer.concat([head, mask, body]));
    }
    function fin(reason) {
      if (closed) return;
      closed = true;
      onClose(reason);
    }
    sock.on('data', function (d) {
      try {
        buf = Buffer.concat([buf, d]);
        if (!open) {
          var end = buf.indexOf('\r\n\r\n');
          if (end < 0) return;
          var status = buf.slice(0, end).toString().split('\r\n')[0];
          if (!/ 101 /.test(status)) { sock.destroy(); return fin('handshake: ' + status); }
          open = true;
          buf = buf.slice(end + 4);
          onOpen(function (text) { frame(1, text); });
        }
        while (buf.length >= 2) {
          var op = buf[0] & 0x0f, len = buf[1] & 0x7f, off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = buf.readUInt32BE(6); off = 10; }
          if (buf[1] & 0x80) off += 4;
          if (buf.length < off + len) return;
          var payload = buf.slice(off, off + len);
          buf = buf.slice(off + len);
          if (op === 1) onMessage(payload.toString('utf8'));
          else if (op === 8) sock.end();
          else if (op === 9) frame(10, payload);
        }
      } catch (e) {
        log('mando: error leyendo:', e.message);
        sock.destroy();
      }
    });
    sock.on('error', function (e) { fin(e.message); });
    sock.on('close', function () { fin(''); });
    return sock;
  }

  // ---------- Abrir apps y fuentes ----------
  var accion = null;    // acción pendiente para la pantalla de inicio: { id, t }
  var avisos = [];      // avisos para mostrar en la pantalla de inicio
  // Vuelta a Inicio al salir de YouTube. Se arma cuando TizenBrew lleva 15 s en marcha con YouTube,
  // para no confundirla con el reinicio en modo depuración que hace TizenBrew al arrancar.
  var volver = null;   // { t: ms, armado: bool }
  function vigilarYoutube() { volver = { t: Date.now(), armado: false }; tbAusente = 0; }

  function bloqueado(id) {
    if (config.blocked[id]) return true;
    if (id === YOUTUBE_NATIVA && config.blocked.youtube) return true;
    return false;
  }
  function lanzar(appId, cb) {
    try {
      tizen.application.launch(appId, function () { cb({ ok: true }); },
        function (e) { log('launch', appId, e.message); cb({ ok: false, motivo: e.message }); });
    } catch (e) {
      log('launch', appId, e.message);
      cb({ ok: false, motivo: e.message });
    }
  }
  function abrirModulo(moduleType, moduleName, cb) {
    try {
      tizen.application.launchAppControl(
        new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/view', null, null, null,
          [new tizen.ApplicationControlData('module', [JSON.stringify({ moduleName: moduleName, moduleType: moduleType })])]),
        TB_APP, function () { cb({ ok: true }); },
        function (e) { log('appcontrol', moduleName, e.message); cb({ ok: false, motivo: e.message }); });
    } catch (e) {
      log('appcontrol', moduleName, e.message);
      cb({ ok: false, motivo: e.message });
    }
  }
  function tbEnMarcha() { return running.indexOf(TB_APP) >= 0; }

  // Abre YouTube sin anuncios (TizenTube). Si Inicio ya está abierto, se lo pide a la pantalla
  // de inicio (lo hace a través de TizenBrew); si no, TizenBrew lo abre directamente.
  function abrirYoutube(cb) {
    if (tbEnMarcha()) {
      accion = { id: 'youtube', t: Date.now() };
      lanzar(TB_APP, cb);
    } else {
      vigilarYoutube();
      abrirModulo('npm', '@foxreis/tizentube', cb);
    }
  }
  function traerInicio(cb) {
    if (tbEnMarcha()) lanzar(TB_APP, cb);
    else abrirModulo('gh', MODULE.slice(3), cb);
  }

  function abrir(id, cb) {
    if (bloqueado(id)) return cb({ ok: false, motivo: 'bloqueado' });
    if (id === 'youtube') return abrirYoutube(cb);
    if (id === 'youtube-directo') {   // respaldo de la pantalla de inicio si TizenBrew no responde
      if (bloqueado('youtube')) return cb({ ok: false, motivo: 'bloqueado' });
      vigilarYoutube();
      return abrirModulo('npm', '@foxreis/tizentube', cb);
    }
    if (id === 'inicio') return traerInicio(cb);
    if (id === 'jellyfin') return cb({ ok: false, motivo: 'sin-configurar' });
    if (APPS[id] && APPS[id].key) return tecla(APPS[id].key, cb);
    lanzar(id, cb);
  }

  // ---------- Temporizador ----------
  function apagar(cb) {
    log('apagando la tele');
    tecla('KEY_POWER', cb);
  }
  function revisarTemporizador() {
    var t = config.timer;
    if (!t) return;
    var falta = t.end - Date.now();
    if (falta <= 0) {
      config.timer = null;
      saveConfig();
      apagar(function (r) { if (!r.ok) log('temporizador: no se pudo apagar:', r.motivo); });
      return;
    }
    if (t.notify && !t.warned && falta <= 60000) {
      t.warned = true;
      saveConfig();
      avisos.push({ tipo: 'temporizador', texto: 'La tele se apagará en 1 minuto' });
      traerInicio(function () {});
    }
  }

  // ---------- Vigilancia: apps abiertas, control parental, vuelta a Inicio ----------
  function vigilar() {
    try {
      tizen.application.getAppsContext(function (ctxs) {
        running = ctxs.map(function (c) { return c.appId; });
        if (prevRunning) {
          running.forEach(function (id) {
            if (prevRunning.indexOf(id) < 0 && bloqueado(id)) {
              log('control parental: se ha abierto', id, '(bloqueada)');
              avisos.push({ tipo: 'bloqueo', texto: nombreDe(id) + ' está bloqueado' });
              traerInicio(function () {});
            }
          });
        }
        prevRunning = running;
        // Al salir de YouTube se cierra TizenBrew entero: se vuelve a abrir Inicio.
        if (volver) {
          if (!volver.armado) {
            if (tbEnMarcha() && Date.now() - volver.t > 15000) volver.armado = true;
            else if (Date.now() - volver.t > 120000) volver = null;
          } else {
            tbAusente = tbEnMarcha() ? 0 : tbAusente + 1;
          }
          if (volver && volver.armado && tbAusente >= 2) {
            volver = null;
            tbAusente = 0;
            log('YouTube cerrado: vuelvo a Inicio');
            traerInicio(function () {});
          }
        }
      }, function (e) { log('getAppsContext:', e.message); });
    } catch (e) { log('getAppsContext:', e.message); }
    revisarTemporizador();
  }

  // ---------- Panel web (HTML servido desde el propio módulo vía TizenBrew) ----------
  var panelHtml = null;
  function cargarPanel() {
    http.get(PROXY + 'panel/index.html?v=' + VERSION, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var html = Buffer.concat(chunks).toString('utf8');
        if (html.indexOf('<!doctype html>') === 0) { if (html !== panelHtml) log('panel cargado'); panelHtml = html; }
        else log('panel: respuesta inesperada');
      });
    }).on('error', function (e) {
      log('panel: no se pudo cargar:', e.message);
    });
  }

  // ---------- Sesiones ----------
  var fallos = { n: 0, hasta: 0 };
  function cookies(req) {
    var out = {};
    (req.headers.cookie || '').split(';').forEach(function (p) {
      var i = p.indexOf('=');
      if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
    });
    return out;
  }
  function sesionValida(req) {
    var sid = cookies(req).sid;
    if (!sid) return false;
    var exp = config.sessions[sha256(sid)];
    return !!exp && exp > Date.now();
  }
  function nuevaSesion(res) {
    var sid = crypto.randomBytes(24).toString('hex');
    var now = Date.now();
    Object.keys(config.sessions).forEach(function (k) { if (config.sessions[k] < now) delete config.sessions[k]; });
    config.sessions[sha256(sid)] = now + SESSION_DAYS * 86400000;
    saveConfig();
    res.setHeader('Set-Cookie', 'sid=' + sid + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + SESSION_DAYS * 86400);
  }

  // ---------- HTTP ----------
  function enviar(res, code, obj, extra) {
    var body = JSON.stringify(obj);
    var h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
    Object.keys(extra || {}).forEach(function (k) { h[k] = extra[k]; });
    res.writeHead(code, h);
    res.end(body);
  }
  function leerCuerpo(req, cb) {
    var data = '', ok = true;
    req.on('data', function (c) {
      data += c;
      if (data.length > 65536) { ok = false; req.destroy(); }
    });
    req.on('end', function () {
      if (!ok) return;
      try { cb(data ? JSON.parse(data) : {}); } catch (e) { cb(null); }
    });
  }
  function esLocal(req) {
    var a = req.socket.remoteAddress || '';
    return a === '127.0.0.1' || a === '::ffff:127.0.0.1' || a === '::1';
  }
  function estadoPublico() {
    return {
      version: VERSION,
      night: config.night,
      blocked: config.blocked,
      timer: config.timer ? { end: config.timer.end, notify: config.timer.notify } : null,
      hora: Date.now()
    };
  }

  function rutaLocal(req, res, ruta) {
    var cors = { 'Access-Control-Allow-Origin': '*' };
    if (req.method === 'GET' && ruta === '/local/estado') {
      var e = estadoPublico();
      e.avisos = avisos; avisos = [];
      if (accion && Date.now() - accion.t < 60000) e.accion = accion.id;
      accion = null;
      return enviar(res, 200, e, cors);
    }
    if (req.method === 'GET' && ruta === '/local/apps') return enviar(res, 200, appsInfo, cors);
    if (req.method !== 'POST') return enviar(res, 404, { ok: false }, cors);
    leerCuerpo(req, function (b) {
      if (!b) return enviar(res, 400, { ok: false }, cors);
      if (ruta === '/local/abrir') return abrir(String(b.id), function (r) { enviar(res, 200, r, cors); });
      if (ruta === '/local/modo') { config.night = !!b.night; saveConfig(); return enviar(res, 200, { ok: true }, cors); }
      if (ruta === '/local/evento') {
        if (b.tipo === 'youtube') vigilarYoutube();
        return enviar(res, 200, { ok: true }, cors);
      }
      if (ruta === '/local/temporizador/mas' && config.timer) {
        config.timer.end += 15 * 60000;
        config.timer.warned = false;
        saveConfig();
        return enviar(res, 200, { ok: true }, cors);
      }
      if (ruta === '/local/log') { log('inicio:', String(b.msg).slice(0, 500)); return enviar(res, 200, { ok: true }, cors); }
      enviar(res, 404, { ok: false }, cors);
    });
  }

  function rutaApi(req, res, ruta) {
    if (req.method === 'GET' && ruta === '/api/sesion') {
      return enviar(res, 200, { logged: sesionValida(req), setup: !config.pass });
    }
    if (req.method === 'POST' && req.headers['x-tv'] !== '1') return enviar(res, 403, { ok: false });

    if (req.method === 'POST' && (ruta === '/api/login' || ruta === '/api/setup')) {
      return leerCuerpo(req, function (b) {
        if (!b) return enviar(res, 400, { ok: false });
        if (ruta === '/api/setup') {
          if (config.pass) return enviar(res, 403, { ok: false, motivo: 'ya-configurado' });
          if (typeof b.pass !== 'string' || b.pass.length < 8) return enviar(res, 400, { ok: false, motivo: 'corta' });
          var salt = crypto.randomBytes(16).toString('hex');
          config.pass = { salt: salt, hash: hashPass(b.pass, salt) };
          saveConfig();
          log('panel: contraseña configurada');
          nuevaSesion(res);
          return enviar(res, 200, { ok: true });
        }
        var now = Date.now();
        if (fallos.hasta > now) return enviar(res, 429, { ok: false, motivo: 'espera' });
        var bien = config.pass && b.user === USER && typeof b.pass === 'string' &&
          igual(hashPass(b.pass, config.pass.salt), config.pass.hash);
        if (!bien) {
          fallos.n++;
          if (fallos.n >= 5) { fallos.hasta = now + 5 * 60000; fallos.n = 0; log('panel: 5 fallos, bloqueo 5 min'); }
          return enviar(res, 401, { ok: false });
        }
        fallos.n = 0;
        nuevaSesion(res);
        enviar(res, 200, { ok: true });
      });
    }
    if (!sesionValida(req)) return enviar(res, 401, { ok: false, motivo: 'sesion' });

    if (req.method === 'GET') {
      if (ruta === '/api/estado') {
        var e = estadoPublico();
        e.running = running.map(function (id) { return { id: id, name: nombreDe(id) }; });
        e.storage = storage;
        e.mando = rc.state;
        return enviar(res, 200, e);
      }
      if (ruta === '/api/apps') {
        var fuentes = ['tv', 'hdmi1', 'hdmi2', 'hdmi3'].map(function (id) { return { id: id, name: APPS[id].name, fuente: true }; });
        var apps = [{ id: 'youtube', name: 'YouTube' }].concat(appsInfo.filter(function (a) {
          return a.id !== YOUTUBE_NATIVA && a.id.indexOf(PKG) !== 0;
        }));
        return enviar(res, 200, { apps: apps, fuentes: fuentes });
      }
      if (ruta === '/api/log') return enviar(res, 200, logs);
      return enviar(res, 404, { ok: false });
    }

    leerCuerpo(req, function (b) {
      if (!b) return enviar(res, 400, { ok: false });
      if (ruta === '/api/logout') {
        var sid = cookies(req).sid;
        if (sid) { delete config.sessions[sha256(sid)]; saveConfig(); }
        return enviar(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' });
      }
      if (ruta === '/api/tecla') {
        if (TECLAS.indexOf(b.key) < 0) return enviar(res, 400, { ok: false });
        return tecla(b.key, function (r) { enviar(res, 200, r); });
      }
      if (ruta === '/api/abrir') return abrir(String(b.id), function (r) { enviar(res, 200, r); });
      if (ruta === '/api/password') {
        if (typeof b.actual !== 'string' || !igual(hashPass(b.actual, config.pass.salt), config.pass.hash)) {
          return enviar(res, 403, { ok: false, motivo: 'actual' });
        }
        if (typeof b.nueva !== 'string' || b.nueva.length < 8) return enviar(res, 400, { ok: false, motivo: 'corta' });
        var sal = crypto.randomBytes(16).toString('hex');
        config.pass = { salt: sal, hash: hashPass(b.nueva, sal) };
        config.sessions = {};   // se cierran todas las sesiones, también las de otros aparatos
        saveConfig();
        log('panel: contraseña cambiada');
        nuevaSesion(res);
        return enviar(res, 200, { ok: true });
      }
      if (ruta === '/api/apagar') return apagar(function (r) { enviar(res, 200, r); });
      if (ruta === '/api/modo') { config.night = !!b.night; saveConfig(); return enviar(res, 200, { ok: true }); }
      if (ruta === '/api/temporizador') {
        var min = Math.floor(Number(b.min));
        if (!(min > 0 && min <= 24 * 60)) return enviar(res, 400, { ok: false });
        config.timer = { end: Date.now() + min * 60000, notify: !!b.notify, warned: false };
        saveConfig();
        log('temporizador:', min, 'min, aviso', !!b.notify);
        return enviar(res, 200, { ok: true });
      }
      if (ruta === '/api/temporizador/cancelar') { config.timer = null; saveConfig(); return enviar(res, 200, { ok: true }); }
      if (ruta === '/api/bloqueo') {
        var id = String(b.id);
        if (b.on) config.blocked[id] = true; else delete config.blocked[id];
        saveConfig();
        log('control parental:', id, b.on ? 'bloqueado' : 'desbloqueado');
        return enviar(res, 200, { ok: true });
      }
      enviar(res, 404, { ok: false });
    });
  }

  function servirPanel(res) {
    if (!panelHtml) {
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '5' });
      return res.end('<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="5">' +
        '<p style="font-family:sans-serif">Cargando el panel…</p>');
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer'
    });
    res.end(panelHtml);
  }

  var server = http.createServer(function (req, res) {
    try {
      var ruta = (req.url || '/').split('?')[0];
      if (ruta.indexOf('/local/') === 0) {
        if (!esLocal(req)) return enviar(res, 403, { ok: false });
        if (req.method === 'OPTIONS') {
          res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' });
          return res.end();
        }
        return rutaLocal(req, res, ruta);
      }
      if (ruta.indexOf('/api/') === 0) return rutaApi(req, res, ruta);
      if (ruta === '/') { res.writeHead(302, { Location: '/gestion' }); return res.end(); }
      if (ruta === '/login' || ruta === '/gestion' || ruta === '/management') return servirPanel(res);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('No encontrado');
    } catch (e) {
      log('error en', req.url, e.message);
      try { enviar(res, 500, { ok: false }); } catch (e2) { /* respuesta ya enviada */ }
    }
  });
  server.on('error', function (e) { log('servidor:', e.message); });

  // ---------- Arranque ----------
  loadConfig();
  if (config.timer && config.timer.end < Date.now()) { config.timer = null; saveConfig(); }
  server.listen(PORT, '0.0.0.0', function () { log('tv-inicio ' + VERSION + ' (' + MODULE + ') escuchando en :' + PORT); });
  cargarPanel();
  setInterval(cargarPanel, 60000);
  leerApps();
  setInterval(leerApps, 5 * 60000);
  leerAlmacenamiento();
  setInterval(leerAlmacenamiento, 60000);
  setInterval(vigilar, 2500);
  vigilar();
})();
