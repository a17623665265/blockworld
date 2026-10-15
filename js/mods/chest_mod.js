/* ============================================================
 * chest_mod.js — 储物箱模组：8x10 大容量储物方块
 *
 * 展示 Mod API 的容器交互用法：
 *   纹理：木板底 + 深色边框 + 金属锁扣
 *   交互：右键打开 8x10（80 格）储物面板（面板逻辑在 chest.js）
 *   破坏：箱内每堆物品在箱子位置掉为世界掉落物，走近自动拾取，背包满留在地上不丢失
 * ============================================================ */
(function () {
  "use strict";

  window.Mods.define("chest", "储物箱模组", function (R) {
    const B = window.BLOCK;

    /* ---------------- 纹理 ---------------- */

    // 顶面：木板 + 边框 + 中央锁扣
    const tChestTop = R.allocTile(function (ctx, ox, oy) {
      ctx.fillStyle = "#a8793d"; ctx.fillRect(ox, oy, 16, 16);
      ctx.fillStyle = "#96682f";
      [3, 7, 11].forEach(function (sx) { ctx.fillRect(ox + sx, oy, 1, 16); });
      ctx.fillStyle = "#6b4c2a";
      ctx.fillRect(ox, oy, 16, 2); ctx.fillRect(ox, oy + 14, 16, 2);
      ctx.fillRect(ox, oy, 2, 16); ctx.fillRect(ox + 14, oy, 2, 16);
      ctx.fillStyle = "#8a5f33";
      ctx.fillRect(ox + 2, oy + 2, 12, 1); ctx.fillRect(ox + 2, oy + 13, 12, 1);
      // 锁扣
      ctx.fillStyle = "#d4af37"; ctx.fillRect(ox + 7, oy + 6, 2, 4);
      ctx.fillStyle = "#b8941f"; ctx.fillRect(ox + 7, oy + 6, 2, 1);
    });

    // 侧面：木板 + 边框 + 上沿锁扣凹槽
    const tChestSide = R.allocTile(function (ctx, ox, oy) {
      ctx.fillStyle = "#a8793d"; ctx.fillRect(ox, oy, 16, 16);
      ctx.fillStyle = "#96682f";
      [3, 7, 11].forEach(function (sx) { ctx.fillRect(ox + sx, oy, 1, 16); });
      ctx.fillStyle = "#6b4c2a";
      ctx.fillRect(ox, oy, 16, 2); ctx.fillRect(ox, oy + 14, 16, 2);
      ctx.fillRect(ox, oy, 2, 16); ctx.fillRect(ox + 14, oy, 2, 16);
      // 上沿凹槽（顶盖接缝感）
      ctx.fillStyle = "#8a5f33"; ctx.fillRect(ox + 2, oy + 2, 12, 2);
      // 锁扣（前面中央）
      ctx.fillStyle = "#d4af37"; ctx.fillRect(ox + 7, oy + 4, 2, 3);
    });

    /* ---------------- 方块 ---------------- */

    const chest = R.block({
      name: "储物箱",
      tiles: [tChestTop, tChestSide, tChestSide],
      dig: [2.0, 1.0, 0.6],
      opaque: true
    });

    /* ---------------- 合成：8 木板围一圈 ---------------- */

    const P = B.PLANKS;
    R.registerRecipe(
      [[P, P, P],
       [P, 0, P],
       [P, P, P]],
      chest, 1
    );

    /* ---------------- 右键打开 8x10 储物面板 ---------------- */

    R.interactions[chest] = function (ctx) {
      // 联机时房主为客人执行：不弹房主自己的面板，回 open 消息让客人打开（Task 5）
      if (ctx.openUI) { ctx.openUI("chest", { x: ctx.x, y: ctx.y, z: ctx.z }); return true; }
      if (window.Chest && window.Chest.openAt) {
        window.Chest.openAt(ctx.x, ctx.y, ctx.z);
        return true;
      }
      return false;
    };

    /* ---------------- 破坏：箱内物品掉为世界掉落物 ---------------- */

    R.breakHooks[chest] = function (ctx) {
      if (window.Chest && window.Chest.breakAt) {
        window.Chest.breakAt(ctx.x, ctx.y, ctx.z, ctx.spawnDrop || null, ctx.toast || null);
      }
      return null;
    };

    // 调试钩子
    window.ChestMod = { block: chest };
  });
})();
