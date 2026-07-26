// fugue.js —— 由给定旋律写一首赋格
// 输入: 旋律的内部音符模型 (parseMelody 的结果)
// 输出: { rows: [{ label, text }], subjectBeats, voices, totalBeats }
//
// 曲式 (n 个声部, 主题长 L 拍):
//   呈示部 n 段: 各声部依次进入 —— 主题(S, 主调)与答题(A, 属调)交替, 每次进入低一个四度;
//                刚陈述完主题的声部转入对题(CS), 更早进入的声部作慢速自由对位
//   插部 1 段:   用主题头动机作下行模进, 和声沿五度圈走回属和弦
//   再现 1 段:   最低声部再次陈述主题, 上方声部对位
//   终止 4 拍:   V - I 正格终止, 各声部持长音收束
//
// 内部音高一律用"音阶级索引" idx = 八度 * 7 + (级数 - 1) 做全音阶运算 —— 移调/倒影/模进
// 都只是加减法, 且天然留在调内; 最后再渲染回本 app 的记谱文本。
/* global analyzeHarmony */

const F_EPS = 1e-6;
const SLOT = 0.5;   // 记谱能表达的最小时值(半拍)
const WIN = 2;      // 和声窗 / [ ] 连音组的固定长度(拍)

/* ---------- 音阶级索引 ---------- */
function degIndex(n) { return n.oct * 7 + (n.deg - 1); }
function fromIndex(idx, acc) {
  return { deg: ((idx % 7) + 7) % 7 + 1, oct: Math.floor(idx / 7), acc: acc || '' };
}
const mkRest = (dur) => ({ deg: 0, oct: 0, acc: '', dur });
const isRest = (n) => !n || !n.deg;
const withDur = (n, dur) => Object.assign({}, n, { dur });

const degOf = (R, s) => ((R - 1 + s) % 7) + 1;
const triadTones = (R) => [R, degOf(R, 2), degOf(R, 4)];

// 全音阶移位。非整八度的移位丢掉临时升降号 —— 保证答题/模进仍落在调内
function transpose(line, steps) {
  return line.map((n) => (isRest(n)
    ? withDur(n, n.dur)
    : withDur(fromIndex(degIndex(n) + steps, steps % 7 === 0 ? n.acc : ''), n.dur)));
}

// 把音高折进某个声部的音区(整八度地折, 所以和弦音仍是和弦音)。band 为半宽, 默认 ±6 级
function place(idx, center, band) {
  const w = band == null ? 6 : band;
  while (idx - center > w) idx -= 7;
  while (center - idx > w) idx += 7;
  return idx;
}

// 吸附到最近的和弦音 —— 对位声部靠它保证与主题协和
function snapToChord(idx, tones) {
  for (let d = 0; d < 7; d++) {
    for (const s of (d === 0 ? [0] : [-d, d])) {
      if (tones.includes((((idx + s) % 7) + 7) % 7 + 1)) return idx + s;
    }
  }
  return idx;
}

// 量化到半拍网格, 并对齐到恰好 total 拍(超出截断, 不足补休止)
function fit(line, total) {
  const cap = Math.round(total / SLOT);
  const out = [];
  let used = 0;
  for (const n of line) {
    let s = Math.max(1, Math.round(n.dur / SLOT));
    if (used + s > cap) s = cap - used;
    if (s <= 0) break;
    out.push(withDur(n, s * SLOT));
    used += s;
  }
  if (used < cap) out.push(mkRest((cap - used) * SLOT));
  return out;
}

// 第 b 拍上正在响的音(休止返回 null)
function sampleAt(line, b) {
  let t = 0;
  for (const n of line) {
    if (b < t + n.dur - F_EPS) return isRest(n) ? null : n;
    t += n.dur;
  }
  return null;
}

// 取旋律开头 L 拍作主题
function takeBeats(model, L) {
  const out = [];
  for (const e of model.events) {
    if (e.startBeat >= L - F_EPS) break;
    const dur = Math.min(e.startBeat + e.durBeats, L) - e.startBeat;
    if (dur <= F_EPS) continue;
    out.push(e.type === 'rest' ? mkRest(dur)
      : { deg: e.degree, oct: e.octaves || 0, acc: e.accidental || '', dur });
  }
  return out;
}

