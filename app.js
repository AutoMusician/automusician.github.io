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
let playFromBeat = 0; // 从第几拍开始播放, 以旋律(声部0)拍位为准 (点击任意声部的音都换算到旋律时间轴)

function updatePlayBtn() {
  playBtn.textContent = playFromBeat > 0 ? `▶ 从第${Math.round(playFromBeat * 10) / 10}拍` : '▶ 播放';
}

/* ---------- 状态快照: 供本地存储 / 导出 / 分享链接共用 ---------- */
const STORE_KEY = 'automusician.v1';
function snapshot() {
  return {
    rows: rows.map((r) => ({ text: r.textarea.value, label: r.label || null, auto: !!r.auto, vol: +r.volEl.value, wave: r.waveEl.value })),
    view: viewSel.value, wave: waveSel.value, harmTex: harmTexSel.value, barBeats: $('barBeats').value, pickup: $('pickup').value,
  };
}
// 把一份状态对象套用到界面上 (不触发渲染; 调用方随后自行 renderAll)
function applyState(saved) {
  rows.slice().forEach((r) => r.wrap.remove());
  rows = [];
  if (saved.rows) saved.rows.forEach((r) => addRow(r.text, { auto: r.auto, label: r.label || undefined, vol: r.vol, wave: r.wave }));
  if (saved.view) viewSel.value = saved.view;
  if (saved.wave) { waveSel.value = saved.wave; engine.wave = saved.wave; }
  if (saved.harmTex) harmTexSel.value = saved.harmTex;
  if (saved.barBeats) $('barBeats').value = saved.barBeats;
  if (saved.pickup != null) $('pickup').value = saved.pickup;
  relabel();
}
function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(snapshot())); } catch (e) { /* localStorage 不可用时静默忽略 */ }
}
function loadState() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { return null; }
}

// base64url —— 把乐谱状态塞进 URL, 无需后端存储即可分享
function bytesToB64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function b64urlEncode(str) { return bytesToB64url(new TextEncoder().encode(str)); }         // 未压缩(#m=) 兼容旧链接
function b64urlDecode(s) { return new TextDecoder().decode(b64urlToBytes(s)); }

// DEFLATE 压缩(浏览器内置 CompressionStream) —— 乐谱文本重复度高, 压缩后链接可短一半以上。
// 不支持的老浏览器回退到未压缩。用不同的 hash 键区分: #c= 压缩, #m= 未压缩。
const HAS_DEFLATE = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
async function deflate(str) {
  const cs = new CompressionStream('deflate-raw');
  const w = cs.writable.getWriter();
  w.write(new TextEncoder().encode(str)); w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}
async function inflate(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const w = ds.writable.getWriter();
  w.write(bytes); w.close();
  return new TextDecoder().decode(await new Response(ds.readable).arrayBuffer());
}
// 生成分享链接(压缩优先); 返回完整 URL
async function buildShareUrl() {
  const base = location.origin + location.pathname;
  const json = JSON.stringify(snapshot());
  if (HAS_DEFLATE) {
    try { return base + '#c=' + bytesToB64url(await deflate(json)); } catch (e) { /* 回退 */ }
  }
  return base + '#m=' + b64urlEncode(json);
}
// 从 URL hash 还原状态(兼容 #c= 压缩 与 #m= 未压缩)
async function stateFromHash() {
  const h = location.hash || '';
  let m = /[#&]c=([^&]+)/.exec(h);
  if (m && HAS_DEFLATE) { try { return JSON.parse(await inflate(b64urlToBytes(m[1]))); } catch (e) { return null; } }
  m = /[#&]m=([^&]+)/.exec(h);
  if (m) { try { return JSON.parse(b64urlDecode(m[1])); } catch (e) { return null; } }
  return null;
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
  waveEl.innerHTML = '<option value="piano">钢琴</option><option value="violin">提琴</option><option value="horn">圆号</option><option value="guitar">吉他</option><option value="flute">长笛</option><option value="chime">编钟</option><option value="glock">钟琴</option><option value="ethereal">空灵</option><option value="square">方波</option><option value="triangle">三角波</option><option value="sawtooth">锯齿</option><option value="sine">正弦</option>';
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
    // 点击的是某声部某拍 -> 先换成共享时间戳, 再换回旋律拍位, 使起播点统一到旋律时间轴。
    // 这样各声部速度不同时, 点任意声部的音, 全部声部都从同一时刻切入(数字也以旋律为准)。
    const rawBeat = parsed[v].model.events[+i].startBeat;
    const t = window.beatToTime(parsed[v].model.tempos, rawBeat);
    playFromBeat = window.timeToBeat(parsed[0].model.tempos, t);
    updatePlayBtn();
  }
});

