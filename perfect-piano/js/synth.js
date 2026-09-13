/* ============================================================
 * 30音纸带音乐盒打孔工作室 - 八音盒音色合成（Web Audio API）
 * 音色思路：梳齿拨奏 = 基音正弦 + 少量泛音 + 快 attack + 指数衰减
 *           + 短噪声瞬态模拟金属敲击
 * ============================================================ */
(function (global) {
  'use strict';

  function MusicBoxSynth() {
    this.ctx = null;
    this.master = null;
    this.noiseBuf = null;
    this.available = true; // 无声卡/自动播放策略受限时置 false，界面仍可静音演示
  }

  MusicBoxSynth.prototype.ensure = function () {
    if (!this.available) return null;
    try {
      if (!this.ctx) {
        var AC = global.AudioContext || global.webkitAudioContext;
        if (!AC) { this.available = false; return null; }
        this.ctx = new AC();
        var comp = this.ctx.createDynamicsCompressor();
        comp.threshold.value = -18;
        comp.ratio.value = 6;
        comp.connect(this.ctx.destination);
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.55;
        this.master.connect(comp);
        // 攻击瞬态用的短噪声 buffer
        var sr = this.ctx.sampleRate;
        var buf = this.ctx.createBuffer(1, Math.max(1, Math.floor(sr * 0.03)), sr);
        var d = buf.getChannelData(0);
        for (var i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
        this.noiseBuf = buf;
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    } catch (e) {
      this.available = false;
      return null;
    }
  };

  /** 演奏一个音。midi: MIDI 音高；when: AudioContext 时间（缺省立即） */
  MusicBoxSynth.prototype.play = function (midi, when, gainMul) {
    var ctx = this.ensure();
    if (!ctx) return;
    var t = (when == null ? ctx.currentTime : when) + 0.001;
    if (t < ctx.currentTime) t = ctx.currentTime;
    gainMul = gainMul == null ? 1 : gainMul;

    var f = 440 * Math.pow(2, (midi - 69) / 12);
    var bright = Math.min(1.5, Math.pow(523.25 / f, 0.45)); // 低音更柔、高音更亮

    // 分音列表：[频率比, 峰值增益, 衰减时间常数系数]
    var partials = [
      [1.0, 0.85, 1.00],
      [2.0, 0.22, 0.45],
      [4.0, 0.10, 0.22],
      [7.02, 0.045, 0.12]
    ];
    var out = ctx.createGain();
    out.gain.value = 0.9 * gainMul;
    out.connect(this.master);

    for (var i = 0; i < partials.length; i++) {
      var ratio = partials[i][0], peak = partials[i][1], dec = partials[i][2];
      var tau = Math.max(0.06, 0.55 * dec * bright);
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f * ratio * (1 + (Math.random() * 2 - 1) * 0.0015); // 轻微失谐
      var g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak * bright, t + 0.006);
      g.gain.setTargetAtTime(0.0001, t + 0.006, tau);
      osc.connect(g);
      g.connect(out);
      osc.start(t);
      osc.stop(t + tau * 5 + 0.08);
    }

    // 金属敲击瞬态
    if (this.noiseBuf) {
      var src = ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = Math.min(f * 3.5, 9000);
      bp.Q.value = 1.2;
      var ng = ctx.createGain();
      ng.gain.value = 0.10 * gainMul;
      src.connect(bp); bp.connect(ng); ng.connect(this.master);
      src.start(t);
    }
  };

  MusicBoxSynth.prototype.now = function () {
    return this.ctx ? this.ctx.currentTime : 0;
  };

  global.MusicBoxSynth = MusicBoxSynth;
})(typeof window !== 'undefined' ? window : globalThis);
