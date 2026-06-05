let WORLD_W = 2400;
let WORLD_H = 1350;
let BASE_X = WORLD_W / 2;
let BASE_Y = WORLD_H / 2;
let BASE_PERIMETER = 560;
let TURRET_X = BASE_X;
let TURRET_Y = BASE_Y;
let GAME_TZ_CLIENT = 'Europe/Paris';
let baseClockInterval = null;
let MAP_BOUNDS = { minI: -1, maxI: 1, minJ: -1, maxJ: 1 };

// Met a jour le bandeau #baseClock (jour de la base + heure jeu coloree jour/nuit).
// Demarre l'intervalle une seule fois ; safe a rappeler a chaque reconnexion.
function startBaseClock() {
  const el = document.getElementById('baseClock');
  if (!el) return;
  const tick = () => {
    const baseEl = serverElements.find(e => e.type === 'base');
    const state = baseEl ? elementStates.get(baseEl.id) : null;
    if (!state) return;
    SharedScene.updateBaseClock(el, state, GAME_TZ_CLIENT);
    el.classList.remove('hidden');
  };
  tick();
  if (baseClockInterval) return;
  baseClockInterval = setInterval(tick, 1000);
}
const ZOOM_FACTOR_MIN = 0.85;
const ZOOM_FACTOR_MAX = 2.5;
const ACTION_MAX_DURATION_MS_DEFAULT = 60 * 60 * 1000;

const SHIP_ASSET = '/assets/PNG/Ship_01/Ship_LVL_1.png';
const SHIP_SCALE = 0.035; // vaisseau Amiral discret
const ENEMY_LEVELS = [1];
const ENEMY_ASSETS = {
  1: '/assets/PNG/Ship_02/Ship_LVL_1.png'
};
const ENEMY_SCALE = 0.045; // ennemis plus discrets
// IA ennemie : cap sur la base par defaut, engagement des cibles croisees dans la range.
const ENEMY_SPEED_PX     = 40;   // px/s (aligne sur ENEMY_SPEED serveur)
const ENEMY_DETECT_RANGE = 340;  // rayon de detection d'une cible a engager
const ENEMY_ORBIT_R_MIN  = 90;
const ENEMY_ORBIT_R_MAX  = 160;
const ENEMY_FIRE_MS      = 5000;
// Tourelles : niveau visuel derive de la puissance (palier de 10)
const GUN_LEVELS = 10;
const GUN_SCALE = 0.55;
function turretGunLevel(puissance) {
  return Math.min(GUN_LEVELS, Math.max(1, 1 + Math.floor((puissance || 0) / 10)));
}
function turretRangePx(state) {
  // 280px de base + 10px par point de "range" — au range 0 on couvre déjà
  // le périmètre, au range 28 on couvre toute la zone d'arrivée des vagues
  return 280 + (state?.range || 0) * 10;
}
function gunKey(level, kind, frame) {
  const k = String(level).padStart(2, '0');
  if (kind === 'idle') return `gun-${k}-idle`;
  return `gun-${k}-shoot-${String(frame).padStart(2, '0')}`;
}

// Variants d'astéroïdes (asteroid_NN_with_cracks.png) : spritesheets en grille
// d'images de base (frame 0 = intact, dernière frame = quasi-détruit)
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
const ASTEROID_TARGET_SIZE = 130; // taille visuelle de référence (px monde) à scale=1
function asteroidScaleFor(variantKey, sizeMultiplier) {
  const meta = ASTEROID_VARIANTS[variantKey] || ASTEROID_VARIANTS['01'];
  return (ASTEROID_TARGET_SIZE * (sizeMultiplier || 1)) / Math.max(meta.w, meta.h);
}
function asteroidFrameFor(variantKey, hpRatio) {
  const meta = ASTEROID_VARIANTS[variantKey] || ASTEROID_VARIANTS['01'];
  const idx = Math.min(meta.count - 1, Math.max(0, Math.floor((1 - hpRatio) * meta.count)));
  return idx;
}

let token = localStorage.getItem('voidfaction:token') || null;
let username = localStorage.getItem('voidfaction:username') || null;
let pendingElementId = null; // id de l'élément cliqué quand non-auth, à rouvrir après auth

// État courant fourni par le serveur
let serverElements = [];
let elementStates = new Map();   // id -> { hp, hpMax, puissance, range, essence, essenceMax, subtype, destroyedAt, respawnsAt }
let factionResources = { materiaux: 0, radius: 0 };
let activeElementsByElement = new Map(); // element_id -> { action_id, category, username }
let lastActiveList = []; // liste brute des actions actives (1 entree par acteur) pour les compteurs
let activeAction = null; // { element_id, action_id, category, started_at, last_settled_at }
let progress = { puissance: 0, defensif: 0, utilitaire: 0, total: 0 };
let previousProgress = null;
let actionDurationMs = ACTION_MAX_DURATION_MS_DEFAULT;
let history = [];
let socket = null;
let authenticated = false;
let knownBuildTime = null;
let amiralDisplayName = 'AMIRAL';  // pseudo affiche sous le vaisseau (rempli par init)
let amiralIsOnline = true;  // true si l'Amiral observé est connecté (sinon vaisseau semi-transparent)

function triggerVersionReload() {
  console.log('%c[VoidFaction] Nouvelle version détectée — rechargement…', 'color:#f80; font-weight:bold; font-size:14px');
  // Bannière brève visible
  const notif = document.createElement('div');
  notif.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#f80;color:#000;padding:10px;text-align:center;font-family:Consolas,monospace;font-weight:bold;letter-spacing:1px;box-shadow:0 2px 12px rgba(0,0,0,0.5)';
  notif.textContent = 'Nouvelle version disponible — rechargement automatique…';
  document.body.appendChild(notif);
  setTimeout(() => location.reload(), 900);
}

// DOM refs
const resourceEl = document.getElementById('resource');
const userLineEl = document.getElementById('userLine');
const userLabelEl = document.getElementById('userLabel');
const authBtn = document.getElementById('authBtn');
const profileMenu = document.getElementById('profileMenu');
const soundBtn = document.getElementById('soundBtn');
const historyListEl = document.getElementById('historyList');

// ============ Toggle son (visuel + flag global, pas encore branche sur des audio) ============
window.gameSoundMuted = localStorage.getItem('voidfaction:muted') === '1';
function applySoundButtonState() {
  if (!soundBtn) return;
  if (window.gameSoundMuted) {
    soundBtn.classList.remove('sound-on');
    soundBtn.classList.add('sound-off');
    soundBtn.title = 'Activer le son';
  } else {
    soundBtn.classList.remove('sound-off');
    soundBtn.classList.add('sound-on');
    soundBtn.title = 'Couper le son';
  }
}
applySoundButtonState();
if (soundBtn) {
  soundBtn.addEventListener('click', () => {
    window.gameSoundMuted = !window.gameSoundMuted;
    localStorage.setItem('voidfaction:muted', window.gameSoundMuted ? '1' : '0');
    applySoundButtonState();
  });
}
const activeActionRow = document.getElementById('activeAction');
const activeActionName = document.getElementById('activeActionName');
const activeActionTimer = document.getElementById('activeActionTimer');
const deactivateBtn = document.getElementById('deactivateBtn');
const barEls = {
  PUISSANCE:  { val: document.getElementById('barPuissanceVal'),  fill: document.getElementById('barPuissanceFill') },
  DEFENSIF:   { val: document.getElementById('barDefensifVal'),   fill: document.getElementById('barDefensifFill') },
  UTILITAIRE: { val: document.getElementById('barUtilitaireVal'), fill: document.getElementById('barUtilitaireFill') }
};
const actionMenu = document.getElementById('actionMenu');
const actionMenuTitle = document.getElementById('actionMenuTitle');
const actionMenuActions = document.getElementById('actionMenuActions');
const actionMenuClose = document.getElementById('actionMenuClose');
const actionMenuDeact = document.getElementById('actionMenuDeact');
const actionMenuNote = document.getElementById('actionMenuNote');
const authModal = document.getElementById('authModal');
const authClose = document.getElementById('authClose');
const authError = document.getElementById('authError');
const loginForm = document.getElementById('loginForm');
const signupForm = document.getElementById('signupForm');
const tabs = document.querySelectorAll('.tab');

// ============ Helpers ============

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 0 || diff < 60000) return 'à l\'instant';
  const m = Math.floor(diff / 60000);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `il y a ${h}h`;
  return `il y a ${Math.floor(h / 24)}j`;
}