// 导出/导入
$('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(snapshot(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'automusician-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
});
// 导出 MusicXML (MuseScore / Sibelius / Finale 可打开)
$('mxlBtn').addEventListener('click', () => {
  const { voices } = collectVoices();
  const playable = voices.filter((v) => v.model.events.some((e) => e.type === 'note'));
  if (!playable.length) { status.className = 'status err'; status.textContent = '没有可导出的音符'; return; }
  const xml = melodyToMusicXML(voices, { barBeats: +$('barBeats').value || 0, pickup: +$('pickup').value || 0, bpm: voices[0].model.bpm });
  const blob = new Blob([xml], { type: 'application/vnd.recordare.musicxml+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'automusician-' + new Date().toISOString().slice(0, 10) + '.musicxml';
  a.click();
  URL.revokeObjectURL(a.href);
  status.className = 'status';
  status.textContent = '🎼 已导出 MusicXML · 用 MuseScore 等软件打开即可';
});
$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', () => {
  const f = $('importFile').files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      applyState(JSON.parse(reader.result));
      renderAll();
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

// 分享: 把整份乐谱压缩编码进 URL(#c=/#m=), 复制到剪贴板 —— 纯静态站, 无需服务器存储
$('shareBtn').addEventListener('click', async () => {
  let url;
  try {
    url = await buildShareUrl();
  } catch (e) {
    status.className = 'status err';
    status.textContent = '生成分享链接失败: ' + e.message;
    return;
  }
  let copied = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(url); copied = true; }
  } catch (e) { /* 剪贴板不可用 (非 HTTPS 等), 走下面的手动复制 */ }
  status.className = 'status';
  if (copied) {
    status.textContent = `🔗 分享链接已复制到剪贴板 (共 ${url.length} 字符) · 打开即可载入这份乐谱`;
  } else {
    // 剪贴板失败: 选中一个只读输入框里的链接, 让用户手动复制
    let box = $('shareUrl');
    if (!box) { box = document.createElement('input'); box.id = 'shareUrl'; box.readOnly = true; box.className = 'shareurl'; status.after(box); }
    box.value = url; box.style.display = 'block'; box.focus(); box.select();
    status.textContent = '🔗 分享链接 (下方已选中, 按 ⌘/Ctrl+C 复制):';
  }
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
function warmup() { engine.unlock(); }
window.addEventListener('pointerdown', warmup, { once: true });
window.addEventListener('keydown', warmup, { once: true });

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'INPUT') {
    e.preventDefault();
    engine.playing ? onStop() : onPlay();
  }
});

// 初始: 分享链接(#c=/#m=) > 本地存档 > 默认示例。压缩解码是异步的, 故用 async IIFE。
(async () => {
  let shared = await stateFromHash();
  if (!(shared && Array.isArray(shared.rows) && shared.rows.length)) shared = null;
  const saved = shared || loadState();
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
  // 载入分享链接后清掉 hash: 之后就是普通可编辑会话(改动进 localStorage), 刷新不会回退
  if (shared) { try { saveState(); history.replaceState(null, '', location.pathname + location.search); } catch (e) {} }
  renderAll();
})();
