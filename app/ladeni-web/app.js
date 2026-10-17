// Ladicí stránka CAD Mouse MK2. Mluví s myší přes ikonku v liště (WebSocket /ws <-> COM).
import * as THREE from 'three';
import { STLLoader } from './vendor/STLLoader.js';
import { toCreasedNormals } from './vendor/BufferGeometryUtils.js';

// --- Osy a směry -----------------------------------------------------------
// Firmware má 6 os × 2 směry, k = osa*2 + (0 = plus, 1 = mínus), osy Tx,Ty,Tz,Rx,Ry,Rz.
// Knoflík na pružině se reálně jen naklání (Rx, Ry), otáčí (Rz) a zmáčkne (Tz+).
const AXES = ['Tx', 'Ty', 'Tz', 'Rx', 'Ry', 'Rz'];
const DIRS = [
  'Posun doprava', 'Posun doleva', 'Posun k sobě', 'Posun od sebe',
  'Zmáčknout dolů', 'Povytáhnout',
  'Dopředu', 'Dozadu',
  'Doprava', 'Doleva',
  'Otočit doleva', 'Otočit doprava', // ověřeno rukou: +Rz = doleva
];
// Zmáčknutí: podle orientace magnetů vyjde jako +Tz (k 4) nebo −Tz (k 5). Kterou polovinu myš
// používá, pozná stránka podle toho, který otisk je nenulový; druhá je vypnutá.
const PRESS_REF = [0, 0, -1, 0, 0, -1, 0, 0, -1]; // směr +Tz v původním vzorci
const pressSlot = () => (cfg && cfg.tpl[4].every((x) => x === 0) && cfg.tpl[5].some((x) => x !== 0) ? 5 : 4);
const pressSign = () => (pressSlot() === 4 ? 1 : -1);
const unused = () => [0, 1, 2, 3, pressSlot() ^ 1];
const maskOf = (ks) => ks.reduce((m, k) => m | (1 << k), 0);
const AXROWS = [
  { axis: 3, name: 'Dopředu / dozadu' },
  { axis: 4, name: 'Doprava / doleva' },
  { axis: 5, name: 'Otáčení' },
  { axis: 2, name: 'Zmáčknutí' },
];
const WIZARD = [
  { dirs: [6, 7], text: 'Nakláněj knoflík dopředu a dozadu' },
  { dirs: [9, 8], text: 'Nakláněj knoflík doleva a doprava' },
  { dirs: [10, 11], text: 'Otáčej knoflíkem doleva a doprava' },
  { dirs: [4], text: 'Zmáčkni knoflík dolů' },
];
const LIMIT = 350;
const NOISE = 0.25;  // mT — menší delty se do učení nepočítají

const $ = (id) => document.getElementById(id);
let cfg = null;
let live = new Array(6).fill(0);
let btnBits = 0; // bit 0 = levé, bit 1 = pravé boční tlačítko (tak, jak je vidí PC)
let connected = false;
let healing = false;

// --- Spojení s ikonkou ------------------------------------------------------
let ws = null;
let recorder = null;  // při učení: funkce, která dostává delty senzorů

function send(...lines) {
  if (ws && ws.readyState === 1) ws.send(lines.join('\n'));
}

let saveTimer = 0;
function setAndSave(...lines) {
  send(...lines);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => send('save'), 700);
}

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => send('stream 1', 'get', 'tray buttons-get');
  ws.onclose = () => { setConn(false, 'Ikonka v liště neběží — spusť CadMouseTray.exe'); setTimeout(connect, 1500); };
  ws.onmessage = (e) => e.data.split('\n').forEach(onLine);
}

function showConn() {
  const name = cfg.mode === 1 ? 'Joystick připojen' : 'SpaceMouse připojena';
  setConn(true, cfg.sleep ? `${name}, spí. Probudíš ji bočním tlačítkem.` : name);
  if (cfg.sleep) live = new Array(6).fill(0);
}

function setConn(on, text) {
  connected = on;
  $('conn').className = 'conn' + (on ? ' on' : '');
  $('conn').textContent = text;
}

function onLine(line) {
  if (line.startsWith('s ')) {
    const v = line.slice(2).trim().split(' ').map(Number);
    if (v.length < 16) return;
    const d = v.slice(0, 9);
    live = v.slice(9, 15);
    btnBits = v[15];
    pushGraphs(d);
    if (recorder) recorder(d);
  } else if (line.startsWith('cfg ')) {
    cfg = JSON.parse(line.slice(4));
    showConn();
    healUnused();
    renderCfg();
  } else if (line.startsWith('buttons ')) {
    btnCfg = JSON.parse(line.slice(8));
    renderButtons();
  } else if (line.startsWith('apps ')) {
    showPicker(JSON.parse(line.slice(5)));
  } else if (line === 'z 1' || line === 'z 0') {
    if (cfg) { cfg.sleep = +line[2]; showConn(); }
  } else if (line.startsWith('b ')) {
    btnBits = +line.split(' ')[1];
  } else if (line === 'conn 1') {
    send('stream 1', 'get');
  } else if (line === 'conn 0') {
    setConn(false, 'Myš není připojená');
  }
}

// Nepoužité směry (posuny, povytažení) mají mít nulový otisk a být vypnuté — i v profilech
// uložených starší verzí. Nulový otisk nesoupeří při rozkladu, takže nekrade pohyb ostatním.
function healUnused() {
  const UNUSED = unused(), UNUSED_MASK = maskOf(UNUSED);
  const dirty = (cfg.lock & UNUSED_MASK) !== UNUSED_MASK || UNUSED.some((k) => cfg.tpl[k].some((x) => x !== 0));
  if (!dirty) { healing = false; return; }
  if (healing) return;
  healing = true;
  send(...UNUSED.map((k) => `tpl ${k} 0 0 0 0 0 0 0 0 0`), `lock ${cfg.lock | UNUSED_MASK}`, 'save', 'get');
}

// --- LED a citlivost -----------------------------------------------------------
function renderCfg() {
  $('m0').classList.toggle('on', cfg.mode === 0);
  $('m1').classList.toggle('on', cfg.mode === 1);
  $('color').value = '#' + cfg.color.toLowerCase();
  $('bright').value = cfg.bright;
  $('brightV').textContent = Math.round(cfg.bright / 2.55) + ' %';
  $('sens').value = cfg.sens;
  $('sensV').textContent = cfg.sens.toFixed(1) + '×';
  document.documentElement.style.setProperty('--led', '#' + cfg.color);
  const favs = $('favs');
  favs.innerHTML = '';
  cfg.fav.forEach((hex, i) => {
    const b = document.createElement('button');
    b.className = 'sw' + (hex === cfg.color ? ' on' : '');
    b.style.background = '#' + hex;
    b.title = 'Použít barvu (pravý klik odebere z oblíbených)';
    b.onclick = () => { cfg.color = hex; setAndSave('color ' + hex); renderCfg(); };
    b.oncontextmenu = (e) => {
      e.preventDefault();
      cfg.fav.splice(i, 1);
      setAndSave('fav ' + cfg.fav.join(','));
      renderCfg();
    };
    favs.appendChild(b);
  });
  ledMat.color.set('#' + cfg.color);
  ledMat.emissive.set('#' + cfg.color);
  ledLight.color.set('#' + cfg.color);
  drawCompass();
  renderMix();
}