function formatDuration(ms) {
  if (ms <= 0) return '00:00';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function getElement(id) {
  return serverElements.find(e => e.id === id);
}

// ============ Rendu HUD ============

function updateUserLine() {
  const authBtnLabel = document.getElementById('authBtnLabel');
  const pmAction = document.getElementById('pmAuthAction');
  if (authenticated && username) {
    userLabelEl.textContent = username;
    userLineEl.classList.remove('anon');
    if (authBtnLabel) authBtnLabel.textContent = username;
    authBtn.title = 'Profil';
    if (pmAction) { pmAction.textContent = 'Déconnexion'; pmAction.classList.add('logout'); }
  } else {
    userLabelEl.textContent = 'Visiteur';
    userLineEl.classList.add('anon');
    if (authBtnLabel) authBtnLabel.textContent = 'Connexion';
    authBtn.title = 'Profil / Connexion';
    if (pmAction) { pmAction.textContent = 'Connexion'; pmAction.classList.remove('logout'); }
  }
}

// ============ Commandant (overlay HUD) ============
const CAPTAIN_FRAMES = (() => {
  const arr = [];
  for (let i = 0; i < 18; i++) arr.push(`/assets/PNG/CaptainTalk/Talk01/skeleton-LoopTalk_${i}.png`);
  return arr;
})();
// Précharge dès l'init du JS pour eviter le flickering au premier affichage
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
  }, 70); // ~14 fps
  if (durationMs > 0) {
    captainHideTimeout = setTimeout(hideCaptain, durationMs);
  }
}
function hideCaptain() {
  const el = document.getElementById('captainAlert');
  if (el) el.classList.add('hidden');
  if (captainAnimInterval) { clearInterval(captainAnimInterval); captainAnimInterval = null; }
  if (captainHideTimeout) { clearTimeout(captainHideTimeout); captainHideTimeout = null; }
}

let waveBannerInterval = null;
function showWaveBanner(wave, warningRemainingMs) {
  const banner = document.getElementById('waveBanner');
  if (!banner) return;
  const labelEl = banner.querySelector('.target');
  const cdEl = banner.querySelector('.countdown');
  if (labelEl) labelEl.textContent = wave.targetLabel || '';
  banner.classList.remove('hidden');
  banner.classList.add('warning');

  if (waveBannerInterval) clearInterval(waveBannerInterval);
  const update = () => {
    const now = Date.now();
    const remaining = wave.warningEndsAt - now;
    if (remaining > 0) {
      cdEl.textContent = formatWaveCountdown(remaining);
      banner.classList.add('warning');
      banner.classList.remove('active');
    } else if (now < wave.endsAt) {
      cdEl.textContent = 'EN COURS';
      banner.classList.remove('warning');
      banner.classList.add('active');
    } else {
      banner.classList.add('hidden');
      banner.classList.remove('warning', 'active');
      clearInterval(waveBannerInterval);
      waveBannerInterval = null;
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

function renderFactionResources() {
  const m = document.getElementById('factionMateriaux');
  const r = document.getElementById('factionRadius');
  if (m) m.textContent = factionResources.materiaux || 0;
  if (r) r.textContent = factionResources.radius || 0;
}

function animateBarPlus(cat, delta) {
  const bar = document.querySelector(`.bar.${cat}`);
  if (!bar) return;
  const float = document.createElement('span');
  float.className = 'float-plus';
  float.textContent = `+${delta}`;
  bar.appendChild(float);
  setTimeout(() => float.remove(), 1600);
}

function renderBars() {
  // Le panneau PUISSANCE/DÉFENSIF/UTILITAIRE a été retiré de l'UI.
  // La fonction reste comme no-op pour ne pas casser les appels existants.
  const cats = ['PUISSANCE', 'DEFENSIF', 'UTILITAIRE'];
  const keys = { PUISSANCE: 'puissance', DEFENSIF: 'defensif', UTILITAIRE: 'utilitaire' };
  const max = Math.floor(actionDurationMs / 10000);
  for (const c of cats) {
    const v = progress[keys[c]] || 0;
    const slot = barEls[c];
    if (!slot || !slot.val || !slot.fill) continue;
    slot.val.textContent = v;
    const pct = Math.min(100, (v / max) * 100);
    slot.fill.style.width = pct + '%';
  }
}

function renderActiveAction() {
  if (!authenticated) {
    activeActionRow.classList.add('idle');
    activeActionName.innerHTML = '<span style="opacity:0.5">connecte-toi pour agir</span>';
    activeActionTimer.textContent = '';
    return;
  }
  if (!activeAction) {
    activeActionRow.classList.add('idle');
    activeActionName.textContent = '— aucune —';
    activeActionTimer.textContent = '';
    return;
  }
  activeActionRow.classList.remove('idle');
  const el = getElement(activeAction.element_id);
  const actionDef = el?.actions.find(a => a.id === activeAction.action_id);
  const cat = activeAction.category;
  const label = actionDef ? actionDef.label : activeAction.action_id;
  const target = el ? el.label : activeAction.element_id;
  activeActionName.innerHTML = `<span class="cat-tag ${cat}">${cat}</span> <strong>${escapeHtml(label)}</strong> sur ${escapeHtml(target)}`;
  refreshActiveActionTimer();
}

function refreshActiveActionTimer() {
  if (!activeAction) { activeActionTimer.textContent = ''; return; }
  const remaining = (activeAction.started_at + actionDurationMs) - Date.now();
  activeActionTimer.textContent = remaining > 0 ? `⏳ ${formatDuration(remaining)} restant` : 'Expiration imminente…';
}

function renderHistory(_freshTimestamp) {
  // Le panneau d'activite recente est retire de l'UI pour l'instant ; on garde la fonction
  // comme no-op pour que les call sites existants ne plantent pas.
  if (!historyListEl) return;
}

setInterval(() => {
  refreshActiveActionTimer();
}, 1000);

// ============ Menu d'action ============

let actionMenuElementId = null;

function openActionMenu(elementId, anchor) {
  if (!authenticated) {
    pendingElementId = elementId;
    openAuthModal();
    return;
  }
  const el = getElement(elementId);
  if (!el) return;
  actionMenuElementId = elementId;
  actionMenuTitle.textContent = el.label;
  // Affiche le cercle de range si c'est une tourelle
  {
    const scene = game.scene.getScene('main');
    if (scene && scene.scene.isActive()) {
      if (el.type === 'turret') scene.showRangeCircle(elementId);
      else scene.hideRangeCircle();
    }
  }
  // Stats de l'élément
  const statsEl = document.getElementById('actionMenuStats');
  if (statsEl) {
    const st = elementStates.get(elementId);
    if (st) {
      const parts = [];
      if (el.type === 'base' && typeof st.daysAlive === 'number') parts.push(`Jour <strong>${st.daysAlive}</strong>`);
      if (st.hp !== undefined && el.type !== 'asteroid') parts.push(`HP <strong>${st.hp}</strong>/${st.hpMax}`);
      if (st.puissance !== undefined) parts.push(`Puissance <strong>${st.puissance}</strong>`);
      if (st.range !== undefined) parts.push(`Portée <strong>${st.range}</strong>`);
      if (st.essence !== undefined) parts.push(`Essence <strong>${st.essence}</strong>/${st.essenceMax}`);
      if (st.subtype) parts.push(`Type <strong>${st.subtype === 'radius' ? 'Radius' : 'Matériaux'}</strong>`);
      statsEl.innerHTML = parts.join(' &middot; ');
      statsEl.classList.remove('hidden');
    } else {
      statsEl.classList.add('hidden');
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
    actionMenuNote.textContent = `Tu vas désactiver ton action en cours.`;
    actionMenuNote.classList.remove('hidden');
  } else {
    actionMenuNote.classList.add('hidden');
  }

  // Positionnement: près du point cliqué, en restant dans le viewport
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
  const scene = game.scene.getScene('main');
  if (scene && scene.scene.isActive()) scene.hideRangeCircle();
}

actionMenuClose.addEventListener('click', closeActionMenu);
actionMenuDeact.addEventListener('click', () => deactivateCurrent());

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeActionMenu(); });

document.addEventListener('mousedown', (e) => {
  if (actionMenu.classList.contains('hidden')) return;
  if (!actionMenu.contains(e.target)) closeActionMenu();
}, true);

function activateAction(elementId, actionId) {
  if (!socket || !authenticated) return;
  socket.emit('action:activate', { elementId, actionId }, (resp) => {
    if (resp?.ok) {
      closeActionMenu();
    } else {
      console.warn('[action] échec activation:', resp?.error);
    }
  });
}

function deactivateCurrent() {
  if (!socket || !authenticated || !activeAction) return;
  socket.emit('action:deactivate', null, () => closeActionMenu());
}

deactivateBtn.addEventListener('click', deactivateCurrent);

// ============ Auth ============

async function refreshAmiralSelect() {
  const sel = document.getElementById('signupAmiralSelect');
  const warn = document.getElementById('signupNoAmiral');
  const submitBtn = document.getElementById('signupSubmit');
  if (!sel) return;
  try {
    const res = await fetch('/api/amiraux');
    const body = await res.json();
    const amiraux = Array.isArray(body?.amiraux) ? body.amiraux : [];
    sel.innerHTML = '';
    if (amiraux.length === 0) {
      sel.innerHTML = '<option value="">— Aucun Amiral inscrit —</option>';
      sel.disabled = true;
      if (warn) warn.classList.remove('hidden');
      if (submitBtn) submitBtn.disabled = true;
    } else {
      // Online d'abord, offline ensuite ; chaque entree taggee
      const sorted = [...amiraux].sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));
      for (const a of sorted) {
        const opt = document.createElement('option');
        opt.value = a.name;
        opt.textContent = a.online ? `${a.name} (en ligne)` : `${a.name} (hors-ligne)`;
        sel.appendChild(opt);
      }
      sel.disabled = false;
      if (warn) warn.classList.add('hidden');
      if (submitBtn) submitBtn.disabled = false;
    }
  } catch (e) {
    if (warn) warn.classList.remove('hidden');
    if (submitBtn) submitBtn.disabled = true;
  }
}

