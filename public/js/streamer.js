let WORLD_W = 2400;
let WORLD_H = 1350;
let BASE_X = WORLD_W / 2;
let BASE_Y = WORLD_H / 2;
let BASE_PERIMETER = 560;
let TURRET_X = BASE_X;
let TURRET_Y = BASE_Y;
const ZOOM_FACTOR_MIN = 0.85;
const ZOOM_FACTOR_MAX = 2.5;

let amiralToken = localStorage.getItem('voidfaction:amiralToken') || null;
let socket = null;
const loginEl = document.getElementById('login');
const loginForm = document.getElementById('loginForm');
const signupForm = document.getElementById('signupForm');
const loginError = document.getElementById('loginError');
const tabLogin = document.getElementById('tabLogin');
const tabSignup = document.getElementById('tabSignup');
const hudEl = document.getElementById('hud');
const resourceEl = document.getElementById('resource');

let authenticated = false;
let gameStarted = false;

document.querySelectorAll('.pwd-toggle').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const id = btn.getAttribute('data-target');
    const input = document.getElementById(id);
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
    input.focus();
  });
});

function setActiveTab(which) {
  loginError.textContent = '';
  const isLogin = which === 'login';
  loginForm.classList.toggle('hidden', !isLogin);
  signupForm.classList.toggle('hidden', isLogin);
  tabLogin.style.borderBottomColor = isLogin ? '#4af' : 'transparent';
  tabLogin.style.color = isLogin ? '#4af' : '#789';
  tabLogin.style.fontWeight = isLogin ? 'bold' : 'normal';
  tabSignup.style.borderBottomColor = !isLogin ? '#4af' : 'transparent';
  tabSignup.style.color = !isLogin ? '#4af' : '#789';
  tabSignup.style.fontWeight = !isLogin ? 'bold' : 'normal';
  setTimeout(() => (isLogin ? loginForm : signupForm).querySelector('input')?.focus(), 30);
}
tabLogin.addEventListener('click', () => setActiveTab('login'));
tabSignup.addEventListener('click', () => setActiveTab('signup'));

function showLoginUI() {
  loginEl.classList.remove('hidden');
  hudEl.classList.add('hidden');
}
function hideLoginUI() {
  loginEl.classList.add('hidden');
  hudEl.classList.remove('hidden');
}

function connectAmiralSocket() {
  if (socket) try { socket.disconnect(); } catch {}
  socket = io({ auth: amiralToken ? { amiralToken } : {} });
  wireSocketEvents();
}

async function submitAmiralAuth(endpoint, body) {
  loginError.textContent = '';
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (e) {
    loginError.textContent = 'Erreur réseau: ' + (e?.message || 'inconnue');
    return;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    loginError.textContent = data.error || `Erreur ${res.status}`;
    return;
  }
  amiralToken = data.token;
  localStorage.setItem('voidfaction:amiralToken', amiralToken);
  localStorage.setItem('voidfaction:amiralUsername', data.username);
  connectAmiralSocket();
}

loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  submitAmiralAuth('/api/amiral/login', {
    username: document.getElementById('loginUsername').value.trim(),
    password: document.getElementById('loginPassword').value
  });
});
signupForm.addEventListener('submit', (e) => {
  e.preventDefault();
  submitAmiralAuth('/api/amiral/signup', {
    username: document.getElementById('signupUsername').value.trim(),
    password: document.getElementById('signupPassword').value,
    masterCode: document.getElementById('signupMaster').value
  });
});

let lastActiveElements = [];
let elementStates = new Map();
let factionResources = { materiaux: 0, radius: 0 };
let amiralDisplayName = 'AMIRAL';  // pseudo affiche sous le vaisseau
let activeAction = null;  // action active de l'Amiral (slot unique)
let amiralProgress = { puissance: 0, defensif: 0, utilitaire: 0, total: 0 };
let serverElementsRef = null;  // alias vers le tableau d'elements (mis a jour dans init)

// ============ Menu d'action (clic sur un element) ============
let actionMenuElementId = null;
const actionMenu = document.getElementById('actionMenu');
const actionMenuTitle = document.getElementById('actionMenuTitle');
const actionMenuActions = document.getElementById('actionMenuActions');
const actionMenuClose = document.getElementById('actionMenuClose');
const actionMenuDeact = document.getElementById('actionMenuDeact');
const actionMenuNote = document.getElementById('actionMenuNote');
const actionMenuStats = document.getElementById('actionMenuStats');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function getElement(elementId) {
  if (!serverElements) return null;
  return serverElements.find(e => e.id === elementId);
}

function openActionMenu(elementId, anchor) {
  if (!authenticated) return; // l'Amiral doit etre authentifie pour cliquer
  const el = getElement(elementId);
  if (!el) return;
  actionMenuElementId = elementId;
  actionMenuTitle.textContent = el.label;

  // Stats de l'element
  if (actionMenuStats) {
    const st = elementStates.get(elementId);
    if (st) {
      const parts = [];
      if (el.type === 'base' && typeof st.daysAlive === 'number') parts.push(`Jour <strong>${st.daysAlive}</strong>`);
      if (st.hp !== undefined && el.type !== 'asteroid') parts.push(`HP <strong>${st.hp}</strong>/${st.hpMax}`);
      if (st.puissance !== undefined) parts.push(`Puissance <strong>${st.puissance}</strong>`);
      if (st.range !== undefined) parts.push(`Visée <strong>${st.range}</strong>`);
      if (st.essence !== undefined) parts.push(`Essence <strong>${st.essence}</strong>/${st.essenceMax}`);
      if (st.subtype) {
        parts.push(`Type <strong>${st.subtype === 'radius' ? 'Radius' : 'Matériaux'}</strong>`);
        if (st.hpMax) {
          const remainingSec = Math.max(0, Math.round(st.hp / 1000));
          const m = Math.floor(remainingSec / 60);
          const s = remainingSec % 60;
          parts.push(`Durée <strong>${m}m${String(s).padStart(2,'0')}s</strong>`);
        }
      }
      actionMenuStats.innerHTML = parts.join(' &middot; ');
      actionMenuStats.classList.remove('hidden');
    } else {
      actionMenuStats.classList.add('hidden');
    }
  }

  actionMenuActions.innerHTML = '';
  for (const a of el.actions) {
    const isActive = activeAction && activeAction.element_id === elementId && activeAction.action_id === a.id;
    const btn = document.createElement('button');
    btn.innerHTML = `<span class="tag cat-tag ${a.category}">${a.category}</span> ${escapeHtml(a.label)}`;
    if (isActive) btn.classList.add('active');
    btn.addEventListener('click', () => activateAction(elementId, a.id));
    actionMenuActions.appendChild(btn);
  }
  const activeHere = activeAction && activeAction.element_id === elementId;
  actionMenuDeact.classList.toggle('hidden', !activeHere);
  if (activeAction && activeAction.element_id !== elementId) {
    actionMenuNote.textContent = 'Tu vas désactiver ton action en cours.';
    actionMenuNote.classList.remove('hidden');
  } else {
    actionMenuNote.classList.add('hidden');
  }

  actionMenu.classList.remove('hidden');
  const rect = actionMenu.getBoundingClientRect();
  let x = (anchor?.clientX ?? window.innerWidth / 2) + 12;
  let y = (anchor?.clientY ?? window.innerHeight / 2) - 10;
  if (x + rect.width > window.innerWidth - 8) x = (anchor?.clientX ?? 0) - rect.width - 12;
  if (y + rect.height > window.innerHeight - 8) y = window.innerHeight - rect.height - 8;
  if (y < 8) y = 8;
  if (x < 8) x = 8;
  actionMenu.style.left = x + 'px';
  actionMenu.style.top = y + 'px';
}

