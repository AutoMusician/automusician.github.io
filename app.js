// app.js —— 装配: 多声部输入 -> 解析 -> 视图渲染 -> 多声部播放
/* global parseMelody, autoHarmonize, renderView, AudioEngine */

const engine = new AudioEngine();
window.engine = engine; // 便于调试

const COLORS = ['#5b8cff', '#48c78e', '#e0a82e', '#c45cff', '#ff7a8a', '#3bc9db'];
const MELODY_DEMO = "1=C 72\n1 1 5 5 6 6 55 +11 -1 1 [123] 11";

const $ = (id) => document.getElementById(id);
const voicesBox = $('voices');
const viz = $('viz');
const status = $('status');
const playBtn = $('play');
const stopBtn = $('stop');
const testToneBtn = $('testTone');
const viewSel = $('view');
const harmTexSel = $('harmTex');
const waveSel = $('wave');
const sampleInput = $('sample');
const sampleBase = $('sampleBase');
const clearSampleBtn = $('clearSample');

let rows = [];        // 声部编辑行: [{ wrap, textarea }]
let setActive = null; // 当前视图的高亮函数
let parsed = [];      // 最近一次解析的声部 [{ label, color, model }]
let playFromBeat = 0; // 从第几拍开始播放 (点击可视化音符设置)

function updatePlayBtn() {
  playBtn.textContent = playFromBeat > 0 ? `▶ 从第${Math.round(playFromBeat * 10) / 10}拍` : '▶ 播放';
}

/* ---------- 本地存储: 刷新后自动恢复 ---------- */
const STORE_KEY = 'automusician.v1';
function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      rows: rows.map((r) => ({ text: r.textarea.value, label: r.label || null, auto: !!r.auto, vol: +r.volEl.value, wave: r.waveEl.value })),
      view: viewSel.value, wave: waveSel.value, harmTex: harmTexSel.value, barBeats: $('barBeats').value, pickup: $('pickup').value,
    }));
  } catch (e) { /* localStorage 不可用时静默忽略 */ }
}
function loadState() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { return null; }
}

/* ---------- 声部编辑行 ---------- */
function rowLabel(i) {
  if (i === 0) return '旋律';
  return rows[i].label || '和声 ' + i;
}
function relabel() {
  rows.forEach((r, i) => {
    r.nameEl.textContent = rowLabel(i);
    r.tag.style.color = COLORS[i % COLORS.length];
    r.del.classList.toggle('hidden', i === 0); // 旋律行不可删
  });
}

function addRow(text, opts) {
  const isMelody = rows.length === 0; // 第一行 = 旋律
  const wrap = document.createElement('div');
  wrap.className = 'voicerow-edit' + (isMelody ? ' melody' : '');
  // 左列: 声部名 + 音量滑块
  const tag = document.createElement('div'); tag.className = 'vtag';
  const nameEl = document.createElement('span'); nameEl.className = 'vname';
  const waveEl = document.createElement('select'); waveEl.className = 'vwave'; waveEl.title = '音色';
  waveEl.innerHTML = '<option value="piano">钢琴</option><option value="violin">提琴</option><option value="horn">圆号</option><option value="guitar">吉他</option><option value="flute">长笛</option><option value="square">方波</option><option value="triangle">三角</option><option value="sawtooth">锯齿</option><option value="sine">正弦</option>';
  waveEl.value = (opts && opts.wave) || waveSel.value;
  const volEl = document.createElement('input');
  volEl.type = 'range'; volEl.className = 'vvol'; volEl.min = 0; volEl.max = 100; volEl.title = '音量';
  volEl.value = (opts && opts.vol != null) ? opts.vol : (isMelody ? 100 : 70);
  tag.append(nameEl, waveEl, volEl);
  const ta = document.createElement('textarea'); ta.spellcheck = false; ta.value = text || '';
  ta.placeholder = isMelody
    ? '在此输入旋律 · 例：1=C 72 ↵ 1 1 5 5 6 6 5'
    : '和声行：可手写，或点上方「自动配和声」生成 · 默认跟随旋律调号，首行写 1=G 可单独定调';
  ta.rows = isMelody ? 3 : (text || '').includes('\n') ? 2 : 1;
  const del = document.createElement('button'); del.className = 'del'; del.textContent = '✕'; del.title = '删除该声部';
  wrap.append(tag, ta, del);
  voicesBox.appendChild(wrap);

  const row = { wrap, textarea: ta, tag, nameEl, waveEl, volEl, del, auto: !!(opts && opts.auto), label: opts && opts.label };
  rows.push(row);

  let t;
  ta.addEventListener('input', () => { clearTimeout(t); t = setTimeout(renderAll, 120); });
  waveEl.addEventListener('change', saveState);
  volEl.addEventListener('input', saveState);
  del.addEventListener('click', () => {
    rows = rows.filter((r) => r !== row);
    wrap.remove();
    relabel();
    renderAll();
  });
  relabel();
  return row;
}