function openAuthModal() {
  authError.textContent = '';
  authModal.classList.remove('hidden');
  refreshAmiralSelect();
  setTimeout(() => {
    const visible = signupForm.classList.contains('hidden') ? loginForm : signupForm;
    visible.querySelector('input')?.focus();
  }, 50);
}
function closeAuthModal() {
  authModal.classList.add('hidden');
  pendingElementId = null;
}

// Action d'authentification (depuis le bouton du menu profil) : connexion ou deconnexion.
async function doAuthAction() {
  if (authenticated) {
    try {
      await fetch('/api/logout', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
    } catch {}
    token = null; username = null; authenticated = false;
    localStorage.removeItem('voidfaction:token');
    localStorage.removeItem('voidfaction:username');
    activeAction = null;
    progress = { puissance: 0, defensif: 0, utilitaire: 0, total: 0 };
    updateUserLine();
    renderActiveAction();
    renderBars();
    connectSocket();
  } else {
    openAuthModal();
  }
}

// Le bouton profil ouvre/ferme le menu (identite + ressources + commandes + connexion).
authBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  profileMenu.classList.toggle('hidden');
});
document.getElementById('pmAuthAction').addEventListener('click', () => {
  profileMenu.classList.add('hidden');
  doAuthAction();
});
document.addEventListener('click', (e) => {
  if (profileMenu.classList.contains('hidden')) return;
  if (!profileMenu.contains(e.target) && !authBtn.contains(e.target)) profileMenu.classList.add('hidden');
});

authClose.addEventListener('click', closeAuthModal);
authModal.addEventListener('click', (e) => { if (e.target === authModal) closeAuthModal(); });

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    tabs.forEach((t) => t.classList.toggle('active', t === tab));
    const isLogin = tab.dataset.tab === 'login';
    loginForm.classList.toggle('hidden', !isLogin);
    signupForm.classList.toggle('hidden', isLogin);
    authError.textContent = '';
    setTimeout(() => (isLogin ? loginForm : signupForm).querySelector('input')?.focus(), 30);
  });
});

async function submitAuth(endpoint, data) {
  authError.textContent = '';
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  } catch (e) {
    authError.textContent = 'Erreur réseau: ' + (e?.message || 'inconnue');
    return false;
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    authError.textContent = body.error || `Erreur ${res.status}`;
    return false;
  }
  token = body.token;
  username = body.username;
  localStorage.setItem('voidfaction:token', token);
  localStorage.setItem('voidfaction:username', username);
  closeAuthModal();
  const pending = pendingElementId;
  pendingElementId = null;
  connectSocket();
  if (pending) {
    setTimeout(() => openActionMenu(pending, null), 400);
  }
  return true;
}

loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const fd = new FormData(loginForm);
  submitAuth('/api/login', { username: fd.get('username'), password: fd.get('password') });
});
signupForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const fd = new FormData(signupForm);
  submitAuth('/api/signup', {
    username: fd.get('username'),
    password: fd.get('password'),
    amiralName: fd.get('amiralName')
  });
});

// ============ Socket ============

