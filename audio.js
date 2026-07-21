// audio.js —— 基于 Web Audio API 的播放引擎 (零依赖)
// 默认音色: 方波振荡器 (经典蜂鸣音); 也可换其它波形, 或加载一段采样做简易采样器

// 分段恒速: 把"拍位"换算成"从第 0 拍起的秒数", 支持中途变速。
//   tempos = [{ beat, bpm }] 按 beat 升序, 第一段 beat 恒为 0。
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
// 逆映射: 秒数 -> 拍位
function timeToBeat(tempos, time) {
  let acc = 0;
  for (let i = 0; i < tempos.length; i++) {
    const seg = tempos[i], next = tempos[i + 1];
    const segEnd = next ? next.beat : Infinity;
    const spb = 60 / seg.bpm;
    const segDur = (segEnd - seg.beat) * spb;
    if (!next || time <= acc + segDur) return seg.beat + (time - acc) / spb;
    acc += segDur;
  }
  return 0;
}

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.wave = 'square';      // 默认蜂鸣音
    this.sample = null;        // { buffer, baseMidi }  加载的音色采样
    this.scheduled = [];       // 已排程的发声节点, 用于 stop()
    this.playing = false;
    this.raf = null;
  }

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.28;
      this.master.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  // Safari/iOS 解锁: 必须在用户手势内"同步"播放一个静音 buffer 并 resume,
  // 否则 AudioContext 一直是 suspended, 后面排程的音全都无声。
  // Safari 会在页面切后台/久置后再次挂起, 所以每次交互都重新解锁一次最稳。
  unlock() {
    const ctx = this.ensure();
    try {
      const b = ctx.createBuffer(1, 1, 22050);
      const s = ctx.createBufferSource();
      s.buffer = b; s.connect(ctx.destination); s.start(0);
    } catch (e) { /* 某些浏览器重复解锁会抛错, 忽略 */ }
    if (ctx.state !== 'running' && ctx.resume) { try { ctx.resume(); } catch (e) {} }
    return ctx;
  }

  midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  async loadSample(file, baseMidi = 60) {
    const ctx = this.ensure();
    const buf = await file.arrayBuffer();
    const audio = await ctx.decodeAudioData(buf);
    this.sample = { buffer: audio, baseMidi };
  }

  clearSample() { this.sample = null; }

  async testBeep() {
    const ctx = this.unlock();               // 同步解锁 (在 click 手势内)
    if (ctx.state !== 'running') { try { await ctx.resume(); } catch (e) {} }
    this.scheduleNote(69, ctx.currentTime + 0.05, 0.4);
    return ctx.state;
  }

  state() { return this.ctx ? this.ctx.state : 'none'; }

  scheduleNote(midi, start, dur, level, wave) {
    const peak = level == null ? 1 : level;
    if (this.sample) return this.scheduleSample(midi, start, dur, peak);
    const w = wave || this.wave;
    if (w === 'piano') return this.schedulePiano(midi, start, dur, peak);
    if (w === 'violin') return this.scheduleViolin(midi, start, dur, peak);
    if (w === 'horn') return this.scheduleHorn(midi, start, dur, peak);
    if (w === 'guitar') return this.scheduleGuitar(midi, start, dur, peak);
    if (w === 'flute') return this.scheduleFlute(midi, start, dur, peak);
    if (w === 'chime') return this.scheduleChime(midi, start, dur, peak);
    if (w === 'glock') return this.scheduleGlock(midi, start, dur, peak);
    if (w === 'ethereal') return this.scheduleEthereal(midi, start, dur, peak);
    return this.scheduleOsc(midi, start, dur, peak, w);
  }

  // 通用 ADSR-ish 包络节点(平台型: 起音→持续→释音), 连到主输出
  basicEnv(start, dur, peak) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    const a = 0.008, r = Math.min(0.08, dur * 0.3);
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(peak, start + a);
    g.gain.setValueAtTime(peak, start + Math.max(a, dur - r));
    g.gain.linearRampToValueAtTime(0, start + dur);
    g.connect(this.master);
    return g;
  }

  scheduleOsc(midi, start, dur, peak, wave) {
    const ctx = this.ctx;
    const g = this.basicEnv(start, dur, peak);
    const o = ctx.createOscillator();
    o.type = wave || this.wave;
    o.frequency.value = this.midiToFreq(midi);
    o.connect(g); o.start(start); o.stop(start + dur + 0.05);
    this.scheduled.push(o);
  }

  scheduleSample(midi, start, dur, peak) {
    const ctx = this.ctx;
    const g = this.basicEnv(start, dur, peak);
    const s = ctx.createBufferSource();
    s.buffer = this.sample.buffer;
    s.playbackRate.value = this.midiToFreq(midi) / this.midiToFreq(this.sample.baseMidi);
    s.connect(g); s.start(start); s.stop(start + dur + 0.05);
    this.scheduled.push(s);
  }

  // 合成钢琴: 多泛音 + 敲击式快起音/指数衰减 + 低通由亮渐暗
  schedulePiano(midi, start, dur, peak) {
    const ctx = this.ctx;
    const f = this.midiToFreq(midi);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Math.min(9000, f * 7), start);
    lp.frequency.exponentialRampToValueAtTime(Math.max(500, f * 2), start + Math.min(dur, 1.4));
    const g = ctx.createGain();
    const p = peak * 0.9;
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(p, start + 0.005);             // 极快起音
    g.gain.exponentialRampToValueAtTime(Math.max(0.0006, p * 0.05), start + dur * 0.9 + 0.05); // 指数衰减
    g.gain.linearRampToValueAtTime(0, start + dur + 0.06);
    lp.connect(g); g.connect(this.master);
    for (const [mult, amt, type] of [[1, 1, 'triangle'], [2, 0.3, 'sine'], [3, 0.12, 'sine'], [4, 0.05, 'sine']]) {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = f * mult;
      const pg = ctx.createGain(); pg.gain.value = amt;
      o.connect(pg); pg.connect(lp);
      o.start(start); o.stop(start + dur + 0.12);
      this.scheduled.push(o);
    }
  }

  // 合成提琴: 锯齿(弦) + 低通 + 慢起音持续 + 颤音 LFO
  scheduleViolin(midi, start, dur, peak) {
    const ctx = this.ctx;
    const f = this.midiToFreq(midi);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = Math.min(6500, f * 6); lp.Q.value = 0.8;
    const g = ctx.createGain();
    const p = peak * 0.5;
    const a = Math.min(0.09, dur * 0.4), r = Math.min(0.14, dur * 0.35);
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(p, start + a);                 // 慢起音
    g.gain.setValueAtTime(p, start + Math.max(a, dur - r));
    g.gain.linearRampToValueAtTime(0, start + dur);
    lp.connect(g); g.connect(this.master);
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
    const lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 5.5;
    const lfoGain = ctx.createGain(); lfoGain.gain.value = f * 0.006; // 颤音深度 ~ 几个音分
    lfo.connect(lfoGain); lfoGain.connect(o.frequency);
    o.connect(lp);
    o.start(start); o.stop(start + dur + 0.05);
    lfo.start(start); lfo.stop(start + dur + 0.05);
    this.scheduled.push(o, lfo);
  }

  getNoiseBuffer() {
    if (!this._noiseBuf) {
      const ctx = this.ctx;
      const len = ctx.sampleRate;
      this._noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this._noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    return this._noiseBuf;
  }

  scheduleHorn(midi, start, dur, peak) {
    const ctx = this.ctx;
    const f = this.midiToFreq(midi);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = Math.min(3000, f * 5); lp.Q.value = 0.7;
    const g = ctx.createGain();
    const p = peak * 0.55;
    const a = Math.min(0.05, dur * 0.3), r = Math.min(0.12, dur * 0.3);
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(p, start + a);
    g.gain.setValueAtTime(p, start + Math.max(a, dur - r));
    g.gain.linearRampToValueAtTime(0, start + dur);
    lp.connect(g); g.connect(this.master);
    let fund;
    for (const [mult, amt] of [[1, 1], [2, 0.45], [3, 0.2], [4, 0.12]]) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f * mult;
      const pg = ctx.createGain(); pg.gain.value = amt;
      o.connect(pg); pg.connect(lp);
      o.start(start); o.stop(start + dur + 0.1);
      this.scheduled.push(o);
      if (mult === 1) fund = o;
    }
    const lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 4.5;
    const lg = ctx.createGain(); lg.gain.value = f * 0.004;
    lfo.connect(lg); lg.connect(fund.frequency);
    lfo.start(start); lfo.stop(start + dur + 0.1);
    this.scheduled.push(lfo);
  }

  scheduleGuitar(midi, start, dur, peak) {
    const ctx = this.ctx;
    const f = this.midiToFreq(midi);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Math.min(8000, f * 8), start);
    lp.frequency.exponentialRampToValueAtTime(Math.max(400, f * 1.5), start + Math.min(dur, 0.8));
    const g = ctx.createGain();
    const p = peak * 0.8;
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(p, start + 0.003);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, p * 0.02), start + Math.min(dur * 0.85, 1.2) + 0.01);
    g.gain.linearRampToValueAtTime(0, start + dur);
    lp.connect(g); g.connect(this.master);
    for (const [mult, amt, type] of [[1, 1, 'triangle'], [2, 0.5, 'sine'], [3, 0.25, 'sine'], [4, 0.12, 'sine'], [5, 0.06, 'sine']]) {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = f * mult;
      const pg = ctx.createGain(); pg.gain.value = amt;
      o.connect(pg); pg.connect(lp);
      o.start(start); o.stop(start + dur + 0.1);
      this.scheduled.push(o);
    }
  }

  scheduleFlute(midi, start, dur, peak) {
    const ctx = this.ctx;
    const f = this.midiToFreq(midi);
    const g = ctx.createGain();
    const p = peak * 0.5;
    const a = Math.min(0.04, dur * 0.25), r = Math.min(0.1, dur * 0.3);
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(p, start + a);
    g.gain.setValueAtTime(p, start + Math.max(a, dur - r));
    g.gain.linearRampToValueAtTime(0, start + dur);
    g.connect(this.master);
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
    o.connect(g); o.start(start); o.stop(start + dur + 0.1);
    this.scheduled.push(o);
    const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = f * 2;
    const g2 = ctx.createGain(); g2.gain.value = 0.12;
    o2.connect(g2); g2.connect(g); o2.start(start); o2.stop(start + dur + 0.1);
    this.scheduled.push(o2);
    const lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 5;
    const lg = ctx.createGain(); lg.gain.value = f * 0.005;
    lfo.connect(lg); lg.connect(o.frequency);
    lfo.start(start); lfo.stop(start + dur + 0.1);
    this.scheduled.push(lfo);
    const noise = ctx.createBufferSource(); noise.buffer = this.getNoiseBuffer(); noise.loop = true;
    const ng = ctx.createGain(); ng.gain.value = 0.03;
    const nlp = ctx.createBiquadFilter(); nlp.type = 'bandpass'; nlp.frequency.value = f; nlp.Q.value = 2;
    noise.connect(ng); ng.connect(nlp); nlp.connect(g);
    noise.start(start); noise.stop(start + dur + 0.1);
    this.scheduled.push(noise);
  }

  // 编钟: 青铜钟的敲击 —— 低"嗡"音 + 一串非谐(金属)泛音 + 很长的余韵, "咚——"的钟声
  scheduleChime(midi, start, dur, peak) {
    const ctx = this.ctx;
    const f = this.midiToFreq(midi);
    const ring = Math.min(3.2, dur + 1.8);          // 钟声余韵很长
    const g = ctx.createGain();
    const p = peak * 0.5;
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(p, start + 0.005);                                   // 敲击起音
    g.gain.exponentialRampToValueAtTime(Math.max(0.0004, p * 0.02), start + ring);      // 长指数衰减
    g.connect(this.master);
    // 0.5 为低"嗡"音(青铜钟体的余响), 其余为非谐金属泛音
    for (const [r, amt] of [[0.5, 0.22], [1, 1], [2.76, 0.5], [5.18, 0.28], [8.16, 0.15]]) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f * r;
      const pg = ctx.createGain(); pg.gain.value = amt;
      o.connect(pg); pg.connect(g);
      o.start(start); o.stop(start + ring + 0.1);
      this.scheduled.push(o);
    }
    // 起音的一下噪声撞击 (较柔, 是"咚"不是"叮")
    const noise = ctx.createBufferSource(); noise.buffer = this.getNoiseBuffer();
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = Math.min(6000, f * 2.5);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(p * 0.35, start);
    ng.gain.exponentialRampToValueAtTime(0.0002, start + 0.06);
    noise.connect(hp); hp.connect(ng); ng.connect(this.master);
    noise.start(start); noise.stop(start + 0.09);
    this.scheduled.push(noise);
  }

  // 钟琴(glockenspiel): 敲击金属条 —— 音高干净明亮、"叮"一声、余韵短而清脆
  scheduleGlock(midi, start, dur, peak) {
    const ctx = this.ctx;
    const f = this.midiToFreq(midi);
    const ring = Math.min(1.6, dur + 0.8);          // 干净短促的余韵
    const g = ctx.createGain();
    const p = peak * 0.5;
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(p, start + 0.002);                                   // 干脆敲击
    g.gain.exponentialRampToValueAtTime(Math.max(0.0004, p * 0.02), start + ring);
    g.connect(this.master);
    // 接近谐音(八度为主) -> 音高干净; 顶部一点非谐给金属清脆感
    for (const [r, amt] of [[1, 1], [2, 0.5], [4, 0.16], [5.4, 0.08]]) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f * r;
      const pg = ctx.createGain(); pg.gain.value = amt;
      o.connect(pg); pg.connect(g);
      o.start(start); o.stop(start + ring + 0.05);
      this.scheduled.push(o);
    }
    // 极短高频撞击 = 清脆的"叮"
    const noise = ctx.createBufferSource(); noise.buffer = this.getNoiseBuffer();
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = Math.min(12000, f * 6);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(p * 0.4, start);
    ng.gain.exponentialRampToValueAtTime(0.0002, start + 0.02);
    noise.connect(hp); hp.connect(ng); ng.connect(this.master);
    noise.start(start); noise.stop(start + 0.035);
    this.scheduled.push(noise);
  }

  // 空灵 pad: 慢起慢收 + 微失谐叠层(宽) + 高八度/两高八度微光 + 缓慢颤动 —— 流行/史诗那种空旷感
  scheduleEthereal(midi, start, dur, peak) {
    const ctx = this.ctx;
    const f = this.midiToFreq(midi);
    const g = ctx.createGain();
    const p = peak * 0.4;
    const a = Math.min(0.35, dur * 0.5), r = Math.min(0.6, dur * 0.5);
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(p, start + a);                  // 慢起音
    g.gain.setValueAtTime(p, start + Math.max(a, dur - r));
    g.gain.linearRampToValueAtTime(0, start + dur + 0.35);         // 尾韵飘散
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = Math.min(5200, f * 6); lp.Q.value = 0.3;
    lp.connect(g); g.connect(this.master);
    // [倍频, 失谐(音分), 波形, 幅度] —— 微失谐叠层做出宽度, 高倍频做出微光
    for (const [mult, det, type, amt] of [[1, 0, 'triangle', 0.55], [1, 7, 'sine', 0.3], [1, -7, 'sine', 0.3], [2, 3, 'sine', 0.2], [4, 0, 'sine', 0.07]]) {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = f * mult; o.detune.value = det;
      const pg = ctx.createGain(); pg.gain.value = amt;
      o.connect(pg); pg.connect(lp);
      o.start(start); o.stop(start + dur + 0.4);
      this.scheduled.push(o);
    }
    // 缓慢颤动(呼吸感)
    const lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.2;
    const lg = ctx.createGain(); lg.gain.value = p * 0.14;
    lfo.connect(lg); lg.connect(g.gain);
    lfo.start(start); lfo.stop(start + dur + 0.4);
    this.scheduled.push(lfo);
  }

  // voices: [{ events, gain?, wave?, tempos? }]  多声部同时播放
  //   每个声部有自己的分段恒速表(tempos), 允许不同速度/中途变速; 缺省用全局 bpm。
  // onTick(activeIdxPerVoice, beat) 高亮回调 (beat 取旋律声部拍位, 供视图滚动); onEnd 结束回调
  // fromBeat: 从第几拍开始播放 (默认 0 = 开头); fromVoice: fromBeat 所属声部(默认旋律 0)。
  //   起播点是一个"共享时间戳"—— 把 fromBeat 用其所属声部的速度换算成从第 0 拍(全曲共同
  //   起点)起的秒数 fromT, 各声部都从这个同一时刻切入。这样即便各声部速度不同(复合速度),
  //   从中间起播也整齐对齐(而不是各自跑到同一个"拍号"上、时间戳却错开)。
  async play(voices, bpm, onTick, onEnd, fromBeat, fromVoice) {
    this.stop();
    const ctx = this.unlock();               // 同步解锁 (在播放手势内)
    if (ctx.state !== 'running') { try { await ctx.resume(); } catch (e) {} }
    this.playing = true;
    fromBeat = fromBeat || 0;

    const t0 = ctx.currentTime + 0.06;
    let lastEnd = t0;
    const tmap = (v) => (v && v.tempos && v.tempos.length) ? v.tempos : [{ beat: 0, bpm: bpm || 72 }];

    // 起播的共享时间戳(从第 0 拍起的秒数)
    const fromT = beatToTime(tmap(voices[fromVoice || 0]), fromBeat);

    voices.forEach((voice) => {
      const vg = voice.gain == null ? 1 : voice.gain;
      const vw = voice.wave;
      const tempos = tmap(voice);
      for (const ev of voice.events) {
        if (ev.type !== 'note') continue;
        const evEndT = beatToTime(tempos, ev.startBeat + ev.durBeats);
        if (evEndT <= fromT) continue;                          // 起播时刻之前已结束, 跳过
        const startT = Math.max(beatToTime(tempos, ev.startBeat), fromT); // 跨起播点的音裁到起播时刻
        const start = t0 + (startT - fromT);
        const dur = evEndT - startT;
        this.scheduleNote(ev.midi, start, dur, vg, vw);
        lastEnd = Math.max(lastEnd, start + dur);
      }
    });

    // 每个声部按各自速度把 wall-clock 时间换算成拍位, 独立高亮; 全部以同一 fromT 为起点
    const melTempos = tmap(voices[0]);
    const tick = () => {
      if (!this.playing) return;
      const now = ctx.currentTime;
      const elapsed = fromT + (now - t0);
      const active = voices.map((voice) => {
        const tempos = tmap(voice);
        const b = timeToBeat(tempos, elapsed);
        for (let k = 0; k < voice.events.length; k++) {
          const e = voice.events[k];
          if (e.type === 'note' && b >= e.startBeat && b < e.startBeat + e.durBeats) return k;
        }
        return -1;
      });
      const melBeat = timeToBeat(melTempos, elapsed);
      if (onTick) onTick(active, Math.max(0, melBeat));
      if (now >= lastEnd + 0.05) {
        this.playing = false;
        if (onTick) onTick(voices.map(() => -1), melBeat);
        if (onEnd) onEnd();
        return;
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    this.playing = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
    for (const s of this.scheduled) { try { s.stop(); } catch (e) {} }
    this.scheduled = [];
  }
}

if (typeof window !== 'undefined') window.AudioEngine = AudioEngine;
