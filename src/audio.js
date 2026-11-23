// ============================================================================
// audio.js — Sintetizador Web Audio Procedural (Brisa nas Folhas, Riacho e
// Pássaros da Floresta)
// ============================================================================

export class ForestAudio {
  constructor() {
    this.ctx = null;
    this.enabled = false;
    this.masterGain = null;
    this.windGain = null;
    this.windFilter = null;
    this.streamGain = null;
    this.rainGain = null;
    this.birdTimer = null;
  }

  toggle() {
    if (!this.ctx) this.init();
    this.enabled = !this.enabled;
    if (this.ctx.state === 'suspended' && this.enabled) {
      this.ctx.resume();
    }
    const now = this.ctx.currentTime;
    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.setTargetAtTime(this.enabled ? 0.5 : 0.0, now, 0.4);
    return this.enabled;
  }

  init() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioCtx();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.0;
    this.masterGain.connect(this.ctx.destination);

    // Buffer de Ruído Rosa orgânico
    const bufferSize = this.ctx.sampleRate * 4;
    const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      output[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.045;
      b6 = white * 0.115926;
    }

    // 1. Vento nas copas
    const windSrc = this.ctx.createBufferSource();
    windSrc.buffer = noiseBuffer;
    windSrc.loop = true;
    this.windFilter = this.ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 340;
    this.windFilter.Q.value = 0.65;
    this.windGain = this.ctx.createGain();
    this.windGain.gain.value = 0.35;
    windSrc.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.masterGain);
    windSrc.start();

    // 2. Murmúrio suave do rio
    const streamSrc = this.ctx.createBufferSource();
    streamSrc.buffer = noiseBuffer;
    streamSrc.loop = true;
    const streamFilter = this.ctx.createBiquadFilter();
    streamFilter.type = 'highpass';
    streamFilter.frequency.value = 950;
    this.streamGain = this.ctx.createGain();
    this.streamGain.gain.value = 0.08;
    streamSrc.connect(streamFilter);
    streamFilter.connect(this.streamGain);
    this.streamGain.connect(this.masterGain);
    streamSrc.start();

    // 3. Chuva — corte de graves e agudos metálicos, volume segue o slider
    const rainSrc = this.ctx.createBufferSource();
    rainSrc.buffer = noiseBuffer;
    rainSrc.loop = true;
    const rainHp = this.ctx.createBiquadFilter();
    rainHp.type = 'highpass';
    rainHp.frequency.value = 900;
    const rainLp = this.ctx.createBiquadFilter();
    rainLp.type = 'lowpass';
    rainLp.frequency.value = 5600;
    this.rainGain = this.ctx.createGain();
    this.rainGain.gain.value = 0.0;
    rainSrc.connect(rainHp);
    rainHp.connect(rainLp);
    rainLp.connect(this.rainGain);
    this.rainGain.connect(this.masterGain);
    rainSrc.start();

    // 4. Pássaros distantes
    const triggerBird = () => {
      if (this.enabled && this.ctx && this.ctx.state === 'running') {
        this.playBirdChirp();
      }
      this.birdTimer = setTimeout(triggerBird, 2600 + Math.random() * 5200);
    };
    this.birdTimer = setTimeout(triggerBird, 1200);
  }

  update(windStrength, distToStream, time, rain = 0) {
    if (!this.ctx || !this.enabled) return;
    const gust = 0.5 + 0.5 * Math.sin(time * 0.35) * Math.cos(time * 0.17);
    const freq = 220 + windStrength * 290 + gust * 190;
    const vol = 0.14 + windStrength * 0.36 + gust * 0.12;
    this.windFilter.frequency.setTargetAtTime(freq, this.ctx.currentTime, 0.2);
    this.windGain.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.2);
    this.rainGain.gain.setTargetAtTime(rain * 0.40, this.ctx.currentTime, 0.35);

    // Volume do rio aumenta quando o jogador se aproxima da água
    const streamProximity = Math.exp(-Math.max(0, distToStream - 3.0) * 0.09);
    this.streamGain.gain.setTargetAtTime(0.02 + streamProximity * 0.18, this.ctx.currentTime, 0.25);
  }

  playBirdChirp() {
    const now = this.ctx.currentTime;
    const notes = 2 + Math.floor(Math.random() * 3);
    const baseFreq = 1950 + Math.random() * 1450;
    const pan = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    if (pan) {
      pan.pan.value = Math.random() * 1.6 - 0.8;
      pan.connect(this.masterGain);
    }
    const dest = pan || this.masterGain;

    for (let i = 0; i < notes; i++) {
      const start = now + i * 0.14;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      const f1 = baseFreq + (Math.random() - 0.5) * 300;
      const f2 = f1 * (1.15 + Math.random() * 0.2);
      osc.frequency.setValueAtTime(f1, start);
      osc.frequency.exponentialRampToValueAtTime(f2, start + 0.06);
      osc.frequency.exponentialRampToValueAtTime(f1 * 0.92, start + 0.12);

      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(0.032, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.12);

      osc.connect(gain);
      gain.connect(dest);
      osc.start(start);
      osc.stop(start + 0.13);
    }
  }
}