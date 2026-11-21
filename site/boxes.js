/* Box locations. A card lives in the box of its ORIGINAL printing (the earliest paper, non-promo print), so every
   printing of a card shares one box. Rules come from the owner (2026-11-20):
   - C boxes = commons/uncommons, R boxes = rares/mythics (special/bonus count as rares). Sets older than Ravnica
     (Mirrodin/Kamigawa and back) are one box for every rarity.
   - Commander decks tied to a main set (incl. Commander 2020 → Ikoria, 2021 → Strixhaven, Modern Horizons 3 Commander)
     go in that set's R box, any rarity. Untied Commander products, Commander Masters, Assassin's Creed and Universes
     Beyond Secret Lair cards go in X5. Commander Legends, Baldur's Gate and Lord of the Rings: commons C14, rares X5.
   - Core sets M10–M21: X1 / X6. Modern Horizons 1 & 2: X2 / X6. Modern Horizons 3: X3 / X6.
   - Everything else (Alpha/Beta/Portal/Arabian Nights/Antiquities/Legends, Un-sets, Conspiracy, Jumpstart, masters,
     promos-only…) is R1. Basic lands get no box. The X4 "Commander staples" list wins over everything else. */
(function () {
  const RULES = 2;  // bump when the rules change, so cached answers are thrown away
  const BOX = {};
  const add = (codes, low, high) => codes.split(' ').forEach(c => { BOX[c] = [low, high == null ? low : high]; });
  // Older than Ravnica: one box for every rarity.
  add('lea leb por p02 ptk arn atq leg', 'R1');
  add('drk fem ice hml all mir vis wth tmp sth exo usg ulg uds', 'R2');
  add('inv pcy nem mmq pls apc ody tor scg lgn ons jud', 'R3');
  add('mrd dst 5dn chk bok sok', 'R4');
  // Ravnica onward: commons/uncommons box, rares/mythics box.
  add('rav dis gpt csp tsp tsb plc fut', 'C1', 'R4');
  add('lrw mor shm eve ala con arb', 'C1', 'R5');
  add('zen wwk roe som mbs nph', 'C2', 'R5');
  add('isd dka avr', 'C2', 'R6');
  add('rtr gtc dgm ths bng jou ktk frf dtk', 'C3', 'R6');
  add('ori bfz ogw soi emn', 'C4', 'R7');
  add('kld aer akh hou', 'C5', 'R7');
  add('xln rix', 'C6', 'R7'); add('dom', 'C6', 'R8');
  add('grn rna', 'C7', 'R8'); add('war eld', 'C8', 'R8'); add('thb iko', 'C9', 'R8');
  add('khm znr', 'C10', 'R8'); add('afr', 'C11', 'R9'); add('stx', 'C11', 'R8');
  add('vow mid', 'C12', 'R9'); add('snc neo', 'C13', 'R9');
  add('ltr clb cmr', 'C14', 'X5');
  add('bro dmu', 'C15', 'R9'); add('mom mat', 'C16', 'R10'); add('one', 'C16', 'R9');
  add('woe lci', 'C17', 'R10'); add('mkm otj', 'C18', 'R10'); add('blb dsk', 'C19', 'R10');
  add('fdn dft tdm', 'C20', 'R10'); add('fin eoe', 'C21', 'R11'); add('spm tla', 'C22', 'R11');
  add('ecl tmt', 'C23', 'R11'); add('sos msh', 'C24', 'R11'); add('hob fra', 'C25', 'R11'); add('trk', 'C26', 'R11');
  // Core sets and Modern Horizons.
  add('m10 m11 m12 m13 m14 m15 m19 m20 m21', 'X1', 'X6');
  add('mh1 mh2', 'X2', 'X6'); add('mh3', 'X3', 'X6');
  add('acr cmm', 'X5');
  // Commander products tied to a main set (code → main set). Unknown ones are looked up from Scryfall's set list.
  const TIED = { znc: 'znr', khc: 'khm', afc: 'afr', mic: 'mid', voc: 'vow', nec: 'neo', ncc: 'snc', dmc: 'dmu', brc: 'bro', onc: 'one', moc: 'mom',
    woc: 'woe', lcc: 'lci', mkc: 'mkm', otc: 'otj', m3c: 'mh3', blc: 'blb', dsc: 'dsk', fdc: 'fdn', drc: 'dft', tdc: 'tdm', fic: 'fin', eoc: 'eoe',
    ecc: 'ecl', soc: 'sos', msc: 'msh', frc: 'fra', trc: 'trk', c20: 'iko', c21: 'stx' };
  const SECRET_LAIR = new Set(['sld', 'slu', 'slc', 'slx']);
  const SKIP_TYPES = new Set(['token', 'memorabilia', 'minigame', 'vanguard', 'promo', 'treasure_chest', 'alchemy']);
  const HIGH = new Set(['rare', 'mythic', 'special', 'bonus']);

  // X4: Commander staples. Names are compared without capitals, accents or punctuation.
  const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const X4 = new Set(`Ephemerate|Generous Gift|Ghostly Prison|Path to Exile|Swords to Plowshares|
Arcane Denial|Brainstorm|Counterspell|Ghostly Flicker|Imprisoned in the Moon|Ponder|Pongify|Propaganda|Treasure Cruise|Rapid Hybridization|
Bastion of Remembrance|Blood Artist|Buried Alive|Dark Ritual|Deadly Dispute|Diabolic Tutor|Dread Return|Feed the Swarm|Gray Merchant of Asphodel|Kaya's Ghostform|Mirkwood Bats|Pitiless Plunderer|Night's Whisper|Read the Bones|Sanguine Bond|Sign in Blood|Syr Konrad, the Grim|Victimize|Village Rites|Viscera Seer|Zulaport Cutthroat|
Blasphemous Act|Chaos Warp|Dualcaster Mage|Impact Tremors|
Arbor Elf|Beast Whisperer|Beast Within|Cultivate|Elvish Mystic|Eternal Witness|Explore|Farseek|Fyndhorn Elves|Garruk's Uprising|Harrow|Herald's Horn|Kodama's Reach|Krosan Grip|Llanowar Elves|Nature's Lore|Rampant Growth|Reclamation Sage|Sakura-Tribe Elder|Springbloom Druid|Three Visits|Tireless Provisioner|Wild Growth|
Anguished Unmaking|Baleful Strix|Despark|Growth Spiral|Putrefy|Ruinous Ultimatum|Tatyova, Benthic Druid|
Arcane Signet|Azorius Signet|Basalt Monolith|Boros Signet|Burnished Hart|Chromatic Lantern|Commander's Sphere|Dimir Signet|Expedition Map|Fellwar Stone|Golgari Signet|Gilded Lotus|Gruul Signet|Izzet Signet|Lightning Greaves|Mind Stone|Ornithopter of Paradise|Orzhov Signet|Rakdos Signet|Selesnya Signet|Simic Signet|Sol Ring|Solemn Simulacrum|Springleaf Drum|Swiftfoot Boots|Talisman of Conviction|Talisman of Creativity|Talisman of Curiosity|Talisman of Dominance|Talisman of Hierarchy|Talisman of Impulse|Talisman of Indulgence|Talisman of Progress|Talisman of Resilience|Talisman of Unity|Thought Vessel|Wayfarer's Bauble`
    .split('|').map(s => fold(s.replace(/\n/g, ''))));
  X4.add(fold('Syr Konrad the Grim')); X4.add(fold('Sakura Tribe Elder')); X4.add(fold('Commander Sphere')); X4.add(fold('Talisman of Heriarchy'));

  /* ---- the rules ---- */
  let setsCache = null;
  async function parentOf(code) {
    if (TIED[code]) return TIED[code];
    if (!setsCache) {
      try { const r = await fetch('https://api.scryfall.com/sets', { headers: { Accept: 'application/json' } }); setsCache = (await r.json()).data || []; } catch (e) { setsCache = []; }
    }
    const s = setsCache.find(x => x.code === code);
    return (s && s.parent_set_code) || '';
  }
  async function boxOfPrint(c) {
    const high = HIGH.has(c.rarity), i = high ? 1 : 0;
    if (BOX[c.set]) return BOX[c.set][i];
    if (c.set_type === 'commander') {
      const p = await parentOf(c.set);
      if (p && BOX[p]) return BOX[p][1];        // tied to a main set: its R box, any rarity
      return 'X5';
    }
    if (SECRET_LAIR.has(c.set) || c.set_type === 'box') return (c.promo_types || []).includes('universesbeyond') ? 'X5' : 'R1';
    return 'R1';
  }
  const rank = c => BOX[c.set] ? 0 : 1;
  async function compute(prints) {
    // Reprint boxes (Salvat, theme-deck boxes…) are skipped; Secret Lair stays because it prints brand-new cards.
    const ok = prints.filter(c => !c.digital && !c.promo && !SKIP_TYPES.has(c.set_type) && !(c.set_type === 'box' && !SECRET_LAIR.has(c.set)) && (!c.games || c.games.includes('paper')));
    if (!ok.length) return 'R1';
    ok.sort((a, b) => (a.released_at || '').localeCompare(b.released_at || '') || rank(a) - rank(b));
    return boxOfPrint(ok[0]);
  }

  /* ---- lookup with caching ---- */
  const cache = new Map();   // folded name → box ('' = none)
  const CK = 'boxcache';
  function loadCache() {
    try { const j = JSON.parse(localStorage.getItem(CK) || '{}'); if (j.rules === RULES) Object.entries(j.map || {}).forEach(([k, v]) => cache.set(k, v)); } catch (e) {}
  }
  function saveCache() { try { localStorage.setItem(CK, JSON.stringify({ rules: RULES, map: Object.fromEntries(cache) })); } catch (e) {} }
  let staticLoaded = null;
  function loadStatic() {
    if (!staticLoaded) staticLoaded = fetch('boxes.json?v=' + RULES).then(r => r.ok ? r.json() : null).then(j => {
      if (j && j.rules === RULES) Object.entries(j.map || {}).forEach(([k, v]) => { if (!cache.has(k)) cache.set(k, v); });
    }).catch(() => {});
    return staticLoaded;
  }
  loadCache();

  function get(name) {
    const k = fold(name);
    if (X4.has(k)) return 'X4';
    return cache.get(k);   // undefined = not looked up yet
  }

  let lastReq = 0;
  async function sf(q) {
    const w = lastReq + 600 - Date.now(); if (w > 0) await new Promise(r => setTimeout(r, w)); lastReq = Date.now();
    const url = 'https://api.scryfall.com/cards/search?q=' + encodeURIComponent(q) + '&unique=prints&order=released&dir=asc&include_extras=true&include_variations=true';
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (r.status === 404) return [];
    if (!r.ok) throw new Error('Scryfall ' + r.status);
    return (await r.json()).data || [];
  }
  async function lookup(name) {
    const names = [name]; if (name.includes(' // ')) names.push(name.split(' // ')[0]);
    for (const n of names) {
      const q = '!"' + n.replace(/"/g, '') + '" game:paper';
      const prints = await sf(q + ' -is:promo');
      if (prints.length) { if (/^Basic/.test(prints[0].type_line || '')) return ''; return compute(prints); }
      const any = await sf(q);
      if (any.length) return /^Basic/.test(any[0].type_line || '') ? '' : 'R1';   // only ever printed as a promo
    }
    return undefined;
  }

  const busy = new Set();
  let running = false;
  async function ensure(names, onUpdate) {
    await loadStatic();
    const todo = [];
    for (const n of new Set(names)) { const k = fold(n); if (n && get(n) === undefined && !busy.has(k)) { busy.add(k); todo.push(n); } }
    if (onUpdate) onUpdate();
    if (!todo.length) return;
    queue.push(...todo.map(n => ({ n, onUpdate })));
    if (!running) run();
  }
  const queue = [];
  let fails = 0;
  async function run() {
    running = true;
    while (queue.length) {
      const { n, onUpdate } = queue.shift();
      try { const b = await lookup(n); if (b !== undefined) { cache.set(fold(n), b); if (queue.length % 10 === 0) saveCache(); if (onUpdate) onUpdate(); } }
      catch (e) { fails++; await new Promise(r => setTimeout(r, Math.min(60000, 5000 * fails))); queue.push({ n, onUpdate }); busy.add(fold(n)); if (fails > 6) { queue.length = 0; busy.clear(); } continue; }
      fails = 0;
      busy.delete(fold(n));
    }
    saveCache(); running = false;
  }

  window.Boxes = { get, ensure, lookup, compute, fold, RULES, cache, x4: X4 };
})();
