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
let latestShipState = null; // derniere position connue du vaisseau amiral (appliquee au demarrage de la scene)

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
const ZOOM_FACTOR_MIN = 0.5;   // plage de zoom resserree (double-clic pour zoomer sur un element)
const ZOOM_FACTOR_MAX = 1.3;
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
const ENEMY_MIN_BASE_DIST = 300; // distance mini au centre de la base (evite que les ennemis collent la base)
const ENEMY_FIRE_MS      = 5000;
// Tourelles : niveau visuel = puissance (Gun01..Gun10) ; puissance va de 1 a 10.
const GUN_LEVELS = 10;
const GUN_SCALE = 0.55;
function turretGunLevel(puissance) {
  return Math.min(GUN_LEVELS, Math.max(1, puissance | 0));
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
const ASTEROID_TARGET_SIZE = 85; // taille visuelle de référence (px monde) à scale=1
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
let levels = { PUISSANCE: 1, DEFENSIF: 1, UTILITAIRE: 1 }; // niveaux viewer par categorie (1-3)
let xp = { PUISSANCE: 0, DEFENSIF: 0, UTILITAIRE: 0 };      // XP brute par categorie (pour les barres)
// Seuils niv2 / niv3 PAR categorie (fournis par le serveur). Attaque en combats, def/util en temps.
let levelXp = { PUISSANCE: [5, 15], DEFENSIF: [10, 30], UTILITAIRE: [10, 30] };
// Contribution TOTALE en cours par action ("elementId|actionId" -> somme des niveaux des acteurs).
let actionContributions = {};
let baseDead = false; // base detruite : aucune action possible en attendant la relance de l'Amiral
let actionDurationMs = ACTION_MAX_DURATION_MS_DEFAULT;
let history = [];
let journal = [];
let chat = [];
let pendingWave = null; // vague active recue a l'init, appliquee des que la scene est prete
let socket = null;

// ============ Ecran de chargement ============
const loadingOverlay = document.getElementById('loadingOverlay');
const ldBarFill = document.getElementById('ldBarFill');
let _loaderHidden = false;
function setLoaderProgress(p) { if (ldBarFill) ldBarFill.style.width = Math.round((p || 0) * 100) + '%'; }
function hideLoader() {
  if (_loaderHidden) return;
  _loaderHidden = true;
  if (ldBarFill) ldBarFill.style.width = '100%';
  if (loadingOverlay) {
    loadingOverlay.classList.add('hidden');
    setTimeout(() => { loadingOverlay.style.display = 'none'; }, 600);
  }
}
// Filet de securite : ne jamais rester bloque sur le loader.
setTimeout(hideLoader, 12000);
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
const journalListEl = document.getElementById('journalList');
// Journal + Chat : boutons bas-gauche, panneaux masques par defaut, exclusifs.
const hudButtons = document.getElementById('hudButtons');
const journalEl = document.getElementById('journal');
const chatEl = document.getElementById('chat');
const journalBtn = document.getElementById('journalBtn');
const chatBtn = document.getElementById('chatBtn');
const journalBadge = document.getElementById('journalBadge');
const chatBadge = document.getElementById('chatBadge');
const chatListEl = document.getElementById('chatList');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const chatLocked = document.getElementById('chatLocked');
let journalUnread = 0;
let chatUnread = 0;

// ============ Son ============
// Le flag global de mute + le menu de reglages (musique / annonces / fx) sont gères
// par sfx.js (SFX.initSoundMenu), partage entre la page joueur et la page streameur.
window.gameSoundMuted = localStorage.getItem('voidfaction:muted') === '1';

// ============ Sons de vagues (annonce + debut), par type ============
const WAVE_SOUNDS = {
  normale:  '/assets/sounds/vague_normale.mp3',
  soutenue: '/assets/sounds/vague_soutenue.mp3',
  dure:     '/assets/sounds/vague_dure.mp3'
};
const _waveAudio = {};
for (const [k, src] of Object.entries(WAVE_SOUNDS)) { try { const a = new Audio(src); a.preload = 'auto'; _waveAudio[k] = a; } catch (e) {} }
function playWaveSound(type) {
  if (window.gameSoundMuted) return;
  const base = _waveAudio[type] || _waveAudio.normale;
  if (!base) return;
  const vol = 0.6 * (window.SFX ? SFX.getVol('announce') : 1); // canal Annonces
  try { const a = base.cloneNode(); a.volume = vol; a.play().catch(() => {}); } catch (e) {}
}

// Retrospective : capture le canvas Phaser, le reduit (~480px, JPEG) et l'envoie au serveur.
function captureSnapshot() {
  const scene = (typeof game !== 'undefined' && game) ? game.scene.getScene('main') : null;
  if (!scene || !scene.scene.isActive() || !game.renderer || !game.renderer.snapshot) return;
  try {
    game.renderer.snapshot((image) => {
      try {
        if (!image || !image.width) return;
        const W = 480, H = Math.max(1, Math.round(W * (image.height / image.width)));
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        c.getContext('2d').drawImage(image, 0, 0, W, H);
        if (socket) socket.emit('snapshot:store', { dataUrl: c.toDataURL('image/jpeg', 0.6) });
      } catch (e) {}
    });
  } catch (e) {}
}
const actionChip = document.getElementById('actionChip');   // pastille "action en cours" (barre de ressources)
const actionGlyph = document.getElementById('actionGlyph');  // cercle teinte par categorie
const actionIco = document.getElementById('actionIco');      // image de l'icone d'action
const actionTime = document.getElementById('actionTime');    // temps restant sous l'icone
const actionTip = document.getElementById('actionTip');      // infobulle au survol = nom de l'action
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
  // Les barres d'XP (toujours visibles sous le profil) ne concernent que les joueurs connectes.
  const xpPanel = document.getElementById('xpPanel');
  if (xpPanel) xpPanel.classList.toggle('hidden', !(authenticated && username));
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
// Précharge dès l'init du JS pour eviter le flickering au premier affichage.
// On RETIENT les objets Image (sinon le GC peut les liberer : la 1re vague affichait
// alors un portrait vide, le temps que les frames soient re-telechargees).
const _captainPreload = CAPTAIN_FRAMES.map((src) => { const img = new Image(); img.src = src; return img; });

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

function renderLevels() {
  const suffix = { PUISSANCE: 'Puissance', DEFENSIF: 'Defensif', UTILITAIRE: 'Utilitaire' };
  for (const cat in suffix) {
    const [t2, t3] = levelXp[cat] || [5, 15]; // seuils niv2 / niv3 propres a la categorie
    const lvl = Math.max(1, Math.min(3, levels[cat] || 1));
    const x = (xp && xp[cat]) || 0;
    const lvlEl = document.getElementById('xpLvl' + suffix[cat]);
    const fillEl = document.getElementById('xpFill' + suffix[cat]);
    const valEl = document.getElementById('xpVal' + suffix[cat]);
    // Valeur lisible : XP dans le palier courant / XP requise pour le palier suivant.
    const lo = lvl === 1 ? 0 : t2;
    const hi = lvl === 1 ? t2 : t3;
    const within = Math.max(0, x - lo);
    const need = Math.max(1, hi - lo);
    if (lvlEl) lvlEl.textContent = `Niv. ${lvl}`;            // niveau aligne a droite (entete)
    if (valEl) valEl.textContent = lvl >= 3 ? `MAX (${x})` : `${within} / ${need}`; // valeur DANS la barre
    if (fillEl) {
      const pct = lvl >= 3 ? 100 : (within / need) * 100;
      fillEl.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    }
  }
}

// Disparition d'un overlay (victoire / defaite) avec une transition de fondu.
function dismissOverlay(el) {
  if (!el || el.classList.contains('hidden') || el.classList.contains('fade-out')) return;
  el.classList.add('fade-out');
  setTimeout(() => { el.classList.add('hidden'); el.classList.remove('fade-out'); }, 480);
}
// Badge "vague eliminee" (ennemis totalement detruits). Reste affiche ; un clic le
// fait partir (fondu). Fallback auto au bout de 7s pour ne pas bloquer la vue.
let _victoryTimer = null;
function showVictory() {
  const el = document.getElementById('victoryOverlay');
  if (!el) return;
  clearTimeout(_victoryTimer);
  el.classList.remove('hidden', 'fade-out');
  void el.offsetWidth; // relance l'animation d'entree
  _victoryTimer = setTimeout(() => dismissOverlay(el), 7000);
}
// Clic pour fermer les overlays victoire / defaite (avec transition).
document.getElementById('victoryOverlay')?.addEventListener('click', () => dismissOverlay(document.getElementById('victoryOverlay')));
document.getElementById('baseDeadOverlay')?.addEventListener('click', () => dismissOverlay(document.getElementById('baseDeadOverlay')));
function showLevelUpToast(category, lvl) {
  const label = category === 'PUISSANCE' ? 'TIR' : category === 'DEFENSIF' ? 'DÉFENSE' : 'UTILITAIRE';
  try { showCaptain(`<span class="danger">NIVEAU ${lvl} !</span><br>${label} amélioré.`, 6000); } catch (e) {}
}

function renderActiveAction() {
  // Pastille compacte : visible seulement quand une action tourne. On affiche l'icone
  // de l'action (minage, reparation, ...) ; au survol -> juste le nom ; dessous -> temps restant.
  if (!authenticated || !activeAction) {
    actionChip.classList.add('idle');
    actionGlyph.className = 'action-glyph';
    if (actionTime) actionTime.textContent = '';
    if (actionTip) actionTip.textContent = '';
    return;
  }
  actionChip.classList.remove('idle');
  const el = getElement(activeAction.element_id);
  const actionDef = el?.actions.find(a => a.id === activeAction.action_id);
  const cat = activeAction.category;
  const label = actionDef ? actionDef.label : activeAction.action_id;
  actionGlyph.className = 'action-glyph ' + cat;
  // Icone de l'action (reconstruction = icone reparation, comme dans le menu)
  const icon = ACTION_ICONS[activeAction.action_id];
  if (actionIco) {
    if (icon) { actionIco.src = icon; actionIco.style.display = ''; }
    else actionIco.style.display = 'none';
  }
  // hover = nom + rappel de la regle de duree (1 h max, stoppable a tout moment)
  if (actionTip) actionTip.innerHTML = `<strong>${escapeHtml(label)}</strong><br>Valable <b>1 h</b> max — peut être stoppée à tout moment.`;
  refreshActiveActionTimer();
}

function refreshActiveActionTimer() {
  if (!activeAction || !actionTime) return;
  const remaining = (activeAction.started_at + actionDurationMs) - Date.now();
  actionTime.textContent = remaining > 0 ? formatDuration(remaining) : '0s';
}

function renderHistory(_freshTimestamp) {
  // Le panneau d'activite recente est retire de l'UI pour l'instant ; on garde la fonction
  // comme no-op pour que les call sites existants ne plantent pas.
  if (!historyListEl) return;
}

// ============ Journal d'evenements ============
function formatClock(at) {
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
// Colore les mots de categorie + met le niveau en gras dans un message de journal (deja echappe).
function decorateJournalMsg(escaped) {
  return (escaped || '')
    .replace(/niveau\s+(\d+)/gi, '<b>niveau $1</b>')
    .replace(/\bPUISSANCE\b/g, '<span class="jr-cat p">ATTAQUE</span>')
    .replace(/\bDEFENSIF\b/g, '<span class="jr-cat d">DÉFENSE</span>')
    .replace(/\bUTILITAIRE\b/g, '<span class="jr-cat u">UTILITAIRE</span>');
}
function journalItemHtml(entry) {
  const type = String(entry.type || '').replace(/[^a-z_]/gi, '');
  return `<div class="jr-item ${type}"><span class="jr-time">${formatClock(entry.at)}</span>`
       + `<span class="jr-msg">${decorateJournalMsg(escapeHtml(entry.message || ''))}</span></div>`;
}
function renderJournal() {
  if (!journalListEl) return;
  // journal[] est ordonne du plus ancien au plus recent -> on affiche le plus recent en haut.
  journalListEl.innerHTML = journal.map(journalItemHtml).reverse().join('');
}
function addJournalEntry(entry) {
  if (!entry) return;
  journal.push(entry);
  if (journal.length > 40) journal.shift();
  renderJournal();
  if (!journalIsOpen()) { journalUnread++; setBadge(journalBtn, journalBadge, journalUnread); }
}

// ============ Panneaux bas-gauche : journal + chat (exclusifs) ============
function setBadge(btn, badgeEl, n) {
  if (!btn || !badgeEl) return;
  if (n > 0) { badgeEl.textContent = n > 99 ? '99+' : String(n); btn.classList.add('has-unread'); }
  else btn.classList.remove('has-unread');
}
function journalIsOpen() { return journalEl && !journalEl.classList.contains('hidden'); }
function chatIsOpen() { return chatEl && !chatEl.classList.contains('hidden'); }
function closePanels() {
  journalEl?.classList.add('hidden');
  chatEl?.classList.add('hidden');
  journalBtn?.classList.remove('active');
  chatBtn?.classList.remove('active');
}
function openPanel(which) {
  closePanels();
  if (which === 'journal') {
    journalEl?.classList.remove('hidden');
    journalBtn?.classList.add('active');
    journalUnread = 0; setBadge(journalBtn, journalBadge, 0);
  } else if (which === 'chat') {
    chatEl?.classList.remove('hidden');
    chatBtn?.classList.add('active');
    chatUnread = 0; setBadge(chatBtn, chatBadge, 0);
    if (chatListEl) chatListEl.scrollTop = chatListEl.scrollHeight;
    if (authenticated && chatInput) chatInput.focus();
  }
}
function togglePanel(which) {
  const el = which === 'journal' ? journalEl : chatEl;
  if (!el) return;
  if (el.classList.contains('hidden')) openPanel(which);
  else closePanels();
}

// ---- Chat communautaire ----
function chatMsgHtml(m) {
  const isAmiral = !m.userId;                 // l'Amiral poste sans user_id
  const mine = !isAmiral && authenticated && username && m.username === username;
  const lvl = (m.level && !isAmiral) ? `<span class="cm-lvl lvl${m.level}">Niv ${m.level}</span>` : '';
  const cls = 'cm-author' + (isAmiral ? ' amiral' : mine ? ' me' : '');
  const name = (isAmiral ? '👑 ' : '') + escapeHtml(m.username || '?');
  return `<div class="chat-msg">${lvl}<span class="${cls}">${name}</span>`
       + `<span class="cm-text">${escapeHtml(m.message || '')}</span>`
       + `<span class="cm-time">${formatClock(m.at)}</span></div>`;
}
function renderChat() {
  if (!chatListEl) return;
  chatListEl.innerHTML = chat.map(chatMsgHtml).join('');
  chatListEl.scrollTop = chatListEl.scrollHeight;
}
function addChatMessage(m) {
  if (!m) return;
  chat.push(m);
  if (chat.length > 50) chat.shift();
  renderChat();
  if (!chatIsOpen()) { chatUnread++; setBadge(chatBtn, chatBadge, chatUnread); }
}
let chatBlocked = null;        // null | { reason: 'mute'|'ban', until }
let chatUnmuteTimer = null;
function setChatBlock(block) {
  chatBlocked = block || null;
  if (chatUnmuteTimer) { clearTimeout(chatUnmuteTimer); chatUnmuteTimer = null; }
  if (chatBlocked && chatBlocked.reason === 'mute' && chatBlocked.until) {
    chatUnmuteTimer = setTimeout(() => { chatBlocked = null; updateChatAuthUI(); },
      Math.max(0, chatBlocked.until - Date.now()) + 500);
  }
  updateChatAuthUI();
}
function updateChatAuthUI() {
  // Boutons journal/chat reserves aux connectes.
  if (hudButtons) hudButtons.style.display = authenticated ? 'flex' : 'none';
  if (!authenticated) closePanels();
  if (!chatForm || !chatLocked) return;
  if (authenticated && chatBlocked) {
    chatForm.classList.add('hidden');
    chatLocked.classList.remove('hidden');
    chatLocked.textContent = chatBlocked.reason === 'ban'
      ? 'Tu as été banni du chat de cette base.'
      : 'Tu es en sourdine sur cette base (timeout 1h).';
  } else {
    chatForm.classList.toggle('hidden', !authenticated);
    chatLocked.classList.toggle('hidden', authenticated);
    if (!authenticated) chatLocked.textContent = 'Connecte-toi pour écrire dans le chat.';
  }
}

// Masque l'infobulle apres un clic (le curseur reste sur le bouton mais on ne veut plus la voir).
function suppressHint(btn) { if (btn) { btn.classList.add('suppress-hint'); btn.blur(); } }
journalBtn?.addEventListener('click', () => { togglePanel('journal'); suppressHint(journalBtn); });
chatBtn?.addEventListener('click', () => { togglePanel('chat'); suppressHint(chatBtn); });
[journalBtn, chatBtn].forEach(b => b?.addEventListener('mouseleave', () => b.classList.remove('suppress-hint')));

// ====== Retrospective 12h : reglette temporelle sur les captures de la base ======
(function () {
  const btn = document.getElementById('snapshotBtn');
  const panel = document.getElementById('snapshotPanel');
  if (!btn || !panel) return;
  const img = document.getElementById('snapImg');
  const empty = document.getElementById('snapEmpty');
  const slider = document.getElementById('snapSlider');
  const timeLabel = document.getElementById('snapTimeLabel');
  const countLabel = document.getElementById('snapCount');
  let snaps = [];
  const fmt = (t) => { const d = new Date(t); const hh = String(d.getHours()).padStart(2, '0'); const mm = String(d.getMinutes()).padStart(2, '0'); return `${hh}:${mm}`; };
  function showIndex(i) {
    if (!snaps.length) return;
    i = Math.max(0, Math.min(snaps.length - 1, i));
    const s = snaps[i];
    img.src = s.url; img.classList.add('shown');
    timeLabel.textContent = fmt(s.t);
    countLabel.textContent = `${i + 1}/${snaps.length}`;
  }
  function open() {
    panel.classList.remove('hidden');
    suppressHint(btn);
    if (!socket) return;
    socket.emit('snapshot:list', (resp) => {
      snaps = (resp && Array.isArray(resp.snapshots)) ? resp.snapshots : [];
      if (!snaps.length) {
        empty.style.display = ''; img.classList.remove('shown'); img.removeAttribute('src');
        slider.max = 0; slider.value = 0; timeLabel.textContent = '—'; countLabel.textContent = '';
        return;
      }
      empty.style.display = 'none';
      slider.min = 0; slider.max = snaps.length - 1; slider.value = snaps.length - 1;
      showIndex(snaps.length - 1); // demarre sur la plus recente
    });
  }
  function close() { panel.classList.add('hidden'); }
  btn.addEventListener('click', () => { panel.classList.contains('hidden') ? open() : close(); });
  btn.addEventListener('mouseleave', () => btn.classList.remove('suppress-hint'));
  document.getElementById('snapClose')?.addEventListener('click', close);
  slider?.addEventListener('input', () => showIndex(parseInt(slider.value, 10) || 0));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
})();
chatForm?.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = (chatInput?.value || '').trim();
  if (!text || !socket || !authenticated) return;
  socket.emit('chat:send', { message: text }, (res) => {
    if (res && res.ok) { chatInput.value = ''; return; }
    if (res && (res.error === 'mute' || res.error === 'ban')) {
      setChatBlock(res.error === 'ban' ? { reason: 'ban' } : { reason: 'mute', until: res.until });
    }
  });
});