for (const b of [$('m0'), $('m1')]) {
  b.onclick = () => {
    const m = +b.dataset.mode;
    if (!cfg || cfg.mode === m) return;
    send('mode ' + m);  // myš uloží režim a připojí se znovu jako jiné zařízení
    setConn(false, 'Přepínám režim…');
  };
}
$('color').oninput = (e) => {
  if (!cfg) return;
  cfg.color = e.target.value.slice(1).toUpperCase();
  setAndSave('color ' + cfg.color);
  document.documentElement.style.setProperty('--led', e.target.value);
  ledMat.color.set(e.target.value);
  ledMat.emissive.set(e.target.value);
  ledLight.color.set(e.target.value);
};
$('favAdd').onclick = () => {
  if (!cfg || cfg.fav.includes(cfg.color)) return;
  if (cfg.fav.length >= 8) cfg.fav.shift();
  cfg.fav.push(cfg.color);
  setAndSave('fav ' + cfg.fav.join(','));
  renderCfg();
};
$('bright').oninput = (e) => {
  cfg.bright = +e.target.value;
  $('brightV').textContent = Math.round(cfg.bright / 2.55) + ' %';
  setAndSave('bright ' + cfg.bright);
};
$('sens').oninput = (e) => {
  cfg.sens = +e.target.value;
  $('sensV').textContent = cfg.sens.toFixed(1) + '×';
  setAndSave('sens ' + cfg.sens);
};
$('defaults').onclick = () => {
  if (!confirm('Vrátit všechny naučené pohyby a citlivosti tohoto režimu na výchozí?')) return;
  send('defaults', 'save', 'get');
};

// --- Výsledné osy ----------------------------------------------------------
const MIX_TITLE = [
  'Volně: kombinuje se s ostatními volnými osami',
  'Tlumit: když je jiná osa výrazně silnější, tahle se ztlumí',
  'Výhradně: když převládá, ostatní osy se vypnou; jinak je vypnutá ona (např. čisté otáčení)',
];
const rows = AXROWS.map(({ axis, name }) => {
  const row = document.createElement('div');
  row.className = 'axrow';
  row.innerHTML = `<span>${name}</span><div class="bar" title="Táhni = mrtvá zóna (menší pohyb se ignoruje)"><div class="dz"></div><div class="val"></div></div>
    <span class="n"></span><span class="mix">${[[0, '0'], [2, '1']].map(([m, t]) => `<button data-m="${m}" title="${MIX_TITLE[m]}">${t}</button>`).join('')}</span>`;
  $('axes').appendChild(row);
  const bar = row.querySelector('.bar');
  const setDead = (e) => {
    const r = bar.getBoundingClientRect();
    cfg.dead[axis] = Math.round(Math.min(LIMIT * 0.6, Math.abs((e.clientX - (r.left + r.width / 2)) / (r.width / 2)) * LIMIT));
    setAndSave(`dead ${axis} ${cfg.dead[axis]}`);
  };
  bar.onpointerdown = (e) => {
    if (!cfg) return;
    bar.setPointerCapture(e.pointerId);
    setDead(e);
    bar.onpointermove = setDead;
  };
  bar.onpointerup = () => { bar.onpointermove = null; };
  row.querySelectorAll('.mix button').forEach((b) => {
    b.onclick = () => {
      if (!cfg) return;
      cfg.mix[axis] = +b.dataset.m;
      setAndSave(`mix ${axis} ${cfg.mix[axis]}`);
      renderMix();
    };
  });
  return { axis, name, row, dz: row.querySelector('.dz'), val: row.querySelector('.val'), num: row.querySelector('.n') };
});

function renderMix() {
  // Na stránce jen 0 = volně a 1 = výhradně; starší „tlumit“ se ukáže jako 0.
  for (const r of rows) r.row.querySelectorAll('.mix button').forEach((b) => b.classList.toggle('on', cfg && +b.dataset.m === (cfg.mix[r.axis] === 2 ? 2 : 0)));
}

function renderAxes() {
  for (const r of rows) {
    const v = live[r.axis];
    const w = Math.min(1, Math.abs(v) / LIMIT) * 50;
    r.val.style.left = (v >= 0 ? 50 : 50 - w) + '%';
    r.val.style.width = w + '%';
    if (cfg) {
      const dz = (cfg.dead[r.axis] / LIMIT) * 50;
      r.dz.style.left = 50 - dz + '%';
      r.dz.style.width = 2 * dz + '%';
    }
    r.num.textContent = Math.round(v);
  }
  // Přelévání: při výrazném pohybu jedné osy ukaž ostatní, které se hýbou s ní.
  const abs = rows.map((r) => Math.abs(live[r.axis]));
  const top = abs.indexOf(Math.max(...abs));
  const msgs = [];
  if (abs[top] > LIMIT * 0.25) {
    abs.forEach((a, i) => {
      const pct = Math.round((a / abs[top]) * 100);
      if (i !== top && pct >= 10) msgs.push(`${rows[i].name} se přidává k ${rows[top].name.toLowerCase()} (${pct} %)`);
    });
  }
  $('bleed').textContent = msgs.join(', ');
}

// --- Kompas knoflíku (pohled shora) ----------------------------------------------
const CX = 160, CY = 160;
// kind 'line': o = vzdálenost začátku od středu, d = směr; 'arc': r, a0 = začátek [rad], s = +1 po směru hodin.
// lbl = [x, y, zarovnání] popisku.
const ARROWS = [
  { k: 6, kind: 'line', o: 60, d: [0, -1], lbl: [CX, 12, 'middle'] },
  { k: 7, kind: 'line', o: 60, d: [0, 1], lbl: [CX, 309, 'middle'] },
  { k: 8, kind: 'line', o: 60, d: [1, 0], lbl: [316, CY + 22, 'end'] },
  { k: 9, kind: 'line', o: 60, d: [-1, 0], lbl: [4, CY + 22, 'start'] },
  { k: 11, kind: 'arc', r: 120, a0: -Math.PI / 2 + 0.3, s: 1, lbl: [316, 26, 'end'] },
  { k: 10, kind: 'arc', r: 120, a0: -Math.PI / 2 - 0.3, s: -1, lbl: [4, 26, 'start'] },
];
const NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs, parent) => {
  const n = document.createElementNS(NS, name);
  for (const a in attrs) n.setAttribute(a, attrs[a]);
  if (parent) parent.appendChild(n);
  return n;
};
const lenOf = (sens) => Math.min(76, 10 + 24 * sens);

function geom(a, sens) {
  const L = lenOf(sens);
  if (a.kind === 'line') {
    const x0 = CX + a.d[0] * a.o, y0 = CY + a.d[1] * a.o;
    const x1 = x0 + a.d[0] * L, y1 = y0 + a.d[1] * L;
    return { path: `M${x0},${y0} L${x1},${y1}`, tip: [x1, y1], tan: a.d };
  }
  const span = Math.min(1.0, L / a.r);
  const a1 = a.a0 + a.s * span;
  const p0 = [CX + a.r * Math.cos(a.a0), CY + a.r * Math.sin(a.a0)];
  const p1 = [CX + a.r * Math.cos(a1), CY + a.r * Math.sin(a1)];
  const tan = [-Math.sin(a1) * a.s, Math.cos(a1) * a.s];
  return { path: `M${p0[0]},${p0[1]} A${a.r},${a.r} 0 0 ${a.s > 0 ? 1 : 0} ${p1[0]},${p1[1]}`, tip: p1, tan };
}
const headPath = (g, size) => {
  const [tx, ty] = g.tip, [ux, uy] = g.tan;
  return `M${tx + ux * size * 1.6},${ty + uy * size * 1.6} L${tx - uy * size},${ty + ux * size} L${tx + uy * size},${ty - ux * size} Z`;
};
const padR = (sens) => 14 + 7 * Math.min(2.5, sens);
const chevron = (r) => `M${CX - r * 0.45},${CY - r * 0.15} L${CX},${CY + r * 0.3} L${CX + r * 0.45},${CY - r * 0.15}`;

