/* ============================================================
 * bucket_mod.js — 铁桶：装水 / 装岩浆 / 倾倒
 *
 * 玩法链路：
 *   3 铁锭在工作台摆 V 形合成「铁桶」；
 *   手持空桶对水 / 岩浆源右键 -> 装成水桶 / 岩浆桶（源头被取走，
 *   岩浆余流会断供回收）；手持桶对空气格右键 -> 倒出液体并变回空桶。
 *   倒出的岩浆会像天然岩浆一样向下/四周流动（接触受伤），
 *   水与岩浆接触处会凝成玄武岩；桶中水也能灌溉远处耕地。
 *   只能装静止源头：流动岩浆（19~21）不能装。
 *
 * 依赖核心小改动：game.js 的 pickBlock 会记录射线沿途第一个液体
 * （返回值 .liq），placeBlock 以 ctx.liquid 传给 placeHook。
 * ============================================================ */
(function () {
  "use strict";
  Mods.define("bucket", "铁桶", function (R) {
    const B = window.BLOCK;
    const IRON = window.ITEM.IRON_INGOT;   // 114

    /* ---------------- 物品（固定 id，跨版本稳定） ---------------- */

    // 铁桶图标：拱形提手 + 梯形桶身（亮铁沿 / 灰铁壁 / 暗铁底）
    function bucketIcon(fill) {
      const map = { i: "#d8d8d8", d: "#8a8a8a" };
      let rows = [
        "................",
        "....iiiiiiii....",
        "....i......i....",
        "...iiiiiiiiii...",
        "...ii......ii...",
        "....id....di....",
        "....id....di....",
        ".....i....i.....",
        ".....i....i.....",
        ".....iiiiii.....",
        ".....dddddd.....",
        "................",
        "................",
        "................",
        "................",
        "................"
      ];
      if (fill === "water") {
        map.B = "#4a86e0"; map.b = "#2f5eab";
        rows[4] = "...iiBBBBBBii...";   // 桶口水线
        rows[5] = "....idBBBBdi....";
        rows[6] = "....idbbbbdi....";
        rows[7] = ".....iBBBBi.....";
        rows[8] = ".....ibbbbi.....";
      } else if (fill === "lava") {
        map.Y = "#ffc23d"; map.O = "#ff7a1e"; map.D = "#c2410f";
        rows[4] = "...iiYYYYYYii...";
        rows[5] = "....idOOOOdi....";
        rows[6] = "....idOOODdi....";
        rows[7] = ".....iYOYOi.....";
        rows[8] = ".....iDOOOi.....";
      }
      return R.pixelIcon(rows, map);
    }

    // 手持渲染与斧/镐/锄一致：直接举 16×16 像素图标（液面颜色清晰）
    const bucket = R.item({
      id: 130,
      name: "铁桶",
      stack: 1,
      held: { model: "bucket" },
      icon: function () { return bucketIcon(null); }
    });
    const waterBucket = R.item({
      id: 131,
      name: "水桶",
      stack: 1,
      held: { model: "bucket" },
      icon: function () { return bucketIcon("water"); }
    });
    const lavaBucket = R.item({
      id: 132,
      name: "岩浆桶",
      stack: 1,
      held: { model: "bucket" },
      icon: function () { return bucketIcon("lava"); }
    });

    /* ---------------- 合成：3 铁锭 V 形（需工作台 3 列宽） ---------------- */

    R.registerRecipe([[IRON, 0, IRON], [0, IRON, 0]], bucket, 1);

    /* ---------------- 装取 / 倾倒 ---------------- */

    // 桶不可堆叠，装/倒都在当前热栏槽原位替换物品堆
    function setHeldStack(ctx, id) {
      // 联机时房主为客人执行：替换的是客人的影子背包（Task 5）
      if (ctx && ctx.replaceHeld) { ctx.replaceHeld(id); return; }
      const C = window.Crafting;   // crafting.js 晚于 mod 加载，用时再取
      C.inventory[C.selected] = C.makeStack(id, 1);
      C.renderAll();
    }

    // 空桶：准星沿途第一格是水/岩浆【源头】时装走；流动岩浆不可装
    R.placeHooks[bucket] = function (ctx) {
      const lq = ctx.liquid;
      if (!lq) return false;
      if (lq.id !== B.WATER && lq.id !== B.LAVA) return false;
      const w = ctx.world;
      w.setBlock(lq.x, lq.y, lq.z, B.AIR);
      w.remeshAround(lq.x, lq.z);
      // 取走岩浆源后惊动余流：失去补给的流动岩浆会连锁回收
      w.notifyLava(lq.x, lq.y, lq.z);
      setHeldStack(ctx, lq.id === B.WATER ? waterBucket : lavaBucket);
      return true;
    };

    // 桶倾倒：只倒空气格；视线隔着液体时不倾倒（防水面误操作），
    // 也不能倒在自己站立处（岩浆会烫脚）。倒岩浆触发现有流动系统，
    // 倒水则通过 notifyLava 让相邻岩浆复检 -> 水岩相接凝玄武岩
    function makePour(liquidId) {
      return function (ctx) {
        if (ctx.liquid) return false;
        if (ctx.cur !== B.AIR) return false;
        if (ctx.overlapsPlayer && ctx.overlapsPlayer(ctx.tx, ctx.ty, ctx.tz)) return false;
        const w = ctx.world;
        w.setBlock(ctx.tx, ctx.ty, ctx.tz, liquidId);
        w.remeshAround(ctx.tx, ctx.tz);
        w.notifyLava(ctx.tx, ctx.ty, ctx.tz);
        setHeldStack(ctx, bucket);
        return true;
      };
    }
    R.placeHooks[waterBucket] = makePour(B.WATER);
    R.placeHooks[lavaBucket] = makePour(B.LAVA);

    // 调试钩子
    window.BucketMod = {
      bucket: bucket, waterBucket: waterBucket, lavaBucket: lavaBucket
    };
  });
})();
