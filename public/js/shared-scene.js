// Helpers de scene partages entre stream.html (streamer.js) et index.html (player.js).
// Charge AVANT le script principal de chaque page ; expose window.SharedScene.
//
// Convention : `serverElements` est un global declare par chaque page principale.
// Les helpers le lisent via getElements() pour rester decouples.

(function () {
  function getElements() {
    return (typeof serverElements !== 'undefined') ? serverElements : [];
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
    applyTurretPowerVisual
  };
})();
