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
  // ----- Camera centree sur un point suivi (scene._viewCenter), borne a la case courante -----
  // On NE lit JAMAIS l'etat de la camera (scrollX/getWorldPoint peuvent etre perimes hors-frame) :
  // on suit nous-memes le point central monde et on applique via cam.centerOn (centrage natif correct).
  // Convention (rotation 0) : worldX(screenX) = viewCenter.x + (screenX - camWidth/2) / zoom.
  function clampCenterToCase(scene, cx, cy) {
    const { w, h } = caseDims();
    const c = scene._currentCase || { i: 0, j: 0 };
    const cam = scene.cameras.main;
    const x0 = c.i * w, y0 = c.j * h;
    const vw = cam.width / cam.zoom, vh = cam.height / cam.zoom;
    return {
      x: vw >= w ? x0 + w / 2 : Math.min(Math.max(cx, x0 + vw / 2), x0 + w - vw / 2),
      y: vh >= h ? y0 + h / 2 : Math.min(Math.max(cy, y0 + vh / 2), y0 + h - vh / 2)
    };
  }
  function applyViewCenter(scene) {
    const cam = scene.cameras.main;
    const vc = scene._viewCenter || caseCenterCoords((scene._currentCase || {}).i || 0, (scene._currentCase || {}).j || 0);
    const cl = clampCenterToCase(scene, vc.x, vc.y);
    scene._viewCenter = cl;
    cam.centerOn(cl.x, cl.y);
  }
  function focusCameraOnCase(scene, c, fx, fy) {
    if (fx == null) { const cc = caseCenterCoords(c.i, c.j); fx = cc.x; fy = cc.y; }
    scene._currentCase = c;
    scene._viewCenter = { x: fx, y: fy };
    applyViewCenter(scene);
  }
  function centerCameraOnCase(scene, i, j) { focusCameraOnCase(scene, { i, j }, null, null); }
  // Recentre sur la case du vaisseau, UNIQUEMENT au changement de case (sinon on ecraserait
  // le zoom/pan manuel). Premier appel -> centre sur la case (= la base).
  function updateCaseCamera(scene, x, y) {
    const cur = caseOf(x, y);
    const prev = scene._currentCase;
    if (!prev || prev.i !== cur.i || prev.j !== cur.j) {
      focusCameraOnCase(scene, cur, null, null);
      return true;
    }
    return false;
  }
  function recenterCurrentCase(scene) {
    if (scene._currentCase) focusCameraOnCase(scene, scene._currentCase, null, null);
  }
  // "Teleporte" la camera sur la case contenant (x,y), centree sur le milieu de la case.
  function tpCameraTo(scene, x, y) {
    focusCameraOnCase(scene, caseOf(x, y), null, null);
  }
  // Re-borne la vue courante a la case (apres un resize p.ex.).
  function clampScrollToCase(scene) { if (scene._currentCase) applyViewCenter(scene); }
  // Deplacement (drag) : on bouge le centre suivi de (dxScreen,dyScreen) px ecran, borne a la case.
  function panView(scene, dxScreen, dyScreen) {
    if (!scene._viewCenter) return;
    const cam = scene.cameras.main;
    scene._viewCenter.x -= dxScreen / cam.zoom;
    scene._viewCenter.y -= dyScreen / cam.zoom;
    applyViewCenter(scene);
  }
  // Zoom centre sur le curseur : le point monde sous la souris reste fixe. applyZoom() change cam.zoom.
  function zoomView(scene, pointer, applyZoom) {
    const cam = scene.cameras.main;
    const zoomOld = cam.zoom;
    applyZoom();
    const zoomNew = cam.zoom;
    if (pointer && scene._viewCenter && zoomOld && zoomNew) {
      const dx = pointer.x - cam.width / 2, dy = pointer.y - cam.height / 2;
      scene._viewCenter.x += dx * (1 / zoomOld - 1 / zoomNew);
      scene._viewCenter.y += dy * (1 / zoomOld - 1 / zoomNew);
    }
    applyViewCenter(scene);
  }

  // ===================== Minimap =====================
  // Dessine une carte des cases dans un <canvas id="minimap"> : grille, case visible,
  // base (case 0,0) et vaisseau. Clic -> onTp(worldX, worldY) pour deplacer la camera.
  function setupMinimap(opts) {
    const canvas = document.getElementById('minimap');
    if (!canvas) return null;
    const { w, h } = caseDims();
    const b = opts.bounds;
    const mm = {
      canvas, ctx: canvas.getContext('2d'), bounds: b,
      mapX0: b.minI * w, mapY0: b.minJ * h,
      mapW: (b.maxI - b.minI + 1) * w, mapH: (b.maxJ - b.minJ + 1) * h,
      shipX: null, shipY: null
    };
    canvas.style.cursor = 'pointer';
    canvas.onclick = (e) => {
      const r = canvas.getBoundingClientRect();
      const wx = mm.mapX0 + ((e.clientX - r.left) / r.width) * mm.mapW;
      const wy = mm.mapY0 + ((e.clientY - r.top) / r.height) * mm.mapH;
      if (typeof opts.onTp === 'function') opts.onTp(wx, wy);
    };
    return mm;
  }
  function drawMinimap(mm, scene, shipX, shipY) {
    if (!mm) return;
    const { ctx, canvas } = mm;
    const W = canvas.width, H = canvas.height;
    const { w, h } = caseDims();
    const tx = (wx) => (wx - mm.mapX0) / mm.mapW * W;
    const ty = (wy) => (wy - mm.mapY0) / mm.mapH * H;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(2,8,18,0.65)';
    ctx.fillRect(0, 0, W, H);
    // Case visible (surbrillance)
    const c = scene._currentCase;
    if (c) {
      ctx.fillStyle = 'rgba(74,175,255,0.22)';
      ctx.fillRect(tx(c.i * w), ty(c.j * h), (w / mm.mapW) * W, (h / mm.mapH) * H);
    }
    // Grille
    ctx.strokeStyle = 'rgba(74,175,255,0.30)';
    ctx.lineWidth = 1;
    for (let i = mm.bounds.minI; i <= mm.bounds.maxI + 1; i++) {
      const x = tx(i * w); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let j = mm.bounds.minJ; j <= mm.bounds.maxJ + 1; j++) {
      const y = ty(j * h); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    // Base (case 0,0)
    const bx = (typeof BASE_X !== 'undefined') ? BASE_X : w / 2;
    const by = (typeof BASE_Y !== 'undefined') ? BASE_Y : h / 2;
    ctx.fillStyle = '#ffd24f';
    ctx.fillRect(tx(bx) - 2.5, ty(by) - 2.5, 5, 5);
    // Vaisseau
    if (shipX != null && shipY != null) {
      ctx.fillStyle = '#ff8044';
      ctx.beginPath(); ctx.arc(tx(shipX), ty(shipY), 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
    }
  }

  // ===================== Overlay actions (compteurs + halo "mon action") =====================
  const ACTION_LABELS = { tir: 'Tir', visee: 'Portée', reparation: 'Répar', remplir: 'Énergie', minage: 'Minage' };

  function actionCountsByElement(activeList) {
    const m = new Map();
    for (const a of (activeList || [])) {
      if (!a || !a.element_id) continue;
      if (!m.has(a.element_id)) m.set(a.element_id, new Map());
      const am = m.get(a.element_id);
      am.set(a.action_id, (am.get(a.action_id) || 0) + 1);
    }
    return m;
  }
  function formatActionCounts(am) {
    if (!am || am.size === 0) return '';
    const parts = [];
    for (const [act, n] of am) parts.push(`${ACTION_LABELS[act] || act} ×${n}`);
    return parts.join('   ');
  }
  function overlayElementPos(scene, id) {
    if (id === 'ship-1') return scene.ship ? { x: scene.ship.x, y: scene.ship.y } : null;
    const sp = scene.elementSprites && scene.elementSprites.get(id);
    if (sp) return { x: sp.x, y: sp.y };
    const el = getElements().find(e => e.id === id);
    return el ? { x: el.x, y: el.y } : null;
  }
  function overlayLabelOffset(scene, id) {
    if (id === 'ship-1') return 30;
    const sp = scene.elementSprites && scene.elementSprites.get(id);
    if (sp && sp.displayHeight) return sp.displayHeight * 0.5 + 12;
    return 40;
  }
  // Cree/maj les labels de compteurs d'actions et le halo de l'element actif de l'utilisateur.
  function refreshActionOverlay(scene, activeList, myActiveElementId) {
    if (!scene._actionLabels) scene._actionLabels = new Map();
    const counts = actionCountsByElement(activeList);
    const ids = new Set([...counts.keys(), ...scene._actionLabels.keys()]);
    for (const id of ids) {
      const txt = formatActionCounts(counts.get(id));
      let lbl = scene._actionLabels.get(id);
      if (!txt) { if (lbl) { lbl.destroy(); scene._actionLabels.delete(id); } continue; }
      if (!lbl) {
        lbl = scene.add.text(0, 0, '', {
          fontFamily: 'Consolas, monospace', fontSize: '13px', color: '#cfe6ff',
          stroke: '#000', strokeThickness: 3, align: 'center'
        }).setOrigin(0.5, 0).setDepth(13);
        scene._actionLabels.set(id, lbl);
      }
      lbl.setText(txt);
    }
    updateMyActiveHalo(scene, myActiveElementId);
    positionActionOverlay(scene);
  }
  function updateMyActiveHalo(scene, myId) {
    if (!scene._myHalo) {
      scene._myHalo = scene.add.circle(0, 0, 70, 0x4afff8, 0)
        .setStrokeStyle(3, 0x4afff8, 0.95).setDepth(6);
      scene.tweens.add({
        targets: scene._myHalo, alpha: { from: 0.95, to: 0.35 }, scaleX: { from: 1, to: 1.12 }, scaleY: { from: 1, to: 1.12 },
        yoyo: true, repeat: -1, duration: 800, ease: 'Sine.easeInOut'
      });
    }
    scene._myHaloId = myId || null;
    if (!myId) { scene._myHalo.visible = false; return; }
    let r = 70;
    if (myId === 'ship-1') r = 42;
    else {
      const sp = scene.elementSprites && scene.elementSprites.get(myId);
      if (sp && sp.displayWidth) r = Math.max(sp.displayWidth, sp.displayHeight) * 0.6;
    }
    scene._myHalo.setRadius(r);
    scene._myHalo.visible = true;
  }
  // A appeler chaque frame : suit la position des elements mobiles (vaisseau).
  function positionActionOverlay(scene) {
    if (scene._actionLabels) {
      for (const [id, lbl] of scene._actionLabels) {
        const p = overlayElementPos(scene, id);
        if (!p) { lbl.visible = false; continue; }
        lbl.visible = true;
        lbl.x = p.x; lbl.y = p.y + overlayLabelOffset(scene, id);
      }
    }
    if (scene._myHalo && scene._myHaloId) {
      const p = overlayElementPos(scene, scene._myHaloId);
      if (p) { scene._myHalo.x = p.x; scene._myHalo.y = p.y; }
    }
  }

  // Petit viseur (anneau + croix + point), discret et pulsant. Renvoie un Graphics a detruire.
  function makeReticle(scene, x, y) {
    const g = scene.add.graphics().setDepth(9);
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
    scene.tweens.add({ targets: g, alpha: { from: 0, to: 0.9 }, duration: 350, ease: 'Sine.easeOut' });
    scene.tweens.add({ targets: g, scaleX: { from: 1, to: 1.18 }, scaleY: { from: 1, to: 1.18 }, yoyo: true, repeat: -1, duration: 700, ease: 'Sine.easeInOut' });
    return g;
  }

  // ===================== HUD stats (barre d'essence + materiaux/radius) =====================
  let _statsEls = null;
  function updateStatsPanel() {
    if (!_statsEls) {
      _statsEls = {
        fill: document.getElementById('statEssenceFill'),
        val:  document.getElementById('statEssenceVal'),
        mat:  document.getElementById('statMateriaux'),
        rad:  document.getElementById('statRadius')
      };
    }
    const states = getStates();
    const baseEl = getElements().find(e => e.type === 'base');
    const st = (baseEl && states) ? states.get(baseEl.id) : null;
    if (st && _statsEls.fill) {
      const max = st.essenceMax || 1;
      const ratio = Math.max(0, Math.min(1, (st.essence || 0) / max));
      _statsEls.fill.style.width = (ratio * 100) + '%';
      // Rouge si tres bas (tourelles bientot HS), sinon bleu.
      _statsEls.fill.style.background = ratio < 0.12 ? '#ff5a5a' : '#3da5ff';
      if (_statsEls.val) _statsEls.val.textContent = Math.round(st.essence || 0) + ' / ' + (st.essenceMax || 0);
    }
    const fr = (typeof factionResources !== 'undefined') ? factionResources : null;
    if (fr) {
      if (_statsEls.mat) _statsEls.mat.textContent = fr.materiaux || 0;
      if (_statsEls.rad) _statsEls.rad.textContent = fr.radius || 0;
    }
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
    // Conteneur : logo TimeIcon (si charge) a gauche + timer restant a droite.
    const container = scene.add.container(c.x, c.y).setDepth(10);
    let hasIcon = false;
    if (scene.textures.exists('time-icon')) {
      const icon = scene.add.image(-44, 0, 'time-icon').setOrigin(0.5).setDisplaySize(30, 30);
      container.add(icon);
      hasIcon = true;
    }
    const txt = scene.add.text(hasIcon ? -26 : 0, 0, '', {
      fontFamily: 'Consolas, monospace', fontSize: '16px', color: '#88e0c8',
      stroke: '#000', strokeThickness: 3, align: hasIcon ? 'left' : 'center'
    }).setOrigin(hasIcon ? 0 : 0.5, 0.5);
    container.add(txt);
    const update = () => {
      const remaining = respawnsAt - Date.now();
      if (remaining <= 0) { container.destroy(); return; }
      const m = Math.floor(remaining / 60000);
      const s = Math.floor((remaining % 60000) / 1000);
      txt.setText(`${label} — repop\n${m}m ${String(s).padStart(2, '0')}s`);
    };
    update();
    const interval = setInterval(update, 1000);
    container.once('destroy', () => clearInterval(interval));
    scene.groupRespawnTimers.set(subtype, container);
    return container;
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

  // Barre de vie basee sur les assets HealthBar (remplissage) + HealthBar_Line (cadre).
  // Conserve l'API historique : container.fill.width (largeur affichee) et
  // container.fill.fillColor (teinte) restent assignables -> aucun appelant a changer.
  function makeImageHpBar(scene, x, y, width) {
    const height = 9;
    const container = scene.add.container(x, y);
    const hasTex = scene.textures.exists('healthbar') && scene.textures.exists('healthbar-line');
    let fill;
    if (hasTex) {
      const frame = scene.add.image(0, 0, 'healthbar-line').setDisplaySize(width + 4, height + 5);
      fill = scene.add.image(-width / 2, 0, 'healthbar').setOrigin(0, 0.5).setDisplaySize(width, height);
      const fh = fill.displayHeight;
      // Compat : .width pilote la largeur affichee, .fillColor pilote la teinte.
      Object.defineProperty(fill, 'width', {
        configurable: true,
        get() { return this.displayWidth; },
        set(w) { this.displayWidth = Math.max(0.001, w); this.displayHeight = fh; }
      });
      Object.defineProperty(fill, 'fillColor', {
        configurable: true,
        get() { return this._fc; },
        set(c) { this._fc = c; if (c == null || c === 0xffffff || c === 0x4fdb73) this.clearTint(); else this.setTint(c); }
      });
      container.add([frame, fill]);
    } else {
      // Fallback (textures non chargees) : ancien rendu rectangle.
      const bg = scene.add.rectangle(0, 0, width, 6, 0x000000, 0.6).setStrokeStyle(1.5, 0xffffff, 0.85);
      fill = scene.add.rectangle(-width / 2, 0, width, 4, 0x4fdb73).setOrigin(0, 0.5);
      container.add([bg, fill]);
    }
    container.fill = fill;
    container.maxWidth = width;
    return container;
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
    makeImageHpBar,
    fadeAsteroidSprite,
    restoreAsteroidSprite,
    isBasePowered,
    applyTurretPowerVisual,
    getGameClock,
    updateBaseClock,
    caseOf,
    caseCenterCoords,
    centerCameraOnCase,
    focusCameraOnCase,
    updateCaseCamera,
    recenterCurrentCase,
    clampScrollToCase,
    panView,
    zoomView,
    tpCameraTo,
    setupMinimap,
    drawMinimap,
    refreshActionOverlay,
    positionActionOverlay,
    makeReticle,
    updateStatsPanel
  };
})();
