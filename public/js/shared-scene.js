// Helpers de scene partages entre stream.html (streamer.js) et index.html (player.js).
// Charge AVANT le script principal de chaque page ; expose window.SharedScene.
//
// Convention : `serverElements` est un global declare par chaque page principale.
// Les helpers le lisent via getElements() pour rester decouples.

(function () {
  function getElements() {
    return (typeof serverElements !== 'undefined') ? serverElements : [];
  }

  // ===================== Systeme de "cases" (rooms facon Zelda) =====================
  // Le monde est decoupe en une grille infinie de cases de WORLD_W x WORLD_H.
  // La case (0,0) est la case d'origine (la base est en son centre). La camera ne
  // suit PAS le vaisseau en continu : elle reste centree sur la case courante et
  // bascule sur la case voisine quand le vaisseau franchit une frontiere (sort de l'ecran).
  function caseDims() {
    return {
      w: (typeof WORLD_W !== 'undefined') ? WORLD_W : 2400,
      h: (typeof WORLD_H !== 'undefined') ? WORLD_H : 1350
    };
  }
  function caseOf(x, y) {
    const { w, h } = caseDims();
    return { i: Math.floor(x / w), j: Math.floor(y / h) };
  }
  function caseCenterCoords(i, j) {
    const { w, h } = caseDims();
    return { x: (i + 0.5) * w, y: (j + 0.5) * h };
  }
  // Centre la camera sur une case. animate=true : petit pan fluide (transition de case).
  function centerCameraOnCase(scene, i, j, animate) {
    const c = caseCenterCoords(i, j);
    const cam = scene.cameras.main;
    scene.tweens.killTweensOf(cam);
    if (animate) {
      scene.tweens.add({
        targets: cam,
        scrollX: c.x - 0.5 * cam.width / cam.zoom,
        scrollY: c.y - 0.5 * cam.height / cam.zoom,
        duration: 320, ease: 'Cubic.easeInOut'
      });
    } else {
      cam.centerOn(c.x, c.y);
    }
  }
  // Detecte un changement de case d'apres (x,y) du vaisseau et recadre si besoin.
  // Premier appel (pas de case memorisee) : centrage instantane, sans animation.
  // Retourne true si une transition a eu lieu.
  function updateCaseCamera(scene, x, y) {
    const cur = caseOf(x, y);
    const prev = scene._currentCase;
    if (!prev || prev.i !== cur.i || prev.j !== cur.j) {
      const hadPrev = !!prev;
      scene._currentCase = cur;
      centerCameraOnCase(scene, cur.i, cur.j, hadPrev);
      return true;
    }
    return false;
  }
  // Recadre sur la case courante (apres un zoom / resize) sans animation.
  function recenterCurrentCase(scene) {
    const c = scene._currentCase;
    if (c) centerCameraOnCase(scene, c.i, c.j, false);
  }

  function getStates() {
    return (typeof elementStates !== 'undefined') ? elementStates : null;
  }

  // La base est alimentee tant qu'elle a de l'essence. Si l'etat est inconnu (init en cours),
  // on retourne true par defaut pour ne pas couper les tourelles a tort.
  function isBasePowered() {
    const states = getStates();
    if (!states) return true;
    const baseEl = getElements().find(e => e.type === 'base');
    if (!baseEl) return true;
    const st = states.get(baseEl.id);
    if (!st) return true;
    return (st.essence || 0) > 0;
  }

  // Horloge jeu : lit l'heure dans le fuseau GAME_TZ (envoye par le serveur).
  // Retourne { hour, minute, isNight, formatted: "HH:MM" }.
  // Jour : 7h-21h, Nuit : 21h-7h.
  const _clockFmtCache = new Map();
  function getGameClock(tz) {
    const zone = tz || 'Europe/Paris';
    let fmt = _clockFmtCache.get(zone);
    if (!fmt) {
      fmt = new Intl.DateTimeFormat('en-GB', {
        timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false
      });
      _clockFmtCache.set(zone, fmt);
    }
    const parts = fmt.formatToParts(new Date());
    const h = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
    const m = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
    return {
      hour: h,
      minute: m,
      isNight: (h < 7 || h >= 21),
      formatted: `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`
    };
  }

  // Met a jour le bandeau "JOUR N - HH:MM" dans un element DOM.
  // baseState : etat de la base (avec daysAlive) ; tz : fuseau jeu.
  function updateBaseClock(domEl, baseState, tz) {
    if (!domEl) return;
    const clock = getGameClock(tz);
    const day = (baseState && Number.isFinite(baseState.daysAlive)) ? baseState.daysAlive : 0;
    domEl.innerHTML = `<span class="day">JOUR ${day}</span><span class="time">${clock.formatted}</span>`;
    domEl.classList.toggle('night', clock.isNight);
    domEl.classList.toggle('day-mode', !clock.isNight);
  }

  // Applique un tint grise sur une tourelle quand la base n'est plus alimentee.
  // Idempotent : safe a rappeler chaque frame.
  function applyTurretPowerVisual(sprite, powered) {
    if (!sprite) return;
    if (powered) {
      if (sprite._powerTinted) { sprite.clearTint(); sprite._powerTinted = false; }
    } else {
      if (!sprite._powerTinted) { sprite.setTint(0x555566); sprite._powerTinted = true; }
    }
  }

  // Centroide des asteroides d'un groupe (subtype) en coordonnees monde.
  function groupCentroid(subtype) {
    const list = getElements().filter(e => e.type === 'asteroid' && e.subtype === subtype);
    if (!list.length) return null;
    const cx = list.reduce((s, e) => s + e.x, 0) / list.length;
    const cy = list.reduce((s, e) => s + e.y, 0) / list.length;
    return { x: cx, y: cy };
  }

  // Affiche UN seul timer de respawn pour tout le groupe au centroide.
  // Stocke dans scene.groupRespawnTimers (lazy-init).
  function showGroupRespawnTimer(scene, subtype, respawnsAt) {
    if (!scene.groupRespawnTimers) scene.groupRespawnTimers = new Map();
    const existing = scene.groupRespawnTimers.get(subtype);
    if (existing) { existing.destroy(); scene.groupRespawnTimers.delete(subtype); }
    const c = groupCentroid(subtype);
    if (!c) return null;
    const label = subtype === 'materiaux' ? 'MATERIAUX' : (subtype === 'radius' ? 'RADIUS' : subtype.toUpperCase());
    const timer = scene.add.text(c.x, c.y, '', {
      fontFamily: 'Consolas, monospace', fontSize: '16px', color: '#88e0c8',
      stroke: '#000', strokeThickness: 3, align: 'center'
    }).setOrigin(0.5).setDepth(10);
    const update = () => {
      const remaining = respawnsAt - Date.now();
      if (remaining <= 0) { timer.destroy(); return; }
      const m = Math.floor(remaining / 60000);
      const s = Math.floor((remaining % 60000) / 1000);
      timer.setText(`${label}\nRESPAWN\n${m}m ${String(s).padStart(2, '0')}s`);
    };
    update();
    const interval = setInterval(update, 1000);
    timer.once('destroy', () => clearInterval(interval));
    scene.groupRespawnTimers.set(subtype, timer);
    return timer;
  }

  function clearGroupRespawnTimer(scene, subtype) {
    if (!scene.groupRespawnTimers) return;
    const t = scene.groupRespawnTimers.get(subtype);
    if (t) { t.destroy(); scene.groupRespawnTimers.delete(subtype); }
  }

  function clearAllGroupRespawnTimers(scene) {
    if (!scene.groupRespawnTimers) { scene.groupRespawnTimers = new Map(); return; }
    for (const t of scene.groupRespawnTimers.values()) t.destroy();
    scene.groupRespawnTimers.clear();
  }

  // Fade-out d'un asteroide (explosion + alpha->0). Masque la barre de vie.
  function fadeAsteroidSprite(scene, sprite, hpBar) {
    if (sprite) {
      if (typeof scene.explodeAt === 'function') scene.explodeAt(sprite.x, sprite.y);
      scene.tweens.killTweensOf(sprite);
      scene.tweens.add({ targets: sprite, alpha: 0, scale: sprite.scale * 1.4, duration: 600, ease: 'Cubic.easeOut' });
    }
    if (hpBar) hpBar.setVisible(false);
  }

  // Renaissance visuelle d'un asteroide (alpha 0 -> 1, scale 0.5 -> 1).
  function restoreAsteroidSprite(scene, sprite, hpBar) {
    if (sprite) {
      scene.tweens.killTweensOf(sprite);
      sprite.setAlpha(0);
      if (sprite._asteroidVariant) sprite.setFrame(0);
      const scaleTarget = sprite.scale;
      scene.tweens.add({ targets: sprite, alpha: 1, scale: { from: scaleTarget * 0.5, to: scaleTarget }, duration: 500 });
    }
    if (hpBar) hpBar.setVisible(true);
  }

  window.SharedScene = {
    showGroupRespawnTimer,
    clearGroupRespawnTimer,
    clearAllGroupRespawnTimers,
    fadeAsteroidSprite,
    restoreAsteroidSprite,
    isBasePowered,
    applyTurretPowerVisual,
    getGameClock,
    updateBaseClock,
    caseOf,
    caseCenterCoords,
    centerCameraOnCase,
    updateCaseCamera,
    recenterCurrentCase
  };
})();
