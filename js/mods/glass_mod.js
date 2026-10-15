/* ============================================================
 * glass_mod.js — 玻璃模组：沙子入熔炉烧炼出玻璃
 *
 * 展示 Mod API 的透明方块用法：
 *   透明纹理（clearRect 镂空）+ cutoutBox 整格网格
 *   → alphaTest 裁切渲染，透明像素不绘制；
 *   相邻玻璃的同 id 面自动剔除，叠放不闪面。
 * 烧炼链：沙子 --熔炉8s--> 玻璃
 * ============================================================ */
(function () {
  "use strict";

  window.Mods.define("glass", "玻璃模组", function (R) {

    // 玻璃纹理：透明底 + 浅色描边 + 斜向高光（经典玻璃样式）
    const tGlass = R.allocTile(function (ctx, ox, oy) {
      ctx.clearRect(ox, oy, 16, 16);
      ctx.fillStyle = "#d8edf4";                                  // 边框
      ctx.fillRect(ox, oy, 16, 1); ctx.fillRect(ox, oy + 15, 16, 1);
      ctx.fillRect(ox, oy, 1, 16); ctx.fillRect(ox + 15, oy, 1, 16);
      ctx.fillStyle = "#ffffff";                                  // 四角高光
      ctx.fillRect(ox, oy, 1, 1); ctx.fillRect(ox + 15, oy, 1, 1);
      ctx.fillRect(ox, oy + 15, 1, 1); ctx.fillRect(ox + 15, oy + 15, 1, 1);
      ctx.fillStyle = "#eaf7fb";                                  // 斜向高光纹
      [[3, 12], [4, 11], [5, 10], [6, 9], [7, 8],
       [9, 6], [10, 5], [11, 4], [12, 3]].forEach(function (p) {
        ctx.fillRect(ox + p[0], oy + p[1], 1, 1);
      });
    });

    // 玻璃方块：整格 cutout 网格（透明像素镂空）；徒手即碎，掉落自身
    const glass = R.block({ name: "玻璃", tiles: tGlass, dig: [0.45], opaque: false });
    R.customMeshes[glass] = function (api) {
      api.cutoutBox(0, 0, 0, 1, 1, 1, tGlass);
    };

    // 沙子 --熔炉--> 玻璃
    R.registerSmelt(window.BLOCK.SAND, glass, 1);

    // 调试钩子：控制台可用 GlassMod.block 取方块 id
    window.GlassMod = { block: glass };
  });
})();
