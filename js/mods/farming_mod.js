/* ============================================================
 * farming_mod.js — 农耕模组：锄头耕地 + 麦子种植
 *
 * 玩法链路：
 *   撸草方块 30% 概率掉麦子种子
 *     → 锄头（木 / 石 / 铁 / 红宝石）右键草方块 / 泥土锄成耕地；
 *       铁锄一次耕 3×3、红宝石锄一次耕 5×5
 *       → 拿种子右键耕地上方播种
 *         → 耕地旁 4 格内有水会自动变湿润（颜色变深），湿润地小麦生长约快一倍；
 *           水源消失后湿润耕地会干涸回普通耕地
 *           → 小麦经 4 个阶段自然生长（干地 3~6 秒/阶段、湿地 1.5~3.5 秒，只在玩家附近生长）
 *           → 成熟后收割：掉麦子 + 种子，可循环种植
 *
 * 技术点：
 *   作物是 nonSolid 方块，用 api.cross() 绘制 X 形交叉面片
 *   生长用 R.registerTick 每帧驱动，玩家附近惰性扫描登记
 * ============================================================ */
(function () {
  "use strict";

  window.Mods.define("farming", "农耕模组", function (R) {
    const B = window.BLOCK;
    const STICK = window.ITEM.STICK;

    /* ---------------- 纹理 ---------------- */

    // 耕地顶面：深色湿土 + 两道浅沟槽
    const tFarmTop = R.allocTile(function (ctx, ox, oy) {
      ctx.fillStyle = "#6e4a2c"; ctx.fillRect(ox, oy, 16, 16);
      ctx.fillStyle = "#5e3d24";
      ctx.fillRect(ox, oy + 4, 16, 2);
      ctx.fillRect(ox, oy + 10, 16, 2);
      ctx.fillStyle = "#7d5735";
      ctx.fillRect(ox, oy + 3, 16, 1);
      ctx.fillRect(ox, oy + 9, 16, 1);
      // 零星深色土粒
      ctx.fillStyle = "#54371f";
      [[2, 1], [12, 7], [5, 13], [14, 14], [8, 2]].forEach(function (p) {
        ctx.fillRect(ox + p[0], oy + p[1], 1, 1);
      });
    });

    // 湿润耕地顶面：近黑的饱水深褐 + 两道深色沟槽（灌溉后变色，作物生长更快）
    const tWetFarmTop = R.allocTile(function (ctx, ox, oy) {
      ctx.fillStyle = "#3c2a1c"; ctx.fillRect(ox, oy, 16, 16);
      ctx.fillStyle = "#2e1f13";
      ctx.fillRect(ox, oy + 4, 16, 2);
      ctx.fillRect(ox, oy + 10, 16, 2);
      ctx.fillStyle = "#4a3524";
      ctx.fillRect(ox, oy + 3, 16, 1);
      ctx.fillRect(ox, oy + 9, 16, 1);
      ctx.fillStyle = "#24170d";
      [[3, 1], [11, 7], [6, 13], [13, 14], [8, 2]].forEach(function (p) {
        ctx.fillRect(ox + p[0], oy + p[1], 1, 1);
      });
    });

    // 点阵贴图工具
    function stamp(ctx, ox, oy, rows, map) {
      for (let y = 0; y < rows.length; y++) {
        for (let x = 0; x < rows[y].length; x++) {
          const c = map[rows[y][x]];
          if (c) { ctx.fillStyle = c; ctx.fillRect(ox + x, oy + y, 1, 1); }
        }
      }
    }

    // 小麦四个生长阶段（画布上方=叶尖，下方=根部）
    const G = "#5f9e32", GL = "#7cc247", GD = "#4a7d26";   // 茎叶
    const Y = "#e8c23a", YL = "#f7dd65", YD = "#b7901f";   // 麦穗
    function wheatTile(rows) {
      return R.allocTile(function (ctx, ox, oy) {
        stamp(ctx, ox, oy, rows, { g: GD, G: G, l: GL, y: YD, Y: Y, L: YL });
      });
    }

    const tW0 = wheatTile([
      "................",
      "................",
      "................",
      "................",
      "................",
      "................",
      "................",
      "................",
      "................",
      ".......g........",
      ".......G........",
      "......GlG.......",
      ".....gG.G.Gg....",
      "....gG..G..Gg...",
      "...gGl..G..lGg..",
      "..ggg...G...ggg."
    ]);
    const tW1 = wheatTile([
      "................",
      "................",
      "................",
      "................",
      "................",
      ".......G........",
      "......GlG.......",
      ".....gG.Gg......",
      "....gG..G.Gg....",
      "...gGl...G..Gg...",
      "..gG.....G....Gg.",
      ".gG......G.....Gg",
      ".G...g...G...g..G",
      "gG...Gg..G..Gg..G",
      "g....G...G...G..g",
      "ggggg....G....ggg"
    ]);
    const tW2 = wheatTile([
      "................",
      "................",
      ".......y........",
      "......yYy.......",
      ".....yYLYy......",
      "......yYy.......",
      ".......G........",
      "......GlG.......",
      ".....gG.Gg......",
      "....gG..G.Gg....",
      "...gG...G..Gg...",
      "..gG....G...Gg..",
      ".gG..g..G..g.Gg.",
      "gG...Gg.G..Gg..G",
      "g....G..G..G...g",
      "ggggg...G...gggg"
    ]);
    const tW3 = wheatTile([
      ".......y........",
      "......yYy.......",
      ".....yYLYy......",
      "....yYLYLYy.....",
      ".....yYLYy......",
      "....yYyYLy......",
      ".....yYLy.......",
      ".......G........",
      "......GYG.......",
      ".....gG.Gg......",
      "....gG..G.Gg....",
      "...gG...G..Gg...",
      "..gG....G...Gg..",
      ".gG..g..G..g.Gg.",
      "gG...Gg.G..Gg..G",
      "gg....G..G....gg"
    ]);

    /* ---------------- 方块 ---------------- */

    // 耕地：实体可站立，顶面湿土纹理，侧面/底面沿用内置泥土；挖掉落泥土
    const farmland = R.block({
      name: "耕地",
      tiles: [tFarmTop, 2, 2],
      dig: [0.5],
      drop: B.DIRT
    });

    // 湿润耕地：4 格内有水自动灌溉而成；颜色近黑、作物生长约快一倍；
    // 水源消失一段时间后会干涸回普通耕地。实体可站立，挖掉落泥土
    const wetFarmland = R.block({
      name: "湿润耕地",
      tiles: [tWetFarmTop, 2, 2],
      dig: [0.5],
      drop: B.DIRT
    });

    // 小麦 4 阶段：可穿过、瞬挖、无默认掉落（breakHook 手动发种子/麦子）
    function wheatBlock(tile, h) {
      const id = R.block({
        name: "小麦",
        tiles: tile,
        dig: [0.05],
        solid: false,
        opaque: false,
        drop: null
      });
      R.customMeshes[id] = function (api) { api.cross(tile, h); };
      return id;
    }
    const w0 = wheatBlock(tW0, 0.32);
    const w1 = wheatBlock(tW1, 0.58);
    const w2 = wheatBlock(tW2, 0.82);
    const w3 = wheatBlock(tW3, 0.98);
    const wheatIds = [w0, w1, w2, w3];

    /* ---------------- 物品 ---------------- */

    // 麦子种子：双叶嫩芽立于一颗饱满籽粒上（籽粒带高光与暗部）
    const seeds = R.item({
      name: "麦子种子",
      stack: 64,
      held: { model: "seed", grain: 0xb5863f, grainDark: 0x8a6028, sprout: 0x7cc247 },
      icon: function () {
        return R.pixelIcon([
          "................",
          "................",
          "................",
          "......l..l......",
          ".....lGlGl......",
          "....lG.G.Gl.....",
          ".....l.G.l......",
          ".......G........",
          ".......g........",
          "......sSs.......",
          ".....sSsss......",
          "....sSsssSd.....",
          "....dSsssSs.....",
          ".....dSssd......",
          "......sds.......",
          "................"
        ], { l: "#a5e06a", G: GL, g: G, s: "#8a6028", S: "#b5863f", d: "#5e4119" });
      }
    });

    // 麦子：一束从左下斜向右上的成熟麦穗（MC 经典物品造型）——
    // 右上是带棕色麦芒的金黄穗头（亮黄/中黄/暗橄榄/深暗四档），
    // 左下是深绿茎叶束，带两处亮黄边
    const wheat = R.item({
      name: "麦子",
      stack: 64,
      held: { model: "wheat" },
      icon: function () {
        return R.pixelIcon([
          "..........a.....",
          "........Yya.a...",
          ".....a..yddd...a",
          ".....YYddYydyaa.",
          ".....yddyydddd..",
          ".....LYdyLddddLa",
          ".....LYYYddydLY.",
          "....LYLdddddyyaa",
          "....LLyddggydgg.",
          "...GgGyyyyGgg...",
          "..LGggGyGgGya...",
          "LyyyGgggg..gGa..",
          "YyyydG..........",
          "gyyGG...........",
          "YGgGG...........",
          "g..g............"
        ], {
          L: "#d9da4a",  // 亮黄高光
          Y: "#b9bf32",  // 穗头中黄
          y: "#8b9229",  // 暗橄榄黄
          d: "#656a1e",  // 穗身深暗部
          a: "#74652a",  // 麦芒棕褐
          G: "#46581a",  // 茎叶中绿
          g: "#26330a"   // 茎叶近黑绿
        });
      }
    });

    // 木锄头：2 木板 + 2 木棍；80 点耐久；耕 1 格
    const hoe = R.item({
      name: "木锄头",
      stack: 1,
      dur: 80,
      tool: { type: "hoe", level: 1 },
      held: { model: "pick", head: 0xa8793d, dark: 0x6b4c2a },
      // 木锄七档棕色按参考图逐格取色（与木斧同系色板）
      icon: function () {
        return hoeIcon({
          O: "#372910", K: "#20180a", Q: "#493615", D: "#684e1e",
          M: "#6b511f", H: "#755821", L: "#896726"
        });
      }
    });

    // 锄头像素图：按玩家提供的木锄参考图 1:1 逐格复刻的 16×16 点阵——
    // 顶部短横梁、右伸锄刃、收颈 + 斜收木柄（每 1 行左移 1 格）。
    // pal 给锄头七档材质色（O 描边 / K 最深影 / Q 头暗部 / D 刃端中暗 /
    // M 主面 / H 受光 / L 高光）；木柄三档（u 柄左上棱 / s 柄身 /
    // p 柄受光高光，K 共用最深影）四把锄头统一为木柄。
    function hoeIcon(pal) {
      return R.pixelIcon([
        "................",
        ".......OOO......",
        "......OLHHO.....",
        ".......KKMHOQD..",
        ".........KMMLK..",
        "..........QHMK..",
        ".........usKK...",
        "........upK.....",
        ".......usK......",
        "......upK.......",
        ".....usK........",
        "....upK.........",
        "...usK..........",
        "..upK...........",
        "..KK............",
        "................"
      ], {
        O: pal.O, K: pal.K, Q: pal.Q, D: pal.D, M: pal.M, H: pal.H, L: pal.L,
        u: "#493615", s: "#684e1e", p: "#896726"
      });
    }

    // 石锄头：2 圆石 + 2 木棍；150 点耐久；仍耕 1 格但更耐用
    const stoneHoe = R.item({
      id: 127,
      name: "石锄头",
      stack: 1,
      dur: 150,
      tool: { type: "hoe", level: 2 },
      held: { model: "pick", head: 0x9a9a9a, dark: 0x5f5f5f },
      icon: function () {
        return hoeIcon({
          O: "#555555", K: "#262626", Q: "#5f5f5f", D: "#808080",
          M: "#929292", H: "#a0a0a0", L: "#aeaeae"
        });
      }
    });

    // 铁锄头：2 铁锭 + 2 木棍；200 点耐久；右键一次耕 3×3 一片
    const ironHoe = R.item({
      id: 128,
      name: "铁锄头",
      stack: 1,
      dur: 200,
      tool: { type: "hoe", level: 3 },
      held: { model: "pick", head: 0xdcdcdc, dark: 0x8f8f8f },
      icon: function () {
        return hoeIcon({
          O: "#43474d", K: "#171717", Q: "#4f565d", D: "#9aa0ab",
          M: "#c8ccd2", H: "#d8dade", L: "#eceef2"
        });
      }
    });

    // 红宝石锄头：2 红宝石 + 2 木棍；260 点耐久；右键一次耕 5×5 一片
    // 红宝石材料由 ruby_mod 导出为 RubyMod.gem（该 mod 先于本 mod 加载）
    const RUBY = window.RubyMod && window.RubyMod.gem;
    const rubyHoe = R.item({
      id: 129,
      name: "红宝石锄头",
      stack: 1,
      dur: 260,
      tool: { type: "hoe", level: 4 },
      held: { model: "pick", head: 0xe02840, dark: 0x8f1426 },
      icon: function () {
        return hoeIcon({
          O: "#6b1226", K: "#3a0a14", Q: "#8f1d38", D: "#b52448",
          M: "#d2273a", H: "#ef3f5c", L: "#ff6a86"
        });
      }
    });

    /* ---------------- 合成 ---------------- */

    // 锄头配方统一为 2×3（材料两格横排 + 中列两木棍）。
    // 注意：pattern 不能带全零的尾列——matchRecipe 只裁剪玩家摆放物的包围盒，
    // 配方宽度不裁剪，写 [[M,M,0],...]（3 列）会永远匹配不上 2 列的实际摆放
    R.registerRecipe([[B.PLANKS, B.PLANKS], [0, STICK], [0, STICK]], hoe, 1);        // 木锄头
    R.registerRecipe([[B.COBBLE, B.COBBLE], [0, STICK], [0, STICK]], stoneHoe, 1);  // 石锄头
    R.registerRecipe([[window.ITEM.IRON_INGOT, window.ITEM.IRON_INGOT],
                      [0, STICK], [0, STICK]], ironHoe, 1);                          // 铁锄头
    // 红宝石锄头：红宝石 mod 先于本 mod 加载（材料导出为 RubyMod.gem）
    if (RUBY != null) {
      R.registerRecipe([[RUBY, RUBY], [0, STICK], [0, STICK]], rubyHoe, 1);
    }
    // 麦子 -> 1 种子（保证收获后可循环；首次种子靠撸草）
    R.registerRecipe([[wheat]], seeds, 1);

    /* ---------------- 灌溉：水源浸润耕地 ---------------- */

    const WATER_R = 4;   // 水平灌溉半径（曼哈顿距离，与 MC 一致）

    // (x,y,z) 处耕地能否被水浸润：同层或上一层有静止水、水平曼哈顿距离 ≤4
    function hasWaterNear(w, x, y, z) {
      for (let dy = 0; dy <= 1; dy++) {
        const wy = y + dy;
        for (let dx = -WATER_R; dx <= WATER_R; dx++) {
          for (let dz = -WATER_R; dz <= WATER_R; dz++) {
            if (Math.abs(dx) + Math.abs(dz) > WATER_R) continue;
            if (dx === 0 && dz === 0 && dy === 0) continue;  // 自身位置不是水
            if (w.getBlock(x + dx, wy, z + dz) === B.WATER) return true;
          }
        }
      }
      return false;
    }

    /* ---------------- 锄头耕地 + 种子播种（placeHooks 物品使用） ---------------- */

    // 锄头：右键草方块/泥土 -> 耕地（其上方必须无方块）。
    // 等级决定耕作半径：木/石锄耕中心 1 格，铁锄 3×3，红宝石锄 5×5；
    // 范围内的石头、已有耕地、上方被占用的格子自动跳过；一次使用只耗 1 点耐久
    function tillOne(w, x, y, z) {
      if (!w.inBounds(x, y, z)) return false;
      const t = w.getBlock(x, y, z);
      if (t !== B.GRASS && t !== B.DIRT) return false;
      if (y + 1 >= w.H || w.getBlock(x, y + 1, z) !== B.AIR) return false;
      // 靠近水时直接耕成湿润耕地，不用等下一轮扫描
      w.setBlock(x, y, z, hasWaterNear(w, x, y, z) ? wetFarmland : farmland);
      return true;
    }
    function makeHoeHook(level) {
      const r = level >= 4 ? 2 : level === 3 ? 1 : 0;
      return function (ctx) {
        const hit = ctx.hit, w = ctx.world;
        // 中心格必须可耕，否则不响应（也不耗耐久）
        if (!tillOne(w, hit.x, hit.y, hit.z)) return false;
        for (let dx = -r; dx <= r; dx++) {
          for (let dz = -r; dz <= r; dz++) {
            if (dx === 0 && dz === 0) continue;
            tillOne(w, hit.x + dx, hit.y, hit.z + dz);
          }
        }
        w.remeshAround(hit.x, hit.z);
        ctx.damageTool(1);
        return true;
      };
    }
    R.placeHooks[hoe] = makeHoeHook(1);
    R.placeHooks[stoneHoe] = makeHoeHook(2);
    R.placeHooks[ironHoe] = makeHoeHook(3);
    R.placeHooks[rubyHoe] = makeHoeHook(4);

    // 种子：右键（湿润）耕地上表面且上方为空气 -> 播种 w0
    R.placeHooks[seeds] = function (ctx) {
      if (ctx.hit.id !== farmland && ctx.hit.id !== wetFarmland) return false;
      if (ctx.ty !== ctx.hit.y + 1 || ctx.tx !== ctx.hit.x || ctx.tz !== ctx.hit.z) return false;
      if (ctx.cur !== B.AIR) return false;
      ctx.world.setBlock(ctx.tx, ctx.ty, ctx.tz, w0);
      ctx.world.remeshAround(ctx.tx, ctx.tz);
      ctx.consume(1);
      return true;
    };

    /* ---------------- 收割掉落 ---------------- */

    function dropWheat(id, x, y, z, ctx) {
      const stage = wheatIds.indexOf(id);
      // 联机时掉落归操作者（房主为客人执行时进客人影子背包，Task 5）
      const give = (ctx && ctx.addItem) || function (it, n) { window.Crafting.addItem(it, n); };
      if (stage < 0) return;
      if (stage === 3) {
        // 成熟：麦子 1~2 + 种子 1~3
        give(wheat, 1 + (Math.random() < 0.5 ? 1 : 0));
        give(seeds, 1 + ((Math.random() * 3) | 0));
      } else if (stage === 2) {
        give(seeds, 1 + (Math.random() < 0.4 ? 1 : 0));
      } else {
        if (Math.random() < 0.6) give(seeds, 1);
      }
      growing.delete(x + "," + y + "," + z);
    }
    wheatIds.forEach(function (id) {
      R.breakHooks[id] = function (ctx) {
        dropWheat(ctx.id, ctx.x, ctx.y, ctx.z, ctx);
        return null;
      };
    });

    // 撸草方块 30% 概率掉 1 颗种子（草本身仍掉泥土）
    R.breakHooks[B.GRASS] = function (ctx) {
      const give = (ctx && ctx.addItem) || function (it, n) { window.Crafting.addItem(it, n); };
      if (Math.random() < 0.3) give(seeds, 1);
      return null;
    };

    // 挖（湿润）耕地：若上方长着小麦，一并清除（作物返还 1 颗种子保底）
    function breakFarmland(ctx) {
      const w = ctx.world;
      const give = (ctx && ctx.addItem) || function (it, n) { window.Crafting.addItem(it, n); };
      if (ctx.y + 1 < w.H && wheatIds.indexOf(w.getBlock(ctx.x, ctx.y + 1, ctx.z)) >= 0) {
        give(seeds, 1);
        w.setBlock(ctx.x, ctx.y + 1, ctx.z, B.AIR);
        growing.delete(ctx.x + "," + (ctx.y + 1) + "," + ctx.z);
      }
      drying.delete(ctx.x + "," + ctx.y + "," + ctx.z);
      return null;
    }
    R.breakHooks[farmland] = breakFarmland;
    R.breakHooks[wetFarmland] = breakFarmland;

    /* ---------------- 生长 + 灌溉：玩家附近的小麦推进、耕地干湿循环 ---------------- */

    const SCAN_R = 7;          // 检测半径（含水浸润扫描）
    const SCAN_EVERY = 1.2;    // 秒，扫描节流
    const GROW_MIN = 3.0, GROW_MAX = 6.0;          // 干耕地：每阶段间隔
    const GROW_WET_MIN = 1.5, GROW_WET_MAX = 3.5;  // 湿润耕地：约快一倍
    let DRY_DELAY = 45;        // 湿耕地离水多久后干涸（秒；玩家远离时计时暂停）
    let scanT = 0;
    const growing = new Map(); // 作物 "x,y,z" -> 下次允许生长的 elapsed 时间点
    const drying = new Map();  // 湿耕地 "x,y,z" -> 开始缺水的 elapsed 时间点

    // 扫描单块耕地：干->近水变湿；湿->缺水累计，超时干涸
    function hydrate(w, x, y, z, id, now) {
      const k = x + "," + y + "," + z;
      if (hasWaterNear(w, x, y, z)) {
        drying.delete(k);
        if (id === farmland) {
          w.setBlock(x, y, z, wetFarmland);
          w.remeshAround(x, z);
        }
      } else if (id === wetFarmland) {
        if (!drying.has(k)) drying.set(k, now);
        else if (now - drying.get(k) >= DRY_DELAY) {
          drying.delete(k);
          w.setBlock(x, y, z, farmland);
          w.remeshAround(x, z);
        }
      }
    }

    R.registerTick(function (ctx) {
      const w = ctx.world;
      scanT -= ctx.dt;
      if (scanT <= 0) {
        scanT = SCAN_EVERY;
        const px = Math.floor(ctx.player.pos.x), pz = Math.floor(ctx.player.pos.z);
        const py = Math.floor(ctx.player.pos.y);
        for (let x = px - SCAN_R; x <= px + SCAN_R; x++) {
          for (let z = pz - SCAN_R; z <= pz + SCAN_R; z++) {
            for (let y = Math.max(1, py - 2); y <= py + 3; y++) {
              if (!w.inBounds(x, y, z)) continue;
              const id = w.getBlock(x, y, z);
              if (id === w0 || id === w1 || id === w2) {
                const k = x + "," + y + "," + z;
                if (!growing.has(k)) {
                  // 湿润耕地播种的作物生长间隔约为干耕地的一半
                  const wet = w.getBlock(x, y - 1, z) === wetFarmland;
                  const a = wet ? GROW_WET_MIN : GROW_MIN;
                  const b = wet ? GROW_WET_MAX : GROW_MAX;
                  growing.set(k, ctx.elapsed + a + Math.random() * (b - a));
                }
              } else if (id === farmland || id === wetFarmland) {
                hydrate(w, x, y, z, id, ctx.elapsed);
              }
            }
          }
        }
      }
      growing.forEach(function (nextT, k) {
        if (ctx.elapsed < nextT) return;
        const parts = k.split(",");
        const x = +parts[0], y = +parts[1], z = +parts[2];
        const id = w.getBlock(x, y, z);
        const idx = wheatIds.indexOf(id);
        const below = w.getBlock(x, y - 1, z);
        // 方块已不在 / 已成熟 / 离开了任意一种耕地：停止追踪
        if (idx < 0 || idx === 3 || (below !== farmland && below !== wetFarmland)) {
          growing.delete(k);
          return;
        }
        w.setBlock(x, y, z, wheatIds[idx + 1]);
        w.remeshAround(x, z);
        growing.delete(k);  // 下一阶段由扫描重新登记（届时重新判定干湿）
      });
    });

    // 调试钩子
    window.FarmingMod = {
      farmland: farmland, wetFarmland: wetFarmland, seeds: seeds, wheat: wheat,
      hoe: hoe, stoneHoe: stoneHoe, ironHoe: ironHoe, rubyHoe: rubyHoe,
      wheatBlocks: wheatIds,
      hasWaterNear: function (x, y, z) { return hasWaterNear(__world(), x, y, z); },
      _setDryDelay: function (s) { DRY_DELAY = s; }
    };
    function __world() { return window.__mc && window.__mc.world && window.__mc.world(); }
  });
})();
