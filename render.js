// render.js —— 三种底部视图: 色块 / 钢琴卷帘 / 五线谱
// 统一接口: renderView(container, voices, mode) -> update(activeIdxPerVoice, beat)
//   voices: [{ label, color, model }]   model 为 parseMelody 结果
//   update([i0,i1,...], beat) 每帧调用: 高亮各声部当前音, 并按视图各自的方式滚动
//     - 色块 / 钢琴卷帘: 跟随播放头连续平滑滚动
//     - 五线谱: 一屏一屏翻页

const SVGNS = 'http://www.w3.org/2000/svg';
const LETTER_STEP = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };

function svg(tag, attrs, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
function hdiv(cls, parent) {
  const e = document.createElement('div');
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

// 小节线位置(拍): 固定拍数 + 挂拍偏移(第一小节可不完整); barBeats<=0 时回退到手写 |
function barPositions(opts, voices, totalBeats) {
  const o = opts || {};
  const bb = o.barBeats || 0;
  if (bb <= 0) return (voices[0] && voices[0].model.bars) || [];
  const pickup = ((((o.pickup || 0) % bb) + bb) % bb); // 规范到 [0, bb)
  const first = pickup > 0 ? pickup : bb;              // 第一条小节线: 挂拍处, 或一个整小节后
  const out = [];
  for (let b = first; b < totalBeats - 1e-6; b += bb) out.push(b);
  return out;
}

// 分段恒速: 拍位 -> 从第 0 拍起的秒数 (与 audio.js 同款, 支持中途变速)
function beatToTime(tempos, beat) {
  let t = 0;
  for (let i = 0; i < tempos.length; i++) {
    const seg = tempos[i], next = tempos[i + 1];
    if (beat <= seg.beat) break;
    const segEnd = next ? next.beat : Infinity;
    t += (Math.min(beat, segEnd) - seg.beat) * (60 / seg.bpm);
    if (beat <= segEnd) break;
  }
  return t;
}

// 把各声部按"时间"重排: 用每个声部自己的速度表把拍位换算成"展示拍"(= 秒 × 参考速度/60)。
//   参考速度取旋律起始速度, 这样旋律以正常宽度显示, 变慢的声部/段落自动变宽 -> 看到的=听到的。
//   所有声部共用同一时间轴, 同一时刻在同一 x, 竖直对齐即同时发声。
//   全曲同速时 displayBeat === beat, 布局与旧版完全一致(零回归)。
function displayTransform(voices) {
  const refBpm = (voices[0] && voices[0].model.tempos && voices[0].model.tempos[0] && voices[0].model.tempos[0].bpm) || 72;
  const dbOf = (tempos) => {
    const T = (tempos && tempos.length) ? tempos : [{ beat: 0, bpm: refBpm }];
    return (beat) => beatToTime(T, beat) * refBpm / 60;
  };
  const melDb = dbOf(voices[0] && voices[0].model.tempos);
  const out = voices.map((v) => {
    const db = dbOf(v.model.tempos);
    const m = v.model;
    return Object.assign({}, v, {
      model: Object.assign({}, m, {
        events: m.events.map((e) => {
          const s = db(e.startBeat), en = db(e.startBeat + e.durBeats);
          return Object.assign({}, e, { startBeat: s, durBeats: en - s, durRaw: e.durBeats });
        }),
        bars: (m.bars || []).map(db),
        totalBeats: db(m.totalBeats),
      }),
    });
  });
  return { voices: out, melDb };
}

// 高亮器: 按 data-v / data-i 切换 .active
function makeHighlight(root) {
  let prev = [];
  return function (active) {
    prev.forEach((sel) => { const e = root.querySelector(sel); if (e) e.classList.remove('active'); });
    prev = [];
    (active || []).forEach((idx, v) => {
      if (idx == null || idx < 0) return;
      const sel = `[data-v="${v}"][data-i="${idx}"]`;
      const e = root.querySelector(sel);
      if (e) { e.classList.add('active'); prev.push(sel); }
    });
  };
}

function spell(name) {
  const m = /^([A-G])(#?)(-?\d+)$/.exec(name || '');
  return m ? { letter: m[1], acc: m[2], octave: +m[3] } : null;
}
function diatonic(name) {
  const s = spell(name);
  return s ? s.octave * 7 + LETTER_STEP[s.letter] : 0;
}

/* ---------- 视图 1: 色块 (连续平滑滚动) ---------- */
function renderBlocks(container, voices, opts) {
  const UNIT = 32; // px/展示拍: 固定单位宽度 -> 按时间对齐(变慢的音符更宽)
  const totalBeats = Math.max(0, ...voices.map((v) => v.model.totalBeats));
  const bars = opts._bars || [];
  const melDb = opts._melDb || ((b) => b);
  const scroller = hdiv('scroller', container);
  const ruler = hdiv('voicerow barruler', scroller);
  hdiv('vlabel', ruler);
  const rlane = hdiv('blocklane', ruler);
  rlane.style.cssText = 'position:relative;min-height:14px;width:' + (totalBeats * UNIT) + 'px';
  const bn0 = hdiv('barnum', rlane); bn0.textContent = '1'; bn0.style.left = '2px';
  bars.forEach((b, idx) => { const bn = hdiv('barnum', rlane); bn.textContent = '' + (idx + 2); bn.style.left = (b * UNIT + 2) + 'px'; });
  voices.forEach((voice, v) => {
    const row = hdiv('voicerow', scroller);
    const tag = hdiv('vlabel', row);
    tag.textContent = voice.label; tag.style.color = voice.color;
    const lane = hdiv('blocklane', row);
    lane.style.position = 'relative';
    voice.model.events.forEach((ev, i) => {
      const b = hdiv('block' + (ev.type === 'rest' ? ' rest' : ''), lane);
      b.style.width = Math.max(3, ev.durBeats * UNIT) + 'px';
      b.style.background = ev.type === 'rest' ? 'var(--rest)' : voice.color;
      b.setAttribute('data-v', v); b.setAttribute('data-i', i);
      if (ev.srcStart != null) { b.setAttribute('data-s', ev.srcStart); b.setAttribute('data-e', ev.srcEnd); }
      b.title = ev.type === 'rest' ? `休止符 · ${ev.durRaw} 拍` : `${ev.raw} (${ev.name}) · ${ev.durRaw} 拍`;
      b.innerHTML = ev.type === 'rest'
        ? '<span class="lab">𝄽</span>'
        : `<span class="lab">${ev.raw}</span><span class="sub">${ev.name}</span>`;
    });
    bars.forEach((bl) => { const d = hdiv('barline-ov', lane); d.style.left = (bl * UNIT) + 'px'; });
  });
  const hl = makeHighlight(container);
  const ev0 = voices[0] ? voices[0].model.events : [];
  return function (active, beat) {
    hl(active);
    if (beat == null) return;
    const idx = active && active[0];
    if (idx == null || idx < 0) return;
    const ev = ev0[idx];
    const el = scroller.querySelector(`[data-v="0"][data-i="${idx}"]`);
    if (!ev || !el) return;
    const sr = scroller.getBoundingClientRect(), er = el.getBoundingClientRect();
    const contentLeft = er.left - sr.left + scroller.scrollLeft;
    const dBeat = melDb(beat);   // 真实拍 -> 展示拍(时间轴)
    const frac = ev.durBeats ? clamp((dBeat - ev.startBeat) / ev.durBeats, 0, 1) : 0;
    const x = contentLeft + frac * er.width;            // 播放头在内容坐标中的位置
    const max = scroller.scrollWidth - scroller.clientWidth;
    scroller.scrollLeft = clamp(x - scroller.clientWidth * 0.4, 0, Math.max(0, max));
  };
}

/* ---------- 视图 2: 钢琴卷帘 (连续平滑滚动 + 播放头) ---------- */
function renderPianoRoll(container, voices, opts) {
  const BW = 34, ROWH = 13, KEYW = 52;
  let lo = 127, hi = 0, totalBeats = 0;
  voices.forEach((vc) => {
    totalBeats = Math.max(totalBeats, vc.model.totalBeats);
    vc.model.events.forEach((e) => { if (e.type === 'note') { lo = Math.min(lo, e.midi); hi = Math.max(hi, e.midi); } });
  });
  if (lo > hi) { lo = 60; hi = 72; }
  lo -= 2; hi += 2;
  const H = (hi - lo + 1) * ROWH;
  const W = Math.max(totalBeats, 4) * BW;
  const yOf = (midi) => (hi - midi) * ROWH;
  const isBlack = (midi) => [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);

  const wrap = hdiv('prwrap', container);
  const keys = svg('svg', { width: KEYW, height: H, class: 'prkeys' }, wrap);
  for (let m = lo; m <= hi; m++) {
    const y = yOf(m);
    svg('rect', { x: 0, y, width: KEYW, height: ROWH, fill: isBlack(m) ? '#10131a' : '#262a36', stroke: '#0c0e14' }, keys);
    if (m % 12 === 0) svg('text', { x: KEYW - 4, y: y + ROWH - 3, 'text-anchor': 'end', fill: '#8a90a3', 'font-size': 9 }, keys).textContent = 'C' + (Math.floor(m / 12) - 1);
  }
  const scroller = hdiv('scroller prroll', wrap);
  const s = svg('svg', { width: W, height: H }, scroller);
  for (let m = lo; m <= hi; m++) svg('rect', { x: 0, y: yOf(m), width: W, height: ROWH, fill: isBlack(m) ? 'rgba(0,0,0,.22)' : 'transparent' }, s);
  svg('text', { x: 2, y: 10, fill: '#8a90a3', 'font-size': 9, 'font-family': 'sans-serif' }, s).textContent = '1';
  (opts._bars || []).forEach((b, idx) => {
    svg('line', { x1: b * BW, y1: 0, x2: b * BW, y2: H, stroke: '#5a6076', 'stroke-width': 1 }, s);
    svg('text', { x: b * BW + 2, y: 10, fill: '#8a90a3', 'font-size': 9, 'font-family': 'sans-serif' }, s).textContent = '' + (idx + 2);
  });
  voices.forEach((vc, v) => {
    vc.model.events.forEach((ev, i) => {
      if (ev.type !== 'note') return;
      const r = svg('rect', { x: ev.startBeat * BW + 1, y: yOf(ev.midi) + 1, width: Math.max(3, ev.durBeats * BW - 2), height: ROWH - 2, rx: 3, fill: vc.color, class: 'prnote', 'data-v': v, 'data-i': i }, s);
      if (ev.srcStart != null) { r.setAttribute('data-s', ev.srcStart); r.setAttribute('data-e', ev.srcEnd); }
      r.setAttribute('opacity', v === 0 ? 0.95 : 0.7);
    });
  });
  const playhead = svg('line', { x1: 0, y1: 0, x2: 0, y2: H, stroke: '#ffffff', 'stroke-width': 1.5, opacity: 0.5 }, s);

  const hl = makeHighlight(container);
  const melDb = opts._melDb || ((b) => b);
  return function (active, beat) {
    hl(active);
    if (beat == null) { playhead.setAttribute('opacity', 0); return; }
    playhead.setAttribute('opacity', 0.5);
    const x = melDb(beat) * BW;   // 真实拍 -> 展示拍(时间轴)
    playhead.setAttribute('x1', x); playhead.setAttribute('x2', x);
    const max = scroller.scrollWidth - scroller.clientWidth;
    scroller.scrollLeft = clamp(x - scroller.clientWidth * 0.4, 0, Math.max(0, max));
  };
}

/* ---------- 视图 3: 五线谱 (一屏一屏翻页 + 留白) ---------- */
function renderStaff(container, voices, opts) {
  const BW = 36, LEFT = 48, LINEGAP = 9, BAND = 96, TOP = 24;
  let totalBeats = 4;
  voices.forEach((vc) => { totalBeats = Math.max(totalBeats, vc.model.totalBeats); });

  const scroller = hdiv('scroller', container);
  const pageW = scroller.clientWidth || container.clientWidth || 800;
  const beatsPerPage = Math.max(1, Math.floor((pageW - LEFT - 40) / BW));
  const stride = beatsPerPage * BW;                 // 每屏内容宽度(整数拍)
  const pages = Math.max(1, Math.ceil(totalBeats / beatsPerPage));
  const W = LEFT + pages * stride + 16;             // 补足到整数屏 -> 末尾是空白五线谱
  const H = voices.length * BAND + 20;
  const s = svg('svg', { width: W, height: H, class: 'staff' }, scroller);
  const stepY = LINEGAP / 2;

  // 小节线: 按固定拍数, 实线贯穿所有谱表; 先画好垫在底层, 避免挡住之后的音符点击
  const barTop = TOP, barBot = TOP + (voices.length - 1) * BAND + 4 * LINEGAP;
  svg('text', { x: LEFT + 2, y: barTop - 4, fill: '#8a90a3', 'font-size': 10, 'font-family': 'sans-serif', 'pointer-events': 'none' }, s).textContent = '1';
  (opts._bars || []).forEach((b, idx) => {
    const x = LEFT + b * BW;
    svg('line', { x1: x, y1: barTop, x2: x, y2: barBot, stroke: '#aab0c4', 'stroke-width': 1.6, 'pointer-events': 'none' }, s);
    svg('text', { x: x + 2, y: barTop - 4, fill: '#8a90a3', 'font-size': 10, 'font-family': 'sans-serif', 'pointer-events': 'none' }, s).textContent = '' + (idx + 2);
  });

  voices.forEach((vc, v) => {
    const notes = vc.model.events.filter((e) => e.type === 'note');
    const med = notes.length ? notes.map((e) => e.midi).sort((a, b) => a - b)[notes.length >> 1] : 67;
    const bass = med < 57;
    const bottomLineY = TOP + v * BAND + 4 * LINEGAP;
    const refDia = bass ? 18 : 30;
    const yDia = (d) => bottomLineY - (d - refDia) * stepY;

    for (let k = 0; k < 5; k++) {                   // 五条线铺满整宽(含留白)
      const y = bottomLineY - k * LINEGAP;
      svg('line', { x1: LEFT - 8, y1: y, x2: W - 12, y2: y, stroke: '#454b5c' }, s);
    }
    svg('text', { x: 10, y: bottomLineY - LINEGAP, fill: vc.color, 'font-size': 30 }, s).textContent = bass ? '𝄢' : '𝄞';
    svg('text', { x: 8, y: bottomLineY - 4 * LINEGAP - 5, fill: vc.color, 'font-size': 10 }, s).textContent = vc.label;

    const topDia = refDia + 8, botDia = refDia;
    vc.model.events.forEach((ev, i) => {
      const x = LEFT + ev.startBeat * BW + 6;
      if (ev.type === 'rest') {
        const g = svg('g', { class: 'srest', 'data-v': v, 'data-i': i }, s);
        if (ev.srcStart != null) { g.setAttribute('data-s', ev.srcStart); g.setAttribute('data-e', ev.srcEnd); }
        svg('rect', { x: x - 6, y: bottomLineY - 2 * LINEGAP - 9, width: 20, height: 20, fill: 'transparent' }, g);
        svg('rect', { x: x + 2, y: bottomLineY - 2 * LINEGAP - 2, width: 9, height: 4, fill: '#6b7180' }, g);
        return;
      }
      const d = diatonic(ev.name);
      const y = yDia(d);
      const g = svg('g', { class: 'snote', 'data-v': v, 'data-i': i }, s);
      if (ev.srcStart != null) { g.setAttribute('data-s', ev.srcStart); g.setAttribute('data-e', ev.srcEnd); }
      svg('rect', { x: x - 8, y: y - 8, width: 16, height: 16, fill: 'transparent' }, g);
      if (d > topDia) for (let dd = topDia + 2; dd <= d; dd += 2) svg('line', { x1: x - 7, y1: yDia(dd), x2: x + 7, y2: yDia(dd), stroke: '#454b5c' }, g);
      if (d < botDia) for (let dd = botDia - 2; dd >= d; dd -= 2) svg('line', { x1: x - 7, y1: yDia(dd), x2: x + 7, y2: yDia(dd), stroke: '#454b5c' }, g);
      const sp = spell(ev.name);
      if (sp && sp.acc === '#') svg('text', { x: x - 13, y: y + 4, fill: vc.color, 'font-size': 14 }, g).textContent = '♯';
      const open = ev.durRaw >= 2;   // 音符头样式按"真实时值", 不受变速影响
      svg('ellipse', { cx: x, cy: y, rx: 5.4, ry: 4, fill: open ? 'none' : vc.color, stroke: vc.color, 'stroke-width': open ? 1.6 : 1, transform: `rotate(-18 ${x} ${y})` }, g);
      if (ev.durRaw < 4) {
        const up = d < refDia + 4;
        svg('line', { x1: up ? x + 5 : x - 5, y1: y, x2: up ? x + 5 : x - 5, y2: y + (up ? -1 : 1) * 3 * LINEGAP, stroke: vc.color, 'stroke-width': 1.4 }, g);
      }
    });
  });

  const hl = makeHighlight(container);
  const melDb = opts._melDb || ((b) => b);
  let lastPage = -1;
  return function (active, beat) {
    hl(active);
    if (beat == null) return;
    const p = clamp(Math.floor(melDb(beat) / beatsPerPage), 0, pages - 1);   // 真实拍 -> 展示拍(时间轴)
    if (p !== lastPage) { lastPage = p; scroller.scrollTo({ left: p * stride, behavior: 'smooth' }); }
  };
}

function renderView(container, voices, mode, opts) {
  container.innerHTML = '';
  // 小节线在"真实拍"里算好, 再用旋律的展示映射转到时间轴; 各视图内部改用 opts._bars。
  const realTotal = Math.max(0, ...voices.map((v) => v.model.totalBeats));
  const barsReal = barPositions(opts, voices, realTotal);
  const { voices: dv, melDb } = displayTransform(voices);
  const dOpts = Object.assign({}, opts, { _bars: barsReal.map(melDb), _melDb: melDb });
  if (mode === 'piano') return renderPianoRoll(container, dv, dOpts);
  if (mode === 'staff') return renderStaff(container, dv, dOpts);
  return renderBlocks(container, dv, dOpts);
}

if (typeof window !== 'undefined') window.renderView = renderView;