function connectSocket() {
  if (socket) socket.disconnect();
  socket = io({ auth: token ? { token } : {} });

  socket.on('init', (data) => {
    if (data.buildTime) {
      if (knownBuildTime && knownBuildTime !== data.buildTime) {
        triggerVersionReload();
        return;
      }
      knownBuildTime = data.buildTime;
      const d = new Date(data.buildTime);
      console.log(`%c[VoidFaction] dernière MAJ : ${d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'medium' })}`,
        'color:#4af; font-weight:bold');
    }
    if (resourceEl) resourceEl.textContent = data.resource;
    authenticated = !!data.user;
    if (data.user) {
      username = data.user.username;
      localStorage.setItem('voidfaction:username', username);
    } else if (token) {
      token = null;
      localStorage.removeItem('voidfaction:token');
      localStorage.removeItem('voidfaction:username');
      username = null;
    }
    serverElements = Array.isArray(data.elements) ? data.elements : [];
    elementStates = new Map((data.elementStates || []).map(s => [s.id, s]));
    factionResources = data.factionResources || { materiaux: 0, radius: 0 };
    activeAction = data.activeAction || null;
    progress = data.progress || { puissance: 0, defensif: 0, utilitaire: 0, total: 0 };
    previousProgress = { ...progress };
    actionDurationMs = data.actionDurationMs || ACTION_MAX_DURATION_MS_DEFAULT;
    history = Array.isArray(data.history) ? data.history : [];
    rebuildActiveElementsMap(data.activeElements);
    if (data.world) {
      WORLD_W = data.world.width;
      WORLD_H = data.world.height;
      BASE_X = data.world.baseX ?? WORLD_W / 2;
      BASE_Y = data.world.baseY ?? WORLD_H / 2;
      BASE_PERIMETER = data.world.basePerimeter ?? 560;
      TURRET_X = data.world.turretX;
      TURRET_Y = data.world.turretY;
      GAME_TZ_CLIENT = data.world.gameTz || 'Europe/Paris';
      MAP_BOUNDS = {
        minI: data.world.mapMinI ?? -1, maxI: data.world.mapMaxI ?? 1,
        minJ: data.world.mapMinJ ?? -1, maxJ: data.world.mapMaxJ ?? 1
      };
    }
    startBaseClock();
    updateUserLine();
    renderActiveAction();
    renderBars();
    renderFactionResources();
    renderHistory();
    amiralDisplayName = data.watchedAmiral?.username || data.amiral?.username || 'AMIRAL';
    amiralIsOnline = data.watchedAmiral?.online !== false;
    const scene = game.scene.getScene('main');
    if (scene && scene.scene.isActive()) {
      if (scene.shipLabel) scene.shipLabel.setText(amiralDisplayName);
      scene.setShipState(data.ship);
      if (scene.ship) scene.ship.setAlpha(amiralIsOnline ? 1 : 0.45);
      if (scene.shipLabel) scene.shipLabel.setAlpha(amiralIsOnline ? 1 : 0.45);
      scene.setupElements(serverElements);
      scene.applyAllElementStates();
      scene.drawBasePerimeter();
      if (data.currentWave) scene.handleWaveIncoming(data.currentWave);
    }
    if (data.currentWave) triggerCaptainForWave(data.currentWave);
  });

  socket.on('resource', (data) => { if (resourceEl) resourceEl.textContent = data.resource; });

  socket.on('ship', (data) => {
    const scene = game.scene.getScene('main');
    if (scene && scene.scene.isActive()) scene.setShipState(data);
  });

  socket.on('action:state', (data) => {
    const oldProgress = previousProgress;
    activeAction = data.activeAction || null;
    progress = data.progress || progress;
    // Anim +N pour chaque catégorie qui a gagné des points depuis le dernier état
    if (oldProgress) {
      const deltas = {
        PUISSANCE:  (progress.puissance  || 0) - (oldProgress.puissance  || 0),
        DEFENSIF:   (progress.defensif   || 0) - (oldProgress.defensif   || 0),
        UTILITAIRE: (progress.utilitaire || 0) - (oldProgress.utilitaire || 0)
      };
      for (const cat of ['PUISSANCE', 'DEFENSIF', 'UTILITAIRE']) {
        if (deltas[cat] > 0) animateBarPlus(cat, deltas[cat]);
      }
      // +N sur l'élément activé (catégorie de l'action active si elle existe)
      const cat = activeAction?.category;
      if (cat && deltas[cat] > 0) {
        const scene = game.scene.getScene('main');
        if (scene && scene.scene.isActive()) {
          scene.flashElementPlus(activeAction.element_id, deltas[cat], cat);
        }
      }
    }
    previousProgress = { ...progress };
    renderActiveAction();
    renderBars();
    // Halo "mon action en cours" sur l'element concerne.
    const scene2 = game.scene.getScene('main');
    if (scene2 && scene2.scene.isActive()) {
      SharedScene.refreshActionOverlay(scene2, lastActiveList, activeAction?.element_id);
    }
  });

  socket.on('elements:update', (data) => {
    // Ne pas ecraser la liste active sur les broadcasts partiels (states seuls).
    if (Array.isArray(data.activeElements)) {
      lastActiveList = data.activeElements;
      rebuildActiveElementsMap(data.activeElements);
    }
    if (Array.isArray(data.states)) {
      // Fusion (pas de remplacement) : les broadcasts partiels (base, asteroides) ne doivent pas s'ecraser
      for (const s of data.states) elementStates.set(s.id, s);
    }
    if (data.faction) {
      factionResources = data.faction;
      renderFactionResources();
    }
    const scene = game.scene.getScene('main');
    if (scene && scene.scene.isActive()) {
      scene.refreshElementHighlights();
      scene.applyAllElementStates();
      SharedScene.refreshActionOverlay(scene, lastActiveList, activeAction?.element_id);
    }
  });

  socket.on('asteroid:destroyed', (data) => {
    const scene = game.scene.getScene('main');
    if (scene && scene.scene.isActive()) scene.onAsteroidDestroyed(data.id, data.respawnsAt);
    const state = elementStates.get(data.id);
    if (state) { state.hp = 0; state.destroyedAt = Date.now(); state.respawnsAt = data.respawnsAt; }
  });

  socket.on('asteroid:respawned', (data) => {
    const scene = game.scene.getScene('main');
    if (scene && scene.scene.isActive()) scene.onAsteroidRespawned(data.id);
    if (data.state) elementStates.set(data.id, data.state);
  });

  // Un seul timer de respawn par groupe (affiche au centroide via SharedScene).
  socket.on('asteroid:group_destroyed', (data) => {
    const scene = game.scene.getScene('main');
    for (const id of (data.ids || [])) {
      if (scene && scene.scene.isActive()) scene.onAsteroidDestroyed(id, data.respawnsAt);
      const state = elementStates.get(id);
      if (state) { state.hp = 0; state.destroyedAt = Date.now(); state.respawnsAt = data.respawnsAt; }
    }
    if (scene && scene.scene.isActive() && data.subtype) {
      SharedScene.showGroupRespawnTimer(scene, data.subtype, data.respawnsAt);
    }
  });
  socket.on('asteroid:group_respawned', (data) => {
    const scene = game.scene.getScene('main');
    const ids = data.ids || [];
    const states = data.states || [];
    for (let i = 0; i < ids.length; i++) {
      if (scene && scene.scene.isActive()) scene.onAsteroidRespawned(ids[i]);
      if (states[i]) elementStates.set(ids[i], states[i]);
    }
    if (scene && scene.scene.isActive() && data.subtype) {
      SharedScene.clearGroupRespawnTimer(scene, data.subtype);
    }
  });

  socket.on('base:reborn', (data) => {
    if (data?.state) elementStates.set(data.id, data.state);
    const scene = game.scene.getScene('main');
    if (scene && scene.scene.isActive()) scene.applyAllElementStates();
  });

  socket.on('history:new', (entry) => {
    if (!entry) return;
    history.unshift(entry);
    if (history.length > 10) history.pop();
    renderHistory(entry.at);
  });

  socket.on('wave:incoming', (wave) => {
    const scene = game.scene.getScene('main');
    if (scene && scene.scene.isActive()) scene.handleWaveIncoming(wave);
    triggerCaptainForWave(wave);
  });

  // Liste des Amiraux connectés met à jour le dropdown si la modal est ouverte
  socket.on('amirals:update', (data) => {
    if (authModal && !authModal.classList.contains('hidden')) refreshAmiralSelect();
    // Vaisseau semi-transparent si l'Amiral observe est offline
    const onlineList = Array.isArray(data?.amiraux) ? data.amiraux : [];
    const isOnline = onlineList.some(a => a.name === amiralDisplayName);
    amiralIsOnline = isOnline;
    const scene = game.scene.getScene('main');
    if (scene && scene.scene.isActive()) {
      if (scene.ship) scene.ship.setAlpha(isOnline ? 1 : 0.45);
      if (scene.shipLabel) scene.shipLabel.setAlpha(isOnline ? 1 : 0.45);
    }
  });
}

function triggerCaptainForWave(wave) {
  if (!wave) return;
  const now = Date.now();
  const warnMs = Math.max(0, wave.warningEndsAt - now);
  const totalRemaining = Math.max(0, wave.endsAt - now);
  if (warnMs > 0) {
    // Captain affiche brievement (15s max) ; la banniere de wave reste pour le compte a rebours
    const captainDurationMs = Math.min(15000, warnMs + 800);
    showCaptain(`<span class="danger">⚠ ENNEMIS DÉTECTÉS</span><br>Tenez vos positions !`, captainDurationMs);
    // Bascule sur un message "engagement" une fois la phase d'alerte terminee
    setTimeout(() => {
      if (Date.now() < wave.endsAt - 1500) {
        showCaptain(`<span class="danger">L'ENNEMI EST LÀ !</span><br>Tirez sur les hostiles !`, Math.max(1500, wave.endsAt - Date.now() - 600));
      }
    }, warnMs);
  } else if (totalRemaining > 1500) {
    showCaptain(`<span class="danger">L'ENNEMI EST LÀ !</span><br>Tirez sur les hostiles !`, totalRemaining - 600);
  }
}

function rebuildActiveElementsMap(list) {
  activeElementsByElement = new Map();
  if (!Array.isArray(list)) return;
  for (const entry of list) {
    activeElementsByElement.set(entry.element_id, entry);
  }
}

// ============ Phaser Scene ============

class MainScene extends Phaser.Scene {
  constructor() { super('main'); }