setInterval(() => {
  refreshActiveActionTimer();
}, 1000);

// ============ Menu d'action ============

// Icone par action (dossier PNG)
const ACTION_ICONS = {
  reparation: '/assets/PNG/Ability21.png',
  remplir:    '/assets/PNG/Ability10.png',
  tir:        '/assets/PNG/Ability02.png',
  visee:      '/assets/PNG/Ability14.png',
  capacite:   '/assets/PNG/Ability14.png',
  minage:     '/assets/PNG/Ability24.png'
};

let actionMenuElementId = null;

function openActionMenu(elementId, anchor, keepPos) {
  if (baseDead) return; // base detruite : aucune action possible
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
  // Tourelle detruite : seule option = Reconstruire (meme mecanique que reparation).
  const stMenu = elementStates.get(elementId);
  const turretDead = (el.type === 'turret' || el.type === 'ship') && stMenu && stMenu.dead;
  const actionsToShow = turretDead
    ? [{ id: 'reparation', label: el.type === 'ship' ? 'Réparer' : 'Reconstruire', category: 'DEFENSIF', icon: '/assets/PNG/Ability25.png', effect: '+1 PV toutes les 10 s' }]
    : el.actions;
  for (const a of actionsToShow) {
    const isActive = activeAction && activeAction.element_id === elementId && activeAction.action_id === a.id;
    const btn = document.createElement('button');
    btn.className = 'act-block ' + a.category;
    const icon = a.icon || ACTION_ICONS[a.id];
    const catIco = `<svg class="act-cat"><use href="#ic-${a.category.toLowerCase()}"/></svg>`;
    // Effet dynamique : +X = contribution TOTALE en cours (somme des niveaux des acteurs actifs).
    // Si personne n'agit encore, on montre ce que TOI tu ajouterais (ton niveau dans la categorie).
    const total = actionContributions[elementId + '|' + a.id] || 0;
    const own = (levels && levels[a.category]) ? levels[a.category] : 1;
    const lvl = total > 0 ? total : own;
    const rest = (a.effect || '').replace(/^\+\s*\d+\s*/, '');
    const sub = `<span class="act-sub"><b class="act-amt">+${lvl}</b> (<svg class="act-cat-inline"><use href="#ic-${a.category.toLowerCase()}"/></svg>)${rest ? ' ' + escapeHtml(rest) : ''}</span>`;
    btn.innerHTML = `${catIco}${icon ? `<img class="act-ico" src="${icon}" alt="">` : ''}<span class="act-lbl">${escapeHtml(a.label)}</span>${sub}`;
    if (isActive) btn.classList.add('active');
    // Ressource requise indisponible -> action non-cliquable (reparation=matériaux, remplir=radius).
    const needRes = a.id === 'reparation' ? 'materiaux' : a.id === 'remplir' ? 'radius' : null;
    const blocked = needRes && (factionResources[needRes] || 0) <= 0;
    if (blocked) btn.classList.add('disabled');
    btn.addEventListener('click', () => {
      if (blocked) {
        actionMenuNote.textContent = `Pas assez de ${needRes === 'materiaux' ? 'matériaux' : 'radius'}.`;
        actionMenuNote.style.color = '#ff6b6b'; actionMenuNote.classList.remove('hidden');
        return;
      }
      activateAction(elementId, a.id);
    });
    actionMenuActions.appendChild(btn);
  }
  // Liste des joueurs actifs sur CET element (qui fait quoi, a quel niveau).
  const playersEl = document.getElementById('actionMenuPlayers');
  if (playersEl) {
    const here = (lastActiveList || []).filter(a => a.element_id === elementId);
    if (here.length) {
      const labelOf = (aid) => { const def = el.actions.find(x => x.id === aid); return def ? def.label : aid; };
      playersEl.innerHTML = `<div class="pl-title">Joueurs actifs (${here.length})</div>` + here.map(a =>
        `<div class="pl-row ${a.category}"><span class="pl-name">${escapeHtml(a.username || '?')}</span>` +
        `<span class="pl-act">${escapeHtml(labelOf(a.action_id))} · Niv.${a.level || 1}</span></div>`).join('');
      playersEl.classList.remove('hidden');
    } else {
      playersEl.classList.add('hidden');
    }
  }
  actionMenuNote.style.color = ''; // reset (peut avoir ete passe en rouge par un echec)
  if (activeAction && activeAction.element_id !== elementId) {
    actionMenuNote.textContent = `Tu vas remplacer ton action en cours.`;
    actionMenuNote.classList.remove('hidden');
  } else {
    actionMenuNote.classList.add('hidden');
  }

  // Positionnement: près du point cliqué, en restant dans le viewport
  actionMenu.classList.remove('hidden');
  if (keepPos) return; // rafraichi sur place : on ne bouge pas le menu (on garde la selection)
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

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeActionMenu(); });