/* ---------- 解析所有声部 ---------- */
function collectVoices() {
  const m0 = parseMelody(rows[0].textarea.value);
  const out = [{ label: '旋律', color: COLORS[0], model: m0 }];
  for (let i = 1; i < rows.length; i++) {
    const model = parseMelody(rows[i].textarea.value, { key: m0.key, bpm: m0.bpm, bodyOnly: true });
    out.push({ label: rowLabel(i), color: COLORS[i % COLORS.length], model });
  }
  return { voices: out, key: m0.key, bpm: m0.bpm };
}

/* ---------- 渲染 ---------- */
function renderAll() {
  const oldScroller = viz.querySelector('.scroller');
  const scrollLeft = oldScroller ? oldScroller.scrollLeft : 0;
  const { voices, key, bpm } = collectVoices();
  parsed = voices;
  setActive = renderView(viz, voices, viewSel.value, { barBeats: +$('barBeats').value || 0, pickup: +$('pickup').value || 0 });
  const newScroller = viz.querySelector('.scroller');
  if (newScroller && scrollLeft) newScroller.scrollLeft = scrollLeft;

  const errs = [];
  voices.forEach((v) => v.model.errors.forEach((e) => errs.push(`[${v.label}] ${e}`)));
  const notes = voices.reduce((s, v) => s + v.model.events.filter((e) => e.type === 'note').length, 0);
  let msg = `调号 1=${key} · ${bpm} BPM · ${voices.length} 声部 · ${notes} 个音符`;
  status.className = 'status';
  if (errs.length) { status.className = 'status err'; msg += ' ⚠ ' + errs.join('; '); }
  status.textContent = msg;
  saveState();
}

/* ---------- 播放 ---------- */
function onPlay() {
  renderAll();
  const playable = parsed.filter((v) => v.model.events.some((e) => e.type === 'note'));
  if (!playable.length) { status.textContent = '没有可播放的音符'; return; }
  engine.wave = waveSel.value;
  const bpm = parsed[0].model.bpm;
  const voiceEvents = parsed.map((v, i) => ({ events: v.model.events, tempos: v.model.tempos, gain: (rows[i] ? +rows[i].volEl.value : 100) / 100, wave: rows[i] ? rows[i].waveEl.value : waveSel.value }));
  playBtn.disabled = true; stopBtn.disabled = false;
  const from = playFromBeat;
  engine.play(voiceEvents, bpm,
    (active, beat) => { if (setActive) setActive(active, beat); },
    () => { playFromBeat = 0; updatePlayBtn(); playBtn.disabled = false; stopBtn.disabled = true; if (setActive) setActive(parsed.map(() => -1)); },
    from);
}

function onStop() {
  engine.stop();
  playBtn.disabled = false; stopBtn.disabled = true;
  if (setActive) setActive(parsed.map(() => -1));
}

/* ---------- 按钮 ---------- */
$('addVoice').addEventListener('click', () => { addRow(''); renderAll(); });

