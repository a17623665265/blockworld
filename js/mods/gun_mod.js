/* ============================================================
 * gun_mod.js — 枪械模组
 *
 * 第一期（火药）：
 *   火药：16×16 像素图标按参考图 1:1 复刻；可堆叠 64。
 *   掉落：僵尸死亡 50% 概率掉 1 个（掉落行 [id,0,1]，
 *         0..1 等概率，与牛掉皮革同一机制）。
 *
 * 第二期（枪械工作台）：
 *   枪械工作台：冷钢灰金属工作台方块，木镐及以上可挖回。
 *   合成：工作台居中，上下左右各 1 铁锭（共 4 铁锭）。
 *   右键打开独立枪械合成面板（js/gunbench.js），
 *   枪械 / 弹药配方只在该面板生效，普通工作台做不出火器。
 *
 * 第三期（手枪子弹）：
 *   手枪子弹：16×16 像素图标按玩家参考图 1:1 复刻（铜色尖弹头 +
 *   金黄直筒弹壳、左侧竖高光、退壳槽、底缘中央底火、右下投影）。
 *   枪械工作台配方：铜块 + 火药 → 手枪子弹 ×4。
 *
 * 第四期（手枪）：
 *   手枪：16×16 图标按参考图 1:1 复刻（冷枪灰套筒 + 橄榄绿聚合物
 *   握把、套筒反光棱、扳机护圈、照门缺口），不可堆叠；
 *   手持为 viewmodel.js 的体素 3D 模型（model:"gun"）。
 *   枪械工作台配方：5 铁锭 + 1 木棍（手枪侧影形状）→ 手枪 ×1。
 * ============================================================ */
