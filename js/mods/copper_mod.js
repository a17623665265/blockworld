/* ============================================================
 * copper_mod.js — 铜模组
 *
 *   铜矿石（地下矿脉，石镐及以上可采）
 *     → 挖掘直接掉落「粗铜」（带氧化铜绿的矿团，不可直接使用）
 *       → 熔炉烧炼 → 「铜块」（纯净橙铜）
 *
 * 三张 16×16 像素图均按玩家参考图逐格采样 1:1 复刻：
 *   矿石方块取等距渲染顶面反投影；粗铜 / 铜块取 10px 网格采样。
 * ============================================================ */
(function () {
  "use strict";

  window.Mods.define("copper", "铜模组", function (R) {

    /* ---------------- 铜矿石纹理（图1 等距顶面 1:1 提取） ----------------
     * 石底 6 档灰 + 铜矿三档橙（深铜/主铜/亮铜）+ 氧化铜绿三档青
     * + 铜绿与石头之间的卡其过渡色 */
    const ORE_P = {
      a: "#8c8c8c", b: "#7c7c7c", c: "#727272", d: "#666666",
      e: "#5c5c5c", f: "#9a9a9a",
      g: "#2f6b5b",                       // 深铜绿
      t: "#43927e", T: "#50b894",         // 中青绿 / 亮铜绿
      k: "#8a7a54",                       // 铜绿-石头过渡卡其
      o: "#c06a44", m: "#d6794d", l: "#e88566"  // 深铜 / 主铜 / 亮铜
    };
    const ORE_ROWS = [
      "aaaababcbcbbbbbc",
      "bbcbccbbbbbddbbc",
      "bcggdeedddcmoacc",
      "bbaceggdaaaaaaac",
      "bcceglmokaaaccbd",
      "badkomlfacceecbd",
      "bbbbaffbcdekkebd",
      "cdceedbbbgttmodc",
      "aTggkedaaagtkmbc",
      "btTTtkbaaaafffbe",
      "bagtfabddbbaaabe",
      "bbafbddoedbbabce",
      "bbccdgkmloobccde",
      "aagkfagkgfbbdgTe",
      "baffabafbbbbaabe",
      "bbbcbcbdbbbbbaae"
    ];
    const oreTile = R.allocTile(function (ctx, ox, oy) {
      for (let y = 0; y < 16; y++) {
        const row = ORE_ROWS[y];
        for (let x = 0; x < 16; x++) {
          const col = ORE_P[row[x]];
          if (col) {
            ctx.fillStyle = col;
            ctx.fillRect(ox + x, oy + y, 1, 1);
          }
        }
      }
    });

    /* ---------------- 物品 ---------------- */

    // 粗铜（图2 1:1 提取）：橙铜矿团 + 氧化铜绿斑块，深色双系描边
    const rawCopper = R.item({
      name: "粗铜",
      stack: 64,
      held: { model: "icon" },
      icon: function () {
        return R.pixelIcon([
          "................",
          "................",
          "...kkk...kdddd..",
          "..ktqqkkkulhhod.",
          ".kTTtTqtulhwhlD.",
          ".kLWLTTuuoolodD.",
          "duTtqqvmddmoD...",
          "dhltqumdddmmmD..",
          "dhhluomdddmdDDD.",
          "DlholomddmholmmD",
          ".Dloomdmdhwlomzg",
          ".gzmdmddDlhhmztg",
          ".gtqzdDDDoomdttg",
          "..gggD...Doddgg.",
          "..........ggg...",
          "................"
        ], {
          k: "#2d5145",   // 深铜绿描边（上半）
          g: "#2b3733",   // 最深铜绿描边（右下尾部）
          d: "#8d3f29",   // 深铜描边
          D: "#71331a",   // 最深棕铜描边（右下）
          m: "#a54b26",   // 暗铜
          o: "#c65f34",   // 主铜橙
          l: "#e67c55",   // 亮铜橙
          h: "#fd9982",   // 肉粉高光
          w: "#ffc1b6",   // 浅粉高光
          q: "#3b7465",   // 深青绿
          t: "#528b7a",   // 中青绿
          T: "#50bc9a",   // 亮铜绿
          L: "#84e2c7",   // 浅薄荷
          W: "#c5feed",   // 近白薄荷高光
          u: "#8c713c",   // 橄榄过渡
          v: "#9d6741",   // 卡其过渡
          z: "#5f5e40"    // 暗橄榄过渡
        });
      }
    });

    // 铜块（图3 1:1 提取）：烧炼后的纯净橙铜团，四档铜色 + 粉色高光
    const copper = R.item({
      name: "铜块",
      stack: 64,
      held: { model: "icon" },
      icon: function () {
        return R.pixelIcon([
          "................",
          "................",
          "..........dd....",
          "........dddoos..",
          ".....dddlomdols.",
          ".dddollommollos.",
          "dhollolmdollhhls",
          "dlhllooolhhhommD",
          "dlohllhhhloomsdD",
          "dldowhodmoomssoD",
          "dlddhommoommmDD.",
          ".domhmdoomDDD...",
          "..ddlmoDDD......",
          "...ddDD.........",
          "................",
          "................"
        ], {
          d: "#9f4522",   // 深铜描边
          D: "#6e3321",   // 最深棕影
          s: "#7e462f",   // 暗红铜（右缘）
          m: "#944d3b",   // 暗紫铜
          o: "#bf5d38",   // 主铜橙
          l: "#e87b5a",   // 亮铜橙
          h: "#fd9886",   // 肉粉
          w: "#f8c5b4"    // 浅粉高光
        });
      }
    });

    /* ---------------- 方块 ---------------- */

    const copperOre = R.block({
      name: "铜矿石",
      tiles: oreTile,
      // 与铁矿石同档：[徒手, 木镐, 石镐] 秒数
      dig: [5.0, 1.9, 0.95],
      pick: 2,             // 至少石镐才会掉落
      drop: rawCopper      // 挖下直接掉粗铜
    });
    R.particleColors[copperOre] = 0xb9684a;

    /* ---------------- 矿脉：中浅层富矿 ---------------- */

    R.registerOre({
      block: copperOre,
      count: 160,         // 全界 160 条矿脉（多于铁、少于煤）
      minY: 3,
      maxY: 16,           // 中浅层都可能遇到
      sizeMin: 4,
      sizeMax: 9
    });

    /* ---------------- 烧炼：粗铜 → 铜块 ---------------- */

    R.registerSmelt(rawCopper, copper, 1);

    // 调试钩子：浏览器控制台 CopperMod.ore / .raw / .copper 取 id
    window.CopperMod = { ore: copperOre, raw: rawCopper, copper: copper };
  });
})();
