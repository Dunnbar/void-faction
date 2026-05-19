const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');

const STREAMER_PASSWORD = process.env.STREAMER_PASSWORD || 'satelitteOrion';
const PORT = Number(process.env.PORT) || 3000;
const WORLD_W = 1280;
const WORLD_H = 720;
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,20}$/;

const ACTION_TICK_MS = 10 * 1000;          // +1 toutes les 10 secondes
const ACTION_MAX_DURATION_MS = 60 * 60 * 1000; // 1 heure max par activation
const HISTORY_LIMIT = 10;

const CATEGORIES = ['PUISSANCE', 'DEFENSIF', 'UTILITAIRE'];
const CATEGORY_TO_COLUMN = { PUISSANCE: 'puissance', DEFENSIF: 'defensif', UTILITAIRE: 'utilitaire' };

// Configuration des éléments interactifs (positions partagées avec le client)
const ELEMENTS = [
  {
    id: 'turret-1', type: 'turret', x: WORLD_W / 2, y: 540,
    label: 'TOURELLE',
    actions: [
      { id: 'tir',        label: 'Tir',        category: 'PUISSANCE' },
      { id: 'reparation', label: 'Réparation', category: 'DEFENSIF'  }
    ]
  },
  // Astéroïdes : mêmes positions que côté client (player.js / streamer.js)
  { id: 'asteroid-0', type: 'asteroid', x: 180,  y: 140, label: 'ASTÉROÏDE', actions: [{ id: 'minage', label: 'Minage', category: 'UTILITAIRE' }] },
  { id: 'asteroid-1', type: 'asteroid', x: 1090, y: 170, label: 'ASTÉROÏDE', actions: [{ id: 'minage', label: 'Minage', category: 'UTILITAIRE' }] },
  { id: 'asteroid-2', type: 'asteroid', x: 200,  y: 580, label: 'ASTÉROÏDE', actions: [{ id: 'minage', label: 'Minage', category: 'UTILITAIRE' }] },
  { id: 'asteroid-3', type: 'asteroid', x: 1100, y: 590, label: 'ASTÉROÏDE', actions: [{ id: 'minage', label: 'Minage', category: 'UTILITAIRE' }] },
  { id: 'asteroid-4', type: 'asteroid', x: 420,  y: 90,  label: 'ASTÉROÏDE', actions: [{ id: 'minage', label: 'Minage', category: 'UTILITAIRE' }] },
  { id: 'asteroid-5', type: 'asteroid', x: 860,  y: 80,  label: 'ASTÉROÏDE', actions: [{ id: 'minage', label: 'Minage', category: 'UTILITAIRE' }] },
  { id: 'asteroid-6', type: 'asteroid', x: 340,  y: 640, label: 'ASTÉROÏDE', actions: [{ id: 'minage', label: 'Minage', category: 'UTILITAIRE' }] },
  { id: 'asteroid-7', type: 'asteroid', x: 940,  y: 630, label: 'ASTÉROÏDE', actions: [{ id: 'minage', label: 'Minage', category: 'UTILITAIRE' }] }
];
const ELEMENT_BY_ID = Object.fromEntries(ELEMENTS.map(e => [e.id, e]));

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'voidfaction.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS user_progress (
    user_id INTEGER PRIMARY KEY,
    puissance INTEGER NOT NULL DEFAULT 0,
    defensif INTEGER NOT NULL DEFAULT 0,
    utilitaire INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS active_actions (
    user_id INTEGER PRIMARY KEY,
    element_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    category TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    last_settled_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS action_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    element_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    category TEXT NOT NULL,
    event_type TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_action_log_time ON action_log (at DESC);
`);
db.prepare("INSERT OR IGNORE INTO state (key, value) VALUES ('resource', '0')").run();

const stmtGetState         = db.prepare('SELECT value FROM state WHERE key = ?');
const stmtSetState         = db.prepare('UPDATE state SET value = ? WHERE key = ?');
const stmtInsertUser       = db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)');
const stmtGetUserByName    = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?');
const stmtGetUserById      = db.prepare('SELECT id, username FROM users WHERE id = ?');
const stmtInsertSession    = db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)');
const stmtGetSession       = db.prepare('SELECT user_id FROM sessions WHERE token = ?');
const stmtDeleteSession    = db.prepare('DELETE FROM sessions WHERE token = ?');

const stmtEnsureProgress = db.prepare('INSERT OR IGNORE INTO user_progress (user_id) VALUES (?)');
const stmtGetProgress    = db.prepare('SELECT puissance, defensif, utilitaire, total FROM user_progress WHERE user_id = ?');
const stmtIncPuissance   = db.prepare('UPDATE user_progress SET puissance = puissance + ?, total = total + ? WHERE user_id = ?');
const stmtIncDefensif    = db.prepare('UPDATE user_progress SET defensif  = defensif  + ?, total = total + ? WHERE user_id = ?');
const stmtIncUtilitaire  = db.prepare('UPDATE user_progress SET utilitaire = utilitaire + ?, total = total + ? WHERE user_id = ?');

const stmtGetActiveAction = db.prepare('SELECT user_id, element_id, action_id, category, started_at, last_settled_at FROM active_actions WHERE user_id = ?');
const stmtAllActiveActions = db.prepare('SELECT user_id, element_id, action_id, category, started_at, last_settled_at FROM active_actions');
const stmtUpsertActiveAction = db.prepare(`
  INSERT INTO active_actions (user_id, element_id, action_id, category, started_at, last_settled_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET
    element_id = excluded.element_id,
    action_id = excluded.action_id,
    category = excluded.category,
    started_at = excluded.started_at,
    last_settled_at = excluded.last_settled_at
`);
const stmtDeleteActiveAction = db.prepare('DELETE FROM active_actions WHERE user_id = ?');
const stmtUpdateLastSettled = db.prepare('UPDATE active_actions SET last_settled_at = ? WHERE user_id = ?');

const stmtInsertActionLog = db.prepare('INSERT INTO action_log (user_id, username, element_id, action_id, category, event_type, at) VALUES (?, ?, ?, ?, ?, ?, ?)');
const stmtRecentActionLog = db.prepare("SELECT username, element_id, action_id, category, event_type, at FROM action_log WHERE event_type = 'activate' ORDER BY at DESC LIMIT ?");

const stmtAllActiveElements = db.prepare(`SELECT a.element_id, a.action_id, a.category, u.username FROM active_actions a JOIN users u ON u.id = a.user_id`);

const getResource = () => parseInt(stmtGetState.get('resource').value, 10);
const setResource = (n) => stmtSetState.run(String(n), 'resource');

function incrementCategory(uid, category, n) {
  if (n <= 0) return;
  if (category === 'PUISSANCE')      stmtIncPuissance.run(n, n, uid);
  else if (category === 'DEFENSIF')  stmtIncDefensif.run(n, n, uid);
  else if (category === 'UTILITAIRE') stmtIncUtilitaire.run(n, n, uid);
}

function getProgressFor(uid) {
  stmtEnsureProgress.run(uid);
  return stmtGetProgress.get(uid);
}

function getRecentActionHistory() {
  return stmtRecentActionLog.all(HISTORY_LIMIT).map(r => ({
    username: r.username,
    element_id: r.element_id,
    action_id: r.action_id,
    category: r.category,
    at: r.at
  }));
}

function getAllActiveElementStates() {
  // Pour chaque élément actif, retourne { element_id, action_id, category, username }
  return stmtAllActiveElements.all();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}
function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, salt, 64);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
function newToken() {
  return crypto.randomBytes(32).toString('hex');
}
function userFromToken(token) {
  if (typeof token !== 'string' || !token) return null;
  const row = stmtGetSession.get(token);
  if (!row) return null;
  return stmtGetUserById.get(row.user_id) || null;
}

const ship = { x: WORLD_W / 2, y: WORLD_H / 2 + 120, rotation: 0 };
let streamerSocketId = null;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

app.post('/api/signup', (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return res.status(400).json({ ok: false, error: 'Pseudo invalide (3-20 caractères, alphanumériques)' });
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 200) {
    return res.status(400).json({ ok: false, error: 'Mot de passe : 6 caractères minimum' });
  }
  const existing = stmtGetUserByName.get(username);
  if (existing) return res.status(409).json({ ok: false, error: 'Ce pseudo est déjà pris' });
  try {
    const info = stmtInsertUser.run(username, hashPassword(password), Date.now());
    stmtEnsureProgress.run(info.lastInsertRowid);
    const token = newToken();
    stmtInsertSession.run(token, info.lastInsertRowid, Date.now());
    res.json({ ok: true, token, username });
  } catch (e) {
    console.error('[signup] erreur:', e?.code || '', e?.message || e);
    res.status(500).json({ ok: false, error: 'Erreur serveur: ' + (e?.code || e?.message || 'inconnue') });
  }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ ok: false, error: 'Identifiants manquants' });
  }
  const user = stmtGetUserByName.get(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ ok: false, error: 'Identifiants incorrects' });
  }
  stmtEnsureProgress.run(user.id);
  const token = newToken();
  stmtInsertSession.run(token, user.id, Date.now());
  res.json({ ok: true, token, username: user.username });
});

app.post('/api/logout', (req, res) => {
  const { token } = req.body || {};
  if (typeof token === 'string') stmtDeleteSession.run(token);
  res.json({ ok: true });
});

const server = http.createServer(app);
const io = new Server(server);

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  const user = userFromToken(token);
  if (user) {
    socket.data.userId = user.id;
    socket.data.username = user.username;
  }
  next();
});

// Mémoire : association user_id -> socket pour les notifications
const socketsByUser = new Map();

io.on('connection', (socket) => {
  if (socket.data.userId) {
    if (!socketsByUser.has(socket.data.userId)) socketsByUser.set(socket.data.userId, new Set());
    socketsByUser.get(socket.data.userId).add(socket);
  }

  const userActiveAction = socket.data.userId ? stmtGetActiveAction.get(socket.data.userId) : null;
  const userProgress = socket.data.userId ? getProgressFor(socket.data.userId) : null;

  socket.emit('init', {
    resource: getResource(),
    ship,
    user: socket.data.userId ? { username: socket.data.username } : null,
    history: getRecentActionHistory(),
    elements: ELEMENTS,
    activeAction: userActiveAction || null,
    actionDurationMs: ACTION_MAX_DURATION_MS,
    actionTickMs: ACTION_TICK_MS,
    progress: userProgress,
    activeElements: getAllActiveElementStates()
  });

  socket.on('action:activate', (data, cb) => {
    const respond = (payload) => { if (typeof cb === 'function') cb(payload); };
    const uid = socket.data.userId;
    if (!uid) return respond({ ok: false, error: 'auth' });
    const elementId = String(data?.elementId || '');
    const actionId = String(data?.actionId || '');
    const el = ELEMENT_BY_ID[elementId];
    if (!el) return respond({ ok: false, error: 'element inconnu' });
    const action = el.actions.find(a => a.id === actionId);
    if (!action) return respond({ ok: false, error: 'action inconnue' });

    const now = Date.now();
    // Si une action est déjà active, on la solde puis on l'efface
    const prev = stmtGetActiveAction.get(uid);
    if (prev) {
      settleAction(prev, now);
      stmtInsertActionLog.run(uid, socket.data.username, prev.element_id, prev.action_id, prev.category, 'deactivate', now);
    }

    stmtUpsertActiveAction.run(uid, elementId, actionId, action.category, now, now);
    stmtInsertActionLog.run(uid, socket.data.username, elementId, actionId, action.category, 'activate', now);

    const newAction = stmtGetActiveAction.get(uid);
    const progress = getProgressFor(uid);

    // Broadcast l'état des éléments à tout le monde, et l'action perso au joueur
    io.emit('elements:update', { activeElements: getAllActiveElementStates() });
    io.emit('history:new', { username: socket.data.username, element_id: elementId, action_id: actionId, category: action.category, at: now });
    socket.emit('action:state', { activeAction: newAction, progress });
    respond({ ok: true });
  });

  socket.on('action:deactivate', (_, cb) => {
    const respond = (payload) => { if (typeof cb === 'function') cb(payload); };
    const uid = socket.data.userId;
    if (!uid) return respond({ ok: false, error: 'auth' });
    const prev = stmtGetActiveAction.get(uid);
    if (!prev) return respond({ ok: true });
    const now = Date.now();
    settleAction(prev, now);
    stmtDeleteActiveAction.run(uid);
    stmtInsertActionLog.run(uid, socket.data.username, prev.element_id, prev.action_id, prev.category, 'deactivate', now);
    const progress = getProgressFor(uid);
    io.emit('elements:update', { activeElements: getAllActiveElementStates() });
    socket.emit('action:state', { activeAction: null, progress });
    respond({ ok: true });
  });

  socket.on('streamer:auth', (data, cb) => {
    if (typeof cb !== 'function') return;
    if (data?.password !== STREAMER_PASSWORD) {
      cb({ ok: false });
      return;
    }
    if (streamerSocketId && streamerSocketId !== socket.id) {
      const prev = io.sockets.sockets.get(streamerSocketId);
      if (prev) {
        prev.data.isStreamer = false;
        prev.emit('streamer:kicked');
      }
    }
    streamerSocketId = socket.id;
    socket.data.isStreamer = true;
    cb({ ok: true });
  });

  socket.on('streamer:ship', (data) => {
    if (!socket.data.isStreamer) return;
    if (typeof data?.x !== 'number' || typeof data?.y !== 'number' || typeof data?.rotation !== 'number') return;
    if (!Number.isFinite(data.x) || !Number.isFinite(data.y) || !Number.isFinite(data.rotation)) return;
    ship.x = Math.max(0, Math.min(WORLD_W, data.x));
    ship.y = Math.max(0, Math.min(WORLD_H, data.y));
    ship.rotation = data.rotation;
    socket.broadcast.emit('ship', ship);
  });

  socket.on('disconnect', () => {
    if (socket.id === streamerSocketId) streamerSocketId = null;
    if (socket.data.userId) {
      const set = socketsByUser.get(socket.data.userId);
      if (set) {
        set.delete(socket);
        if (set.size === 0) socketsByUser.delete(socket.data.userId);
      }
    }
  });
});

// Solde une action active : crédite les points écoulés depuis last_settled_at jusqu'à now
// (ou jusqu'à started_at + 1h si dépassé), met à jour les compteurs joueur + global.
function settleAction(action, now) {
  const cap = action.started_at + ACTION_MAX_DURATION_MS;
  const settledThrough = Math.min(now, cap);
  const elapsedSinceLast = settledThrough - action.last_settled_at;
  if (elapsedSinceLast <= 0) return 0;
  const delta = Math.floor(elapsedSinceLast / ACTION_TICK_MS);
  if (delta <= 0) return 0;
  const newLastSettled = action.last_settled_at + delta * ACTION_TICK_MS;
  stmtUpdateLastSettled.run(newLastSettled, action.user_id);
  incrementCategory(action.user_id, action.category, delta);
  const newRes = getResource() + delta;
  setResource(newRes);
  return delta;
}

// Tick périodique : solde toutes les actions actives, expire celles >1h, broadcast la ressource
let lastBroadcastResource = -1;
function tickActions() {
  const now = Date.now();
  const all = stmtAllActiveActions.all();
  let anyChange = false;
  const expiredUserIds = [];
  for (const a of all) {
    const delta = settleAction(a, now);
    if (delta > 0) anyChange = true;
    if (now >= a.started_at + ACTION_MAX_DURATION_MS) {
      stmtDeleteActiveAction.run(a.user_id);
      stmtInsertActionLog.run(a.user_id, '', a.element_id, a.action_id, a.category, 'expire', now);
      expiredUserIds.push(a.user_id);
      anyChange = true;
    }
  }
  if (anyChange) {
    const res = getResource();
    if (res !== lastBroadcastResource) {
      io.emit('resource', { resource: res });
      lastBroadcastResource = res;
    }
    io.emit('elements:update', { activeElements: getAllActiveElementStates() });
    // Pour chaque user actif, notifier sa nouvelle progression personnelle
    const stillActive = stmtAllActiveActions.all();
    for (const a of stillActive) {
      const sockets = socketsByUser.get(a.user_id);
      if (!sockets) continue;
      const progress = getProgressFor(a.user_id);
      const activeAction = stmtGetActiveAction.get(a.user_id);
      for (const s of sockets) s.emit('action:state', { activeAction, progress });
    }
    // Pour ceux qui viennent d'expirer
    for (const uid of expiredUserIds) {
      const sockets = socketsByUser.get(uid);
      if (!sockets) continue;
      const progress = getProgressFor(uid);
      for (const s of sockets) s.emit('action:state', { activeAction: null, progress, expired: true });
    }
  }
}

setInterval(tickActions, ACTION_TICK_MS);

server.listen(PORT, () => {
  console.log(`VoidFaction écoute sur le port ${PORT}`);
  const fromEnv = !!process.env.STREAMER_PASSWORD;
  console.log(`Amiral : STREAMER_PASSWORD source=${fromEnv ? 'env' : 'défaut'}, longueur=${STREAMER_PASSWORD.length}`);
  try {
    const testFile = path.join(dataDir, '.write-test');
    fs.writeFileSync(testFile, String(Date.now()));
    fs.unlinkSync(testFile);
    console.log(`DB : dataDir=${dataDir} (écriture OK)`);
  } catch (e) {
    console.error(`DB : dataDir=${dataDir} ÉCHEC ÉCRITURE:`, e?.code || e?.message);
  }
});
