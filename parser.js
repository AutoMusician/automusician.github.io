// parser.js —— 把文本记谱解析成内部音符模型
//
// 记谱规则：
//   音高:   1-7 = do re mi fa sol la si (相对调号的唱名), 0 = 休止符
//   时值:   相邻相同记号重复 = 延长一拍/次; 空格断开 = 重新触发
//           例: 111 = do 占 3 拍;  1 1 = 两个独立的 do
//   连音:   [ ... ] 内固定占 2 拍, 内部音均分
//           例: [123] = 三连音;  [12345] = 五连音
//   八度:   前缀 + 高八度, - 低八度, 可叠加 (++1 高两个八度)
//   升降:   后缀 # 升, b 降 (顺序: 八度在前, 升降在后, 如 +1#)
//   转调:   (1=Bb) 从此处起切换调号, 影响后续所有音
//   首行:   可选, 调号+速度, 如 "1=G 120"; 默认 1=C / 72

const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11]; // 大调音阶各级的半音偏移
const PITCH_CLASS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// 字母音符简写(大写, 不改变累积八度状态)。oct = 相对当前八度的偏移; suffix=true 允许再跟 #/b
// 设计: QWERTY 行=黑键(升音), 数字行=白键; 字母 C..B=低八度自然音; 8/9/P=高八度自然音
const SHORT_NOTES = {
  '8': { digit: 1, oct: 1, acc: '', suffix: true },   // 高 do
  '9': { digit: 2, oct: 1, acc: '', suffix: true },   // 高 re
  P: { digit: 3, oct: 1, acc: '', suffix: true },     // 高 mi
  C: { digit: 1, oct: -1, acc: '', suffix: true },    // 低 do
  D: { digit: 2, oct: -1, acc: '', suffix: true },    // 低 re
  E: { digit: 3, oct: -1, acc: '', suffix: true },    // 低 mi
  F: { digit: 4, oct: -1, acc: '', suffix: true },    // 低 fa
  G: { digit: 5, oct: -1, acc: '', suffix: true },    // 低 sol
  A: { digit: 6, oct: -1, acc: '', suffix: true },    // 低 la
  B: { digit: 7, oct: -1, acc: '', suffix: true },    // 低 si
  Q: { digit: 1, oct: 0, acc: '#' },   // #1
  W: { digit: 2, oct: 0, acc: '#' },   // #2
  R: { digit: 4, oct: 0, acc: '#' },   // #4
  T: { digit: 5, oct: 0, acc: '#' },   // #5
  Y: { digit: 6, oct: 0, acc: '#' },   // #6
  I: { digit: 1, oct: 1, acc: '#' },   // #8 = 高 #1
  O: { digit: 2, oct: 1, acc: '#' },   // #9 = 高 #2
};