// Ikona jednoho směru (do kruhu kalibrace) — stejná kresba jako kompas.
function iconSvg(k) {
  const body = `<circle cx="${CX}" cy="${CY}" r="44" fill="#2e3238" stroke="#59606a" stroke-width="4"/>`;
  if (k === 4) return `<svg viewBox="40 40 240 240">${body}<circle cx="${CX}" cy="${CY}" r="30" fill="#4a1715" stroke="#e5322d" stroke-width="4"/>
    <path d="${chevron(30)}" fill="none" stroke="#ecebe8" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  // Ikona je zmenšená varianta šipky z kompasu: kratší a oblouky blíž ke knoflíku, aby i s hrotem
  // zůstala uvnitř kruhu (pole viewBoxu ±120 kolem středu, šipka dosáhne nejvýš ~112).
  const a = { ...ARROWS.find((x) => x.k === k), o: 54, r: 86 };
  const g = geom(a, 1.1);
  return `<svg viewBox="40 40 240 240">${body}<path d="${g.path}" fill="none" stroke="#ecebe8" stroke-width="14" stroke-linecap="round"/>
    <path d="${headPath(g, 13)}" fill="#ecebe8"/></svg>`;
}

const svg = $('compass');
const arrowEls = [];
let press = null;

// Táhlo citlivosti: pohyb myši ve směru šipky = vyšší citlivost. Malý pohyb = klik (naučit).
function dragSens(e, k, tan, redraw, teachK = k) {
  e.stopPropagation();
  if (!cfg) return;
  const target = e.currentTarget;
  target.setPointerCapture(e.pointerId);
  const pt = svg.createSVGPoint();
  const toSvg = (ev) => { pt.x = ev.clientX; pt.y = ev.clientY; return pt.matrixTransform(svg.getScreenCTM().inverse()); };
  const start = toSvg(e);
  let last = start, moved = false;
  target.onpointermove = (ev) => {
    const p = toSvg(ev);
    if (Math.hypot(p.x - start.x, p.y - start.y) > 4) moved = true;
    const t = tan();
    cfg.dsens[k] = Math.max(0.1, Math.min(2.8, cfg.dsens[k] + ((p.x - last.x) * t[0] + (p.y - last.y) * t[1]) / 24));
    last = p;
    redraw();
  };
  target.onpointerup = () => {
    target.onpointermove = null;
    if (moved) setAndSave(`dsens ${k} ${cfg.dsens[k].toFixed(3)}`);
    else teachOne(teachK);
  };
}

function toggleLock(e, k) {
  e.preventDefault();
  if (!cfg) return;
  cfg.lock ^= 1 << k;
  setAndSave('lock ' + cfg.lock);
  drawCompass();
}

function buildCompass() {
  el('circle', { cx: CX, cy: CY, r: 120, class: 'guide' }, svg);
  el('circle', { cx: CX, cy: CY, r: 51, class: 'ledring' }, svg);
  el('circle', { cx: CX, cy: CY, r: 44, class: 'knob' }, svg);
  for (const a of ARROWS) {
    const g = el('g', { class: 'dir', tabindex: 0, role: 'button' }, svg);
    el('title', {}, g);
    const grip = el('path', { class: 'grip' }, g);
    const shaft = el('path', { class: 'shaft' }, g);
    const tip = el('path', { class: 'tip' }, g);
    const lbl = el('text', { class: 'lbl', x: a.lbl[0], y: a.lbl[1], 'text-anchor': a.lbl[2] }, g);
    lbl.textContent = DIRS[a.k];
    lbl.style.textAnchor = a.lbl[2];
    g.addEventListener('click', (e) => { if (e.target !== tip) teachOne(a.k); });
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') teachOne(a.k); });
    g.addEventListener('contextmenu', (e) => toggleLock(e, a.k));
    tip.addEventListener('click', (e) => e.stopPropagation());
    tip.addEventListener('pointerdown', (e) => dragSens(e, a.k, () => geom(a, cfg.dsens[a.k]).tan, drawCompass));
    arrowEls.push({ a, g, grip, shaft, tip });
  }
  const g = el('g', { class: 'dir press', tabindex: 0, role: 'button' }, svg);
  el('title', {}, g);
  const pad = el('circle', { cx: CX, cy: CY, class: 'pad' }, g);
  const chev = el('path', { class: 'chev' }, g); // bez popisku: v kompasu by kolidoval se šipkou Dozadu
  g.addEventListener('pointerdown', (e) => dragSens(e, pressSlot(), () => [0, 1], drawCompass, 4));
  g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') teachOne(4); });
  g.addEventListener('contextmenu', (e) => toggleLock(e, pressSlot()));
  press = { g, pad, chev };
}

function drawCompass() {
  for (const x of arrowEls) {
    const sens = cfg ? cfg.dsens[x.a.k] : 1;
    const g = geom(x.a, sens);
    x.grip.setAttribute('d', g.path);
    x.shaft.setAttribute('d', g.path);
    x.tip.setAttribute('d', headPath(g, 9));
    x.g.classList.toggle('locked', !!(cfg && cfg.lock & (1 << x.a.k)));
    x.g.querySelector('title').textContent = `${DIRS[x.a.k]}: citlivost ${sens.toFixed(2)}×. Klik naučí, tažení hrotu mění citlivost, pravý klik vypne.`;
  }
  const s = cfg ? cfg.dsens[pressSlot()] : 1;
  press.pad.setAttribute('r', padR(s));
  press.chev.setAttribute('d', chevron(padR(s)));
  press.g.classList.toggle('locked', !!(cfg && cfg.lock & (1 << pressSlot())));
  press.g.querySelector('title').textContent = `${DIRS[4]}: citlivost ${s.toFixed(2)}×. Klik naučí, tažení dolů/nahoru mění citlivost, pravý klik vypne.`;
}

function liveCompass() {
  for (const x of arrowEls) {
    const v = live[x.a.k >> 1];
    const on = (x.a.k & 1 ? -v : v) > 0;
    x.g.classList.toggle('live', on);
    x.shaft.style.opacity = on ? 0.5 + 0.5 * Math.min(1, Math.abs(v) / LIMIT) : '';
  }
  press.g.classList.toggle('live', pressSign() * live[2] > 0);
}

// --- Učení pohybů -------------------------------------------------------------
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const norm = (a) => Math.sqrt(dot(a, a));
const cos = (a, b) => dot(a, b) / (norm(a) * norm(b) || 1);
const unit = (a) => { const n = norm(a) || 1; return a.map((x) => x / n); };

// Hlavní směr vzorků (největší vlastní vektor kovariance, mocninná metoda).
function principal(samples) {
  let v = samples.reduce((s, d) => s.map((x, i) => x + d[i]), new Array(9).fill(0));
  if (norm(v) < 1e-6) v = samples[0].slice();
  for (let it = 0; it < 60; it++) {
    const w = new Array(9).fill(0);
    for (const d of samples) {
      const p = dot(d, v);
      for (let i = 0; i < 9; i++) w[i] += p * d[i];
    }
    const n = norm(w) || 1;
    v = w.map((x) => x / n);
  }
  return v;
}


const moving = (rec) => rec.filter((d) => norm(d) > NOISE);

// Tah = pohyb z klidu a zpátky do klidu. Učení sbírá tahy jako čtečka otisků prstů.
const STROKE_START = 1.2, STROKE_END = 0.7, STROKE_QUIET = 6; // mT, mT, vzorků v klidu (~90 ms)
const STROKES_NEEDED = 5; // tolik tahů naplní jeden směr

// Délka vektoru se vyhlazuje: klidový šum 9 hodnot dohromady je ~0,3 mT a se špičkami by
// pevný práh tah nikdy neuzavřel (to byla příčina „kulhající“ kalibrace).
function strokeDetector(onStroke) {
  let cur = null, quiet = 0, n = 0;
  return (d) => {
    n = n * 0.6 + norm(d) * 0.4;
    if (!cur) {
      if (n > STROKE_START) { cur = [d]; quiet = 0; }
      return;
    }
    cur.push(d);
    quiet = n < STROKE_END ? quiet + 1 : 0;
    if (quiet >= STROKE_QUIET || cur.length > 400) {
      const s = cur;
      cur = null;
      onStroke(s);
    }
  };
}

// Učení jednoho směru (klik na šipku) nebo dvojice ± (průvodce) jako vážený průměr tahů:
// každý tah ve správném směru se započítá, otisk = průměr směrů vážený silou tahu a shodou
// s ostatními. Slabý nebo trochu ujetý tah tak výsledek jen málo ovlivní, místo aby se zahodil.
// Výchozí (nulové) otisky nemají směr — tah se pak jen nesmí podobat opačnému směru dvojice.
const refOf = (k) => (norm(cfg.tpl[k]) > 1e-6 ? cfg.tpl[k] : cfg.tpl[k ^ 1].map((x) => -x));

class Enrollment {
  constructor(dirs) {
    this.dirs = dirs;
    this.st = Object.fromEntries(dirs.map((k) => [k, []])); // tahy: { v, peak }
  }

  // Vážený průměr směrů; váha = síla tahu × (shoda s průměrem)^4, dva průchody.
  static mean(strokes) {
    let m = unit(strokes.reduce((a, s) => a.map((x, i) => x + s.v[i] * s.peak), new Array(9).fill(0)));
    const w = strokes.map((s) => s.peak * Math.max(0, cos(s.v, m)) ** 4);
    m = unit(strokes.reduce((a, s, j) => a.map((x, i) => x + s.v[i] * w[j]), new Array(9).fill(0)));
    const sw = w.reduce((a, b) => a + b, 0) || 1;
    return { dir: m, peak: strokes.reduce((a, s, j) => a + s.peak * w[j], 0) / sw };
  }

  add(stroke) {
    const s = moving(stroke);
    if (s.length < 5) return { ok: false, msg: 'Moc krátký pohyb, zkus ho podržet chvilku déle' };
    let v = principal(s);
    if (s.reduce((a, d) => a + dot(d, v), 0) < 0) v = v.map((x) => -x);
    const peak = Math.max(...s.map((d) => dot(d, v)));
    if (peak < 1.0) return { ok: false, msg: 'Moc slabý pohyb, dotáhni ho víc' };
    // Dvojice: tah patří k tomu směru, jehož dosavadní otisk mu je podobnější.
    // Zmáčknutí se nekontroluje proti znaménku — do které poloviny Tz patří, určí templates().
    const k = this.dirs.reduce((b, k2) => (cos(v, refOf(k2)) > cos(v, refOf(b)) ? k2 : b));
    if (k !== 4 && cos(v, refOf(k)) < 0) return { k, ok: false, msg: `Opačný směr než „${DIRS[k]}“` };
    const st = this.st[k];
    if (st.length >= STROKES_NEEDED) return { k, ok: false, msg: `„${DIRS[k]}“ je hotové, teď druhý směr` };
    const c = st.length ? cos(v, Enrollment.mean(st).dir) : 1;
    if (c < 0.6) return { k, ok: false, msg: `Úplně jiný pohyb než předtím (shoda ${Math.round(c * 100)} %)` };
    st.push({ v, peak });
    return { k, ok: true, msg: `Tah ${st.length} z ${STROKES_NEEDED}: shoda ${Math.round(c * 100)} %, síla ${peak.toFixed(1)} mT` };
  }

  fill(k) { return Math.min(1, this.st[k].length / STROKES_NEEDED); }

  get done() { return this.dirs.every((k) => this.fill(k) >= 1); }

  // Otisk = průměrný směr × průměrná síla tahu -> běžný plný tah = plná výchylka osy.
  templates() {
    return Object.fromEntries(this.dirs.map((k) => {
      const { dir, peak } = Enrollment.mean(this.st[k]);
      const t = dir.map((x) => x * peak);
      return [k === 4 && cos(t, PRESS_REF) < 0 ? 5 : k, t];
    }));
  }
}

function applyTemplates(tpl) {
  const lines = Object.entries(tpl).map(([k, t]) => {
    cfg.tpl[k] = t;
    return `tpl ${k} ${t.map((x) => x.toFixed(4)).join(' ')}`;
  });
  // Zmáčknutí: zapnout naučenou polovinu Tz, druhou vynulovat a vypnout.
  for (const slot of [4, 5].filter((k) => k in tpl)) {
    const other = slot ^ 1;
    cfg.tpl[other] = new Array(9).fill(0);
    cfg.lock = (cfg.lock | (1 << other)) & ~(1 << slot);
    lines.push(`tpl ${other} 0 0 0 0 0 0 0 0 0`, `lock ${cfg.lock}`);
  }
  send(...lines, 'save', 'get');
}

// --- Dialog učení (bez časovače, plní se tahy) -------------------------------------
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let cancelEnroll = null;

function openDialog(step, title, text) {
  $('overlay').hidden = false;
  $('dlgStep').textContent = step;
  $('dlgTitle').textContent = title;
  $('dlgText').textContent = text;
  $('dlgRings').innerHTML = '';
  $('dlgMsg').textContent = '';
  $('dlgMsg').className = 'msg';
  $('dlgGo').hidden = true;
  $('dlgCancel').hidden = false;
}
function finish(text) {
  $('dlgText').textContent = text;
  $('dlgGo').hidden = false;
  $('dlgGo').textContent = 'Zavřít';
  $('dlgGo').onclick = closeDialog;
  $('dlgCancel').hidden = true;
  $('dlgGo').focus();
}
function closeDialog() {
  recorder = null;
  if (cancelEnroll) cancelEnroll();
  $('overlay').hidden = true;
}
$('dlgCancel').onclick = closeDialog;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('overlay').hidden) closeDialog(); });

const RING = 2 * Math.PI * 60;
function renderRings(enr, hit) {
  $('dlgRings').innerHTML = enr.dirs.map((k) => {
    const f = enr.fill(k);
    return `<figure class="ring${f >= 1 ? ' full' : ''}${k === hit ? ' hit' : ''}">
      <div class="wrap"><svg viewBox="0 0 132 132"><circle cx="66" cy="66" r="60" class="track"/>
        <circle cx="66" cy="66" r="60" class="fill" stroke-dasharray="${RING * f} ${RING}"${f ? '' : ' stroke-opacity="0"'}/></svg>
        <div class="icon">${iconSvg(k)}</div></div>
      <figcaption>${DIRS[k]}</figcaption><div class="pct">${f >= 1 ? 'hotovo' : `${enr.st[k].length} z ${STROKES_NEEDED} tahů`}</div></figure>`;
  }).join('');
}

// Sbírá tahy, dokud se všechny kruhy nenaplní. Vrací true = hotovo, false = zrušeno.
function enroll(enr, step, title, text) {
  openDialog(step, title, text);
  renderRings(enr);
  return new Promise((resolve) => {
    cancelEnroll = () => { cancelEnroll = null; resolve(false); };
    recorder = strokeDetector((s) => {
      const r = enr.add(s);
      $('dlgMsg').textContent = r.msg;
      $('dlgMsg').className = 'msg ' + (r.ok ? 'good' : 'bad');
      renderRings(enr, r.k);
      if (enr.done) {
        recorder = null;
        cancelEnroll = null;
        resolve(true);
      }
    });
  });
}

async function teachOne(k) {
  if (!cfg || !connected) return;
  const enr = new Enrollment([k]);
  const text = 'Udělej pohyb tak, jak ho děláš normálně, a pusť knoflík do klidu. Opakuj, dokud se kruh nenaplní.';
  if (!(await enroll(enr, 'Naučit pohyb', DIRS[k], text))) return;
  applyTemplates(enr.templates());
  finish('Naučeno a uloženo do myši. Zkus pohyb: svítit má jen tahle šipka.');
}

$('wizard').onclick = async () => {
  if (!cfg || !connected) return;
  const tpl = {};
  for (let i = 0; i < WIZARD.length; i++) {
    const step = WIZARD[i];
    const enr = new Enrollment(step.dirs);
    if (!(await enroll(enr, `Krok ${i + 1} ze ${WIZARD.length}`, step.text, 'Po každém tahu pusť knoflík do klidu.'))) return;
    Object.assign(tpl, enr.templates());
    await wait(700);
  }
  applyTemplates(tpl);
  finish('Všechny pohyby jsou naučené a uložené v myši.');
};

$('cal').onclick = () => {
  if (!connected) return;
  openDialog('Kalibrace klidu', 'Pusť knoflík', 'Nesahej na myš, dokud LED nedoběhne modrý kruh.');
  $('dlgGo').hidden = false;
  $('dlgGo').textContent = 'Začít';
  $('dlgGo').onclick = async () => {
    $('dlgGo').hidden = true;
    send('cal');
    await wait(2500);
    finish('Hotovo, klid je nastavený.');
  };
};

// --- Podstránka Tlačítka -----------------------------------------------------------
// Nastavení drží ikonka v liště (tlacitka.json), stránka ho jen upravuje.
let btnCfg = null;            // { default: {left, right}, apps: { exe: {name, left, right} } }
let presets = { obecne: [], programy: {} };
let selApp = 'default';
let recording = null;         // 'left' | 'right' při nahrávání zkratky
const NONE = { label: 'Nic', keys: '' };
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
fetch('predvolby.json').then((r) => r.json()).then((p) => { presets = p; renderButtons(); });

$('tabTune').onclick = () => showView(false);
$('tabBtns').onclick = () => showView(true);
function showView(buttons) {
  document.querySelector('.app').classList.toggle('buttons', buttons);
  $('btnView').hidden = !buttons;
  $('tabTune').classList.toggle('on', !buttons);
  $('tabBtns').classList.toggle('on', buttons);
  if (buttons) send('tray buttons-get');
}

function saveButtons() {
  send('tray buttons-set ' + JSON.stringify(btnCfg));
}

// Název klávesy pro člověka: "Ctrl+D0" -> Ctrl 0, "Decimal" -> Num .
const KEY_TEXT = { Return: 'Enter', Escape: 'Esc', Back: 'Backspace', Decimal: 'Num .', Add: 'Num +', Subtract: 'Num −',
  Multiply: 'Num ×', Divide: 'Num ÷', MediaPlayPause: 'Přehrát/pauza', VolumeMute: 'Ztlumit', VolumeUp: 'Hlasitost +',
  VolumeDown: 'Hlasitost −', MediaNextTrack: 'Další skladba', MediaPreviousTrack: 'Předchozí skladba', Left: '←', Right: '→', Up: '↑', Down: '↓' };
const keyText = (k) => KEY_TEXT[k] || k.replace(/^D(\d)$/, '$1').replace(/^NumPad(\d)$/, 'Num $1').replace(/^Oem/, '');
const kbd = (keys) => {
  if (!keys) return 'nic';
  // funkce Fusionu bez zkratky provede doplněk CadMouseNav přes API
  if (keys.startsWith('Fusion:')) return `<kbd>Fusion</kbd> ${esc(keys.slice(7))} přes doplněk`;
  return keys.split('+').map((k) => `<kbd>${keyText(k)}</kbd>`).join('');
};

// Kód klávesy z prohlížeče -> název podle System.Windows.Forms.Keys (to umí ikonka poslat).
function keyName(e) {
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit\d$/.test(c)) return 'D' + c.slice(5);
  if (/^F\d+$/.test(c)) return c;
  if (/^Numpad\d$/.test(c)) return 'NumPad' + c.slice(6);
  const map = { NumpadDecimal: 'Decimal', NumpadAdd: 'Add', NumpadSubtract: 'Subtract', NumpadMultiply: 'Multiply',
    NumpadDivide: 'Divide', NumpadEnter: 'Return', Enter: 'Return', Escape: 'Escape', Tab: 'Tab', Space: 'Space',
    Backspace: 'Back', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Minus: 'OemMinus', Equal: 'Oemplus',
    Comma: 'Oemcomma', Period: 'OemPeriod', Slash: 'OemQuestion', Semicolon: 'OemSemicolon', Quote: 'OemQuotes',
    BracketLeft: 'OemOpenBrackets', BracketRight: 'OemCloseBrackets', Backslash: 'OemPipe', Backquote: 'Oemtilde' };
  return map[c] || null;
}

document.addEventListener('keydown', (e) => {
  if (!recording) return;
  e.preventDefault();
  const k = keyName(e);
  if (!k) return; // samotný Ctrl/Shift/Alt — čekáme na hlavní klávesu
  const mods = [e.ctrlKey && 'Ctrl', e.shiftKey && 'Shift', e.altKey && 'Alt', e.metaKey && 'Win'].filter(Boolean);
  const keys = [...mods, k].join('+');
  appCfg()[recording] = { label: 'Vlastní zkratka', keys };
  recording = null;
  saveButtons();
  renderButtons();
});

const appCfg = () => (selApp === 'default' ? btnCfg.default : btnCfg.apps[selApp]);

// Ikonka myši s rozsvíceným bočním tlačítkem (levé / pravé).
const mouseIcon = (side) => `<svg viewBox="0 0 92 62">
  <rect x="10" y="26" width="72" height="30" rx="12" fill="#2a2e34" stroke="#474d55"/>
  <rect x="26" y="8" width="40" height="24" rx="10" fill="#353a41" stroke="#59606a"/>
  <rect x="${side === 'left' ? 4 : 82}" y="36" width="6" height="12" rx="2" fill="${'#e5322d'}"/>
  <rect x="${side === 'left' ? 82 : 4}" y="36" width="6" height="12" rx="2" fill="#474d55"/></svg>`;

function renderButtons() {
  if (!btnCfg) return;
  // program s doporučeným mapováním (Blender), který ho ještě nemá -> doplnit
  const preset = presets.programy[selApp];
  const a = btnCfg.apps[selApp];
  if (preset && a && ((preset.map && !a.map) || (preset.press && !a.press))) {
    if (preset.map && !a.map) a.map = preset.map.slice();
    if (preset.press && !a.press) a.press = Object.assign({}, preset.press);
    saveButtons();
  }
  // starší uložení mělo zmáčknutí i v map -> poslalo by se dvakrát; teď ho řídí jen press
  if (a && a.press && a.map && a.map.some((v) => Math.abs(v) === 3)) {
    a.map = a.map.map((v) => (Math.abs(v) === 3 ? 0 : v));
    saveButtons();
  }
  renderZoom();
  renderAxMap();
  if (selApp !== 'default' && !btnCfg.apps[selApp]) selApp = 'default';
  // seznam programů
  const items = [['default', 'Všechny ostatní programy', 'když program nemá vlastní nastavení']]
    .concat(Object.entries(btnCfg.apps).map(([exe, a]) => [exe, a.name, exe + '.exe']));
  $('appList').innerHTML = items.map(([id, name, sub]) =>
    `<button class="appitem${id === selApp ? ' on' : ''}" data-id="${esc(id)}">${esc(name)}<small>${esc(sub)}</small></button>`).join('');
  $('appList').querySelectorAll('.appitem').forEach((b) => { b.onclick = () => { selApp = b.dataset.id; recording = null; renderButtons(); }; });
  // editor
  const cfgApp = appCfg();
  $('edTitle').textContent = selApp === 'default' ? 'Všechny ostatní programy' : cfgApp.name;
  $('edExe').textContent = selApp === 'default' ? '' : selApp + '.exe';
  $('appDel').hidden = selApp === 'default';
  const own = (presets.programy[selApp] || {}).akce || [];
  $('btnCards').innerHTML = ['left', 'right'].map((side) => {
    const a = cfgApp[side] || NONE;
    const opt = (x) => `<option value="${x.keys}"${x.keys === a.keys ? ' selected' : ''}>${x.label}</option>`;
    const known = [NONE, ...presets.obecne, ...own].some((x) => x.keys === a.keys);
    return `<div class="btncard" data-side="${side}">
      <div class="top">${mouseIcon(side)}<h3>${side === 'left' ? 'Levé tlačítko' : 'Pravé tlačítko'}</h3></div>
      <select aria-label="Akce">
        ${opt(NONE)}
        ${own.length ? `<optgroup label="${cfgApp.name || ''}">${own.map(opt).join('')}</optgroup>` : ''}
        <optgroup label="Obecné akce">${presets.obecne.map(opt).join('')}</optgroup>
        ${known ? '' : `<optgroup label="Vlastní">${opt(a)}</optgroup>`}
      </select>
      <div class="keyrow"><div class="keys${recording === side ? ' rec' : ''}">${recording === side ? 'Zmáčkni zkratku na klávesnici…' : kbd(a.keys)}</div>
        <button data-rec>${recording === side ? 'Zrušit' : 'Nahrát vlastní'}</button></div>
    </div>`;
  }).join('');
  $('btnCards').querySelectorAll('.btncard').forEach((card) => {
    const side = card.dataset.side;
    card.querySelector('select').onchange = (e) => {
      const all = [NONE, ...presets.obecne, ...own];
      cfgApp[side] = all.find((x) => x.keys === e.target.value) || NONE;
      saveButtons();
      renderButtons();
    };
    card.querySelector('[data-rec]').onclick = () => { recording = recording === side ? null : side; renderButtons(); };
  });
}

// Pohyb v programu: přemapování os, které myš pošle programu (např. Blender: náklony = posun).
// map = 6 čísel pro výstupní osy Tx,Ty,Tz,Rx,Ry,Rz: ±zdroj 1..6 (minus = obráceně), 0 = nic.
// Zmáčknutí má vlastní nastavení press = { to: ±osa (0 = vypnuto), flip: s tlačítkem obráceně }:
// myš ho k výstupní ose přičte, takže se může sdílet s jiným pohybem (zoom v Blenderu = dopředu).
// „Obrátit“ je vždy proti výchozímu nastavení programu (Blender má výchozí už správně).
const AX_SRC = [[4, 'Dopředu / dozadu'], [5, 'Doprava / doleva'], [6, 'Otáčení'], [3, 'Zmáčknutí']];
const AX_DST = [[-1, 'Beze změny'], [1, 'Posun do stran'], [2, 'Posun dopředu / dozadu'], [3, 'Posun nahoru / dolů'],
  [4, 'Naklápění (rotace kolem X)'], [5, 'Naklápění do stran (rotace kolem Y)'], [6, 'Otáčení (rotace kolem Z)'], [0, 'Vypnuto']];
const IDENT = [1, 2, 3, 4, 5, 6];
const base = () => {
  const p = presets.programy[selApp] || {};
  return { map: p.map || IDENT, press: p.press || { to: 3, flip: false } };
};
// znaménko, které má dvojice zdroj -> cíl ve výchozím nastavení (+1, když tam výchozí nevede)
function baseSign(src, dst) {
  const b = base();
  if (src === 3) return Math.abs(b.press.to) === dst ? Math.sign(b.press.to) : 1;
  const t = b.map.findIndex((v) => Math.abs(v) === src);
  return t + 1 === dst ? Math.sign(b.map[t]) : 1;
}

function renderAxMap() {
  // Fusion řídí doplněk (mapování se neuplatní), u „ostatních programů“ se nic nemapuje
  const box = $('axBox');
  box.hidden = selApp === 'default' || selApp === 'fusion360';
  if (box.hidden) return;
  const app = btnCfg.apps[selApp];
  const map = app.map || base().map;
  const press = app.press || base().press;
  $('axRows').innerHTML = AX_SRC.map(([src, name]) => {
    let to;
    if (src === 3) to = press.to;
    else { const t = map.findIndex((v) => Math.abs(v) === src); to = t < 0 ? 0 : (t + 1) * Math.sign(map[t]); }
    const dstAbs = Math.abs(to);
    const dst = dstAbs === 0 ? 0 : (dstAbs === src ? -1 : dstAbs);
    const inv = dstAbs > 0 && Math.sign(to) !== baseSign(src, dstAbs);
    const extra = src === 3
      ? `<label><input type="checkbox" data-flip${press.flip ? ' checked' : ''}${dstAbs ? '' : ' disabled'}> S podrženým tlačítkem opačně (oddálit)</label>` : '';
    return `<div class="axmap${src === 3 ? ' press' : ''}" data-src="${src}"><span>${name}</span>
      <select>${AX_DST.map(([v, l]) => `<option value="${v}"${v === dst ? ' selected' : ''}>${l}</option>`).join('')}</select>
      <label><input type="checkbox" data-inv${inv ? ' checked' : ''}${dstAbs ? '' : ' disabled'}> Obrátit</label>${extra}</div>`;
  }).join('');
  $('axRows').querySelectorAll('select, input').forEach((el) => { el.onchange = saveAxMap; });
}

function saveAxMap() {
  const map = [0, 0, 0, 0, 0, 0];
  const app = btnCfg.apps[selApp];
  $('axRows').querySelectorAll('.axmap').forEach((row) => {
    const src = +row.dataset.src;
    let dst = +row.querySelector('select').value;
    if (dst === -1) dst = src;
    const sign = dst ? baseSign(src, dst) * (row.querySelector('[data-inv]').checked ? -1 : 1) : 0;
    if (src === 3) app.press = { to: dst * sign, flip: row.querySelector('[data-flip]').checked };
    else if (dst > 0) map[dst - 1] = src * sign;
  });
  app.map = map;
  saveButtons();
  renderAxMap();
}

// Zoom ve Fusionu (čte doplněk CadMouseNav z nastavení ikonky); výchozí = jako dřív.
const zoomCfg = () => Object.assign({ off: false, modLeft: true, modRight: true, invert: false, speed: 1 }, btnCfg.zoom || {});
// Rychlost pohybu ve Fusionu (násobí otáčení i zoom v doplňku). Citlivost myši to neovlivní:
// ta končí na plné výchylce osy, rychlost kamery nad tím určuje až doplněk.
$('fSpeed').oninput = (e) => {
  btnCfg.zoom = zoomCfg();
  btnCfg.zoom.speed = +e.target.value;
  $('fSpeedV').textContent = btnCfg.zoom.speed.toFixed(1) + '×';
  clearTimeout(fSpeedTimer);
  fSpeedTimer = setTimeout(saveButtons, 300);
};
let fSpeedTimer = 0;
function renderZoom() {
  // zoom řídí doplněk Fusionu, takže nastavení dává smysl jen u Fusionu
  document.querySelector('.zoombox').hidden = selApp !== 'fusion360';
  const z = zoomCfg();
  $('zOn').checked = !z.off;
  $('zLeft').checked = z.modLeft;
  $('zRight').checked = z.modRight;
  $('zInv').checked = z.invert;
  if (document.activeElement !== $('fSpeed')) $('fSpeed').value = z.speed;
  $('fSpeedV').textContent = (+z.speed).toFixed(1) + '×';
  document.querySelector('.zoombox').classList.toggle('off', z.off);
}
for (const [id, key, neg] of [['zOn', 'off', true], ['zLeft', 'modLeft'], ['zRight', 'modRight'], ['zInv', 'invert']]) {
  $(id).onchange = (e) => {
    btnCfg.zoom = zoomCfg();
    btnCfg.zoom[key] = neg ? !e.target.checked : e.target.checked;
    saveButtons();
    renderZoom();
  };
}

$('appDel').onclick = () => {
  if (selApp === 'default' || !confirm(`Odebrat nastavení pro ${btnCfg.apps[selApp].name}?`)) return;
  delete btnCfg.apps[selApp];
  selApp = 'default';
  saveButtons();
  renderButtons();
};
$('appAdd').onclick = () => send('tray apps');
$('pickCancel').onclick = () => { $('pickOverlay').hidden = true; };

function showPicker(running) {
  const known = Object.entries(presets.programy).map(([exe, p]) => ({ exe, name: p.name }));
  const row = (a) => `<button data-exe="${esc(a.exe)}" data-name="${esc(a.name)}">${esc(a.name)}<small>${esc(a.exe)}.exe</small></button>`;
  const free = (list) => list.filter((a) => !btnCfg.apps[a.exe]);
  $('pickList').innerHTML = `<h4>S přednastavením</h4>${free(known).map(row).join('') || '<small>všechny už máš</small>'}
    <h4>Právě běží</h4>${free(running.filter((a) => !presets.programy[a.exe])).map(row).join('')}`;
  $('pickList').querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      btnCfg.apps[b.dataset.exe] = { name: b.dataset.name, left: NONE, right: NONE };
      selApp = b.dataset.exe;
      $('pickOverlay').hidden = true;
      saveButtons();
      renderButtons();
    };
  });
  $('pickOverlay').hidden = false;
}

// živé zvýraznění karty, když tlačítko na myši držíš
function liveButtons() {
  document.querySelectorAll('.btncard').forEach((c) => c.classList.toggle('live', !!(btnBits & (c.dataset.side === 'left' ? 1 : 2))));
}

// --- Grafy senzorů -------------------------------------------------------------
const HIST = 600;
const SENSORS = ['Senzor dole', 'Senzor vlevo', 'Senzor vpravo'];
const COLORS = ['#e0645e', '#6dbf73', '#5a8fe8'];
const hist = Array.from({ length: 9 }, () => new Float32Array(HIST));
let head = 0;
const graphs = SENSORS.map((name) => {
  const box = document.createElement('div');
  box.className = 'graph';
  box.innerHTML = `<div class="t"><h2>${name}</h2><span class="lx">x</span><span class="ly">y</span><span class="lz">z</span></div><canvas></canvas>`;
  $('graphs').appendChild(box);
  return box.querySelector('canvas');
});

function pushGraphs(d) {
  for (let i = 0; i < 9; i++) hist[i][head] = d[i];
  head = (head + 1) % HIST;
}

function drawGraphs() {
  graphs.forEach((cv, s) => {
    const w = cv.clientWidth, h = cv.clientHeight;
    const pw = Math.round(w * devicePixelRatio), ph = Math.round(h * devicePixelRatio);
    if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
    const g = cv.getContext('2d');
    g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    g.clearRect(0, 0, w, h);
    let m = 0.5;
    for (let c = 0; c < 3; c++) for (const v of hist[s * 3 + c]) m = Math.max(m, Math.abs(v));
    g.strokeStyle = '#30353b';
    g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
    g.fillStyle = '#8e939a';
    g.font = '11px "Segoe UI", sans-serif';
    g.fillText(`±${m.toFixed(1)} mT`, 2, 11);
    for (let c = 0; c < 3; c++) {
      const a = hist[s * 3 + c];
      g.strokeStyle = COLORS[c];
      g.lineWidth = 1.4;
      g.beginPath();
      for (let i = 0; i < HIST; i++) {
        const v = a[(head + i) % HIST];
        const x = (i / (HIST - 1)) * w, y = h / 2 - (v / m) * (h / 2 - 4);
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
    }
  });
}

// --- 3D scéna -------------------------------------------------------------------
const sceneEl = $('scene');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
sceneEl.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#1d2024');
scene.fog = new THREE.Fog('#1d2024', 13, 24);
const rim = new THREE.DirectionalLight('#dfe4ee', 0.55); // chladné protisvětlo obkreslí oblé hrany
rim.position.set(-4, 3, -5);
scene.add(rim);
const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
camera.position.set(5.0, 6.2, 6.6);
camera.lookAt(0, 0.35, 0);
scene.add(new THREE.HemisphereLight('#ffffff', '#2a2e34', 1.1));
const sun = new THREE.DirectionalLight('#ffffff', 1.7);
sun.position.set(3, 6, 4);
scene.add(sun);
const grid = new THREE.GridHelper(10, 20, '#353a41', '#272b30');
grid.position.y = -0.62;
scene.add(grid);

// Skutečné díly myši ze STL (sestava v mm, Z nahoru). Knoflík se naklání kolem pružiny (~Z 10 mm).
const MM = 1 / 25, PIVOT_Z = 10;
const mouse = new THREE.Group();
mouse.rotation.x = -Math.PI / 2;      // Z nahoru -> Y nahoru
mouse.scale.setScalar(MM);
mouse.position.y = -0.62;             // spodek myši na mřížce
scene.add(mouse);
const knob = new THREE.Group();       // otočný bod knoflíku
knob.position.z = PIVOT_Z;
mouse.add(knob);
const pla = new THREE.MeshStandardMaterial({ color: '#4a4f57', roughness: 0.5, metalness: 0.2 });
const shell = new THREE.MeshStandardMaterial({ color: '#363a41', roughness: 0.65, metalness: 0.1 });
const ledMat = new THREE.MeshStandardMaterial({ color: '#e5322d', emissive: '#e5322d', emissiveIntensity: 1.4, roughness: 0.4 });
const stl = new STLLoader();
function loadPart(file, mat, parent, dz = 0) {
  stl.load('model/' + file, (geo) => {
    const g = toCreasedNormals(geo, Math.PI / 5); // hladké oblé plochy, ostré hrany zůstanou
    const m = new THREE.Mesh(g, mat);
    m.position.z = dz;
    parent.add(m);
  });
}
// LED svítí na knoflík zespodu ze štěrbiny kolem něj
const ledLight = new THREE.PointLight('#e5322d', 6, 3, 1.2);
ledLight.position.z = 22;
mouse.add(ledLight);
loadPart('base-top.stl', shell, mouse);
loadPart('diffuser.stl', ledMat, mouse);
// Knoflík je vytažený nad svítící štěrbinu jako na hotové myši (STL je v pozici k tisku níž).
const KNOB_LIFT = 22;
loadPart('knob.stl', pla, knob, KNOB_LIFT - PIVOT_Z);
// Tečka na víčku u předního okraje — knoflík je kulatý, bez ní by otáčení nebylo vidět.
const dot3d = new THREE.Mesh(new THREE.SphereGeometry(2.4, 24, 12), new THREE.MeshStandardMaterial({ color: '#ecebe8', roughness: 0.35 }));
dot3d.position.set(0, -15, 32 + KNOB_LIFT - PIVOT_Z - 0.9);
knob.add(dot3d);
// Boční tlačítka: STL je pravé (+X), levé je stejný díl otočený o 180°.
const sideBtns = [Math.PI, 0].map((rot) => {
  const g = new THREE.Group();
  g.rotation.z = rot;
  mouse.add(g);
  loadPart('side-button.stl', pla, g);
  return g;
});

// Osy v rohu scény (nepřekrývají model), natočené stejně jako kamera.
const gizmoScene = new THREE.Scene();
const gizmoCam = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10);
const gizmo = new THREE.Group();
gizmoScene.add(gizmo);
function axisLabel(text, color, pos) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = color;
  g.font = '600 40px "Segoe UI", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 32, 34);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
  s.position.copy(pos);
  s.scale.setScalar(0.55);
  gizmo.add(s);
}
for (const [dir, color, name] of [[[1, 0, 0], '#e0645e', 'X'], [[0, 1, 0], '#6dbf73', 'Y'], [[0, 0, 1], '#5a8fe8', 'Z']]) {
  const v = new THREE.Vector3(...dir);
  gizmo.add(new THREE.ArrowHelper(v, new THREE.Vector3(), 0.95, color, 0.22, 0.13));
  axisLabel(name, color, v.clone().multiplyScalar(1.25));
}
const GIZMO_PX = 130;

function resize() {
  const w = sceneEl.clientWidth, h = sceneEl.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(sceneEl);

// Myš -> díl v souřadnicích sestavy (X doprava, Y dozadu?, Z nahoru). Znaménka Rx a Rz ověřena rukou.
function pose() {
  const [, , tz, rx, ry, rz] = live.map((v) => v / LIMIT);
  knob.position.z = PIVOT_Z - Math.max(0, pressSign() * tz) * 3; // zmáčknutí = 3 mm dolů
  // stisk bočního tlačítka = zajede 1,5 mm dovnitř (levé je otočené, proto +X)
  sideBtns[0].position.x = btnBits & 1 ? 1.5 : 0;
  sideBtns[1].position.x = btnBits & 2 ? -1.5 : 0;
  knob.rotation.set(-rx * 0.35, ry * 0.35, rz * 0.8);
}

function frame() {
  pose();
  const w = sceneEl.clientWidth, h = sceneEl.clientHeight;
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, w, h);
  renderer.render(scene, camera);
  // osy vlevo dole: stejná orientace jako kamera, vlastní malý výřez
  gizmoCam.position.copy(camera.position).sub(new THREE.Vector3(0, 0.1, 0)).setLength(4);
  gizmoCam.lookAt(0, 0, 0);
  renderer.autoClear = false;
  renderer.clearDepth();
  renderer.setScissorTest(true);
  renderer.setScissor(8, 8, GIZMO_PX, GIZMO_PX);
  renderer.setViewport(8, 8, GIZMO_PX, GIZMO_PX);
  renderer.render(gizmoScene, gizmoCam);
  renderer.autoClear = true;
  renderAxes();
  liveCompass();
  liveButtons();
  drawGraphs();
  requestAnimationFrame(frame);
}

// Self-check učení: otevři stránku s ?test, výsledek je v konzoli.
if (location.search.includes('test')) {
  const t = [1, 0, 2, 0, -1, 0, 0, 3, 0], u = t.map((x) => -x * 0.5);
  cfg = { tpl: Array.from({ length: 12 }, (_, k) => (k === 6 ? t : k === 7 ? u : new Array(9).fill(k === 4 ? 0 : 1))) };
  // klidový šum ~0,12 mT na kanál jako u skutečné myši (deterministický)
  let seed = 1;
  const noise = () => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647 - 0.5) * 0.42; };
  const stroke = (v, amp) => {
    const s = [];
    for (let i = 0; i < 15; i++) s.push(new Array(9).fill(0).map(noise));
    for (let i = 0; i <= 30; i++) s.push(v.map((x) => x * amp * Math.sin((Math.PI * i) / 30) + noise()));
    for (let i = 0; i < 15; i++) s.push(new Array(9).fill(0).map(noise));
    return s;
  };
  const feed = (enr, strokes) => {
    const log = [];
    const det = strokeDetector((s) => log.push(enr.add(s)));
    strokes.forEach((s) => s.forEach(det));
    return log;
  };
  const rest = new Enrollment([6]);
  console.assert(feed(rest, [stroke(t, 0), stroke(t, 0), stroke(t, 0)]).length === 0, 'samotný šum nesmí vytvořit tah');
  const one = new Enrollment([6]);
  const l1 = feed(one, [stroke(t, 1), stroke(u, 2), stroke(t, 0.4), stroke(t, 1), stroke(t, 0.9), stroke(t, 1)]);
  console.assert(l1.length === 6 && !l1[1].ok, 'každý tah se pozná, opačný se nepočítá', l1);
  console.assert(one.done && cos(one.templates()[6], t) > 0.995, 'jeden směr: 5 tahů = hotovo, vážený průměr', one.st, l1);
  const pair = new Enrollment([6, 7]);
  feed(pair, [1, 2, 3, 4, 5].flatMap(() => [stroke(t, 1), stroke(u, 1)]));
  const tp = pair.templates();
  console.assert(pair.done && cos(tp[6], t) > 0.995 && cos(tp[7], u) > 0.995, 'dvojice: tahy rozdělené na ±', pair.st);
  // zmáčknutí: naučí se v obou znaménkách, polovinu Tz určí směr vůči PRESS_REF
  for (const [sig, slot] of [[PRESS_REF, 4], [PRESS_REF.map((x) => -x), 5]]) {
    const prs = new Enrollment([4]);
    feed(prs, [1, 2, 3, 4, 5].map(() => stroke(sig, 3)));
    console.assert(prs.done && Object.keys(prs.templates())[0] === String(slot), 'zmáčknutí → slot ' + slot, prs.st, prs.templates());
  }
  console.log('self-check učení hotov');
  cfg = null;
}

buildCompass();
drawCompass();
resize();
connect();
requestAnimationFrame(frame);
