const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');

const STREAMER_PASSWORD = process.env.STREAMER_PASSWORD || 'satelitteOrion';
const PORT = Number(process.env.PORT) || 3000;
const BUILD_TIME = new Date().toISOString();
const WORLD_W = 2400;
const WORLD_H = 1350;
const TURRET_X = 1200;
const TURRET_Y = 1000;
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,20}$/;

const ACTION_TICK_MS = 10 * 1000;          // +1 toutes les 10 secondes
const ACTION_MAX_DURATION_MS = 60 * 60 * 1000; // 1 heure max par activation
const HISTORY_LIMIT = 10;

// Système de vagues d'ennemis
const WAVE_CHECK_INTERVAL_MS = 60 * 1000;  // check toutes les minutes
const WAVE_PROBABILITY = 0.35;             // 35% de chance par check
const WAVE_WARNING_MS = 10 * 1000;         // 10s d'alerte avant le spawn
const ENEMY_SPEED = 70;                    // px/s
const ENEMY_MIN = 3;
const ENEMY_MAX = 6;
const ENEMY_LEVELS_AVAILABLE = [1, 2]; // niveaux d'ennemis pouvant spawn (Ship_02/Ship_LVL_N)

const CATEGORIES = ['PUISSANCE', 'DEFENSIF', 'UTILITAIRE'];
const CATEGORY_TO_COLUMN = { PUISSANCE: 'puissance', DEFENSIF: 'defensif', UTILITAIRE: 'utilitaire' };

// ============ Configuration des éléments interactifs ============

const TURRET_ACTIONS = [
  { id: 'tir',        label: 'Améliorer Tir',   category: 'PUISSANCE' },
  { id: 'visee',      label: 'Améliorer Visée', category: 'PUISSANCE' },
  { id: 'reparation', label: 'Réparation',      category: 'DEFENSIF'  }
];
const BASE_ACTIONS = [
  { id: 'reparation', label: 'Réparation', category: 'DEFENSIF'   },
  { id: 'remplir',    label: 'Remplir',    category: 'UTILITAIRE' }
];
const MINING_ACTION = [{ id: 'minage', label: 'Minage', category: 'UTILITAIRE' }];

const ASTEROID_HP_MAX     = 240;
const ASTEROID_RESPAWN_MS = 20 * 60 * 1000;  // 20 minutes
const TURRET_HP_MAX       = 200;
const BASE_HP_MAX         = 400;
const BASE_ESSENCE_MAX    = 400;

const ELEMENTS = [
  // Base centrale
  { id: 'base-1', type: 'base', x: WORLD_W / 2, y: WORLD_H / 2,
    label: 'BASE', actions: BASE_ACTIONS },
  // Tourelles autour de la base (formation triangulaire)
  { id: 'turret-1', type: 'turret', x: 1200, y: 380,
    label: 'TOURELLE NORD', actions: TURRET_ACTIONS },
  { id: 'turret-2', type: 'turret', x: 1620, y: 970,
    label: 'TOURELLE SE',  actions: TURRET_ACTIONS },
  { id: 'turret-3', type: 'turret', x: 780,  y: 970,
    label: 'TOURELLE SO',  actions: TURRET_ACTIONS },
  // Astéroïdes : alternance matériaux / radius (variant aléatoire 01-15 attribué ci-dessous)
  { id: 'asteroid-0', type: 'asteroid', subtype: 'materiaux', x: 250,  y: 200,  scale: 1.4, label: 'ASTÉROÏDE (matériaux)', actions: MINING_ACTION },
  { id: 'asteroid-1', type: 'asteroid', subtype: 'radius',    x: 700,  y: 350,  scale: 1.0, label: 'ASTÉROÏDE (radius)',    actions: MINING_ACTION },
  { id: 'asteroid-2', type: 'asteroid', subtype: 'materiaux', x: 1700, y: 350,  scale: 1.2, label: 'ASTÉROÏDE (matériaux)', actions: MINING_ACTION },
  { id: 'asteroid-3', type: 'asteroid', subtype: 'radius',    x: 2150, y: 230,  scale: 0.9, label: 'ASTÉROÏDE (radius)',    actions: MINING_ACTION },
  { id: 'asteroid-4', type: 'asteroid', subtype: 'materiaux', x: 250,  y: 1130, scale: 1.6, label: 'ASTÉROÏDE (matériaux)', actions: MINING_ACTION },
  { id: 'asteroid-5', type: 'asteroid', subtype: 'radius',    x: 650,  y: 1080, scale: 0.95, label: 'ASTÉROÏDE (radius)',    actions: MINING_ACTION },
  { id: 'asteroid-6', type: 'asteroid', subtype: 'materiaux', x: 1750, y: 1100, scale: 1.1, label: 'ASTÉROÏDE (matériaux)', actions: MINING_ACTION },
  { id: 'asteroid-7', type: 'asteroid', subtype: 'radius',    x: 2180, y: 1220, scale: 1.3, label: 'ASTÉROÏDE (radius)',    actions: MINING_ACTION }
];

