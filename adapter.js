/* Conferência X — ligação com o Firebase (versão fora do Claude) */
window.CX_STANDALONE = true;
(function () {
  var cfg = window.CX_FIREBASE || {};
  var configured = cfg.apiKey && cfg.apiKey.indexOf('COLE') !== 0 && cfg.projectId;
  var authReady, resolveAuth;
  authReady = new Promise(function (r) { resolveAuth = r; });

  // ---------- tela de entrada do aparelho ----------
  function gate(msg) {
    var g = document.getElementById('cx-gate');
    if (!g) {
      g = document.createElement('div'); g.id = 'cx-gate';
      g.innerHTML =
        '<div class="cxg-box"><img src="icon-512.png" alt="Xis da Gaúcha" class="cxg-logo">' +
        '<div class="cxg-title">Conferência <em>X</em><i style="font-style:normal;font-family:system-ui,sans-serif;font-weight:700;text-transform:none;font-size:.6em;color:#28c850">is da Gaúcha</i></div>' +
        '<p class="cxg-sub">Entre com a conta deste aparelho. Isso é feito uma vez só: depois cada funcionário entra com o próprio PIN.</p>' +
        '<form id="cxg-form"><label>E-mail<input type="email" id="cxg-email" autocomplete="username" required></label>' +
        '<label>Senha<input type="password" id="cxg-pass" autocomplete="current-password" required></label>' +
        '<p class="cxg-err" id="cxg-err"></p><button type="submit" id="cxg-btn">Entrar no aparelho</button></form></div>';
      document.body.appendChild(g);
      document.getElementById('cxg-form').addEventListener('submit', function (e) {
        e.preventDefault();
        var b = document.getElementById('cxg-btn'); b.disabled = true; b.textContent = 'Entrando…';
        firebase.auth().signInWithEmailAndPassword(
          document.getElementById('cxg-email').value.trim(),
          document.getElementById('cxg-pass').value
        ).catch(function (err) {
          var c = (err && err.code) || '';
          document.getElementById('cxg-err').textContent =
            c.indexOf('network') >= 0 ? 'Sem internet. Confira a conexão e tente de novo.' :
            c.indexOf('too-many') >= 0 ? 'Muitas tentativas. Espere alguns minutos.' :
            'E-mail ou senha errados.';
          b.disabled = false; b.textContent = 'Entrar no aparelho';
        });
      });
    }
    g.hidden = false;
    if (msg) { document.getElementById('cxg-err').textContent = msg; }
  }
  function hideGate() { var g = document.getElementById('cx-gate'); if (g) g.hidden = true; }

  if (!configured) {
    document.addEventListener('DOMContentLoaded', function () {
      gate('O app ainda não foi ligado ao Firebase. Preencha o arquivo firebase-config.js (veja o passo a passo).');
      document.getElementById('cxg-btn').disabled = true;
    });
    window.claude = { use: function () { return new Promise(function () {}); } };
    return;
  }

  firebase.initializeApp(cfg);
  var fs = firebase.firestore();
  try { fs.settings({ ignoreUndefinedProperties: true, merge: true }); } catch (e) {}
  try { fs.enablePersistence({ synchronizeTabs: true }).catch(function () {}); } catch (e) {}
  var currentUser = null;
  firebase.auth().onAuthStateChanged(function (u) {
    if (u) { currentUser = u; hideGate(); resolveAuth(u); }
    else if (currentUser) { location.reload(); }
    else { if (document.body) gate(); else document.addEventListener('DOMContentLoaded', function () { gate(); }); }
  });
  window.CX_signOut = function () { firebase.auth().signOut().then(function () { location.reload(); }); };

  // ---------- erros no formato que o app espera ----------
  function mapErr(e) {
    var c = (e && e.code) || '';
    if (/permission-denied|not-found|invalid-argument|failed-precondition/.test(c)) return { code: 'invalid_argument', message: e.message };
    if (/resource-exhausted/.test(c)) return { code: 'quota_exceeded', message: e.message };
    return { code: 'unavailable', message: (e && e.message) || String(e) };
  }
  function wrapDoc(s) {
    return { id: s.id, exists: s.exists, data: function () { return s.exists ? s.data() : undefined; },
      metadata: { fromCache: s.metadata.fromCache, hasPendingWrites: s.metadata.hasPendingWrites } };
  }
  function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date); }
  // update() do app mescla objetos aninhados; no Firestore isso vira caminhos com ponto
  function flatten(obj, prefix, out) {
    Object.keys(obj).forEach(function (k) {
      var v = obj[k], p = prefix ? prefix + '.' + k : k;
      if (isObj(v) && Object.keys(v).length) flatten(v, p, out); else out[p] = v;
    });
    return out;
  }

  function docRef(path) {
    var r = fs.doc(path);
    return {
      id: r.id, path: path,
      get: function () { return r.get().then(wrapDoc, function (e) { throw mapErr(e); }); },
      set: function (d) { return r.set(d).catch(function (e) { throw mapErr(e); }); },
      update: function (d) { return r.update(flatten(d, '', {})).catch(function (e) { throw mapErr(e); }); },
      delete: function () { return r.delete().catch(function (e) { throw mapErr(e); }); },
      onSnapshot: function (next, err) {
        return r.onSnapshot({ includeMetadataChanges: false }, function (s) { next(wrapDoc(s)); }, function (e) { if (err) err(mapErr(e)); });
      },
      collection: function (sub) { return collRef(path + '/' + sub); }
    };
  }

  function collRef(path, filters, order, lim) {
    filters = filters || []; order = order || null; lim = lim || null;
    // igualdade + intervalo em campos diferentes exigiria índice no Firestore:
    // nesses casos a igualdade é filtrada aqui no aparelho.
    function plan() {
      var eq = filters.filter(function (f) { return f[1] === '=='; });
      var other = filters.filter(function (f) { return f[1] !== '=='; });
      var otherFields = other.map(function (f) { return f[0]; }).concat(order ? [order[0]] : []);
      var mixed = eq.length && otherFields.length && eq.some(function (f) { return otherFields.indexOf(f[0]) < 0; });
      var server = mixed ? other : filters, client = mixed ? eq : [];
      var q = fs.collection(path);
      server.forEach(function (f) { q = q.where(f[0], f[1], f[2]); });
      if (order) q = q.orderBy(order[0], order[1] || 'asc');
      if (lim && !client.length) q = q.limit(lim);
      return { q: q, client: client };
    }
    function finish(snap, client) {
      var docs = snap.docs.filter(function (d) { var x = d.data(); return client.every(function (f) { return x[f[0]] === f[2]; }); });
      if (lim) docs = docs.slice(0, lim);
      docs = docs.map(wrapDoc);
      return { docs: docs, size: docs.length, empty: !docs.length, docChanges: function () { return docs.map(function (d, i) { return { type: 'added', doc: d, oldIndex: -1, newIndex: i }; }); },
        metadata: { fromCache: snap.metadata.fromCache, hasPendingWrites: snap.metadata.hasPendingWrites } };
    }
    var api = {
      path: path,
      where: function (f, op, v) { return collRef(path, filters.concat([[f, op, v]]), order, lim); },
      orderBy: function (f, dir) { return collRef(path, filters, [f, dir || 'asc'], lim); },
      limit: function (n) { return collRef(path, filters, order, n); },
      get: function () { var p = plan(); return p.q.get().then(function (s) { return finish(s, p.client); }, function (e) { throw mapErr(e); }); },
      onSnapshot: function (next, err) { var p = plan(); return p.q.onSnapshot(function (s) { next(finish(s, p.client)); }, function (e) { if (err) err(mapErr(e)); }); },
      doc: function (id) { return docRef(path + '/' + (id || fs.collection(path).doc().id)); },
      add: function (d) { var ref = api.doc(); return ref.set(d).then(function () { return ref; }); }
    };
    return api;
  }

  var DB = { doc: docRef, collection: function (p) { return collRef(p); } };
  function isGestora() {
    var em = (currentUser && currentUser.email || '').toLowerCase();
    var list = [].concat(window.CX_GESTORA_EMAIL || []).map(function (x) { return String(x).toLowerCase(); });
    return list.indexOf(em) >= 0;
  }
  var USER = {
    isOwner: function () { return isGestora(); }, canEdit: function () { return isGestora(); },
    can: function () { return true; }, id: function () { return Promise.resolve(currentUser && currentUser.uid); },
    me: function () { return Promise.resolve({ id: currentUser && currentUser.uid, name: currentUser && currentUser.email }); }
  };
  var DL = {
    save: function (req) {
      var blob = req.data instanceof Blob ? req.data : new Blob([req.data], { type: /\.csv$/i.test(req.filename) ? 'text/csv;charset=utf-8' : /\.json$/i.test(req.filename) ? 'application/json' : 'text/html;charset=utf-8' });
      var url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = req.filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      return Promise.resolve({ status: 'saved' });
    }
  };
  window.claude = {
    use: function (name) {
      return authReady.then(function () {
        if (name === 'db') return DB; if (name === 'user') return USER; if (name === 'downloads') return DL; return null;
      });
    }
  };

  // app instalável
  if ('serviceWorker' in navigator) window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
})();
