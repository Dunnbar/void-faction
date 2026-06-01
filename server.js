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
const BASE_X = WORLD_W / 2;
const BASE_Y = WORLD_H / 2;
const BASE_PERIMETER = 560;
const TURRET_X = BASE_X;
const TURRET_Y = BASE_Y;
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,20}$/;

const ACTION_TICK_MS = 10 * 1000;
const ACTION_MAX_DURATION_MS = 60 * 60 * 1000;
const HISTORY_LIMIT = 10;

const WAVE_CHECK_INTERVAL_MS = 60 * 1000;
const WAVE_PROBABILITY = 0.35;
const WAVE_WARNING_MS = 40 * 60 * 1000;  // 40 min de preavis avant l'arrivee des ennemis
const ENEMY_SPEED = 40;
const ENEMY_MIN = 3;
const ENEMY_MAX = 6;
const ENEMY_LEVELS_AVAILABLE = [1];

const CATEGORIES = ['PUISSANCE', 'DEFENSIF', 'UTILITAIRE'];
const CATEGORY_TO_COLUMN = { PUISSANCE: 'puissance', DEFENSIF: 'defensif', UTILITAIRE: 'utilitaire' };

// ============ Templates d'éléments (instanciés par Amiral) ============

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

// Astéroïdes : groupés par subtype, partagent une durée d'utilisation de 40 min.
// La durée descend naturellement (1s par seconde), accélérée par les tirs ennemis.
// Le minage ne consomme PAS la durée (produit seulement des ressources).
const ASTEROID_GROUP_DURATION_MS = 40 * 60 * 1000;  // 40 min
const ASTEROID_ENEMY_DAMAGE_MS = 30 * 1000;         // 30s retires par tir ennemi
const ASTEROID_RESPAWN_MS = 20 * 60 * 1000;
const ASTEROID_HP_MAX     = 240;  // legacy, gardé pour eventuel fallback
const TURRET_HP_MAX       = 200;
const BASE_HP_MAX         = 400;
const BASE_ESSENCE_MAX    = 400;
const BASE_HIT_DMG        = 3;    // degats par tir ennemi atteignant la base (tempo lent)

function poly(angleRad, dist) {
  return { x: Math.round(BASE_X + Math.cos(angleRad) * dist), y: Math.round(BASE_Y + Math.sin(angleRad) * dist) };
}
const TURRET_D = 260;
const ASTEROID_D = 700;
const ASTEROID_VARIANT_COUNT = 15;

const ELEMENT_TEMPLATES = (() => {
  const list = [
    { id: 'base-1', type: 'base', x: BASE_X, y: BASE_Y, label: 'BASE', actions: BASE_ACTIONS },
  ];
  const turretAngles = [-Math.PI/2, Math.PI*5/6, Math.PI/6];
  const turretLabels = ['TOURELLE NORD', 'TOURELLE SO', 'TOURELLE SE'];
  turretAngles.forEach((a, i) => {
    const p = poly(a, TURRET_D);
    list.push({ id: `turret-${i + 1}`, type: 'turret', x: p.x, y: p.y, label: turretLabels[i], actions: TURRET_ACTIONS });
  });
  // 4 materiaux serres a droite, 4 radius serres a gauche (chaque groupe centre sur son axe)
  const scales = [1.0, 1.1, 1.2, 0.9, 1.0, 0.95, 1.0, 1.05];
  const ASTEROID_GROUP_STEP = Math.PI / 12;  // 15 deg entre asteroides du meme groupe
  // Centrage : startAngle = centre - 1.5 * step (pour 4 asteroides)
  const halfSpan = 1.5 * ASTEROID_GROUP_STEP;
  const groupConfigs = [
    { subtype: 'materiaux', startAngle: Math.PI / 4 - halfSpan },        // centre au sud-est (π/4)
    { subtype: 'radius',    startAngle: -3 * Math.PI / 4 - halfSpan }    // centre au nord-ouest (-3π/4)
  ];
  let idx = 0;
  for (const cfg of groupConfigs) {
    for (let k = 0; k < 4; k++) {
      const angle = cfg.startAngle + k * ASTEROID_GROUP_STEP;
      const p = poly(angle, ASTEROID_D);
      list.push({
        id: `asteroid-${idx}`,
        type: 'asteroid',
        subtype: cfg.subtype,
        x: p.x, y: p.y, scale: scales[idx],
        label: `ASTÉROÏDE (${cfg.subtype})`,
        actions: MINING_ACTION
      });
      idx++;
    }
  }
  return list;
})();

function buildElementsForAmiral() {
  return ELEMENT_TEMPLATES.map(t => {
    const el = { ...t };
    if (el.type === 'asteroid') {
      el.variant = String(1 + Math.floor(Math.random() * ASTEROID_VARIANT_COUNT)).padStart(2, '0');
    }
    return el;
  });
}

function initStateFor(el) {
  if (el.type === 'base') {
    return { hp: BASE_HP_MAX, hpMax: BASE_HP_MAX, essence: BASE_ESSENCE_MAX, essenceMax: BASE_ESSENCE_MAX, bornAt: Date.now() };
  }
  if (el.type === 'turret') {
    return { hp: TURRET_HP_MAX, hpMax: TURRET_HP_MAX, puissance: 0, range: 0 };
  }
  if (el.type === 'asteroid') {
    // L'etat per-asteroide ne contient que le subtype ; la duree partagee est dans rt.asteroidGroups
    return { subtype: el.subtype };
  }
  return {};
}

// ============ DB schema ============

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const dbFilePath = path.join(dataDir, 'voidfaction.db');
const dbExistedBeforeBoot = fs.existsSync(dbFilePath);
let dbSizeBeforeBoot = 0;
try { dbSizeBeforeBoot = dbExistedBeforeBoot ? fs.statSync(dbFilePath).size : 0; } catch {}
console.log(`[boot] DB file ${dbFilePath} : ${dbExistedBeforeBoot ? `EXISTANT (${dbSizeBeforeBoot} octets)` : 'absent -> sera cree'}`);
const db = new Database(dbFilePath);
db.pragma('journal_mode = WAL');

// Détection migration : si la table users existe SANS amiral_id, on reset (changement de contrat).
function needsReset() {
  const usersExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (!usersExists) {
    console.log('[migration] table users absente -> creation complete (pas de reset)');
    return false;
  }
  const cols = db.prepare("PRAGMA table_info(users)").all();
  const hasAmiralId = !!cols.find(c => c.name === 'amiral_id');
  if (hasAmiralId) {
    console.log('[migration] table users OK (amiral_id present) -> conservation des donnees');
    return false;
  }
  console.log('[migration] table users ANCIEN schema (sans amiral_id) -> reset necessaire');
  return true;
}