function runAutoHarmonize() {
  const m0 = parseMelody(rows[0].textarea.value);
  if (m0.totalBeats <= 0) { status.textContent = '旋律为空, 无法配和声'; return; }
  // 追加新的和声声部, 不删除已有的(手写或之前生成的都保留)
  const { rows: hrows, chords } = autoHarmonize(m0, { texture: harmTexSel.value });
  hrows.forEach((hr) => addRow(hr.text, { auto: true, label: hr.label }));
  relabel();
  renderAll();
  status.className = 'status';
  const tex = harmTexSel.selectedOptions[0].textContent;
  status.textContent = `✨ 已追加和声 (${tex}) · 进行: ${chords.join(' - ')}`;
}
$('autoHarm').addEventListener('click', runAutoHarmonize);

// 调整每小节拍数/挂拍时: 删除各声部原有的 |, 再按固定拍位(含挂拍偏移)重新插入 |
function applyBarlines() {
  const bb = +$('barBeats').value || 0;
  const pickup = ((((+$('pickup').value || 0) % bb) + bb) % bb) || 0; // bb=0 时为 NaN%, 下面会跳过
  const m0 = parseMelody(rows[0].textarea.value.replace(/\|/g, ''));
  rows.forEach((row, vi) => {
    let text = row.textarea.value.replace(/\|/g, ''); // 删除原来的 |
    if (bb > 0) {
      const model = vi === 0 ? parseMelody(text) : parseMelody(text, { key: m0.key, bpm: m0.bpm, bodyOnly: true });
      const first = pickup > 0 ? pickup : bb;
      const boundaries = [];
      for (let b = first; b < model.totalBeats - 1e-6; b += bb) boundaries.push(b);
      const inserts = [];
      let bi = 0;
      for (const ev of model.events) {
        let crossed = false;
        while (bi < boundaries.length && ev.startBeat >= boundaries[bi] - 1e-6) { bi++; crossed = true; }
        if (crossed && ev.srcStart != null) inserts.push(ev.srcStart);
      }
      inserts.sort((a, b) => b - a);
      for (const p of inserts) text = text.slice(0, p) + '|' + text.slice(p);
    }
    row.textarea.value = text;
  });
  renderAll();
}

// 点击视图中的音符 -> 选中源文字 + 设置播放起始位置
viz.addEventListener('click', (e) => {
  const el = e.target.closest && e.target.closest('[data-v][data-s]');
  if (!el) { playFromBeat = 0; updatePlayBtn(); return; }
  const v = +el.getAttribute('data-v');
  const i = el.getAttribute('data-i');
  const s = +el.getAttribute('data-s'), en = +el.getAttribute('data-e');
  const row = rows[v];
  if (!row || isNaN(s)) return;
  row.textarea.focus();
  row.textarea.setSelectionRange(s, en);
  if (i != null && parsed[v] && parsed[v].model.events[+i]) {
    playFromBeat = parsed[v].model.events[+i].startBeat;
    updatePlayBtn();
  }
});

// 导出/导入
$('exportBtn').addEventListener('click', () => {
  const state = {
    rows: rows.map((r) => ({ text: r.textarea.value, label: r.label || null, auto: !!r.auto, vol: +r.volEl.value, wave: r.waveEl.value })),
    view: viewSel.value, wave: waveSel.value, harmTex: harmTexSel.value,
    barBeats: $('barBeats').value, pickup: $('pickup').value,
  };
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'automusician-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
});
$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', () => {
  const f = $('importFile').files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const saved = JSON.parse(reader.result);
      rows.slice().forEach((r) => r.wrap.remove());
      rows = [];
      if (saved.rows) saved.rows.forEach((r) => addRow(r.text, { auto: r.auto, label: r.label, vol: r.vol, wave: r.wave }));
      if (saved.view) viewSel.value = saved.view;
      if (saved.wave) { waveSel.value = saved.wave; engine.wave = saved.wave; }
      if (saved.harmTex) harmTexSel.value = saved.harmTex;
      if (saved.barBeats) $('barBeats').value = saved.barBeats;
      if (saved.pickup != null) $('pickup').value = saved.pickup;
      relabel(); renderAll();
      status.className = 'status';
      status.textContent = '已导入: ' + f.name;
    } catch (e) {
      status.className = 'status err';
      status.textContent = '导入失败: ' + e.message;
    }
  };
  reader.readAsText(f);
  $('importFile').value = '';
});

