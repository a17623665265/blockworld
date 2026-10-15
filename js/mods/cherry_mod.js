/* ============================================================
 * cherry_mod.js — 樱花林模组：樱花原木 / 樱花树叶 + 樱花林生物群系
 *
 * 1:1 复刻参考图：
 *   樱花原木 —— 深紫褐色纵向竖纹树皮 + 粉色同心年轮横截面
 *   樱花树叶 —— 粉色花瓣夹杂橄榄绿叶片，cutout 镂空（真孔洞）
 * 三面纹理均从参考图的 2:1 等距渲染反投影提取 16×16 像素点阵：
 *   侧面取受光最足的左立面（引擎会再烘焙六面明暗，见 FACE_SHADE），
 *   顶面取全亮面；树叶只用一张 albedo，六面共用。
 *
 * 说明：樱花林群系本身在 world.js 内生成，通过 window.CherryMod
 * 防御读取本模组导出的方块 id（mod 必须先于 world.js 加载）。
 * ============================================================ */
(function () {
  "use strict";

  window.Mods.define("cherry", "樱花林模组", function (R) {

    // 16×16 点阵贴图：每行 4 组×4 token，组间空格仅为可读性；
    // "." 留空（树叶配合 clearRect 形成真镂空）
    function stamp(ctx, ox, oy, rows, map) {
      ctx.clearRect(ox, oy, 16, 16);
      for (let y = 0; y < rows.length; y++) {
        const line = rows[y].replace(/ /g, "");
        for (let x = 0; x < line.length; x++) {
          const c = map[line[x]];
          if (c) { ctx.fillStyle = c; ctx.fillRect(ox + x, oy + y, 1, 1); }
        }
      }
    }

    /* ---------------- 纹理（逐像素反投影自参考图） ---------------- */

    // 樱花原木侧面：深紫褐树皮纵向竖纹（6 级明暗）
    const tLogSide = R.allocTile(function (ctx, ox, oy) {
      stamp(ctx, ox, oy, [
        "cdee dddc cddb bccc",
        "dccc ceee ddcb babc",
        "bacd ddef ffee cbbc",
        "dddc aaac ddde eedc",
        "dccc cddc aaab bbcc",
        "eeed dccc cbac ddee",
        "edcc caaa deee dcce",
        "cccd dcac ddca aacc",
        "aaee ffee cccd dcaa",
        "aacc deec aaac aaac",
        "ccaa aacc accd cacd",
        "edac dddc deee fffe",
        "dccd effe eedc ccdd",
        "caac cccd eeed dccc",
        "cbdd daac ccdd ddee",
        "eeee ddca aeff eddd"
      ], {
        a: "#160b12",
        b: "#1d0f17",
        c: "#23141e",
        d: "#2c1921",
        e: "#35202b",
        f: "#412833"
      });
    });

    // 樱花原木顶面：深紫褐外圈 + 粉色同心年轮
    const tLogTop = R.allocTile(function (ctx, ox, oy) {
      stamp(ctx, ox, oy, [
        "kkKK KKkk Kwww kkwK",
        "kPPP pPpP PppP PPPk",
        "KPdd mmmm mmmm ddPK",
        "KPdP PPPP PpPP PdmK",
        "KpmP pppp pppp PmmK",
        "kPmP pmmm mmmp Pdmk",
        "Kpmp pdpp ppmp PdPK",
        "KpmP pmpm mpmp PmmK",
        "KpmP pmpm mpmp PdsK",
        "KpmP pmpp ppmp Pdmk",
        "wpmP pmmm mmmp PmmK",
        "KpmP pppp pppP PmsK",
        "kPmP PpPP PPPP Pdsk",
        "KPmm mmmm mddd dmsK",
        "wPmm mmPm ssms sssK",
        "KkKK kKKK KKKK kKKK"
      ], {
        k: "#26151f",  // 最暗边
        K: "#35202a",  // 暗紫褐外圈
        w: "#452c34",  // 外圈亮部
        P: "#e8c2b8",  // 浅粉年轮
        p: "#e3b3ab",  // 亮粉
        m: "#da9b95",  // 中粉
        d: "#ca837e",  // 暗粉年轮线
        s: "#b18c88"   // 深粉影
      });
    });

    // 樱花树叶：粉色花瓣（多色阶）+ 橄榄绿叶片 + 镂空孔洞
    const tLeaves = R.allocTile(function (ctx, ox, oy) {
      stamp(ctx, ox, oy, [
        "sppp mm.. PPP. pm..",
        "mppp smmg gP.p mp..",
        "pmpm ppgG Gmsm pmm.",
        "ppsp pp.g mmmm ggm.",
        "pmpm pp.. mmpp pGG.",
        "sppp smm. lgpp ps..",
        "mppp .msm ppmp mpp.",
        "msm. ..mm pppm ppp.",
        "psg. ppp. ppmp mmp.",
        "mpGg PpPm mmpp Pm..",
        "p.pP smsP s.pp p...",
        "sspp mdmp p.mP ..P.",
        "PspP smsP pmmm gPmG",
        "PmGG PpPs mmmg GPP.",
        "rgGg pppm m..g gmP.",
        ".rGG r..r rr.. rrr."
      ], {
        p: "#fcd6ec",  // 花瓣高光
        P: "#f4b4dc",  // 亮粉花瓣
        m: "#ec98c8",  // 中粉花瓣
        s: "#e878b4",  // 饱和粉
        d: "#e05896",  // 深粉
        r: "#c0789c",  // 暗玫瑰（冠底阴影）
        l: "#dce8cc",  // 浅绿白嫩叶
        g: "#849c30",  // 橄榄绿叶
        G: "#6a8424"   // 深橄榄绿叶
      });
    });

    /* ---------------- 方块 ---------------- */

    // 樱花原木：深紫褐树皮 + 粉色年轮截面；斧砍 0.25s
    const log = R.block({
      name: "樱花原木",
      tiles: [tLogTop, tLogSide, tLogTop],
      dig: [2.0],
      drop: "self"
    });
    R.axeDig[log] = 0.25;
    R.particleColors[log] = 0x2c1921;
    // 物品栏等距图标（透明底 PNG，1:1 取自参考渲染图）
    R.blockIconSrc[log] = "assets/cherry-log-icon.png?v=20261014a";

    // 樱花树叶：镂空 cutout 整格，透光不遮邻面；徒手 0.35s，不掉落
    // creative:true 让它在无敌模式创造物品栏中仍可直接领取（与橡木树叶同级）
    const leaves = R.block({
      name: "樱花树叶",
      tiles: [tLeaves, tLeaves, tLeaves],
      dig: [0.35],
      opaque: false,
      drop: null,
      creative: true
    });
    R.customMeshes[leaves] = function (api) {
      api.cutoutBox(0, 0, 0, 1, 1, 1, tLeaves);
    };
    R.axeDig[leaves] = 0.2;
    R.particleColors[leaves] = 0xec98c8;
    R.blockIconSrc[leaves] = "assets/cherry-leaves-icon.png?v=20261014a";

    /* ---------------- 导出（world.js 樱花林群系生成读取） ---------------- */

    window.CherryMod = { log: log, leaves: leaves };
  });
})();