if (needsReset()) {
  console.log('[migration] Refonte Amiraux : reset des utilisateurs et tables liées.');
  db.exec(`
    DROP TABLE IF EXISTS active_actions;
    DROP TABLE IF EXISTS user_progress;
    DROP TABLE IF EXISTS action_log;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS users;
  `);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE IF NOT EXISTS amirals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    grid_x INTEGER NOT NULL,
    grid_y INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS amiral_sessions (
    token TEXT PRIMARY KEY,
    amiral_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (amiral_id) REFERENCES amirals(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    amiral_id INTEGER NOT NULL,
    FOREIGN KEY (amiral_id) REFERENCES amirals(id) ON DELETE CASCADE
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
    amiral_id INTEGER NOT NULL,
    element_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    category TEXT NOT NULL,
    event_type TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_action_log_time ON action_log (at DESC);
  CREATE INDEX IF NOT EXISTS idx_action_log_amiral ON action_log (amiral_id, at DESC);

  -- L'Amiral peut activer une action a la fois (meme regle qu'un joueur)
  CREATE TABLE IF NOT EXISTS amiral_active_actions (
    amiral_id INTEGER PRIMARY KEY,
    element_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    category TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    last_settled_at INTEGER NOT NULL,
    FOREIGN KEY (amiral_id) REFERENCES amirals(id) ON DELETE CASCADE
  );
`);

// Ajoute colonnes de progression a la table amirals si pas encore presentes
{
  const cols = db.prepare("PRAGMA table_info(amirals)").all();
  if (!cols.find(c => c.name === 'puissance')) {
    db.exec("ALTER TABLE amirals ADD COLUMN puissance INTEGER NOT NULL DEFAULT 0");
    db.exec("ALTER TABLE amirals ADD COLUMN defensif INTEGER NOT NULL DEFAULT 0");
    db.exec("ALTER TABLE amirals ADD COLUMN utilitaire INTEGER NOT NULL DEFAULT 0");
    db.exec("ALTER TABLE amirals ADD COLUMN total INTEGER NOT NULL DEFAULT 0");
  }
}
db.prepare("INSERT OR IGNORE INTO state (key, value) VALUES ('resource', '0')").run();

// Prepared statements
const stmtGetState           = db.prepare('SELECT value FROM state WHERE key = ?');
const stmtSetState           = db.prepare('UPDATE state SET value = ? WHERE key = ?');

const stmtInsertAmiral       = db.prepare('INSERT INTO amirals (username, password_hash, created_at, grid_x, grid_y) VALUES (?, ?, ?, ?, ?)');
const stmtGetAmiralByName    = db.prepare('SELECT id, username, password_hash, grid_x, grid_y FROM amirals WHERE username = ?');
const stmtGetAmiralById      = db.prepare('SELECT id, username, grid_x, grid_y FROM amirals WHERE id = ?');
const stmtAllAmirals         = db.prepare('SELECT id, username, grid_x, grid_y FROM amirals');
const stmtAmiralGridUsed     = db.prepare('SELECT 1 AS x FROM amirals WHERE grid_x = ? AND grid_y = ?');
const stmtInsertAmiralSess   = db.prepare('INSERT INTO amiral_sessions (token, amiral_id, created_at) VALUES (?, ?, ?)');
const stmtGetAmiralSess      = db.prepare('SELECT amiral_id FROM amiral_sessions WHERE token = ?');
const stmtDeleteAmiralSess   = db.prepare('DELETE FROM amiral_sessions WHERE token = ?');

const stmtInsertUser         = db.prepare('INSERT INTO users (username, password_hash, created_at, amiral_id) VALUES (?, ?, ?, ?)');
const stmtGetUserByName      = db.prepare('SELECT id, username, password_hash, amiral_id FROM users WHERE username = ?');
const stmtGetUserById        = db.prepare('SELECT id, username, amiral_id FROM users WHERE id = ?');
const stmtInsertSession      = db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)');
const stmtGetSession         = db.prepare('SELECT user_id FROM sessions WHERE token = ?');
const stmtDeleteSession      = db.prepare('DELETE FROM sessions WHERE token = ?');

const stmtEnsureProgress = db.prepare('INSERT OR IGNORE INTO user_progress (user_id) VALUES (?)');
const stmtGetProgress    = db.prepare('SELECT puissance, defensif, utilitaire, total FROM user_progress WHERE user_id = ?');
const stmtIncPuissance   = db.prepare('UPDATE user_progress SET puissance = puissance + ?, total = total + ? WHERE user_id = ?');
const stmtIncDefensif    = db.prepare('UPDATE user_progress SET defensif  = defensif  + ?, total = total + ? WHERE user_id = ?');
const stmtIncUtilitaire  = db.prepare('UPDATE user_progress SET utilitaire = utilitaire + ?, total = total + ? WHERE user_id = ?');

const stmtGetActiveAction  = db.prepare('SELECT user_id, element_id, action_id, category, started_at, last_settled_at FROM active_actions WHERE user_id = ?');
const stmtAllActiveActions = db.prepare(`
  SELECT a.user_id, a.element_id, a.action_id, a.category, a.started_at, a.last_settled_at, u.amiral_id, u.username
  FROM active_actions a JOIN users u ON u.id = a.user_id
`);
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
const stmtUpdateLastSettled  = db.prepare('UPDATE active_actions SET last_settled_at = ? WHERE user_id = ?');
const stmtActiveOnElement    = db.prepare('SELECT a.user_id, a.action_id, a.category FROM active_actions a JOIN users u ON u.id = a.user_id WHERE a.element_id = ? AND u.amiral_id = ?');

const stmtInsertActionLog   = db.prepare('INSERT INTO action_log (user_id, username, amiral_id, element_id, action_id, category, event_type, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
const stmtRecentActionLog   = db.prepare("SELECT username, element_id, action_id, category, event_type, at FROM action_log WHERE event_type = 'activate' AND amiral_id = ? ORDER BY at DESC LIMIT ?");
const stmtActiveElementsBy  = db.prepare(`
  SELECT a.element_id, a.action_id, a.category, u.username
  FROM active_actions a JOIN users u ON u.id = a.user_id
  WHERE u.amiral_id = ?
`);

// Amiral active actions (slot dedie pour l'Amiral)
const stmtGetAmiralActive    = db.prepare('SELECT amiral_id, element_id, action_id, category, started_at, last_settled_at FROM amiral_active_actions WHERE amiral_id = ?');
const stmtAllAmiralActive    = db.prepare(`
  SELECT a.amiral_id, a.element_id, a.action_id, a.category, a.started_at, a.last_settled_at, am.username
  FROM amiral_active_actions a JOIN amirals am ON am.id = a.amiral_id
`);
const stmtUpsertAmiralActive = db.prepare(`
  INSERT INTO amiral_active_actions (amiral_id, element_id, action_id, category, started_at, last_settled_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(amiral_id) DO UPDATE SET
    element_id = excluded.element_id,
    action_id = excluded.action_id,
    category = excluded.category,
    started_at = excluded.started_at,
    last_settled_at = excluded.last_settled_at
`);
const stmtDeleteAmiralActive = db.prepare('DELETE FROM amiral_active_actions WHERE amiral_id = ?');
const stmtUpdateAmiralLastSettled = db.prepare('UPDATE amiral_active_actions SET last_settled_at = ? WHERE amiral_id = ?');
const stmtAmiralActiveOnElement   = db.prepare('SELECT amiral_id, action_id, category FROM amiral_active_actions WHERE element_id = ? AND amiral_id = ?');

// Amiral progression
const stmtGetAmiralProgress  = db.prepare('SELECT puissance, defensif, utilitaire, total FROM amirals WHERE id = ?');
const stmtIncAmiralPuissance = db.prepare('UPDATE amirals SET puissance = puissance + ?, total = total + ? WHERE id = ?');
const stmtIncAmiralDefensif  = db.prepare('UPDATE amirals SET defensif  = defensif  + ?, total = total + ? WHERE id = ?');
const stmtIncAmiralUtil      = db.prepare('UPDATE amirals SET utilitaire = utilitaire + ?, total = total + ? WHERE id = ?');

const getResource = () => parseInt(stmtGetState.get('resource').value, 10);
const setResource = (n) => stmtSetState.run(String(n), 'resource');

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
function amiralFromToken(token) {
  if (typeof token !== 'string' || !token) return null;
  const row = stmtGetAmiralSess.get(token);
  if (!row) return null;
  return stmtGetAmiralById.get(row.amiral_id) || null;
}

// ============ Runtime par Amiral ============

// Map<amiral_id, AmiralRuntime>
const amiralsRuntime = new Map();

function getOrCreateAmiralRuntime(amiral) {
  let rt = amiralsRuntime.get(amiral.id);
  if (rt) return rt;
  const elements = buildElementsForAmiral();
  const elementStates = new Map();
  for (const el of elements) elementStates.set(el.id, initStateFor(el));
  rt = {
    id: amiral.id,
    username: amiral.username,
    gridX: amiral.grid_x,
    gridY: amiral.grid_y,
    socketId: null,
    online: false,
    ship: { x: WORLD_W / 2, y: WORLD_H / 2 + 230, rotation: 0 },
    elements,
    elementById: Object.fromEntries(elements.map(e => [e.id, e])),
    elementStates,
    factionResources: { materiaux: 0, radius: 0 },
    currentWave: null,
    asteroidGroups: makeFreshAsteroidGroups()
  };
  amiralsRuntime.set(amiral.id, rt);
  return rt;
}

function makeFreshAsteroidGroups() {
  return {
    materiaux: { durationMs: ASTEROID_GROUP_DURATION_MS, durationMaxMs: ASTEROID_GROUP_DURATION_MS, destroyedAt: null, respawnsAt: null },
    radius:    { durationMs: ASTEROID_GROUP_DURATION_MS, durationMaxMs: ASTEROID_GROUP_DURATION_MS, destroyedAt: null, respawnsAt: null }
  };
}

// Précharge tous les amiraux (élements en mémoire dès le boot)
for (const a of stmtAllAmirals.all()) getOrCreateAmiralRuntime(a);

// Runtime de démo (uniquement en mémoire, pas en DB) : sert de fallback pour les
// visiteurs anonymes quand aucun Amiral n'est inscrit. Permet d'avoir une vue
// non-vide même au démarrage.
let demoRuntime = null;
function getDemoRuntime() {
  if (demoRuntime) return demoRuntime;
  const elements = buildElementsForAmiral();
  const elementStates = new Map();
  for (const el of elements) elementStates.set(el.id, initStateFor(el));
  demoRuntime = {
    id: 0,
    username: 'DEMO',
    gridX: 0, gridY: 0,
    socketId: null,
    online: false,
    ship: { x: WORLD_W / 2, y: WORLD_H / 2 + 230, rotation: 0 },
    elements,
    elementById: Object.fromEntries(elements.map(e => [e.id, e])),
    elementStates,
    factionResources: { materiaux: 0, radius: 0 },
    currentWave: null,
    asteroidGroups: makeFreshAsteroidGroups()
  };
  return demoRuntime;
}

const DAY_MS = 24 * 60 * 60 * 1000;
function publicElementState(rt, id) {
  const s = rt.elementStates.get(id);
  if (!s) return null;
  const el = rt.elementById[id];
  // Pour les astéroïdes, on renvoie la durée du groupe en tant que hp/hpMax
  // pour que le rendu HP bar reste compatible cote client.
  if (el && el.type === 'asteroid') {
    const group = rt.asteroidGroups[s.subtype];
    if (group) {
      return {
        id,
        subtype: s.subtype,
        hp: group.durationMs,
        hpMax: group.durationMaxMs,
        destroyedAt: group.destroyedAt,
        respawnsAt: group.respawnsAt
      };
    }
  }
  // Base : on calcule le nombre de jours depuis sa naissance
  if (el && el.type === 'base') {
    return {
      id, ...s,
      daysAlive: Math.floor((Date.now() - (s.bornAt || Date.now())) / DAY_MS)
    };
  }
  return { id, ...s };
}

// Renaissance de la base : reset HP/essence/bornAt et broadcast l'event
function rebirthBase(rt) {
  const baseEl = rt.elements.find(e => e.type === 'base');
  if (!baseEl) return;
  const state = rt.elementStates.get(baseEl.id);
  if (!state) return;
  state.hp = state.hpMax;
  state.essence = state.essenceMax;
  state.bornAt = Date.now();
  io.to(amiralRoom(rt.id)).emit('base:reborn', { id: baseEl.id, state: publicElementState(rt, baseEl.id) });
  console.log(`[amiral ${rt.username}] base ${baseEl.id} renaissance (jour 0)`);
}

// Hook pour appliquer des degats a la base (futur : tirs ennemis sur la base).
// Si HP tombe a 0 -> renaissance avec compteur de jours reset.
function applyBaseDamage(rt, dmg) {
  const baseEl = rt.elements.find(e => e.type === 'base');
  if (!baseEl) return;
  const state = rt.elementStates.get(baseEl.id);
  if (!state || dmg <= 0) return;
  state.hp = Math.max(0, state.hp - dmg);
  if (state.hp <= 0) {
    rebirthBase(rt);
  } else {
    io.to(amiralRoom(rt.id)).emit('elements:update', { states: [publicElementState(rt, baseEl.id)] });
  }
}
function allElementStates(rt) {
  return rt.elements.map(e => publicElementState(rt, e.id));
}
// Union des actions actives sur les elements d'un Amiral : joueurs + l'Amiral lui-meme
const stmtActiveElementsByAmiralUnion = db.prepare(`
  SELECT a.element_id, a.action_id, a.category, u.username
  FROM active_actions a JOIN users u ON u.id = a.user_id
  WHERE u.amiral_id = ?
  UNION ALL
  SELECT a.element_id, a.action_id, a.category, am.username
  FROM amiral_active_actions a JOIN amirals am ON am.id = a.amiral_id
  WHERE am.id = ?
`);
function activeElementStatesForAmiral(amiralId) {
  return stmtActiveElementsByAmiralUnion.all(amiralId, amiralId);
}
function recentHistoryForAmiral(amiralId) {
  return stmtRecentActionLog.all(amiralId, HISTORY_LIMIT).map(r => ({
    username: r.username,
    element_id: r.element_id,
    action_id: r.action_id,
    category: r.category,
    at: r.at
  }));
}

function amiralRoom(amiralId) { return `amiral-${amiralId}`; }

function getOnlineAmiralsList() {
  const out = [];
  for (const rt of amiralsRuntime.values()) {
    if (rt.online) out.push({ name: rt.username });
  }
  return out;
}
// Liste exhaustive (online + offline) pour le dropdown de signup
function getAllAmiralsList() {
  const out = [];
  for (const rt of amiralsRuntime.values()) {
    if (rt.id === 0) continue; // exclure le runtime demo
    out.push({ name: rt.username, online: !!rt.online });
  }
  return out;
}

// Allocation de case en spirale : cherche la plus proche du centre non utilisée
function nextFreeGridCell() {
  const used = new Set(stmtAllAmirals.all().map(a => `${a.grid_x},${a.grid_y}`));
  // Spirale carrée : on parcourt les anneaux r = 0, 1, 2, ...
  for (let r = 0; r < 1000; r++) {
    if (r === 0) {
      if (!used.has('0,0')) return { x: 0, y: 0 };
      continue;
    }
    const cells = [];
    // top row (y = -r)
    for (let x = -r; x <= r; x++) cells.push([x, -r]);
    // right col (x = r, y from -r+1 to r)
    for (let y = -r + 1; y <= r; y++) cells.push([r, y]);
    // bottom row (y = r, x from r-1 down to -r)
    for (let x = r - 1; x >= -r; x--) cells.push([x, r]);
    // left col (x = -r, y from r-1 down to -r+1)
    for (let y = r - 1; y >= -r + 1; y--) cells.push([-r, y]);
    for (const [x, y] of cells) {
      if (!used.has(`${x},${y}`)) return { x, y };
    }
  }
  return null;
}

// ============ HTTP / Socket ============

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

app.get('/api/amiraux', (_req, res) => {
  // Renvoie TOUS les amiraux (online + offline) pour permettre l'inscription joueur
  // meme si l'Amiral n'est pas connecte au moment du signup
  res.json({ amiraux: getAllAmiralsList() });
});

app.post('/api/amiral/signup', (req, res) => {
  const { username, password, masterCode } = req.body || {};
  if (typeof masterCode !== 'string' || masterCode !== STREAMER_PASSWORD) {
    return res.status(403).json({ ok: false, error: 'Code maître incorrect' });
  }
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return res.status(400).json({ ok: false, error: 'Pseudo invalide (3-20 caractères, alphanumériques)' });
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 200) {
    return res.status(400).json({ ok: false, error: 'Mot de passe : 6 caractères minimum' });
  }
  const existing = stmtGetAmiralByName.get(username);
  if (existing) return res.status(409).json({ ok: false, error: 'Ce pseudo Amiral est déjà pris' });
  const cell = nextFreeGridCell();
  if (!cell) return res.status(503).json({ ok: false, error: 'Plus de cases disponibles' });
  try {
    const info = stmtInsertAmiral.run(username, hashPassword(password), Date.now(), cell.x, cell.y);
    const amiral = stmtGetAmiralById.get(info.lastInsertRowid);
    getOrCreateAmiralRuntime(amiral);
    const token = newToken();
    stmtInsertAmiralSess.run(token, amiral.id, Date.now());
    res.json({ ok: true, token, username, gridX: cell.x, gridY: cell.y });
  } catch (e) {
    console.error('[amiral signup] erreur:', e?.code || '', e?.message || e);
    res.status(500).json({ ok: false, error: 'Erreur serveur: ' + (e?.code || e?.message || 'inconnue') });
  }
});

app.post('/api/amiral/login', (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ ok: false, error: 'Identifiants manquants' });
  }
  const amiral = stmtGetAmiralByName.get(username);
  if (!amiral || !verifyPassword(password, amiral.password_hash)) {
    return res.status(401).json({ ok: false, error: 'Identifiants incorrects' });
  }
  getOrCreateAmiralRuntime(amiral);
  const token = newToken();
  stmtInsertAmiralSess.run(token, amiral.id, Date.now());
  res.json({ ok: true, token, username: amiral.username, gridX: amiral.grid_x, gridY: amiral.grid_y });
});

app.post('/api/amiral/logout', (req, res) => {
  const { token } = req.body || {};
  if (typeof token === 'string') stmtDeleteAmiralSess.run(token);
  res.json({ ok: true });
});

app.post('/api/signup', (req, res) => {
  const { username, password, amiralName } = req.body || {};
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return res.status(400).json({ ok: false, error: 'Pseudo invalide (3-20 caractères, alphanumériques)' });
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 200) {
    return res.status(400).json({ ok: false, error: 'Mot de passe : 6 caractères minimum' });
  }
  if (typeof amiralName !== 'string' || !amiralName) {
    return res.status(400).json({ ok: false, error: 'Choisis un Amiral à rejoindre' });
  }
  const amiral = stmtGetAmiralByName.get(amiralName);
  if (!amiral) return res.status(400).json({ ok: false, error: 'Amiral inconnu' });
  // L'Amiral peut etre offline au moment du signup ; les actions seront juste bloquees
  // tant qu'il ne se connecte pas (verif faite dans action:activate)
  getOrCreateAmiralRuntime(amiral); // s'assure que le runtime existe
  const existing = stmtGetUserByName.get(username);
  if (existing) return res.status(409).json({ ok: false, error: 'Ce pseudo est déjà pris' });
  try {
    const info = stmtInsertUser.run(username, hashPassword(password), Date.now(), amiral.id);
    stmtEnsureProgress.run(info.lastInsertRowid);
    const token = newToken();
    stmtInsertSession.run(token, info.lastInsertRowid, Date.now());
    res.json({ ok: true, token, username, amiralName: amiral.username });
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
  const auth = socket.handshake.auth || {};
  // Tentative d'auth Amiral via amiralToken
  if (typeof auth.amiralToken === 'string' && auth.amiralToken) {
    const amiral = amiralFromToken(auth.amiralToken);
    if (amiral) {
      socket.data.amiralId = amiral.id;
      socket.data.amiralUsername = amiral.username;
    }
  }
  // Tentative d'auth Joueur via token
  if (typeof auth.token === 'string' && auth.token) {
    const user = userFromToken(auth.token);
    if (user) {
      socket.data.userId = user.id;
      socket.data.username = user.username;
      socket.data.userAmiralId = user.amiral_id;
    }
  }
  next();
});

const socketsByUser = new Map();

function broadcastAmiraux() {
  io.emit('amirals:update', { amiraux: getOnlineAmiralsList() });
}

io.on('connection', (socket) => {
  let amiralIdForRoom = null;

  if (socket.data.amiralId) {
    const rt = amiralsRuntime.get(socket.data.amiralId);
    if (rt) {
      // Si un autre socket pilote déjà cet Amiral, on kick l'ancien
      if (rt.socketId && rt.socketId !== socket.id) {
        const prev = io.sockets.sockets.get(rt.socketId);
        if (prev) {
          prev.data.amiralId = null;
          prev.emit('streamer:kicked');
        }
      }
      rt.socketId = socket.id;
      rt.online = true;
      socket.join(amiralRoom(rt.id));
      amiralIdForRoom = rt.id;
      if (!amiralSocketsById.has(socket.data.amiralId)) amiralSocketsById.set(socket.data.amiralId, new Set());
      amiralSocketsById.get(socket.data.amiralId).add(socket);
      broadcastAmiraux();
    }
  } else if (socket.data.userId && socket.data.userAmiralId) {
    socket.join(amiralRoom(socket.data.userAmiralId));
    amiralIdForRoom = socket.data.userAmiralId;
    if (!socketsByUser.has(socket.data.userId)) socketsByUser.set(socket.data.userId, new Set());
    socketsByUser.get(socket.data.userId).add(socket);
  }

  // Acteur = joueur OU Amiral (les deux peuvent avoir une action active)
  let userActiveAction = null;
  let userProgress = null;
  if (socket.data.amiralId) {
    userActiveAction = stmtGetAmiralActive.get(socket.data.amiralId) || null;
    userProgress = stmtGetAmiralProgress.get(socket.data.amiralId) || { puissance: 0, defensif: 0, utilitaire: 0, total: 0 };
  } else if (socket.data.userId) {
    userActiveAction = stmtGetActiveAction.get(socket.data.userId) || null;
    userProgress = getProgressFor(socket.data.userId);
  }

  // 1) Amiral connecté -> son propre monde
  // 2) Joueur affilié -> monde de son Amiral
  // 3) Visiteur anonyme / joueur non-affilié -> Amiral ALEATOIRE parmi les online (sinon parmi tous)
  let rtForInit = socket.data.amiralId
    ? amiralsRuntime.get(socket.data.amiralId)
    : (socket.data.userAmiralId ? amiralsRuntime.get(socket.data.userAmiralId) : null);
  if (!rtForInit) {
    const onlineList = [...amiralsRuntime.values()].filter(rt => rt.online);
    if (onlineList.length > 0) rtForInit = onlineList[Math.floor(Math.random() * onlineList.length)];
  }
  if (!rtForInit) {
    const allList = [...amiralsRuntime.values()];
    if (allList.length > 0) rtForInit = allList[Math.floor(Math.random() * allList.length)];
  }
  if (!rtForInit) {
    rtForInit = getDemoRuntime();
  }
  // Le visiteur anonyme rejoint la room de l'Amiral observé pour voir les events en live
  // (sauf demo runtime qui n'a pas de room dédiée)
  if (rtForInit && rtForInit.id !== 0 && !socket.data.amiralId && !socket.data.userAmiralId) {
    socket.join(amiralRoom(rtForInit.id));
  }

  socket.emit('init', {
    resource: getResource(),
    ship: rtForInit ? rtForInit.ship : null,
    user: socket.data.userId ? { username: socket.data.username } : null,
    amiral: socket.data.amiralId ? { username: socket.data.amiralUsername, gridX: rtForInit?.gridX, gridY: rtForInit?.gridY, isOwn: true } : null,
    watchedAmiral: rtForInit && rtForInit.username ? { username: rtForInit.username, gridX: rtForInit.gridX, gridY: rtForInit.gridY, online: !!rtForInit.online } : null,
    history: rtForInit ? recentHistoryForAmiral(rtForInit.id) : [],
    elements: rtForInit ? rtForInit.elements : [],
    elementStates: rtForInit ? allElementStates(rtForInit) : [],
    factionResources: rtForInit ? { ...rtForInit.factionResources } : { materiaux: 0, radius: 0 },
    activeAction: userActiveAction || null,
    actionDurationMs: ACTION_MAX_DURATION_MS,
    actionTickMs: ACTION_TICK_MS,
    progress: userProgress,
    activeElements: rtForInit ? activeElementStatesForAmiral(rtForInit.id) : [],
    world: { width: WORLD_W, height: WORLD_H, baseX: BASE_X, baseY: BASE_Y, basePerimeter: BASE_PERIMETER, turretX: TURRET_X, turretY: TURRET_Y },
    currentWave: rtForInit && rtForInit.currentWave && rtForInit.currentWave.endsAt > Date.now() ? rtForInit.currentWave : null,
    buildTime: BUILD_TIME
  });

  socket.on('action:activate', (data, cb) => {
    const respond = (payload) => { if (typeof cb === 'function') cb(payload); };
    const actor = getSocketActor(socket);
    if (!actor) return respond({ ok: false, error: 'auth' });
    const rt = amiralsRuntime.get(actor.amiralId);
    if (!rt) return respond({ ok: false, error: 'amiral inconnu' });
    // Les joueurs ne peuvent pas agir si l'Amiral est hors-ligne. L'Amiral lui-meme oui.
    if (actor.type === 'user' && !rt.online) return respond({ ok: false, error: 'amiral hors-ligne' });
    const elementId = String(data?.elementId || '');
    const actionId = String(data?.actionId || '');
    const el = rt.elementById[elementId];
    if (!el) return respond({ ok: false, error: 'element inconnu' });
    const action = el.actions.find(a => a.id === actionId);
    if (!action) return respond({ ok: false, error: 'action inconnue' });
    if (el.type === 'asteroid') {
      const st = rt.elementStates.get(elementId);
      const group = st && rt.asteroidGroups[st.subtype];
      if (group && group.destroyedAt) {
        return respond({ ok: false, error: 'astéroïdes détruits (respawn en cours)' });
      }
    }

    const now = Date.now();
    const prev = getActiveActionForActor(actor);
    if (prev) {
      settleActionGeneric(actor, prev, now, rt);
      insertActorActionLog(actor, rt.id, prev.element_id, prev.action_id, prev.category, 'deactivate', now);
    }

    upsertActiveActionForActor(actor, elementId, actionId, action.category, now);
    insertActorActionLog(actor, rt.id, elementId, actionId, action.category, 'activate', now);

    const newAction = getActiveActionForActor(actor);
    const progress = getProgressForActor(actor);

    io.to(amiralRoom(rt.id)).emit('elements:update', { activeElements: activeElementStatesForAmiral(rt.id) });
    io.to(amiralRoom(rt.id)).emit('history:new', { username: actor.displayName, element_id: elementId, action_id: actionId, category: action.category, at: now });
    socket.emit('action:state', { activeAction: newAction, progress });
    respond({ ok: true });
  });

  socket.on('action:deactivate', (_, cb) => {
    const respond = (payload) => { if (typeof cb === 'function') cb(payload); };
    const actor = getSocketActor(socket);
    if (!actor) return respond({ ok: false, error: 'auth' });
    const rt = amiralsRuntime.get(actor.amiralId);
    const prev = getActiveActionForActor(actor);
    if (!prev) return respond({ ok: true });
    const now = Date.now();
    if (rt) settleActionGeneric(actor, prev, now, rt);
    deleteActiveActionForActor(actor);
    insertActorActionLog(actor, actor.amiralId, prev.element_id, prev.action_id, prev.category, 'deactivate', now);
    const progress = getProgressForActor(actor);
    if (actor.amiralId) io.to(amiralRoom(actor.amiralId)).emit('elements:update', { activeElements: activeElementStatesForAmiral(actor.amiralId) });
    socket.emit('action:state', { activeAction: null, progress });
    respond({ ok: true });
  });

  socket.on('streamer:ship', (data) => {
    if (!socket.data.amiralId) return;
    const rt = amiralsRuntime.get(socket.data.amiralId);
    if (!rt) return;
    if (typeof data?.x !== 'number' || typeof data?.y !== 'number' || typeof data?.rotation !== 'number') return;
    if (!Number.isFinite(data.x) || !Number.isFinite(data.y) || !Number.isFinite(data.rotation)) return;
    rt.ship.x = Math.max(0, Math.min(WORLD_W, data.x));
    rt.ship.y = Math.max(0, Math.min(WORLD_H, data.y));
    rt.ship.rotation = data.rotation;
    socket.broadcast.to(amiralRoom(rt.id)).emit('ship', rt.ship);
  });

  // Tir ennemi atteignant la base : seul le client Amiral (streameur) fait autorite.
  // Le serveur applique un degat fixe (le client ne dicte pas la valeur).
  socket.on('streamer:base_hit', () => {
    if (!socket.data.amiralId) return;
    const rt = amiralsRuntime.get(socket.data.amiralId);
    if (!rt) return;
    applyBaseDamage(rt, BASE_HIT_DMG);
  });

  socket.on('disconnect', () => {
    if (socket.data.amiralId) {
      const rt = amiralsRuntime.get(socket.data.amiralId);
      if (rt && rt.socketId === socket.id) {
        rt.socketId = null;
        rt.online = false;
        broadcastAmiraux();
      }
      const set = amiralSocketsById.get(socket.data.amiralId);
      if (set) {
        set.delete(socket);
        if (set.size === 0) amiralSocketsById.delete(socket.data.amiralId);
      }
    }
    if (socket.data.userId) {
      const set = socketsByUser.get(socket.data.userId);
      if (set) {
        set.delete(socket);
        if (set.size === 0) socketsByUser.delete(socket.data.userId);
      }
    }
  });
});

// ============ Logique d'effet ============

function applyActionEffect(rt, actionId, element) {
  const state = rt.elementStates.get(element.id);
  if (!state) return false;
  // Astéroïde : verifier que le groupe n'est pas detruit
  if (element.type === 'asteroid') {
    const group = rt.asteroidGroups[state.subtype];
    if (!group || group.destroyedAt) return false;
  }

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
      // Le minage ne diminue PAS la duree (countdown naturel + tirs ennemis).
      // Il ne produit que des ressources.
      if (state.subtype === 'materiaux') rt.factionResources.materiaux += 1;
      else if (state.subtype === 'radius') rt.factionResources.radius += 1;
      return true;
    default:
      return false;
  }
}

function destroyAsteroidGroup(rt, subtype) {
  const group = rt.asteroidGroups[subtype];
  if (!group || group.destroyedAt) return;
  group.durationMs = 0;
  group.destroyedAt = Date.now();
  group.respawnsAt = group.destroyedAt + ASTEROID_RESPAWN_MS;
  const affectedIds = rt.elements.filter(e => e.type === 'asteroid' && e.subtype === subtype).map(e => e.id);
  io.to(amiralRoom(rt.id)).emit('asteroid:group_destroyed', { subtype, ids: affectedIds, respawnsAt: group.respawnsAt });
  console.log(`[amiral ${rt.username}] groupe ${subtype} detruit, respawn a ${new Date(group.respawnsAt).toISOString()}`);
  // Couper les actions en cours sur n'importe quel astéroïde de ce subtype
  for (const id of affectedIds) {
    const affected = stmtActiveOnElement.all(id, rt.id);
    for (const a of affected) {
      stmtDeleteActiveAction.run(a.user_id);
      stmtInsertActionLog.run(a.user_id, '', rt.id, id, a.action_id, a.category, 'expire', Date.now());
      const sockets = socketsByUser.get(a.user_id);
      if (sockets) {
        const progress = getProgressFor(a.user_id);
        for (const s of sockets) s.emit('action:state', { activeAction: null, progress, expired: true });
      }
    }
    // Egalement les actions de l'Amiral sur cet element
    const amAffected = stmtAmiralActiveOnElement.all(id, rt.id);
    for (const a of amAffected) {
      stmtDeleteAmiralActive.run(a.amiral_id);
      stmtInsertActionLog.run(0, rt.username, rt.id, id, a.action_id, a.category, 'expire', Date.now());
      const sockets = amiralSocketsById.get(a.amiral_id);
      if (sockets) {
        const progress = stmtGetAmiralProgress.get(a.amiral_id) || { puissance: 0, defensif: 0, utilitaire: 0, total: 0 };
        for (const s of sockets) s.emit('action:state', { activeAction: null, progress, expired: true });
      }
    }
  }
  // Rafraichit la liste des elements actifs pour TOUS les viewers (sinon le highlight
  // "en cours de minage" reste affiche sur les asteroides detruits jusqu'au prochain tick).
  io.to(amiralRoom(rt.id)).emit('elements:update', { activeElements: activeElementStatesForAmiral(rt.id) });
  setTimeout(() => respawnAsteroidGroup(rt, subtype), ASTEROID_RESPAWN_MS);
}

function respawnAsteroidGroup(rt, subtype) {
  const group = rt.asteroidGroups[subtype];
  if (!group) return;
  group.durationMs = group.durationMaxMs;
  group.destroyedAt = null;
  group.respawnsAt = null;
  const ids = rt.elements.filter(e => e.type === 'asteroid' && e.subtype === subtype).map(e => e.id);
  const states = ids.map(id => publicElementState(rt, id));
  io.to(amiralRoom(rt.id)).emit('asteroid:group_respawned', { subtype, ids, states });
  console.log(`[amiral ${rt.username}] groupe ${subtype} respawn`);
}

// Retire `damageMs` de la duree du groupe ; declenche destruction si <= 0.
// Utilise par le countdown naturel et par les tirs ennemis.
function applyAsteroidGroupDamage(rt, subtype, damageMs) {
  const group = rt.asteroidGroups[subtype];
  if (!group || group.destroyedAt) return;
  group.durationMs = Math.max(0, group.durationMs - damageMs);
  if (group.durationMs <= 0) destroyAsteroidGroup(rt, subtype);
}

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

// ============ Acteurs (user OU amiral) ============

function getSocketActor(socket) {
  if (socket.data.amiralId) {
    return {
      type: 'amiral',
      id: socket.data.amiralId,
      displayName: socket.data.amiralUsername || 'AMIRAL',
      amiralId: socket.data.amiralId
    };
  }
  if (socket.data.userId && socket.data.userAmiralId) {
    return {
      type: 'user',
      id: socket.data.userId,
      displayName: socket.data.username || 'joueur',
      amiralId: socket.data.userAmiralId
    };
  }
  return null;
}

function getActiveActionForActor(actor) {
  if (actor.type === 'amiral') return stmtGetAmiralActive.get(actor.id);
  return stmtGetActiveAction.get(actor.id);
}
function upsertActiveActionForActor(actor, elementId, actionId, category, now) {
  if (actor.type === 'amiral') return stmtUpsertAmiralActive.run(actor.id, elementId, actionId, category, now, now);
  return stmtUpsertActiveAction.run(actor.id, elementId, actionId, category, now, now);
}
function deleteActiveActionForActor(actor) {
  if (actor.type === 'amiral') return stmtDeleteAmiralActive.run(actor.id);
  return stmtDeleteActiveAction.run(actor.id);
}
function updateLastSettledForActor(actor, lastSettled) {
  if (actor.type === 'amiral') return stmtUpdateAmiralLastSettled.run(lastSettled, actor.id);
  return stmtUpdateLastSettled.run(lastSettled, actor.id);
}
function getProgressForActor(actor) {
  if (actor.type === 'amiral') return stmtGetAmiralProgress.get(actor.id) || { puissance: 0, defensif: 0, utilitaire: 0, total: 0 };
  return getProgressFor(actor.id);
}
function incrementCategoryForActor(actor, category, n) {
  if (n <= 0) return;
  if (actor.type === 'amiral') {
    if (category === 'PUISSANCE')      stmtIncAmiralPuissance.run(n, n, actor.id);
    else if (category === 'DEFENSIF')  stmtIncAmiralDefensif.run(n, n, actor.id);
    else if (category === 'UTILITAIRE') stmtIncAmiralUtil.run(n, n, actor.id);
  } else {
    incrementCategory(actor.id, category, n);
  }
}
// Pour action_log : on stocke user_id = 0 pour les Amiraux (le username reste informatif)
function insertActorActionLog(actor, amiralId, elementId, actionId, category, eventType, at) {
  const userIdField = actor.type === 'amiral' ? 0 : actor.id;
  stmtInsertActionLog.run(userIdField, actor.displayName, amiralId, elementId, actionId, category, eventType, at);
}

// Notification action:state vers tous les sockets de l'acteur
const amiralSocketsById = new Map();
function notifyActorActionState(actor, payload) {
  if (actor.type === 'amiral') {
    const set = amiralSocketsById.get(actor.id);
    if (!set) return;
    for (const s of set) s.emit('action:state', payload);
  } else {
    const set = socketsByUser.get(actor.id);
    if (!set) return;
    for (const s of set) s.emit('action:state', payload);
  }
}

function settleActionGeneric(actor, action, now, rt) {
  const cap = action.started_at + ACTION_MAX_DURATION_MS;
  const settledThrough = Math.min(now, cap);
  const elapsedSinceLast = settledThrough - action.last_settled_at;
  if (elapsedSinceLast <= 0) return 0;
  const delta = Math.floor(elapsedSinceLast / ACTION_TICK_MS);
  if (delta <= 0) return 0;
  const newLastSettled = action.last_settled_at + delta * ACTION_TICK_MS;
  updateLastSettledForActor(actor, newLastSettled);
  incrementCategoryForActor(actor, action.category, delta);
  const newRes = getResource() + delta;
  setResource(newRes);
  const element = rt.elementById[action.element_id];
  if (element) {
    for (let i = 0; i < delta; i++) {
      const applied = applyActionEffect(rt, action.action_id, element);
      if (!applied) break;
    }
  }
  return delta;
}

let lastBroadcastResource = -1;
function tickActions() {
  const now = Date.now();
  // Snapshots des actions actives : joueurs + Amiraux (chacun avec un acteur type)
  const userRows = stmtAllActiveActions.all().map(r => ({
    actor: { type: 'user', id: r.user_id, displayName: r.username, amiralId: r.amiral_id },
    action: r
  }));
  const amiralRows = stmtAllAmiralActive.all().map(r => ({
    actor: { type: 'amiral', id: r.amiral_id, displayName: r.username, amiralId: r.amiral_id },
    action: r
  }));
  const all = [...userRows, ...amiralRows];

  const dirtyAmiraux = new Set();
  const expiredActors = [];
  for (const { actor, action } of all) {
    const rt = amiralsRuntime.get(actor.amiralId);
    if (!rt) continue;
    const delta = settleActionGeneric(actor, action, now, rt);
    if (delta > 0) dirtyAmiraux.add(actor.amiralId);
    if (now >= action.started_at + ACTION_MAX_DURATION_MS) {
      deleteActiveActionForActor(actor);
      insertActorActionLog(actor, actor.amiralId, action.element_id, action.action_id, action.category, 'expire', now);
      expiredActors.push(actor);
      dirtyAmiraux.add(actor.amiralId);
    }
  }
  // Drain d'essence : 1 par tick (toutes les 10s) sur la base de chaque amiral.
  // L'essence alimente la base ; si elle tombe a 0, les tourelles sont desactivees (cote client).
  for (const rt of amiralsRuntime.values()) {
    const baseEl = rt.elements.find(e => e.type === 'base');
    if (!baseEl) continue;
    const state = rt.elementStates.get(baseEl.id);
    if (!state || state.essence <= 0) continue;
    state.essence = Math.max(0, state.essence - 1);
    dirtyAmiraux.add(rt.id);
  }
  if (dirtyAmiraux.size > 0) {
    const res = getResource();
    if (res !== lastBroadcastResource) {
      io.emit('resource', { resource: res });
      lastBroadcastResource = res;
    }
    for (const amiralId of dirtyAmiraux) {
      const rt = amiralsRuntime.get(amiralId);
      if (!rt) continue;
      io.to(amiralRoom(amiralId)).emit('elements:update', {
        activeElements: activeElementStatesForAmiral(amiralId),
        states: allElementStates(rt),
        faction: { ...rt.factionResources }
      });
    }
    // Notifier les acteurs encore actifs
    for (const { actor } of all) {
      if (expiredActors.find(e => e.type === actor.type && e.id === actor.id)) continue;
      const activeAction = getActiveActionForActor(actor);
      const progress = getProgressForActor(actor);
      notifyActorActionState(actor, { activeAction, progress });
    }
    for (const actor of expiredActors) {
      const progress = getProgressForActor(actor);
      notifyActorActionState(actor, { activeAction: null, progress, expired: true });
    }
  }
}
setInterval(tickActions, ACTION_TICK_MS);

// ============ Vagues (par Amiral en ligne) ============

function rollWaveFor(rt, force = false) {
  if (rt.currentWave && rt.currentWave.endsAt > Date.now()) return;
  if (!force && Math.random() > WAVE_PROBABILITY) return;

  const count = ENEMY_MIN + Math.floor(Math.random() * (ENEMY_MAX - ENEMY_MIN + 1));
  const baseAngle = Math.random() * Math.PI * 2;
  const spread = 1.9;
  const asteroids = rt.elements.filter(e => e.type === 'asteroid');
  const target = Math.random() < 0.4 ? rt.elementById['turret-1'] : asteroids[Math.floor(Math.random() * asteroids.length)];
  const cx = WORLD_W / 2;
  const cy = WORLD_H / 2;
  const r = Math.max(WORLD_W, WORLD_H) * 1.2;
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
      id: `e-${rt.id}-${now}-${i}`,
      level,
      spawnX, spawnY,
      targetX: target.x, targetY: target.y,
      travelMs: Math.round(travelMs),
      spawnOffsetMs: Math.floor(Math.random() * 3500)
    });
  }
  rt.currentWave = {
    id: `w-${rt.id}-${now}`,
    startedAt: now,
    warningEndsAt: spawnAt,
    spawnAt,
    targetId: target.id,
    targetLabel: target.label,
    edgeAngle: baseAngle,
    enemies,
    endsAt: spawnAt + Math.ceil(maxTravel) + 120000
  };
  io.to(amiralRoom(rt.id)).emit('wave:incoming', rt.currentWave);
  console.log(`[amiral ${rt.username}] wave ${rt.currentWave.id} — ${count} ennemis vers ${target.id}`);

  // Si la cible est un astéroïde, on planifie les tirs ennemis qui vont rogner
  // la durée du groupe (simulation server-side, indépendamment du combat client).
  if (target.type === 'asteroid' && target.subtype) {
    const subtype = target.subtype;
    const ENEMY_FIRE_INTERVAL_MS = 5000;
    const ENEMY_BURST_DURATION_MS = 30000; // ~6 tirs par ennemi avant qu'on suppose qu'il soit gere
    for (const enemy of enemies) {
      const enemyArrivesAt = spawnAt + enemy.spawnOffsetMs + enemy.travelMs;
      const ticksToFire = Math.ceil(ENEMY_BURST_DURATION_MS / ENEMY_FIRE_INTERVAL_MS);
      for (let t = 0; t < ticksToFire; t++) {
        const fireAt = enemyArrivesAt + t * ENEMY_FIRE_INTERVAL_MS;
        const delay = Math.max(0, fireAt - Date.now());
        setTimeout(() => {
          if (!rt.online) return;
          applyAsteroidGroupDamage(rt, subtype, ASTEROID_ENEMY_DAMAGE_MS);
        }, delay);
      }
    }
  }
}

// ============ Planning des vagues : horaires fixes (TZ Europe/Paris par defaut) ============
// Jour : 5 vagues entre 9h et 23h, spawn aleatoire dans la fenetre de 2h qui suit chaque slot
// Nuit : 1 seule vague entre 2h et 6h, spawn aleatoire dans la fenetre de 4h
// On peut surclasser la TZ via env var GAME_TZ
const GAME_TZ = process.env.GAME_TZ || 'Europe/Paris';
const DAY_WAVE_SLOT_HOURS = [9, 12, 15, 18, 21];       // chaque slot ouvre une fenetre [h, h+1]
const NIGHT_WAVE_WINDOW   = { startHour: 2, endHour: 6 };

const tzPartsFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: GAME_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false
});
function tzNow() {
  const now = new Date();
  const parts = tzPartsFmt.formatToParts(now);
  const get = (t) => parseInt(parts.find(p => p.type === t)?.value || '0', 10);
  const year = get('year'), month = get('month'), day = get('day');
  const hour = get('hour'), minute = get('minute');
  return {
    dateKey: `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`,
    hour, minute,
    minuteOfDay: hour * 60 + minute
  };
}

function ensureWaveSchedule(rt, t) {
  if (rt.waveScheduleDay === t.dateKey) return;
  rt.waveScheduleDay = t.dateKey;
  rt.waveFiredSlots = new Set();
  rt.waveSchedule = new Map();
  // Fenetre de 2h par slot (windows : [9h-11h], [12h-14h], [15h-17h], [18h-20h], [21h-23h])
  const DAY_WINDOW_MIN = 120;
  for (const h of DAY_WAVE_SLOT_HOURS) {
    const scheduled = h * 60 + Math.floor(Math.random() * DAY_WINDOW_MIN);
    rt.waveSchedule.set(`day${h}`, { scheduled, slotEnd: h * 60 + DAY_WINDOW_MIN });
  }
  const nightStartMin = NIGHT_WAVE_WINDOW.startHour * 60;
  const nightEndMin   = NIGHT_WAVE_WINDOW.endHour * 60;
  const nightScheduled = nightStartMin + Math.floor(Math.random() * (nightEndMin - nightStartMin));
  rt.waveSchedule.set('night', { scheduled: nightScheduled, slotEnd: nightEndMin });

  const fmtMin = m => `${Math.floor(m/60)}h${String(m%60).padStart(2,'0')}`;
  const summary = [...rt.waveSchedule.entries()].map(([k, v]) => `${k}@${fmtMin(v.scheduled)}`).join(', ');
  console.log(`[amiral ${rt.username}] planning vagues ${t.dateKey} (${GAME_TZ}) : ${summary}`);
}

function tickWaveScheduler() {
  const t = tzNow();
  for (const rt of amiralsRuntime.values()) {
    if (!rt.online) continue;
    ensureWaveSchedule(rt, t);
    for (const [slotKey, { scheduled, slotEnd }] of rt.waveSchedule.entries()) {
      if (rt.waveFiredSlots.has(slotKey)) continue;
      if (t.minuteOfDay >= scheduled && t.minuteOfDay < slotEnd) {
        rt.waveFiredSlots.add(slotKey);
        rollWaveFor(rt, true);
      } else if (t.minuteOfDay >= slotEnd) {
        // Slot dépassé (server eteint pendant la fenetre, ou Amiral pas en ligne au bon moment)
        // → on marque comme "fired" pour ne pas declencher en retard ; il sera reschedule demain
        rt.waveFiredSlots.add(slotKey);
      }
    }
  }
}
setInterval(tickWaveScheduler, 60 * 1000);
// Tick initial des le boot pour planifier la journee en cours
tickWaveScheduler();

// ============ Countdown naturel des groupes d'asteroides ============
// Toutes les secondes : decrement chaque groupe non detruit de 1000 ms.
// Broadcast d'un snapshot des etats toutes les 5s pour rafraichir la barre cote client.
let lastAsteroidBroadcast = 0;
setInterval(() => {
  const now = Date.now();
  const shouldBroadcast = (now - lastAsteroidBroadcast) >= 5000;
  if (shouldBroadcast) lastAsteroidBroadcast = now;
  for (const rt of amiralsRuntime.values()) {
    for (const subtype of ['materiaux', 'radius']) {
      const group = rt.asteroidGroups[subtype];
      if (!group || group.destroyedAt) continue;
      applyAsteroidGroupDamage(rt, subtype, 1000);
    }
    if (shouldBroadcast && rt.online) {
      const ids = rt.elements.filter(e => e.type === 'asteroid').map(e => e.id);
      const states = ids.map(id => publicElementState(rt, id));
      io.to(amiralRoom(rt.id)).emit('elements:update', { states });
    }
  }
}, 1000);

server.listen(PORT, () => {
  console.log(`VoidFaction écoute sur le port ${PORT}`);
  const fromEnv = !!process.env.STREAMER_PASSWORD;
  console.log(`Amiral : STREAMER_PASSWORD (code maître) source=${fromEnv ? 'env' : 'défaut'}, longueur=${STREAMER_PASSWORD.length}`);
  try {
    const testFile = path.join(dataDir, '.write-test');
    fs.writeFileSync(testFile, String(Date.now()));
    fs.unlinkSync(testFile);
    const fromEnvDir = !!process.env.DATA_DIR;
    const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const amiralCount = db.prepare('SELECT COUNT(*) AS n FROM amirals').get().n;
    if (!fromEnvDir) {
      console.warn(`⚠️  DB : dataDir=${dataDir} (DATA_DIR non défini → stockage ÉPHÉMÈRE, perdu à chaque déploiement)`);
    } else {
      console.log(`DB : dataDir=${dataDir} (DATA_DIR=env, écriture OK)`);
    }
    console.log(`DB : ${amiralCount} amiral(aux), ${userCount} joueur(s) au démarrage`);
  } catch (e) {
    console.error(`DB : dataDir=${dataDir} ÉCHEC ÉCRITURE:`, e?.code || e?.message);
  }
});