  preload() {
    this.load.image('ship', SHIP_ASSET);
    this.load.image('mothership-base', '/assets/Spaceships/PNG/enemy_mothership.png');
    this.load.spritesheet('shield', '/assets/Weapons/PNG/shield_frames.png', { frameWidth: 280, frameHeight: 280 });
    this.load.spritesheet('rocket-flame', '/assets/Weapons/PNG/rocket_flame_animation.png', { frameWidth: 12, frameHeight: 46 });
    // Frames d'exhaust pour le vaisseau Amiral (Ship_01, variant 2 = grosse flamme)
    for (let i = 0; i < 10; i++) {
      const n = String(i).padStart(3, '0');
      this.load.image(`ship-fr-${n}`, `/assets/PNG/Ship_01/Exhaust/Exhaust_1_2_${n}.png`);
    }
    // Frames d'exhaust + explosion pour les ennemis (par niveau)
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
    // Tourelles : 10 niveaux x (1 idle + 10 shoot frames)
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
    // Systeme de "cases" : le viewer voit une case a la fois (une case entiere tient a
    // l'ecran a userZoomFactor=1). La camera ne suit PAS automatiquement le vaisseau ;
    // le viewer se deplace librement et utilise la minimap pour rejoindre le streameur.
    this._userZoomFactor = 1.0;
    this.applyFitZoom();
    SharedScene.updateCaseCamera(this, this.ship ? this.ship.x : BASE_X, this.ship ? this.ship.y : BASE_Y);
    this._cameraInitFromShip = false; // recadre une 1re fois sur le vaisseau des reception de sa position
    // Minimap : clic = teleporter la vue (rejoindre le streameur / explorer).
    this._minimap = SharedScene.setupMinimap({ bounds: MAP_BOUNDS, onTp: (wx, wy) => SharedScene.tpCameraTo(this, wx, wy, true) });
    document.getElementById('minimap')?.classList.remove('hidden');
    document.getElementById('minimapLabel')?.classList.remove('hidden');
    this.scale.on('resize', () => this.onResize());

    // Background parallax (background_04 : fond fixe + planètes parallax)
    this.setupParallaxBackground();

    // Animations vaisseaux (Amiral + ennemis lvl 1 et 2)
    this.createShipAnimations();

    // Maps des éléments (peuplées par setupElements)
    this.elementSprites = new Map();
    this.elementHighlights = new Map();
    this.createTurretTexture();
    this.createExplosionTexture();

    // Vaisseau Amiral (positionné via socket)
    this.ship = this.add.sprite(WORLD_W / 2, WORLD_H / 2 + 230, 'ship-fr-000')
      .setScale(SHIP_SCALE)
      .setOrigin(0.5, 0.36)
      .setDepth(7); // au-dessus des assets (base/tourelles/asteroides en depth 0)
    this.ship.play('ship-thrust');
    this.ship._hp = 100;
    this.ship._hpMax = 100;
    // Cliquable : ouvre le menu d'actions du vaisseau (tir / portee, comme une tourelle).
    // Hit area = cercle genereux en coords texture (vaisseau scale 0.035, sprite ~25px ecran).
    this.ship.setInteractive({
      hitArea: new Phaser.Geom.Circle(this.ship.width / 2, this.ship.height / 2, Math.max(this.ship.width, this.ship.height) * 0.7),
      hitAreaCallback: Phaser.Geom.Circle.Contains,
      useHandCursor: true
    });
    this.ship.on('pointerdown', (pointer) => {
      if (pointer.button !== 0) return;
      if (this._panState) this._panState.pendingMenu = { id: 'ship-1', event: pointer.event };
    });
    // Flamme de reacteur attachee a l'arriere du vaisseau (sprite anime 7 frames)
    this.shipFlame = this.add.sprite(this.ship.x, this.ship.y, 'rocket-flame', 0)
      .setScale(0.8)
      .setOrigin(0.5, 0)
      .setDepth(this.ship.depth - 1);
    this.shipFlame.play('rocket-flame-loop');
    this.shipHpBar = this.makeHpBar(this.ship.x, this.ship.y - 40, 60, 0x4fdb73);
    this.shipHpBar.setDepth(11);
    this.shipLabel = this.add.text(this.ship.x, this.ship.y - 56, amiralDisplayName, {
      fontFamily: 'Consolas, monospace', fontSize: '13px', color: '#4af',
      stroke: '#000', strokeThickness: 3, fontStyle: 'bold'
    }).setOrigin(0.5).setDepth(11);
    // Si l'Amiral observé est offline, on grise le vaisseau pour le signaler
    this.ship.setAlpha(amiralIsOnline ? 1 : 0.45);
    this.shipLabel.setAlpha(amiralIsOnline ? 1 : 0.45);

    // Cercle de "grande base" (rayon visuel autour du centre)
    this.drawBasePerimeter();

    // Conteneur pour les ennemis
    this.enemies = new Set();
    this.waveWarnIcon = null;

    // Zoom à la molette (zoomFactor relatif au "fit" qui s'adapte aux resize)
    this.input.on('wheel', (pointer, _gos, _dx, deltaY) => {
      this._userZoomFactor = Phaser.Math.Clamp(this._userZoomFactor - deltaY * 0.0006, ZOOM_FACTOR_MIN, ZOOM_FACTOR_MAX);
      // Zoom vers le curseur (pas de recentrage), borne a la case.
      SharedScene.zoomToPointer(this, pointer, () => this.applyFitZoom());
    });

    // Drag-to-pan (style MOBA) : clic gauche maintenu + deplacement = panoramique de la carte
    // Si le mouvement est inferieur a un seuil, on traite comme un clic et on ouvre le menu d'action de l'element vise.
    this._panState = { active: false, lastX: 0, lastY: 0, moved: 0, pendingMenu: null };
    const DRAG_THRESHOLD_PX = 6;
    this.input.on('pointerdown', (pointer) => {
      if (pointer.button !== 0) return;
      this._panState.active = true;
      this._panState.lastX = pointer.x;
      this._panState.lastY = pointer.y;
      this._panState.moved = 0;
    });
    this.input.on('pointermove', (pointer) => {
      // _panState.active passe a true sur pointerdown gauche et false sur pointerup
      // -> pas besoin de revérifier les boutons ici (et `pointer.isDown` peut filtrer faussement)
      if (!this._panState.active) return;
      const dx = pointer.x - this._panState.lastX;
      const dy = pointer.y - this._panState.lastY;
      this._panState.lastX = pointer.x;
      this._panState.lastY = pointer.y;
      this._panState.moved += Math.hypot(dx, dy);
      if (this._panState.moved > DRAG_THRESHOLD_PX) {
        const cam = this.cameras.main;
        cam.scrollX -= dx / cam.zoom;
        cam.scrollY -= dy / cam.zoom;
        // La camera ne peut pas sortir de la case courante.
        SharedScene.clampScrollToCase(this);
      }
    });
    this.input.on('pointerup', (pointer) => {
      if (pointer.button !== 0) return;
      const wasPanning = this._panState.moved > DRAG_THRESHOLD_PX;
      if (!wasPanning && this._panState.pendingMenu) {
        openActionMenu(this._panState.pendingMenu.id, this._panState.pendingMenu.event);
      }
      this._panState.active = false;
      this._panState.moved = 0;
      this._panState.pendingMenu = null;
    });

    // Si l'init est déjà arrivée avant que create() ne tourne, on applique maintenant
    if (serverElements.length > 0) {
      this.setupElements(serverElements);
      this.applyAllElementStates();
    }
  }

  update(time, delta) {
    this.updateParallaxBackground();
    if (this.ship) {
      if (this.shipLabel) {
        this.shipLabel.x = this.ship.x;
        this.shipLabel.y = this.ship.y - 56;
      }
      if (this.shipHpBar) {
        this.shipHpBar.x = this.ship.x;
        this.shipHpBar.y = this.ship.y - 40;
      }
      // Sync flamme de reacteur a l'arriere du vaisseau
      if (this.shipFlame) {
        const rearAngle = this.ship.rotation + Math.PI / 2;
        const offset = 18;
        this.shipFlame.x = this.ship.x + Math.cos(rearAngle) * offset;
        this.shipFlame.y = this.ship.y + Math.sin(rearAngle) * offset;
        this.shipFlame.rotation = rearAngle - Math.PI / 2;
      }
    }
    this.updateTurretTargeting();
    this.updateShipTargeting();
    this.updateEnemies(delta);
    // Au tout premier positionnement connu du vaisseau, on recadre dessus (sinon vue libre).
    if (this.ship && !this._cameraInitFromShip && (this.ship.x !== WORLD_W / 2 || this.ship.y !== WORLD_H / 2 + 230)) {
      this._cameraInitFromShip = true;
      SharedScene.tpCameraTo(this, this.ship.x, this.ship.y, false);
    }
    if (this._minimap) SharedScene.drawMinimap(this._minimap, this, this.ship ? this.ship.x : null, this.ship ? this.ship.y : null);
    SharedScene.positionActionOverlay(this); // suit le vaisseau (labels + halo)
  }

  // Cibles hostiles qu'un ennemi peut engager : asteroides vivants, tourelles, vaisseau du joueur.
  collectEnemyTargets() {
    const targets = [];
    if (this.elementSprites) {
      for (const el of serverElements) {
        if (el.type === 'asteroid') {
          const s = this.elementSprites.get(el.id);
          if (s && s.active && s.alpha > 0.5) targets.push({ kind: 'asteroid', sprite: s });
        } else if (el.type === 'turret') {
          const s = this.elementSprites.get(el.id);
          if (s && s.active) targets.push({ kind: 'turret', sprite: s });
        }
      }
    }
    if (this.ship && this.ship.active) targets.push({ kind: 'ship', sprite: this.ship });
    return targets;
  }