// Attribution d'un variant graphique aléatoire (1..15) à chaque astéroïde au démarrage
const ASTEROID_VARIANT_COUNT = 15;
for (const el of ELEMENTS) {
  if (el.type === 'asteroid') {
    el.variant = String(1 + Math.floor(Math.random() * ASTEROID_VARIANT_COUNT)).padStart(2, '0');
  }
}
const ELEMENT_BY_ID = Object.fromEntries(ELEMENTS.map(e => [e.id, e]));

// État runtime par élément (en mémoire — repop au boot via initElementState)
const elementStates = new Map();
function initElementState(el) {
  if (el.type === 'base') {
    elementStates.set(el.id, { hp: BASE_HP_MAX, hpMax: BASE_HP_MAX, essence: 0, essenceMax: BASE_ESSENCE_MAX });
  } else if (el.type === 'turret') {
    elementStates.set(el.id, { hp: TURRET_HP_MAX, hpMax: TURRET_HP_MAX, puissance: 0, range: 0 });
  } else if (el.type === 'asteroid') {
    elementStates.set(el.id, { hp: ASTEROID_HP_MAX, hpMax: ASTEROID_HP_MAX, subtype: el.subtype, destroyedAt: null, respawnsAt: null });
  }
}
for (const el of ELEMENTS) initElementState(el);

// Ressources globales (faction)
const factionResources = { materiaux: 0, radius: 0 };

function getPublicElementState(id) {
  const s = elementStates.get(id);
  if (!s) return null;
  return { id, ...s };
}
function getAllElementStates() {
  return ELEMENTS.map(e => getPublicElementState(e.id));
}

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

const ship = { x: WORLD_W / 2, y: WORLD_H / 2, rotation: 0 };
let streamerSocketId = null;
let currentWave = null;  // wave en cours (null si aucune)

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
    elementStates: getAllElementStates(),
    factionResources: { ...factionResources },
    activeAction: userActiveAction || null,
    actionDurationMs: ACTION_MAX_DURATION_MS,
    actionTickMs: ACTION_TICK_MS,
    progress: userProgress,
    activeElements: getAllActiveElementStates(),
    world: { width: WORLD_W, height: WORLD_H, turretX: TURRET_X, turretY: TURRET_Y },
    currentWave: currentWave && currentWave.endsAt > Date.now() ? currentWave : null,
    buildTime: BUILD_TIME
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
    // Refuse les activations sur un astéroïde détruit
    const st = elementStates.get(elementId);
    if (st && el.type === 'asteroid' && st.hp <= 0) {
      return respond({ ok: false, error: 'asteroïde détruit (respawn en cours)' });
    }

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

// Applique l'effet d'une action sur l'état de l'élément cible (1 tick = 1 unité).
// Retourne true si l'effet a été appliqué, false si l'élément n'existe plus ou n'est pas exploitable.
function applyActionEffect(actionId, element) {
  const state = elementStates.get(element.id);
  if (!state) return false;

  // Astéroïde détruit → minage inopérant
  if (element.type === 'asteroid' && state.hp <= 0) return false;

  switch (actionId) {
    case 'tir':
      state.puissance = (state.puissance || 0) + 1;
      return true;
    case 'visee':
      state.range = (state.range || 0) + 1;
      return true;
    case 'reparation':
      if (state.hp >= state.hpMax) return false;
      state.hp = Math.min(state.hp + 1, state.hpMax);
      return true;
    case 'remplir':
      if (state.essence >= state.essenceMax) return false;
      state.essence = Math.min(state.essence + 1, state.essenceMax);
      return true;
    case 'minage':
      state.hp = Math.max(0, state.hp - 1);
      if (state.subtype === 'materiaux') factionResources.materiaux += 1;
      else if (state.subtype === 'radius') factionResources.radius += 1;
      if (state.hp <= 0) destroyAsteroid(element.id);
      return true;
    default:
      return false;
  }
}

// Détruit un astéroïde : marque l'état, désactive les actions des joueurs qui le minaient,
// et programme un respawn 20 minutes plus tard.
function destroyAsteroid(id) {
  const state = elementStates.get(id);
  if (!state) return;
  state.destroyedAt = Date.now();
  state.respawnsAt = state.destroyedAt + ASTEROID_RESPAWN_MS;
  io.emit('asteroid:destroyed', { id, respawnsAt: state.respawnsAt });
  console.log(`[asteroid] ${id} détruit, respawn à ${new Date(state.respawnsAt).toISOString()}`);
  // Désactiver toutes les actions actives sur cet astéroïde
  const affected = db.prepare('SELECT user_id, action_id, category FROM active_actions WHERE element_id = ?').all(id);
  for (const a of affected) {
    stmtDeleteActiveAction.run(a.user_id);
    stmtInsertActionLog.run(a.user_id, '', id, a.action_id, a.category, 'expire', Date.now());
    const sockets = socketsByUser.get(a.user_id);
    if (sockets) {
      const progress = getProgressFor(a.user_id);
      for (const s of sockets) s.emit('action:state', { activeAction: null, progress, expired: true });
    }
  }
  // Programmer le respawn
  setTimeout(() => respawnAsteroid(id), ASTEROID_RESPAWN_MS);
}

