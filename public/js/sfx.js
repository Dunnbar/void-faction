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

  // Reglages par son. src:'' => desactive tant que tu n'as pas choisi le fichier.
  // volume 0-1 | throttleMs : delai mini entre 2 lectures du meme son
  // maxVoices : nb max d'instances simultanees | pitch : variation aleatoire (+/-)
  const MANIFEST = {
    'shot-ship':   { src: '', volume: 0.50, throttleMs: 55,  maxVoices: 4, pitch: 0.08 },
    'shot-turret': { src: '', volume: 0.45, throttleMs: 70,  maxVoices: 4, pitch: 0.08 },
    'shot-enemy':  { src: '', volume: 0.40, throttleMs: 80,  maxVoices: 4, pitch: 0.10 },
    'impact':      { src: '', volume: 0.50, throttleMs: 45,  maxVoices: 5, pitch: 0.12 },
    'explosion':   { src: '', volume: 0.70, throttleMs: 120, maxVoices: 3, pitch: 0.10 },
    'ambience':    { src: '', volume: 0.60, loop: true },   // boucle de bataille (vue dezoomee)
  };

  // En-dessous de ce zoom camera, on est "dezoome" : on n'egrene plus chaque tir,
  // on bascule sur l'ambiance + quelques tirs aleatoires. (a ajuster selon le rendu)
  const ZOOM_OUT_THRESHOLD   = 0.6;
  const FAR_SHOT_PROBABILITY = 0.18; // proba de laisser passer un tir individuel en dezoom

  const lastPlayAt = {};   // throttle par cle
  const activeCount = {};  // voix actives par cle

  function loaded(scene, key) {
    return !!(scene && scene.cache && scene.cache.audio && scene.cache.audio.exists(key));
  }

  // A appeler dans le preload() de chaque scene.
  function preload(scene) {
    if (!scene || !scene.load) return;
    for (const [key, cfg] of Object.entries(MANIFEST)) {
      if (!cfg.src) continue;                 // pas de fichier -> on saute (aucun 404)
      try { scene.load.audio(key, cfg.src); } catch (e) {}
    }
    scene.load.on('loaderror', () => {});      // un fichier manquant ne bloque pas le chargement
  }

  // Joue un SFX a la position monde (x,y). Omets x,y pour un son non-spatial.
  function play(scene, key, x, y) {
    if (isMuted()) return;
    const cfg = MANIFEST[key];
    if (!cfg || !cfg.src || !loaded(scene, key)) return;
    const now = (scene.time && scene.time.now) || (typeof performance !== 'undefined' ? performance.now() : 0);

    // 1) throttle par type
    if (lastPlayAt[key] && now - lastPlayAt[key] < cfg.throttleMs) return;

    // 2) cull hors-ecran + 3) bascule dezoom
    let vol = cfg.volume;
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

    // 5) lecture avec variation
    try {
      const rate = 1 + (Math.random() * 2 - 1) * (cfg.pitch || 0);
      const snd = scene.sound.add(key, { volume: vol * (0.9 + Math.random() * 0.2), rate });
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

  window.SFX = { preload, play, updateAmbience, MANIFEST };
})();