  updateEnemies(delta) {
    if (!this.enemies) return;
    const dtSec = (delta || 16) / 1000;
    const now = this.time.now;
    const targets = this.collectEnemyTargets();
    for (const sprite of this.enemies) {
      if (!sprite.active) continue;

      // Cible hostile la plus proche dans la range de detection
      let best = null, bestDist = ENEMY_DETECT_RANGE;
      for (const t of targets) {
        const d = Phaser.Math.Distance.Between(sprite.x, sprite.y, t.sprite.x, t.sprite.y);
        if (d < bestDist) { best = t; bestDist = d; }
      }

      let mode, cx, cy, orbitR;
      if (best) {
        mode = best.kind;
        cx = best.sprite.x; cy = best.sprite.y;
        orbitR = sprite._orbitRadius;
        // Nouvelle cible : on casse la trajectoire et on (re)part en approche
        if (sprite._engageRef !== best.sprite) {
          sprite._engageRef = best.sprite;
          sprite._engaging = false;
        }
      } else {
        // Aucune cible : on file vers la base centrale (orbite sans degats une fois arrive)
        if (sprite._engageRef !== 'base') {
          sprite._engageRef = 'base';
          sprite._engaging = false;
        }
        mode = 'base';
        cx = BASE_X; cy = BASE_Y;
        orbitR = BASE_PERIMETER + sprite._orbitRadius;
      }

      const distToCenter = Phaser.Math.Distance.Between(sprite.x, sprite.y, cx, cy);
      if (!sprite._engaging && distToCenter > orbitR + 6) {
        // Phase d'approche : on fonce en ligne droite vers la cible
        const dx = cx - sprite.x, dy = cy - sprite.y;
        const dn = distToCenter || 1;
        const step = ENEMY_SPEED_PX * dtSec;
        sprite.x += (dx / dn) * step;
        sprite.y += (dy / dn) * step;
        sprite.rotation = Math.atan2(dy, dx) + Math.PI / 2;
      } else {
        // Phase d'orbite (a l'entree, on cale l'angle sur la position d'approche courante)
        if (!sprite._engaging) {
          sprite._engaging = true;
          sprite._orbitAngle = Math.atan2(sprite.y - cy, sprite.x - cx);
        }
        sprite._orbitAngle += sprite._orbitSpeed * dtSec;
        sprite.x = cx + Math.cos(sprite._orbitAngle) * orbitR;
        sprite.y = cy + Math.sin(sprite._orbitAngle) * orbitR;
        const tangent = sprite._orbitAngle + (sprite._orbitSpeed > 0 ? Math.PI / 2 : -Math.PI / 2);
        sprite.rotation = tangent + Math.PI / 2;
        // Tir visuel sur la cible (base incluse). Cote viewer : pas d'autorite, on n'emet rien ;
        // les degats base sont pilotes par le client Amiral (streameur).
        if (!sprite._lastFireAt) sprite._lastFireAt = now - Math.random() * ENEMY_FIRE_MS;
        if (now - sprite._lastFireAt >= ENEMY_FIRE_MS) {
          this.fireEnemyShot(sprite, cx, cy);
          sprite._lastFireAt = now;
        }
      }

      if (sprite._hpBar) {
        sprite._hpBar.x = sprite.x;
        sprite._hpBar.y = sprite.y - 38;
      }
    }
  }