function keyToRootMidi(letter) {
  // 把调号 (do 落在哪个音) 映射到 4 区附近的 MIDI 音高
  const m = /^([A-Ga-g])([#bB]?)$/.exec(letter || '');
  if (!m) return 60; // 默认 C4
  let pc = PITCH_CLASS[m[1].toUpperCase()];
  if (m[2] === '#') pc += 1;
  else if (m[2].toLowerCase() === 'b') pc -= 1;
  return 60 + ((pc % 12) + 12) % 12;
}

function midiToName(midi) {
  const pc = ((midi % 12) + 12) % 12;
  return NOTE_NAMES[pc] + (Math.floor(midi / 12) - 1);
}

// 规范化调号显示: 字母大写 + 升降号小写, 如 "eB" -> "Eb", "f#" -> "F#"
function normalizeKey(s) {
  const m = /^([A-Ga-g])([#bB]?)$/.exec(s || '');
  if (!m) return (s || '').toUpperCase();
  return m[1].toUpperCase() + (m[2] ? (m[2] === '#' ? '#' : 'b') : '');
}

// 解析可选的首行说明: "1=G 120" / "(1=G 0=120)" / "key=G bpm=120" / "120"
//   调号: 1=X 或 key=X;  速度: 0=NNN 或 bpm=NNN 或裸数字; 括号可有可无
function parseHeader(line, defaults) {
  const d = defaults || {};
  const out = { key: d.key || 'C', bpm: d.bpm || 72, hasHeader: false };
  if (!line) return out;
  let found = false;
  let m;
  if ((m = /([1-7])\s*=\s*([A-Ga-g][#b]?)/.exec(line))) { out.key = normalizeKey(m[2]); found = true; }
  if ((m = /key\s*=\s*([A-Ga-g][#b]?)/i.exec(line))) { out.key = normalizeKey(m[1]); found = true; }
  if ((m = /(?:^|[\s(])0\s*=\s*(\d+)/.exec(line))) { out.bpm = +m[1]; found = true; }
  else if ((m = /bpm\s*=\s*(\d+)/i.exec(line))) { out.bpm = +m[1]; found = true; }
  else if ((m = /(?:^|\s)(\d{2,3})(?:\s|$)/.exec(line))) { out.bpm = +m[1]; found = true; }
  out.hasHeader = found;
  return out;
}

// 一行是否是"纯声明行"(只有 X=Y 声明, 没有音符内容) —— 供和声行判别首行是否为表头。
// 括号声明 (1=G 0=120) 由词法器就地处理, 这里不算, 所以含括号一律返回 false。
function isPureHeaderLine(line) {
  if (!line || /[()]/.test(line)) return false;
  let had = false;
  let s = ' ' + line + ' ';
  s = s.replace(/([1-7])\s*=\s*([A-Ga-g][#b]?)/g, () => { had = true; return ' '; });
  s = s.replace(/key\s*=\s*([A-Ga-g][#b]?)/gi, () => { had = true; return ' '; });
  s = s.replace(/(?:^|\s)0\s*=\s*(\d+)/g, () => { had = true; return ' '; });
  s = s.replace(/bpm\s*=\s*(\d+)/gi, () => { had = true; return ' '; });
  return had && s.trim() === '';
}

function noteKey(t) { return t.octaves + '|' + t.digit + '|' + t.accidental; }

function rawOf(t) {
  const oct = t.octaves > 0 ? '+'.repeat(t.octaves) : t.octaves < 0 ? '-'.repeat(-t.octaves) : '';
  return oct + t.digit + t.accidental;
}

// 第一步: 把旋律字符串扫描成 token 流。base = str 在原文本中的起始偏移,
// 每个音符 token 记录其在原文本中的字符范围 [pos, end) 供点击选中/插入小节线用。
function tokenize(str, errors, base) {
  base = base || 0;
  const tokens = [];
  let i = 0;
  while (i < str.length) {
    const c = str[i];
    const at = i + base;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; } // 空白仅作排版, 忽略
    if (c === "'") { tokens.push({ kind: 'sep' }); i++; continue; }              // ' = 断开 / 重新触发
    if (c === '|') { tokens.push({ kind: 'bar' }); i++; continue; }              // 小节线, 纯装饰
    if (c === '[') { tokens.push({ kind: 'bopen' }); i++; continue; }
    if (c === ']') { tokens.push({ kind: 'bclose' }); i++; continue; }
    if (c === '(') {
      // 括号声明: (1=G) 转调, (0=120) 变速, (1=G 0=120) 同时; 也支持 key=/bpm=
      const grp = /^\(([^)]*)\)/.exec(str.slice(i));
      if (grp) {
        const inner = grp[1];
        let key = null, bpm = null, mm;
        if ((mm = /([1-7])\s*=\s*([A-Ga-g][#b]?)/.exec(inner))) key = normalizeKey(mm[2]);
        else if ((mm = /key\s*=\s*([A-Ga-g][#b]?)/i.exec(inner))) key = normalizeKey(mm[1]);
        if ((mm = /(?:^|\s)0\s*=\s*(\d+)/.exec(inner)) || (mm = /bpm\s*=\s*(\d+)/i.exec(inner))) bpm = +mm[1];
        if (key || bpm) {
          tokens.push({ kind: 'keychange', key, bpm, pos: at, end: at + grp[0].length });
          i += grp[0].length;
          continue;
        }
        errors.push(`无法识别的括号标注 "${grp[0]}"`);
        i += grp[0].length;
        continue;
      }
      errors.push('"(" 没有匹配的 ")"'); i++;
      continue;
    }
    if (c === ')') { i++; continue; }
    if (c === '.') { tokens.push({ kind: 'dot', pos: at, end: at + 1 }); i++; continue; } // 附点: 时值 ×1.5
    // +/- 是独立的移调记号: 从此处起累积升/降八度, 影响后续所有音
    if (c === '+') { tokens.push({ kind: 'octup' }); i++; continue; }
    if (c === '-') { tokens.push({ kind: 'octdown' }); i++; continue; }
    const m = /^([0-7])([#b]?)/.exec(str.slice(i));
    if (m) {
      tokens.push({ kind: 'note', digit: +m[1], accidental: m[2] || '', octShift: 0, pos: at, end: at + m[0].length });
      i += m[0].length;
      continue;
    }
    // 字母音符简写 (见 SHORT_NOTES): 黑键 QWRTYIO / 低音 C-G·A·B / 高音 8·9·P
    const sh = SHORT_NOTES[c];
    if (sh) {
      let acc = sh.acc, adv = 1;
      if (sh.suffix && (str[i + 1] === '#' || str[i + 1] === 'b')) { acc = str[i + 1]; adv = 2; }
      tokens.push({ kind: 'note', digit: sh.digit, accidental: acc, octShift: sh.oct, pos: at, end: at + adv });
      i += adv;
      continue;
    }
    errors.push(`无法识别的字符 "${c}"`);
    i++;
  }
  return tokens;
}

// 把累积的 +/- 移调解析掉: 维护一个跑动的八度偏移, 写到每个音上,
// octup/octdown 记号本身被消费掉, 其余 token 原样保留
function resolveOctaves(tokens) {
  const out = [];
  let octave = 0;
  for (const t of tokens) {
    if (t.kind === 'octup') { octave++; continue; }
    if (t.kind === 'octdown') { octave--; continue; }
    if (t.kind === 'note') out.push({ kind: 'note', digit: t.digit, accidental: t.accidental, octaves: octave + (t.octShift || 0), pos: t.pos, end: t.end });
    else out.push(t);
  }
  return out;
}

// 附点系数: 1 个点 ×1.5, 2 个点 ×1.75 ...
function dotFactor(dots) { return 2 - Math.pow(0.5, dots); }

// 把一段 note/sep token 按"相邻相同记号"合并, 并吞掉后随的附点; 返回每组的时值权重
function mergeRuns(list) {
  const out = [];
  let k = 0;
  while (k < list.length) {
    if (list[k].kind !== 'note') { k++; continue; }
    const t = list[k];
    let len = 1, j = k + 1, last = k;
    while (j < list.length) {
      if (list[j].kind === 'bar') { j++; continue; } // 小节线透明
      if (list[j].kind === 'note' && noteKey(list[j]) === noteKey(t)) { len++; last = j; j++; }
      else break;
    }
    let dots = 0, m = last + 1;
    while (m < list.length && list[m].kind === 'dot') { dots++; m++; }
    out.push({ tok: t, weight: len * dotFactor(dots), srcStart: t.pos, srcEnd: dots ? list[m - 1].end : list[last].end });
    k = m;
  }
  return out;
}

function makeEvent(t, startBeat, durBeats, root) {
  if (t.digit === 0) {
    return { type: 'rest', startBeat, durBeats, raw: '0' };
  }
  let semis = MAJOR_STEPS[t.digit - 1];
  if (t.accidental === '#') semis += 1;
  else if (t.accidental === 'b') semis -= 1;
  const midi = root + semis + 12 * t.octaves;
  return {
    type: 'note', midi, name: midiToName(midi),
    degree: t.digit, accidental: t.accidental, octaves: t.octaves,
    startBeat, durBeats, raw: rawOf(t),
  };
}

// 第二步: 把 token 流编译成带拍位的事件序列
// tempos: [{ beat, bpm }] 分段恒速表, 供播放时把"拍"换算成"秒"(支持中途变速)
function build(tokens, initialRoot, initialBpm, errors) {
  const events = [];
  const bars = [];
  const tempos = [{ beat: 0, bpm: initialBpm || 72 }];
  let root = initialRoot;
  let beat = 0, i = 0, lastWasSep = false;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.kind === 'keychange') {
      if (t.key) root = keyToRootMidi(t.key);
      if (t.bpm) {
        const last = tempos[tempos.length - 1];
        if (Math.abs(last.beat - beat) < 1e-6) last.bpm = t.bpm; // 同一拍位上的重复声明: 覆盖
        else tempos.push({ beat, bpm: t.bpm });
      }
      i++; continue;
    }
    if (t.kind === 'sep') { lastWasSep = true; i++; continue; }
    if (t.kind === 'bar') { bars.push(beat); i++; continue; }
    if (t.kind === 'bclose') { errors.push('多余的 "]"'); i++; continue; }
    if (t.kind === 'bopen') {
      const sepBefore = lastWasSep;
      lastWasSep = false;
      const inner = [];
      i++;
      while (i < tokens.length && tokens[i].kind !== 'bclose') { inner.push(tokens[i]); i++; }
      if (i >= tokens.length) errors.push('"[" 没有匹配的 "]"');
      else i++;
      let innerSep = false;
      for (const tt of inner) { if (tt.kind === 'note') break; if (tt.kind === 'sep') { innerSep = true; break; } }
      const groups = mergeRuns(inner);
      const totalSlots = groups.reduce((s, g) => s + g.weight, 0) || 1;
      let local = beat;
      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi];
        const dur = 2 * g.weight / totalSlots;
        const ev = makeEvent(g.tok, local, dur, root);
        ev.srcStart = g.srcStart; ev.srcEnd = g.srcEnd;
        if (gi === 0 && !sepBefore && !innerSep && events.length > 0) {
          const prev = events[events.length - 1];
          if (prev.type === 'note' && ev.type === 'note' && prev.midi === ev.midi) {
            prev.durBeats += dur;
            prev.srcEnd = ev.srcEnd;
            local += dur;
            continue;
          }
        }
        events.push(ev);
        local += dur;
      }
      beat += 2;
      continue;
    }
    if (t.kind === 'note') {
      const hadSep = lastWasSep;
      lastWasSep = false;
      let len = 1, j = i + 1, last = i;
      while (j < tokens.length) {
        if (tokens[j].kind === 'bar') { j++; continue; }
        if (tokens[j].kind === 'note' && noteKey(tokens[j]) === noteKey(t)) { len++; last = j; j++; }
        else break;
      }
      let dots = 0, k = last + 1;
      while (k < tokens.length && tokens[k].kind === 'dot') { dots++; k++; }
      const dur = len * dotFactor(dots);
      const ev = makeEvent(t, beat, dur, root);
      ev.srcStart = t.pos; ev.srcEnd = dots ? tokens[k - 1].end : tokens[last].end;
      if (!hadSep && events.length > 0) {
        const prev = events[events.length - 1];
        if (prev.type === 'note' && ev.type === 'note' && prev.midi === ev.midi
            && Math.abs(prev.startBeat + prev.durBeats - beat) < 1e-6) {
          prev.durBeats += dur;
          prev.srcEnd = ev.srcEnd;
          beat += dur;
          i = k;
          continue;
        }
      }
      events.push(ev);
      beat += dur;
      i = k;
    } else {
      i++;
    }
  }
  return { events, bars, totalBeats: beat, tempos };
}

function parseMelody(text, opts) {
  const errors = [];
  const raw = text || '';
  const d = opts || {};
  let header = { key: d.key || 'C', bpm: d.bpm || 72, hasHeader: false };
  let bodyStart = 0;
  if (!d.bodyOnly) {
    const nl = raw.indexOf('\n');                 // 旋律: 首行恒为调号/速度说明, 不判别
    header = parseHeader(nl === -1 ? raw : raw.slice(0, nl), d);
    bodyStart = nl === -1 ? raw.length : nl + 1;
  } else {
    // 和声行: 默认跟随旋律调号/速度; 首行若是"纯声明行"(如 "1=Bb" / "1=Bb 0=90") 则吃掉当表头。
    // 括号声明 (1=Bb 0=90) 不在此处理, 交给词法器就地生效(下面的 fold 逻辑会补进表头供显示)。
    const nl = raw.indexOf('\n');
    const first = nl === -1 ? raw : raw.slice(0, nl);
    if (isPureHeaderLine(first)) {
      header = parseHeader(first, d);
      bodyStart = nl === -1 ? raw.length : nl + 1;
    }
  }
  // 直接对原文本切片做词法分析(换行被当空白跳过), 偏移加 bodyStart -> 映射回 textarea 原位置
  const tokens = resolveOctaves(tokenize(raw.slice(bodyStart), errors, bodyStart));
  // 开头(第 0 拍)的括号声明并入表头, 让状态栏能显示实际的调号/速度
  for (const tk of tokens) {
    if (tk.kind === 'note' || tk.kind === 'bopen') break;
    if (tk.kind === 'keychange') { if (tk.key) header.key = tk.key; if (tk.bpm) header.bpm = tk.bpm; }
  }
  const root = keyToRootMidi(header.key);
  const { events, bars, totalBeats, tempos } = build(tokens, root, header.bpm, errors);
  return { key: header.key, bpm: header.bpm, root, events, bars, totalBeats, tempos, errors };
}

if (typeof module !== 'undefined') module.exports = { parseMelody, midiToName, keyToRootMidi };