// 答题: 主题上行五度(全音阶 +4 级)。首音是属音(5)时改用主音(1) —— 传统的"调性答题"
function answerOf(subject) {
  const a = transpose(subject, 4);
  for (let i = 0; i < a.length; i++) {
    if (isRest(a[i])) continue;
    if (subject[i].deg === 5) a[i] = withDur(fromIndex(degIndex(a[i]) - 1), a[i].dur);
    break;
  }
  return a;
}

// 对题轮廓: 主题绕首音的倒影, 逐拍取样 —— 与主题反向进行, 节奏比主题平稳
function csSeed(subject, L) {
  let pivot = null;
  for (const n of subject) if (!isRest(n)) { pivot = degIndex(n); break; }
  if (pivot == null) return null;
  const seed = [];
  for (let b = 0; b < L; b++) {
    const n = sampleAt(subject, b);
    seed.push(n ? 2 * pivot - degIndex(n) : null);
  }
  return seed;
}

/* ---------- 和声 ---------- */
// 造一个够 analyzeHarmony 用的伪 model
function lineModel(line, key) {
  const events = [];
  let t = 0;
  for (const n of line) {
    events.push(isRest(n)
      ? { type: 'rest', startBeat: t, durBeats: n.dur }
      : { type: 'note', degree: n.deg, accidental: n.acc || '', startBeat: t, durBeats: n.dur });
    t += n.dur;
  }
  return { key, events, totalBeats: t };
}

// 给一段线条配和弦(每 2 拍一个), 供对位声部取和弦音; 复用 harmony.js 的 Viterbi 分析
function harmonyOf(line, key, beats) {
  if (typeof analyzeHarmony === 'function') {
    const r = analyzeHarmony(lineModel(line, key), { win: WIN });
    if (r.windows.length) return r.windows;
  }
  const out = [];
  for (let b = 0; b < beats; b += WIN) out.push({ start: b, beats: WIN, root: 1, tones: triadTones(1) });
  return out;
}

function windowAt(windows, b) {
  for (const w of windows) if (b >= w.start - F_EPS && b < w.start + w.beats - F_EPS) return w;
  return windows[windows.length - 1] || null;
}

const BAND = 4;   // 对位声部的音区半宽(级): 太窄会几个声部挤在同一个音上, 太宽则声部交叉泛滥

// 在本声部音区(center ± BAND)内挑一个和弦音: 尽量靠近想要的轮廓 want,
// 且避开 busy(本块中已定好的其它声部) —— 否则几个声部会挤到同一个音上, 听起来就少了层次
function pickTone(want, tones, center, busy) {
  const cands = [];
  for (let idx = center - BAND; idx <= center + BAND; idx++) {
    if (tones.includes((((idx % 7) + 7) % 7) + 1)) cands.push(idx);
  }
  if (!cands.length) return place(want, center, BAND);
  const free = cands.filter((c) => busy.indexOf(c) < 0);
  const pool = free.length ? free : cands;
  let best = pool[0];
  for (const c of pool) if (Math.abs(c - want) < Math.abs(best - want)) best = c;
  return best;
}

// 某拍上已定好的其它声部音高
function soundingAt(segs, b) {
  const out = [];
  for (const s of segs) { const n = sampleAt(s, b); if (n) out.push(degIndex(n)); }
  return out;
}

// 对位声部: 每 rate 拍一个音。给了 seed(对题轮廓)就贴着它走, 否则顺着上一音平稳进行;
// 落点一律取本声部音区内、不与已定声部撞同度的和弦音。
function counterLine(windows, beats, center, seed, rate, taken) {
  const out = [];
  let prev = center;
  for (let b = 0; b < beats; b += rate) {
    const w = windowAt(windows, b);
    const tones = w ? w.tones : [1, 3, 5];
    let want = place(seed && seed[b] != null ? seed[b] : prev, center, BAND);
    if (!seed && want === prev) want = prev + 2;          // 自由对位: 别原地不动
    const busy = (taken ? taken(b) : []).slice();
    if (want !== prev) busy.push(prev);                   // 轮廓要求换音, 就别又落回同一个音
    const idx = pickTone(want, tones, center, busy);
    out.push(withDur(fromIndex(idx), Math.min(rate, beats - b)));
    prev = idx;
  }
  return out;
}