document.addEventListener('mousedown', (e) => {
  if (actionMenu.classList.contains('hidden')) return;
  if (!actionMenu.contains(e.target)) closeActionMenu();
}, true);

function activateAction(elementId, actionId) {
  if (!socket || !authenticated) return;
  socket.emit('action:activate', { elementId, actionId }, (resp) => {
    if (resp?.ok) {
      if (window.SFX) SFX.play(game.scene.getScene('main'), 'action-select');
      // On NE ferme PAS le menu : l'element reste selectionne (cercle de portee visible)
      // pour voir la portee evoluer. On rafraichit sur place (surbrillance de l'action active).
      openActionMenu(elementId, null, true);
    } else {
      // Feedback visible (ex. "amiral hors-ligne") au lieu d'un echec silencieux.
      const msg = resp?.error === 'amiral hors-ligne'
        ? "L'Amiral est hors-ligne — impossible d'agir pour le moment."
        : (resp?.error || "Action impossible.");
      if (actionMenuNote) {
        actionMenuNote.textContent = msg;
        actionMenuNote.style.color = '#ff8a8a';
        actionMenuNote.classList.remove('hidden');
      }
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
  // Pre-remplit le dernier pseudo connu (cache local) — sans autocomplete navigateur.
  const lastName = localStorage.getItem('voidfaction:username') || '';
  const lp = document.getElementById('loginPseudo');
  if (lp && lastName) lp.value = lastName;
  setTimeout(() => {
    const visible = signupForm.classList.contains('hidden') ? loginForm : signupForm;
    // Focus le mot de passe si le pseudo est deja pre-rempli (login), sinon le 1er champ.
    const target = (visible === loginForm && lp && lp.value)
      ? loginForm.querySelector('input[type="password"]')
      : visible.querySelector('input');
    target?.focus();
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
  submitAuth('/api/login', { username: fd.get('pseudo'), password: fd.get('password') });
});
signupForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const fd = new FormData(signupForm);
  submitAuth('/api/signup', {
    username: fd.get('pseudo'),
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
      window.gameBuildTime = data.buildTime; // date/heure de derniere maj affichee sous l'horloge
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
    if (data.levels) levels = data.levels;
    if (data.xp) xp = data.xp;
    if (data.levelXp && typeof data.levelXp === 'object') levelXp = data.levelXp;
    if (data.contributions) actionContributions = data.contributions;
    renderLevels();
    baseDead = !!data.baseDead;
    document.getElementById('baseDeadOverlay')?.classList.toggle('hidden', !baseDead);
    actionDurationMs = data.actionDurationMs || ACTION_MAX_DURATION_MS_DEFAULT;
    history = Array.isArray(data.history) ? data.history : [];
    journal = Array.isArray(data.journal) ? data.journal : [];
    chat = Array.isArray(data.chat) ? data.chat : [];
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
    renderJournal();
    renderChat();
    setChatBlock(data.chatBlocked || null);
    amiralDisplayName = data.watchedAmiral?.username || data.amiral?.username || 'AMIRAL';
    amiralIsOnline = data.watchedAmiral?.online !== false;
    if (data.ship) latestShipState = data.ship; // memorise pour l'appliquer au (re)demarrage de la scene
    // Vague en cours memorisee : appliquee ici si la scene est prete, sinon dans create().
    pendingWave = data.currentWave || null;
    const scene = game.scene.getScene('main');
    if (scene && scene.scene.isActive()) {
      if (scene.shipLabel) scene.shipLabel.setText(amiralDisplayName);
      scene.setShipState(data.ship);
      if (scene.ship) scene.ship.setAlpha(amiralIsOnline ? 1 : 0.45);
      if (scene.shipLabel) scene.shipLabel.setAlpha(amiralIsOnline ? 1 : 0.45);
      // Par defaut, le viewer se cale sur la DERNIERE case du streameur (sa position courante).
      if (data.ship) { SharedScene.tpCameraTo(scene, data.ship.x, data.ship.y, false); scene._cameraInitFromShip = true; }
      scene.setupElements(serverElements);
      scene.applyAllElementStates();
      scene.drawBasePerimeter();
      if (pendingWave) { scene.handleWaveIncoming(pendingWave); pendingWave = null; }
    }
    if (data.currentWave) triggerCaptainForWave(data.currentWave);
  });

  socket.on('resource', (data) => { if (resourceEl) resourceEl.textContent = data.resource; });

  socket.on('ship', (data) => {
    latestShipState = data;
    const scene = game.scene.getScene('main');
    if (scene && scene.scene.isActive()) scene.setShipState(data);
  });

  // ===== Combat serveur-autoritaire : le viewer ne fait qu'afficher =====
  socket.on('combat:enemies', (list) => {
    const scene = game.scene.getScene('main');
    if (scene && scene.scene.isActive()) SharedScene.reconcileEnemies(scene, list, (e) => scene.createEnemySprite(e));
  });
  socket.on('combat:tracer', (t) => {
    const scene = game.scene.getScene('main');
    if (!scene || !scene.scene.isActive() || !t) return;
    SharedScene.drawTracer(scene, t.from, t.to, t.kind);
    if (window.SFX) SFX.play(scene, t.kind === 'enemy' ? 'shot-enemy' : t.kind === 'ship' ? 'shot-ship' : 'shot-turret', t.from.x, t.from.y);
    if (t.kind === 'turret' && t.turretId && scene.elementSprites) {
      const sp = scene.elementSprites.get(t.turretId);
      const st = elementStates.get(t.turretId);
      if (sp && st && typeof scene.playTurretShoot === 'function') scene.playTurretShoot(sp, turretGunLevel(st.puissance));
    }
  });
  socket.on('combat:enemy_down', (d) => {
    const scene = game.scene.getScene('main');
    if (scene && scene.scene.isActive() && d) SharedScene.removeEnemySprite(scene, d.id, true);
  });
  socket.on('wave:repelled', () => {
    const scene = game.scene.getScene('main');
    if (scene && scene.scene.isActive()) { SharedScene.clearAllEnemies(scene); if (typeof scene.hideWaveWarnIcon === 'function') scene.hideWaveWarnIcon(); }
    try { showVictory(); } catch (e) {}
  });
  // Retrospective : le serveur nous demande une capture du canvas (cadence ~12 min).
  socket.on('snapshot:capture', () => captureSnapshot());

  // Mise a jour des niveaux (gain d'XP a une vague)
  socket.on('levels', (data) => {
    if (data && data.levels) {
      const before = { ...levels };
      levels = data.levels;
      if (data.xp) xp = data.xp;
      renderLevels();
      // Petit feedback : montre quel niveau a augmente.
      for (const cat of ['PUISSANCE', 'DEFENSIF', 'UTILITAIRE']) {
        if ((levels[cat] || 1) > (before[cat] || 1)) showLevelUpToast(cat, levels[cat]);
      }
    }
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
      // "+N" toutes les 10s sur l'élément : seulement pour UTILITAIRE (minage/remplir).
      // DEFENSIF -> gain de PV total diffuse par le serveur ('element:plus'). PUISSANCE (attaque)
      // -> rien (la puissance est dynamique, un "+1" par tick n'aurait pas de sens).
      const cat = activeAction?.category;
      if (cat === 'UTILITAIRE' && deltas[cat] > 0) {
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
    if (data.contributions) actionContributions = data.contributions;
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
    // Panneau d'action ouvert : rafraichit les stats (HP, essence...) en direct, sans re-clic.
    if (actionMenuElementId && !actionMenu.classList.contains('hidden')) openActionMenu(actionMenuElementId, null, true);
  });

  // Gain de PV total "+N" sur un element (reparation, somme des contributeurs).
  socket.on('element:plus', (d) => {
    if (!d || !d.id || !d.n) return;
    const scene = game.scene.getScene('main');
    if (scene && scene.scene.isActive()) SharedScene.flashElementPlus(scene, d.id, d.n, d.category || 'DEFENSIF');
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
      if (window.SFX) SFX.play(scene, data.subtype === 'radius' ? 'asteroid-rad-depleted' : 'asteroid-mat-depleted');
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
    if (scene && scene.scene.isActive()) { SharedScene.clearAllEnemies(scene); scene.hideWaveWarnIcon?.(); scene.applyAllElementStates(); }
    baseDead = false;
    document.getElementById('baseDeadOverlay')?.classList.add('hidden');
  });
  socket.on('base:destroyed', () => {
    baseDead = true;
    closeActionMenu();
    const scene = game.scene.getScene('main');
    if (scene && scene.scene.isActive() && typeof scene.playBaseExplosion === 'function') {
      scene.playBaseExplosion();
      // Ecran de fin apres un petit delai (le temps que l'explosion joue).
      setTimeout(() => { if (baseDead) document.getElementById('baseDeadOverlay')?.classList.remove('hidden'); }, 1200);
    } else {
      document.getElementById('baseDeadOverlay')?.classList.remove('hidden');
    }
  });

  socket.on('history:new', (entry) => {
    if (!entry) return;
    history.unshift(entry);
    if (history.length > 10) history.pop();
    renderHistory(entry.at);
  });

  socket.on('journal:new', (entry) => addJournalEntry(entry));
  socket.on('chat:new', (m) => addChatMessage(m));
  socket.on('chat:moderated', (d) => {
    if (!d) return;
    if (d.action === 'unban') setChatBlock(null);
    else if (d.action === 'ban') setChatBlock({ reason: 'ban' });
    else if (d.action === 'mute1h') setChatBlock({ reason: 'mute', until: d.until });
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
    this.load.on('progress', setLoaderProgress);
    if (window.SFX) SFX.preload(this);
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
    // Assets UI in-world : barre de vie, icone de repop, fleche d'amelioration tourelle
    this.load.image('healthbar', '/assets/PNG/HealthBar.png');
    this.load.image('healthbar-line', '/assets/PNG/HealthBar_Line.png');
    this.load.image('time-icon', '/assets/PNG/TimeIcon.png');
    this.load.image('upgrade-arrow', '/assets/PNG/User%20interfaces/Shopping%20popup/upgrade%20arrow.png');
    this.load.image('enemy-hp-bg', '/assets/PNG/User%20interfaces/enemy%20hp%20bar/enemy%20hp%20bar%20bg.png');
    this.load.image('enemy-hp-fg', '/assets/PNG/User%20interfaces/enemy%20hp%20bar/enemy%20hp%20bar%20fg.png');
    // Explosion de la base (Explosion_3, 8 frames)
    for (let i = 1; i <= 8; i++) {
      this.load.image(`base-ex-${i}`, `/assets/PNG/Ship_Effects/Explosion/Explosion_3_${String(i).padStart(3, '0')}.png`);
    }
    // Icones d'actions (overlay in-world) + fond de badge compteur
    this.load.image('act-tir', '/assets/PNG/Ability02.png');
    this.load.image('act-visee', '/assets/PNG/Ability14.png');
    this.load.image('act-reparation', '/assets/PNG/Ability21.png');
    this.load.image('act-remplir', '/assets/PNG/Ability10.png');
    this.load.image('act-minage', '/assets/PNG/Ability24.png');
    this.load.image('bg-hud-icon', '/assets/PNG/Bg_Hud-Icon.png');
    // Explosion de tourelle (spritesheet 9 frames de 140x140) + icone alarme essence
    this.load.spritesheet('turret-explosion', '/assets/Explosions/PNG/explosion.png', { frameWidth: 140, frameHeight: 140 });
    this.load.image('turret-alarm', '/assets/HUD/PNG/points_powerup_lifes_05_life_indicator_alarm.png');
    this.load.image('turret-life', '/assets/HUD/PNG/points_powerup_lifes_05_life_indicator.png');
    // Projectiles : vaisseau (small1), tourelles (big1), ennemis (short6)
    this.load.image('bullet-ship', '/assets/Weapons/PNG/bullet_blaster_small1.png');
    this.load.image('bullet-turret', '/assets/Weapons/PNG/bullet_blaster_big1.png');
    this.load.image('bullet-enemy', '/assets/Weapons/PNG/bullet_short6.png');
  }

  create() {
    this.cameras.main.setBackgroundColor('#04060a');
    // Systeme de "cases" : le viewer voit une case a la fois (une case entiere tient a
    // l'ecran a userZoomFactor=1). La camera ne suit PAS automatiquement le vaisseau ;
    // le viewer se deplace librement et utilise la minimap pour rejoindre le streameur.
    this._userZoomFactor = 0.5; // demarre dezoome (vue ~2x plus large que la case)
    this.applyFitZoom();
    SharedScene.updateCaseCamera(this, this.ship ? this.ship.x : BASE_X, this.ship ? this.ship.y : BASE_Y);
    this._cameraInitFromShip = false; // recadre une 1re fois sur le vaisseau des reception de sa position
    // (Minimap retiree : le monde tient sur un seul ecran, plus de navigation multi-cases.)
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

    // Vaisseau Amiral (position connue restauree des l'init, sinon defaut pres de la base)
    const _shipStart = latestShipState || { x: WORLD_W / 2, y: WORLD_H / 2 + 230, rotation: 0 };
    this.ship = this.add.sprite(_shipStart.x, _shipStart.y, 'ship-fr-000')
      .setScale(SHIP_SCALE)
      .setOrigin(0.5, 0.36)
      .setDepth(7); // au-dessus des assets (base/tourelles/asteroides en depth 0)
    if (typeof _shipStart.rotation === 'number') this.ship.rotation = _shipStart.rotation;
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
    // Si on connait deja la position du vaisseau, on cadre la vue dessus au demarrage.
    if (latestShipState) {
      SharedScene.tpCameraTo(this, this.ship.x, this.ship.y, false);
      this._cameraInitFromShip = true;
    }

    // Cercle de "grande base" (rayon visuel autour du centre)
    this.drawBasePerimeter();

    // Ennemis affiches (etat simule cote serveur, recu via 'combat:enemies')
    this.enemyById = new Map();
    this.waveWarnIcon = null;

    // Zoom molette (vers le curseur), borne a la case courante.
    this.input.on('wheel', (pointer, _gos, _dx, deltaY) => {
      this._userZoomFactor = Phaser.Math.Clamp(this._userZoomFactor - deltaY * 0.0006, ZOOM_FACTOR_MIN, ZOOM_FACTOR_MAX);
      SharedScene.zoomView(this, pointer, () => this.applyFitZoom());
    });
    // Double-clic sur un element -> zoom + centrage dessus.
    this.input.on('pointerdown', (pointer) => {
      const now = this.time.now;
      if (this._lastClickAt && now - this._lastClickAt < 350 &&
          Math.hypot(pointer.x - this._lastClickX, pointer.y - this._lastClickY) < 24) {
        const el = this.findElementAt(pointer.worldX, pointer.worldY);
        if (el) this.zoomOnElement(el);
        this._lastClickAt = 0;
      } else {
        this._lastClickAt = now; this._lastClickX = pointer.x; this._lastClickY = pointer.y;
      }
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
        // Deplacement borne a la case (centre suivi, pas de manip directe du scroll).
        SharedScene.panView(this, dx, dy);
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
    // Vague deja en cours a la connexion : on l'affiche maintenant que la scene est prete.
    if (pendingWave) { this.handleWaveIncoming(pendingWave); triggerCaptainForWave(pendingWave); pendingWave = null; }
    // Scene prete -> on retire l'ecran de chargement.
    hideLoader();
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
      // Sync flamme de reacteur a l'arriere du vaisseau (masquee a l'arret)
      const moving = this.time.now < (this._shipMovingUntil || 0);
      if (this.shipFlame) {
        const rearAngle = this.ship.rotation + Math.PI / 2;
        const offset = 18;
        this.shipFlame.x = this.ship.x + Math.cos(rearAngle) * offset;
        this.shipFlame.y = this.ship.y + Math.sin(rearAngle) * offset;
        this.shipFlame.rotation = rearAngle - Math.PI / 2;
        this.shipFlame.setVisible(moving);
      }
      // Le sprite du vaisseau EST l'animation d'echappement : a l'arret, corps statique sans flamme.
      if (moving) {
        if (this.ship.anims && !this.ship.anims.isPlaying) this.ship.play('ship-thrust');
      } else if (this.ship.anims && this.ship.anims.isPlaying) {
        this.ship.stop(); this.ship.setTexture('ship');
      }
    }
    SharedScene.lerpEnemies(this); // interpolation des ennemis pousses par le serveur
    this.updateTurretAim(delta);   // les tourelles suivent l'ennemi vise
    SharedScene.spinBase(this, delta); // la base tourne lentement (s'arrete sans essence)
    SharedScene.updateWaveEdgeIndicator(this); // "!" de provenance de la vague colle au bord
    if (window.SFX) SFX.updateAmbience(this, this.enemyById ? this.enemyById.size : 0);
    // Le viewer suit la case du streameur, toujours centree (comme le streameur sur la sienne).
    if (this.ship) SharedScene.updateCaseCamera(this, this.ship.x, this.ship.y);
    if (this._minimap) SharedScene.drawMinimap(this._minimap, this, this.ship ? this.ship.x : null, this.ship ? this.ship.y : null);
    SharedScene.positionActionOverlay(this); // suit le vaisseau (labels + halo)
    SharedScene.updateStatsPanel(); // barre d'essence + materiaux/radius
  }

  // Cibles hostiles qu'un ennemi peut engager : asteroides vivants, tourelles, vaisseau du joueur.
  // Le combat (ennemis, tourelles, balles) est simule cote serveur. Le viewer ne fait
  // qu'afficher : reconciliation via SharedScene.reconcileEnemies + tracers (combat:tracer).

  showRangeCircle(turretId) {
    this.rangeCircleId = turretId;
    this._lastRangePx = null;
    this._drawRangeCircle();
  }

  // Dessine/met a jour le cercle de portee de la tourelle suivie. Appele aussi a chaque
  // maj d'etat (applyAllElementStates) -> le cercle GRANDIT en direct quand la portee monte.
  _drawRangeCircle() {
    const id = this.rangeCircleId;
    if (!id) return;
    const state = elementStates.get(id);
    const sprite = this.elementSprites.get(id);
    if (!state || !sprite) { this.hideRangeCircle(); return; }
    const range = turretRangePx(state);

    if (!this.rangeCircleGfx) this.rangeCircleGfx = this.add.graphics().setDepth(-30);
    const g = this.rangeCircleGfx;
    g.clear();
    g.fillStyle(0xff4f6d, 0.08); g.fillCircle(sprite.x, sprite.y, range);
    g.lineStyle(2, 0xff4f6d, 0.65); g.strokeCircle(sprite.x, sprite.y, range);
    g.lineStyle(2, 0xff4f6d, 0.8);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      g.beginPath();
      g.moveTo(sprite.x + Math.cos(a) * (range - 8), sprite.y + Math.sin(a) * (range - 8));
      g.lineTo(sprite.x + Math.cos(a) * (range + 8), sprite.y + Math.sin(a) * (range + 8));
      g.strokePath();
    }
    // Label de portee, en haut du cercle.
    if (!this.rangeCircleLabel) {
      this.rangeCircleLabel = this.add.text(0, 0, '', {
        fontFamily: 'Consolas, monospace', fontSize: '14px', fontStyle: 'bold',
        color: '#ffb3c0', stroke: '#3a0a12', strokeThickness: 4
      }).setOrigin(0.5).setDepth(-29);
    }
    this.rangeCircleLabel.setText(`PORTÉE ${state.range || 0}`);
    this.rangeCircleLabel.setPosition(sprite.x, sprite.y - range - 14);

    // Pulse quand la portee vient d'augmenter (rendre l'evolution bien visible).
    if (this._lastRangePx != null && range > this._lastRangePx + 0.5) {
      this.rangeCircleLabel.setScale(1.4);
      this.tweens.add({ targets: this.rangeCircleLabel, scale: 1, duration: 350, ease: 'Back.easeOut' });
      const ring = this.add.graphics().setDepth(-30);
      ring.lineStyle(3, 0xff8aa0, 0.9); ring.strokeCircle(sprite.x, sprite.y, range);
      this.tweens.add({ targets: ring, alpha: 0, duration: 450, ease: 'Quad.easeOut', onComplete: () => ring.destroy() });
    }
    this._lastRangePx = range;
  }

  hideRangeCircle() {
    this.rangeCircleId = null;
    this._lastRangePx = null;
    if (this.rangeCircleGfx) { this.rangeCircleGfx.destroy(); this.rangeCircleGfx = null; }
    if (this.rangeCircleLabel) { this.rangeCircleLabel.destroy(); this.rangeCircleLabel = null; }
  }

  applyFitZoom() {
    const cam = this.cameras.main;
    // "Fit" : la case entiere est TOUJOURS visible (rien n'est rogne, asteroides compris).
    // Le zoom s'ajuste a l'ecran ; l'espace en plus (ecran non 16:9) montre la nebuleuse.
    const fit = Math.min(cam.width / WORLD_W, cam.height / WORLD_H);
    cam.setZoom(fit * (this._userZoomFactor || 1));
  }

  // Element (tourelle/base/asteroide/vaisseau) sous un point monde, ou null.
  findElementAt(wx, wy) {
    let best = null, bestD = Infinity;
    if (this.elementSprites) {
      for (const sp of this.elementSprites.values()) {
        if (!sp.visible) continue;
        const r = Math.max(sp.displayWidth, sp.displayHeight) * 0.6 || 40;
        const d = Phaser.Math.Distance.Between(wx, wy, sp.x, sp.y);
        if (d < r && d < bestD) { best = sp; bestD = d; }
      }
    }
    if (this.ship && this.ship.active) {
      const r = Math.max(this.ship.displayWidth, this.ship.displayHeight) * 0.7 || 40;
      const d = Phaser.Math.Distance.Between(wx, wy, this.ship.x, this.ship.y);
      if (d < r && d < bestD) best = this.ship;
    }
    return best;
  }
  // Zoom + centrage sur un element (double-clic).
  zoomOnElement(sprite) {
    if (!sprite) return;
    if (this._panState) this._panState.pendingMenu = null; // pas de menu sur un double-clic
    this._userZoomFactor = Phaser.Math.Clamp((this._userZoomFactor || 1) + 0.7, ZOOM_FACTOR_MIN, ZOOM_FACTOR_MAX);
    this.applyFitZoom();
    SharedScene.centerViewOn(this, sprite.x, sprite.y);
  }

  onResize() {
    const w = this.scale.gameSize.width;
    const h = this.scale.gameSize.height;
    this.cameras.main.setSize(w, h);
    this.applyFitZoom();
    SharedScene.recenterCurrentCase(this);
    if (this.bgLayer01) this.bgLayer01.setPosition(w / 2, h / 2);
    if (this._bgDim) this._bgDim.setPosition(w / 2, h / 2);
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
        this.anims.create({ key, frames: mkFrames(`gun-${k}-shoot-`, 10, 2), frameRate: 30, repeat: 0 });
      }
    }
    // Explosion de la base (Explosion_3, frames 1..8)
    if (!this.anims.exists('base-explode')) {
      this.anims.create({
        key: 'base-explode',
        frames: Array.from({ length: 8 }, (_, i) => ({ key: `base-ex-${i + 1}` })),
        frameRate: 18, repeat: 0
      });
    }
    // Explosion de tourelle (spritesheet explosion.png, 9 frames)
    if (this.textures.exists('turret-explosion') && !this.anims.exists('turret-explode')) {
      this.anims.create({
        key: 'turret-explode',
        frames: this.anims.generateFrameNumbers('turret-explosion', { start: 0, end: 8 }),
        frameRate: 20, repeat: 0
      });
    }
  }

  setupParallaxBackground() {
    const w = this.scale.gameSize.width;
    const h = this.scale.gameSize.height;
    // Calque 01 : fond principal, fixé à la caméra
    const bg01 = this.add.image(w / 2, h / 2, 'bg-01')
      .setOrigin(0.5).setScrollFactor(0).setDepth(-100);
    this.bgLayer01 = bg01;
    // Voile sombre semi-transparent : attenue la nebuleuse pour que les elements ressortent.
    this._bgDim = this.add.rectangle(w / 2, h / 2, 8000, 8000, 0x04060a, 0.4).setScrollFactor(0).setDepth(-99);
    // (Planète parallax retirée : elle faisait tache sur le fond.)
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
          // Tourelle desactivee (base hors tension) ou detruite -> pas de patrouille (figee).
          const stt = elementStates.get(el.id);
          if (!sprite.active || sprite._targetingEnemy || !SharedScene.isBasePowered() || (stt && stt.dead)) return;
          // Cible ramenee au PLUS COURT chemin depuis la rotation courante (sinon tour complet
          // quand baseRot depasse ±π — bug tourelle SO).
          const wanted = Phaser.Math.Angle.Wrap(baseRot + Math.random() * PATROL_AMP);
          const target = sprite.rotation + Phaser.Math.Angle.Wrap(wanted - sprite.rotation);
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
    return SharedScene.makeImageHpBar(this, x, y, width);
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
    // Apparence tourelles + etat "detruite" (dead) : explosion a la mort, reconstruction.
    for (const el of serverElements) {
      if (el.type !== 'turret') continue;
      const st = elementStates.get(el.id);
      const sp = this.elementSprites.get(el.id);
      if (st && sp) {
        if (st.dead && !sp._dead) this.enterTurretDead(el.id);
        else if (!st.dead && sp._dead) this.exitTurretDead(el.id);
        else if (st.dead && sp._dead) this.updateTurretDeadVisual(el.id, st);
      }
      if (sp && !sp._dead) this.updateTurretAppearance(el.id);
    }
    // Vaisseau hors service (0 PV) : grise jusqu'a reparation (50% PV).
    if (this.ship) {
      const ss = elementStates.get('ship-1');
      if (ss && ss.dead) { if (!this.ship._dead) { this.ship._dead = true; this.ship.setTint(0x556070); } }
      else if (this.ship._dead) { this.ship._dead = false; this.ship.clearTint(); this.ship.setAlpha(amiralIsOnline ? 1 : 0.45); }
    }
    // Cercle de portee affiche : on le redessine pour suivre l'evolution en direct.
    if (this.rangeCircleId) this._drawRangeCircle();
  }

  // Tourelle detruite : explosion, plus d'asset (tourelle masquee) ; un coeur d'alarme
  // rouge prend sa place et permet d'activer la reconstruction. Des qu'on regagne des HP,
  // la tourelle reapparait DESACTIVEE (grisee) et garde son coeur jusqu'a 50% HP.
  enterTurretDead(id) {
    const sprite = this.elementSprites.get(id);
    if (!sprite || sprite._dead) return;
    sprite._dead = true;
    const bar = this.elementHpBars && this.elementHpBars.get(id);
    if (bar) bar.setVisible(false);
    if (sprite._patrolTween) sprite._patrolTween.stop();
    if (sprite.anims && sprite.anims.isPlaying) sprite.anims.stop();
    if (this.anims.exists('turret-explode')) {
      const ex = this.add.sprite(sprite.x, sprite.y, 'turret-explosion', 0).setDepth(12).setScale(0.95);
      ex.play('turret-explode');
      ex.once('animationcomplete', () => ex.destroy());
    }
    sprite.setVisible(false); // plus d'asset
    this.showTurretHeart(id, sprite, 'turret-alarm');
  }
  // Tourelle morte : la tourelle reapparait grisee des qu'elle a des HP (< 50%).
  updateTurretDeadVisual(id, st) {
    const sprite = this.elementSprites.get(id);
    if (!sprite) return;
    if (st.hp > 0) { sprite.setVisible(true); sprite.setAlpha(0.4); sprite.clearTint(); sprite.setTint(0x666666); }
    else sprite.setVisible(false);
  }
  // Coeur d'alarme/sante a la place de la tourelle ; cliquable -> menu (Reconstruire).
  showTurretHeart(id, sprite, texKey) {
    if (sprite._heart) { sprite._heart.destroy(); sprite._heart = null; }
    if (!this.textures.exists(texKey)) return;
    const target = Math.max(sprite.displayWidth, sprite.displayHeight) * 0.6 || 36;
    const ico = this.add.image(sprite.x, sprite.y, texKey).setDepth(13);
    const base = target / (ico.width || target);
    ico.setScale(base); ico._baseScale = base;
    ico.setInteractive({ useHandCursor: true });
    ico.on('pointerdown', (pointer) => {
      if (pointer.button !== 0) return;
      if (this._panState) this._panState.pendingMenu = { id, event: pointer.event };
    });
    ico._pulse = this.tweens.add({ targets: ico, scaleX: { from: base, to: base * 1.25 }, scaleY: { from: base, to: base * 1.25 },
      yoyo: true, repeat: -1, duration: 600, ease: 'Sine.easeInOut' });
    sprite._heart = ico;
  }
  // 50% HP atteint : on bascule le coeur sur l'icone "sante", il disparait en fondu,
  // puis la tourelle est reactivee (apparence normale). Le log serveur signale la reactivation.
  exitTurretDead(id) {
    const sprite = this.elementSprites.get(id);
    if (!sprite) return;
    sprite._dead = false;
    if (window.SFX) SFX.play(this, 'turret-reactivate'); // tourelle reactivee (>= 50% HP)
    sprite.setVisible(true); sprite.setAlpha(1); sprite.clearTint();
    sprite._gunLevel = null; sprite._currentAnim = null;
    const bar = this.elementHpBars && this.elementHpBars.get(id);
    if (bar) bar.setVisible(true);
    this.updateTurretAppearance(id);
    const heart = sprite._heart; sprite._heart = null;
    if (heart) {
      if (heart._pulse) heart._pulse.stop();
      heart.disableInteractive();
      if (this.textures.exists('turret-life')) {
        heart.setTexture('turret-life');
        const t = Math.max(sprite.displayWidth, sprite.displayHeight) * 0.6 || 36;
        heart.setScale(t / (heart.width || t));
      }
      this.tweens.add({ targets: heart, alpha: 0, scaleX: heart.scaleX * 1.5, scaleY: heart.scaleY * 1.5,
        duration: 600, ease: 'Sine.easeOut', onComplete: () => heart.destroy() });
    }
  }

  // Oriente les tourelles : suivent l'ennemi le plus proche en portee (visuel), sinon patrouille.
  updateTurretAim(delta) {
    if (!this.elementSprites) return;
    const dt = (delta || 16) / 1000;
    const powered = SharedScene.isBasePowered();
    for (const el of serverElements) {
      if (el.type !== 'turret') continue;
      const sprite = this.elementSprites.get(el.id);
      const state = elementStates.get(el.id);
      if (!sprite || !state) continue;
      if (state.dead) { sprite._targetingEnemy = false; continue; }
      SharedScene.applyTurretPowerVisual(sprite, powered); // grise la tourelle hors tension (plus d'essence)
      if (!powered) { sprite._targetingEnemy = false; continue; }
      let best = null, bestD = turretRangePx(state);
      if (this.enemyById) {
        for (const e of this.enemyById.values()) {
          if (!e.active) continue;
          const d = Phaser.Math.Distance.Between(sprite.x, sprite.y, e.x, e.y);
          if (d < bestD) { best = e; bestD = d; }
        }
      }
      if (best) {
        if (!sprite._targetingEnemy && sprite._patrolTween) sprite._patrolTween.stop();
        sprite._targetingEnemy = true;
        const target = Phaser.Math.Angle.Between(sprite.x, sprite.y, best.x, best.y) + Math.PI / 2;
        sprite.rotation = Phaser.Math.Angle.RotateTo(sprite.rotation, target, 8 * dt);
      } else {
        sprite._targetingEnemy = false;
      }
    }
  }

  updateTurretAppearance(id) {
    const sprite = this.elementSprites.get(id);
    if (!sprite) return;
    const state = elementStates.get(id);
    if (!state) return;
    const level = turretGunLevel(state.puissance);
    // Montee de niveau (grace aux viewers) : fleche d'amelioration en fondu rapide.
    if (sprite._gunLevel == null) sprite._gunLevel = level;
    else if (level > sprite._gunLevel) { this.showTurretUpgrade(sprite); sprite._gunLevel = level; }
    else sprite._gunLevel = level;
    const k = String(level).padStart(2, '0');
    const idleKey = `gun-${k}-idle`;
    const shootKey = `gun-${k}-shoot`;
    // L'anim de tir est jouee UNE FOIS au moment du tir (playTurretShoot). Ici on n'interrompt
    // pas une anim de tir en cours ; sinon on reste sur l'idle du niveau courant.
    if (sprite.anims && sprite.anims.isPlaying && sprite._currentAnim === shootKey) return;
    if (sprite.texture && sprite.texture.key !== idleKey) sprite.setTexture(idleKey);
    sprite._currentAnim = null;
  }

  // Joue l'animation de tir UNE fois (au moment ou un projectile part).
  playTurretShoot(sprite, level) {
    const shootKey = `gun-${String(level).padStart(2, '0')}-shoot`;
    if (!this.anims.exists(shootKey)) return;
    sprite._currentAnim = shootKey;
    sprite.play(shootKey); // repeat:0 -> revient a l'idle via updateTurretAppearance
  }

  // Fleche d'amelioration (upgrade arrow) qui monte et s'efface rapidement au-dessus
  // d'une tourelle qui vient de gagner un niveau grace aux viewers.
  showTurretUpgrade(turretSprite) {
    if (!this.textures.exists('upgrade-arrow')) return;
    const arrow = this.add.image(turretSprite.x, turretSprite.y - 30, 'upgrade-arrow')
      .setDepth(12).setDisplaySize(26, 30).setAlpha(0);
    this.tweens.add({
      targets: arrow,
      y: turretSprite.y - 60,
      alpha: { from: 0, to: 1 },
      duration: 220,
      yoyo: true,
      hold: 120,
      ease: 'Sine.easeOut',
      onComplete: () => arrow.destroy()
    });
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
    // Son de vague : annonce (maintenant) + debut (a l'arrivee). Une seule fois par vague,
    // et seulement si on est avant le spawn (evite de rejouer sur reconnexion en plein combat).
    if (warningRemaining > 0 && this._soundWaveId !== wave.id) {
      this._soundWaveId = wave.id;
      playWaveSound(wave.type);
      this.time.delayedCall(warningRemaining, () => playWaveSound(wave.type));
    }
    // Indique la provenance des ennemis (les sprites sont ensuite pousses par le serveur).
    this.showWaveWarnIcon(wave);
  }

  // Provenance de la vague : "!" colle au bord de l'ecran (cf. SharedScene), independant du zoom.
  showWaveWarnIcon(wave) { SharedScene.setWaveOrigin(this, wave); }
  hideWaveWarnIcon() { SharedScene.clearWaveOrigin(this); }

  // Fabrique d'un sprite ennemi (l'etat/mouvement vient du serveur, via SharedScene.reconcileEnemies).
  createEnemySprite(e) {
    const level = 1;
    const boss = !!e.boss;
    const sprite = this.add.sprite(e.x, e.y, `enemy${level}-fr-000`)
      .setScale(ENEMY_SCALE * (boss ? 2.6 : 1))
      .setOrigin(0.5, 0.36)
      .setDepth(boss ? 9 : 8);
    sprite.play(`enemy${level}-thrust`);
    sprite._level = level;
    sprite._boss = boss;
    const barW = boss ? 64 : 40, barDy = boss ? -64 : -38;
    sprite._hpBarDy = barDy;
    sprite._hpBar = SharedScene.makeImageHpBar(this, sprite.x, sprite.y + barDy, barW,
      { fillTex: 'enemy-hp-fg', frameTex: 'enemy-hp-bg', tint: false, uniform: true, fillDy: -1 });
    sprite._hpBar.setDepth(boss ? 10 : 8);
    return sprite;
  }

  playEnemyExplosion(x, y, level) {
    if (window.SFX) SFX.play(this, 'explosion', x, y);
    const lvl = 1;
    const ex = this.add.sprite(x, y, `enemy${lvl}-ex-000`).setScale(ENEMY_SCALE * 2.2).setDepth(9);
    ex.play(`enemy${lvl}-explode`);
    ex.once('animationcomplete', () => ex.destroy());
  }

  // Explosion spectaculaire de la base : plusieurs bouffees etalees sur ~0.6s.
  playBaseExplosion() {
    if (!this.anims.exists('base-explode')) return;
    // Masque la barre de vie de la base pendant/apres l'explosion.
    if (this.elementHpBars) {
      for (const el of serverElements) {
        if (el.type === 'base') { const b = this.elementHpBars.get(el.id); if (b) b.setVisible(false); }
      }
    }
    const cx = BASE_X, cy = BASE_Y;
    const bursts = [
      { dx: 0, dy: 0, s: 0.42, d: 0 },
      { dx: -110, dy: -50, s: 0.22, d: 140 },
      { dx: 100, dy: 70, s: 0.26, d: 260 },
      { dx: 60, dy: -110, s: 0.20, d: 380 },
      { dx: -80, dy: 90, s: 0.24, d: 500 },
      { dx: 0, dy: 0, s: 0.52, d: 600 }
    ];
    for (const b of bursts) {
      this.time.delayedCall(b.d, () => {
        const ex = this.add.sprite(cx + b.dx, cy + b.dy, 'base-ex-1').setScale(b.s).setDepth(13);
        ex.play('base-explode');
        ex.once('animationcomplete', () => ex.destroy());
      });
    }
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
    // Plus de cercle autour des elements en cours d'action : l'icone + le compteur au-dessus
    // suffisent (et le halo "mon action" reste pour soi). On garde juste les anneaux eteints.
    if (this.elementHighlights) {
      for (const highlight of this.elementHighlights.values()) {
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
    // Etat de deplacement : flag autoritaire du streameur (sinon repli sur le delta de position).
    const moved = (typeof s.moving === 'boolean') ? s.moving : (Math.hypot(s.x - this.ship.x, s.y - this.ship.y) > 0.5);
    this.ship.x = s.x;
    this.ship.y = s.y;
    this.ship.rotation = s.rotation;
    this._shipMovingUntil = moved ? this.time.now + 250 : 0; // courte remanence ; coupe net a l'arret
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
