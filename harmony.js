// harmony.js —— 规则版自动配和声 (refined)
// 输入: 旋律的内部音符模型 (parseMelody 的结果)
// 输出: { text, chords }
//   text   : 一行"和声"记谱字符串(同一套记号), 分解和弦伴奏(Alberti 根-五-三-五), 整体降八度
//   chords : 每个和声窗口的和弦名, 如 ["C","C","F","G7"...] (这里只用三和弦)
//
// 算法:
//   1. 按固定和声节奏(默认每 2 拍)切窗
//   2. 候选 = 大调内 7 个三和弦 I ii iii IV V vi vii°
//   3. 发射分: 窗内旋律音是否为和弦音(按时值 & 强拍加权) + 和弦先验
//   4. 转移分: 功能和声偏好(V→I, ii→V, IV→V 加分; V→IV 退行扣分; 阻碍 V→vi 等)
//   5. Viterbi DP 求全局最优进行; 起于 I、强烈偏好终于 I (正格终止)

const MAJ_SEMI = [0, 2, 4, 5, 7, 9, 11]; // 各音阶级的半音偏移 (避免与 parser.js 全局名冲突)
const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const FLAT_KEYS = ['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb'];

const QUALITY = ['maj', 'min', 'min', 'maj', 'maj', 'min', 'dim']; // 大调各级三和弦性质
const PRIOR = { 1: 1.0, 2: 0.4, 3: 0.15, 4: 0.7, 5: 0.8, 6: 0.5, 7: 0.15 };
const FUNC = { 1: 'T', 2: 'S', 3: 'T', 4: 'S', 5: 'D', 6: 'T', 7: 'D' };

const deg = (R, step) => ((R - 1 + step) % 7) + 1;           // 第 R 级往上 step 个音阶音
const TRIADS = [1, 2, 3, 4, 5, 6, 7].map((R) => ({ root: R, tones: [R, deg(R, 2), deg(R, 4)], quality: QUALITY[R - 1] }));

