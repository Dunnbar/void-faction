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
// Grille de "cases" explorables (chaque case = WORLD_W x WORLD_H). La base est dans la case (0,0).
// Pour l'instant on se restreint a la SEULE case de depart (grille 1x1). Repasser a -1..1
// (ou plus) pour reactiver l'exploration multi-cases + la minimap.
const MAP_MIN_I = 0, MAP_MAX_I = 0, MAP_MIN_J = 0, MAP_MAX_J = 0; // 1x1 : case de depart uniquement
// Max exclusif : -1 pour que floor(x/W) reste dans la derniere case (sinon le bord droit/bas
// retombe dans la case suivante, hors de la grille).
const SHIP_MIN_X = MAP_MIN_I * WORLD_W, SHIP_MAX_X = (MAP_MAX_I + 1) * WORLD_W - 1;
const SHIP_MIN_Y = MAP_MIN_J * WORLD_H, SHIP_MAX_Y = (MAP_MAX_J + 1) * WORLD_H - 1;
const BASE_X = WORLD_W / 2;
const BASE_Y = WORLD_H / 2;
const BASE_PERIMETER = 560;
const TURRET_X = BASE_X;
const TURRET_Y = BASE_Y;
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,20}$/;

const ACTION_TICK_MS = 10 * 1000;
const ACTION_MAX_DURATION_MS = 60 * 60 * 1000;
const HISTORY_LIMIT = 10;
const JOURNAL_LIMIT = 40; // nb d'entrees de journal conservees/affichees par base

// Niveaux viewer (par categorie). Max niveau 3. L'XP = nombre de vagues ou le joueur
// etait present + actif dans cette categorie. Seuils : niv2 a 5 vagues, niv3 a 15.
const LEVEL_XP = [5, 15];
const LEVEL_XP_MAX = LEVEL_XP[1];
function levelFromXp(xp) { return (xp >= LEVEL_XP[1]) ? 3 : (xp >= LEVEL_XP[0]) ? 2 : 1; }

const WAVE_CHECK_INTERVAL_MS = 60 * 1000;
const WAVE_PROBABILITY = 0.35;
const WAVE_WARNING_MS = 40 * 60 * 1000;  // 40 min de preavis avant l'arrivee des ennemis
const COMBAT_WINDOW_MS = 15 * 60 * 1000; // delai avant la 1re verif de resolution (hors-ligne) ; PAS de deadline en ligne
const ENEMY_SPEED = 40;
const ENEMY_MIN = 3;
const ENEMY_MAX = 6;
const ENEMY_LEVELS_AVAILABLE = [1];

// Types de vagues :
//  - normale  : 1 point de spawn, WAVE_GROUP_SIZE vaisseaux.
//  - soutenue : SOUTENUE_GROUPS points de spawn simultanes, WAVE_GROUP_SIZE chacun.
//  - dure     : 1 point de spawn + 1 boss (plus tanky/lent/dangereux). 1 seule/jour, jamais la nuit.
const WAVE_GROUP_SIZE      = 5;     // vaisseaux par point de spawn
const SOUTENUE_GROUPS      = 3;     // vague soutenue : 3 spawns en meme temps
const SOUTENUE_PROBABILITY = 0.25;  // hors vague dure : 25% soutenue, 75% normale
const BOSS_HP_FACTOR    = 4;        // boss : HP x4 (tanky)
const BOSS_DMG_FACTOR   = 3;        // boss : degats x3 sur base/tourelle
const BOSS_SPEED_FACTOR = 0.5;      // boss : 2x plus lent
const BOSS_SCALE        = 2.6;      // boss : sprite plus gros (cote client)

// Montee en difficulte : les ennemis deviennent plus forts au fil des jours de survie
// de la base (daysAlive). Tempo lent -> progression douce et plafonnee.
const ENEMY_HP_BASE        = 30;   // HP d'un ennemi au jour 0
const ENEMY_HP_PER_DAY     = 5;    // +5 HP par jour
const ENEMY_HP_CAP         = 150;  // plafond HP
const ENEMY_COUNT_PER_DAYS = 4;    // +1 ennemi tous les 4 jours
const ENEMY_COUNT_BONUS_CAP = 6;   // +6 ennemis max
const ENEMY_BASE_DMG_PER_DAYS = 2; // +1 degat sur la base tous les 2 jours
const ENEMY_BASE_DMG_CAP   = 15;   // plafond degat par tir sur la base

// Jours de survie de la base d'un Amiral (0 = naissance). Sert a la montee en difficulte.
function daysAliveFor(rt) {
  const baseEl = rt.elements.find(e => e.type === 'base');
  const s = baseEl && rt.elementStates.get(baseEl.id);
  const bornAt = (s && s.bornAt) || Date.now();
  return Math.max(0, Math.floor((Date.now() - bornAt) / DAY_MS));
}
function enemyHpForDay(day)      { return Math.min(ENEMY_HP_CAP, ENEMY_HP_BASE + day * ENEMY_HP_PER_DAY); }
function enemyCountBonus(day)    { return Math.min(ENEMY_COUNT_BONUS_CAP, Math.floor(day / ENEMY_COUNT_PER_DAYS)); }
function baseHitDmgForDay(day)   { return Math.min(ENEMY_BASE_DMG_CAP, BASE_HIT_DMG + Math.floor(day / ENEMY_BASE_DMG_PER_DAYS)); }

const CATEGORIES = ['PUISSANCE', 'DEFENSIF', 'UTILITAIRE'];
const CATEGORY_TO_COLUMN = { PUISSANCE: 'puissance', DEFENSIF: 'defensif', UTILITAIRE: 'utilitaire' };

// ============ Templates d'éléments (instanciés par Amiral) ============

const TURRET_ACTIONS = [
  { id: 'tir',        label: 'Puissance',  category: 'PUISSANCE', effect: '+1 par contributeur' },
  { id: 'visee',      label: 'Portée',     category: 'PUISSANCE', effect: '+1 par contributeur' },
  { id: 'reparation', label: 'Réparation', category: 'DEFENSIF',  effect: '+1 PV toutes les 10 s' }
];
const BASE_ACTIONS = [
  { id: 'reparation', label: 'Réparation', category: 'DEFENSIF',   effect: '+1 PV toutes les 10 s' },
  { id: 'remplir',    label: 'Remplir',    category: 'UTILITAIRE', effect: '+1 énergie toutes les 10 s' }
];
const MINING_ACTION = [{ id: 'minage', label: 'Minage', category: 'UTILITAIRE', effect: '+1 ressource toutes les 10 s' }];
const SHIP_ACTIONS = [
  { id: 'tir',      label: 'Tir',      category: 'PUISSANCE',  effect: '+1 par contributeur' },
  { id: 'capacite', label: 'Capacité', category: 'UTILITAIRE', effect: '+1 vitesse (max 10)' }
];
const SHIP_HP_MAX = 100;

