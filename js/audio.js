/* ============================================================
 * audio.js — 统一 SFX 音频总线（WebAudio 程序化合成，零音频资源）
 *
 * 音频图：
 *   各 voice ──► master(gain) ──► compressor（防爆音）──► destination
 *
 * 当前接入：
 *   1) 环境床层（常驻 loop，增益平滑跟随天气）
 *      rain  粉噪声 → lowpass ............ 连绵雨声（室内滤波截闷）
 *      hf    白噪声 → highpass 3.6kHz .... 雨点高频沙沙
 *      wind  白噪声 → lowpass 150Hz ...... 暴雨低频风
 *   2) 雷声 thunder(dist, age)：闪电后按「距离/声速」延迟调度，
 *      近雷 = 高频劈 + 低频轰，远雷 = 慢速滚雷。
 *
 * 浏览器自动播放策略：AudioContext 在首次用户手势（点击/按键）内创建并
 * resume；此前所有 update 调用静默空转，床层节点延迟到解锁时构建。
 * ============================================================ */
(function (global) {
  "use strict";

  const SFX = {
    ctx: null,
    master: null,
    unlocked: false,
    _duck: 1,
    _nodes: null,
    _bufPink: null,
    _bufWhite: null,

    // 调试计数（CDP 走查用）
    _dbg: { thunder: 0, lastDist: 0, lastDelay: 0 },

    /* ---------------- 手势解锁 / 懒构建 ---------------- */

    unlock: function () {
      if (this.unlocked) {
        if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
        return;
      }
      const AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return;
      try { this.ctx = new AC(); } catch (e) { return; }
      const ctx = this.ctx;

      this.master = ctx.createGain();
      this.master.gain.value = 0.9;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 6;
      this.master.connect(comp);
      comp.connect(ctx.destination);

      this.buildBed();
      this.unlocked = true;
      if (ctx.state === "suspended") ctx.resume();
    },

    // 2 秒白噪声缓冲（雷 / 高频层 / 风共用）
    whiteBuffer: function () {
      if (this._bufWhite) return this._bufWhite;
      const ctx = this.ctx, len = ctx.sampleRate * 2;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this._bufWhite = buf;
      return buf;
    },

    // 2 秒粉噪声缓冲（Paul Kellet 滤波）：雨声主体，比白噪声更绵密自然
    pinkBuffer: function () {
      if (this._bufPink) return this._bufPink;
      const ctx = this.ctx, len = ctx.sampleRate * 2;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520;
        b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.0168980;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
      this._bufPink = buf;
      return buf;
    },

    loopSource: function (buf) {
      const s = this.ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      s.start();
      return s;
    },

    // 常驻环境床层：三条 loop 一直跑，音量为 0 时静音，靠增益淡入淡出
    buildBed: function () {
      const ctx = this.ctx;

      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 1800;
      lp.Q.value = 0.4;
      const rainGain = ctx.createGain();
      rainGain.gain.value = 0;
      this.loopSource(this.pinkBuffer()).connect(lp);
      lp.connect(rainGain);
      rainGain.connect(this.master);

      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 3600;
      const hfGain = ctx.createGain();
      hfGain.gain.value = 0;
      this.loopSource(this.whiteBuffer()).connect(hp);
      hp.connect(hfGain);
      hfGain.connect(this.master);

      const wlp = ctx.createBiquadFilter();
      wlp.type = "lowpass";
      wlp.frequency.value = 150;
      const windGain = ctx.createGain();
      windGain.gain.value = 0;
      this.loopSource(this.whiteBuffer()).connect(wlp);
      wlp.connect(windGain);
      windGain.connect(this.master);

      this._nodes = { lp: lp, rainGain: rainGain, hp: hp, hfGain: hfGain,
                      wlp: wlp, windGain: windGain };
    },

    /* ---------------- 每帧驱动（主循环无条件调用） ----------------
     * env = { precip:0..1, storm:bool, indoors:bool, playing:bool } */

    update: function (dt, env) {
      if (!this.unlocked || !this.ctx) return;
      const ctx = this.ctx, n = this._nodes, t = ctx.currentTime;
      const p = env && env.precip || 0;
      const raining = p > 0.03;
      const inside = !!(env && env.indoors);

      // 暂停 / 菜单 / 面板：整条总线压低但不停（联机时世界仍在运转）
      const duckTarget = env && env.playing ? 1 : 0.15;
      this._duck += (duckTarget - this._duck) * Math.min(1, dt * 5);
      this.master.gain.setTargetAtTime(0.9 * this._duck, t, 0.12);

      if (!n) return;

      // 雨声主体：雨 0.75 → 0.19，暴雨 1.0 → 0.22；室内闷响减半
      const rainVol = raining ? (0.10 + p * 0.12) * (inside ? 0.5 : 1) : 0;
      n.rainGain.gain.setTargetAtTime(rainVol, t, 0.3);
      n.lp.frequency.setTargetAtTime(inside ? 460 : 1600 + p * 900, t, 0.25);

      // 高频雨点沙沙：室内基本滤掉
      n.hfGain.gain.setTargetAtTime(
        raining ? (inside ? 0.012 : 0.03 + p * 0.05) : 0, t, 0.3);

      // 暴雨风：仅 storm 且降水量接近峰值时渐入
      const windVol = env && env.storm && p > 0.82
        ? (inside ? 0.05 : Math.min(0.14, (p - 0.82) * 0.85)) : 0;
      n.windGain.gain.setTargetAtTime(windVol, t, 0.5);
    },

    /* ---------------- 雷声 ----------------
     * dist 雷与玩家的「距离」(格, 20..160)；age 事件已过去秒数
     * （联机客人收包补传），本地播放延迟 = 声光差 - age。 */

    thunder: function (dist, age) {
      if (!this.unlocked || !this.ctx) return;
      const ctx = this.ctx;
      dist = Math.max(20, Math.min(160, dist | 0 || 20));
      const delay = Math.max(0.05, 0.35 + dist / 75 - (age || 0));
      const near = dist < 45;
      // 距离衰减：20 格≈满音量，160 格仅剩微弱滚响
      const vol = Math.max(0.12, Math.min(1, 1.18 - dist / 135));
      const t = ctx.currentTime + delay;
      const out = this.master;

      const noiseOneshot = function (filterType, f0, f1, q) {
        const s = ctx.createBufferSource();
        s.buffer = SFX.whiteBuffer();
        s.loop = true;
        const f = ctx.createBiquadFilter();
        f.type = filterType;
        f.Q.value = q || 0.5;
        f.frequency.setValueAtTime(f0, t);
        if (f1) f.frequency.exponentialRampToValueAtTime(f1, t + 1.2);
        s.connect(f);
        return { s: s, f: f };
      };

      if (near) {
        // 近雷：开头 0.2s 高频劈裂
        const crack = noiseOneshot("highpass", 900, 0, 0.7);
        const cg = ctx.createGain();
        cg.gain.setValueAtTime(0.001, t);
        cg.gain.exponentialRampToValueAtTime(vol * 0.9, t + 0.025);
        cg.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
        crack.f.connect(cg); cg.connect(out);
        crack.s.start(t); crack.s.stop(t + 0.26);

        // 主轰鸣：低通从 1500 迅速收窄到 180
        const rum = noiseOneshot("lowpass", 1500, 180, 0.4);
        const rg = ctx.createGain();
        rg.gain.setValueAtTime(0.001, t);
        rg.gain.exponentialRampToValueAtTime(vol * 0.7, t + 0.04);
        rg.gain.exponentialRampToValueAtTime(0.001, t + 1.5);
        // 6Hz 起伏调制，模拟回声颤动
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 6;
        const lfoG = ctx.createGain();
        lfoG.gain.value = vol * 0.18;
        lfo.connect(lfoG); lfoG.connect(rg.gain);
        rum.f.connect(rg); rg.connect(out);
        rum.s.start(t); rum.s.stop(t + 1.6); lfo.start(t); lfo.stop(t + 1.6);

        // 低频体：60→34Hz 下坠
        const sub = ctx.createOscillator();
        sub.type = "sine";
        sub.frequency.setValueAtTime(60, t);
        sub.frequency.exponentialRampToValueAtTime(34, t + 0.9);
        const sg = ctx.createGain();
        sg.gain.setValueAtTime(0.001, t);
        sg.gain.exponentialRampToValueAtTime(vol * 0.8, t + 0.03);
        sg.gain.exponentialRampToValueAtTime(0.001, t + 1.1);
        sub.connect(sg); sg.connect(out);
        sub.start(t); sub.stop(t + 1.2);
      } else {
        // 远雷：慢起音的低通滚雷，2.8s 长尾
        const rum = noiseOneshot("lowpass", 480, 150, 0.4);
        const rg = ctx.createGain();
        rg.gain.setValueAtTime(0.001, t);
        rg.gain.exponentialRampToValueAtTime(vol * 0.5, t + 0.35);
        rg.gain.exponentialRampToValueAtTime(0.001, t + 2.8);
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 3.5;
        const lfoG = ctx.createGain();
        lfoG.gain.value = vol * 0.22;
        lfo.connect(lfoG); lfoG.connect(rg.gain);
        rum.f.connect(rg); rg.connect(out);
        rum.s.start(t); rum.s.stop(t + 2.9); lfo.start(t); lfo.stop(t + 2.9);

        const sub = ctx.createOscillator();
        sub.type = "sine";
        sub.frequency.setValueAtTime(46, t);
        sub.frequency.exponentialRampToValueAtTime(32, t + 1.2);
        const sg = ctx.createGain();
        sg.gain.setValueAtTime(0.001, t);
        sg.gain.exponentialRampToValueAtTime(vol * 0.45, t + 0.4);
        sg.gain.exponentialRampToValueAtTime(0.001, t + 2.2);
        sub.connect(sg); sg.connect(out);
        sub.start(t); sub.stop(t + 2.3);
      }

      this._dbg.thunder++;
      this._dbg.lastDist = dist;
      this._dbg.lastDelay = Math.round(delay * 1000) / 1000;
    }
  };

  // 首次任意点击 / 触摸 / 按键即在用户手势内解锁音频
  function gestureUnlock() { SFX.unlock(); }
  global.addEventListener("pointerdown", gestureUnlock, { passive: true });
  global.addEventListener("keydown", gestureUnlock, { passive: true });

  global.SFX = SFX;
})(window);