/* ---------- 插部 ---------- */
const EPISODE_FIFTHS = [1, 4, 7, 3, 6, 2, 5]; // 下行五度圈, 收在属和弦上(好接下一次主题进入)

function episodeWindows(beats) {
  const n = Math.max(1, Math.round(beats / WIN));
  const out = [];
  for (let i = 0; i < n; i++) {
    const R = EPISODE_FIFTHS[((EPISODE_FIFTHS.length - n + i) % EPISODE_FIFTHS.length + EPISODE_FIFTHS.length) % EPISODE_FIFTHS.length];
    out.push({ start: i * WIN, beats: WIN, root: R, tones: triadTones(R) });
  }
  return out;
}

// 模进动机: 取主题里第一段"有起伏"的 2 拍 —— 主题开头常是一个长音, 拿它去模进会很呆板
function headMotif(subject, L) {
  let first = null;
  for (let s = 0; s + WIN <= L; s++) {
    const seg = [];
    for (let b = 0; b < WIN; b++) { const n = sampleAt(subject, s + b); seg.push(n ? degIndex(n) : null); }
    const pitches = seg.filter((x) => x != null);
    if (!pitches.length) continue;
    if (!first) first = seg;
    if (new Set(pitches).size >= 2) return seg;
  }
  return first || [0, 0];
}

// 模进: 每个和弦窗把头动机整体下移一级, 再吸附到该窗的和弦音
function episodeLead(head, windows, center) {
  const out = [];
  windows.forEach((w, j) => {
    head.forEach((idx) => {
      out.push(idx == null ? mkRest(1)
        : withDur(fromIndex(place(snapToChord(idx - j, w.tones), center)), 1));
    });
  });
  return out;
}

// 终止式: V - I, 低音走根音, 高音收在主音
function codaLines(nv, centers) {
  const lines = [];
  for (let v = 0; v < nv; v++) {
    const line = [];
    [5, 1].forEach((R, ci) => {
      const tones = triadTones(R);
      let d;
      if (v === nv - 1) d = R;                    // 最低声部走根音 -> 正格终止
      else if (ci === 1 && v === 0) d = 1;        // 最高声部收在主音
      else d = tones[(v + ci) % 3];
      line.push(withDur(fromIndex(place(d - 1, centers[v])), WIN));
    });
    lines.push(line);
  }
  return lines;
}

/* ---------- 渲染回记谱文本 ---------- */
// 记谱限制: 整拍音符 = 数字重复(111 = 3 拍); 含半拍的必须写进 [ ](固定 2 拍, 内部按权重均分)。
// 所以按 2 拍(4 个半拍格)一窗输出: 整窗都落在整拍上就直接写数字, 否则整窗写成一个 [ ] 组。
// 跨窗的长音会被解析器自动合并(相邻同音), 因此只需在"新起的同音"前加 ' 断开。
function renderLine(line) {
  const total = line.reduce((s, n) => s + n.dur, 0);
  const pad = (WIN - (total % WIN)) % WIN;
  const src = pad > F_EPS ? line.concat([mkRest(pad)]) : line; // 补齐末窗, 否则 [ ] 会占满 2 拍而错位

  const slots = [];
  src.forEach((n, i) => {
    const cnt = Math.max(1, Math.round(n.dur / SLOT));
    for (let k = 0; k < cnt; k++) slots.push({ n, i, first: k === 0 });
  });

  const out = [];
  let cur = 0, prev = null;   // cur: 当前累积八度(+/- 持续生效); prev: 上一个写出的音, 用于判断要不要 '
  for (let w = 0; w < slots.length; w += 4) {
    const runs = [];
    for (let k = w; k < Math.min(w + 4, slots.length); k++) {
      const s = slots[k], last = runs[runs.length - 1];
      if (last && last.i === s.i) last.len++;
      else runs.push({ n: s.n, i: s.i, len: 1, first: s.first });
    }
    const whole = runs.every((r) => r.len % 2 === 0);   // 整窗都是整拍 -> 可以直接写数字
    let text = '';
    for (const r of runs) {
      let pre = '';
      if (!isRest(r.n)) {
        const sh = r.n.oct - cur;
        pre = sh > 0 ? '+'.repeat(sh) : sh < 0 ? '-'.repeat(-sh) : '';
        cur = r.n.oct;
      }
      const body = isRest(r.n) ? '0' : String(r.n.deg) + (r.n.acc || '');
      const id = isRest(r.n) ? 'r' : cur + '|' + body;
      text += (r.first && prev === id ? "'" : '') + pre + body.repeat(whole ? r.len / 2 : r.len);
      prev = id;
    }
    out.push(whole ? text : '[' + text + ']');
  }
  return out.join(' ');
}