(function () {
  "use strict";

  window.Mods.define("gun", "枪械模组", function (R) {
    /* ---------------- 火药 ---------------- */

    const gunpowder = R.item({
      name: "火药",
      stack: 64,
      held: { model: "icon" },
      icon: function () {
        // k 近黑描边 / K 深黑颗粒 / d 暗灰 / D 中暗灰 / m 主灰 / l 受光亮灰
        return R.pixelIcon([
          "................",
          "................",
          "................",
          ".......kk.......",
          "......kmmk......",
          ".....klmDdk.....",
          "....kmmmmddk....",
          "...kmmmmmdKdk...",
          "..kmmmDmlddddk..",
          "..kmDmmmmddKdk..",
          "..kdmlmmmddddk..",
          "...kddmmKddDk...",
          "....kkddddkk....",
          "......kkkk......",
          "................",
          "................"
        ], {
          k: "#2d2d2d",
          K: "#373737",
          d: "#494949",
          D: "#545454",
          m: "#727272",
          l: "#8a8a8a"
        });
      }
    });

    // 僵尸：50% 掉 1 个火药（min=0/max=1）
    R.mobDrops.zombie = [[gunpowder, 0, 1]];

    /* ---------------- 手枪子弹（参考图 1:1 复刻） ----------------
     * 铜色尖弹头（h 浅粉高光 / l 亮铜 / m 主铜 / d 深铜暗）+
     * 金黄直筒弹壳（w 白高光 / G 亮金 / g 主金 / D 暗金），
     * 弹肩接缝、退壳槽 S、底缘中央底火 N、右下地面投影 s。
     * ---------------------------------------------------------------- */
    const bullet = R.item({
      name: "手枪子弹",
      stack: 64,
      held: { model: "icon" },
      icon: function () {
        return R.pixelIcon([
          "................",
          ".......kk.......",
          "......khhk......",
          ".....khlmdk.....",
          ".....khlmdk.....",
          "....kGdmmdGk....",
          "....kGwgggDk....",
          "....kwGgggDk....",
          "....kSSSSDDk....",
          "....kwGgggDk....",
          "....kwGgggDk....",
          "....kwGgggDk....",
          "....kGGgggDk....",
          "....kGwGGGDk....",
          "....kDgNNgDk....",
          "....kkkkkkkstt.."
        ], {
          k: "#20150a",  // 近黑暖描边
          h: "#ffcca6",  // 弹头浅粉高光
          l: "#ee9a64",  // 亮铜
          m: "#d97c4a",  // 主铜橙
          d: "#ad5328",  // 深铜暗部
          w: "#fff3b2",  // 弹壳白高光
          G: "#f5d86b",  // 亮金
          g: "#d7ab30",  // 主金黄铜
          D: "#9e7413",  // 暗金
          S: "#7c5b0d",  // 退壳槽暗带
          N: "#39404c",  // 底火蓝黑
          s: "#534d42",  // 地面投影（近）
          t: "#7a7468"   // 地面投影（渐隐）
        });
      }
    });

    /* ---------------- 手枪（参考图 1:1 复刻） ----------------
     * 枪口朝右侧视图：冷枪灰长套筒（w/G 反光棱、k 照门缺口、
     * D 套筒下沿暗带）+ 橄榄绿聚合物握把（l 亮面/s 暗边，
     * 下部弹匣底座向左外撇）+ 扳机护圈（N 护圈内空洞）。
     * 无色阴影（参考图本体无投影）。
     * ---------------------------------------------------------------- */
    const pistol = R.item({
      name: "手枪",
      stack: 1,
      held: { model: "gun" },
      icon: function () {
        return R.pixelIcon([
          "................",
          "................",
          ".wdmmmdkDmmmmmGG",
          "GdDDDdmwGddddddd",
          "mDkkkkDDDDDDDkkD",
          "dslllskkDkkkkkkD",
          ".sslgkkDNkDDk...",
          ".dgllDkd.d......",
          ".gggskDkDd.......",
          "sgggsG..........",
          "slgls...........",
          "slggk...........",
          "ssssk...........",
          "kkkkk...........",
          "................",
          "................"
        ], {
          k: "#14161a",  // 近黑蓝：描边 / 接缝 / 照门缺口
          D: "#262a30",  // 深枪灰：套筒下沿暗带
          d: "#3a3f45",  // 中深枪灰：套筒暗侧
          m: "#4d5157",  // 主枪灰：套筒正面
          G: "#6f7378",  // 亮枪灰：棱角 / 枪口端
          w: "#8b8e93",  // 近白高光：套筒反光棱 / 枪尾棱角
          g: "#494e40",  // 橄榄绿：聚合物握把主色
          l: "#585e4d",  // 握把亮面
          s: "#30352b",  // 握把暗边 / 弹匣底座
          N: "#080b10"   // 扳机护圈内空洞
        });
      }
    });

    /* ---------------- 枪械工作台方块纹理 ---------------- */

    // 顶面：钢制工作面 —— 螺栓四角 + 中央横向枪管槽
    const tBenchTop = R.allocTile(function (ctx, ox, oy) {
      // 钢灰底板
      ctx.fillStyle = "#8b8f94";
      ctx.fillRect(ox, oy, 16, 16);
      // 细碎金属噪点（暗点 / 亮点）
      ctx.fillStyle = "#7d8187";
      [[2,3],[5,2],[9,3],[13,2],[3,12],[8,13],[12,12],[14,9],[1,8],[6,9]].forEach(function (p) {
        ctx.fillRect(ox + p[0], oy + p[1], 1, 1);
      });
      ctx.fillStyle = "#9aa0a7";
      [[3,1],[11,1],[6,14],[14,14],[1,4],[13,5]].forEach(function (p) {
        ctx.fillRect(ox + p[0], oy + p[1], 1, 1);
      });
      // 近黑外沿 + 内侧高光棱
      ctx.fillStyle = "#5b5f66";
      ctx.fillRect(ox, oy, 16, 1); ctx.fillRect(ox, oy + 15, 16, 1);
      ctx.fillRect(ox, oy, 1, 16); ctx.fillRect(ox + 15, oy, 1, 16);
      ctx.fillStyle = "#9ea4ab";
      ctx.fillRect(ox + 1, oy + 1, 14, 1); ctx.fillRect(ox + 1, oy + 1, 1, 14);
      // 四角螺栓（2×2 暗底 + 左上一点高光）
      [[2,2],[12,2],[2,12],[12,12]].forEach(function (p) {
        ctx.fillStyle = "#3d4147";
        ctx.fillRect(ox + p[0], oy + p[1], 2, 2);
        ctx.fillStyle = "#b6bcc3";
        ctx.fillRect(ox + p[0], oy + p[1], 1, 1);
      });
      // 中央横向枪管槽：深色凹槽 + 高光棱 + 底部深影
      ctx.fillStyle = "#34383e";
      ctx.fillRect(ox + 2, oy + 6, 12, 4);
      ctx.fillStyle = "#a8aeb5";
      ctx.fillRect(ox + 3, oy + 6, 10, 1);
      ctx.fillStyle = "#565b62";
      ctx.fillRect(ox + 3, oy + 7, 10, 2);
      ctx.fillStyle = "#2b2f35";
      ctx.fillRect(ox + 3, oy + 9, 10, 1);
    });

    // 侧面：上 2/3 铆接铁板（台钳凹槽）+ 下方木板基座（抽屉拉手）
    const tBenchSide = R.allocTile(function (ctx, ox, oy) {
      // 下方木板基座 y11..15
      ctx.fillStyle = "#a8793d";
      ctx.fillRect(ox, oy + 11, 16, 5);
      ctx.fillStyle = "#96682f";
      [5, 10].forEach(function (sx) { ctx.fillRect(ox + sx, oy + 11, 1, 5); });
      ctx.fillStyle = "#bd8b4c";
      ctx.fillRect(ox, oy + 11, 16, 1);
      ctx.fillStyle = "#6b4c2a";
      ctx.fillRect(ox, oy + 15, 16, 1);
      // 木板上的抽屉拉手
      ctx.fillStyle = "#5a3f26";
      ctx.fillRect(ox + 5, oy + 13, 6, 1);
      ctx.fillStyle = "#9aa0a7";
      ctx.fillRect(ox + 6, oy + 13, 4, 1);
      // 上部铆接铁板 y1..10
      ctx.fillStyle = "#848890";
      ctx.fillRect(ox, oy + 1, 16, 10);
      // 顶沿 / 两侧包边 / 板底阴影
      ctx.fillStyle = "#595d64";
      ctx.fillRect(ox, oy, 16, 1);
      ctx.fillStyle = "#6d7178";
      ctx.fillRect(ox, oy + 1, 1, 10);
      ctx.fillRect(ox + 15, oy + 1, 1, 10);
      ctx.fillStyle = "#969ba2";
      ctx.fillRect(ox + 1, oy + 1, 1, 10);
      ctx.fillStyle = "#6a6e75";
      ctx.fillRect(ox, oy + 10, 16, 1);
      // 铆钉 2×2
      [[2,2],[12,2],[2,7],[12,7]].forEach(function (p) {
        ctx.fillStyle = "#3d4147";
        ctx.fillRect(ox + p[0], oy + p[1], 2, 2);
        ctx.fillStyle = "#b6bcc3";
        ctx.fillRect(ox + p[0], oy + p[1], 1, 1);
      });
      // 铁板中央台钳凹槽（枪械夹具识别符号）
      ctx.fillStyle = "#34383e";
      ctx.fillRect(ox + 5, oy + 3, 6, 3);
      ctx.fillStyle = "#a8aeb5";
      ctx.fillRect(ox + 5, oy + 3, 6, 1);
      ctx.fillStyle = "#565b62";
      ctx.fillRect(ox + 6, oy + 4, 4, 1);
    });

    // 底面：木板
    const tBenchBottom = R.allocTile(function (ctx, ox, oy) {
      ctx.fillStyle = "#a8793d";
      ctx.fillRect(ox, oy, 16, 16);
      ctx.fillStyle = "#96682f";
      [3, 7, 11].forEach(function (sx) { ctx.fillRect(ox + sx, oy, 1, 16); });
    });

    /* ---------------- 枪械工作台方块 ---------------- */

    const gunBench = R.block({
      name: "枪械工作台",
      tiles: [tBenchTop, tBenchSide, tBenchBottom],
      dig: [3.2, 1.5, 0.9, 0.55],  // 比木板硬、比熔炉略软
      pick: 1,                       // 木镐及以上可挖回，徒手敲碎不掉落
      opaque: true
    });
    R.particleColors[gunBench] = 0x848890;

    /* ---------------- 合成：4 铁锭上下夹住工作台 ----------------
     *   · 铁 ·
     *   铁 台 铁     （台 = 工作台）
     *   · 铁 ·
     * ------------------------------------------------------------------ */
    const IRON = window.ITEM.IRON_INGOT;   // 114
    const TABLE = window.BLOCK.CRAFTING_TABLE;  // 11
    R.registerRecipe(
      [[0, IRON, 0],
       [IRON, TABLE, IRON],
       [0, IRON, 0]],
      gunBench, 1
    );

    /* ---------------- 右键打开枪械合成面板 ---------------- */

    R.interactions[gunBench] = function (ctx) {
      // 联机时房主为客人执行：与储物箱 / 熔炉同路径（客人端收到开放提示）
      if (ctx.openUI) {
        ctx.openUI("gunbench", { x: ctx.x, y: ctx.y, z: ctx.z });
        return true;
      }
      if (window.GunBench && window.GunBench.open) {
        window.GunBench.open();
        return true;
      }
      return true;
    };

    /* ---------------- 枪械工作台专属配方 ----------------
     * 铜块 + 火药 → 手枪子弹 ×4（竖直两格，3×3 网格内任意位置）。
     * copper_mod.js 与 gunbench.js 均在本 mod 之后加载，
     * 立即注册取不到依赖，延迟到 DOMContentLoaded（全部脚本就位）。
     * ------------------------------------------------------------------ */
    function registerGunBenchRecipes() {
      const gb = window.GunBench;
      const copper = window.CopperMod && window.CopperMod.copper;
      if (!gb || copper == null) return false;
      // 弹药：铜块 + 火药（竖排两格）→ 子弹 ×4
      gb.addRecipe([[copper], [gunpowder]], bullet, 4);
      // 手枪：5 铁锭 + 1 木棍摆成手枪侧影
      //   · 铁 铁
      //   铁 铁 铁      （枪口朝右，左下木棍为握把）
      //   木 · ·
      const IRON = window.ITEM.IRON_INGOT;
      const STICK = window.ITEM.STICK;
      gb.addRecipe(
        [[0, IRON, IRON],
         [IRON, IRON, IRON],
         [STICK, 0, 0]],
        pistol, 1
      );
      return true;
    }
    if (!registerGunBenchRecipes()) {
      // 同步脚本执行期间 DOMContentLoaded 必未触发，回调时依赖均已就位
      window.addEventListener("DOMContentLoaded", registerGunBenchRecipes);
    }

    /* ============================================================
     * 枪械战斗参数（game.js 射击系统读取）
     *  - MAG：手枪弹匣容量；RANGE：射程（方块）；DAMAGE：单发伤害；
     *    FIRE_CD：半自动开火间隔（秒）；RELOAD_T：换弹动作时长（秒）
     * ============================================================ */
    const GUN_SPEC = {
      MAG: 7,
      RANGE: 20,        // 需求 ≥15 格
      DAMAGE: 6,
      FIRE_CD: 0.28,
      RELOAD_T: 0.9
    };

    /* ---------------- 程序化音效（WebAudio，零音频资源） ---------------- */
    let audioCtx = null;
    function getCtx() {
      if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        try { audioCtx = new AC(); } catch (e) { return null; }
      }
      // 浏览器自动播放策略：首次用户手势内 resume
      if (audioCtx.state === "suspended") audioCtx.resume();
      return audioCtx;
    }
    // 白噪声缓存（1 秒缓冲反复裁用）
    let noiseBuf = null;
    function getNoise(ctx) {
      if (noiseBuf) return noiseBuf;
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = noiseBuf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      return noiseBuf;
    }
    function playClick(ctx, t, freq, dur, vol) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "square";
      o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g).connect(ctx.destination);
      o.start(t); o.stop(t + dur + 0.02);
    }
    const GunSFX = {
      // 枪声：噪声爆点（低通模拟钝响）+ 低频「咚」体
      fire() {
        const ctx = getCtx(); if (!ctx) return;
        const t = ctx.currentTime;
        const src = ctx.createBufferSource();
        src.buffer = getNoise(ctx);
        const lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.setValueAtTime(2600, t);
        lp.frequency.exponentialRampToValueAtTime(420, t + 0.2);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.55, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
        src.connect(lp).connect(g).connect(ctx.destination);
        src.start(t); src.stop(t + 0.26);
        playClick(ctx, t, 95, 0.14, 0.5);   // 低频体
      },
      // 空仓：干涩短咔哒
      empty() {
        const ctx = getCtx(); if (!ctx) return;
        playClick(ctx, ctx.currentTime, 1300, 0.035, 0.12);
      },
      // 换弹：退匣咔 + 上匣咔（按 RELOAD_T 节奏分布）
      reload() {
        const ctx = getCtx(); if (!ctx) return;
        const t = ctx.currentTime;
        playClick(ctx, t, 700, 0.05, 0.18);
        playClick(ctx, t + GUN_SPEC.RELOAD_T * 0.62, 480, 0.06, 0.22);
        playClick(ctx, t + GUN_SPEC.RELOAD_T * 0.85, 900, 0.04, 0.16);
      }
    };

    // 调试钩子：浏览器控制台 GunMod.gunpowder / .bench / .bullet / .pistol 取 id
    window.GunMod = {
      gunpowder: gunpowder, bench: gunBench, bullet: bullet, pistol: pistol,
      MAG: GUN_SPEC.MAG, RANGE: GUN_SPEC.RANGE, DAMAGE: GUN_SPEC.DAMAGE,
      FIRE_CD: GUN_SPEC.FIRE_CD, RELOAD_T: GUN_SPEC.RELOAD_T,
      sfx: function (kind) { if (GunSFX[kind]) GunSFX[kind](); }
    };
  });
})();
