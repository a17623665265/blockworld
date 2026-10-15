/* ============================================================
 * noise.js — 确定性值噪声 + 分形布朗运动(fBm)，用于地形生成
 * 纯 JS 实现，无外部依赖
 * ============================================================ */
(function (global) {
  "use strict";

  // 整数哈希 -> [0,1)
  function hash2(x, y, seed) {
    let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (seed | 0) * 1442695040;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  // 三维整数哈希 -> [0,1)（地下洞穴雕刻用）
  function hash3(x, y, z, seed) {
    let h = (x | 0) * 374761393 + (y | 0) * 668265263 +
            (z | 0) * 1274126177 + (seed | 0) * 1442695040;
    h = Math.imul(h ^ (h >>> 13), 2246822519);
    h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  }

  function smooth(t) { return t * t * (3 - 2 * t); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  class Noise {
    constructor(seed) {
      this.seed = (seed == null ? 1337 : seed) >>> 0;
    }

    // 二维值噪声，返回 0..1
    noise2(x, y) {
      const x0 = Math.floor(x), y0 = Math.floor(y);
      const fx = smooth(x - x0), fy = smooth(y - y0);
      const s = this.seed;
      const v00 = hash2(x0,     y0,     s);
      const v10 = hash2(x0 + 1, y0,     s);
      const v01 = hash2(x0,     y0 + 1, s);
      const v11 = hash2(x0 + 1, y0 + 1, s);
      return lerp(lerp(v00, v10, fx), lerp(v01, v11, fx), fy);
    }

    // 分形叠加，返回 0..1
    fbm(x, y, octaves, lacunarity, gain) {
      octaves = octaves || 4;
      lacunarity = lacunarity || 2;
      gain = gain == null ? 0.5 : gain;
      let amp = 1, freq = 1, sum = 0, norm = 0;
      for (let i = 0; i < octaves; i++) {
        sum += amp * this.noise2(x * freq, y * freq);
        norm += amp;
        amp *= gain;
        freq *= lacunarity;
      }
      return sum / norm;
    }

    // 三维值噪声，返回 0..1
    noise3(x, y, z) {
      const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
      const fx = smooth(x - x0), fy = smooth(y - y0), fz = smooth(z - z0);
      const s = this.seed;
      const c000 = hash3(x0,     y0,     z0,     s);
      const c100 = hash3(x0 + 1, y0,     z0,     s);
      const c010 = hash3(x0,     y0 + 1, z0,     s);
      const c110 = hash3(x0 + 1, y0 + 1, z0,     s);
      const c001 = hash3(x0,     y0,     z0 + 1, s);
      const c101 = hash3(x0 + 1, y0,     z0 + 1, s);
      const c011 = hash3(x0,     y0 + 1, z0 + 1, s);
      const c111 = hash3(x0 + 1, y0 + 1, z0 + 1, s);
      const x00 = lerp(c000, c100, fx), x10 = lerp(c010, c110, fx);
      const x01 = lerp(c001, c101, fx), x11 = lerp(c011, c111, fx);
      return lerp(lerp(x00, x10, fy), lerp(x01, x11, fy), fz);
    }

    // 三维分形叠加，返回 0..1
    fbm3(x, y, z, octaves, lacunarity, gain) {
      octaves = octaves || 4;
      lacunarity = lacunarity || 2;
      gain = gain == null ? 0.5 : gain;
      let amp = 1, freq = 1, sum = 0, norm = 0;
      for (let i = 0; i < octaves; i++) {
        sum += amp * this.noise3(x * freq, y * freq, z * freq);
        norm += amp;
        amp *= gain;
        freq *= lacunarity;
      }
      return sum / norm;
    }

    // 脊状分形（ridged noise）：噪声翻折成 |1-2n|，
    // 高值连成细长尖锐的脊线，用于尖峭山峰的刃脊轮廓，返回 0..1
    ridged(x, y, octaves, lacunarity, gain) {
      octaves = octaves || 4;
      lacunarity = lacunarity || 2;
      gain = gain == null ? 0.5 : gain;
      let amp = 1, freq = 1, sum = 0, norm = 0;
      for (let i = 0; i < octaves; i++) {
        const n = this.noise2(x * freq, y * freq);
        sum += amp * (1 - Math.abs(2 * n - 1));
        norm += amp;
        amp *= gain;
        freq *= lacunarity;
      }
      return sum / norm;
    }
  }

  // 确定性伪随机数生成器（用于种树等）
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (Math.imul(a ^ (a >>> 15), a | 1) + Math.imul(a ^ (a >>> 7), a | 61)) ^ a;
      a ^= a << 13; a ^= a >>> 17; a ^= a << 5;
      return (a >>> 0) / 4294967296;
    };
  }

  global.Noise = Noise;
  global.mulberry32 = mulberry32;
})(window);