// Astéroïdes : groupés par subtype, partagent une durée d'utilisation de 40 min.
// La durée descend naturellement (1s par seconde), accélérée par les tirs ennemis.
// Le minage ne consomme PAS la durée (produit seulement des ressources).
const ASTEROID_GROUP_DURATION_MS = 40 * 60 * 1000;  // 40 min
const ASTEROID_ENEMY_DAMAGE_MS = 30 * 1000;         // 30s retires par tir ennemi
const ASTEROID_RESPAWN_MS = 20 * 60 * 1000;
const ASTEROID_HP_MAX     = 240;  // legacy, gardé pour eventuel fallback
const TURRET_HP_MAX       = 200;
const BASE_HP_MAX         = 400;
const BASE_ESSENCE_MAX    = 720;   // 12h d'autonomie au drain de 1/min (cf. ESSENCE_DRAIN_MS)
const ESSENCE_DRAIN_MS    = 60 * 1000; // -1 essence par minute (720 min = 12h) ; assez lent pour que "Remplir" remonte vraiment
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
    // Vaisseau de l'Amiral : entree d'element virtuelle (position dynamique cote ship sync).
    // Permet d'attacher des actions (tir / portee) avec la meme mecanique que les tourelles.
    { id: 'ship-1', type: 'ship', x: BASE_X, y: BASE_Y, label: 'VAISSEAU', actions: SHIP_ACTIONS },
  ];
  const turretAngles = [-Math.PI/2, Math.PI*5/6, Math.PI/6];
  const turretLabels = ['TOURELLE NORD', 'TOURELLE SO', 'TOURELLE SE'];
  turretAngles.forEach((a, i) => {
    const p = poly(a, TURRET_D);
    list.push({ id: `turret-${i + 1}`, type: 'turret', x: p.x, y: p.y, label: turretLabels[i], actions: TURRET_ACTIONS });
  });
  // 4 materiaux serres a droite, 4 radius serres a gauche (chaque groupe centre sur son axe)
  const scales = [1.0, 1.1, 1.2, 0.9, 1.0, 0.95, 1.0, 1.05];
  const ASTEROID_GROUP_STEP = Math.PI / 18;  // 10 deg entre asteroides du meme groupe (groupes plus serres)
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
    // dead=true a 0 HP : seule la "reconstruction" est possible ; redevient active a 50% HP.
    return { hp: TURRET_HP_MAX, hpMax: TURRET_HP_MAX, puissance: 0, range: 0, dead: false };
  }
  if (el.type === 'ship') {
    return { hp: SHIP_HP_MAX, hpMax: SHIP_HP_MAX, puissance: 0, range: 0 };
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
// Captures d'ecran periodiques (retrospective 12h) : un dossier par Amiral.
const snapshotsDir = path.join(dataDir, 'snapshots');
fs.mkdirSync(snapshotsDir, { recursive: true });
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
    xp_puissance INTEGER NOT NULL DEFAULT 0,
    xp_defensif INTEGER NOT NULL DEFAULT 0,
    xp_utilitaire INTEGER NOT NULL DEFAULT 0,
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

  -- Journal d'evenements par base (vagues, montees de niveau, destructions...).
  -- Message pre-rendu cote serveur -> le client se contente d'afficher.
  CREATE TABLE IF NOT EXISTS journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amiral_id INTEGER NOT NULL,
    at INTEGER NOT NULL,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    FOREIGN KEY (amiral_id) REFERENCES amirals(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_journal ON journal (amiral_id, at DESC);

  -- Etat persistant des elements (base + tourelles) : HP, et essence pour la base.
  -- Ecrit periodiquement + sur degats/renaissance ; relu au demarrage pour survivre aux maj.
  CREATE TABLE IF NOT EXISTS element_state (
    amiral_id INTEGER NOT NULL,
    element_id TEXT NOT NULL,
    hp REAL,
    essence REAL,
    dead INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (amiral_id, element_id),
    FOREIGN KEY (amiral_id) REFERENCES amirals(id) ON DELETE CASCADE
  );

  -- Chat communautaire par base : messages des joueurs connectes sur l'Amiral.
  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amiral_id INTEGER NOT NULL,
    user_id INTEGER,
    username TEXT NOT NULL,
    message TEXT NOT NULL,
    at INTEGER NOT NULL,
    FOREIGN KEY (amiral_id) REFERENCES amirals(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_chat ON chat_messages (amiral_id, at DESC);

  -- Moderation du chat par base (decidee par l'Amiral) :
  --   muted_until = timeout temporaire (ts), banned = 1 -> ban permanent (chat + actions).
  CREATE TABLE IF NOT EXISTS chat_moderation (
    amiral_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    muted_until INTEGER,
    banned INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (amiral_id, user_id),
    FOREIGN KEY (amiral_id) REFERENCES amirals(id) ON DELETE CASCADE
  );
`);
// Migration : colonne dead pour les DB element_state existantes (tourelle detruite).
{
  const cols = db.prepare("PRAGMA table_info(element_state)").all();
  if (cols.length && !cols.find(c => c.name === 'dead')) {
    db.exec("ALTER TABLE element_state ADD COLUMN dead INTEGER NOT NULL DEFAULT 0");
  }
}

// Ajoute colonnes de progression a la table amirals si pas encore presentes
{
  const cols = db.prepare("PRAGMA table_info(amirals)").all();
  if (!cols.find(c => c.name === 'puissance')) {
    db.exec("ALTER TABLE amirals ADD COLUMN puissance INTEGER NOT NULL DEFAULT 0");
    db.exec("ALTER TABLE amirals ADD COLUMN defensif INTEGER NOT NULL DEFAULT 0");
    db.exec("ALTER TABLE amirals ADD COLUMN utilitaire INTEGER NOT NULL DEFAULT 0");
    db.exec("ALTER TABLE amirals ADD COLUMN total INTEGER NOT NULL DEFAULT 0");
  }
  // Position du vaisseau (persistance entre sessions). NULL -> position par defaut au 1er chargement.
  if (!cols.find(c => c.name === 'ship_x')) {
    db.exec("ALTER TABLE amirals ADD COLUMN ship_x REAL");
    db.exec("ALTER TABLE amirals ADD COLUMN ship_y REAL");
    db.exec("ALTER TABLE amirals ADD COLUMN ship_rot REAL");
  }
  // Naissance de la base (compteur de jours) : persiste pour survivre aux redemarrages.
  if (!cols.find(c => c.name === 'base_born_at')) {
    db.exec("ALTER TABLE amirals ADD COLUMN base_born_at INTEGER");
  }
  // Ressources de faction recoltees (minage) : persistent entre redemarrages.
  if (!cols.find(c => c.name === 'res_materiaux')) {
    db.exec("ALTER TABLE amirals ADD COLUMN res_materiaux INTEGER NOT NULL DEFAULT 0");
    db.exec("ALTER TABLE amirals ADD COLUMN res_radius INTEGER NOT NULL DEFAULT 0");
  }
}
// XP par categorie (niveaux viewer) sur user_progress
{
  const cols = db.prepare("PRAGMA table_info(user_progress)").all();
  if (cols.length && !cols.find(c => c.name === 'xp_puissance')) {
    db.exec("ALTER TABLE user_progress ADD COLUMN xp_puissance INTEGER NOT NULL DEFAULT 0");
    db.exec("ALTER TABLE user_progress ADD COLUMN xp_defensif INTEGER NOT NULL DEFAULT 0");
    db.exec("ALTER TABLE user_progress ADD COLUMN xp_utilitaire INTEGER NOT NULL DEFAULT 0");
  }
}
db.prepare("INSERT OR IGNORE INTO state (key, value) VALUES ('resource', '0')").run();

// Prepared statements
const stmtGetState           = db.prepare('SELECT value FROM state WHERE key = ?');
const stmtSetState           = db.prepare('UPDATE state SET value = ? WHERE key = ?');

const stmtInsertAmiral       = db.prepare('INSERT INTO amirals (username, password_hash, created_at, grid_x, grid_y) VALUES (?, ?, ?, ?, ?)');
const stmtGetAmiralByName    = db.prepare('SELECT id, username, password_hash, grid_x, grid_y, ship_x, ship_y, ship_rot, base_born_at FROM amirals WHERE username = ?');
const stmtGetAmiralById      = db.prepare('SELECT id, username, grid_x, grid_y, ship_x, ship_y, ship_rot, base_born_at, res_materiaux, res_radius FROM amirals WHERE id = ?');
const stmtAllAmirals         = db.prepare('SELECT id, username, grid_x, grid_y, ship_x, ship_y, ship_rot, base_born_at, res_materiaux, res_radius FROM amirals');
const stmtSetAmiralShip      = db.prepare('UPDATE amirals SET ship_x = ?, ship_y = ?, ship_rot = ? WHERE id = ?');
const stmtSetAmiralBornAt    = db.prepare('UPDATE amirals SET base_born_at = ? WHERE id = ?');
const stmtSetAmiralResources = db.prepare('UPDATE amirals SET res_materiaux = ?, res_radius = ? WHERE id = ?');
const stmtAmiralGridUsed     = db.prepare('SELECT 1 AS x FROM amirals WHERE grid_x = ? AND grid_y = ?');
const stmtInsertAmiralSess   = db.prepare('INSERT INTO amiral_sessions (token, amiral_id, created_at) VALUES (?, ?, ?)');
const stmtGetAmiralSess      = db.prepare('SELECT amiral_id FROM amiral_sessions WHERE token = ?');
const stmtDeleteAmiralSess   = db.prepare('DELETE FROM amiral_sessions WHERE token = ?');

const stmtInsertUser         = db.prepare('INSERT INTO users (username, password_hash, created_at, amiral_id) VALUES (?, ?, ?, ?)');
const stmtGetUserByName      = db.prepare('SELECT id, username, password_hash, amiral_id FROM users WHERE username = ?');
const stmtGetUserById        = db.prepare('SELECT id, username, amiral_id FROM users WHERE id = ?');
const stmtUsersByAmiral      = db.prepare('SELECT id, username FROM users WHERE amiral_id = ?');
const stmtInsertSession      = db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)');
const stmtGetSession         = db.prepare('SELECT user_id FROM sessions WHERE token = ?');
const stmtDeleteSession      = db.prepare('DELETE FROM sessions WHERE token = ?');

const stmtEnsureProgress = db.prepare('INSERT OR IGNORE INTO user_progress (user_id) VALUES (?)');
const stmtGetProgress    = db.prepare('SELECT puissance, defensif, utilitaire, total FROM user_progress WHERE user_id = ?');
const stmtIncPuissance   = db.prepare('UPDATE user_progress SET puissance = puissance + ?, total = total + ? WHERE user_id = ?');
const stmtIncDefensif    = db.prepare('UPDATE user_progress SET defensif  = defensif  + ?, total = total + ? WHERE user_id = ?');
const stmtIncUtilitaire  = db.prepare('UPDATE user_progress SET utilitaire = utilitaire + ?, total = total + ? WHERE user_id = ?');
// XP par categorie (niveaux). Capee a LEVEL_XP_MAX (le niveau plafonne a 3 de toute facon).
const stmtGetXp          = db.prepare('SELECT xp_puissance, xp_defensif, xp_utilitaire FROM user_progress WHERE user_id = ?');
const stmtIncXpPuissance = db.prepare('UPDATE user_progress SET xp_puissance = MIN(xp_puissance + ?, ?) WHERE user_id = ?');
const stmtIncXpDefensif  = db.prepare('UPDATE user_progress SET xp_defensif  = MIN(xp_defensif  + ?, ?) WHERE user_id = ?');
const stmtIncXpUtil      = db.prepare('UPDATE user_progress SET xp_utilitaire = MIN(xp_utilitaire + ?, ?) WHERE user_id = ?');
// Joueurs ayant une action active, par amiral (pour l'attribution d'XP a chaque vague)
const stmtActiveUsersByAmiral = db.prepare('SELECT a.user_id, a.category FROM active_actions a JOIN users u ON u.id = a.user_id WHERE u.amiral_id = ?');

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

// Persistance de l'etat des elements (HP base/tourelles, essence base)
const stmtUpsertElementState = db.prepare(`
  INSERT INTO element_state (amiral_id, element_id, hp, essence, dead)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(amiral_id, element_id) DO UPDATE SET hp = excluded.hp, essence = excluded.essence, dead = excluded.dead
`);
const stmtGetElementStates = db.prepare('SELECT element_id, hp, essence, dead FROM element_state WHERE amiral_id = ?');

// Ecrit en DB l'etat (HP + essence pour la base) des elements base/tourelle d'un Amiral.
// Pas de persistance pour le runtime de demo (id 0).
function persistElementStates(rt) {
  if (!rt || rt.id === 0) return;
  for (const el of rt.elements) {
    if (el.type !== 'base' && el.type !== 'turret') continue;
    const s = rt.elementStates.get(el.id);
    if (!s) continue;
    try { stmtUpsertElementState.run(rt.id, el.id, s.hp, el.type === 'base' ? s.essence : null, (el.type === 'turret' && s.dead) ? 1 : 0); } catch (e) {}
  }
  // Ressources de faction (minage) : persistees ici aussi, meme cadence que HP/essence.
  try { stmtSetAmiralResources.run(Math.round(rt.factionResources.materiaux || 0), Math.round(rt.factionResources.radius || 0), rt.id); } catch (e) {}
}

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
    baseDead: false,
    // Position du vaisseau : restauree depuis la DB si presente, sinon defaut (pres de la base).
    ship: {
      x: (amiral.ship_x ?? (WORLD_W / 2)),
      y: (amiral.ship_y ?? (WORLD_H / 2 + 230)),
      rotation: (amiral.ship_rot ?? 0)
    },
    _lastShipSave: 0,
    elements,
    elementById: Object.fromEntries(elements.map(e => [e.id, e])),
    elementStates,
    // Ressources de faction restaurees depuis la DB (persistent entre redemarrages).
    factionResources: { materiaux: amiral.res_materiaux || 0, radius: amiral.res_radius || 0 },
    currentWave: null,
    asteroidGroups: makeFreshAsteroidGroups()
  };
  // Naissance de la base : restauree depuis la DB (compteur de jours persistant).
  // Si absente (premiere fois), on persiste la valeur initiale.
  const baseEl = elements.find(e => e.type === 'base');
  if (baseEl) {
    const bs = rt.elementStates.get(baseEl.id);
    if (amiral.base_born_at != null) {
      bs.bornAt = amiral.base_born_at;
    } else if (amiral.id !== 0) { // pas pour le runtime demo
      try { stmtSetAmiralBornAt.run(bs.bornAt, amiral.id); } catch (e) {}
    }
  }
  // Restaure HP/essence persistes (base + tourelles) pour survivre aux redemarrages.
  if (amiral.id !== 0) {
    for (const row of stmtGetElementStates.all(amiral.id)) {
      const s = rt.elementStates.get(row.element_id);
      if (!s) continue;
      if (row.hp != null && s.hpMax != null) s.hp = Math.max(0, Math.min(row.hp, s.hpMax));
      if (row.essence != null && s.essenceMax != null) s.essence = Math.max(0, Math.min(row.essence, s.essenceMax));
      if (row.dead) s.dead = true; // tourelle detruite/en reconstruction (<50% HP)
    }
    // Base rechargee a 0 HP -> elle etait detruite : on conserve cet etat.
    if (baseEl) {
      const bsHp = rt.elementStates.get(baseEl.id);
      if (bsHp && bsHp.hp <= 0) rt.baseDead = true;
    }
  }
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
    baseDead: false,
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

// Compte les acteurs (joueurs + amiral) actuellement actifs sur (elementId, actionId)
// pour la runtime donnee. Utilise pour deriver puissance/range de tourelle a la volee.
// Somme des contributions des acteurs actifs sur (elementId, actionId) : niveau du joueur
// dans la categorie (1-3), +1 fixe par Amiral. Utilise pour puissance/portee des tourelles/vaisseau.
function sumContributionsOnAction(rt, elementId, actionId, category) {
  const users = stmtActiveOnElement.all(elementId, rt.id);
  const amir  = stmtAmiralActiveOnElement.all(elementId, rt.id);
  let n = 0;
  for (const a of users) if (a.action_id === actionId) n += userLevelForCategory(a.user_id, category);
  for (const a of amir)  if (a.action_id === actionId) n += 1;
  return n;
}

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
  // Tourelle / Vaisseau : puissance et portee = somme des niveaux PUISSANCE des acteurs actifs.
  if (el && (el.type === 'turret' || el.type === 'ship')) {
    // Tourelle : latch "morte" -> a 0 HP elle est detruite (seule la reconstruction est
    // possible) ; elle redevient active des 50% HP.
    if (el.type === 'turret') {
      if (s.hp <= 0) s.dead = true;
      else if (s.dead && s.hp >= s.hpMax * 0.5) s.dead = false;
    }
    const dead = el.type === 'turret' && s.dead;
    const out = {
      id, ...s,
      puissance: dead ? 0 : Math.max(1, Math.min(10, sumContributionsOnAction(rt, id, 'tir', 'PUISSANCE'))),
      range:     dead ? 0 : Math.max(1, Math.min(10, sumContributionsOnAction(rt, id, 'visee', 'PUISSANCE')))
    };
    // Le vaisseau a en plus une "capacite" (vitesse) boostee par les viewers (niveaux UTILITAIRE).
    if (el.type === 'ship') out.capacite = Math.max(1, Math.min(10, sumContributionsOnAction(rt, id, 'capacite', 'UTILITAIRE')));
    return out;
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

// Snapshot des etats publics des elements dont les stats derivent des acteurs actifs
// (tourelles + vaisseau). Utilise pour diffuser un bonus de puissance/portee en direct.
function turretStatesPayload(rt) {
  return rt.elements
    .filter(e => e.type === 'turret' || e.type === 'ship')
    .map(e => publicElementState(rt, e.id));
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
  if (rt.id !== 0) { try { stmtSetAmiralBornAt.run(state.bornAt, rt.id); } catch (e) {} }
  // Renaissance = RESET TOTAL : ressources a 0, tourelles + vaisseau pleine vie, gisements
  // restaures, vague en cours annulee, toutes les actions coupees. Seuls les NIVEAUX des
  // joueurs sont conserves (on ne touche pas a user_progress / xp).
  rt.factionResources.materiaux = 0;
  rt.factionResources.radius = 0;
  if (rt.id !== 0) { try { stmtSetAmiralResources.run(0, 0, rt.id); } catch (e) {} }
  for (const el of rt.elements) {
    const s = rt.elementStates.get(el.id);
    if (!s) continue;
    if (el.type === 'turret') { s.hp = s.hpMax; s.dead = false; }
    else if (el.type === 'ship') { s.hp = s.hpMax; }
  }
  clearAllActionsForAmiral(rt);
  rt.currentWave = null;
  rt.combat = null;
  persistElementStates(rt);
  respawnAsteroidGroup(rt, 'materiaux');
  respawnAsteroidGroup(rt, 'radius');
  io.to(amiralRoom(rt.id)).emit('base:reborn', { id: baseEl.id, state: publicElementState(rt, baseEl.id) });
  io.to(amiralRoom(rt.id)).emit('elements:update', {
    states: allElementStates(rt),
    activeElements: activeElementStatesForAmiral(rt.id),
    faction: { ...rt.factionResources }
  });
  logJournal(rt, 'base_reborn', `La base renaît — jour 0`);
  console.log(`[amiral ${rt.username}] base ${baseEl.id} renaissance (jour 0)`);
}

// Coupe TOUTES les actions en cours d'un Amiral (ses joueurs + lui-meme) et notifie chacun.
function clearAllActionsForAmiral(rt) {
  const now = Date.now();
  for (const r of stmtActiveUsersByAmiral.all(rt.id)) {
    stmtDeleteActiveAction.run(r.user_id);
    stmtInsertActionLog.run(r.user_id, '', rt.id, '', '', r.category, 'expire', now);
    const sockets = socketsByUser.get(r.user_id);
    if (sockets) {
      const progress = getProgressFor(r.user_id);
      for (const s of sockets) s.emit('action:state', { activeAction: null, progress, expired: true });
    }
  }
  const am = stmtGetAmiralActive.get(rt.id);
  if (am) {
    stmtDeleteAmiralActive.run(rt.id);
    const sockets = amiralSocketsById.get(rt.id);
    if (sockets) {
      const progress = stmtGetAmiralProgress.get(rt.id) || { puissance: 0, defensif: 0, utilitaire: 0, total: 0 };
      for (const s of sockets) s.emit('action:state', { activeAction: null, progress, expired: true });
    }
  }
}

// Degats a la base. A 0 HP : la base est DETRUITE (pas de renaissance auto).
// Le streameur doit cliquer "Recommencer" (streamer:rebirth) ; en attendant, plus personne n'agit.
function applyBaseDamage(rt, dmg) {
  const baseEl = rt.elements.find(e => e.type === 'base');
  if (!baseEl) return;
  const state = rt.elementStates.get(baseEl.id);
  if (!state || dmg <= 0 || rt.baseDead) return;
  state.hp = Math.max(0, state.hp - dmg);
  persistElementStates(rt);
  if (state.hp <= 0) {
    rt.baseDead = true;
    clearAllActionsForAmiral(rt);
    io.to(amiralRoom(rt.id)).emit('base:destroyed', { id: baseEl.id });
    io.to(amiralRoom(rt.id)).emit('elements:update', {
      states: [publicElementState(rt, baseEl.id)],
      activeElements: activeElementStatesForAmiral(rt.id)
    });
    logJournal(rt, 'base_destroyed', `💥 La base a été détruite !`);
    console.log(`[amiral ${rt.username}] BASE DETRUITE — en attente de relance`);
  } else {
    io.to(amiralRoom(rt.id)).emit('elements:update', { states: [publicElementState(rt, baseEl.id)] });
  }
}
// Degats a une tourelle (tir ennemi). A 0 HP -> detruite (dead) : reconstruction requise.
// Autoritatif serveur + persiste (la barre HP reste a jour apres un rechargement).
function applyTurretDamage(rt, turretId, dmg) {
  const el = rt.elementById[turretId];
  if (!el || el.type !== 'turret') return;
  const state = rt.elementStates.get(turretId);
  if (!state || dmg <= 0 || state.hp <= 0) return;
  state.hp = Math.max(0, state.hp - dmg);
  if (state.hp <= 0) {
    state.dead = true;
    logJournal(rt, 'turret', `${el.label} détruite`);
  }
  persistElementStates(rt);
  io.to(amiralRoom(rt.id)).emit('elements:update', { states: [publicElementState(rt, turretId)] });
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

// ============ Journal d'evenements (par base) ============
const stmtInsertJournal = db.prepare('INSERT INTO journal (amiral_id, at, type, message) VALUES (?, ?, ?, ?)');
const stmtRecentJournal = db.prepare('SELECT type, message, at FROM journal WHERE amiral_id = ? ORDER BY at DESC LIMIT ?');
const stmtTrimJournal   = db.prepare(`
  DELETE FROM journal WHERE amiral_id = ? AND id NOT IN (
    SELECT id FROM journal WHERE amiral_id = ? ORDER BY at DESC LIMIT ?
  )
`);
function recentJournalForAmiral(amiralId) {
  // Renvoie du plus ancien au plus recent (le client prepend les nouveaux).
  return stmtRecentJournal.all(amiralId, JOURNAL_LIMIT).reverse();
}
// Enregistre un evenement et le diffuse en direct a la room de la base.
// type : 'wave' | 'wave_repelled' | 'levelup' | 'base_destroyed' | 'base_reborn' | 'asteroid' ...
function logJournal(rt, type, message) {
  if (!rt) return;
  const at = Date.now();
  const entry = { type, message, at };
  if (rt.id !== 0) { // pas de persistance pour le runtime de demo
    try {
      stmtInsertJournal.run(rt.id, at, type, message);
      stmtTrimJournal.run(rt.id, rt.id, JOURNAL_LIMIT);
    } catch (e) {}
  }
  io.to(amiralRoom(rt.id)).emit('journal:new', entry);
}

// ============ Chat communautaire (par base) ============
const CHAT_LIMIT = 50;            // messages renvoyes a la connexion
const CHAT_MAX_LEN = 280;         // longueur max d'un message
const stmtInsertChat = db.prepare('INSERT INTO chat_messages (amiral_id, user_id, username, message, at) VALUES (?, ?, ?, ?, ?)');
const stmtRecentChat = db.prepare('SELECT user_id, username, message, at FROM chat_messages WHERE amiral_id = ? ORDER BY at DESC LIMIT ?');
const stmtTrimChat   = db.prepare(`
  DELETE FROM chat_messages WHERE amiral_id = ? AND id NOT IN (
    SELECT id FROM chat_messages WHERE amiral_id = ? ORDER BY at DESC LIMIT ?
  )
`);
function recentChatForAmiral(amiralId) {
  // Du plus ancien au plus recent (le client append en bas). userId expose pour la moderation,
  // level = niveau courant du joueur (cache par user pour eviter les requetes repetees).
  const lvlCache = new Map();
  const lvlFor = (uid) => {
    if (!uid) return null;
    if (!lvlCache.has(uid)) lvlCache.set(uid, userDisplayLevel(uid));
    return lvlCache.get(uid);
  };
  return stmtRecentChat.all(amiralId, CHAT_LIMIT)
    .map(r => ({ userId: r.user_id || null, username: r.username, message: r.message, at: r.at, level: lvlFor(r.user_id || null) }))
    .reverse();
}

// --- Moderation du chat (par base) ---
const CHAT_TIMEOUT_MS = 60 * 60 * 1000; // timeout = 1h
const stmtGetModeration = db.prepare('SELECT muted_until, banned FROM chat_moderation WHERE amiral_id = ? AND user_id = ?');
const stmtSetModeration = db.prepare(`
  INSERT INTO chat_moderation (amiral_id, user_id, muted_until, banned) VALUES (?, ?, ?, ?)
  ON CONFLICT(amiral_id, user_id) DO UPDATE SET muted_until = excluded.muted_until, banned = excluded.banned
`);
// banni de cette base (chat + actions) ?
function isBannedFromBase(amiralId, userId) {
  if (!amiralId || !userId) return false;
  const row = stmtGetModeration.get(amiralId, userId);
  return !!(row && row.banned);
}
// peut ecrire dans le chat de cette base ? -> { ok, reason, until }
function chatModerationStatus(amiralId, userId) {
  if (!amiralId || !userId) return { ok: true };
  const row = stmtGetModeration.get(amiralId, userId);
  if (!row) return { ok: true };
  if (row.banned) return { ok: false, reason: 'ban' };
  if (row.muted_until && row.muted_until > Date.now()) return { ok: false, reason: 'mute', until: row.muted_until };
  return { ok: true };
}

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

// Cache-busting : on sert index.html / stream.html avec ?v=<version> ajoute aux
// scripts/css locaux. La version change a chaque deploiement (BUILD_TIME), donc le
// navigateur recharge TOUJOURS le JS a jour, sans hard-refresh manuel.
const ASSET_VERSION = BUILD_TIME.replace(/[^0-9]/g, '');
const _htmlCache = new Map();
function serveVersionedHtml(fileName) {
  return (req, res, next) => {
    try {
      let html = _htmlCache.get(fileName);
      if (html === undefined) {
        const raw = fs.readFileSync(path.join(__dirname, 'public', fileName), 'utf8');
        // Ajoute ?v=VERSION sur les src/href locaux en .js / .css
        html = raw.replace(/(src|href)="((?:js\/|css\/|\.\/)?[^"]+\.(?:js|css))"/g,
          (m, attr, url) => url.startsWith('http') ? m : `${attr}="${url}?v=${ASSET_VERSION}"`);
        _htmlCache.set(fileName, html);
      }
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (e) { next(); }
  };
}
app.get(['/', '/index.html'], serveVersionedHtml('index.html'));
app.get('/stream.html', serveVersionedHtml('stream.html'));

app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    // HTML/JS/CSS : jamais mis en cache (le code evolue souvent ; evite de servir une
    // ancienne version en ligne, ex. shared-scene.js manquant -> halo/minimap absents).
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// Images de retrospective servies statiquement (cache court).
app.use('/snapshots', express.static(snapshotsDir, { maxAge: '1h' }));

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
  let userLevelsObj = { PUISSANCE: 1, DEFENSIF: 1, UTILITAIRE: 1 }; // Amiral = niveau 1 fixe
  if (socket.data.amiralId) {
    userActiveAction = stmtGetAmiralActive.get(socket.data.amiralId) || null;
    userProgress = stmtGetAmiralProgress.get(socket.data.amiralId) || { puissance: 0, defensif: 0, utilitaire: 0, total: 0 };
  } else if (socket.data.userId) {
    userActiveAction = stmtGetActiveAction.get(socket.data.userId) || null;
    userProgress = getProgressFor(socket.data.userId);
    userLevelsObj = userLevels(socket.data.userId);
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
  // Base actuellement observee : sert de cible pour le chat communautaire.
  socket.data.watchedAmiralId = rtForInit ? rtForInit.id : null;

  socket.emit('init', {
    resource: getResource(),
    ship: rtForInit ? rtForInit.ship : null,
    user: socket.data.userId ? { username: socket.data.username } : null,
    amiral: socket.data.amiralId ? { username: socket.data.amiralUsername, gridX: rtForInit?.gridX, gridY: rtForInit?.gridY, isOwn: true } : null,
    watchedAmiral: rtForInit && rtForInit.username ? { username: rtForInit.username, gridX: rtForInit.gridX, gridY: rtForInit.gridY, online: !!rtForInit.online } : null,
    history: rtForInit ? recentHistoryForAmiral(rtForInit.id) : [],
    journal: rtForInit ? recentJournalForAmiral(rtForInit.id) : [],
    chat: rtForInit && rtForInit.id !== 0 ? recentChatForAmiral(rtForInit.id) : [],
    chatBlocked: (socket.data.userId && rtForInit && rtForInit.id !== 0)
      ? (() => { const m = chatModerationStatus(rtForInit.id, socket.data.userId); return m.ok ? null : { reason: m.reason, until: m.until }; })()
      : null,
    elements: rtForInit ? rtForInit.elements : [],
    elementStates: rtForInit ? allElementStates(rtForInit) : [],
    factionResources: rtForInit ? { ...rtForInit.factionResources } : { materiaux: 0, radius: 0 },
    activeAction: userActiveAction || null,
    actionDurationMs: ACTION_MAX_DURATION_MS,
    actionTickMs: ACTION_TICK_MS,
    progress: userProgress,
    levels: userLevelsObj,
    xp: socket.data.userId ? userXp(socket.data.userId) : { PUISSANCE: 0, DEFENSIF: 0, UTILITAIRE: 0 },
    levelXp: LEVEL_XP,
    activeElements: rtForInit ? activeElementStatesForAmiral(rtForInit.id) : [],
    world: { width: WORLD_W, height: WORLD_H, baseX: BASE_X, baseY: BASE_Y, basePerimeter: BASE_PERIMETER, turretX: TURRET_X, turretY: TURRET_Y, gameTz: GAME_TZ,
             mapMinI: MAP_MIN_I, mapMaxI: MAP_MAX_I, mapMinJ: MAP_MIN_J, mapMaxJ: MAP_MAX_J },
    currentWave: rtForInit && rtForInit.currentWave && rtForInit.currentWave.endsAt > Date.now() ? rtForInit.currentWave : null,
    combatEnemies: rtForInit ? combatSnapshot(rtForInit.combat) : [],
    baseDead: rtForInit ? !!rtForInit.baseDead : false,
    buildTime: BUILD_TIME
  });

  // Amiral : tableau de bord (viewers connectes/inscrits + niveaux). Joueur : maj du dashboard de son amiral.
  if (socket.data.amiralId) pushAmiralDashboard(socket.data.amiralId);
  if (socket.data.userId && socket.data.userAmiralId) pushAmiralDashboard(socket.data.userAmiralId);

  socket.on('action:activate', (data, cb) => {
    const respond = (payload) => { if (typeof cb === 'function') cb(payload); };
    const actor = getSocketActor(socket);
    if (!actor) return respond({ ok: false, error: 'auth' });
    const rt = amiralsRuntime.get(actor.amiralId);
    if (!rt) return respond({ ok: false, error: 'amiral inconnu' });
    if (rt.baseDead) return respond({ ok: false, error: 'base détruite' });
    // Banni de cette base : ne peut plus agir sur ses elements.
    if (actor.type === 'user' && isBannedFromBase(rt.id, actor.id)) {
      return respond({ ok: false, error: 'banni de cette base' });
    }
    // Les joueurs peuvent agir a tout moment, meme si l'Amiral est hors-ligne
    // (le runtime de l'amiral est toujours en memoire et les actions se reglent au tick).
    const elementId = String(data?.elementId || '');
    const actionId = String(data?.actionId || '');
    const el = rt.elementById[elementId];
    if (!el) return respond({ ok: false, error: 'element inconnu' });
    const action = el.actions.find(a => a.id === actionId);
    if (!action) return respond({ ok: false, error: 'action inconnue' });
    // Tourelle detruite : seule la reconstruction (reparation) est autorisee.
    if (el.type === 'turret') {
      const st = rt.elementStates.get(elementId);
      if (st && st.dead && actionId !== 'reparation') {
        return respond({ ok: false, error: 'tourelle détruite : reconstruction requise' });
      }
    }
    if (el.type === 'asteroid') {
      const st = rt.elementStates.get(elementId);
      const group = st && rt.asteroidGroups[st.subtype];
      if (group && group.destroyedAt) {
        return respond({ ok: false, error: 'astéroïdes détruits (respawn en cours)' });
      }
    }
    // Ressources requises : reparation coute des Materiaux, remplir coute du Radius.
    if (actionId === 'reparation' && (rt.factionResources.materiaux || 0) <= 0) {
      return respond({ ok: false, error: 'Pas assez de matériaux' });
    }
    if (actionId === 'remplir' && (rt.factionResources.radius || 0) <= 0) {
      return respond({ ok: false, error: 'Pas assez de radius' });
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

    io.to(amiralRoom(rt.id)).emit('elements:update', {
      activeElements: activeElementStatesForAmiral(rt.id),
      // Diffuse les etats de tourelles : leur puissance/range derive du nombre d'acteurs actifs.
      states: turretStatesPayload(rt)
    });
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
    if (actor.amiralId && rt) {
      io.to(amiralRoom(actor.amiralId)).emit('elements:update', {
        activeElements: activeElementStatesForAmiral(actor.amiralId),
        // Diffuse les etats de tourelles : leur puissance/range derive du nombre d'acteurs actifs.
        states: turretStatesPayload(rt)
      });
    }
    socket.emit('action:state', { activeAction: null, progress });
    respond({ ok: true });
  });

  socket.on('streamer:ship', (data) => {
    if (!socket.data.amiralId) return;
    const rt = amiralsRuntime.get(socket.data.amiralId);
    if (!rt) return;
    if (typeof data?.x !== 'number' || typeof data?.y !== 'number' || typeof data?.rotation !== 'number') return;
    if (!Number.isFinite(data.x) || !Number.isFinite(data.y) || !Number.isFinite(data.rotation)) return;
    // Borne a la grille de cases (le vaisseau peut explorer au-dela de la case d'origine).
    rt.ship.x = Math.max(SHIP_MIN_X, Math.min(SHIP_MAX_X, data.x));
    rt.ship.y = Math.max(SHIP_MIN_Y, Math.min(SHIP_MAX_Y, data.y));
    rt.ship.rotation = data.rotation;
    rt.ship.moving = !!data.moving; // etat de deplacement (pour masquer les flammes a l'arret)
    socket.broadcast.to(amiralRoom(rt.id)).emit('ship', rt.ship);
    // Persistance DB throttlee (la position reste apres un refresh / redemarrage).
    const now = Date.now();
    if (now - (rt._lastShipSave || 0) > 3000) {
      rt._lastShipSave = now;
      try { stmtSetAmiralShip.run(rt.ship.x, rt.ship.y, rt.ship.rotation, rt.id); } catch (e) {}
    }
  });

  // Tir du vaisseau (touche Espace de l'Amiral) : le serveur fait autorite. Il resout la
  // touche contre les ennemis serveur (cible verrouillee ou ray-cast) et diffuse le tracer.
  socket.on('ship:fire', (data) => {
    if (!socket.data.amiralId) return;
    const rt = amiralsRuntime.get(socket.data.amiralId);
    if (!rt) return;
    if (!data || typeof data.x !== 'number' || typeof data.y !== 'number' || typeof data.angle !== 'number') return;
    if (!Number.isFinite(data.x) || !Number.isFinite(data.y) || !Number.isFinite(data.angle)) return;
    resolveShipFire(rt, { x: data.x, y: data.y, angle: data.angle, targetId: data.targetId ? String(data.targetId) : null });
  });

  // Retrospective : depot d'une capture d'ecran (seul le socket sollicite par snapshotTick).
  socket.on('snapshot:store', (data) => {
    const amiralId = socket.data.amiralId || socket.data.watchedAmiralId;
    if (!amiralId) return;
    const rt = amiralsRuntime.get(amiralId);
    if (!rt || rt.id === 0) return;
    if (socket.id !== rt._snapReqSocket || Date.now() - (rt._snapReqAt || 0) > 30000) return; // non sollicite
    if (!data || typeof data.dataUrl !== 'string') return;
    const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(data.dataUrl);
    if (!m) return;
    const buf = Buffer.from(m[1], 'base64');
    if (!buf.length || buf.length > SNAPSHOT_MAX_BYTES) return;
    const dir = snapshotDirFor(amiralId);
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, Date.now() + '.jpg'), buf); } catch (e) { return; }
    rt._snapReqSocket = null;
    pruneSnapshots(dir);
  });

  // Retrospective : liste des captures (12h) de la base regardee.
  socket.on('snapshot:list', (cb) => {
    if (typeof cb !== 'function') return;
    const amiralId = socket.data.amiralId || socket.data.watchedAmiralId;
    cb({ snapshots: amiralId ? listSnapshots(amiralId) : [] });
  });

  // "Recommencer" : seul l'Amiral relance sa base apres destruction (HP/essence/jour reinitialises).
  socket.on('streamer:rebirth', () => {
    if (!socket.data.amiralId) return;
    const rt = amiralsRuntime.get(socket.data.amiralId);
    if (!rt || !rt.baseDead) return;
    rt.baseDead = false;
    rebirthBase(rt);
    console.log(`[amiral ${rt.username}] base relancee (Recommencer)`);
  });

  // Chat communautaire : seul un utilisateur/Amiral connecte (avec pseudo) peut ecrire.
  // Le message est diffuse a la room de la base observee (cette base) et persiste.
  socket.on('chat:send', (data, cb) => {
    const reply = (p) => { if (typeof cb === 'function') cb(p); };
    const username = socket.data.username || socket.data.amiralUsername;
    if (!username) return reply({ ok: false, error: 'auth' });
    const amiralId = socket.data.watchedAmiralId;
    if (!amiralId || amiralId === 0) return reply({ ok: false, error: 'no_base' });
    // Moderation : un viewer muet/banni ne peut pas ecrire (l'Amiral n'est jamais modere chez lui).
    if (socket.data.userId) {
      const mod = chatModerationStatus(amiralId, socket.data.userId);
      if (!mod.ok) return reply({ ok: false, error: mod.reason, until: mod.until });
    }
    let text = (data && typeof data.message === 'string') ? data.message.trim() : '';
    if (!text) return reply({ ok: false, error: 'empty' });
    if (text.length > CHAT_MAX_LEN) text = text.slice(0, CHAT_MAX_LEN);
    const at = Date.now();
    const userId = socket.data.userId || null;
    try {
      stmtInsertChat.run(amiralId, userId, username, text, at);
      stmtTrimChat.run(amiralId, amiralId, CHAT_LIMIT);
    } catch (e) {}
    const level = userId ? userDisplayLevel(userId) : null;
    io.to(amiralRoom(amiralId)).emit('chat:new', { userId, username, message: text, at, level });
    reply({ ok: true });
  });

  // Moderation du chat : reservee a l'Amiral, sur les viewers de SA base.
  // action : 'mute1h' (timeout 1h) | 'ban' (chat + actions, permanent) | 'unban' (leve tout).
  socket.on('chat:moderate', (data, cb) => {
    const reply = (p) => { if (typeof cb === 'function') cb(p); };
    if (!socket.data.amiralId) return reply({ ok: false, error: 'auth' });
    const amiralId = socket.data.amiralId;
    const targetUserId = parseInt(data?.userId, 10);
    const action = String(data?.action || '');
    if (!targetUserId) return reply({ ok: false, error: 'no_target' });
    let muted_until = null, banned = 0, label = '';
    if (action === 'mute1h') { muted_until = Date.now() + CHAT_TIMEOUT_MS; label = 'timeout 1h'; }
    else if (action === 'ban') { banned = 1; label = 'banni'; }
    else if (action === 'unban') { label = 'reintegre'; }
    else return reply({ ok: false, error: 'bad_action' });
    try { stmtSetModeration.run(amiralId, targetUserId, muted_until, banned); } catch (e) {}
    // Notifie la cible si elle est connectee (maj de son UI chat + blocage actions cote serveur).
    const targetSockets = socketsByUser.get(targetUserId);
    if (targetSockets) for (const s of targetSockets) {
      if (s.data.watchedAmiralId === amiralId) s.emit('chat:moderated', { action, until: muted_until });
    }
    const uname = stmtGetUserById.get(targetUserId)?.username || `#${targetUserId}`;
    console.log(`[amiral ${socket.data.amiralUsername}] moderation : ${uname} -> ${label}`);
    reply({ ok: true, action });
  });

  socket.on('disconnect', () => {
    if (socket.data.amiralId) {
      const rt = amiralsRuntime.get(socket.data.amiralId);
      if (rt && rt.socketId === socket.id) {
        rt.socketId = null;
        rt.online = false;
        // Sauvegarde finale de la position du vaisseau.
        try { stmtSetAmiralShip.run(rt.ship.x, rt.ship.y, rt.ship.rotation, rt.id); } catch (e) {}
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
      // Maj du tableau de bord de l'amiral (un viewer s'est deconnecte).
      if (socket.data.userAmiralId) pushAmiralDashboard(socket.data.userAmiralId);
    }
  });
});

// ============ Logique d'effet ============

// amount = contribution de l'acteur (= son niveau dans la categorie, 1-3 ; 1 pour l'Amiral).
function applyActionEffect(rt, actionId, element, amount = 1) {
  const state = rt.elementStates.get(element.id);
  if (!state) return false;
  // Astéroïde : verifier que le groupe n'est pas detruit
  if (element.type === 'asteroid') {
    const group = rt.asteroidGroups[state.subtype];
    if (!group || group.destroyedAt) return false;
  }

  switch (actionId) {
    case 'tir':
    case 'visee':
    case 'capacite':
      // Pas d'accumulation : puissance/portee/capacite sont calculees dynamiquement
      // a partir de la somme des niveaux des acteurs actifs (cf. publicElementState).
      return true;
    case 'reparation': {
      if (state.hp >= state.hpMax) return false;
      // Cout : 1 Materiau par PV repare. Penurie -> 'no_resource' (l'action sera annulee).
      if ((rt.factionResources.materiaux || 0) < amount) return 'no_resource';
      rt.factionResources.materiaux -= amount;
      const wasDead = element.type === 'turret' && state.dead;
      state.hp = Math.min(state.hp + amount, state.hpMax);
      // Tourelle en reconstruction : reactivee des 50% HP (+ journal).
      if (wasDead && state.hp >= state.hpMax * 0.5) {
        state.dead = false;
        logJournal(rt, 'turret', `${element.label} réactivée`);
      }
      return true;
    }
    case 'remplir':
      if (state.essence >= state.essenceMax) return false;
      // Cout : 1 Radius par point d'essence. Penurie -> 'no_resource'.
      if ((rt.factionResources.radius || 0) < amount) return 'no_resource';
      rt.factionResources.radius -= amount;
      state.essence = Math.min(state.essence + amount, state.essenceMax);
      return true;
    case 'minage':
      // Produit des ressources proportionnellement au niveau UTILITAIRE du joueur.
      if (state.subtype === 'materiaux') rt.factionResources.materiaux += amount;
      else if (state.subtype === 'radius') rt.factionResources.radius += amount;
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
  // (pas de journal pour les gisements detruits : trop frequent, ca noierait le journal)
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

// Niveaux (1-3) d'un joueur par categorie, derives de son XP.
function userLevels(uid) {
  stmtEnsureProgress.run(uid);
  const r = stmtGetXp.get(uid) || {};
  return {
    PUISSANCE:  levelFromXp(r.xp_puissance  || 0),
    DEFENSIF:   levelFromXp(r.xp_defensif   || 0),
    UTILITAIRE: levelFromXp(r.xp_utilitaire || 0)
  };
}
function userLevelForCategory(uid, category) {
  return userLevels(uid)[category] || 1;
}
// XP brute d'un joueur par categorie (pour les barres de progression cote client).
function userXp(uid) {
  stmtEnsureProgress.run(uid);
  const r = stmtGetXp.get(uid) || {};
  return { PUISSANCE: r.xp_puissance || 0, DEFENSIF: r.xp_defensif || 0, UTILITAIRE: r.xp_utilitaire || 0 };
}
// Niveau "global" d'un joueur (le plus haut des 3 categories) : affiche dans le chat.
function userDisplayLevel(uid) {
  const l = userLevels(uid);
  return Math.max(l.PUISSANCE, l.DEFENSIF, l.UTILITAIRE);
}
// Contribution (multiplicateur) d'un acteur pour une action : niveau du joueur, ou +1 fixe pour l'Amiral.
function actorContribution(actor, category) {
  if (!actor || actor.type === 'amiral') return 1;
  return userLevelForCategory(actor.id, category);
}
function incrementXp(uid, category, n) {
  if (n <= 0) return;
  if (category === 'PUISSANCE')       stmtIncXpPuissance.run(n, LEVEL_XP_MAX, uid);
  else if (category === 'DEFENSIF')   stmtIncXpDefensif.run(n, LEVEL_XP_MAX, uid);
  else if (category === 'UTILITAIRE') stmtIncXpUtil.run(n, LEVEL_XP_MAX, uid);
}
// Tableau de bord Amiral : viewers inscrits sur sa base, combien connectes, et leurs niveaux.
function amiralDashboard(amiralId) {
  const rows = stmtUsersByAmiral.all(amiralId);
  let connected = 0;
  const users = rows.map(u => {
    const set = socketsByUser.get(u.id);
    const online = !!(set && set.size > 0);
    if (online) connected++;
    const lv = userLevels(u.id);
    return { username: u.username, online, levels: { puissance: lv.PUISSANCE, defensif: lv.DEFENSIF, utilitaire: lv.UTILITAIRE } };
  });
  // Connectes d'abord, puis par niveau total decroissant
  users.sort((a, b) => (b.online - a.online) ||
    ((b.levels.puissance + b.levels.defensif + b.levels.utilitaire) - (a.levels.puissance + a.levels.defensif + a.levels.utilitaire)));
  return { connected, total: rows.length, users };
}
function pushAmiralDashboard(amiralId) {
  if (!amiralId) return;
  const set = amiralSocketsById.get(amiralId);
  if (!set || set.size === 0) return;
  const dash = amiralDashboard(amiralId);
  for (const s of set) s.emit('dashboard', dash);
}

// Attribution d'XP a un joueur present (connecte) sur une categorie. Emet 'levels' + journal de niveau.
// ATTAQUE (PUISSANCE) : seulement pendant un combat. DEFENSE/UTILITAIRE : au temps passe a agir.
function awardActionXp(rt, userId, category, n) {
  if (!rt || n <= 0) return;
  const sockets = socketsByUser.get(userId);
  if (!sockets || sockets.size === 0) return; // present requis
  stmtEnsureProgress.run(userId);
  const before = userLevels(userId)[category] || 1;
  incrementXp(userId, category, n);
  const levels = userLevels(userId);
  const xp = userXp(userId);
  for (const s of sockets) s.emit('levels', { levels, xp, gain: { category, n } });
  const after = levels[category] || 1;
  if (after > before) {
    const uname = [...sockets][0]?.data?.username || 'Un viewer';
    logJournal(rt, 'levelup', `${uname} passe niveau ${after} en ${category}`);
  }
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
  let blocked = false; // penurie de ressource -> l'action doit etre annulee par l'appelant
  if (element) {
    const amount = actorContribution(actor, action.category); // niveau du joueur (1-3), 1 pour l'Amiral
    for (let i = 0; i < delta; i++) {
      const applied = applyActionEffect(rt, action.action_id, element, amount);
      if (applied === 'no_resource') { blocked = true; break; }
      if (!applied) break;
    }
  }
  return { delta, blocked };
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

  // HP avant settlement (pour diffuser le GAIN TOTAL "+N" par element, somme de tous les
  // contributeurs, et pas la contribution individuelle de chaque joueur).
  const hpBefore = new Map();
  for (const rt of amiralsRuntime.values()) {
    for (const el of rt.elements) {
      if (el.type === 'turret' || el.type === 'base' || el.type === 'ship') {
        const s = rt.elementStates.get(el.id);
        if (s) hpBefore.set(rt.id + ':' + el.id, s.hp);
      }
    }
  }

  const dirtyAmiraux = new Set();
  const expiredActors = [];
  for (const { actor, action } of all) {
    const rt = amiralsRuntime.get(actor.amiralId);
    if (!rt) continue;
    const { delta, blocked } = settleActionGeneric(actor, action, now, rt);
    if (delta > 0) dirtyAmiraux.add(actor.amiralId);
    // XP des viewers : DEFENSE/UTILITAIRE montent au temps passe a agir ; ATTAQUE (PUISSANCE)
    // ne monte QUE pendant un combat (et on retient le joueur comme participant a la bataille).
    if (delta > 0 && actor.type === 'user') {
      const cat = action.category;
      if (cat === 'DEFENSIF' || cat === 'UTILITAIRE') {
        awardActionXp(rt, actor.id, cat, delta);
      } else if (cat === 'PUISSANCE' && combatActiveFor(rt)) {
        awardActionXp(rt, actor.id, cat, delta);
        rt.combat.participants.add(actor.id);
      }
    }
    // Penurie de ressource (reparation/remplir) OU duree max atteinte -> on coupe l'action.
    if (blocked || now >= action.started_at + ACTION_MAX_DURATION_MS) {
      deleteActiveActionForActor(actor);
      insertActorActionLog(actor, actor.amiralId, action.element_id, action.action_id, action.category, 'expire', now);
      expiredActors.push(actor);
      dirtyAmiraux.add(actor.amiralId);
    }
  }
  // Drain d'essence : -1 par MINUTE (720 min = 12h d'autonomie). Assez lent pour que l'action
  // "Remplir" (qui ajoute par tick de 10s) remonte reellement la jauge au lieu de juste compenser.
  for (const rt of amiralsRuntime.values()) {
    if (rt.baseDead) continue; // base detruite -> tout est en pause
    const baseEl = rt.elements.find(e => e.type === 'base');
    if (!baseEl) continue;
    const state = rt.elementStates.get(baseEl.id);
    if (!state || state.essence <= 0) continue;
    if (now - (rt._lastEssenceDrainAt || 0) < ESSENCE_DRAIN_MS) continue;
    rt._lastEssenceDrainAt = now;
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
      persistElementStates(rt); // ecriture periodique HP/essence (toutes les 10s tant que la base vit)
      io.to(amiralRoom(amiralId)).emit('elements:update', {
        activeElements: activeElementStatesForAmiral(amiralId),
        states: allElementStates(rt),
        faction: { ...rt.factionResources }
      });
      // Gain de PV total ce tick (reparation) -> flash "+N" sur l'element, vu par toute la room.
      for (const el of rt.elements) {
        if (el.type !== 'turret' && el.type !== 'base' && el.type !== 'ship') continue;
        const s = rt.elementStates.get(el.id);
        const before = hpBefore.get(amiralId + ':' + el.id);
        if (s && before != null && s.hp > before) {
          io.to(amiralRoom(amiralId)).emit('element:plus', { id: el.id, n: s.hp - before, category: 'DEFENSIF' });
        }
      }
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

// Hors vague dure : 25% soutenue, 75% normale.
function pickNonHardType() {
  return Math.random() < SOUTENUE_PROBABILITY ? 'soutenue' : 'normale';
}

// Construit un groupe de `size` ennemis arrivant d'une direction (baseAngle) vers la cible.
function buildEnemyGroup(target, baseAngle, size, hp, now, idPrefix) {
  const cx = WORLD_W / 2, cy = WORLD_H / 2;
  const r = Math.max(WORLD_W, WORLD_H) * 1.2;
  const margin = 80;
  const spread = 1.2; // un peu plus resserre qu'avant : plusieurs groupes peuvent coexister
  const out = [];
  let maxTravel = 0;
  for (let i = 0; i < size; i++) {
    const a = baseAngle + (Math.random() - 0.5) * spread;
    const spawnX = Math.max(-margin, Math.min(WORLD_W + margin, cx + Math.cos(a) * r));
    const spawnY = Math.max(-margin, Math.min(WORLD_H + margin, cy + Math.sin(a) * r));
    const travelMs = (Math.hypot(target.x - spawnX, target.y - spawnY) / ENEMY_SPEED) * 1000;
    if (travelMs > maxTravel) maxTravel = travelMs;
    out.push({
      id: `${idPrefix}-${i}`, level: 1, hp,
      spawnX, spawnY, targetX: target.x, targetY: target.y,
      travelMs: Math.round(travelMs), spawnOffsetMs: Math.floor(Math.random() * 3500)
    });
  }
  return { enemies: out, maxTravel };
}

function rollWaveFor(rt, force = false, type = null) {
  // Une vague encore active (fenetre en cours OU ennemis vivants) bloque une nouvelle vague :
  // pas de chevauchement, et on ne remplace pas une vague non resolue (sans deadline).
  if (rt.currentWave && (rt.currentWave.endsAt > Date.now() || (rt.currentWave.alive || 0) > 0)) return;
  if (!force && Math.random() > WAVE_PROBABILITY) return;
  if (!type) type = pickNonHardType();

  const day = daysAliveFor(rt);
  const enemyHp = enemyHpForDay(day);
  const asteroids = rt.elements.filter(e => e.type === 'asteroid');
  const target = Math.random() < 0.4 ? rt.elementById['turret-1'] : asteroids[Math.floor(Math.random() * asteroids.length)];
  const now = Date.now();
  const spawnAt = now + WAVE_WARNING_MS;
  const baseAngle = Math.random() * Math.PI * 2;
  const enemies = [];
  let maxTravel = 0;

  if (type === 'soutenue') {
    // 3 points de spawn repartis autour, WAVE_GROUP_SIZE vaisseaux chacun.
    for (let g = 0; g < SOUTENUE_GROUPS; g++) {
      const ang = baseAngle + g * (Math.PI * 2 / SOUTENUE_GROUPS);
      const grp = buildEnemyGroup(target, ang, WAVE_GROUP_SIZE, enemyHp, now, `e-${rt.id}-${now}-g${g}`);
      enemies.push(...grp.enemies);
      if (grp.maxTravel > maxTravel) maxTravel = grp.maxTravel;
    }
  } else {
    // normale et dure : 1 point de spawn, WAVE_GROUP_SIZE vaisseaux.
    const grp = buildEnemyGroup(target, baseAngle, WAVE_GROUP_SIZE, enemyHp, now, `e-${rt.id}-${now}`);
    enemies.push(...grp.enemies);
    maxTravel = grp.maxTravel;
    if (type === 'dure') {
      // + 1 boss : plus tanky, plus lent, plus de degats, plus gros (rendu cote client via les flags).
      const cx = WORLD_W / 2, cy = WORLD_H / 2, r = Math.max(WORLD_W, WORLD_H) * 1.2, margin = 80;
      const a = baseAngle + (Math.random() - 0.5) * 0.4;
      const spawnX = Math.max(-margin, Math.min(WORLD_W + margin, cx + Math.cos(a) * r));
      const spawnY = Math.max(-margin, Math.min(WORLD_H + margin, cy + Math.sin(a) * r));
      const travelMs = (Math.hypot(target.x - spawnX, target.y - spawnY) / (ENEMY_SPEED * BOSS_SPEED_FACTOR)) * 1000;
      if (travelMs > maxTravel) maxTravel = travelMs;
      enemies.push({
        id: `e-${rt.id}-${now}-boss`, level: 1, boss: true,
        hp: Math.round(enemyHp * BOSS_HP_FACTOR),
        scale: BOSS_SCALE, speedFactor: BOSS_SPEED_FACTOR, dmgFactor: BOSS_DMG_FACTOR,
        spawnX, spawnY, targetX: target.x, targetY: target.y,
        travelMs: Math.round(travelMs), spawnOffsetMs: 0
      });
    }
  }

  rt.currentWave = {
    id: `w-${rt.id}-${now}`,
    type,
    startedAt: now,
    warningEndsAt: spawnAt,
    spawnAt,
    targetId: target.id,
    targetLabel: target.label,
    edgeAngle: baseAngle,
    enemies,
    alive: enemies.length,   // ennemis encore vivants (decremente par streamer:enemy_down)
    endsAt: spawnAt + Math.ceil(maxTravel) + COMBAT_WINDOW_MS
  };
  io.to(amiralRoom(rt.id)).emit('wave:incoming', rt.currentWave);
  console.log(`[amiral ${rt.username}] wave ${rt.currentWave.id} (${type}) — ${enemies.length} ennemis vers ${target.id}`);
  const journalMsg = type === 'dure'
    ? `Vague dure — ${enemies.length} ennemis dont un vaisseau lourd !`
    : type === 'soutenue'
      ? `Vague soutenue — ${enemies.length} ennemis sur plusieurs fronts`
      : `Vague de ${enemies.length} ennemis détectée`;
  logJournal(rt, 'wave', journalMsg);

  // PAS de deadline cote combat. La vague se termine UNIQUEMENT par :
  //  - tous les ennemis tues (streamer:enemy_down) -> repoussee + currentWave efface ;
  //  - base detruite -> baseDead.
  // Les ennemis attaquent les tourelles en priorite, puis la base, jusqu'a leur mort.
  // Seul cas de resolution server-side : l'Amiral est HORS-LIGNE (personne ne simule le
  // combat) -> on tranche selon les defenses (resolveWaveOffline). On re-verifie
  // periodiquement (sans jamais "percer" une vague en ligne).
  const waveId = rt.currentWave.id;
  const waveSnapshot = rt.currentWave;
  const firstCheck = Math.max(0, rt.currentWave.endsAt - Date.now());
  scheduleWaveResolution(rt, waveId, waveSnapshot, firstCheck);

  // (L'XP n'est plus donnee en bloc a l'arrivee : elle s'accumule au tick — DEFENSE/UTILITAIRE au
  //  temps passe, ATTAQUE seulement pendant le combat. Cf. tickActions + awardActionXp.)

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
          // Attrition du gisement : seulement quand la base est REGARDEE (combat live).
          // Quand personne ne regarde, c'est resolveWaveOffline qui ronge le gisement.
          if (!roomIsWatched(rt.id)) return;
          applyAsteroidGroupDamage(rt, subtype, ASTEROID_ENEMY_DAMAGE_MS);
        }, delay);
      }
    }
  }
}

