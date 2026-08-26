import { clamp } from './mathx';
import { WeaponId } from './weapons';

/**
 * Sound effects are synthesised with WebAudio so audio never delays the first
 * frame — but when the CC0 samples in public/assets/audio have downloaded, the
 * one-shots (guns, punches, footsteps, crashes, siren, engine timbre) come from
 * recordings instead, and the synth stays as the offline fallback. Volume is
 * distance-scaled by the caller.
 */
export class GameAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private music!: GainNode;
  private noise!: AudioBuffer;
  /** Fetched at boot, decoded once the context exists (it needs a user gesture). */
  private raw: Record<string, ArrayBuffer> = {};
  private buf: Record<string, AudioBuffer> = {};
  private stepPick = 0;
  private engineOsc: OscillatorNode | null = null;
  private engineOsc2: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private engineSrc: AudioBufferSourceNode | null = null;
  private engineSampleGain: GainNode | null = null;
  private sirenOsc: OscillatorNode | null = null;
  private sirenSrc: AudioBufferSourceNode | null = null;
  private sirenGain: GainNode | null = null;
  private sirenT = 0;
  private ambientGain: GainNode | null = null;
  ready = false;

  /** Fetch the sample files at boot. Missing files just keep the synth voice. */
  async queueSamples(files: Record<string, string>): Promise<void> {
    await Promise.all(Object.entries(files).map(async ([key, url]) => {
      try {
        const r = await fetch(url);
        if (r.ok) this.raw[key] = await r.arrayBuffer();
      } catch { /* offline: synth covers it */ }
    }));
  }

  init(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(this.ctx.destination);
    this.sfx = this.ctx.createGain();
    this.sfx.gain.value = 0.9;
    this.sfx.connect(this.master);
    this.music = this.ctx.createGain();
    this.music.gain.value = 0.3;
    this.music.connect(this.master);

    // one second of white noise, reused for every gunshot / impact
    const len = this.ctx.sampleRate;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.ready = true;
    for (const [key, ab] of Object.entries(this.raw)) {
      try {
        this.ctx.decodeAudioData(ab.slice(0)).then((b) => { this.buf[key] = b; }).catch(() => { });
      } catch { /* undecodable: synth covers it */ }
    }
    this.startAmbient();
  }

  setVolumes(master: number, sfx: number, music: number): void {
    if (!this.ctx) return;
    this.master.gain.value = clamp(master, 0, 1);
    this.sfx.gain.value = clamp(sfx, 0, 1);
    this.music.gain.value = clamp(music, 0, 1) * 0.5;
  }

  suspend(): void {
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend();
  }

  resume(): void {
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  private tone(
    type: OscillatorType, f0: number, f1: number, dur: number, vol: number, delay = 0,
  ): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private burst(dur: number, vol: number, freq: number, q: number, type: BiquadFilterType = 'lowpass', delay = 0): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(freq * 0.25, 60), t + dur);
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.sfx);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  gunshot(id: WeaponId, vol = 1): void {
    if (!this.ctx) return;
    if (id === 'pistol') {
      this.burst(0.16, 0.55 * vol, 2600, 0.8);
      this.tone('square', 220, 60, 0.1, 0.12 * vol);
    } else if (id === 'smg') {
      this.burst(0.1, 0.4 * vol, 3200, 0.7);
      this.tone('square', 260, 90, 0.06, 0.09 * vol);
    } else {
      this.burst(0.34, 0.75 * vol, 1500, 1.1);
      this.tone('sawtooth', 130, 40, 0.22, 0.16 * vol);
    }
  }

  dryFire(): void { this.tone('square', 900, 500, 0.04, 0.06); }
  reload(): void {
    this.tone('square', 300, 180, 0.06, 0.07);
    this.tone('square', 420, 220, 0.06, 0.07, 0.22);
    this.burst(0.07, 0.16, 1800, 1, 'bandpass', 0.42);
  }
  punch(): void { this.burst(0.1, 0.4, 700, 1.4); this.tone('sine', 160, 60, 0.1, 0.14); }
  bodyHit(): void { this.burst(0.14, 0.5, 500, 1.6); this.tone('sine', 120, 50, 0.14, 0.16); }
  hitMarker(): void { this.tone('square', 1500, 1500, 0.03, 0.07); }
  death(): void { this.tone('sawtooth', 220, 60, 0.5, 0.12); this.burst(0.3, 0.3, 900, 0.8); }
  footstep(vol = 1): void { this.burst(0.06, 0.12 * vol, 900, 1.2, 'bandpass'); }
  jump(): void { this.tone('sine', 420, 260, 0.1, 0.07); }
  land(): void { this.burst(0.1, 0.2, 500, 1); }
  pickup(): void { [720, 960, 1280].forEach((f, i) => this.tone('sine', f, f, 0.12, 0.09, i * 0.07)); }
  cash(): void { [880, 1180].forEach((f, i) => this.tone('triangle', f, f * 1.2, 0.1, 0.08, i * 0.08)); }
  deny(): void { this.tone('square', 180, 120, 0.16, 0.08); }
  ui(): void { this.tone('sine', 660, 660, 0.04, 0.05); }
  boost(): void {
    this.burst(0.45, 0.16, 1600, 0.9, 'highpass');
    this.tone('sawtooth', 180, 620, 0.4, 0.07);
  }

  horn(): void { this.tone('square', 400, 395, 0.32, 0.13); this.tone('square', 300, 297, 0.32, 0.1); }
  crash(mag: number): void {
    const v = clamp(mag / 18, 0.15, 1);
    this.burst(0.34, 0.6 * v, 1200, 0.9);
    this.tone('sawtooth', 90, 40, 0.28, 0.18 * v);
  }
  wanted(): void { [520, 660, 880].forEach((f, i) => this.tone('square', f, f, 0.16, 0.09, i * 0.13)); }

  private startAmbient(): void {
    if (!this.ctx) return;
    // very low city rumble so silence never feels broken
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 180;
    const g = this.ctx.createGain();
    g.gain.value = 0.1;
    src.connect(f).connect(g).connect(this.music);
    src.start();
    this.ambientGain = g;
  }

  engineOn(): void {
    if (!this.ctx || this.engineOsc) return;
    this.engineGain = this.ctx.createGain();
    this.engineGain.gain.value = 0.0;
    this.engineFilter = this.ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 700;
    this.engineFilter.Q.value = 3;
    this.engineOsc = this.ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc2 = this.ctx.createOscillator();
    this.engineOsc2.type = 'square';
    this.engineOsc.connect(this.engineFilter);
    this.engineOsc2.connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain).connect(this.sfx);
    this.engineOsc.start();
    this.engineOsc2.start();
    this.engineGain.gain.linearRampToValueAtTime(0.075, this.ctx.currentTime + 0.25);
  }

  engineRpm(speed: number, maxSpeed: number, throttle: number): void {
    if (!this.ctx || !this.engineOsc || !this.engineOsc2 || !this.engineFilter) return;
    const norm = clamp(Math.abs(speed) / Math.max(1, maxSpeed), 0, 1);
    // fake gearbox: pitch rises through four ratios
    const gear = Math.min(3, Math.floor(norm * 4));
    const inGear = norm * 4 - gear;
    const f = 52 + inGear * 62 + gear * 12;
    const t = this.ctx.currentTime;
    this.engineOsc.frequency.setTargetAtTime(f, t, 0.06);
    this.engineOsc2.frequency.setTargetAtTime(f * 0.5, t, 0.06);
    this.engineFilter.frequency.setTargetAtTime(420 + norm * 1500 + throttle * 400, t, 0.08);
    if (this.engineGain) this.engineGain.gain.setTargetAtTime(0.05 + norm * 0.05 + throttle * 0.02, t, 0.1);
  }

  engineOff(): void {
    if (!this.ctx || !this.engineOsc) return;
    const t = this.ctx.currentTime;
    this.engineGain?.gain.linearRampToValueAtTime(0, t + 0.18);
    this.engineOsc.stop(t + 0.2);
    this.engineOsc2?.stop(t + 0.2);
    this.engineOsc = null;
    this.engineOsc2 = null;
    this.engineGain = null;
    this.engineFilter = null;
  }

  sirenOn(): void {
    if (!this.ctx || this.sirenOsc) return;
    this.sirenGain = this.ctx.createGain();
    this.sirenGain.gain.value = 0;
    this.sirenOsc = this.ctx.createOscillator();
    this.sirenOsc.type = 'sine';
    this.sirenOsc.frequency.value = 700;
    this.sirenOsc.connect(this.sirenGain).connect(this.sfx);
    this.sirenOsc.start();
  }

  /** Call every frame while any siren is audible; `vol` folds in distance. */
  sirenUpdate(dt: number, vol: number): void {
    if (!this.ctx || !this.sirenOsc || !this.sirenGain) return;
    this.sirenT += dt;
    const hi = Math.sin(this.sirenT * 3.4) > 0;
    this.sirenOsc.frequency.setTargetAtTime(hi ? 880 : 620, this.ctx.currentTime, 0.03);
    this.sirenGain.gain.setTargetAtTime(clamp(vol, 0, 1) * 0.055, this.ctx.currentTime, 0.1);
  }

  sirenOff(): void {
    if (!this.ctx || !this.sirenOsc) return;
    const t = this.ctx.currentTime;
    this.sirenGain?.gain.linearRampToValueAtTime(0, t + 0.2);
    this.sirenOsc.stop(t + 0.22);
    this.sirenOsc = null;
    this.sirenGain = null;
  }

  dispose(): void {
    this.engineOff();
    this.sirenOff();
    this.ambientGain = null;
    if (this.ctx) void this.ctx.close();
    this.ctx = null;
    this.ready = false;
  }
}