/* ---------- 主入口 ---------- */
// 第 i 次进入的落点: 每次比前一次低一个四度 (0, -3, -7, -10 ...)
function entryCenter(i) { return -Math.floor(i / 2) * 7 - (i % 2 ? 3 : 0); }
// 要给素材加的移位: 答题(奇数次进入)本身已上行五度(+4 级), 所以要多降一个八度才落到位
function entryShift(i) { return i % 2 ? entryCenter(i) - 4 : entryCenter(i); }

const VOICE_NAMES = {
  2: ['高音', '低音'],
  3: ['高音', '中音', '低音'],
  4: ['高音', '中音', '次中音', '低音'],
};

function makeFugue(model, opts) {
  const o = opts || {};
  const nv = Math.max(2, Math.min(4, o.voices || 3));
  const key = model.key || 'C';
  const bar = o.barBeats > 0 ? o.barBeats : 4;
  // 主题 = 旋律开头两小节, 取偶数拍(2..16), 旋律不够长就用整条旋律
  let L = Math.min(model.totalBeats, bar * 2);
  L = Math.max(2, Math.min(16, Math.round(L / 2) * 2));

  const subject = fit(takeBeats(model, L), L);
  if (!subject.some((n) => !isRest(n))) return { rows: [] };

  const answer = answerOf(subject);
  const seed = csSeed(subject, L);
  const centers = [];
  for (let v = 0; v < nv; v++) centers.push(entryCenter(v) + 3);

  const lines = [];
  for (let v = 0; v < nv; v++) lines.push([]);
  const push = (v, seg) => { lines[v] = lines[v].concat(seg); };

  // 组装一整块: leadV 声部唱 lead, 其余声部依次填对位 —— 刚陈述完主题的声部接对题(每拍一音),
  // 更早进入的作慢速自由对位; 后填的声部避开先填好的, 免得几个声部挤到同一个音上。
  // entered != null 时表示还在呈示部, 序号大于它的声部尚未进入, 整块休止。
  const block = (leadV, lead, windows, beats, entered) => {
    const seg = [];
    seg[leadV] = fit(lead, beats);
    const done = [seg[leadV]];
    for (let v = 0; v < nv; v++) {
      if (v === leadV) continue;
      if (entered != null && v > entered) { seg[v] = [mkRest(beats)]; continue; }
      const cs = v === leadV - 1;
      seg[v] = fit(counterLine(windows, beats, centers[v], cs ? seed : null, cs ? 1 : WIN,
        (b) => soundingAt(done, b)), beats);
      done.push(seg[v]);
    }
    for (let v = 0; v < nv; v++) push(v, seg[v]);
  };

  // 呈示部: 第 k 块由声部 k 进入
  for (let k = 0; k < nv; k++) {
    const entry = transpose(k % 2 ? answer : subject, entryShift(k));
    block(k, entry, harmonyOf(fit(entry, L), key, L), L, k);
  }

  // 插部: 头动机下行模进
  const epW = episodeWindows(L);
  block(0, episodeLead(headMotif(subject, L), epW, centers[0]), epW, L, null);

  // 再现: 最低声部再陈述一次主题
  const low = nv - 1;
  const lastEntry = transpose(subject, entryShift(low));
  block(low, lastEntry, harmonyOf(fit(lastEntry, L), key, L), L, null);

  // 终止
  codaLines(nv, centers).forEach((seg, v) => push(v, seg));

  const names = VOICE_NAMES[nv];
  const rows = lines.map((line, v) => ({ label: '赋格·' + names[v], text: renderLine(line) }));
  return { rows, subjectBeats: L, voices: nv, totalBeats: (nv + 2) * L + 2 * WIN };
}

if (typeof window !== 'undefined') window.makeFugue = makeFugue;
if (typeof module !== 'undefined') module.exports = { makeFugue, renderLine };