// Resolution d'une vague quand l'Amiral est HORS-LIGNE : aucun client ne simule le
// combat, on tranche donc le sort cote serveur selon les defenses de la base.
//  - Les tourelles auto-defendent TANT QUE la base a de l'essence -> vague repoussee
//    (mais defendre brule de l'essence).
//  - Essence a sec OU aucune tourelle vivante -> les ennemis frappent librement :
//    degats a la base (destruction possible) + le gisement cible est ronge.
const OFFLINE_DEFENSE_ESSENCE_PER_ENEMY = 8; // essence brulee par ennemi repousse automatiquement
const OFFLINE_BASE_HITS_PER_ENEMY       = 2; // tirs encaisses par une base sans defense

function resolveWaveOffline(rt, wave) {
  const baseEl = rt.elements.find(e => e.type === 'base');
  const baseState = baseEl && rt.elementStates.get(baseEl.id);
  if (!baseState || !wave) return;
  const enemyCount = (wave.enemies && wave.enemies.length) || 0;
  if (enemyCount <= 0) return;
  const day = daysAliveFor(rt);
  const essence = baseState.essence || 0;
  const aliveTurrets = rt.elements
    .filter(e => e.type === 'turret')
    .filter(t => { const s = rt.elementStates.get(t.id); return s && s.hp > 0 && !s.dead; });
  const defended = essence > 0 && aliveTurrets.length > 0;

  if (defended) {
    const cost = enemyCount * OFFLINE_DEFENSE_ESSENCE_PER_ENEMY;
    baseState.essence = Math.max(0, essence - cost);
    persistElementStates(rt);
    io.to(amiralRoom(rt.id)).emit('elements:update', { states: [publicElementState(rt, baseEl.id)] });
    logJournal(rt, 'wave_repelled', `Vague repoussée hors-ligne — défense automatique (essence -${cost})`);
    console.log(`[amiral ${rt.username}] vague hors-ligne repoussee — essence ${baseState.essence}/${baseState.essenceMax}`);
    return;
  }

  // Sans defense : les ennemis ne sont pas arretes -> ils frappent tourelles ET base.
  const reason = essence <= 0 ? 'essence à sec' : 'tourelles hors service';
  const targetEl = rt.elementById[wave.targetId];
  if (targetEl && targetEl.type === 'asteroid' && targetEl.subtype) {
    applyAsteroidGroupDamage(rt, targetEl.subtype, enemyCount * ASTEROID_ENEMY_DAMAGE_MS);
  }
  // Les tourelles presentes encaissent (essence a sec : elles ne ripostent pas).
  const turretDmg = enemyCount * baseHitDmgForDay(day);
  for (const t of aliveTurrets) applyTurretDamage(rt, t.id, turretDmg);
  const dmg = enemyCount * OFFLINE_BASE_HITS_PER_ENEMY * baseHitDmgForDay(day);
  logJournal(rt, 'wave', `Vague subie hors-ligne (${reason}) — base touchée -${dmg} HP`);
  applyBaseDamage(rt, dmg); // gere la destruction (baseDead), le broadcast et le journal associe
  console.log(`[amiral ${rt.username}] vague hors-ligne SUBIE — base -${dmg} HP (${reason})`);
}