  updateTurretTargeting() {
    if (!this.elementSprites || !this.enemies) return;
    const now = Date.now();
    const powered = SharedScene.isBasePowered();
    for (const el of serverElements) {
      if (el.type !== 'turret') continue;
      const sprite = this.elementSprites.get(el.id);
      const state = elementStates.get(el.id);
      if (!sprite || !state) continue;
      SharedScene.applyTurretPowerVisual(sprite, powered);
      // Base hors tension : la tourelle est desactivee (la patrouille reprend naturellement).
      if (!powered) { sprite._targetingEnemy = false; continue; }
      // Tourelle autonome : tire en permanence sur l'ennemi le plus proche.
      // L'action 'tir' boost les degats via state.puissance.
      const range = turretRangePx(state);
      const target = this.findNearestEnemyInRange(sprite.x, sprite.y, range);
      if (target) {
        if (sprite._patrolTween) sprite._patrolTween.stop();
        sprite._targetingEnemy = true;
        const a = Phaser.Math.Angle.Between(sprite.x, sprite.y, target.x, target.y);
        sprite.rotation = a + Math.PI / 2;
        if (!sprite._lastShotAt) sprite._lastShotAt = 0;
        const fireDelay = Math.max(1000, 2000 - (state.puissance || 0) * 30);
        if (now - sprite._lastShotAt >= fireDelay) {
          const dmg = 5 + Math.floor((state.puissance || 0) * 0.5);
          this.fireTurretLaser(sprite, target);
          this.damageEnemy(target, dmg);
          sprite._lastShotAt = now;
        }
      } else {
        // Pas d'ennemi : la patrouille reprend au prochain tick du timer (max 5s)
        sprite._targetingEnemy = false;
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

  // Vaisseau : meme principe que les tourelles mais source mobile (this.ship).
  // Stats derivees du nombre d'acteurs actifs sur 'tir'/'visee'. Independant de l'essence base.
  updateShipTargeting() {
    if (!this.ship || !this.ship.active || !this.enemies) return;
    const state = elementStates.get('ship-1');
    if (!state) return;
    const range = turretRangePx(state);
    const target = this.findNearestEnemyInRange(this.ship.x, this.ship.y, range);
    if (!target) return;
    const now = Date.now();
    if (!this.ship._lastShotAt) this.ship._lastShotAt = 0;
    const fireDelay = Math.max(1000, 2000 - (state.puissance || 0) * 30);
    if (now - this.ship._lastShotAt >= fireDelay) {
      const dmg = 5 + Math.floor((state.puissance || 0) * 0.5);
      this.fireTurretLaser(this.ship, target);
      this.damageEnemy(target, dmg);
      this.ship._lastShotAt = now;
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

  showRangeCircle(turretId) {
    this.hideRangeCircle();
    const state = elementStates.get(turretId);
    const sprite = this.elementSprites.get(turretId);
    if (!state || !sprite) return;
    const range = turretRangePx(state);
    const g = this.add.graphics().setDepth(-30);
    g.fillStyle(0xff4f6d, 0.08);
    g.fillCircle(sprite.x, sprite.y, range);
    g.lineStyle(2, 0xff4f6d, 0.65);
    g.strokeCircle(sprite.x, sprite.y, range);
    // Petits ticks à cardinaux
    g.lineStyle(2, 0xff4f6d, 0.8);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const x1 = sprite.x + Math.cos(a) * (range - 8);
      const y1 = sprite.y + Math.sin(a) * (range - 8);
      const x2 = sprite.x + Math.cos(a) * (range + 8);
      const y2 = sprite.y + Math.sin(a) * (range + 8);
      g.beginPath();
      g.moveTo(x1, y1); g.lineTo(x2, y2);
      g.strokePath();
    }
    this.rangeCircleGfx = g;
  }

  hideRangeCircle() {
    if (this.rangeCircleGfx) {
      this.rangeCircleGfx.destroy();
      this.rangeCircleGfx = null;
    }
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
    SharedScene.clampScrollToCase(this);
    if (this.bgLayer01) this.bgLayer01.setPosition(w / 2, h / 2);
    this.updateParallaxBackground();
  }

  createShipAnimations() {
    const mkFrames = (prefix, count, pad) =>
      Array.from({ length: count }, (_, i) => ({ key: `${prefix}${String(i).padStart(pad || 3, '0')}` }));
    if (!this.anims.exists('ship-thrust')) {
      this.anims.create({ key: 'ship-thrust', frames: mkFrames('ship-fr-', 10, 3), frameRate: 24, repeat: -1 });
    }
    if (!this.anims.exists('rocket-flame-loop')) {
      this.anims.create({
        key: 'rocket-flame-loop',
        frames: this.anims.generateFrameNumbers('rocket-flame', { start: 0, end: 6 }),
        frameRate: 18, repeat: -1
      });
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
    // Animations de tir tourelle (10 niveaux)
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
    // Calque 01 : fond principal, fixé à la caméra
    const bg01 = this.add.image(w / 2, h / 2, 'bg-01')
      .setOrigin(0.5).setScrollFactor(0).setDepth(-100);
    this.bgLayer01 = bg01;
    // Calque 03 : petite planète parallax dans le monde
    const bg03 = this.add.image(2200, 1200, 'bg-03')
      .setOrigin(0.5).setScrollFactor(0.35).setDepth(-80).setScale(0.4);
    this.bgLayer03 = bg03;
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

  // Pas de bouclier visuel autour de la base (la base n'a pas de shield).
  // On nettoie d'eventuels restes ; BASE_PERIMETER reste utilise par l'IA ennemie.
  drawBasePerimeter() {
    if (this.basePerimeterGfx) { this.basePerimeterGfx.destroy(); this.basePerimeterGfx = null; }
    if (this.basePerimeterHalo) { this.basePerimeterHalo.destroy(); this.basePerimeterHalo = null; }
    if (this.shieldSprite) { this.shieldSprite.destroy(); this.shieldSprite = null; }
  }

  setupElements(elements) {
    if (!Array.isArray(elements)) return;
    for (const s of this.elementSprites.values()) s.destroy();
    for (const h of this.elementHighlights.values()) h.destroy();
    if (this.elementHpBars) for (const b of this.elementHpBars.values()) b.destroy();
    if (this.elementLabels) for (const l of this.elementLabels.values()) l.destroy();
    if (this.elementRespawnTimers) for (const t of this.elementRespawnTimers.values()) t.destroy();
    SharedScene.clearAllGroupRespawnTimers(this);
    this.elementSprites.clear();
    this.elementHighlights.clear();
    this.elementHpBars = new Map();
    this.elementLabels = new Map();
    this.elementRespawnTimers = new Map();

    this.createBaseTexture();

    // Barre commune partagee par subtype d'asteroide (materiaux / radius)
    const groupBarSubtypes = new Set();

    elements.forEach((el, i) => {
      if (el.type === 'asteroid') {
        const variant = el.variant || '01';
        const meta = ASTEROID_VARIANTS[variant] || ASTEROID_VARIANTS['01'];
        const phaserScale = asteroidScaleFor(variant, el.scale);
        const tint = el.subtype === 'radius' ? 0x88e0c8 : 0xffffff;
        const visibleSize = Math.max(meta.w, meta.h) * phaserScale;
        // Filtre NEAREST pour eviter le shimmer linear-filter sur les bords
        const tex = this.textures.get(`a-${variant}`);
        if (tex) tex.setFilter(Phaser.Textures.FilterMode.NEAREST);
        const highlight = this.add.circle(el.x, el.y, visibleSize * 0.6, 0xffd24f, 0)
          .setStrokeStyle(3, 0xffd24f, 0);
        const sprite = this.add.sprite(el.x, el.y, `a-${variant}`, 0)
          .setScale(phaserScale)
          .setRotation(Math.random() * Math.PI * 2)
          .setTint(tint)
          .setInteractive({ useHandCursor: true });
        // Asteroides statiques : rotation aleatoire fixee a l'init, pas d'animation

        sprite.on('pointerdown', (pointer) => {
          if (pointer.button !== 0) return;
          // Defer : on memorise l'intent ; le menu s'ouvrira au pointerup si pas de drag
          if (this._panState) this._panState.pendingMenu = { id: el.id, event: pointer.event };
        });
        sprite._asteroidVariant = variant;
        this.elementSprites.set(el.id, sprite);
        this.elementHighlights.set(el.id, highlight);
        // Pas de barre HP visible sur les asteroides : l'info est dans le menu d'action au clic
      } else if (el.type === 'turret') {
        const highlight = this.add.circle(el.x, el.y, 60, 0xff4f6d, 0)
          .setStrokeStyle(2, 0xff4f6d, 0);
        // Orientation initiale "vers l'extérieur" : direction du centre de la base vers la tourelle
        const outward = Math.atan2(el.y - BASE_Y, el.x - BASE_X);
        const baseRot = outward + Math.PI / 2; // l'asset Gun pointe vers le haut, on compense
        const sprite = this.add.sprite(el.x, el.y, 'gun-01-idle')
          .setScale(GUN_SCALE)
          .setRotation(baseRot)
          .setInteractive({ useHandCursor: true });
        sprite._baseRotation = baseRot;
        // Patrouille discrete : toutes les 5s, tire un angle aleatoire entre baseRot et baseRot + π/4 ;
        // la tourelle pivote vers cet angle (transition courte) puis y reste jusqu'au prochain tirage.
        const PATROL_AMP = Math.PI / 4;
        const pickNewPatrolTarget = () => {
          if (!sprite.active || sprite._targetingEnemy) return;
          const target = baseRot + Math.random() * PATROL_AMP;
          if (sprite._patrolTween) sprite._patrolTween.stop();
          sprite._patrolTween = this.tweens.add({
            targets: sprite,
            rotation: target,
            duration: 800,
            ease: 'Sine.easeInOut'
          });
        };
        pickNewPatrolTarget();
        sprite._patrolEvent = this.time.addEvent({ delay: 5000, loop: true, callback: pickNewPatrolTarget });
        sprite._turretId = el.id;
        sprite.on('pointerdown', (pointer) => {
          if (pointer.button !== 0) return;
          // Defer : on memorise l'intent ; le menu s'ouvrira au pointerup si pas de drag
          if (this._panState) this._panState.pendingMenu = { id: el.id, event: pointer.event };
        });
        this.elementSprites.set(el.id, sprite);
        this.elementHighlights.set(el.id, highlight);
        const bar = this.makeHpBar(el.x, el.y - 70, 90, 0xff4f6d);
        this.elementHpBars.set(el.id, bar);
      } else if (el.type === 'base') {
        const highlight = this.add.circle(el.x, el.y, 120, 0x4af, 0)
          .setStrokeStyle(2, 0x4af, 0);
        const sprite = this.add.image(el.x, el.y, 'mothership-base').setScale(0.9)
          .setInteractive({ useHandCursor: true });
        sprite.on('pointerdown', (pointer) => {
          if (pointer.button !== 0) return;
          // Defer : on memorise l'intent ; le menu s'ouvrira au pointerup si pas de drag
          if (this._panState) this._panState.pendingMenu = { id: el.id, event: pointer.event };
        });
        this.baseElementId = el.id;
        this.elementSprites.set(el.id, sprite);
        this.elementHighlights.set(el.id, highlight);
        const bar = this.makeHpBar(el.x, el.y - 88, 120, 0x4af);
        this.elementHpBars.set(el.id, bar);
      }
    });
    this.refreshElementHighlights();
    SharedScene.refreshActionOverlay(this, lastActiveList, activeAction?.element_id);
  }

  makeHpBar(x, y, width, strokeColor) {
    const container = this.add.container(x, y);
    const bg = this.add.rectangle(0, 0, width, 6, 0x000000, 0.6)
      .setStrokeStyle(1.5, strokeColor || 0xffffff, 0.85);
    const fill = this.add.rectangle(-width / 2, 0, width, 4, 0x4fdb73).setOrigin(0, 0.5);
    container.add([bg, fill]);
    container.fill = fill;
    container.bg = bg;
    container.maxWidth = width;
    container.strokeColor = strokeColor;
    return container;
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
      // Frame de l'astéroïde en fonction du HP
      const sprite = this.elementSprites.get(id);
      if (sprite && sprite._asteroidVariant) {
        sprite.setFrame(asteroidFrameFor(sprite._asteroidVariant, ratio));
      }
    }
    // Apparence tourelles (niveau visuel + anim tir)
    for (const el of serverElements) {
      if (el.type === 'turret') this.updateTurretAppearance(el.id);
    }
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
    const activeHere = activeElementsByElement.get(id);
    const isShooting = activeHere && activeHere.action_id === 'tir';
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

  // Astero detruit (un seul). Animation visuelle uniquement ; le timer de respawn
  // est gere au niveau du GROUPE dans le handler asteroid:group_destroyed.
  onAsteroidDestroyed(id /*, respawnsAt */) {
    const sprite = this.elementSprites.get(id);
    const bar = this.elementHpBars.get(id);
    SharedScene.fadeAsteroidSprite(this, sprite, bar);
  }

  onAsteroidRespawned(id) {
    const sprite = this.elementSprites.get(id);
    const bar = this.elementHpBars.get(id);
    SharedScene.restoreAsteroidSprite(this, sprite, bar);
    this.applyAllElementStates();
  }

  createBaseTexture() {
    if (this.textures.exists('base')) return;
    const g = this.make.graphics({ x: 0, y: 0, add: false });
    const cx = 80, cy = 80, r = 60;
    // Hexagone extérieur
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
    // Anneau intérieur
    g.fillStyle(0x223a5e, 1);
    g.fillCircle(cx, cy, r * 0.65);
    g.lineStyle(2, 0x6cf, 0.7);
    g.strokeCircle(cx, cy, r * 0.65);
    // Croix centrale
    g.lineStyle(2, 0x4af, 1);
    g.beginPath();
    g.moveTo(cx - 14, cy); g.lineTo(cx + 14, cy);
    g.moveTo(cx, cy - 14); g.lineTo(cx, cy + 14);
    g.strokePath();
    // Dot central
    g.fillStyle(0x4af, 1);
    g.fillCircle(cx, cy, 5);
    g.generateTexture('base', 160, 160);
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

  handleWaveIncoming(wave) {
    if (!wave) return;
    const now = Date.now();
    const warningRemaining = Math.max(0, wave.warningEndsAt - now);
    // UI bannière
    showWaveBanner(wave, warningRemaining);
    // Icône d'alerte dans le monde, près du point d'arrivée des ennemis
    this.showWaveWarnIcon(wave);
    // Programmer le spawn des ennemis
    for (const enemy of wave.enemies) {
      const delay = warningRemaining + (enemy.spawnOffsetMs || 0);
      this.time.delayedCall(delay, () => this.spawnEnemy(enemy));
    }
    // Nettoyage du marqueur de bord après le warning
    this.time.delayedCall(warningRemaining + 600, () => this.hideWaveWarnIcon());
  }

  showWaveWarnIcon(wave) {
    this.hideWaveWarnIcon();
    const avgX = wave.enemies.reduce((s, e) => s + e.spawnX, 0) / wave.enemies.length;
    const avgY = wave.enemies.reduce((s, e) => s + e.spawnY, 0) / wave.enemies.length;
    const x = Math.max(60, Math.min(WORLD_W - 60, avgX));
    const y = Math.max(60, Math.min(WORLD_H - 60, avgY));
    // Viseur leger marquant la zone d'arrivee des ennemis (pas de cible nommee).
    this.waveWarnIcon = this.makeReticle(x, y);
  }

  // Petit viseur (anneau + croix), discret et pulsant. Renvoie un objet a detruire.
  makeReticle(x, y) {
    const g = this.add.graphics().setDepth(9);
    const R = 22, tick = 8, col = 0xff6655;
    g.lineStyle(2, col, 0.85);
    g.strokeCircle(0, 0, R);
    g.beginPath();
    g.moveTo(-R - 7, 0); g.lineTo(-R + tick, 0);
    g.moveTo(R + 7, 0);  g.lineTo(R - tick, 0);
    g.moveTo(0, -R - 7); g.lineTo(0, -R + tick);
    g.moveTo(0, R + 7);  g.lineTo(0, R - tick);
    g.strokePath();
    g.fillStyle(col, 0.9); g.fillCircle(0, 0, 2);
    g.setPosition(x, y).setAlpha(0);
    this.tweens.add({ targets: g, alpha: { from: 0, to: 0.9 }, duration: 350, ease: 'Sine.easeOut' });
    this.tweens.add({ targets: g, scaleX: { from: 1, to: 1.18 }, scaleY: { from: 1, to: 1.18 }, yoyo: true, repeat: -1, duration: 700, ease: 'Sine.easeInOut' });
    return g;
  }

  hideWaveWarnIcon() {
    if (this.waveWarnIcon) {
      this.tweens.killTweensOf(this.waveWarnIcon);
      this.tweens.add({
        targets: this.waveWarnIcon,
        alpha: 0,
        duration: 300,
        onComplete: () => this.waveWarnIcon?.destroy()
      });
      this.waveWarnIcon = null;
    }
  }

  spawnEnemy(e) {
    const level = 1;
    const sprite = this.add.sprite(e.spawnX, e.spawnY, `enemy${level}-fr-000`)
      .setScale(ENEMY_SCALE)
      .setOrigin(0.5, 0.36)
      .setDepth(8);
    sprite.play(`enemy${level}-thrust`);
    sprite._level = level;
    sprite._hp = sprite._hpMax = 30;
    sprite._orbitRadius = ENEMY_ORBIT_R_MIN + Math.random() * (ENEMY_ORBIT_R_MAX - ENEMY_ORBIT_R_MIN);
    sprite._orbitSpeed = (0.20 + Math.random() * 0.20) * (Math.random() < 0.5 ? 1 : -1);
    sprite._engageRef = null;
    sprite._engaging = false;
    // Oriente d'emblee vers la base (cap par defaut)
    sprite.rotation = Math.atan2(BASE_Y - e.spawnY, BASE_X - e.spawnX) + Math.PI / 2;
    sprite._hpBar = this.makeHpBar(sprite.x, sprite.y - 38, 40, 0xff3322);
    sprite._hpBar.setDepth(8);
    this.enemies.add(sprite);
  }

  damageEnemy(sprite, dmg) {
    if (!sprite.active) return;
    sprite._hp = Math.max(0, sprite._hp - dmg);
    // Refresh barre
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
    if (sprite._hpBar) sprite._hpBar.destroy();
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
    const particles = this.add.particles(x, y, 'explosion-dot', {
      speed: { min: 80, max: 220 },
      scale: { start: 1.5, end: 0 },
      alpha: { start: 1, end: 0 },
      lifespan: 700,
      blendMode: 'ADD',
      quantity: 18,
      emitting: false
    });
    particles.explode(18);
    this.time.delayedCall(900, () => particles.destroy());
  }

  createTurretTexture() {
    const g = this.make.graphics({ x: 0, y: 0, add: false });
    // Base : disque foncé avec anneau
    g.fillStyle(0x1a2335, 1);
    g.fillCircle(40, 40, 30);
    g.lineStyle(2, 0xff8044, 1);
    g.strokeCircle(40, 40, 30);
    // Cercle intérieur
    g.fillStyle(0x2a3550, 1);
    g.fillCircle(40, 40, 20);
    g.lineStyle(1.5, 0xff4f6d, 0.8);
    g.strokeCircle(40, 40, 20);
    // Canon vertical
    g.fillStyle(0x404a60, 1);
    g.fillRect(34, 8, 12, 32);
    g.lineStyle(1.5, 0xff8044, 1);
    g.strokeRect(34, 8, 12, 32);
    // Embout du canon
    g.fillStyle(0xff4f6d, 1);
    g.fillRect(33, 4, 14, 6);
    // Point central
    g.fillStyle(0xff4f6d, 1);
    g.fillCircle(40, 40, 4);
    g.generateTexture('turret', 80, 80);
    g.destroy();
  }

  refreshElementHighlights() {
    if (!this.elementHighlights) return;
    for (const [elementId, highlight] of this.elementHighlights.entries()) {
      const active = activeElementsByElement.get(elementId);
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
    // Met à jour l'animation tir des tourelles quand un état actif change
    for (const el of serverElements) {
      if (el.type === 'turret') this.updateTurretAppearance(el.id);
    }
  }

  setShipState(s) {
    if (!this.ship || !s) return;
    this.ship.x = s.x;
    this.ship.y = s.y;
    this.ship.rotation = s.rotation;
  }

  flashElementPlus(elementId, n, category) {
    const sprite = this.elementSprites?.get(elementId);
    if (!sprite) return;
    const color = category === 'PUISSANCE'  ? '#ff4f6d' :
                  category === 'DEFENSIF'   ? '#4fa3ff' :
                  category === 'UTILITAIRE' ? '#ffd24f' :
                                              '#ffffff';
    const txt = this.add.text(sprite.x, sprite.y - 30, `+${n}`, {
      fontFamily: 'Consolas, monospace',
      fontSize: '22px',
      color,
      stroke: '#000000',
      strokeThickness: 4,
      fontStyle: 'bold'
    }).setOrigin(0.5);
    this.tweens.add({
      targets: txt,
      y: txt.y - 48,
      alpha: { from: 1, to: 0 },
      scale: { from: 0.7, to: 1.1 },
      duration: 1500,
      ease: 'Cubic.easeOut',
      onComplete: () => txt.destroy()
    });
  }
}

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#04060a',
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: window.innerWidth,
    height: window.innerHeight
  },
  scene: MainScene
});

updateUserLine();
renderActiveAction();
renderBars();
connectSocket();
