/* ============================================================
 * weather.js — 昼夜循环 + 天气（晴 / 雨 / 暴雨）
 *
 * 单一权威状态：
 *   phase  0..1，phase=0 为日出 06:00，0.25 正午，0.5 日落，0.75 子夜
 *   elev   太阳仰角 sin(phase*2π)，夜晚为负
 *   dayF   0(深夜) .. 1(正午)，所有光照 / 天空 / 星空只认它
 *   weather clear | rain | storm，precip 0..1 平滑过渡
 *
 * 表现层全部由此驱动：太阳 / 月亮 / 星空 / 天空穹顶 / 雾 /
 * 平行光（日光转月光）/ 半球光 / 云染色 / 雨粒子 / 闪电 / HUD 时钟。
 * 玩法层读取 snapshot()：isNight 刷僵尸，sunBurn 僵尸晒太阳燃烧。
 * ============================================================ */
(function (global) {
  "use strict";

  /* ---------- 时间节奏（显式可配，改这里即可调整昼夜长短） ----------
   * phase 是太阳的轨道角参数：0=日出06:00，0.5=日落18:00。
   * 上半周（太阳在地平线上）与下半周（太阳在地平线下）各占 0.5 个
   * phase，但现实耗时独立：白天 DAY_SECONDS 秒、黑夜 NIGHT_SECONDS 秒，
   * 一昼夜现实总时长 = DAY_SECONDS + NIGHT_SECONDS。 */
  const DAY_SECONDS = 15 * 60;   // 白天（日出→日落）现实秒数：15 分钟
  const NIGHT_SECONDS = 8 * 60;  // 黑夜（日落→日出）现实秒数：8 分钟
  const NIGHT_ELEV = -0.10;      // 太阳仰角低于此值 = 夜晚（刷怪）
  const SUNBURN_ELEV = 0.28;     // 太阳高于此值 = 僵尸在露天燃烧

  /* ---------- 调色板 ---------- */
  const COL = {
    dayZenith: 0x4f97e8, dayHorizon: 0xd7ecff, dayFog: 0xcde6ff,
    nightZenith: 0x0b1028, nightHorizon: 0x1e2748, nightFog: 0x131932,
    duskZenith: 0x4a3a6e, duskHorizon: 0xff8a45,
    castZenith: 0x5f6c7e, castHorizon: 0x8c97a8, castFog: 0x7e8a9c,
    sun: 0xffe2b0, moon: 0xa9bcec,
    hemiDay: 0xcfe6ff, hemiNight: 0x33406b,
    groundDay: 0x5d6b46, groundNight: 0x14181f,
    cloudDay: 0xffffff, cloudNight: 0x2f3752, cloudRain: 0x6d7483
  };

  function smooth(a, b, x) {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  const Weather = {
    phase: 0.12,               // 新开档从早晨开始
    weather: "clear",
    precip: 0,                 // 当前降水量 0..1（平滑）
    flash: 0,                  // 闪电亮度 0..1
    thunderId: 0,              // 雷声事件序号（房主权威，联机去重用）
    thunderDist: 0,            // 最近一次雷的距离（格）
    thunderAge: 99,            // 最近一次雷事件经过的秒数
    isNight: false,
    sunBurn: false,
    dayF: 1,
    elev: 0,

    init(opts) {
      this.scene = opts.scene;
      this.center = opts.center.clone();
      this.skyU = opts.skyUniforms;            // {zenith, horizon}
      this.hemi = opts.hemi;
      this.sunLight = opts.sunLight;
      this.ambient = opts.ambient;
      this.sunMesh = opts.sunMesh;
      this.clouds = opts.clouds;
      this.clockEl = opts.clockEl || null;
      this.hooks = opts.hooks || {};

      // 平行光目标固定在世界中心
      this.sunLightTarget = new THREE.Object3D();
      this.sunLightTarget.position.copy(this.center);
      this.scene.add(this.sunLightTarget);
      this.sunLight.target = this.sunLightTarget;

      // 月亮（太阳的对面）
      this.moonMesh = new THREE.Mesh(
        new THREE.SphereGeometry(3.4, 16, 16),
        new THREE.MeshBasicMaterial({ color: 0xe6ecff, fog: false })
      );
      this.scene.add(this.moonMesh);

      // 星空：随机撒在世界中心上方的半球壳上
      this.stars = this.createStars();
      this.scene.add(this.stars);

      // 雨粒子（相机附近循环下落）
      this.rain = this.createRain(1500);
      this.scene.add(this.rain);

      this.weatherT = 18 + Math.random() * 18;
      this.lightningT = 4 + Math.random() * 7;
      this.hudT = 0;
      this._c0 = new THREE.Color();
      this._c1 = new THREE.Color();
      this._sunDir = new THREE.Vector3();
      this._moonDir = new THREE.Vector3();
      this._lightDir = new THREE.Vector3();

      if (this.clockEl) {
        this.clockEl.innerHTML =
          '<span class="cl-phase"></span><span class="cl-time"></span><span class="cl-weather"></span>';
        this.clockPhaseEl = this.clockEl.querySelector(".cl-phase");
        this.clockTimeEl = this.clockEl.querySelector(".cl-time");
        this.clockWeatherEl = this.clockEl.querySelector(".cl-weather");
      }
      this.apply(0, this.center, true);
    },

    createStars() {
      const N = 320, R = 215;
      const pos = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) {
        const a = Math.random() * Math.PI * 2;
        // y 限制在上方 8% .. 100%
        const y = 0.08 + Math.random() * 0.92;
        const rr = Math.sqrt(Math.max(0, 1 - y * y));
        pos[i * 3] = Math.cos(a) * rr * R;
        pos[i * 3 + 1] = y * R;
        pos[i * 3 + 2] = Math.sin(a) * rr * R;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      const mat = new THREE.PointsMaterial({
        color: 0xdfe6ff, size: 1.5, sizeAttenuation: true,
        transparent: true, opacity: 0, depthWrite: false, fog: false
      });
      const p = new THREE.Points(geo, mat);
      p.position.copy(this.center);
      return p;
    },

    // 雨以细长线段（LineSegments）渲染：每滴雨是沿运动方向拉长的条纹，
    // 头（下端）亮、尾（上端）暗，配合高速斜落 —— 点状粒子看起来会像雪。
    createRain(n) {
      this.rainN = n;
      this.rainBox = 26;
      this.rainH = 24;
      this.rainWindT = Math.random() * 100;
      // 每滴雨的逻辑位置（线段头部），独立存储便于按风向量推进
      const px = new Float32Array(n);
      const py = new Float32Array(n);
      const pz = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        px[i] = (Math.random() * 2 - 1) * this.rainBox;
        py[i] = Math.random() * this.rainH - this.rainH / 2;
        pz[i] = (Math.random() * 2 - 1) * this.rainBox;
      }
      this.rainPX = px; this.rainPY = py; this.rainPZ = pz;

      const vCount = n * 2;
      const pos = new Float32Array(vCount * 3);
      const col = new Float32Array(vCount * 3);
      // 顶点色：头=白（材质基色相乘），尾偏暗蓝模拟拖尾淡出
      for (let i = 0; i < n; i++) {
        col[i * 6] = 1.0; col[i * 6 + 1] = 1.0; col[i * 6 + 2] = 1.0;
        col[i * 6 + 3] = 0.42; col[i * 6 + 4] = 0.48; col[i * 6 + 5] = 0.62;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
      const mat = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true, opacity: 0, depthWrite: false, fog: true
      });
      const lines = new THREE.LineSegments(geo, mat);
      lines.visible = false;
      lines.frustumCulled = false;
      this.rainBaseColor = new THREE.Color(0x93acd4);
      return lines;
    },

    /* ---------------- 天气状态机 ---------------- */

    rollWeather() {
      const r = Math.random();
      let next;
      if (r < 0.62) next = "clear";
      else if (r < 0.88) next = "rain";
      else next = "storm";
      if (next !== this.weather) {
        this.weather = next;
        if (this.hooks.onWeather) this.hooks.onWeather(next);
      }
    },

    updateWeather(dt) {
      this.weatherT -= dt;
      if (this.weatherT <= 0) {
        this.rollWeather();
        this.weatherT = 35 + Math.random() * 40;
      }
      const target = this.weather === "storm" ? 1 : this.weather === "rain" ? 0.75 : 0;
      this.precip += (target - this.precip) * Math.min(1, dt * 1.4);

      // 暴雨中的随机闪电：闪光 + 独立雷声事件（距离随机，声光延迟由音频层折算）
      if (this.weather === "storm" && this.precip > 0.6) {
        this.lightningT -= dt;
        if (this.lightningT <= 0) {
          this.flash = 1;
          this.lightningT = 3 + Math.random() * 8;
          this.thunderId++;
          this.thunderDist = 20 + Math.random() * 140;
          this.thunderAge = 0;
          if (this.hooks.onLightning) {
            this.hooks.onLightning(this.thunderDist, this.thunderId, 0);
          }
        }
      }
      this.flash *= Math.exp(-dt * 9);
      this.thunderAge += dt;
    },

    updateRain(dt, camPos) {
      const visible = this.precip > 0.05;
      this.rain.visible = visible;
      if (!visible) return;
      // 雨盒中心平滑跟随相机（不每帧重置，避免闪烁）
      const dx = camPos.x - this.rain.position.x;
      const dz = camPos.z - this.rain.position.z;
      if (Math.abs(dx) > this.rainBox || Math.abs(dz) > this.rainBox) {
        this.rain.position.set(camPos.x, camPos.y + 2, camPos.z);
      } else {
        this.rain.position.y = camPos.y + 2;
      }

      // 阵风：两个错频正弦叠加，普通雨微风、暴雨风势明显
      this.rainWindT += dt;
      const wt = this.rainWindT;
      const gust = Math.sin(wt * 0.9) * 0.55 + Math.sin(wt * 0.37 + 1.7) * 0.45;
      const p = this.precip;
      const windX = 1.6 + p * 5.2 + gust * (0.8 + p * 3.4);
      const windZ = 0.4 + p * 1.8 + gust * (0.3 + p * 1.2);
      // 下落速度远高于飘雪（26~56 格/秒），雨丝长度匹配速度形成运动拖尾
      const fall = 26 + p * 30;
      const streak = 0.9 + p * 0.55;
      const inv = 1 / Math.hypot(fall, windX, windZ);
      const tx = windX * inv, ty = fall * inv, tz = windZ * inv;

      const px = this.rainPX, py = this.rainPY, pz = this.rainPZ;
      const arr = this.rain.geometry.attributes.position.array;
      const B = this.rainBox, H = this.rainH;
      const vx = windX * dt, vy = fall * dt, vz = windZ * dt;
      const bx = tx * streak, by = ty * streak, bz = tz * streak;
      for (let i = 0; i < this.rainN; i++) {
        let x = px[i] - vx;
        let y = py[i] - vy;
        let z = pz[i] - vz;
        if (y < -H / 2) {
          y += H;
          x = (Math.random() * 2 - 1) * B;
          z = (Math.random() * 2 - 1) * B;
        }
        // 水平漂移循环包裹
        if (x > B) x -= 2 * B; else if (x < -B) x += 2 * B;
        if (z > B) z -= 2 * B; else if (z < -B) z += 2 * B;
        px[i] = x; py[i] = y; pz[i] = z;
        // 每段：头=当前位置，尾沿运动反方向（上逆风）拉长
        const o = i * 6;
        arr[o] = x; arr[o + 1] = y; arr[o + 2] = z;
        arr[o + 3] = x - bx; arr[o + 4] = y + by; arr[o + 5] = z - bz;
      }
      this.rain.geometry.attributes.position.needsUpdate = true;

      // 基色随昼夜变暗、阴天略压暗，闪电瞬间雨丝同步加亮
      const lit = (0.42 + this.dayF * 0.58) * (1 - p * 0.12) + this.flash * 0.9;
      this.rain.material.color.copy(this.rainBaseColor).multiplyScalar(lit);
      this.rain.material.opacity = Math.min(1, 0.3 + p * 0.4 + this.flash * 0.2);
    },

    /* ---------------- 主更新：推进时间并应用全部表现 ---------------- */

    // 按昼夜不同时长推进 phase：白天半周 0.5/DAY_SECONDS，黑夜半周 0.5/NIGHT_SECONDS。
    // dt 跨越日夜分界时拆分剩余时长，保证大帧 / 切后台回来也精确。
    advancePhase(dt) {
      let remain = dt, guard = 0;
      while (remain > 0 && guard++ < 4) {
        const dayHalf = this.phase < 0.5;
        const rate = dayHalf ? 0.5 / DAY_SECONDS : 0.5 / NIGHT_SECONDS;
        const boundary = dayHalf ? 0.5 : 1;
        const step = remain * rate;
        if (this.phase + step < boundary) { this.phase += step; remain = 0; }
        else {
          remain -= (boundary - this.phase) / rate;
          this.phase = dayHalf ? 0.5 : 0;
        }
      }
    },

    update(dt, camPos) {
      this.advancePhase(dt);
      this.elev = Math.sin(this.phase * Math.PI * 2);
      this.dayF = smooth(-0.15, 0.25, this.elev);

      const wasNight = this.isNight;
      this.isNight = this.elev < NIGHT_ELEV;
      this.sunBurn = this.elev > SUNBURN_ELEV;
      if (this.isNight !== wasNight) {
        if (this.isNight && this.hooks.onNight) this.hooks.onNight();
        if (!this.isNight && this.hooks.onDay) this.hooks.onDay();
      }

      this.updateWeather(dt);
      this.apply(dt, camPos || this.center, false);
      this.updateHud(dt);

      return this.snapshot();
    },

    // 依据 dayF / elev / precip 计算颜色并写入场景（force=true 时跳过仅依赖 dt 的部分）
    apply(dt, camPos, force) {
      const dayF = this.dayF, nightF = 1 - dayF;
      const duskAmt = Math.max(0, 1 - Math.abs(this.elev) / 0.30) * 0.85;
      const p = this.precip;

      // 天顶 / 地平线：昼夜 -> 晨昏暖色 -> 阴雨天灰
      const zenith = this._c0.setHex(COL.dayZenith).lerp(this._c1.setHex(COL.nightZenith), nightF);
      zenith.lerp(this._c1.setHex(COL.duskZenith), duskAmt * 0.45);
      zenith.lerp(this._c1.setHex(COL.castZenith), p * 0.72 * (0.35 + dayF * 0.65));
      const horizon = this._c0.setHex(COL.dayHorizon).lerp(this._c1.setHex(COL.nightHorizon), nightF);
      horizon.lerp(this._c1.setHex(COL.duskHorizon), duskAmt * 0.7);
      horizon.lerp(this._c1.setHex(COL.castHorizon), p * 0.8 * (0.35 + dayF * 0.65));
      const fogC = this._c0.setHex(COL.dayFog).lerp(this._c1.setHex(COL.nightFog), nightF);
      fogC.lerp(this._c1.setHex(COL.castFog), p * 0.85);

      this.skyU.zenith.value.copy(zenith);
      this.skyU.horizon.value.copy(horizon);
      this.scene.background.copy(fogC);
      this.scene.fog.color.copy(fogC);
      this.scene.fog.near = 46 - p * 16;
      this.scene.fog.far = 118 - p * 38;

      // 太阳 / 月亮轨迹（半径 200，绕世界中心东升西落）
      const a = this.phase * Math.PI * 2;
      this._sunDir.set(Math.cos(a), Math.sin(a), 0.28).normalize();
      this._moonDir.set(-Math.cos(a), -Math.sin(a), -0.28).normalize();
      this.sunMesh.position.copy(this.center).addScaledVector(this._sunDir, 200);
      this.moonMesh.position.copy(this.center).addScaledVector(this._moonDir, 200);
      this.sunMesh.visible = dayF > 0.03;
      this.moonMesh.visible = nightF > 0.03;
      this.stars.material.opacity = nightF * (1 - p * 0.85);

      // 平行光：白天暖日光，夜里蓝月光（方向在两者间平滑切换）
      this._lightDir.copy(this._sunDir).multiplyScalar(dayF)
        .addScaledVector(this._moonDir, nightF).normalize();
      this.sunLight.position.copy(this.center).addScaledVector(this._lightDir, 150);
      this.sunLight.color.setHex(COL.sun).lerp(this._c1.setHex(COL.moon), nightF);
      this.sunLight.intensity = 0.68 * dayF + 0.12 * nightF + this.flash * 0.9;

      // 半球光 / 环境光
      this.hemi.color.setHex(COL.hemiDay).lerp(this._c1.setHex(COL.hemiNight), nightF);
      this.hemi.groundColor.setHex(COL.groundDay).lerp(this._c1.setHex(COL.groundNight), nightF);
      this.hemi.intensity = Math.max(0, 0.62 * dayF + 0.16 * nightF - p * 0.18 + this.flash * 0.55);
      this.ambient.intensity = Math.max(0, 0.10 * dayF + 0.06 * nightF + this.flash * 0.25);

      // 云：夜晚变暗、雨天变灰
      this.clouds.material.color.setHex(COL.cloudDay).lerp(this._c1.setHex(COL.cloudNight), nightF);
      this.clouds.material.color.lerp(this._c1.setHex(COL.cloudRain), p * 0.8);

      if (!force) this.updateRain(dt, camPos);
    },

    /* ---------------- HUD 时钟 ---------------- */

    updateHud(dt) {
      if (!this.clockEl) return;
      this.hudT -= dt;
      if (this.hudT > 0) return;
      this.hudT = 0.25;
      const totalMin = Math.floor(((6 + this.phase * 24) % 24) * 60);
      const hh = String(Math.floor(totalMin / 60)).padStart(2, "0");
      const mm = String(totalMin % 60).padStart(2, "0");
      this.clockPhaseEl.textContent = this.isNight ? "夜" : "昼";
      this.clockPhaseEl.className = "cl-phase " + (this.isNight ? "is-night" : "is-day");
      this.clockTimeEl.textContent = hh + ":" + mm;
      const wText = this.weather === "storm" ? "暴雨" : this.weather === "rain" ? "雨" : "晴";
      this.clockWeatherEl.textContent = wText;
      this.clockWeatherEl.className = "cl-weather " +
        (this.weather === "clear" ? "w-clear" : this.weather === "rain" ? "w-rain" : "w-storm");
    },

    snapshot() {
      return {
        phase: this.phase, elev: this.elev, dayF: this.dayF,
        isNight: this.isNight, sunBurn: this.sunBurn,
        weather: this.weather, precip: this.precip, flash: this.flash,
        clock: (function () {
          const m = Math.floor(((6 + this.phase * 24) % 24) * 60);
          return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
        }).call(this)
      };
    },

    /* ---------------- 联机客人端：房主权威天气（只渲染，不推进） ---------------- */

    // 写入房主权威状态；缺省的派生量按 phase 本地补齐，保证首包到达前天空也正确
    setRemote(s) {
      if (!s) return;
      this.remote = true;
      if (typeof s.phase === "number") this.phase = s.phase;
      if (s.weather === "clear" || s.weather === "rain" || s.weather === "storm") {
        this.weather = s.weather;
      }
      if (typeof s.precip === "number") this.precip = s.precip;
      this.elev = typeof s.elev === "number" ? s.elev : Math.sin(this.phase * Math.PI * 2);
      this.dayF = typeof s.dayF === "number" ? s.dayF : smooth(-0.15, 0.25, this.elev);
      this.isNight = typeof s.isNight === "boolean" ? s.isNight : this.elev < NIGHT_ELEV;
      this.sunBurn = typeof s.sunBurn === "boolean" ? s.sunBurn : this.elev > SUNBURN_ELEV;
      // 闪电取本地与远端较大值，随后由 renderRemote 自然衰减，避免 2Hz 包导致闪烁突兀
      if (typeof s.flash === "number") this.flash = Math.max(this.flash || 0, s.flash);
      // 雷声事件：房主权威（递增 id 去重），客人按事件 age 折减声光延迟
      if (s.th && typeof s.th.id === "number" && s.th.id > this.thunderId) {
        this.thunderId = s.th.id;
        this.thunderDist = typeof s.th.d === "number" ? s.th.d : 80;
        this.thunderAge = typeof s.th.age === "number" ? s.th.age : 0;
        if (this.hooks.onLightning) {
          this.hooks.onLightning(this.thunderDist, this.thunderId, this.thunderAge);
        }
      }
    },

    // 客人端每帧：不推进 phase / 不滚动天气，只把权威状态应用到全部表现
    // （天空、光照、雾、雨粒子下落、HUD 时钟）
    renderRemote(dt, camPos) {
      if (!this.remote) return;
      this.flash *= Math.exp(-dt * 9);
      this.apply(dt, camPos || this.center, false);
      this.updateHud(dt);
    }
  };

  global.Weather = Weather;
})(window);