function respawnAsteroid(id) {
  const state = elementStates.get(id);
  if (!state) return;
  state.hp = state.hpMax;
  state.destroyedAt = null;
  state.respawnsAt = null;
  io.emit('asteroid:respawned', { id, state: getPublicElementState(id) });
  console.log(`[asteroid] ${id} respawn`);
}

// Solde une action active : crédite les points écoulés depuis last_settled_at jusqu'à now
// (ou jusqu'à started_at + 1h si dépassé), met à jour les compteurs joueur + global +
// applique les effets sur l'élément ciblé.
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
  // Applique l'effet sur l'élément : N ticks = N applications
  const element = ELEMENT_BY_ID[action.element_id];
  if (element) {
    for (let i = 0; i < delta; i++) {
      const applied = applyActionEffect(action.action_id, element);
      // Si la cible devient inactive (asteroïde HP=0) on arrête d'appliquer
      if (!applied) break;
    }
  }
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
    io.emit('elements:update', {
      activeElements: getAllActiveElementStates(),
      states: getAllElementStates(),
      faction: { ...factionResources }
    });
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

// ============ Vagues d'ennemis ============

function rollWave() {
  // Si une vague est encore en cours (warning ou ennemis en vol), on saute
  if (currentWave && currentWave.endsAt > Date.now()) return;
  if (Math.random() > WAVE_PROBABILITY) return;

  const count = ENEMY_MIN + Math.floor(Math.random() * (ENEMY_MAX - ENEMY_MIN + 1));
  const baseAngle = Math.random() * Math.PI * 2;
  const spread = 0.5;

  // Cible : tourelle (40%) ou astéroïde (60%)
  const asteroids = ELEMENTS.filter(e => e.type === 'asteroid');
  const target = Math.random() < 0.4
    ? ELEMENT_BY_ID['turret-1']
    : asteroids[Math.floor(Math.random() * asteroids.length)];

  const cx = WORLD_W / 2;
  const cy = WORLD_H / 2;
  const r = Math.max(WORLD_W, WORLD_H) * 1.2; // au-delà du bord
  const margin = 80;

  const now = Date.now();
  const spawnAt = now + WAVE_WARNING_MS;
  const enemies = [];
  let maxTravel = 0;
  for (let i = 0; i < count; i++) {
    const a = baseAngle + (Math.random() - 0.5) * spread;
    const rawX = cx + Math.cos(a) * r;
    const rawY = cy + Math.sin(a) * r;
    const spawnX = Math.max(-margin, Math.min(WORLD_W + margin, rawX));
    const spawnY = Math.max(-margin, Math.min(WORLD_H + margin, rawY));
    const dist = Math.hypot(target.x - spawnX, target.y - spawnY);
    const travelMs = (dist / ENEMY_SPEED) * 1000;
    if (travelMs > maxTravel) maxTravel = travelMs;
    const level = ENEMY_LEVELS_AVAILABLE[Math.floor(Math.random() * ENEMY_LEVELS_AVAILABLE.length)];
    enemies.push({
      id: `e-${now}-${i}`,
      level,
      spawnX, spawnY,
      targetX: target.x, targetY: target.y,
      travelMs: Math.round(travelMs),
      // léger décalage de spawn entre ennemis pour les espacer
      spawnOffsetMs: Math.floor(Math.random() * 800)
    });
  }

  currentWave = {
    id: `w-${now}`,
    startedAt: now,
    warningEndsAt: spawnAt,
    spawnAt,
    targetId: target.id,
    targetLabel: target.label,
    edgeAngle: baseAngle,
    enemies,
    endsAt: spawnAt + Math.ceil(maxTravel) + 2000
  };
  io.emit('wave:incoming', currentWave);
  console.log(`[wave] ${currentWave.id} — ${count} ennemis vers ${target.id} (angle ${baseAngle.toFixed(2)} rad)`);
}

setInterval(rollWave, WAVE_CHECK_INTERVAL_MS);


server.listen(PORT, () => {
  console.log(`VoidFaction écoute sur le port ${PORT}`);
  const fromEnv = !!process.env.STREAMER_PASSWORD;
  console.log(`Amiral : STREAMER_PASSWORD source=${fromEnv ? 'env' : 'défaut'}, longueur=${STREAMER_PASSWORD.length}`);
  try {
    const testFile = path.join(dataDir, '.write-test');
    fs.writeFileSync(testFile, String(Date.now()));
    fs.unlinkSync(testFile);
    const fromEnvDir = !!process.env.DATA_DIR;
    const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    if (!fromEnvDir) {
      console.warn(`⚠️  DB : dataDir=${dataDir} (DATA_DIR non défini → stockage ÉPHÉMÈRE, perdu à chaque déploiement)`);
    } else {
      console.log(`DB : dataDir=${dataDir} (DATA_DIR=env, écriture OK)`);
    }
    console.log(`DB : ${userCount} utilisateur(s) existant(s) au démarrage`);
  } catch (e) {
    console.error(`DB : dataDir=${dataDir} ÉCHEC ÉCRITURE:`, e?.code || e?.message);
  }
});
