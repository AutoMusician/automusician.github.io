// audio.js —— 基于 Web Audio API 的播放引擎 (零依赖)
// 默认音色: 方波振荡器 (经典蜂鸣音); 也可换其它波形, 或加载一段采样做简易采样器

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

  midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  async loadSample(file, baseMidi = 60) {
    const ctx = this.ensure();
    const buf = await file.arrayBuffer();
    const audio = await ctx.decodeAudioData(buf);
    this.sample = { buffer: audio, baseMidi };
  }

  clearSample() { this.sample = null; }

  // 立即发一声 A4, 用于确认当前环境音频是否可用; 返回 AudioContext 状态
  testBeep() {
    const ctx = this.ensure();
    if (ctx.state === 'suspended') ctx.resume();
    this.scheduleNote(69, ctx.currentTime + 0.02, 0.35);
    return ctx.state;
  }

  state() { return this.ctx ? this.ctx.state : 'none'; }

  scheduleNote(midi, start, dur, level) {
    const peak = level == null ? 1 : level;
    if (this.sample) return this.scheduleSample(midi, start, dur, peak);
    if (this.wave === 'piano') return this.schedulePiano(midi, start, dur, peak);
    if (this.wave === 'violin') return this.scheduleViolin(midi, start, dur, peak);
    return this.scheduleOsc(midi, start, dur, peak);
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

  scheduleOsc(midi, start, dur, peak) {
    const ctx = this.ctx;
    const g = this.basicEnv(start, dur, peak);
    const o = ctx.createOscillator();
    o.type = this.wave;
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

  // voices: [{ events, gain? }]  多声部同时播放
  // onTick(activeIdxPerVoice, beat) 高亮回调; onEnd 结束回调
  play(voices, bpm, onTick, onEnd) {
    this.stop();
    const ctx = this.ensure();
    if (ctx.state === 'suspended') ctx.resume();
    this.playing = true;

    const spb = 60 / bpm;               // 每拍秒数
    const t0 = ctx.currentTime + 0.05;  // 调度前瞻: 够稳又跟手
    let lastEnd = t0;

    voices.forEach((voice) => {
      const vg = voice.gain == null ? 1 : voice.gain;
      for (const ev of voice.events) {
        if (ev.type !== 'note') continue;
        const start = t0 + ev.startBeat * spb;
        const dur = ev.durBeats * spb;
        this.scheduleNote(ev.midi, start, dur, vg);
        lastEnd = Math.max(lastEnd, start + dur);
      }
    });

    const tick = () => {
      if (!this.playing) return;
      const now = ctx.currentTime;
      const beat = (now - t0) / spb;
      const active = voices.map((voice) => {
        for (let k = 0; k < voice.events.length; k++) {
          const e = voice.events[k];
          if (e.type === 'note' && beat >= e.startBeat && beat < e.startBeat + e.durBeats) return k;
        }
        return -1;
      });
      if (onTick) onTick(active, Math.max(0, beat));
      if (now >= lastEnd + 0.05) {
        this.playing = false;
        if (onTick) onTick(voices.map(() => -1), beat);
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