// Verifie le sort d'une vague SANS jamais imposer de deadline au combat live.
//  - Personne ne regarde : aucun client ne simule -> resolution server-side abstraite.
//  - Base regardee (amiral OU viewer) : le combat live (combatTick) gere la vague jusqu'a
//    la mort des ennemis ou de la base ; on re-verifie plus tard au cas ou tout le monde part.
function scheduleWaveResolution(rt, waveId, waveSnapshot, delay) {
  setTimeout(() => {
    if (amiralsRuntime.get(rt.id) !== rt) return;
    if (!rt.currentWave || rt.currentWave.id !== waveId) return; // deja repoussee/remplacee
    if (rt.baseDead) { rt.currentWave = null; return; }
    if (!roomIsWatched(rt.id)) {
      resolveWaveOffline(rt, waveSnapshot);
      rt.currentWave = null;
      rt.combat = null;
    } else {
      scheduleWaveResolution(rt, waveId, waveSnapshot, 60000); // re-check dans 60s
    }
  }, delay);
}

// ============ Planning des vagues : horaires fixes (TZ Europe/Paris par defaut) ============
// Jour : 1 vague par creneau de 2h, de 9h jusqu'a 1h du matin (dernier creneau 23h->1h).
// Nuit : 1 seule vague entre 2h et 6h.
// Le "jour de jeu" est ancre a 7h du matin (apres la nuit, avant le 1er creneau) : ainsi
// toute la journee — y compris le creneau 23h->1h et la nuit 2h-6h — tient dans une plage
// continue sans coupure a minuit (sinon minuteOfDay repartirait a 0 et casserait le creneau).
// On peut surclasser la TZ via env var GAME_TZ
const GAME_TZ = process.env.GAME_TZ || 'Europe/Paris';
const DAY_WAVE_SLOT_HOURS = [9, 11, 13, 15, 17, 19, 21, 23]; // creneaux toutes les 2h, dernier 23h->1h
const NIGHT_WAVE_WINDOW   = { startHour: 2, endHour: 6 };
const DAY_ANCHOR_HOUR     = 7;  // debut du "jour de jeu"
// Heure reelle -> minute dans le jour de jeu (0 = DAY_ANCHOR_HOUR). Monotone sur [0,1440).
const toGamingMin = (h) => ((h - DAY_ANCHOR_HOUR + 24) % 24) * 60;

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
  const minuteOfDay = hour * 60 + minute;
  // Cle + minute du "jour de jeu" (ancre a 7h). Avant 7h on appartient au jour de jeu
  // de la veille -> on calcule la date a partir de l'instant decale de -7h.
  const sp = tzPartsFmt.formatToParts(new Date(now.getTime() - DAY_ANCHOR_HOUR * 3600 * 1000));
  const sget = (t) => sp.find(p => p.type === t)?.value || '00';
  return {
    dateKey: `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`,
    hour, minute, minuteOfDay,
    gamingDayKey: `${sget('year')}-${sget('month')}-${sget('day')}`,
    gamingMinute: (minuteOfDay - DAY_ANCHOR_HOUR * 60 + 1440) % 1440
  };
}