// 重置: 清空本地存档, 恢复默认示例与默认设置
$('resetDemo').addEventListener('click', () => {
  if (!confirm('清空当前所有内容并恢复默认示例？')) return;
  try { localStorage.removeItem(STORE_KEY); } catch (e) {}
  rows.slice().forEach((r) => r.wrap.remove());
  rows = [];
  addRow(MELODY_DEMO);
  viewSel.value = 'blocks';
  waveSel.value = 'square'; engine.wave = 'square';
  harmTexSel.value = 'block';
  $('barBeats').value = '4';
  $('pickup').value = '0';
  relabel();
  renderAll();
});

playBtn.addEventListener('click', onPlay);
stopBtn.addEventListener('click', onStop);
viewSel.addEventListener('change', renderAll);
waveSel.addEventListener('change', () => { engine.wave = waveSel.value; saveState(); });
harmTexSel.addEventListener('change', saveState);
$('barBeats').addEventListener('change', applyBarlines); // 改拍数 -> 各声部重写 |
$('pickup').addEventListener('change', applyBarlines);   // 改挂拍 -> 同上
window.addEventListener('beforeunload', saveState);

testToneBtn.addEventListener('click', async () => {
  engine.wave = waveSel.value;
  const st = await engine.testBeep();
  if (st === 'running') {
    status.className = 'status';
    status.textContent = '🔊 已发出测试音 (A4) · 没听到请检查系统音量, 或在真实浏览器打开 http://localhost:5510';
  } else {
    status.className = 'status err';
    status.textContent = `⚠ 音频上下文为 "${st}", 被浏览器挂起 · 请在真实浏览器打开 http://localhost:5510`;
  }
});

sampleInput.addEventListener('change', async () => {
  const f = sampleInput.files[0];
  if (!f) return;
  try {
    await engine.loadSample(f, +sampleBase.value || 60);
    status.className = 'status';
    status.textContent = `已加载音色采样: ${f.name} (基准音 MIDI ${sampleBase.value})`;
    clearSampleBtn.disabled = false;
  } catch (e) {
    status.className = 'status err';
    status.textContent = '采样加载失败: ' + e.message;
  }
});
clearSampleBtn.addEventListener('click', () => {
  engine.clearSample();
  sampleInput.value = '';
  clearSampleBtn.disabled = true;
  status.textContent = '已恢复为合成音色';
});

// 预热: 首次任意交互就建好音频上下文, 消除冷启动延迟
function warmup() { const ctx = engine.ensure(); if (ctx.state !== 'running') ctx.resume(); }
window.addEventListener('pointerdown', warmup, { once: true });
window.addEventListener('keydown', warmup, { once: true });

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'INPUT') {
    e.preventDefault();
    engine.playing ? onStop() : onPlay();
  }
});

// 初始: 有本地存档则恢复, 否则用默认示例
const saved = loadState();
if (saved && Array.isArray(saved.rows) && saved.rows.length) {
  saved.rows.forEach((r) => addRow(r.text, { auto: r.auto, label: r.label || undefined, vol: r.vol, wave: r.wave }));
  if (saved.view) viewSel.value = saved.view;
  if (saved.wave) { waveSel.value = saved.wave; engine.wave = saved.wave; }
  if (saved.harmTex) harmTexSel.value = saved.harmTex;
  if (saved.barBeats) $('barBeats').value = saved.barBeats;
  if (saved.pickup != null) $('pickup').value = saved.pickup;
} else {
  addRow(MELODY_DEMO);
}
renderAll();
