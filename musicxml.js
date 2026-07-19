// musicxml.js —— 把内部乐谱模型导出成 MusicXML (MuseScore / Sibelius / Finale 均可打开)
// 入口: melodyToMusicXML(voices, opts) -> XML 字符串
//   voices: [{ label, model }]  model 为 parseMelody 结果
//   opts:   { barBeats, pickup, bpm }
//
// 说明: 每个声部导出为一个 part(单声部, 无和弦)。跨小节的长音用连音线(tie)拆开。
//   时值以 480 divisions/四分音符表示 —— 可精确表示三连音(÷3)、五连音(÷5)、附点等。
//   注: 各声部若用了不同速度, MusicXML 只保留旋律的全局速度(多数记谱软件不支持多速度)。

const DIV = 480; // divisions / 四分音符(=1 拍)

const FIFTHS = {
  C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, 'C#': 7,
  F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6, Cb: -7,
};

function xmlEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 时值(拍) -> 音符类型 + 附点数 (尽力而为; 时值本身由 <duration> 精确表示)
function noteType(beats) {
  const T = [[4, 'whole'], [2, 'half'], [1, 'quarter'], [0.5, 'eighth'], [0.25, '16th'], [0.125, '32nd'], [0.0625, '64th']];
  for (const [base, name] of T) {
    if (beats >= base - 1e-6) {
      let dots = 0;
      if (Math.abs(beats - base * 1.75) < 1e-2) dots = 2;
      else if (Math.abs(beats - base * 1.5) < 1e-2) dots = 1;
      return { type: name, dots };
    }
  }
  return { type: '64th', dots: 0 };
}