function ensureWaveSchedule(rt, t) {
  if (rt.waveScheduleDay === t.gamingDayKey) return;
  rt.waveScheduleDay = t.gamingDayKey;
  rt.waveFiredSlots = new Set();
  rt.waveSchedule = new Map();
  // Slots exprimes en minutes du jour de jeu (fenetre de 2h chacun ; le slot 23h va jusqu'a 1h).
  const DAY_WINDOW_MIN = 120;
  for (const h of DAY_WAVE_SLOT_HOURS) {
    const gStart = toGamingMin(h);
    const scheduled = gStart + Math.floor(Math.random() * DAY_WINDOW_MIN);
    rt.waveSchedule.set(`day${h}`, { scheduled, slotEnd: gStart + DAY_WINDOW_MIN });
  }
  const nightStart = toGamingMin(NIGHT_WAVE_WINDOW.startHour);
  const nightEnd   = toGamingMin(NIGHT_WAVE_WINDOW.endHour);
  const nightScheduled = nightStart + Math.floor(Math.random() * (nightEnd - nightStart));
  rt.waveSchedule.set('night', { scheduled: nightScheduled, slotEnd: nightEnd });

  // Une seule vague DURE par jour, sur un creneau de JOUR choisi au hasard (jamais la nuit).
  const hardHour = DAY_WAVE_SLOT_HOURS[Math.floor(Math.random() * DAY_WAVE_SLOT_HOURS.length)];
  rt.hardWaveSlot = `day${hardHour}`;

  // Affichage : reconvertit la minute de jeu en heure reelle.
  const fmtMin = gm => { const r = (gm + DAY_ANCHOR_HOUR * 60) % 1440; return `${Math.floor(r/60)}h${String(r%60).padStart(2,'0')}`; };
  const summary = [...rt.waveSchedule.entries()].map(([k, v]) => `${k}@${fmtMin(v.scheduled)}`).join(', ');
  console.log(`[amiral ${rt.username}] planning vagues ${t.gamingDayKey} (${GAME_TZ}) : ${summary} | dure=${rt.hardWaveSlot}`);
}