function keyPc(key) {
  const m = /^([A-G])([#b]?)$/.exec(key || 'C');
  let pc = PC[m ? m[1] : 'C'];
  if (m && m[2] === '#') pc++;
  if (m && m[2] === 'b') pc--;
  return ((pc % 12) + 12) % 12;
}

function chordName(key, R, quality) {
  const pc = (keyPc(key) + MAJ_SEMI[R - 1]) % 12;
  const names = FLAT_KEYS.includes(key) ? FLAT_NAMES : SHARP_NAMES;
  return names[pc] + (quality === 'min' ? 'm' : quality === 'dim' ? 'dim' : '');
}

// 转移分: 功能和声偏好
function trans(a, b) {
  if (a === b) return 0.2;
  const special = {
    '5>1': 1.3, '7>1': 0.9, '4>1': 0.6,                 // 终止: 正格/导/变格
    '2>5': 1.1, '4>5': 0.9, '6>5': 0.5,                 // 走向属功能
    '5>6': 0.6,                                          // 阻碍终止
    '1>4': 0.6, '1>5': 0.6, '1>6': 0.5, '1>2': 0.4,     // 离开主功能
    '6>4': 0.5, '6>2': 0.5, '3>6': 0.4, '2>4': 0.3,
    '5>4': -0.6, '4>3': -0.3,                            // 退行 / 弱进行
  };
  const k = a + '>' + b;
  if (k in special) return special[k];
  const order = { T: 0, S: 1, D: 2 };
  const fa = order[FUNC[a]], fb = order[FUNC[b]];
  if ((fa + 1) % 3 === fb) return 0.4;  // 顺功能 T→S→D
  if (fb === 0) return 0.3;             // 回主功能
  return 0;
}

// 窗内对 7 个候选和弦的发射分
function emissionFor(model, start, end) {
  const notes = model.events.filter((e) => e.type === 'note' && Math.min(e.startBeat + e.durBeats, end) > Math.max(e.startBeat, start));
  return TRIADS.map((tri) => {
    let s = PRIOR[tri.root];
    notes.forEach((n) => {
      const a = Math.max(n.startBeat, start), b = Math.min(n.startBeat + n.durBeats, end);
      const dur = b - a;
      if (dur <= 0) return;
      const w = dur * (a <= start + 1e-6 ? 1.5 : 1.0);   // 强拍(窗首)加权
      const dgr = ((n.degree - 1) % 7) + 1;
      if (!n.accidental && tri.tones.includes(dgr)) s += w * 2.0;   // 和弦音
      else if (!n.accidental) s += w * 0.2;                        // 调内经过音
      else s -= w * 0.5;                                           // 变化音, 轻罚
    });
    return s;
  });
}

function analyze(model, opts) {
  const win = (opts && opts.win) || 2;
  const total = model.totalBeats;
  const wins = [];
  for (let st = 0; st < total - 1e-6; st += win) {
    const end = Math.min(st + win, total);
    wins.push({ start: st, end, beats: Math.max(1, Math.round(end - st)) });
  }
  const n = wins.length;
  if (!n) return { windows: [], chords: [] };

  const emis = wins.map((w) => emissionFor(model, w.start, w.end));
  emis[0][0] += 0.5;        // 起于 I
  emis[n - 1][0] += 2.0;    // 终于 I (正格终止)

  // Viterbi
  const dp = [emis[0].slice()], bk = [null];
  for (let w = 1; w < n; w++) {
    dp[w] = new Array(7); bk[w] = new Array(7);
    for (let c = 0; c < 7; c++) {
      let best = -1e9, bestp = 0;
      for (let p = 0; p < 7; p++) {
        const v = dp[w - 1][p] + trans(p + 1, c + 1);
        if (v > best) { best = v; bestp = p; }
      }
      dp[w][c] = best + emis[w][c];
      bk[w][c] = bestp;
    }
  }
  let c = 0, bv = -1e9;
  for (let k = 0; k < 7; k++) if (dp[n - 1][k] > bv) { bv = dp[n - 1][k]; c = k; }
  const chosen = new Array(n);
  chosen[n - 1] = c;
  for (let w = n - 1; w > 0; w--) chosen[w - 1] = bk[w][chosen[w]];

  const windows = wins.map((w, i) => {
    const R = chosen[i] + 1, q = QUALITY[R - 1];
    return { start: w.start, beats: w.beats, root: R, quality: q, tones: TRIADS[R - 1].tones, name: chordName(model.key, R, q) };
  });
  return { windows, chords: windows.map((w) => w.name) };
}

// 分解和弦(Alberti 根-五-三-五): 一行, 每窗一组琶音
function albertiRow(windows) {
  let text = '-';
  for (const w of windows) {
    const R = w.root, F = deg(R, 4), T = deg(R, 2);
    text += w.beats >= 2 ? `[${R}${F}${T}${F}]` : String(R).repeat(w.beats);
  }
  return text;
}

// 持续声部: 取每个和弦的第 step 个音(0根/2三/4五), 相邻同音延续不重击(共同音保持)
function sustainRow(windows, step) {
  let text = '-', prev = null, run = 0;
  const flush = () => { if (prev != null) text += String(prev).repeat(run) + "'"; };
  for (const w of windows) {
    const d = deg(w.root, step);
    if (d === prev) run += w.beats;
    else { flush(); prev = d; run = w.beats; }
  }
  flush();
  return text.replace(/'$/, '');
}

// 按织体生成和声声部(行)
//   texture: 'block' 柱式和弦(根/三/五三行) | 'broken' 分解和弦(一行) | 'bass' 低音线(一行)
function autoHarmonize(model, opts) {
  const texture = (opts && opts.texture) || 'block';
  const { windows, chords } = analyze(model, opts);
  if (!windows.length) return { rows: [], chords: [] };
  let rows;
  if (texture === 'broken') rows = [{ label: '和声', text: albertiRow(windows) }];
  else if (texture === 'bass') rows = [{ label: '和声·低音', text: sustainRow(windows, 0) }];
  else rows = [
    { label: '和声·五', text: sustainRow(windows, 4) },
    { label: '和声·三', text: sustainRow(windows, 2) },
    { label: '和声·根', text: sustainRow(windows, 0) },
  ];
  return { rows, chords };
}

if (typeof window !== 'undefined') { window.autoHarmonize = autoHarmonize; window.analyzeHarmony = analyze; }
if (typeof module !== 'undefined') module.exports = { autoHarmonize, analyze, chordName };
