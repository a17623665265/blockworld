/* ============================================================
 * ruby_mod.js — 红宝石模组（Mod API 示例）
 *
 * 展示一条完整的扩展链路，全程不改核心代码：
 *   红宝石矿石(地下深处, 石镐可采)
 *     → 熔炉烧炼 → 红宝石
 *       → 合成红宝石镐（4 级镐，260 点耐久，挖石最快、伤害 7）
 *       → 合成红宝石斧（4 级斧，260 点耐久，砍木最快、伤害 8，固定 id 124）
 *   9 红宝石 ⇄ 红宝石块（储物 / 建筑装饰）
 *
 * 它也是 mod 写法的参考模板：复制本文件改名即可开发新模组。
 * ============================================================ */
(function () {
  "use strict";

  window.Mods.define("ruby", "红宝石模组", function (R) {
    const STICK = window.ITEM.STICK;

    /* ---------------- 调色板 ---------------- */
    const C = {
      outline: "#6e1028", // 最深轮廓色
      hi: "#ff7a95",      // 宝石受光刻面
      main: "#e0355a",    // 红宝石主色
      dark: "#b02044",    // 暗刻面（比旧版提亮，增加层次）
      shine: "#ffd9e2"    // 近白高光
    };

    // 固定种子的小随机数，保证纹理每次生成都一致
    function rng(seed) {
      return function () {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    // 在 tile 原点 (ox,oy) 上按字符串点阵盖图案，map 给出字符→颜色
    function stamp(ctx, ox, oy, bx, by, rows, map) {
      for (let y = 0; y < rows.length; y++) {
        for (let x = 0; x < rows[y].length; x++) {
          const color = map[rows[y][x]];
          if (color) {
            ctx.fillStyle = color;
            ctx.fillRect(ox + bx + x, oy + by + y, 1, 1);
          }
        }
      }
    }

    // 石底：5 级灰的高密度细噪点 + 少量最深裂纹像素，质感更细腻
    function stoneBase(ctx, ox, oy, seed) {
      const r = rng(seed);
      const pal = ["#838383", "#8c8c8c", "#949494", "#9b9b9b", "#a2a2a2"];
      ctx.fillStyle = "#8c8c8c";
      ctx.fillRect(ox, oy, 16, 16);
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          if (r() < 0.72) {
            ctx.fillStyle = pal[(r() * pal.length) | 0];
            ctx.fillRect(ox + x, oy + y, 1, 1);
          }
        }
      }
      // 深色裂纹点（固定位置，与随机底区分开）
      ctx.fillStyle = "#707070";
      [[1, 1], [14, 2], [6, 7], [0, 12], [11, 14], [15, 9]].forEach(function (p) {
        ctx.fillRect(ox + p[0], oy + p[1], 1, 1);
      });
    }

    /* ---------------- 纹理 tile ---------------- */

    // 红宝石矿石：石底 + 带切面高光的晶体簇
    const oreTile = R.allocTile(function (ctx, ox, oy) {
      stoneBase(ctx, ox, oy, 0x52012);
      const map = { h: C.hi, L: C.main, d: C.dark };
      // 4x4 刻面晶体：亮台面 + 主色面 + 右侧暗面 + 暗底
      const facet = [
        ".hh.",
        "hLLd",
        "hLdd",
        ".dd."
      ];
      stamp(ctx, ox, oy, 2, 2, facet, map);
      stamp(ctx, ox, oy, 10, 3, facet, map);
      stamp(ctx, ox, oy, 3, 11, facet, map);
      // 零散碎晶（受光面点亮色，其余主色 / 暗色）
      ctx.fillStyle = C.hi;
      ctx.fillRect(ox + 13, oy + 1, 1, 1);
      ctx.fillRect(ox + 8, oy + 8, 1, 1);
      ctx.fillStyle = C.main;
      ctx.fillRect(ox + 13, oy + 9, 1, 1);
      ctx.fillRect(ox + 9, oy + 13, 1, 1);
      ctx.fillStyle = C.dark;
      ctx.fillRect(ox + 14, oy + 10, 1, 1);
    });

    // 红宝石块：红色底 + 最深描边 + 中央 14 宽多刻面宝石
    const blockTile = R.allocTile(function (ctx, ox, oy) {
      const r = rng(0x52bb1);
      const pal = ["#c22a4c", "#d63a5f", "#b02545", "#941a38"];
      ctx.fillStyle = "#b02545";
      ctx.fillRect(ox, oy, 16, 16);
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          if (r() < 0.55) {
            ctx.fillStyle = pal[(r() * pal.length) | 0];
            ctx.fillRect(ox + x, oy + y, 1, 1);
          }
        }
      }
      // 最深色外描边
      ctx.fillStyle = C.outline;
      ctx.fillRect(ox, oy, 16, 1);
      ctx.fillRect(ox, oy + 15, 16, 1);
      ctx.fillRect(ox, oy, 1, 16);
      ctx.fillRect(ox + 15, oy, 1, 16);
      // 中央大宝石：台面亮边、冠部主色、左右各一粒高光、亭部对称收尖
      stamp(ctx, ox, oy, 0, 3, [
        ".....oooooo.....",
        "....ohhhhhho....",
        "...ohLLLLLLho...",
        "..ohLLLLLLLLho..",
        ".ohLwLLLLLLwLho.",
        ".odLLLLLLLLLLdo.",
        "..odLLLLLLLLdo..",
        "...odLLLLLLdo...",
        "....odLLLLdo....",
        ".....odLLdo.....",
        "......oddo......",
        ".......oo......."
      ], { o: C.outline, h: C.hi, L: C.main, d: C.dark, w: C.shine });
    });

    /* ---------------- 方块 ---------------- */

    const rubyOre = R.block({
      name: "红宝石矿石",
      tiles: oreTile,
      // [徒手, 木镐, 石镐, 红宝石镐] 秒数
      dig: [5.5, 2.2, 1.1, 0.55],
      pick: 2           // 至少石镐才会掉落
    });

    const rubyBlock = R.block({
      name: "红宝石块",
      tiles: blockTile,
      dig: [6.0, 2.4, 1.2, 0.5],
      pick: 1
    });

    /* ---------------- 物品 ---------------- */

    // 红宝石：5 色刻面图标（轮廓/亮/主/暗/高光）+ 3D 宝石手持模型
    const ruby = R.item({
      name: "红宝石",
      stack: 64,
      held: { model: "gem", color: 0xe0355a, dark: 0x8f1d38 },
      icon: function () {
        return R.pixelIcon([
          "................",
          "................",
          ".....oooooo.....",
          "....ohhhhhho....",
          "...ohLLLLLLho...",
          "..ohLwLLLLwLho..",
          "..ohLLLLLLLLho..",
          "..odLLLLLLLLdo..",
          "...odLLLLLdo....",
          "....odLLLdo.....",
          ".....odLLdo.....",
          "......oddo......",
          ".......oo.......",
          "................",
          "................",
          "................"
        ], { o: C.outline, h: C.hi, L: C.main, d: C.dark, w: C.shine });
      }
    });

    // 红宝石镐：4 级镐（镐中最高，高于 3 级铁镐）、260 点耐久。图标与木/石/铁镐
    // 共用同一套参考图 1:1 点阵，仅镐头四档换成红宝石色（亮粉受光面/宝石红主色/
    // 深晶影/深晶描边），木柄五色与其他镐完全一致
    const rubyPick = R.item({
      name: "红宝石镐",
      stack: 1,
      dur: 260,
      tool: { type: "pickaxe", level: 4 },
      held: { model: "pick", head: 0xe0355a, dark: 0x8f1d38 },
      icon: function () {
        return R.pixelIcon([
          "................",
          "................",
          "......OOOOO.....",
          ".....O.HMMHOem..",
          "......OKKKMMhd..",
          "..........eHHd..",
          ".........emdMHK.",
          "........ehd.KMK.",
          ".......emd..KMK.",
          "......ehdw..KHK.",
          ".....emd....K.K.",
          "....ehd......K..",
          "...emd..........",
          "..ehdw..........",
          "..dd............",
          "................"
        ], {
          O: "#8f1d38", K: "#5c0f22", M: C.main, H: C.hi,
          e: "#453820", m: "#6a5028", d: "#28200e", h: "#876b33", w: "#fff9e6"
        });
      }
    });

    // 红宝石斧：4 级斧（斧中最高，高于 3 级铁斧）、260 点耐久。固定 id 124（def.id）——
    // 注册顺序早于农耕 mod，必须显式占号，否则会把麦子/锄头的 117~119 顶走。
    // 图标：红色斧头（亮边/主色/暗腮/深轮廓）+ 木柄左高光
    const rubyAxe = R.item({
      id: 124,
      name: "红宝石斧",
      stack: 1,
      dur: 260,
      tool: { type: "axe", level: 4 },
      held: { model: "axe", head: 0xe0355a, dark: 0x8f1d38 },
      icon: function () {
        return R.pixelIcon([
          "................",
          ".....hLLh.......",
          "...hLLLLLLLo....",
          "..hLLLLLLLLLo...",
          "..LLLLLLLLLLo...",
          "..LLddddLLLo....",
          "..sddddddo......",
          "..wsddoo........",
          "...ws...........",
          "....ws..........",
          ".....ws.........",
          "......ws........",
          ".......s........",
          "................",
          "................",
          "................"
        ], { h: C.hi, L: C.main, d: C.dark, o: C.outline, s: "#6b4c2a", w: "#9a7243" });
      }
    });

    /* ---------------- 矿脉：深层稀有 ---------------- */

    R.registerOre({
      block: rubyOre,
      count: 60,          // 全界 60 条矿脉
      minY: 2,
      maxY: 7,            // 比铁更深
      sizeMin: 2,
      sizeMax: 5
    });

    /* ---------------- 烧炼：矿石入炉出宝石 ---------------- */

    R.registerSmelt(rubyOre, ruby, 1);

    /* ---------------- 合成 ---------------- */

    // 红宝石镐：三宝石横排 + 两木棍
    R.registerRecipe(
      [[ruby, ruby, ruby],
       [0, STICK, 0],
       [0, STICK, 0]],
      rubyPick, 1
    );
    // 红宝石斧：三宝石 L 形 + 两木棍（与木斧 / 石斧同形）
    R.registerRecipe(
      [[ruby, ruby],
       [ruby, STICK],
       [0, STICK]],
      rubyAxe, 1
    );
    // 9 宝石 → 红宝石块
    R.registerRecipe(
      [[ruby, ruby, ruby],
       [ruby, ruby, ruby],
       [ruby, ruby, ruby]],
      rubyBlock, 1
    );
    // 红宝石块 → 9 宝石
    R.registerRecipe([[rubyBlock]], ruby, 9);

    // 调试钩子：浏览器控制台可通过 RubyMod.ore / .gem / .pick / .axe 取用 id
    window.RubyMod = { ore: rubyOre, block: rubyBlock, gem: ruby, pick: rubyPick, axe: rubyAxe };
  });
})();
