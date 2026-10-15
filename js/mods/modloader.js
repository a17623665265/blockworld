/* ============================================================
 * modloader.js — 极简模组加载器
 *
 * 用法：
 *   Mods.define("my_mod", "我的模组", function (R) {
 *     // R 即 GameRegistry，可注册方块 / 物品 / 纹理 / 配方 /
 *     // 烧炼 / 燃料 / 矿脉，无需改动任何核心文件
 *   });
 *
 * 加载顺序（见 index.html）：blocks.js → modloader.js → 各 mod
 * → textures.js / crafting.js / furnace.js / world.js。
 * mod 注册发生在图集与配方表构建之前，后加载的核心模块会
 * 自动把注册内容合并进游戏。
 * ============================================================ */
(function (global) {
  "use strict";

  const Mods = {
    list: [],

    // 登记并立即执行一个模组。fn 抛出的异常会被捕获并报告，
    // 不会拖垮整个游戏启动流程
    define(id, name, fn) {
      const mod = { id: id, name: name || id };
      this.list.push(mod);
      try {
        fn(global.GameRegistry);
        console.log("[Mods] 已加载模组：" + mod.name + " (" + id + ")");
      } catch (e) {
        mod.error = e;
        console.error("[Mods] 模组加载失败：" + id, e);
      }
    }
  };

  global.Mods = Mods;
})(window);