function closeActionMenu() {
  actionMenu.classList.add('hidden');
  actionMenuElementId = null;
}

function activateAction(elementId, actionId) {
  if (!socket || !authenticated) return;
  socket.emit('action:activate', { elementId, actionId }, (resp) => {
    if (resp?.ok) closeActionMenu();
    else console.warn('[amiral] activation refusee:', resp?.error);
  });
}

function deactivateCurrent() {
  if (!socket || !authenticated || !activeAction) return;
  socket.emit('action:deactivate', null, () => closeActionMenu());
}

if (actionMenuClose) actionMenuClose.addEventListener('click', closeActionMenu);
if (actionMenuDeact) actionMenuDeact.addEventListener('click', deactivateCurrent);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeActionMenu(); });
document.addEventListener('mousedown', (e) => {
  if (!actionMenu || actionMenu.classList.contains('hidden')) return;
  if (!actionMenu.contains(e.target)) closeActionMenu();
}, true);
let knownBuildTime = null;

// ============ Commandant overlay HUD ============
const CAPTAIN_FRAMES = (() => {
  const arr = [];
  for (let i = 0; i < 18; i++) arr.push(`/assets/PNG/CaptainTalk/Talk01/skeleton-LoopTalk_${i}.png`);
  return arr;
})();
CAPTAIN_FRAMES.forEach((src) => { const img = new Image(); img.src = src; });
let captainAnimInterval = null;
let captainHideTimeout = null;
function showCaptain(message, durationMs) {
  const el = document.getElementById('captainAlert');
  const img = document.getElementById('captainImg');
  const msg = document.getElementById('captainMsg');
  if (!el || !img || !msg) return;
  msg.innerHTML = message;
  el.classList.remove('hidden');
  if (captainAnimInterval) clearInterval(captainAnimInterval);
  if (captainHideTimeout) clearTimeout(captainHideTimeout);
  let i = 0;
  img.src = CAPTAIN_FRAMES[0];
  captainAnimInterval = setInterval(() => {
    i = (i + 1) % CAPTAIN_FRAMES.length;
    img.src = CAPTAIN_FRAMES[i];
  }, 70);
  if (durationMs > 0) captainHideTimeout = setTimeout(hideCaptain, durationMs);
}
function hideCaptain() {
  const el = document.getElementById('captainAlert');
  if (el) el.classList.add('hidden');
  if (captainAnimInterval) { clearInterval(captainAnimInterval); captainAnimInterval = null; }
  if (captainHideTimeout) { clearTimeout(captainHideTimeout); captainHideTimeout = null; }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function triggerCaptainForWave(wave) {
  if (!wave) return;
  const now = Date.now();
  const target = escapeHtml(wave.targetLabel || 'la base');
  const warnMs = Math.max(0, wave.warningEndsAt - now);
  const totalRemaining = Math.max(0, wave.endsAt - now);
  if (warnMs > 0) {
    // Captain affiche brievement (15s max), la banniere de wave reste pour le countdown long
    const captainDurationMs = Math.min(15000, warnMs + 800);
    showCaptain(`<span class="danger">⚠ ENNEMIS DÉTECTÉS</span><br>Cible : ${target}<br>Tenez vos positions !`, captainDurationMs);
    setTimeout(() => {
      if (Date.now() < wave.endsAt - 1500) {
        showCaptain(`<span class="danger">L'ENNEMI EST LÀ !</span><br>Tirez sur les hostiles !`, Math.max(1500, wave.endsAt - Date.now() - 600));
      }
    }, warnMs);
  } else if (totalRemaining > 1500) {
    showCaptain(`<span class="danger">L'ENNEMI EST LÀ !</span><br>Tirez sur les hostiles !`, totalRemaining - 600);
  }
}

function triggerVersionReload() {
  console.log('%c[VoidFaction Amiral] Nouvelle version détectée — rechargement…', 'color:#f80; font-weight:bold; font-size:14px');
  const notif = document.createElement('div');
  notif.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#f80;color:#000;padding:10px;text-align:center;font-family:Consolas,monospace;font-weight:bold;letter-spacing:1px;box-shadow:0 2px 12px rgba(0,0,0,0.5)';
  notif.textContent = 'Nouvelle version disponible — rechargement automatique…';
  document.body.appendChild(notif);
  setTimeout(() => location.reload(), 900);
}
let waveBannerInterval = null;
function showWaveBanner(wave) {
  const banner = document.getElementById('waveBanner');
  if (!banner) return;
  const labelEl = banner.querySelector('.target');
  const cdEl = banner.querySelector('.countdown');
  if (labelEl) labelEl.textContent = wave.targetLabel || '';
  banner.classList.remove('hidden');
  if (waveBannerInterval) clearInterval(waveBannerInterval);
  const update = () => {
    const now = Date.now();
    if (now < wave.warningEndsAt) {
      const remMs = wave.warningEndsAt - now;
      cdEl.textContent = formatWaveCountdown(remMs);
      banner.classList.add('warning'); banner.classList.remove('active');
    } else if (now < wave.endsAt) {
      cdEl.textContent = 'EN COURS';
      banner.classList.remove('warning'); banner.classList.add('active');
    } else {
      banner.classList.add('hidden');
      banner.classList.remove('warning', 'active');
      clearInterval(waveBannerInterval); waveBannerInterval = null;
    }
  };
  update();
  waveBannerInterval = setInterval(update, 1000);
}

function formatWaveCountdown(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h${String(m).padStart(2,'0')}`;
  if (m > 0) return `${m}m${String(s).padStart(2,'0')}s`;
  return `${s}s`;
}

function wireSocketEvents() {
  socket.on('init', (data) => {
    if (data.buildTime) {
      if (knownBuildTime && knownBuildTime !== data.buildTime) {
        triggerVersionReload();
        return;
      }
      knownBuildTime = data.buildTime;
      const d = new Date(data.buildTime);
      console.log(`%c[VoidFaction Amiral] dernière MAJ : ${d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'medium' })}`,
        'color:#ff8044; font-weight:bold');
    }
    // Authentification : si data.amiral est absent, le token est invalide
    if (!data.amiral) {
      amiralToken = null;
      localStorage.removeItem('voidfaction:amiralToken');
      authenticated = false;
      showLoginUI();
      try { socket.disconnect(); } catch {}
      return;
    }
    authenticated = true;
    hideLoginUI();
    resourceEl.textContent = data.resource;
    lastActiveElements = data.activeElements || [];
    serverElements = data.elements || [];
    elementStates = new Map((data.elementStates || []).map(s => [s.id, s]));
    factionResources = data.factionResources || factionResources;
    activeAction = data.activeAction || null;
    amiralProgress = data.progress || amiralProgress;
    // Pseudo de l'Amiral sur le vaisseau (le sien). Stocke pour utilisation au demarrage de la scene
    amiralDisplayName = data.watchedAmiral?.username || data.amiral?.username || 'AMIRAL';
    const sceneForLabel = game?.scene.getScene('main');
    if (sceneForLabel && sceneForLabel.shipLabel) sceneForLabel.shipLabel.setText(amiralDisplayName);
    if (data.world) {
      WORLD_W = data.world.width;
      WORLD_H = data.world.height;
      BASE_X = data.world.baseX ?? WORLD_W / 2;
      BASE_Y = data.world.baseY ?? WORLD_H / 2;
      BASE_PERIMETER = data.world.basePerimeter ?? 560;
      TURRET_X = data.world.turretX;
      TURRET_Y = data.world.turretY;
    }
    pendingWave = data.currentWave && data.currentWave.endsAt > Date.now() ? data.currentWave : null;
    if (pendingWave) triggerCaptainForWave(pendingWave);
    if (!gameStarted) {
      gameStarted = true;
      startGame();
    } else {
      const scene = game?.scene.getScene('main');
      if (scene && scene.scene.isActive()) {
        scene.setupElements(serverElements);
        scene.applyAllElementStates();
        scene.refreshElementHighlights(lastActiveElements);
        scene.drawBasePerimeter();
        if (pendingWave) {
          scene.handleWaveIncoming(pendingWave);
          pendingWave = null;
        }
      }
    }
  });
  socket.on('resource', (data) => {
    resourceEl.textContent = data.resource;
  });
  socket.on('elements:update', (data) => {
    lastActiveElements = data.activeElements || [];
    if (Array.isArray(data.states)) {
      elementStates = new Map(data.states.map(s => [s.id, s]));
    }
    if (data.faction) factionResources = data.faction;
    const scene = game?.scene.getScene('main');
    if (scene && scene.scene.isActive()) {
      scene.refreshElementHighlights(lastActiveElements);
      scene.applyAllElementStates();
    }
  });
  socket.on('asteroid:destroyed', (data) => {
    const scene = game?.scene.getScene('main');
    if (scene && scene.scene.isActive()) scene.onAsteroidDestroyed(data.id, data.respawnsAt);
    const st = elementStates.get(data.id);
    if (st) { st.hp = 0; st.respawnsAt = data.respawnsAt; }
  });
  socket.on('asteroid:respawned', (data) => {
    const scene = game?.scene.getScene('main');
    if (scene && scene.scene.isActive()) scene.onAsteroidRespawned(data.id);
    if (data.state) elementStates.set(data.id, data.state);
  });
  // Groupes : destruction/respawn de tous les asteroides d'un subtype
  socket.on('asteroid:group_destroyed', (data) => {
    const scene = game?.scene.getScene('main');
    for (const id of (data.ids || [])) {
      if (scene && scene.scene.isActive()) scene.onAsteroidDestroyed(id, data.respawnsAt);
      const st = elementStates.get(id);
      if (st) { st.hp = 0; st.respawnsAt = data.respawnsAt; }
    }
  });
  socket.on('asteroid:group_respawned', (data) => {
    const scene = game?.scene.getScene('main');
    const ids = data.ids || [];
    const states = data.states || [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (scene && scene.scene.isActive()) scene.onAsteroidRespawned(id);
      if (states[i]) elementStates.set(id, states[i]);
    }
  });
  socket.on('base:reborn', (data) => {
    if (data?.state) elementStates.set(data.id, data.state);
    const scene = game?.scene.getScene('main');
    if (scene && scene.scene.isActive()) scene.applyAllElementStates();
  });
  socket.on('wave:incoming', (wave) => {
    const scene = game?.scene.getScene('main');
    if (scene && scene.scene.isActive()) scene.handleWaveIncoming(wave);
    else pendingWave = wave;
    triggerCaptainForWave(wave);
  });
  socket.on('streamer:kicked', () => {
    alert('Un autre Amiral s\'est connecté avec ton compte. Tu as perdu le contrôle.');
    amiralToken = null;
    localStorage.removeItem('voidfaction:amiralToken');
    location.reload();
  });
  socket.on('action:state', (data) => {
    activeAction = data?.activeAction || null;
    if (data?.progress) amiralProgress = data.progress;
    // Mise a jour du menu si ouvert sur l'element concerne
    if (actionMenuElementId && !actionMenu.classList.contains('hidden')) {
      openActionMenu(actionMenuElementId, null);
    }
  });
}

// Connexion initiale : si un token Amiral est en localStorage, on tente de réutiliser ;
// sinon le formulaire de login/signup reste affiché.
if (amiralToken) {
  connectAmiralSocket();
} else {
  setActiveTab('login');
}

const SHIP_ASSET = '/assets/PNG/Ship_01/Ship_LVL_1.png';
const SHIP_SCALE = 0.035; // vaisseau Amiral discret, ne masque pas la base
const ENEMY_LEVELS = [1];
const ENEMY_ASSETS = {
  1: '/assets/PNG/Ship_02/Ship_LVL_1.png'
};
const ENEMY_SCALE = 0.045;
const GUN_LEVELS = 10;
const GUN_SCALE = 0.55;
function turretGunLevel(puissance) {
  return Math.min(GUN_LEVELS, Math.max(1, 1 + Math.floor((puissance || 0) / 10)));
}
function turretRangePx(state) {
  return 280 + (state?.range || 0) * 10;
}
const SHIP_SPRITE_OFFSET = Math.PI / 2; // les nouveaux assets pointent vers le haut

const ASTEROID_VARIANTS = {
  '01': { cols: 3, rows: 2, count: 6, w: 600, h: 500 },
  '02': { cols: 2, rows: 2, count: 4, w: 520, h: 430 },
  '03': { cols: 2, rows: 2, count: 4, w: 500, h: 360 },
  '04': { cols: 2, rows: 2, count: 4, w: 350, h: 300 },
  '05': { cols: 2, rows: 2, count: 4, w: 450, h: 200 },
  '06': { cols: 3, rows: 1, count: 3, w: 320, h: 240 },
  '07': { cols: 3, rows: 1, count: 3, w: 300, h: 250 },
  '08': { cols: 3, rows: 1, count: 3, w: 240, h: 240 },
  '09': { cols: 3, rows: 1, count: 3, w: 250, h: 230 },
  '10': { cols: 3, rows: 1, count: 3, w: 260, h: 240 },
  '11': { cols: 3, rows: 1, count: 3, w: 240, h: 150 },
  '12': { cols: 3, rows: 1, count: 3, w: 170, h: 180 },
  '13': { cols: 3, rows: 1, count: 3, w: 190, h: 160 },
  '14': { cols: 2, rows: 1, count: 2, w: 110, h: 110 },
  '15': { cols: 2, rows: 1, count: 2, w: 70,  h: 100 }
};
const ASTEROID_TARGET_SIZE = 130;
function asteroidScaleFor(variantKey, sizeMultiplier) {
  const meta = ASTEROID_VARIANTS[variantKey] || ASTEROID_VARIANTS['01'];
  return (ASTEROID_TARGET_SIZE * (sizeMultiplier || 1)) / Math.max(meta.w, meta.h);
}
function asteroidFrameFor(variantKey, hpRatio) {
  const meta = ASTEROID_VARIANTS[variantKey] || ASTEROID_VARIANTS['01'];
  return Math.min(meta.count - 1, Math.max(0, Math.floor((1 - hpRatio) * meta.count)));
}

let serverElements = [];
let pendingWave = null; // wave reçue avant que la scène ne démarre

class MainScene extends Phaser.Scene {
  constructor() { super('main'); }

  preload() {
    this.load.image('ship', SHIP_ASSET);
    this.load.image('mothership-base', '/assets/Spaceships/PNG/enemy_mothership.png');
    for (let i = 0; i < 10; i++) {
      const n = String(i).padStart(3, '0');
      this.load.image(`ship-fr-${n}`, `/assets/PNG/Ship_01/Exhaust/Exhaust_1_2_${n}.png`);
    }
    for (const lvl of ENEMY_LEVELS) {
      this.load.image(`enemy_ship_${lvl}`, ENEMY_ASSETS[lvl]);
      for (let i = 0; i < 10; i++) {
        const n = String(i).padStart(3, '0');
        this.load.image(`enemy${lvl}-fr-${n}`, `/assets/PNG/Ship_02/Exhaust/Exhaust_${lvl}_2_${n}.png`);
      }
      for (let i = 0; i < 9; i++) {
        const n = String(i).padStart(3, '0');
        this.load.image(`enemy${lvl}-ex-${n}`, `/assets/PNG/Ship_02/Explosion/Explosion_${lvl}_${n}.png`);
      }
    }
    this.load.image('bg-01', '/assets/Backgrounds/PNG_and_JPG/background_04_parallax_01.png');
    this.load.image('bg-02', '/assets/Backgrounds/PNG_and_JPG/background_04_parallax_02.png');
    this.load.image('bg-03', '/assets/Backgrounds/PNG_and_JPG/background_04_parallax_03.png');
    this.load.image('bg-04', '/assets/Backgrounds/PNG_and_JPG/background_04_parallax_04.png');
    for (let g = 1; g <= GUN_LEVELS; g++) {
      const k = String(g).padStart(2, '0');
      this.load.image(`gun-${k}-idle`, `/assets/PNG/Guns/Gun${k}/Idle/Gun${k}-Idle_0.png`);
      for (let f = 0; f < 10; f++) {
        const ff = String(f).padStart(2, '0');
        this.load.image(`gun-${k}-shoot-${ff}`, `/assets/PNG/Guns/Gun${k}/Shoot/Gun${k}-Shoot_${ff}.png`);
      }
    }
    for (const [v, meta] of Object.entries(ASTEROID_VARIANTS)) {
      this.load.spritesheet(`a-${v}`,
        `/assets/Asteroids/PNG/asteroid_${v}_with_cracks.png`,
        { frameWidth: meta.w, frameHeight: meta.h });
    }
  }

  create() {
    this.cameras.main.setBackgroundColor('#04060a');

    // Background parallax (background_04)
    this.setupParallaxBackground();

    // Animations vaisseaux
    this.createShipAnimations();

    // Setup textures
    this.createTurretTexture();
    this.createExplosionTexture();

    // Containers
    this.elementSprites = new Map();
    this.elementHighlights = new Map();
    this.enemies = new Set();
    this.waveWarnIcon = null;

    // Thruster particle texture
    const tg = this.make.graphics({ x: 0, y: 0, add: false });
    tg.fillStyle(0xff8844, 1);
    tg.fillCircle(4, 4, 4);
    tg.generateTexture('thrust', 8, 8);
    tg.destroy();

    this.ship = this.physics.add.sprite(WORLD_W / 2, WORLD_H / 2 + 230, 'ship-fr-000');
    this.ship.setScale(SHIP_SCALE).setOrigin(0.5, 0.36);
    this.ship.play('ship-thrust');
    this.ship._hp = 100;
    this.ship._hpMax = 100;
    this.shipHpBar = this.makeHpBar(this.ship.x, this.ship.y - 40, 60, 0x4fdb73);
    this.shipHpBar.setDepth(11);
    this.ship.setDamping(true);
    this.ship.setDrag(0.92);
    this.ship.setMaxVelocity(140);

    // Pseudo de l'Amiral qui suit le vaisseau
    this.shipLabel = this.add.text(this.ship.x, this.ship.y - 56, amiralDisplayName, {
      fontFamily: 'Consolas, monospace', fontSize: '13px', color: '#ff8044',
      stroke: '#000', strokeThickness: 3, fontStyle: 'bold'
    }).setOrigin(0.5).setDepth(11);

    // Cercle "grande base"
    this.drawBasePerimeter();

    // Caméra : bornes du monde + follow ship + zoom relatif au fit
    this.cameras.main.setBounds(0, 0, WORLD_W, WORLD_H);
    this.cameras.main.startFollow(this.ship, true, 0.08, 0.08);
    this._userZoomFactor = 1.0; // démarre à la vue d'ensemble pour voir tout le périmètre
    this.applyFitZoom();
    this.scale.on('resize', () => this.onResize());
    this.input.on('wheel', (_p, _g, _dx, deltaY) => {
      this._userZoomFactor = Phaser.Math.Clamp(this._userZoomFactor - deltaY * 0.0006, ZOOM_FACTOR_MIN, ZOOM_FACTOR_MAX);
      this.applyFitZoom();
    });

    this.thrust = this.add.particles(0, 0, 'thrust', {
      speed: { min: 30, max: 70 },
      scale: { start: 1, end: 0 },
      alpha: { start: 0.8, end: 0 },
      lifespan: 280,
      blendMode: 'ADD',
      frequency: 30,
      emitting: false,
      follow: this.ship
    });

    // Marqueur visuel de destination (clic droit)
    this.destMarker = this.add.circle(0, 0, 14, 0x4f8aff, 0.0).setStrokeStyle(2, 0x4f8aff, 0.9);
    this.destination = null;

    // Clic droit = définir la destination
    this.input.mouse.disableContextMenu();
    this.input.on('pointerdown', (pointer) => {
      if (pointer.rightButtonDown()) {
        this.destination = { x: pointer.worldX, y: pointer.worldY };
        this.destMarker.setPosition(pointer.worldX, pointer.worldY);
        this.destMarker.setFillStyle(0x4f8aff, 0.25);
        this.tweens.killTweensOf(this.destMarker);
        this.tweens.add({
          targets: this.destMarker,
          scale: { from: 1.6, to: 1 },
          duration: 240,
          ease: 'Back.easeOut'
        });
      }
    });

    this.lastSend = 0;
    if (serverElements.length > 0) this.setupElements(serverElements);
    if (pendingWave) {
      this.handleWaveIncoming(pendingWave);
      pendingWave = null;
    }
  }

  createTurretTexture() {
    const g = this.make.graphics({ x: 0, y: 0, add: false });
    g.fillStyle(0x1a2335, 1);
    g.fillCircle(40, 40, 30);
    g.lineStyle(2, 0xff8044, 1);
    g.strokeCircle(40, 40, 30);
    g.fillStyle(0x2a3550, 1);
    g.fillCircle(40, 40, 20);
    g.lineStyle(1.5, 0xff4f6d, 0.8);
    g.strokeCircle(40, 40, 20);
    g.fillStyle(0x404a60, 1);
    g.fillRect(34, 8, 12, 32);
    g.lineStyle(1.5, 0xff8044, 1);
    g.strokeRect(34, 8, 12, 32);
    g.fillStyle(0xff4f6d, 1);
    g.fillRect(33, 4, 14, 6);
    g.fillStyle(0xff4f6d, 1);
    g.fillCircle(40, 40, 4);
    g.generateTexture('turret', 80, 80);
    g.destroy();
  }

  createExplosionTexture() {
    if (this.textures.exists('explosion-dot')) return;
    const g = this.make.graphics({ x: 0, y: 0, add: false });
    g.fillStyle(0xff6644, 1);
    g.fillCircle(4, 4, 4);
    g.generateTexture('explosion-dot', 8, 8);
    g.destroy();
  }

  createShipAnimations() {
    const mkFrames = (prefix, count, pad) =>
      Array.from({ length: count }, (_, i) => ({ key: `${prefix}${String(i).padStart(pad || 3, '0')}` }));
    if (!this.anims.exists('ship-thrust')) {
      this.anims.create({ key: 'ship-thrust', frames: mkFrames('ship-fr-', 10, 3), frameRate: 24, repeat: -1 });
    }
    for (const lvl of ENEMY_LEVELS) {
      const thr = `enemy${lvl}-thrust`;
      if (!this.anims.exists(thr)) {
        this.anims.create({ key: thr, frames: mkFrames(`enemy${lvl}-fr-`, 10, 3), frameRate: 24, repeat: -1 });
      }
      const ex = `enemy${lvl}-explode`;
      if (!this.anims.exists(ex)) {
        this.anims.create({ key: ex, frames: mkFrames(`enemy${lvl}-ex-`, 9, 3), frameRate: 22, repeat: 0 });
      }
    }
    for (let g = 1; g <= GUN_LEVELS; g++) {
      const k = String(g).padStart(2, '0');
      const key = `gun-${k}-shoot`;
      if (!this.anims.exists(key)) {
        this.anims.create({ key, frames: mkFrames(`gun-${k}-shoot-`, 10, 2), frameRate: 24, repeat: -1 });
      }
    }
  }

  setupParallaxBackground() {
    const w = this.scale.gameSize.width;
    const h = this.scale.gameSize.height;
    // Fond principal qui couvre le viewport (suit la camera)
    this.bgLayer01 = this.add.image(w / 2, h / 2, 'bg-01')
      .setOrigin(0.5).setScrollFactor(0).setDepth(-100);
    // Petite planete parallax dans le monde
    this.bgLayer03 = this.add.image(2200, 1200, 'bg-03')
      .setOrigin(0.5).setScrollFactor(0.35).setDepth(-80).setScale(0.4);
    this.updateParallaxBackground();
  }

  updateParallaxBackground() {
    if (!this.bgLayer01) return;
    const cam = this.cameras.main;
    const z = cam.zoom;
    const src01 = this.textures.get('bg-01').getSourceImage();
    const cover01 = Math.max(cam.width / src01.width, cam.height / src01.height) * 1.05;
    this.bgLayer01.setScale(cover01 / z);
  }

  applyFitZoom() {
    const cam = this.cameras.main;
    const fit = Math.min(cam.width / WORLD_W, cam.height / WORLD_H);
    cam.setZoom(fit * (this._userZoomFactor || 1));
  }

  onResize() {
    const w = this.scale.gameSize.width;
    const h = this.scale.gameSize.height;
    this.cameras.main.setSize(w, h);
    this.applyFitZoom();
    if (this.bgLayer01) this.bgLayer01.setPosition(w / 2, h / 2);
    this.updateParallaxBackground();
  }

  drawBasePerimeter() {
    if (this.basePerimeterGfx) this.basePerimeterGfx.destroy();
    if (this.basePerimeterHalo) this.basePerimeterHalo.destroy();
    const halo = this.add.graphics().setDepth(-60);
    halo.fillStyle(0xff8044, 0.07);
    halo.fillCircle(BASE_X, BASE_Y, BASE_PERIMETER);
    halo.fillStyle(0xff8044, 0.04);
    halo.fillCircle(BASE_X, BASE_Y, BASE_PERIMETER * 1.05);
    this.basePerimeterHalo = halo;
    const g = this.add.graphics().setDepth(-50);
    g.lineStyle(4, 0xff8044, 0.75);
    g.strokeCircle(BASE_X, BASE_Y, BASE_PERIMETER);
    g.lineStyle(1.5, 0xff8044, 0.35);
    for (let i = 0; i < 24; i++) {
      const a0 = (i / 24) * Math.PI * 2;
      const a1 = a0 + Math.PI / 36;
      g.beginPath();
      g.arc(BASE_X, BASE_Y, BASE_PERIMETER - 22, a0, a1);
      g.strokePath();
    }
    this.basePerimeterGfx = g;
    this.tweens.add({
      targets: g, alpha: { from: 0.85, to: 1.0 },
      yoyo: true, repeat: -1, duration: 3000, ease: 'Sine.easeInOut'
    });
  }

  setupElements(elements) {
    if (!Array.isArray(elements)) return;
    for (const s of this.elementSprites.values()) s.destroy();
    for (const h of this.elementHighlights.values()) h.destroy();
    if (this.elementHpBars) for (const b of this.elementHpBars.values()) b.destroy();
    if (this.elementRespawnTimers) for (const t of this.elementRespawnTimers.values()) t.destroy();
    this.elementSprites.clear();
    this.elementHighlights.clear();
    this.elementHpBars = new Map();
    this.elementRespawnTimers = new Map();

    this.createBaseTexture();

    // Pour les asteroides, on partage UNE seule barre par subtype (materiaux / radius).
    // La barre est attachee au premier asteroide rencontre de chaque type ; les autres
    // n'ont pas de barre individuelle.
    const groupBarSubtypes = new Set();

    elements.forEach((el, i) => {
      if (el.type === 'asteroid') {
        const variant = el.variant || '01';
        const meta = ASTEROID_VARIANTS[variant] || ASTEROID_VARIANTS['01'];
        const phaserScale = asteroidScaleFor(variant, el.scale);
        const tint = el.subtype === 'radius' ? 0x88e0c8 : 0xffffff;
        const visibleSize = Math.max(meta.w, meta.h) * phaserScale;
        const tex = this.textures.get(`a-${variant}`);
        if (tex) tex.setFilter(Phaser.Textures.FilterMode.NEAREST);
        const highlight = this.add.circle(el.x, el.y, visibleSize * 0.6, 0xffd24f, 0)
          .setStrokeStyle(3, 0xffd24f, 0);
        const sprite = this.add.sprite(el.x, el.y, `a-${variant}`, 0)
          .setScale(phaserScale)
          .setRotation(Math.random() * Math.PI * 2)
          .setTint(tint)
          .setInteractive({ useHandCursor: true });
        sprite.on('pointerdown', (pointer) => {
          if (pointer.button !== 0) return;
          openActionMenu(el.id, pointer.event);
        });
        const dir = (i % 2 === 0) ? 1 : -1;
        this.tweens.add({
          targets: sprite,
          rotation: sprite.rotation + dir * Math.PI * 2,
          duration: 110000 + (i * 12000),
          repeat: -1
        });
        sprite._asteroidVariant = variant;
        this.elementSprites.set(el.id, sprite);
        this.elementHighlights.set(el.id, highlight);
        // Barre commune : seul le premier asteroide de chaque subtype en a une
        if (!groupBarSubtypes.has(el.subtype)) {
          groupBarSubtypes.add(el.subtype);
          const barColor = el.subtype === 'radius' ? 0x88e0c8 : 0xffd24f;
          const barW = 140;
          const bar = this.makeHpBar(el.x, el.y - visibleSize * 0.5 - 28, barW, barColor);
          const labelTxt = el.subtype === 'radius' ? 'ASTÉROÏDES RADIUS' : 'ASTÉROÏDES MATÉRIAUX';
          this.add.text(el.x, el.y - visibleSize * 0.5 - 44, labelTxt, {
            fontFamily: 'Consolas, monospace', fontSize: '10px',
            color: el.subtype === 'radius' ? '#88e0c8' : '#ffd24f',
            stroke: '#000', strokeThickness: 2
          }).setOrigin(0.5);
          this.elementHpBars.set(el.id, bar);
        }
      } else if (el.type === 'turret') {
        const highlight = this.add.circle(el.x, el.y, 60, 0xff4f6d, 0)
          .setStrokeStyle(2, 0xff4f6d, 0);
        const outward = Math.atan2(el.y - BASE_Y, el.x - BASE_X);
        const baseRot = outward + Math.PI / 2;
        const sprite = this.add.sprite(el.x, el.y, 'gun-01-idle')
          .setScale(GUN_SCALE)
          .setRotation(baseRot)
          .setInteractive({ useHandCursor: true });
        sprite.on('pointerdown', (pointer) => {
          if (pointer.button !== 0) return;
          openActionMenu(el.id, pointer.event);
        });
        sprite._baseRotation = baseRot;
        const amp = 0.15;
        const dur = 7000 + Math.floor(Math.random() * 4000);
        sprite._patrolTween = this.tweens.add({
          targets: sprite,
          rotation: { from: baseRot - amp, to: baseRot + amp },
          duration: dur, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
          delay: Math.floor(Math.random() * 2000)
        });
        sprite._turretId = el.id;
        this.elementSprites.set(el.id, sprite);
        this.elementHighlights.set(el.id, highlight);
        this.elementHpBars.set(el.id, this.makeHpBar(el.x, el.y - 70, 90, 0xff4f6d));
      } else if (el.type === 'base') {
        const highlight = this.add.circle(el.x, el.y, 120, 0x4af, 0)
          .setStrokeStyle(2, 0x4af, 0);
        const sprite = this.add.image(el.x, el.y, 'mothership-base').setScale(0.9)
          .setInteractive({ useHandCursor: true });
        sprite.on('pointerdown', (pointer) => {
          if (pointer.button !== 0) return;
          openActionMenu(el.id, pointer.event);
        });
        this.add.text(el.x, el.y + 120, el.label, {
          fontFamily: 'Consolas, monospace', fontSize: '13px', color: '#4af'
        }).setOrigin(0.5);
        this.baseElementId = el.id;
        this.elementSprites.set(el.id, sprite);
        this.elementHighlights.set(el.id, highlight);
        this.elementHpBars.set(el.id, this.makeHpBar(el.x, el.y - 88, 120, 0x4af));
      }
    });
    this.refreshElementHighlights(lastActiveElements);
    this.applyAllElementStates();
  }

  makeHpBar(x, y, width, strokeColor) {
    const c = this.add.container(x, y);
    const bg = this.add.rectangle(0, 0, width, 6, 0x000000, 0.6).setStrokeStyle(1.5, strokeColor || 0xffffff, 0.85);
    const fill = this.add.rectangle(-width / 2, 0, width, 4, 0x4fdb73).setOrigin(0, 0.5);
    c.add([bg, fill]);
    c.fill = fill; c.bg = bg; c.maxWidth = width;
    c.strokeColor = strokeColor;
    return c;
  }

  applyAllElementStates() {
    if (!this.elementHpBars) return;
    for (const [id, bar] of this.elementHpBars.entries()) {
      const state = elementStates.get(id);
      if (!state) continue;
      const ratio = Math.max(0, Math.min(1, state.hp / state.hpMax));
      const w = bar.maxWidth * ratio;
      bar.fill.width = Math.max(0, w);
      let color = 0x4fdb73;
      if (ratio < 0.3) color = 0xff4f6d;
      else if (ratio < 0.6) color = 0xffd24f;
      bar.fill.fillColor = color;
      const sprite = this.elementSprites.get(id);
      if (sprite && sprite._asteroidVariant) {
        sprite.setFrame(asteroidFrameFor(sprite._asteroidVariant, ratio));
      }
    }
    for (const el of serverElements) {
      if (el.type === 'turret') this.updateTurretAppearance(el.id);
    }
  }

  updateTurretTargeting() {
    if (!this.elementSprites || !this.enemies) return;
    const now = Date.now();
    for (const el of serverElements) {
      if (el.type !== 'turret') continue;
      const sprite = this.elementSprites.get(el.id);
      const state = elementStates.get(el.id);
      if (!sprite || !state) continue;
      // Tourelle = défense autonome : tire en permanence sur l'ennemi le plus proche.
      // L'action 'tir' boost les degats via state.puissance.
      const range = turretRangePx(state);
      const target = this.findNearestEnemyInRange(sprite.x, sprite.y, range);
      if (target) {
        if (sprite._patrolTween && !sprite._patrolTween.paused) sprite._patrolTween.pause();
        const a = Phaser.Math.Angle.Between(sprite.x, sprite.y, target.x, target.y);
        sprite.rotation = a + Math.PI / 2;
        if (!sprite._lastShotAt) sprite._lastShotAt = 0;
        // Cadence de tir : 2s de base, descend a ~1s si tir est tres ameliore
        const fireDelay = Math.max(1000, 2000 - (state.puissance || 0) * 30);
        if (now - sprite._lastShotAt >= fireDelay) {
          const dmg = 5 + Math.floor((state.puissance || 0) * 0.5);
          this.fireTurretLaser(sprite, target);
          this.damageEnemy(target, dmg);
          sprite._lastShotAt = now;
        }
      } else {
        if (sprite._patrolTween && sprite._patrolTween.paused) sprite._patrolTween.resume();
      }
    }
  }

  fireTurretLaser(turretSprite, enemySprite) {
    const line = this.add.graphics().setDepth(9);
    line.lineStyle(3, 0x4afff8, 0.95);
    line.beginPath();
    line.moveTo(turretSprite.x, turretSprite.y);
    line.lineTo(enemySprite.x, enemySprite.y);
    line.strokePath();
    this.tweens.add({ targets: line, alpha: 0, duration: 200, onComplete: () => line.destroy() });
  }

  updateEnemyOrbits(delta) {
    if (!this.enemies) return;
    const dtSec = (delta || 16) / 1000;
    for (const sprite of this.enemies) {
      if (!sprite._isOrbiting || !sprite._target) continue;
      sprite._orbitAngle += sprite._orbitSpeed * dtSec;
      sprite.x = sprite._target.x + Math.cos(sprite._orbitAngle) * sprite._orbitRadius;
      sprite.y = sprite._target.y + Math.sin(sprite._orbitAngle) * sprite._orbitRadius;
      const tangent = sprite._orbitAngle + (sprite._orbitSpeed > 0 ? Math.PI / 2 : -Math.PI / 2);
      sprite.rotation = tangent + Math.PI / 2;
      if (sprite._hpBar) {
        sprite._hpBar.x = sprite.x;
        sprite._hpBar.y = sprite.y - 38;
      }
    }
  }

  findNearestEnemyInRange(tx, ty, range) {
    let best = null, bestDist = range;
    for (const e of this.enemies) {
      const d = Phaser.Math.Distance.Between(tx, ty, e.x, e.y);
      if (d < bestDist) { best = e; bestDist = d; }
    }
    return best;
  }

  updateTurretAppearance(id) {
    const sprite = this.elementSprites.get(id);
    if (!sprite) return;
    const state = elementStates.get(id);
    if (!state) return;
    const level = turretGunLevel(state.puissance);
    const k = String(level).padStart(2, '0');
    const idleKey = `gun-${k}-idle`;
    const shootKey = `gun-${k}-shoot`;
    const active = (lastActiveElements || []).find(a => a.element_id === id);
    const isShooting = active && active.action_id === 'tir';
    if (isShooting) {
      if (sprite._currentAnim !== shootKey) {
        sprite.play(shootKey);
        sprite._currentAnim = shootKey;
      }
    } else {
      if (sprite.anims && sprite.anims.isPlaying) sprite.anims.stop();
      if (sprite.texture && sprite.texture.key !== idleKey) sprite.setTexture(idleKey);
      sprite._currentAnim = null;
    }
  }

  onAsteroidDestroyed(id, respawnsAt) {
    const sprite = this.elementSprites.get(id);
    const bar = this.elementHpBars.get(id);
    if (sprite) {
      this.explodeAt(sprite.x, sprite.y);
      this.tweens.killTweensOf(sprite);
      this.tweens.add({ targets: sprite, alpha: 0, scale: sprite.scale * 1.4, duration: 600, ease: 'Cubic.easeOut' });
    }
    if (bar) bar.setVisible(false);
    if (sprite) {
      const timer = this.add.text(sprite.x, sprite.y, '', {
        fontFamily: 'Consolas, monospace', fontSize: '14px', color: '#88e0c8',
        stroke: '#000', strokeThickness: 3, align: 'center'
      }).setOrigin(0.5);
      const update = () => {
        const remaining = respawnsAt - Date.now();
        if (remaining <= 0) { timer.destroy(); return; }
        const m = Math.floor(remaining / 60000);
        const s = Math.floor((remaining % 60000) / 1000);
        timer.setText(`RESPAWN\n${m}m ${String(s).padStart(2,'0')}s`);
      };
      update();
      const interval = setInterval(update, 1000);
      timer.once('destroy', () => clearInterval(interval));
      this.elementRespawnTimers.set(id, timer);
    }
  }

  onAsteroidRespawned(id) {
    const sprite = this.elementSprites.get(id);
    const bar = this.elementHpBars.get(id);
    const timer = this.elementRespawnTimers.get(id);
    if (timer) { timer.destroy(); this.elementRespawnTimers.delete(id); }
    if (sprite) {
      this.tweens.killTweensOf(sprite);
      sprite.setAlpha(0);
      if (sprite._asteroidVariant) sprite.setFrame(0);
      const scaleTarget = sprite.scale;
      this.tweens.add({ targets: sprite, alpha: 1, scale: { from: scaleTarget * 0.5, to: scaleTarget }, duration: 500 });
    }
    if (bar) bar.setVisible(true);
    this.applyAllElementStates();
  }

  createBaseTexture() {
    if (this.textures.exists('base')) return;
    const g = this.make.graphics({ x: 0, y: 0, add: false });
    const cx = 80, cy = 80, r = 60;
    g.fillStyle(0x152038, 1);
    g.lineStyle(3, 0x4af, 1);
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
      pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    g.beginPath();
    g.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i+1]);
    g.closePath();
    g.fillPath();
    g.strokePath();
    g.fillStyle(0x223a5e, 1);
    g.fillCircle(cx, cy, r * 0.65);
    g.lineStyle(2, 0x6cf, 0.7);
    g.strokeCircle(cx, cy, r * 0.65);
    g.lineStyle(2, 0x4af, 1);
    g.beginPath();
    g.moveTo(cx - 14, cy); g.lineTo(cx + 14, cy);
    g.moveTo(cx, cy - 14); g.lineTo(cx, cy + 14);
    g.strokePath();
    g.fillStyle(0x4af, 1);
    g.fillCircle(cx, cy, 5);
    g.generateTexture('base', 160, 160);
    g.destroy();
  }

  handleWaveIncoming(wave) {
    if (!wave) return;
    const now = Date.now();
    const warningRemaining = Math.max(0, wave.warningEndsAt - now);
    showWaveBanner(wave);
    this.showWaveWarnIcon(wave);
    for (const enemy of wave.enemies) {
      const delay = warningRemaining + (enemy.spawnOffsetMs || 0);
      this.time.delayedCall(delay, () => this.spawnEnemy(enemy));
    }
    this.time.delayedCall(warningRemaining + 600, () => this.hideWaveWarnIcon());
  }

  showWaveWarnIcon(wave) {
    this.hideWaveWarnIcon();
    const avgX = wave.enemies.reduce((s, e) => s + e.spawnX, 0) / wave.enemies.length;
    const avgY = wave.enemies.reduce((s, e) => s + e.spawnY, 0) / wave.enemies.length;
    const x = Math.max(40, Math.min(WORLD_W - 40, avgX));
    const y = Math.max(40, Math.min(WORLD_H - 40, avgY));
    const icon = this.add.text(x, y, '⚠', {
      fontFamily: 'Consolas, monospace', fontSize: '64px', color: '#ff4444',
      stroke: '#000000', strokeThickness: 4
    }).setOrigin(0.5).setAlpha(0);
    this.tweens.add({ targets: icon, alpha: { from: 0, to: 1 }, scale: { from: 0.5, to: 1.2 }, duration: 400, ease: 'Back.easeOut' });
    this.tweens.add({ targets: icon, scale: { from: 1.0, to: 1.3 }, yoyo: true, repeat: -1, duration: 600, ease: 'Sine.easeInOut' });
    this.waveWarnIcon = icon;
  }

  hideWaveWarnIcon() {
    if (this.waveWarnIcon) {
      this.tweens.killTweensOf(this.waveWarnIcon);
      this.tweens.add({
        targets: this.waveWarnIcon, alpha: 0, duration: 300,
        onComplete: () => this.waveWarnIcon?.destroy()
      });
      this.waveWarnIcon = null;
    }
  }

  spawnEnemy(e) {
    const level = 1;
    const sprite = this.add.sprite(e.spawnX, e.spawnY, `enemy${level}-fr-000`)
      .setScale(ENEMY_SCALE).setOrigin(0.5, 0.36).setDepth(8);
    sprite.play(`enemy${level}-thrust`);
    sprite._level = level;
    const angle = Math.atan2(e.targetY - e.spawnY, e.targetX - e.spawnX);
    sprite.rotation = angle + Math.PI / 2;
    this.enemies.add(sprite);

    const ORBIT_R_MIN = 90;
    const ORBIT_R_MAX = 160;
    const orbitRadius = ORBIT_R_MIN + Math.random() * (ORBIT_R_MAX - ORBIT_R_MIN);
    const total = Math.hypot(e.targetX - e.spawnX, e.targetY - e.spawnY);
    if (total <= orbitRadius + 10) {
      this.startEnemyOrbit(sprite, e.targetX, e.targetY, orbitRadius);
      return;
    }
    const ratio = (total - orbitRadius) / total;
    const stopX = e.spawnX + (e.targetX - e.spawnX) * ratio;
    const stopY = e.spawnY + (e.targetY - e.spawnY) * ratio;
    const approachMs = e.travelMs * ratio;
    sprite._approachTween = this.tweens.add({
      targets: sprite,
      x: stopX, y: stopY,
      duration: approachMs, ease: 'Linear',
      onComplete: () => this.startEnemyOrbit(sprite, e.targetX, e.targetY, orbitRadius)
    });
  }

  startEnemyOrbit(sprite, tx, ty, orbitRadius) {
    if (!sprite.active) return;
    sprite._target = { x: tx, y: ty };
    sprite._orbitRadius = orbitRadius;
    sprite._orbitAngle = Math.atan2(sprite.y - ty, sprite.x - tx);
    sprite._orbitSpeed = (0.20 + Math.random() * 0.20) * (Math.random() < 0.5 ? 1 : -1);
    sprite._isOrbiting = true;
    sprite._hp = sprite._hpMax = 30;
    sprite._hpBar = this.makeHpBar(sprite.x, sprite.y - 38, 40, 0xff3322);
    sprite._hpBar.setDepth(8);
    const firstFireDelay = 800 + Math.floor(Math.random() * 2200);
    this.time.delayedCall(firstFireDelay, () => {
      if (!sprite.active) return;
      this.fireEnemyShot(sprite, sprite._target.x, sprite._target.y);
      sprite._fireEvent = this.time.addEvent({
        delay: 5000, loop: true,
        callback: () => { if (sprite.active) this.fireEnemyShot(sprite, sprite._target.x, sprite._target.y); }
      });
    });
  }

  damageEnemy(sprite, dmg) {
    if (!sprite.active || !sprite._isOrbiting) return;
    sprite._hp = Math.max(0, sprite._hp - dmg);
    if (sprite._hpBar) {
      const ratio = sprite._hp / sprite._hpMax;
      sprite._hpBar.fill.width = sprite._hpBar.maxWidth * ratio;
      let color = 0x4fdb73;
      if (ratio < 0.3) color = 0xff4f6d;
      else if (ratio < 0.6) color = 0xffd24f;
      sprite._hpBar.fill.fillColor = color;
    }
    if (sprite._hp <= 0) this.destroyEnemy(sprite);
  }

  destroyEnemy(sprite) {
    if (!sprite.active) return;
    sprite._isOrbiting = false;
    if (sprite._fireEvent) sprite._fireEvent.remove();
    if (sprite._hpBar) sprite._hpBar.destroy();
    this.playEnemyExplosion(sprite.x, sprite.y, sprite._level || 1);
    this.enemies.delete(sprite);
    sprite.destroy();
  }

  fireEnemyShot(sprite, tx, ty) {
    const line = this.add.graphics().setDepth(9);
    line.lineStyle(3, 0xff3322, 0.95);
    line.beginPath();
    line.moveTo(sprite.x, sprite.y);
    line.lineTo(tx, ty);
    line.strokePath();
    this.tweens.add({ targets: line, alpha: 0, duration: 220, onComplete: () => line.destroy() });
    const spark = this.add.circle(tx, ty, 9, 0xff7733, 0.9).setDepth(9);
    this.tweens.add({ targets: spark, alpha: 0, scale: 1.8, duration: 280, onComplete: () => spark.destroy() });
  }

  destroyEnemy(sprite) {
    if (!sprite.active) return;
    if (sprite._fireEvent) sprite._fireEvent.remove();
    this.playEnemyExplosion(sprite.x, sprite.y, sprite._level || 1);
    this.enemies.delete(sprite);
    sprite.destroy();
  }

  playEnemyExplosion(x, y, level) {
    const lvl = 1;
    const ex = this.add.sprite(x, y, `enemy${lvl}-ex-000`).setScale(ENEMY_SCALE * 2.2).setDepth(9);
    ex.play(`enemy${lvl}-explode`);
    ex.once('animationcomplete', () => ex.destroy());
  }

  explodeAt(x, y) {
    const p = this.add.particles(x, y, 'explosion-dot', {
      speed: { min: 80, max: 220 },
      scale: { start: 1.5, end: 0 },
      alpha: { start: 1, end: 0 },
      lifespan: 700, blendMode: 'ADD',
      quantity: 18, emitting: false
    });
    p.explode(18);
    this.time.delayedCall(900, () => p.destroy());
  }

  refreshElementHighlights(activeList) {
    if (!this.elementHighlights) return;
    const activeMap = new Map();
    if (Array.isArray(activeList)) {
      for (const a of activeList) activeMap.set(a.element_id, a);
    }
    for (const [id, highlight] of this.elementHighlights.entries()) {
      const active = activeMap.get(id);
      if (active) {
        const color = active.category === 'PUISSANCE' ? 0xff4f6d :
                      active.category === 'DEFENSIF'  ? 0x4fa3ff :
                                                        0xffd24f;
        highlight.setStrokeStyle(2, color, 0.9);
        highlight.setFillStyle(color, 0.18);
        this.tweens.killTweensOf(highlight);
        this.tweens.add({
          targets: highlight,
          alpha: { from: 1, to: 0.5 },
          yoyo: true, repeat: -1, duration: 900, ease: 'Sine.easeInOut'
        });
      } else {
        this.tweens.killTweensOf(highlight);
        highlight.setStrokeStyle(2, 0xffffff, 0);
        highlight.setFillStyle(0xffffff, 0);
        highlight.alpha = 1;
      }
    }
    for (const el of serverElements) {
      if (el.type === 'turret') this.updateTurretAppearance(el.id);
    }
  }

  update(time, delta) {
    this.updateParallaxBackground();
    this.updateTurretTargeting();
    this.updateEnemyOrbits(delta);
    if (!this.ship) return;
    if (this.shipLabel) {
      this.shipLabel.x = this.ship.x;
      this.shipLabel.y = this.ship.y - 56;
    }
    if (this.shipHpBar) {
      this.shipHpBar.x = this.ship.x;
      this.shipHpBar.y = this.ship.y - 40;
    }

    // Déplacement vers la destination : contrôleur proportionnel.
    // Le vaisseau accélère pour rejoindre une "vitesse cible" qui décroît
    // en sqrt(2·a·d) à l'approche, ce qui le fait freiner avant d'arriver.
    const MAX_SPEED = 120;           // px/s
    const APPROACH_DECEL = 150;      // px/s² (force de freinage théorique)
    const STIFFNESS = 6;             // raideur du correcteur vitesse
    const STOP_DIST = 4;             // px : on s'arrête net si proche ET lent
    const STOP_SPEED = 20;           // px/s

    let moving = false;
    if (this.destination) {
      const dx = this.destination.x - this.ship.x;
      const dy = this.destination.y - this.ship.y;
      const dist = Math.hypot(dx, dy);
      const v = this.ship.body.velocity;
      const speed = Math.hypot(v.x, v.y);

      if (dist < STOP_DIST && speed < STOP_SPEED) {
        this.destination = null;
        this.ship.setAcceleration(0, 0);
        this.ship.setVelocity(0, 0);
        this.destMarker.setFillStyle(0x4f8aff, 0);
      } else {
        const targetSpeed = Math.min(MAX_SPEED, Math.sqrt(2 * APPROACH_DECEL * dist));
        const desiredVx = (dx / dist) * targetSpeed;
        const desiredVy = (dy / dist) * targetSpeed;
        this.ship.setAcceleration((desiredVx - v.x) * STIFFNESS, (desiredVy - v.y) * STIFFNESS);
        moving = true;
      }
    } else {
      this.ship.setAcceleration(0, 0);
    }
    this.thrust.emitting = moving;

    // Orientation : on s'oriente vers la destination quand on se déplace,
    // sinon on garde la rotation actuelle
    if (this.destination) {
      this.ship.rotation = Phaser.Math.Angle.Between(this.ship.x, this.ship.y, this.destination.x, this.destination.y) + SHIP_SPRITE_OFFSET;
    }

    if (this.ship.x < 0) this.ship.x = WORLD_W;
    else if (this.ship.x > WORLD_W) this.ship.x = 0;
    if (this.ship.y < 0) this.ship.y = WORLD_H;
    else if (this.ship.y > WORLD_H) this.ship.y = 0;

    if (time - this.lastSend > 50) {
      this.lastSend = time;
      socket.emit('streamer:ship', {
        x: this.ship.x,
        y: this.ship.y,
        rotation: this.ship.rotation
      });
    }
  }
}

let game = null;
function startGame() {
  if (game) return;
  game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    backgroundColor: '#04060a',
    physics: { default: 'arcade', arcade: { gravity: { y: 0 } } },
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: window.innerWidth,
      height: window.innerHeight
    },
    scene: MainScene
  });
}
