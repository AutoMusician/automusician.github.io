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

/* ---------- 本地存储: 刷新后自动恢复 ---------- */
const STORE_KEY = 'automusician.v1';
function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      rows: rows.map((r) => ({ text: r.textarea.value, label: r.label || null, auto: !!r.auto })),
      view: viewSel.value, wave: waveSel.value, harmTex: harmTexSel.value, barBeats: $('barBeats').value,
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
    r.tag.textContent = rowLabel(i);
    r.tag.style.color = COLORS[i % COLORS.length];
    r.del.classList.toggle('hidden', i === 0); // 旋律行不可删
  });
}

function addRow(text, opts) {
  const isMelody = rows.length === 0; // 第一行 = 旋律
  const wrap = document.createElement('div');
  wrap.className = 'voicerow-edit' + (isMelody ? ' melody' : '');
  const tag = document.createElement('div'); tag.className = 'vtag';
  const ta = document.createElement('textarea'); ta.spellcheck = false; ta.value = text || '';
  ta.placeholder = isMelody
    ? '在此输入旋律 · 例：1=C 72 ↵ 1 1 5 5 6 6 5'
    : '和声行：可手写，或点上方「自动配和声」生成';
  ta.rows = isMelody ? 3 : (text || '').includes('\n') ? 2 : 1;
  const del = document.createElement('button'); del.className = 'del'; del.textContent = '✕'; del.title = '删除该声部';
  wrap.append(tag, ta, del);
  voicesBox.appendChild(wrap);

  const row = { wrap, textarea: ta, tag, del, auto: !!(opts && opts.auto), label: opts && opts.label };
  rows.push(row);

  let t;
  ta.addEventListener('input', () => { clearTimeout(t); t = setTimeout(renderAll, 120); });
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
  const { voices, key, bpm } = collectVoices();
  parsed = voices;
  setActive = renderView(viz, voices, viewSel.value);

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
  const nH = Math.max(1, parsed.length - 1);
  const hg = 0.7 / Math.sqrt(nH); // 声部越多, 每个和声声部音量越低, 避免压过旋律
  const voiceEvents = parsed.map((v, i) => ({ events: v.model.events, gain: i === 0 ? 1 : hg }));
  playBtn.disabled = true; stopBtn.disabled = false;
  engine.play(voiceEvents, bpm,
    (active, beat) => { if (setActive) setActive(active, beat); },
    () => { playBtn.disabled = false; stopBtn.disabled = true; if (setActive) setActive(parsed.map(() => -1)); });
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
  // 移除上一次自动生成的行, 再插入新的(可重复点击/切织体不堆积)
  rows.filter((r) => r.auto).forEach((r) => r.wrap.remove());
  rows = rows.filter((r) => !r.auto);
  const { rows: hrows, chords } = autoHarmonize(m0, { texture: harmTexSel.value });
  hrows.forEach((hr) => addRow(hr.text, { auto: true, label: hr.label }));
  relabel();
  renderAll();
  status.className = 'status';
  const tex = harmTexSel.selectedOptions[0].textContent;
  status.textContent = `✨ 自动和声 (${tex}, 可编辑) · 进行: ${chords.join(' - ')}`;
}
$('autoHarm').addEventListener('click', runAutoHarmonize);
harmTexSel.addEventListener('change', () => { if (rows.some((r) => r.auto)) runAutoHarmonize(); });

// 点击视图中的音符 -> 在对应声部的文本框里选中其源文字
viz.addEventListener('click', (e) => {
  const el = e.target.closest && e.target.closest('[data-v][data-s]');
  if (!el) return;
  const v = +el.getAttribute('data-v');
  const s = +el.getAttribute('data-s'), en = +el.getAttribute('data-e');
  const row = rows[v];
  if (!row || isNaN(s)) return;
  row.textarea.focus();
  row.textarea.setSelectionRange(s, en);
});

// 自动按固定拍数加小节线(写入旋律文本; 各视图据旋律小节位置绘制)
function addBarlines() {
  const n = Math.max(1, Math.round(+$('barBeats').value || 4));
  let text = rows[0].textarea.value.replace(/\|/g, ''); // 先清除已有, 可重复点击不叠加
  const model = parseMelody(text);
  const boundaries = [];
  for (let b = n; b < model.totalBeats - 1e-6; b += n) boundaries.push(b);
  const inserts = [];
  let bi = 0;
  for (const ev of model.events) {
    let crossed = false;
    while (bi < boundaries.length && ev.startBeat >= boundaries[bi] - 1e-6) { bi++; crossed = true; }
    if (crossed && ev.srcStart != null) inserts.push(ev.srcStart);
  }
  inserts.sort((a, b) => b - a); // 从后往前插, 保持偏移有效
  for (const p of inserts) text = text.slice(0, p) + '|' + text.slice(p);
  rows[0].textarea.value = text;
  renderAll();
  status.className = 'status';
  status.textContent = `已按每 ${n} 拍加小节线 · 共 ${inserts.length} 条`;
}
$('addBars').addEventListener('click', addBarlines);

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
  relabel();
  renderAll();
});

playBtn.addEventListener('click', onPlay);
stopBtn.addEventListener('click', onStop);
viewSel.addEventListener('change', renderAll);
waveSel.addEventListener('change', () => { engine.wave = waveSel.value; saveState(); });
harmTexSel.addEventListener('change', saveState);
$('barBeats').addEventListener('change', saveState);
window.addEventListener('beforeunload', saveState);

testToneBtn.addEventListener('click', () => {
  engine.wave = waveSel.value;
  const st = engine.testBeep();
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
function warmup() { const ctx = engine.ensure(); if (ctx.state === 'suspended') ctx.resume(); }
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
  saved.rows.forEach((r) => addRow(r.text, { auto: r.auto, label: r.label || undefined }));
  if (saved.view) viewSel.value = saved.view;
  if (saved.wave) { waveSel.value = saved.wave; engine.wave = saved.wave; }
  if (saved.harmTex) harmTexSel.value = saved.harmTex;
  if (saved.barBeats) $('barBeats').value = saved.barBeats;
} else {
  addRow(MELODY_DEMO);
}
renderAll();
