/* ============================================================
 * bamboo_mod.js — 竹林模组：竹竿 / 竹笋 + 竹林生物群系
 *
 * 玩法链路：
 *   竹林群系（温暖低海拔草地）成片生成 4~7 格高的细竹竿，
 *   竹竿脚下偶有竹笋；
 *     → 撸竹竿/竹笋得到「竹子」物品（斜向竹棍图标）
 *       → 拿竹子右键草方块/泥土顶面，插下竹笋
 *         → 竹笋经随机生长变为 1 格竹竿，再逐格向上长到 8~12 格
 *           → 挖任意一段竹竿，整列向上的竹竿一起折断掉落
 *
 * 技术点：
 *   竹竿是 nonSolid 细方柱（customMesh 纹理盒 + 细碰撞盒），
 *   侧面 tile 带浅绿竹节横环，方块垂直堆叠天然成节；
 *   竹笋是 nonSolid X 形交叉面片（api.cross）。
 *   生长用 R.registerTick 每帧驱动，玩家附近惰性扫描登记。
 *
 * 说明：竹林群系本身在 world.js 内生成，通过 window.BambooMod
 * 防御读取本模组导出的方块 id（mod 必须先于 world.js 加载）。
 * ============================================================ */
(function () {
  "use strict";

  window.Mods.define("bamboo", "竹林模组", function (R) {
    const B = window.BLOCK;

    /* ---------------- 纹理 ---------------- */

    // 点阵贴图工具（透明底交叉面片用）
    function stamp(ctx, ox, oy, rows, map) {
      for (let y = 0; y < rows.length; y++) {
        for (let x = 0; x < rows[y].length; x++) {
          const c = map[rows[y][x]];
          if (c) { ctx.fillStyle = c; ctx.fillRect(ox + x, oy + y, 1, 1); }
        }
      }
    }

    // 竹竿侧面：深绿方柱棱面（暗边/亮中棱）+ 近格底一条浅绿竹节环。
    // 方块逐格堆叠时，每米一道竹节，顶段再加浅绿截面盖帽
    const tStalkSide = R.allocTile(function (ctx, ox, oy) {
      ctx.fillStyle = "#46681c"; ctx.fillRect(ox, oy, 16, 16);
      // 两侧暗棱
      ctx.fillStyle = "#3a5818";
      ctx.fillRect(ox, oy, 3, 16);
      ctx.fillRect(ox + 13, oy, 3, 16);
      ctx.fillStyle = "#2c4517";
      ctx.fillRect(ox, oy, 1, 16);
      ctx.fillRect(ox + 15, oy, 1, 16);
      // 中央亮棱
      ctx.fillStyle = "#557e24";
      ctx.fillRect(ox + 6, oy, 4, 16);
      ctx.fillStyle = "#63902c";
      ctx.fillRect(ox + 7, oy, 1, 16);
      // 零星斑驳
      ctx.fillStyle = "#3a5818";
      [[4, 3], [11, 5], [5, 8], [12, 9], [8, 14], [3, 15]].forEach(function (p) {
        ctx.fillRect(ox + p[0], oy + p[1], 1, 1);
      });
      ctx.fillStyle = "#6a9c30";
      [[9, 2], [6, 6], [10, 10], [7, 15]].forEach(function (p) {
        ctx.fillRect(ox + p[0], oy + p[1], 1, 1);
      });
      // 竹节环（格底上方）：两道浅绿 + 一道暗缝
      ctx.fillStyle = "#8fb455";
      ctx.fillRect(ox, oy + 11, 16, 2);
      ctx.fillStyle = "#a7cc6c";
      ctx.fillRect(ox, oy + 11, 16, 1);
      ctx.fillStyle = "#2c4517";
      ctx.fillRect(ox, oy + 13, 16, 1);
    });

    // 竹竿顶面：浅绿截面，深绿外圈 + 亮芯
    const tStalkTop = R.allocTile(function (ctx, ox, oy) {
      ctx.fillStyle = "#3a5818"; ctx.fillRect(ox, oy, 16, 16);
      ctx.fillStyle = "#6f9c3a"; ctx.fillRect(ox + 1, oy + 1, 14, 14);
      ctx.fillStyle = "#8ec658"; ctx.fillRect(ox + 3, oy + 3, 10, 10);
      ctx.fillStyle = "#a7d36e"; ctx.fillRect(ox + 6, oy + 6, 4, 4);
      ctx.fillStyle = "#5d8230";
      ctx.fillRect(ox + 3, oy + 3, 1, 10);
      ctx.fillRect(ox + 12, oy + 3, 1, 10);
    });

    // 竹笋交叉面片（画布上方=叶尖，下方=棕色笋壳根部）
    const tShoot = R.allocTile(function (ctx, ox, oy) {
      stamp(ctx, ox, oy, [
        "................",
        "................",
        "................",
        ".......g........",
        "......glG.......",
        ".....GglGg......",
        "....GgglggG.....",
        "...gGgotogGg....",
        "...GgoTtTogG....",
        "..gGobTttTboGg..",
        "..GobbtTtbbobG..",
        ".gGobbbttbbboGg.",
        ".gGobttttbbobGg.",
        "gBBobbbbbbbboBGg",
        ".bbbbbbbbbbbbbb.",
        "..BBBBBBBBBBBB.."
      ], {
        g: "#3f6319",  // 叶尖深绿
        G: "#5d9428",  // 叶片主绿
        l: "#79b03a",  // 叶心亮绿
        o: "#6b7a2e",  // 绿褐过渡（笋壳尖）
        t: "#9c8444",  // 笋壳黄褐
        T: "#b5a06a",  // 笋壳亮面
        b: "#6e4e24",  // 笋壳棕
        B: "#4a3117"   // 根部暗棕
      });
    });

    /* ---------------- 方块 ---------------- */

    // 竹竿：可穿过的细方柱（碰撞只有中间细盒），瞬挖、无默认掉落（breakHook 发竹子）
    const stalk = R.block({
      name: "竹竿",
      tiles: [tStalkTop, tStalkSide, tStalkSide],
      dig: [0.4],
      solid: false,
      opaque: false,
      drop: null
    });
    // 细柱模型：柱身 0~0.94 用侧面 tile，0.94~1 盖帽用浅绿截面
    // （堆叠段的盖帽在接缝处形成一圈浅绿竹节，顶段盖帽即顶端截面）
    R.customMeshes[stalk] = function (api) {
      api.box(0.36, 0, 0.36, 0.64, 0.94, 0.64, tStalkSide, true);
      api.box(0.36, 0.94, 0.36, 0.64, 1, 0.64, tStalkTop, true);
    };
    R.collisionBoxes[stalk] = [[0.36, 0, 0.36, 0.64, 1, 0.64]];
    R.axeDig[stalk] = 0.2;
    R.particleColors[stalk] = 0x46681c;

    // 竹笋：地上 X 形小笋尖，可穿过、瞬挖、无默认掉落（breakHook 发竹子）
    const shoot = R.block({
      name: "竹笋",
      tiles: tShoot,
      dig: [0.05],
      solid: false,
      opaque: false,
      drop: null
    });
    R.customMeshes[shoot] = function (api) {
      // 世界网格走交叉面片；手持迷你模型 api 无 cross（no-op），
      // 竹笋本身不会进物品栏，这里仅做防御
      if (api.cross) api.cross(tShoot, 0.62, 0.22);
    };
    R.particleColors[shoot] = 0x6e4e24;

    /* ---------------- 物品 ---------------- */

    // 竹子：一根从左下斜到右上的绿色竹棍（深绿描边 + 中绿棍身 +
    // 浅绿竹节高光 + 右上一处枝节小叉），手持/掉落/物品栏共用此图标
    const bamboo = R.item({
      name: "竹子",
      stack: 64,
      held: { model: "icon" },
      icon: function () {
        return R.pixelIcon([
          "................",
          "................",
          "................",
          "............lgD.",
          "...........DglD.",
          "..........DglDg.",
          ".........dDglgD.",
          "........dDglD...",
          ".......dDglg....",
          "......dDglD.....",
          ".....dDgllD.....",
          "....dDglD.......",
          "...dDglD........",
          "..dDglD.........",
          ".dDgD...........",
          ".DD............."
        ], {
          d: "#2c4517",  // 描边暗绿
          D: "#46681c",  // 棍身深绿
          g: "#5d8f2a",  // 棍身主绿
          l: "#83b34a"   // 竹节高光亮绿
        });
      }
    });

    /* ---------------- 种植：竹子物品右键草/泥顶面插竹笋 ---------------- */

    R.placeHooks[bamboo] = function (ctx) {
      const hit = ctx.hit, w = ctx.world;
      if (hit.id !== B.GRASS && hit.id !== B.DIRT) return false;
      // 必须点的是顶面上方那格
      if (ctx.ty !== hit.y + 1 || ctx.tx !== hit.x || ctx.tz !== hit.z) return false;
      if (ctx.cur !== B.AIR) return false;
      w.setBlock(ctx.tx, ctx.ty, ctx.tz, shoot);
      w.remeshAround(ctx.tx, ctx.tz);
      ctx.consume(1);
      return true;
    };

    /* ---------------- 收割掉落 ---------------- */

    function giveFn(ctx) {
      return (ctx && ctx.addItem) || function (it, n) { window.Crafting.addItem(it, n); };
    }

    // 挖任意一段竹竿：掉 1 竹子，上方整列竹竿连续折断（每段再掉 1 根）
    R.breakHooks[stalk] = function (ctx) {
      const w = ctx.world;
      const give = giveFn(ctx);
      give(bamboo, 1);
      growing.delete(ctx.x + "," + (ctx.y + 1) + "," + ctx.z);
      let y = ctx.y + 1, n = 0;
      while (y < w.H && n < 16 && w.getBlock(ctx.x, y, ctx.z) === stalk) {
        w.setBlock(ctx.x, y, ctx.z, B.AIR);
        growing.delete(ctx.x + "," + y + "," + ctx.z);
        give(bamboo, 1);
        y++; n++;
      }
      if (n > 0) w.remeshAround(ctx.x, ctx.z);
      return null;
    };

    // 挖竹笋：返还 1 竹子（可重新栽种）
    R.breakHooks[shoot] = function (ctx) {
      const give = giveFn(ctx);
      give(bamboo, 1);
      growing.delete(ctx.x + "," + ctx.y + "," + ctx.z);
      return null;
    };

    /* ---------------- 生长：玩家附近的竹笋 -> 竹竿 -> 逐格拔高 ---------------- */

    const SCAN_R = 7;          // 玩家周围扫描半径
    const SCAN_EVERY = 1.2;    // 秒，扫描节流
    const SPROUT_MIN = 3.0, SPROUT_MAX = 7.0;   // 竹笋 -> 竹竿间隔
    const GROW_MIN = 3.5, GROW_MAX = 8.0;       // 竹竿每向上长一格间隔
    const MAX_COLUMN = 16;
    let scanT = 0;
    // "x,y,z" -> 下次允许生长的 elapsed 时间点（竹笋 / 竹竿顶段）
    const growing = new Map();

    // 每列竹子的最终高度由列坐标哈希决定（8~12 格），无限图上确定一致
    function columnMax(x, z) {
      let h = Math.imul(x | 0, 73856093) ^ Math.imul(z | 0, 19349663);
      h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
      return 8 + (h % 5);
    }

    function soilOk(w, x, y, z) {
      const t = w.getBlock(x, y, z);
      return t === B.GRASS || t === B.DIRT;
    }

    R.registerTick(function (ctx) {
      const w = ctx.world;
      scanT -= ctx.dt;
      if (scanT > 0) {
        runGrowth(w, ctx.elapsed);
        return;
      }
      scanT = SCAN_EVERY;
      const px = Math.floor(ctx.player.pos.x), pz = Math.floor(ctx.player.pos.z);
      const py = Math.floor(ctx.player.pos.y);
      for (let x = px - SCAN_R; x <= px + SCAN_R; x++) {
        for (let z = pz - SCAN_R; z <= pz + SCAN_R; z++) {
          for (let y = Math.max(1, py - 3); y <= py + 14; y++) {
            if (!w.inBounds(x, y, z)) continue;
            const id = w.getBlock(x, y, z);
            const k = x + "," + y + "," + z;
            if (id === shoot) {
              if (!growing.has(k)) {
                growing.set(k, ctx.elapsed + SPROUT_MIN + Math.random() * (SPROUT_MAX - SPROUT_MIN));
              }
            } else if (id === stalk && w.getBlock(x, y + 1, z) === B.AIR) {
              // 只登记顶段（上方为空气）；下方必须是竹竿或草/泥土（浮空残段不长）
              const below = w.getBlock(x, y - 1, z);
              const supported = below === stalk || soilOk(w, x, y - 1, z);
              if (supported && !growing.has(k)) {
                growing.set(k, ctx.elapsed + GROW_MIN + Math.random() * (GROW_MAX - GROW_MIN));
              }
            }
          }
        }
      }
      runGrowth(w, ctx.elapsed);
    });

    function runGrowth(w, now) {
      growing.forEach(function (nextT, k) {
        if (now < nextT) return;
        const parts = k.split(",");
        const x = +parts[0], y = +parts[1], z = +parts[2];
        const id = w.getBlock(x, y, z);
        growing.delete(k);
        if (id === shoot) {
          // 竹笋 -> 1 格竹竿（脚下仍须是草/泥土，上方留空）
          if (!soilOk(w, x, y - 1, z)) return;
          if (w.getBlock(x, y + 1, z) !== B.AIR) return;
          w.setBlock(x, y, z, stalk);
          w.remeshAround(x, z);
        } else if (id === stalk && w.getBlock(x, y + 1, z) === B.AIR) {
          // 顶段向上拔高一格；数脚下竹竿总数，达到本列目标高度即停
          let h = 1;
          for (let yy = y - 1; yy > 0 && w.getBlock(x, yy, z) === stalk && h < MAX_COLUMN; yy--) h++;
          if (h >= columnMax(x, z)) return;
          if (!w.inBounds(x, y + 1, z)) return;
          w.setBlock(x, y + 1, z, stalk);
          w.remeshAround(x, z);
        }
      });
    }

    /* ---------------- 导出（world.js 竹林群系生成读取） ---------------- */

    window.BambooMod = { stalk: stalk, shoot: shoot, bamboo: bamboo };
  });
})();
