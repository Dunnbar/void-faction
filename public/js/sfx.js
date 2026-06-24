// ============================================================================
// SFX : sons de combat (tir / impact / explosion) + ambiance de bataille.
//
// Principe : on ne joue JAMAIS tout. Chaque son passe par :
//   1. mute global        2. throttle (par type)     3. cull distance / hors-ecran
//   4. bascule "dezoom" (on n'egrene plus les tirs -> ambiance + tirs aleatoires)
//   5. cap de voix simultanees   6. variation de pitch/volume
//
// >>> POUR ACTIVER LES SONS :
//     - depose tes fichiers dans  public/assets/sounds/fx/
//     - renseigne le champ `src` de chaque entree du MANIFEST ci-dessous.
//     - laisse src:'' pour garder un son DESACTIVE (aucune erreur, aucun 404).
//     Formats conseilles : .ogg ou .mp3 (court : tir ~100-300ms, impact ~150ms,
//     explosion ~400-700ms ; ambiance = boucle ~3-8s qui boucle proprement).
// ============================================================================
(function () {
  const MUTE_KEY = 'voidfaction:muted';
  function isMuted() {
    if (typeof window !== 'undefined' && window.gameSoundMuted) return true;
    try { return localStorage.getItem(MUTE_KEY) === '1'; } catch (e) { return false; }
  }

  // ===== Mix son : 3 canaux (musique / annonces / fx) + mute maitre, persistes =====
  // Les volumes 0-1 sont memorises en localStorage et partages entre la page joueur
  // et la page streameur (les deux chargent sfx.js).
  const VOL_KEYS    = { music: 'voidfaction:vol:music', announce: 'voidfaction:vol:announce', fx: 'voidfaction:vol:fx' };
  const DEFAULT_VOL = { music: 0.35, announce: 0.7, fx: 0.8 };
  function clamp01(v) { v = parseFloat(v); return isNaN(v) ? 0 : Math.max(0, Math.min(1, v)); }
  function getVol(ch) {
    try { const v = localStorage.getItem(VOL_KEYS[ch]); return v == null ? DEFAULT_VOL[ch] : clamp01(v); }
    catch (e) { return DEFAULT_VOL[ch]; }
  }
  function setVol(ch, v) {
    v = clamp01(v);
    try { localStorage.setItem(VOL_KEYS[ch], String(v)); } catch (e) {}
    if (ch === 'music') applyMusicVolume();
  }
  function setMuted(m) {
    m = !!m;
    try { localStorage.setItem(MUTE_KEY, m ? '1' : '0'); } catch (e) {}
    if (typeof window !== 'undefined') window.gameSoundMuted = m;
    applyMusicVolume();
  }

  // Musique/bruit de fond CONSTANT : "Hyper Vitesse", boucle demarree au 1er geste utilisateur.
  const MUSIC_SRC = '/assets/sounds/v2/ambiance-loop.wav';
  let musicEl = null;
  function ensureMusicEl() {
    if (musicEl || typeof Audio === 'undefined') return musicEl;
    try { musicEl = new Audio(MUSIC_SRC); musicEl.loop = true; musicEl.preload = 'auto'; musicEl.volume = isMuted() ? 0 : getVol('music'); } catch (e) {}
    return musicEl;
  }
  function applyMusicVolume() { if (musicEl) musicEl.volume = isMuted() ? 0 : getVol('music'); }
  function startMusic() {
    const el = ensureMusicEl();
    if (!el) return;
    applyMusicVolume();
    if (el.paused) el.play().catch(() => {}); // re-tente au prochain geste si refuse
  }

  // Echantillons de test (joues directement, hors moteur Phaser, pour marcher sur les 2 pages).
  const FX_TEST_SRC       = '/assets/sounds/v2/damage-1.wav';
  const ANNOUNCE_TEST_SRC = '/assets/sounds/vague_normale.mp3';
  function testChannel(ch) {
    if (isMuted()) return;
    if (ch === 'music') { startMusic(); return; }
    const src = ch === 'fx' ? FX_TEST_SRC : ANNOUNCE_TEST_SRC;
    try { const a = new Audio(src); a.volume = getVol(ch); a.play().catch(() => {}); } catch (e) {}
  }

  // Cable le menu de reglages son (memes IDs sur index.html et stream.html).
  function initSoundMenu() {
    if (typeof document === 'undefined') return;
    const btn  = document.getElementById('soundBtn');
    const menu = document.getElementById('soundMenu');
    const sliders = { music: document.getElementById('volMusic'), announce: document.getElementById('volAnnonce'), fx: document.getElementById('volFx') };
    const muteCb = document.getElementById('soundMute');
    function updateBtnIcon() {
      if (!btn) return;
      const m = isMuted();
      btn.classList.toggle('sound-off', m);
      btn.classList.toggle('sound-on', !m);
      btn.title = m ? 'Son coupé — ouvrir les réglages' : 'Réglages du son';
    }
    for (const ch of Object.keys(sliders)) {
      const s = sliders[ch];
      if (!s) continue;
      s.value = Math.round(getVol(ch) * 100);
      s.addEventListener('input', () => setVol(ch, s.value / 100));
    }
    if (muteCb) {
      muteCb.checked = isMuted();
      muteCb.addEventListener('change', () => { setMuted(muteCb.checked); updateBtnIcon(); });
    }
    if (menu) menu.querySelectorAll('.sm-test').forEach(b =>
      b.addEventListener('click', (e) => { e.stopPropagation(); testChannel(b.getAttribute('data-ch')); }));
    updateBtnIcon();
    if (btn && menu) {
      btn.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('hidden'); });
      document.addEventListener('mousedown', (e) => {
        if (menu.classList.contains('hidden')) return;
        if (!menu.contains(e.target) && e.target !== btn) menu.classList.add('hidden');
      }, true);
    }
    // Demarre la musique au tout 1er geste utilisateur (clic ou touche).
    const kick = () => { startMusic(); window.removeEventListener('pointerdown', kick); window.removeEventListener('keydown', kick); };
    window.addEventListener('pointerdown', kick);
    window.addEventListener('keydown', kick);
  }
  if (typeof document !== 'undefined') {
    if (document.readyState !== 'loading') initSoundMenu();
    else document.addEventListener('DOMContentLoaded', initSoundMenu);
  }

  // Reglages par son. src:'' => desactive tant que tu n'as pas choisi le fichier.
  // volume 0-1 | throttleMs : delai mini entre 2 lectures du meme son
  // maxVoices : nb max d'instances simultanees | pitch : variation aleatoire (+/-)
  // src peut etre une chaine OU un tableau (variation : un echantillon tire au hasard).
  const FX = '/assets/sounds/fx/';
  // Sons de degats (impacts) : 10 echantillons tires au hasard a chaque tir qui touche.
  const DAMAGE_HITS = Array.from({ length: 10 }, (_, i) => `/assets/sounds/v2/damage-${i + 1}.wav`);
  const MANIFEST = {
    'shot-ship':   { src: '', volume: 0.50, throttleMs: 55,  maxVoices: 4, pitch: 0.07 }, // tirs coupes
    'shot-turret': { src: '', volume: 0.45, throttleMs: 70,  maxVoices: 4, pitch: 0.08 }, // coupe
    'shot-enemy':  { src: '', volume: 0.40, throttleMs: 80,  maxVoices: 4, pitch: 0.09 }, // coupe
    'impact':      { src: DAMAGE_HITS, volume: 0.55, throttleMs: 45, maxVoices: 6, pitch: 0.12 }, // degats (10 sons aleatoires)
    'explosion':   { src: '', volume: 0.70, throttleMs: 120, maxVoices: 3, pitch: 0.10 }, // pas encore choisi
    'ambience':    { src: '', volume: 0.60, loop: true },   // (ancienne boucle de bataille : coupee)
    // Evenements ponctuels (joues NON-spatiaux -> toujours audibles).
    'turret-reactivate':     { src: FX + 'turret_reactivate.wav',     volume: 0.6,  throttleMs: 200, maxVoices: 2, pitch: 0.05 },
    'action-select':         { src: FX + 'action_select.wav',         volume: 0.5,  throttleMs: 90,  maxVoices: 2, pitch: 0.05 },
    'asteroid-mat-depleted': { src: FX + 'asteroid_mat_depleted.wav', volume: 0.55, throttleMs: 200, maxVoices: 2, pitch: 0.05 },
    'asteroid-rad-depleted': { src: FX + 'asteroid_rad_depleted.wav', volume: 0.55, throttleMs: 200, maxVoices: 2, pitch: 0.05 },
  };

  // En-dessous de ce zoom camera, on est "dezoome" : on n'egrene plus chaque tir,
  // on bascule sur l'ambiance + quelques tirs aleatoires. (a ajuster selon le rendu)
  const ZOOM_OUT_THRESHOLD   = 0.6;
  const FAR_SHOT_PROBABILITY = 0.18; // proba de laisser passer un tir individuel en dezoom

  const lastPlayAt = {};   // throttle par cle
  const activeCount = {};  // voix actives par cle

  // Cle(s) Phaser pour un son : une seule, ou key__0/1/... si plusieurs echantillons.
  function variantKeys(key, cfg) {
    const arr = Array.isArray(cfg.src) ? cfg.src : [cfg.src];
    return arr.length > 1 ? arr.map((_, i) => `${key}__${i}`) : [key];
  }
  // Tire au hasard une variante CHARGEE (ou null si aucune).
  function pickLoadedKey(scene, key, cfg) {
    if (!scene.cache || !scene.cache.audio) return null;
    const avail = variantKeys(key, cfg).filter(k => scene.cache.audio.exists(k));
    return avail.length ? avail[Math.floor(Math.random() * avail.length)] : null;
  }

  // A appeler dans le preload() de chaque scene.
  function preload(scene) {
    if (!scene || !scene.load) return;
    for (const [key, cfg] of Object.entries(MANIFEST)) {
      if (!cfg.src) continue;                 // pas de fichier -> on saute (aucun 404)
      const arr = Array.isArray(cfg.src) ? cfg.src : [cfg.src];
      const keys = variantKeys(key, cfg);
      arr.forEach((src, i) => { if (src) { try { scene.load.audio(keys[i], src); } catch (e) {} } });
    }
    scene.load.on('loaderror', () => {});      // un fichier manquant ne bloque pas le chargement
  }

  // Joue un SFX a la position monde (x,y). Omets x,y pour un son non-spatial.
  function play(scene, key, x, y) {
    if (isMuted()) return;
    const cfg = MANIFEST[key];
    if (!cfg || !cfg.src) return;
    const playKey = pickLoadedKey(scene, key, cfg);
    if (!playKey) return;
    const now = (scene.time && scene.time.now) || (typeof performance !== 'undefined' ? performance.now() : 0);

    // 1) throttle par type
    if (lastPlayAt[key] && now - lastPlayAt[key] < cfg.throttleMs) return;

    // 2) cull hors-ecran + 3) bascule dezoom
    let vol = cfg.volume * getVol('fx'); // canal FX (reglage utilisateur)
    const cam = scene.cameras && scene.cameras.main;
    if (cam && typeof x === 'number' && cam.worldView) {
      const v = cam.worldView, m = 80;
      if (x < v.x - m || x > v.right + m || y < v.y - m || y > v.bottom + m) return; // hors champ
      if (cam.zoom < ZOOM_OUT_THRESHOLD && key.indexOf('shot') === 0) {
        if (Math.random() > FAR_SHOT_PROBABILITY) return; // on ne garde que quelques tirs
        vol *= 0.6;
      }
    }

    // 4) cap de voix simultanees
    if ((activeCount[key] || 0) >= (cfg.maxVoices || 4)) return;

    // 5) lecture avec variation (echantillon + pitch + volume)
    try {
      const rate = 1 + (Math.random() * 2 - 1) * (cfg.pitch || 0);
      const snd = scene.sound.add(playKey, { volume: vol * (0.9 + Math.random() * 0.2), rate });
      activeCount[key] = (activeCount[key] || 0) + 1;
      const done = () => { activeCount[key] = Math.max(0, (activeCount[key] || 1) - 1); try { snd.destroy(); } catch (e) {} };
      snd.once('complete', done);
      snd.once('stop', done);
      snd.play();
      lastPlayAt[key] = now;
    } catch (e) {}
  }

  // Ambiance de bataille : nappe sonore qui monte avec le DEZOOM et l'ACTIVITE.
  // activity = nb de combattants/projectiles actifs (0 = calme -> silence).
  let ambienceSnd = null;
  function updateAmbience(scene, activity) {
    const cfg = MANIFEST['ambience'];
    if (!cfg || !cfg.src || !loaded(scene, 'ambience')) return;
    if (isMuted()) { if (ambienceSnd) ambienceSnd.setVolume(0); return; }
    const cam = scene.cameras && scene.cameras.main;
    const zoom = cam ? cam.zoom : 1;
    let target = 0;
    if (zoom < ZOOM_OUT_THRESHOLD && activity > 0) {
      const zoomF = Math.min(1, (ZOOM_OUT_THRESHOLD - zoom) / ZOOM_OUT_THRESHOLD);
      const actF  = Math.min(1, activity / 12);
      target = (cfg.volume || 0.6) * zoomF * actF;
    }
    if (!ambienceSnd) {
      try { ambienceSnd = scene.sound.add('ambience', { loop: true, volume: 0 }); ambienceSnd.play(); } catch (e) { return; }
    }
    const cur = ambienceSnd.volume || 0;
    ambienceSnd.setVolume(cur + (target - cur) * 0.05); // fondu doux
  }

  // ===== Bruits de fond declenches par seuil de PV (base / vaisseau) =====
  // Boucles HTML Audio (non spatiales) qui s'activent quand les PV passent sous un seuil.
  // base : < 50% -> drone 50% ; < 25% -> drone 25% (plus urgent). vaisseau : < 25% -> drone 25%.
  const HP_AMBIENCE = {
    base50: { src: '/assets/sounds/v2/base-hp-50.wav', vol: 0.55, el: null },
    base25: { src: '/assets/sounds/v2/base-hp-25.wav', vol: 0.65, el: null },
    ship25: { src: '/assets/sounds/v2/ship-hp-25.wav', vol: 0.6,  el: null }
  };
  function ensureLoopEl(o) {
    if (o.el || typeof Audio === 'undefined') return o.el;
    try { o.el = new Audio(o.src); o.el.loop = true; o.el.preload = 'auto'; o.el.volume = 0; } catch (e) {}
    return o.el;
  }
  function setLoopActive(o, active) {
    const el = ensureLoopEl(o);
    if (!el) return;
    const target = (active && !isMuted()) ? o.vol * getVol('fx') : 0;
    el.volume = target;
    if (target > 0) { if (el.paused) el.play().catch(() => {}); }
    else if (!el.paused) { try { el.pause(); el.currentTime = 0; } catch (e) {} }
  }
  // A appeler regulierement (chaque frame) avec les ratios de PV 0-1 (null si inconnu/non affiche).
  function updateHpAmbience(basePct, shipPct) {
    const b = (typeof basePct === 'number' && isFinite(basePct)) ? basePct : null;
    const s = (typeof shipPct === 'number' && isFinite(shipPct)) ? shipPct : null;
    setLoopActive(HP_AMBIENCE.base50, b != null && b < 0.50 && b >= 0.25);
    setLoopActive(HP_AMBIENCE.base25, b != null && b < 0.25);
    setLoopActive(HP_AMBIENCE.ship25, s != null && s < 0.25);
  }

  window.SFX = { preload, play, updateAmbience, updateHpAmbience, MANIFEST, getVol, setVol, setMuted, isMuted, startMusic, testChannel, initSoundMenu };
})();