// 音名(如 "C4" / "D#4") -> { step, alter, octave }; 本项目 midiToName 只用升号
function pitchOf(name) {
  const m = /^([A-G])(#?)(-?\d+)$/.exec(name || '');
  if (!m) return null;
  return { step: m[1], alter: m[2] === '#' ? 1 : 0, octave: +m[3] };
}

function clefOf(model) {
  const notes = model.events.filter((e) => e.type === 'note');
  const med = notes.length ? notes.map((e) => e.midi).sort((a, b) => a - b)[notes.length >> 1] : 67;
  return med < 57 ? { sign: 'F', line: 4 } : { sign: 'G', line: 2 };
}

// 把一个声部的事件按小节切分, 跨线的音符标注连音线; 每小节内空隙补休止
function measuresOf(model, bb, pickup) {
  const total = Math.max(model.totalBeats, 1e-6);
  const pk = bb > 0 ? ((((pickup || 0) % bb) + bb) % bb) : 0;
  // 小节边界(拍)
  const bounds = [0];
  let cur = pk > 0 ? pk : bb;
  bounds.push(cur);
  while (cur < total - 1e-6) { cur += bb; bounds.push(cur); }
  const measures = [];
  for (let i = 0; i < bounds.length - 1; i++) measures.push({ start: bounds[i], end: bounds[i + 1], items: [] });

  // 把每个事件裁进它跨越的小节, 记录连音线关系
  for (const ev of model.events) {
    const s = ev.startBeat, e = ev.startBeat + ev.durBeats;
    const segs = [];
    for (const mz of measures) {
      const cs = Math.max(s, mz.start), ce = Math.min(e, mz.end);
      if (ce - cs > 1e-6) segs.push({ mz, start: cs, dur: ce - cs });
    }
    segs.forEach((seg, k) => {
      let tie = null;
      if (ev.type === 'note' && segs.length > 1) {
        if (k === 0) tie = 'start';
        else if (k === segs.length - 1) tie = 'stop';
        else tie = 'both';
      }
      seg.mz.items.push({ type: ev.type, ev, start: seg.start, dur: seg.dur, tie });
    });
  }

  // 每小节: 按起点排序, 补齐空隙为休止
  for (const mz of measures) {
    mz.items.sort((a, b) => a.start - b.start);
    const out = [];
    let cursor = mz.start;
    for (const it of mz.items) {
      if (it.start - cursor > 1e-6) out.push({ type: 'rest', start: cursor, dur: it.start - cursor, tie: null });
      out.push(it);
      cursor = it.start + it.dur;
    }
    if (mz.end - cursor > 1e-6) out.push({ type: 'rest', start: cursor, dur: mz.end - cursor, tie: null });
    mz.items = out;
  }
  return { measures, pickup: pk > 0 };
}

function noteXML(it) {
  const dur = Math.max(1, Math.round(it.dur * DIV));
  const nt = noteType(it.dur);
  const p = it.type === 'note' ? pitchOf(it.ev.name) : null;
  let x = '        <note>\n';
  if (it.type === 'rest' || !p) x += '          <rest/>\n';
  else {
    x += '          <pitch><step>' + p.step + '</step>';
    if (p.alter) x += '<alter>' + p.alter + '</alter>';
    x += '<octave>' + p.octave + '</octave></pitch>\n';
  }
  x += '          <duration>' + dur + '</duration>\n';
  if (it.tie === 'start') x += '          <tie type="start"/>\n';
  else if (it.tie === 'stop') x += '          <tie type="stop"/>\n';
  else if (it.tie === 'both') x += '          <tie type="stop"/><tie type="start"/>\n';
  x += '          <voice>1</voice>\n';
  x += '          <type>' + nt.type + '</type>\n';
  for (let d = 0; d < nt.dots; d++) x += '          <dot/>\n';
  if (p && p.alter) x += '          <accidental>sharp</accidental>\n';
  if (it.tie) {
    const t = it.tie === 'both' ? '<tied type="stop"/><tied type="start"/>' : '<tied type="' + it.tie + '"/>';
    x += '          <notations>' + t + '</notations>\n';
  }
  x += '        </note>\n';
  return x;
}

function melodyToMusicXML(voices, opts) {
  const o = opts || {};
  const bb = (+o.barBeats > 0) ? +o.barBeats : 4; // 无小节设定时按 4/4 导出
  const pickup = +o.pickup || 0;
  const bpm = +o.bpm || 72;

  let out = '<?xml version="1.0" encoding="UTF-8"?>\n';
  out += '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n';
  out += '<score-partwise version="3.1">\n';
  out += '  <work><work-title>AutoMusician</work-title></work>\n';
  out += '  <identification><encoding><software>AutoMusician</software></encoding></identification>\n';

  // part-list
  out += '  <part-list>\n';
  voices.forEach((v, i) => {
    out += '    <score-part id="P' + (i + 1) + '"><part-name>' + xmlEsc(v.label || ('声部' + (i + 1))) + '</part-name></score-part>\n';
  });
  out += '  </part-list>\n';

  // parts
  voices.forEach((v, vi) => {
    out += '  <part id="P' + (vi + 1) + '">\n';
    const clef = clefOf(v.model);
    const fifths = FIFTHS[v.model.key] != null ? FIFTHS[v.model.key] : 0;
    const { measures, pickup: hasPickup } = measuresOf(v.model, bb, pickup);
    measures.forEach((mz, mi) => {
      const num = mi + 1;
      const implicit = (mi === 0 && hasPickup) ? ' implicit="yes"' : '';
      out += '    <measure number="' + num + '"' + implicit + '>\n';
      if (mi === 0) {
        out += '      <attributes>\n';
        out += '        <divisions>' + DIV + '</divisions>\n';
        out += '        <key><fifths>' + fifths + '</fifths></key>\n';
        out += '        <time><beats>' + bb + '</beats><beat-type>4</beat-type></time>\n';
        out += '        <clef><sign>' + clef.sign + '</sign><line>' + clef.line + '</line></clef>\n';
        out += '      </attributes>\n';
        if (vi === 0) {
          out += '      <direction placement="above"><direction-type>';
          out += '<metronome><beat-unit>quarter</beat-unit><per-minute>' + bpm + '</per-minute></metronome>';
          out += '</direction-type><sound tempo="' + bpm + '"/></direction>\n';
        }
      }
      if (!mz.items.length) {
        // 空小节: 整小节休止
        out += noteXML({ type: 'rest', dur: bb, tie: null });
      } else {
        for (const it of mz.items) out += noteXML(it);
      }
      out += '    </measure>\n';
    });
    out += '  </part>\n';
  });

  out += '</score-partwise>\n';
  return out;
}

if (typeof window !== 'undefined') window.melodyToMusicXML = melodyToMusicXML;
if (typeof module !== 'undefined') module.exports = { melodyToMusicXML };