function tickWaveScheduler() {
  const t = tzNow();
  for (const rt of amiralsRuntime.values()) {
    // Les vagues sont planifiees/declenchees meme hors-ligne : sans pilote, elles
    // sont resolues cote serveur a l'echeance (cf. resolveWaveOffline).
    ensureWaveSchedule(rt, t);
    for (const [slotKey, { scheduled, slotEnd }] of rt.waveSchedule.entries()) {
      if (rt.waveFiredSlots.has(slotKey)) continue;
      if (t.gamingMinute >= scheduled && t.gamingMinute < slotEnd) {
        rt.waveFiredSlots.add(slotKey);
        // Creneau dure du jour -> vague dure ; sinon 25% soutenue / 75% normale.
        const type = (slotKey === rt.hardWaveSlot) ? 'dure' : pickNonHardType();
        rollWaveFor(rt, true, type);
      } else if (t.gamingMinute >= slotEnd) {
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

// ============================================================================
// COMBAT SERVEUR-AUTORITAIRE
// Le serveur simule les ennemis (deplacement + IA + tir), le tir des tourelles
// et resout le tir du vaisseau, a ~10 Hz, UNIQUEMENT pour les runtimes dont la
// room est "regardee" (>=1 client : amiral ou viewer). Les clients ne sont que
// des afficheurs (snapshot 'combat:enemies' + 'combat:tracer'/'combat:enemy_down').
// Quand personne ne regarde, on retombe sur resolveWaveOffline (resolution abstraite).
// ============================================================================
const COMBAT_TICK_MS         = 100;  // ~10 Hz
const COMBAT_DETECT_RANGE    = 340;  // rayon de detection d'une cible a engager (vaisseau)
const COMBAT_ORBIT_MIN       = 160;  // les ennemis gardent plus de distance avec leur cible
const COMBAT_ORBIT_MAX       = 240;
const COMBAT_MIN_BASE_DIST   = 380;  // distance mini au centre de la base
const COMBAT_ENEMY_FIRE_MS   = 5000; // delai entre 2 passes d'attaque d'un ennemi
const TURRET_PUISSANCE_CAP   = 10;   // niveaux/assets de tourelle (Gun01..Gun10), min 1
const TURRET_RANGE_CAP       = 10;

// Une room est "regardee" si au moins un socket y est present (amiral OU viewer).
function roomIsWatched(amiralId) {
  const r = io.sockets.adapter.rooms.get(amiralRoom(amiralId));
  return !!r && r.size > 0;
}
function turretRangePxServer(range) { return 280 + (range || 0) * 10; }
function angleWrap(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }
function angleRotateTo(cur, target, step) {
  const diff = angleWrap(target - cur);
  if (Math.abs(diff) <= step) return target;
  return cur + Math.sign(diff) * step;
}

// Construit l'etat de combat ephemere a partir de la vague courante.
function buildCombatForWave(rt) {
  const wave = rt.currentWave;
  if (!wave) return null;
  const enemies = new Map();
  for (const e of wave.enemies) {
    const hp = (typeof e.hp === 'number' && e.hp > 0) ? e.hp : 30;
    enemies.set(e.id, {
      id: e.id, boss: !!e.boss, hp, hpMax: hp,
      scale: e.scale || 1, speedFactor: e.speedFactor || 1,
      x: e.spawnX, y: e.spawnY,
      rotation: Math.atan2(BASE_Y - e.spawnY, BASE_X - e.spawnX) + Math.PI / 2,
      spawnAt: wave.spawnAt + (e.spawnOffsetMs || 0), spawned: false,
      orbitRadius: COMBAT_ORBIT_MIN + Math.random() * (COMBAT_ORBIT_MAX - COMBAT_ORBIT_MIN),
      orbitSpeed: (0.20 + Math.random() * 0.20) * (Math.random() < 0.5 ? 1 : -1),
      orbitAngle: 0, wobblePhase: Math.random() * Math.PI * 2,
      engageRef: null, engaging: false, phase: 'cruise', lastFireAt: 0, firedThisRun: false, peelSide: 1
    });
  }
  return { waveId: wave.id, enemies, lastTickAt: Date.now(), turretLastShot: {}, participants: new Set() };
}

// Un combat est "actif" si au moins un ennemi est apparu (vague en cours, pas juste annoncee).
function combatActiveFor(rt) {
  if (!rt.combat) return false;
  for (const e of rt.combat.enemies.values()) if (e.spawned) return true;
  return false;
}

// Snapshot serialisable des ennemis spawnes (pour init + diffusion).
function combatSnapshot(combat) {
  const out = [];
  if (!combat) return out;
  for (const en of combat.enemies.values()) {
    if (!en.spawned) continue;
    out.push({ id: en.id, x: Math.round(en.x), y: Math.round(en.y), rotation: +en.rotation.toFixed(3),
               hp: en.hp, hpMax: en.hpMax, boss: en.boss, phase: en.phase });
  }
  return out;
}

// Defenseurs engageables (tourelles vivantes + vaisseau). Les asteroides ne sont PAS des cibles.
function combatDefenders(rt) {
  const list = [];
  for (const el of rt.elements) {
    if (el.type !== 'turret') continue;
    const s = rt.elementStates.get(el.id);
    if (s && s.hp > 0 && !s.dead) list.push({ kind: 'turret', id: el.id, x: el.x, y: el.y });
  }
  list.push({ kind: 'ship', x: rt.ship.x, y: rt.ship.y });
  return list;
}

function killEnemyServer(rt, combat, en) {
  if (!combat.enemies.has(en.id)) return;
  combat.enemies.delete(en.id);
  io.to(amiralRoom(rt.id)).emit('combat:enemy_down', { id: en.id, x: Math.round(en.x), y: Math.round(en.y), boss: en.boss });
  if (rt.currentWave) {
    rt.currentWave.alive = Math.max(0, (rt.currentWave.alive || 0) - 1);
    if (rt.currentWave.alive <= 0 && !rt.baseDead) {
      // Recap de bataille : qui a combattu (action ATTAQUE pendant le combat).
      const parts = combat && combat.participants ? [...combat.participants] : [];
      const names = parts.map(uid => { const set = socketsByUser.get(uid); return set && set.size ? [...set][0].data.username : null; }).filter(Boolean);
      const recap = names.length ? `Vague repoussée — au combat : ${names.join(', ')}` : `Vague repoussée — tous les ennemis détruits`;
      logJournal(rt, 'wave_repelled', recap);
      const wid = rt.currentWave.id;
      rt.currentWave = null;
      rt.combat = null;
      io.to(amiralRoom(rt.id)).emit('wave:repelled', { waveId: wid, participants: names });
    }
  }
}
function damageEnemyServer(rt, combat, en, dmg) {
  en.hp = Math.max(0, en.hp - dmg);
  if (en.hp <= 0) killEnemyServer(rt, combat, en);
}

// Tir ennemi (hitscan) : applique les degats a la base/tourelle + diffuse un tracer visuel.
function enemyFireServer(rt, en, mode, targetId, cx, cy, day) {
  const dmg = baseHitDmgForDay(day) * (en.boss ? BOSS_DMG_FACTOR : 1);
  io.to(amiralRoom(rt.id)).emit('combat:tracer', {
    from: { x: Math.round(en.x), y: Math.round(en.y) }, to: { x: Math.round(cx), y: Math.round(cy) },
    kind: 'enemy', boss: en.boss
  });
  if (mode === 'base') applyBaseDamage(rt, dmg);
  else if (mode === 'turret' && targetId) applyTurretDamage(rt, targetId, dmg);
  // mode 'ship' : pas de degats au vaisseau (parite avec le comportement client d'origine)
}

// Cycle d'engagement d'un ennemi : orbite -> plongee (tir) -> degagement -> orbite.
function tickEnemyEngage(rt, combat, en, cx, cy, orbitR, dt, now, mode, targetId, day) {
  const step = ENEMY_SPEED * (en.speedFactor || 1) * dt;
  const turn = 5 * dt;
  const bearing = Math.atan2(en.y - cy, en.x - cx);
  const distT = Math.hypot(en.x - cx, en.y - cy) || 1;
  const dirAway = bearing + Math.PI / 2;
  const dirToward = bearing + Math.PI + Math.PI / 2;
  const moveFwd = (spd) => { const f = en.rotation - Math.PI / 2; en.x += Math.cos(f) * spd; en.y += Math.sin(f) * spd; };

  if (en.phase === 'dive') {
    en.rotation = angleRotateTo(en.rotation, dirToward, turn * 1.3);
    moveFwd(step * 2.6);
    if (!en.firedThisRun && Math.abs(angleWrap(dirToward - en.rotation)) < 0.25) {
      enemyFireServer(rt, en, mode, targetId, cx, cy, day);
      en.firedThisRun = true;
    }
    if (distT <= orbitR * 0.6) en.phase = 'peel';
    return;
  }
  if (en.phase === 'peel') {
    en.rotation = angleRotateTo(en.rotation, dirAway + en.peelSide * (Math.PI / 4), turn * 1.1);
    moveFwd(step * 1.8);
    if (distT >= orbitR) { en.phase = 'cruise'; en.lastFireAt = now; en.orbitAngle = bearing; }
    return;
  }
  // cruise : orbite reguliere avec legere fluctuation du rayon
  en.orbitAngle += en.orbitSpeed * dt;
  const r = orbitR + Math.sin(now * 0.0011 + en.wobblePhase) * (orbitR * 0.14);
  en.x = cx + Math.cos(en.orbitAngle) * r;
  en.y = cy + Math.sin(en.orbitAngle) * r;
  const tangent = en.orbitAngle + (en.orbitSpeed > 0 ? Math.PI / 2 : -Math.PI / 2) + Math.PI / 2;
  en.rotation = angleRotateTo(en.rotation, tangent, turn);
  if (now - en.lastFireAt >= COMBAT_ENEMY_FIRE_MS) { en.phase = 'dive'; en.firedThisRun = false; en.peelSide = Math.random() < 0.5 ? 1 : -1; }
}

// Deplacement + selection de cible d'un ennemi (priorite tourelle proche > vaisseau proche > base).
function tickEnemyServer(rt, combat, en, defenders, dt, now, day) {
  let best = null, bestTurretDist = Infinity;
  for (const t of defenders) {
    if (t.kind !== 'turret') continue;
    const d = Math.hypot(en.x - t.x, en.y - t.y);
    if (d < bestTurretDist) { best = t; bestTurretDist = d; }
  }
  const shipT = defenders.find(t => t.kind === 'ship');
  if (shipT) {
    const sd = Math.hypot(en.x - shipT.x, en.y - shipT.y);
    if (sd < COMBAT_DETECT_RANGE && sd < bestTurretDist) best = shipT;
  }
  let mode, cx, cy, orbitR, targetId = null;
  if (best) {
    mode = best.kind; cx = best.x; cy = best.y; orbitR = en.orbitRadius;
    targetId = best.id || null;
    const ref = best.kind === 'turret' ? best.id : 'ship';
    if (en.engageRef !== ref) { en.engageRef = ref; en.engaging = false; }
  } else {
    if (en.engageRef !== 'base') { en.engageRef = 'base'; en.engaging = false; }
    mode = 'base'; cx = BASE_X; cy = BASE_Y; orbitR = BASE_PERIMETER + en.orbitRadius;
  }
  const distToCenter = Math.hypot(en.x - cx, en.y - cy);
  if (!en.engaging && distToCenter > orbitR + 6) {
    const dx = cx - en.x, dy = cy - en.y, dn = distToCenter || 1;
    const stp = ENEMY_SPEED * (en.speedFactor || 1) * dt;
    en.x += (dx / dn) * stp; en.y += (dy / dn) * stp;
    en.rotation = Math.atan2(dy, dx) + Math.PI / 2;
  } else {
    if (!en.engaging) { en.engaging = true; en.orbitAngle = Math.atan2(en.y - cy, en.x - cx); en.phase = 'cruise'; }
    if (!en.lastFireAt) en.lastFireAt = now - Math.random() * COMBAT_ENEMY_FIRE_MS;
    tickEnemyEngage(rt, combat, en, cx, cy, orbitR, dt, now, mode, targetId, day);
  }
  // Clamp : aucun ennemi ne colle la base
  const dbx = en.x - BASE_X, dby = en.y - BASE_Y, db = Math.hypot(dbx, dby);
  if (db > 0 && db < COMBAT_MIN_BASE_DIST) {
    en.x = BASE_X + (dbx / db) * COMBAT_MIN_BASE_DIST;
    en.y = BASE_Y + (dby / db) * COMBAT_MIN_BASE_DIST;
  }
}

// Tir des tourelles (hitscan) : ennemi le plus proche en portee, cadence selon puissance.
function tickTurretsServer(rt, combat, now) {
  const baseEl = rt.elements.find(e => e.type === 'base');
  const baseState = baseEl && rt.elementStates.get(baseEl.id);
  if (!baseState || (baseState.essence || 0) <= 0) return; // base hors tension -> tourelles inactives
  for (const el of rt.elements) {
    if (el.type !== 'turret') continue;
    const s = rt.elementStates.get(el.id);
    if (!s || s.dead || s.hp <= 0) continue;
    const puissance = Math.max(1, Math.min(TURRET_PUISSANCE_CAP, sumContributionsOnAction(rt, el.id, 'tir', 'PUISSANCE')));
    const range     = Math.max(1, Math.min(TURRET_RANGE_CAP, sumContributionsOnAction(rt, el.id, 'visee', 'PUISSANCE')));
    const rangePx = turretRangePxServer(range);
    let best = null, bestD = rangePx;
    for (const en of combat.enemies.values()) {
      if (!en.spawned) continue;
      const d = Math.hypot(el.x - en.x, el.y - en.y);
      if (d < bestD) { best = en; bestD = d; }
    }
    if (!best) continue;
    const fireDelay = Math.max(1000, 2000 - puissance * 30);
    if (now - (combat.turretLastShot[el.id] || 0) < fireDelay) continue;
    combat.turretLastShot[el.id] = now;
    const dmg = 5 + Math.floor(puissance * 0.5);
    io.to(amiralRoom(rt.id)).emit('combat:tracer', { from: { x: el.x, y: el.y }, to: { x: Math.round(best.x), y: Math.round(best.y) }, kind: 'turret', turretId: el.id });
    damageEnemyServer(rt, combat, best, dmg);
    if (!rt.combat) return; // la vague vient de se terminer
  }
}

// Resout le tir du vaisseau (cible verrouillee ou ray-cast) + diffuse le tracer a toute la room.
function resolveShipFire(rt, data) {
  const combat = rt.combat;
  let tx = data.x + Math.cos(data.angle) * 900;
  let ty = data.y + Math.sin(data.angle) * 900;
  let hit = null;
  if (combat) {
    if (data.targetId && combat.enemies.has(data.targetId)) {
      hit = combat.enemies.get(data.targetId);
    } else {
      let bestProj = Infinity;
      for (const en of combat.enemies.values()) {
        if (!en.spawned) continue;
        const rx = en.x - data.x, ry = en.y - data.y;
        const proj = rx * Math.cos(data.angle) + ry * Math.sin(data.angle);
        if (proj < 0 || proj > 900) continue;
        const perp = Math.abs(-Math.sin(data.angle) * rx + Math.cos(data.angle) * ry);
        if (perp <= 28 && proj < bestProj) { bestProj = proj; hit = en; }
      }
    }
  }
  if (hit) { tx = Math.round(hit.x); ty = Math.round(hit.y); }
  io.to(amiralRoom(rt.id)).emit('combat:tracer', { from: { x: Math.round(data.x), y: Math.round(data.y) }, to: { x: Math.round(tx), y: Math.round(ty) }, kind: 'ship' });
  if (hit && combat) {
    const puissance = Math.max(1, Math.min(TURRET_PUISSANCE_CAP, sumContributionsOnAction(rt, 'ship-1', 'tir', 'PUISSANCE')));
    damageEnemyServer(rt, combat, hit, 5 + Math.floor(puissance * 0.5));
  }
}

function combatTick() {
  const now = Date.now();
  for (const rt of amiralsRuntime.values()) {
    if (rt.id === 0) continue;                       // pas de combat live pour la demo
    if (rt.baseDead || !rt.currentWave || !roomIsWatched(rt.id)) { rt.combat = null; continue; }
    if (!rt.combat || rt.combat.waveId !== rt.currentWave.id) rt.combat = buildCombatForWave(rt);
    const combat = rt.combat;
    let dt = (now - combat.lastTickAt) / 1000;
    combat.lastTickAt = now;
    if (dt <= 0) dt = COMBAT_TICK_MS / 1000;
    if (dt > 0.25) dt = 0.25;
    const day = daysAliveFor(rt);
    // Apparition des ennemis dus
    for (const en of combat.enemies.values()) if (!en.spawned && now >= en.spawnAt) en.spawned = true;
    // Deplacement + IA + tir ennemi
    const defenders = combatDefenders(rt);
    for (const en of combat.enemies.values()) { if (en.spawned) tickEnemyServer(rt, combat, en, defenders, dt, now, day); }
    // Tir des tourelles (peut terminer la vague -> rt.combat devient null)
    if (rt.combat) tickTurretsServer(rt, combat, now);
    // Diffusion du snapshot (seulement s'il y a des ennemis a l'ecran)
    if (rt.combat) {
      const snap = combatSnapshot(combat);
      if (snap.length) io.to(amiralRoom(rt.id)).emit('combat:enemies', snap);
    }
  }
}
setInterval(combatTick, COMBAT_TICK_MS);

// ============================================================================
// RETROSPECTIVE : captures d'ecran periodiques (12h glissantes)
// Un seul client par base (amiral en priorite, sinon un viewer) capture son canvas
// toutes les SNAPSHOT_INTERVAL_MS ; le serveur stocke l'image et purge au-dela de 12h.
// ============================================================================
const SNAPSHOT_INTERVAL_MS  = 12 * 60 * 1000;       // cadence de capture (~12 min -> ~60 images/12h)
const SNAPSHOT_RETENTION_MS = 12 * 60 * 60 * 1000;  // duree conservee (12h)
const SNAPSHOT_MAX_BYTES    = 400 * 1024;           // garde-fou taille image

function snapshotDirFor(amiralId) { return path.join(snapshotsDir, String(amiralId)); }
function pruneSnapshots(dir) {
  let files; try { files = fs.readdirSync(dir); } catch (e) { return; }
  const cutoff = Date.now() - SNAPSHOT_RETENTION_MS;
  for (const f of files) {
    const ts = parseInt(f, 10);
    if (Number.isFinite(ts) && ts < cutoff) { try { fs.unlinkSync(path.join(dir, f)); } catch (e) {} }
  }
}
function listSnapshots(amiralId) {
  let files; try { files = fs.readdirSync(snapshotDirFor(amiralId)); } catch (e) { return []; }
  const cutoff = Date.now() - SNAPSHOT_RETENTION_MS;
  return files.map(f => parseInt(f, 10)).filter(t => Number.isFinite(t) && t >= cutoff)
    .sort((a, b) => a - b).map(t => ({ t, url: `/snapshots/${amiralId}/${t}.jpg` }));
}
function pickCapturer(rt) {
  const room = io.sockets.adapter.rooms.get(amiralRoom(rt.id));
  if (!room || room.size === 0) return null;
  if (rt.socketId && room.has(rt.socketId)) return rt.socketId; // l'amiral en priorite
  return room.values().next().value;
}
function snapshotTick() {
  const now = Date.now();
  for (const rt of amiralsRuntime.values()) {
    if (rt.id === 0) continue;
    if (now - (rt._lastSnapAt || 0) < SNAPSHOT_INTERVAL_MS) continue;
    const sid = pickCapturer(rt);
    if (!sid) continue;
    rt._lastSnapAt = now;
    rt._snapReqSocket = sid; rt._snapReqAt = now;  // seul ce socket pourra deposer l'image
    io.to(sid).emit('snapshot:capture');
  }
}
setInterval(snapshotTick, 60 * 1000);

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
