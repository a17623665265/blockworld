/* ============================================================
 * furniture_mod.js — 家具模组：门 / 窗 / 床 / 楼梯 / 台阶 / 活板门 / 灯 / 围栏 / 栅门
 *
 * 展示 Mod API 的高级用法：
 *   customMeshes   自定义网格（薄板 / 半砖 / 阶梯 / 栅栏等异形方块）
 *   collisionBoxes 局部碰撞盒（台阶只挡半格、围栏 1.5 格高跳不过）
 *   interactions   右键交互（门 / 活板门开关、床睡觉跳过夜晚）
 *   placeHooks     自定义放置（双格门、按朝向放楼梯）
 *   breakHooks     破坏连带（挖门任一半，两半一起消失）
 *   lightBlocks    点光源（灯，比火把更亮更稳）
 * 状态全部编码为独立方块 ID，存档（Uint8Array）天然兼容。
 * ============================================================ */
(function () {
  "use strict";

  window.Mods.define("furniture", "家具模组", function (R) {
    const B = window.BLOCK, T = window.TILE, S = window.ITEM.STICK, W = window.ITEM.WOOL;
    const BL = B.BIRCH_LOG;   // 桦木原木（木栅门材料）
    const PLANKS = T.PLANKS, SNOW = T.SNOW;   // 复用内置木板 / 雪白纹理

    /* ============================================================
     * 白桦木板纹理（橄榄黄褐横纹木板，逐像素采样参考图）。
     * 白桦木板方块 / 压力板共用。
     * ============================================================ */
    const tBirchPlanks = R.allocTile(function (ctx, ox, oy) {
      const P = ["#CEBE84", "#CEB47C", "#C0AB73", "#B09D6E",
                 "#A7956E", "#9E8A60", "#97825B"];
      const M = [
        "1210000010000010",
        "1122432111221133",
        "2111212333322111",
        "4554456655656656",
        "1030000300012231",
        "2112323432211112",
        "3321222411122333",
        "6655456666555456",
        "1001220000000013",
        "1211112333232333",
        "0122333322223313",
        "6654456665455666",
        "0310011300030100",
        "2211332331121222",
        "2332123411233333",
        "6556654445656666"
      ];
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          ctx.fillStyle = P[+M[y][x]];
          ctx.fillRect(ox + x, oy + y, 1, 1);
        }
      }
    });

    /* ============================================================
     * 纹理
     * ============================================================ */

    // 木门下半格：透明底 + 深木外框 + 木板嵌板 + 顶部把手（与上半格把手在中缝相接）
    const tDoorBtm = R.allocTile(function (ctx, ox, oy) {
      ctx.clearRect(ox, oy, 16, 16);
      ctx.fillStyle = "#6b4c2a";
      ctx.fillRect(ox, oy, 16, 2); ctx.fillRect(ox, oy + 14, 16, 2);
      ctx.fillRect(ox, oy, 2, 16); ctx.fillRect(ox + 14, oy, 2, 16);
      ctx.fillStyle = "#a8793d"; ctx.fillRect(ox + 2, oy + 2, 12, 12);
      ctx.fillStyle = "#96682f";
      [5, 8, 11].forEach(function (sx) { ctx.fillRect(ox + sx, oy + 2, 1, 12); });
      ctx.fillStyle = "#8a5f33";
      ctx.fillRect(ox + 4, oy + 4, 8, 1); ctx.fillRect(ox + 4, oy + 9, 8, 1);
      ctx.fillRect(ox + 4, oy + 4, 1, 6); ctx.fillRect(ox + 11, oy + 4, 1, 6);
      ctx.fillStyle = "#3d2c16";
      ctx.fillRect(ox + 11, oy + 2, 2, 1);   // 把手（靠中缝）
    });

    // 木门上半格：透明底 + 深木外框 + 镂空玻璃窗（与玻璃窗同风格）+ 底部把手
    const tDoorTop = R.allocTile(function (ctx, ox, oy) {
      ctx.clearRect(ox, oy, 16, 16);
      ctx.fillStyle = "#6b4c2a";
      ctx.fillRect(ox, oy, 16, 2); ctx.fillRect(ox, oy + 14, 16, 2);
      ctx.fillRect(ox, oy, 2, 16); ctx.fillRect(ox + 14, oy, 2, 16);
      ctx.fillStyle = "#a8793d";
      ctx.fillRect(ox + 2, oy + 2, 12, 1); ctx.fillRect(ox + 2, oy + 13, 12, 1);
      ctx.fillRect(ox + 2, oy + 2, 1, 12); ctx.fillRect(ox + 13, oy + 2, 1, 12);
      ctx.fillRect(ox + 7, oy + 2, 2, 12);                       // 竖中梃
      ctx.fillStyle = "#eaf7fb";                                 // 玻璃斜向高光
      [[4, 10], [5, 9], [6, 8], [10, 6], [11, 5], [12, 4]].forEach(function (p) {
        ctx.fillRect(ox + p[0], oy + p[1], 1, 1);
      });
      ctx.fillStyle = "#3d2c16";
      ctx.fillRect(ox + 11, oy + 13, 2, 1);  // 把手（靠中缝）
    });

    // 玻璃窗：透明底（alphaTest 镂空）+ 细木框 + 十字中梃 + 斜向高光。
    // 上下叠放时拼成一扇通高竖窗：hasTop/hasBottom 控制上/下横框是否省略，
    // 侧框与竖中梃始终贯通，接缝处木框消隐。
    function paintWindow(ctx, ox, oy, hasTop, hasBottom) {
      ctx.clearRect(ox, oy, 16, 16);
      ctx.fillStyle = "#7a5a30";
      ctx.fillRect(ox, oy, 2, 16); ctx.fillRect(ox + 14, oy, 2, 16);   // 侧框（贯通）
      if (hasTop) ctx.fillRect(ox, oy, 16, 2);                         // 上框
      if (hasBottom) ctx.fillRect(ox, oy + 14, 16, 2);                 // 下框
      ctx.fillRect(ox + 7, oy, 2, 16);                                 // 竖中梃（贯通）
      ctx.fillRect(ox + 2, oy + 7, 12, 2);                             // 横中梃
      ctx.fillStyle = "#5e4523";                                       // 立体暗边
      ctx.fillRect(ox, oy, 1, 16); ctx.fillRect(ox + 15, oy, 1, 16);
      if (hasTop) ctx.fillRect(ox, oy, 16, 1);
      if (hasBottom) ctx.fillRect(ox, oy + 15, 16, 1);
      if (hasTop) {                                                    // 左上立体亮边
        ctx.fillStyle = "#9a753f";
        ctx.fillRect(ox + 2, oy + 2, 12, 1); ctx.fillRect(ox + 2, oy + 2, 1, 12);
      }
      ctx.fillStyle = "#dff0fa";                                       // 玻璃斜向高光
      ctx.fillRect(ox + 3, oy + 4, 1, 1); ctx.fillRect(ox + 4, oy + 3, 1, 1);
      ctx.fillRect(ox + 11, oy + 5, 1, 1); ctx.fillRect(ox + 12, oy + 4, 1, 1);
      ctx.fillRect(ox + 3, oy + 12, 1, 1); ctx.fillRect(ox + 4, oy + 11, 1, 1);
      ctx.fillRect(ox + 11, oy + 13, 1, 1); ctx.fillRect(ox + 12, oy + 12, 1, 1);
    }
    const tWindow  = R.allocTile(function (ctx, ox, oy) { paintWindow(ctx, ox, oy, true, true); });
    const tWinNoTop = R.allocTile(function (ctx, ox, oy) { paintWindow(ctx, ox, oy, false, true); });
    const tWinNoBtm = R.allocTile(function (ctx, ox, oy) { paintWindow(ctx, ox, oy, true, false); });
    const tWinMid  = R.allocTile(function (ctx, ox, oy) { paintWindow(ctx, ox, oy, false, false); });

    // 活板门：横向木板 + 上下横梁 + 中央拉孔
    const tTrap = R.allocTile(function (ctx, ox, oy) {
      ctx.fillStyle = "#a8793d"; ctx.fillRect(ox, oy, 16, 16);
      ctx.fillStyle = "#8a5f33";
      [3, 7, 11].forEach(function (sy) { ctx.fillRect(ox, oy + sy, 16, 1); });
      ctx.fillStyle = "#6b4c2a";
      ctx.fillRect(ox, oy + 1, 16, 2); ctx.fillRect(ox, oy + 13, 16, 2);
      ctx.fillRect(ox, oy, 16, 1); ctx.fillRect(ox, oy + 15, 16, 1);
      ctx.fillRect(ox, oy, 1, 16); ctx.fillRect(ox + 15, oy, 1, 16);
      ctx.fillStyle = "#3d2c16";
      ctx.fillRect(ox + 7, oy + 6, 2, 3);
    });

    // 灯（物品栏图标）：深色灯笼立面
    const tLamp = R.allocTile(function (ctx, ox, oy) {
      ctx.fillStyle = "#4a3420"; ctx.fillRect(ox, oy, 16, 16);
      // 顶盖与底盖
      ctx.fillStyle = "#3e2a18";
      ctx.fillRect(ox + 1, oy + 1, 14, 2); ctx.fillRect(ox + 1, oy + 13, 14, 2);
      // 竖框
      ctx.fillRect(ox + 1, oy + 1, 2, 14); ctx.fillRect(ox + 13, oy + 1, 2, 14);
      // 横木条
      ctx.fillRect(ox + 3, oy + 7, 10, 1);
      // 铆钉
      ctx.fillStyle = "#2e2010";
      [[2, 2], [13, 2], [2, 13], [13, 13], [7, 7], [8, 7]].forEach(function (p) {
        ctx.fillRect(ox + p[0], oy + p[1], 1, 1);
      });
      // 中心暖色
      ctx.fillStyle = "#f0b840"; ctx.fillRect(ox + 4, oy + 4, 8, 8);
      ctx.fillStyle = "#ffe060"; ctx.fillRect(ox + 5, oy + 5, 6, 6);
      ctx.fillStyle = "#fff8d0"; ctx.fillRect(ox + 7, oy + 7, 2, 2);
    });

    // 灯笼框架（立柱/盖）：深棕木框 + 铆钉 + 竖向纹理
    const tLampFrame = R.allocTile(function (ctx, ox, oy) {
      ctx.fillStyle = "#4a3420"; ctx.fillRect(ox, oy, 16, 16);
      // 竖向拉丝
      ctx.fillStyle = "#3e2a18";
      [2, 5, 8, 11, 14].forEach(function (sx) { ctx.fillRect(ox + sx, oy, 1, 16); });
      // 深色边框
      ctx.fillStyle = "#2e2010";
      [[0, 0], [15, 0], [0, 15], [15, 15], [7, 0], [8, 0], [7, 15], [8, 15]].forEach(function (p) {
        ctx.fillRect(ox + p[0], oy + p[1], 1, 1);
      });
    });

    // 灯笼灯芯：暖色径向渐变，中心白亮，四边暗衬，带竖向火焰纹
    const tLampGlow = R.allocTile(function (ctx, ox, oy) {
      // 外圈暗衬
      ctx.fillStyle = "#c47a18"; ctx.fillRect(ox, oy, 16, 16);
      ctx.fillStyle = "#d48c20"; ctx.fillRect(ox + 1, oy + 1, 14, 14);
      ctx.fillStyle = "#e8a830"; ctx.fillRect(ox + 2, oy + 2, 12, 12);
      ctx.fillStyle = "#f5c040"; ctx.fillRect(ox + 3, oy + 3, 10, 10);
      ctx.fillStyle = "#ffe060"; ctx.fillRect(ox + 5, oy + 5, 6, 6);
      ctx.fillStyle = "#fff8d0"; ctx.fillRect(ox + 6, oy + 6, 4, 4);
      // 竖向火焰芯
      ctx.fillStyle = "#fffce8";
      ctx.fillRect(ox + 7, oy + 3, 2, 10);
    });

    // 红毯子（床尾盖毯）
    const tRed = R.allocTile(function (ctx, ox, oy) {
      ctx.fillStyle = "#c23a3a"; ctx.fillRect(ox, oy, 16, 16);
      ctx.fillStyle = "#b03232";
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          if ((x + y) % 2 === 0) ctx.fillRect(ox + x, oy + y, 1, 1);
        }
      }
    });

    /* ============================================================
     * 台阶（半砖）：只有下半格，可直接走上
     * ============================================================ */
    const slab = R.block({ name: "木台阶", tiles: PLANKS, dig: [1.5], opaque: false });
    R.customMeshes[slab] = function (api) {
      api.box(0, 0, 0, 1, 0.5, 1, PLANKS);
    };
    R.collisionBoxes[slab] = [[0, 0, 0, 1, 0.5, 1]];

    /* ============================================================
     * 楼梯：下半格 + 朝向侧的上半格，4 个朝向各一个 ID
     * ============================================================ */
    function stairDef(drop) {
      const def = { name: "木楼梯", tiles: PLANKS, dig: [1.8], opaque: false };
      if (drop) def.drop = drop;
      return R.block(def);
    }
    const stairN = stairDef(null);               // 高半格在 -z 侧（基准ID，物品栏持有它）
    const stairS = stairDef(stairN);
    const stairE = stairDef(stairN);
    const stairW = stairDef(stairN);
    // boxes: [底半格] + [高半格]（高半格 = 上行方向的远侧）
    const STAIR_SHAPE = {
      N: [[0, 0, 0, 1, 0.5, 1], [0, 0.5, 0, 1, 1, 0.5]],
      S: [[0, 0, 0, 1, 0.5, 1], [0, 0.5, 0.5, 1, 1, 1]],
      E: [[0, 0, 0, 1, 0.5, 1], [0.5, 0.5, 0, 1, 1, 1]],
      W: [[0, 0, 0, 1, 0.5, 1], [0, 0.5, 0, 0.5, 1, 1]]
    };
    function stairMesh(dir) {
      return function (api) {
        const b = STAIR_SHAPE[dir];
        api.box(b[0][0], b[0][1], b[0][2], b[0][3], b[0][4], b[0][5], PLANKS);
        api.box(b[1][0], b[1][1], b[1][2], b[1][3], b[1][4], b[1][5], PLANKS);
      };
    }
    R.customMeshes[stairN] = stairMesh("N"); R.collisionBoxes[stairN] = STAIR_SHAPE.N;
    R.customMeshes[stairS] = stairMesh("S"); R.collisionBoxes[stairS] = STAIR_SHAPE.S;
    R.customMeshes[stairE] = stairMesh("E"); R.collisionBoxes[stairE] = STAIR_SHAPE.E;
    R.customMeshes[stairW] = stairMesh("W"); R.collisionBoxes[stairW] = STAIR_SHAPE.W;

    // 按玩家朝向放置对应方向的楼梯
    function facingFromYaw(yaw) {
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      if (Math.abs(fx) > Math.abs(fz)) return fx > 0 ? "E" : "W";
      return fz > 0 ? "S" : "N";
    }
    const STAIR_BY_DIR = { N: stairN, S: stairS, E: stairE, W: stairW };
    R.placeHooks[stairN] = function (ctx) {
      const t = ctx.hit;
      const tx = t.x + t.nx, ty = t.y + t.ny, tz = t.z + t.nz;
      const w = ctx.world;
      if (!w.inBounds(tx, ty, tz)) return false;
      const cur = w.getBlock(tx, ty, tz);
      if (cur !== B.AIR && cur !== B.WATER) return false;
      w.setBlock(tx, ty, tz, STAIR_BY_DIR[facingFromYaw(ctx.yaw)]);
      ctx.remesh(tx, tz);
      ctx.consume();
      return true;
    };

    /* ============================================================
     * 木门：两格高，玻璃窗式薄板（0.125 厚居中，镂空纹理，可透视）。
     * 轴 X / 轴 Z × 开 / 关 × 上 / 下半 = 8 个 ID（顺序不变，兼容旧存档）
     * ============================================================ */
    function doorDef(solid, drop, tile) {
      const def = { name: "木门", tiles: tile, dig: [1.6], opaque: false };
      if (!solid) def.solid = false;
      if (drop !== undefined) def.drop = drop;
      return R.block(def);
    }
    const doorBX = doorDef(true, undefined, tDoorBtm);   // 基准ID（物品栏持有），关门、板面 ⊥x
    const doorBXO = doorDef(false, doorBX, tDoorBtm);    // 开门（板面贴 -z 边）
    const doorBZ = doorDef(true, doorBX, tDoorBtm);
    const doorBZO = doorDef(false, doorBX, tDoorBtm);
    const doorTX = doorDef(true, null, tDoorTop);        // 上半格：自身不掉落，由 breakHook 补掉门
    const doorTXO = doorDef(false, null, tDoorTop);
    const doorTZ = doorDef(true, null, tDoorTop);
    const doorTZO = doorDef(false, null, tDoorTop);

    const DOOR_BOX = {
      X:  [0.4375, 0, 0, 0.5625, 1, 1],   // 关：薄板居中，厚 0.125（同玻璃窗）
      XO: [0, 0, 0, 1, 1, 0.125],         // 开：门板折到 -z 边
      Z:  [0, 0, 0.4375, 1, 1, 0.5625],
      ZO: [0, 0, 0, 0.125, 1, 1]
    };
    const DOOR_IDS = {
      BX: doorBX, BXO: doorBXO, BZ: doorBZ, BZO: doorBZO,
      TX: doorTX, TXO: doorTXO, TZ: doorTZ, TZO: doorTZO
    };
    const DOOR_AXIS = {};                                  // id -> "X" | "Z"（整列联动判定用）
    Object.keys(DOOR_IDS).forEach(function (k) {
      const id = DOOR_IDS[k];
      const b = DOOR_BOX[k.slice(1)];
      const tile = k[0] === "T" ? tDoorTop : tDoorBtm;
      DOOR_AXIS[id] = k[1][0];
      R.collisionBoxes[id] = [b];
      R.customMeshes[id] = function (api) {
        api.cutoutBox(b[0], b[1], b[2], b[3], b[4], b[5], tile);
      };
    });
    // 开关联动：同格换态 + 同轴整列一起动（两扇门叠放也同步）
    const DOOR_TOGGLE = {};
    DOOR_TOGGLE[doorBX] = doorBXO; DOOR_TOGGLE[doorBXO] = doorBX;
    DOOR_TOGGLE[doorBZ] = doorBZO; DOOR_TOGGLE[doorBZO] = doorBZ;
    DOOR_TOGGLE[doorTX] = doorTXO; DOOR_TOGGLE[doorTXO] = doorTX;
    DOOR_TOGGLE[doorTZ] = doorTZO; DOOR_TOGGLE[doorTZO] = doorTZ;
    const DOOR_TOPS = [doorTX, doorTXO, doorTZ, doorTZO];
    const DOOR_BOTTOMS = [doorBX, doorBXO, doorBZ, doorBZO];
    function doorInteract(ctx) {
      const w = ctx.world, ax = DOOR_AXIS[ctx.id];
      const ys = [ctx.y];
      for (let y = ctx.y + 1; y < w.H && DOOR_AXIS[w.getBlock(ctx.x, y, ctx.z)] === ax; y++) ys.push(y);
      for (let y = ctx.y - 1; y >= 0 && DOOR_AXIS[w.getBlock(ctx.x, y, ctx.z)] === ax; y--) ys.push(y);
      ys.forEach(function (y) {
        w.setBlock(ctx.x, y, ctx.z, DOOR_TOGGLE[w.getBlock(ctx.x, y, ctx.z)]);
      });
      ctx.remesh(ctx.x, ctx.z);
      return true;
    }
    Object.keys(DOOR_IDS).forEach(function (k) {
      R.interactions[DOOR_IDS[k]] = doorInteract;
    });
    // 破坏连带：挖任一半，另一半一起消失；挖上半格时也正常掉门
    DOOR_BOTTOMS.forEach(function (id) {
      R.breakHooks[id] = function (ctx) {
        const w = ctx.world;
        if (DOOR_TOPS.indexOf(w.getBlock(ctx.x, ctx.y + 1, ctx.z)) >= 0) w.setBlock(ctx.x, ctx.y + 1, ctx.z, B.AIR);
        return null;
      };
    });
    DOOR_TOPS.forEach(function (id) {
      R.breakHooks[id] = function (ctx) {
        const w = ctx.world;
        if (DOOR_BOTTOMS.indexOf(w.getBlock(ctx.x, ctx.y - 1, ctx.z)) >= 0) w.setBlock(ctx.x, ctx.y - 1, ctx.z, B.AIR);
        return doorBX;
      };
    });
    // 放置：脚下实心 + 目标格与上一格都是空气；朝向按玩家视线（面朝东西 → 门板 ⊥x）
    R.placeHooks[doorBX] = function (ctx) {
      const t = ctx.hit;
      const tx = t.x + t.nx, ty = t.y + t.ny, tz = t.z + t.nz;
      const w = ctx.world;
      if (!w.inBounds(tx, ty + 1, tz)) return false;
      if (w.getBlock(tx, ty, tz) !== B.AIR || w.getBlock(tx, ty + 1, tz) !== B.AIR) return false;
      if (!window.isSolid(w.getBlock(tx, ty - 1, tz))) return false;
      const fx = -Math.sin(ctx.yaw), fz = -Math.cos(ctx.yaw);
      const alongX = Math.abs(fx) > Math.abs(fz);
      w.setBlock(tx, ty, tz, alongX ? doorBX : doorBZ);
      w.setBlock(tx, ty + 1, tz, alongX ? doorTX : doorTZ);
      ctx.remesh(tx, tz);
      ctx.consume();
      return true;
    };

    /* ============================================================
     * 活板门：关闭 = 贴地薄板（可踩）；打开 = 贴玩家近侧的竖板
     * ============================================================ */
    function trapDef(solid, drop) {
      const def = { name: "活板门", tiles: tTrap, dig: [1.5], opaque: false };
      if (!solid) def.solid = false;
      if (drop !== undefined) def.drop = drop;
      return R.block(def);
    }
    const trap = R.block({ name: "活板门", tiles: tTrap, dig: [1.5], opaque: false });
    const trapN = trapDef(false, trap);   // 打开，板贴 -z 边
    const trapS = trapDef(false, trap);
    const trapE = trapDef(false, trap);
    const trapW = trapDef(false, trap);
    const TRAP_BOX = {
      closed: [0, 0, 0, 1, 0.1875, 1],
      N: [0, 0, 0, 1, 1, 0.1875],
      S: [0, 0, 0.8125, 1, 1, 1],
      E: [0.8125, 0, 0, 1, 1, 1],
      W: [0, 0, 0, 0.1875, 1, 1]
    };
    const TRAP_IDS = { closed: trap, N: trapN, S: trapS, E: trapE, W: trapW };
    Object.keys(TRAP_IDS).forEach(function (k) {
      const id = TRAP_IDS[k], b = TRAP_BOX[k];
      R.collisionBoxes[id] = [b];
      R.customMeshes[id] = function (api) {
        api.box(b[0], b[1], b[2], b[3], b[4], b[5], tTrap);
      };
    });
    R.interactions[trap] = function (ctx) {
      // 打开：板倒向玩家近侧（玩家面朝 -z，则板贴 +z 边）
      const fx = -Math.sin(ctx.yaw), fz = -Math.cos(ctx.yaw);
      let id;
      if (Math.abs(fx) > Math.abs(fz)) id = fx > 0 ? trapW : trapE;
      else id = fz > 0 ? trapN : trapS;
      ctx.world.setBlock(ctx.x, ctx.y, ctx.z, id);
      ctx.remesh(ctx.x, ctx.z);
      return true;
    };
    [trapN, trapS, trapE, trapW].forEach(function (id) {
      R.interactions[id] = function (ctx) {
        ctx.world.setBlock(ctx.x, ctx.y, ctx.z, trap);
        ctx.remesh(ctx.x, ctx.z);
        return true;
      };
    });

    /* ============================================================
     * 床：木架 + 白床垫 + 红毯子 + 枕头；右键夜晚睡觉跳到日出
     * ============================================================ */
    const bed = R.block({ name: "床", tiles: tRed, dig: [0.8], solid: false, opaque: false });
    R.customMeshes[bed] = function (api) {
      api.box(0, 0, 0, 1, 0.25, 1, PLANKS);                  // 床架
      api.box(0.04, 0.25, 0.04, 0.96, 0.5, 0.96, SNOW);      // 床垫
      api.box(0.04, 0.5, 0.38, 0.96, 0.6, 0.96, tRed);       // 红毯子（床尾）
      api.box(0.16, 0.5, 0.08, 0.84, 0.64, 0.34, SNOW);      // 枕头（床头）
    };
    R.collisionBoxes[bed] = [[0, 0, 0, 1, 0.5625, 1]];
    R.interactions[bed] = function (ctx) {
      ctx.sleep();      // sleep 内部判断昼夜并提示
      return true;
    };
    // 床需要放在实心方块顶面上
    R.placeHooks[bed] = function (ctx) {
      const t = ctx.hit;
      const tx = t.x + t.nx, ty = t.y + t.ny, tz = t.z + t.nz;
      const w = ctx.world;
      if (!w.inBounds(tx, ty, tz)) return false;
      if (w.getBlock(tx, ty, tz) !== B.AIR) return false;
      if (!window.isSolid(w.getBlock(tx, ty - 1, tz))) return false;
      w.setBlock(tx, ty, tz, bed);
      ctx.remesh(tx, tz);
      ctx.consume();
      return true;
    };

    /* ============================================================
     * 白桦木压力板：1/16 格厚薄板，贴地放置，只能放在实心方块顶面。
     * 世界模型与图标均用白桦木板纹理（薄板侧面只采样纹理底行暗色
     * 板缝，自然形成图中深色裙边）；物品栏另有等距立体图标。
     * ============================================================ */
    const birchPlate = R.block({
      name: "白桦木压力板",
      tiles: tBirchPlanks,
      dig: [0.5],
      opaque: false
    });
    R.customMeshes[birchPlate] = function (api) {
      api.box(0, 0, 0, 1, 0.0625, 1, tBirchPlanks);   // 1/16 格高薄板
    };
    R.collisionBoxes[birchPlate] = [[0, 0, 0, 1, 0.0625, 1]];
    // 只能放在实心方块顶面上（与床同理）
    R.placeHooks[birchPlate] = function (ctx) {
      const t = ctx.hit;
      const tx = t.x + t.nx, ty = t.y + t.ny, tz = t.z + t.nz;
      const w = ctx.world;
      if (!w.inBounds(tx, ty, tz)) return false;
      if (w.getBlock(tx, ty, tz) !== B.AIR) return false;
      if (!window.isSolid(w.getBlock(tx, ty - 1, tz))) return false;
      w.setBlock(tx, ty, tz, birchPlate);
      ctx.remesh(tx, tz);
      ctx.consume();
      return true;
    };

    /* ============================================================
     * 玻璃窗：0.125 厚居中薄板（比整格镂空更薄更好看）；
     * 上下叠放同轴窗自动拼成一扇通高竖窗（接缝木框消隐）；
     * 右键开/关，整列联动。
     * 存档兼容：基准ID必须保持在原位（旧档里已存的窗户是它），
     * ⊥z 关 / 开×2 三个状态在文件后部（围栏之后）追加分配。
     * ============================================================ */
    const win = R.block({ name: "玻璃窗", tiles: tWindow, dig: [0.6], opaque: false });
    const WIN_BOX = {
      X:  [0.4375, 0, 0, 0.5625, 1, 1],   // 关：薄板居中，厚 0.125
      Z:  [0, 0, 0.4375, 1, 1, 0.5625],
      XO: [0, 0, 0, 1, 1, 0.125],         // 开：板折到 -z 边
      ZO: [0, 0, 0, 0.125, 1, 1]          // 开：板折到 -x 边
    };
    const WIN_AXIS = {};   WIN_AXIS[win] = "X";      // 各状态所属轴（扩展段补全）
    const WIN_CLOSED = {}; WIN_CLOSED[win] = "X";    // 关着的同轴窗（拼接判定用）
    const WIN_TOGGLE = {};                           // 开关联动表（扩展段补全）

    // 关着的同轴窗上下相接时选用无框纹理，拼成一扇通高竖窗
    function winMeshClosed(axis) {
      return function (api) {
        const w = api.world;
        const up = WIN_CLOSED[w.getBlock(api.x, api.y + 1, api.z)] === axis;
        const dn = WIN_CLOSED[w.getBlock(api.x, api.y - 1, api.z)] === axis;
        const tile = up ? (dn ? tWinMid : tWinNoTop) : (dn ? tWinNoBtm : tWindow);
        const b = WIN_BOX[axis];
        api.cutoutBox(b[0], b[1], b[2], b[3], b[4], b[5], tile);
      };
    }
    R.customMeshes[win] = winMeshClosed("X");
    R.collisionBoxes[win] = [WIN_BOX.X];

    // 右键开/关：同轴连续的一整列一起动（竖窗两半同步）
    function winInteract(ctx) {
      const w = ctx.world, ax = WIN_AXIS[ctx.id];
      const ys = [ctx.y];
      for (let y = ctx.y + 1; y < w.H && WIN_AXIS[w.getBlock(ctx.x, y, ctx.z)] === ax; y++) ys.push(y);
      for (let y = ctx.y - 1; y >= 0 && WIN_AXIS[w.getBlock(ctx.x, y, ctx.z)] === ax; y--) ys.push(y);
      ys.forEach(function (y) {
        const id = w.getBlock(ctx.x, y, ctx.z);
        w.setBlock(ctx.x, y, ctx.z, WIN_TOGGLE[id]);
      });
      ctx.remesh(ctx.x, ctx.z);
      return true;
    }
    R.interactions[win] = winInteract;

    /* ============================================================
     * 灯（灯笼造型）：青铜底座 + 顶盖 + 四角立柱 + 自发光灯芯；
     * 点光源比火把更亮、不闪烁
     * ============================================================ */
    const lamp = R.block({ name: "灯", tiles: tLamp, dig: [1.5], opaque: false });
    R.customMeshes[lamp] = function (api) {
      const F = tLampFrame, G = tLampGlow;
      // 底座 / 顶盖（铺满纹理）
      api.box(0.26, 0, 0.26, 0.74, 0.09, 0.74, F, true);
      api.box(0.26, 0.86, 0.26, 0.74, 0.95, 0.74, F, true);
      api.box(0.44, 0.95, 0.44, 0.56, 0.98, 0.56, F, true);   // 顶钮
      // 四角立柱（fit=true 让细柱每面都显示完整木纹）
      const p = 0.28, w = 0.075, lo = 0.09, hi = 0.86;
      [[p, p], [p, 1 - p - w], [1 - p - w, p], [1 - p - w, 1 - p - w]].forEach(function (c) {
        api.box(c[0], lo, c[1], c[0] + w, hi, c[1] + w, F, true);
      });
      // 灯芯（自发光、铺满渐变，夜晚如小灯笼）
      api.unlitBox(0.33, lo, 0.33, 0.67, hi, 0.67, G, true);
    };
    R.lightBlocks[lamp] = { color: 0xffe2a0, intensity: 3.4, dist: 16, oy: 0.47, flicker: false };

    /* ============================================================
     * 木栅门（桦木）：关上 = 两端立柱 + 双横杆，封住围栏缺口
     * （碰撞 1.5 格高，人和动物都跳不过）；右键开门时两扇门板绕柱
     * 甩向来路两侧，正中央留出 0.625 宽通道。
     * 横杆沿 x / 沿 z × 关 / 开（两个摆向）= 6 个状态 ID。
     * ============================================================ */
    // 桦木板材纹理：浅米白板面 + 横向板缝 + 细木纹（与白皮桦木同色系）
    const tGate = R.allocTile(function (ctx, ox, oy) {
      ctx.fillStyle = "#ddd9c6";
      ctx.fillRect(ox, oy, 16, 16);
      for (let yy = 0; yy < 16; yy++) {
        for (let xx = 0; xx < 16; xx++) {
          if ((xx * 3 + yy * 7) % 10 === 0) ctx.fillStyle = "#d2ceba";
          else if ((xx * 5 + yy * 3) % 13 === 0) ctx.fillStyle = "#e9e5d3";
          else continue;
          ctx.fillRect(ox + xx, oy + yy, 1, 1);
        }
      }
      ctx.fillStyle = "#bbb6a2";                              // 横向板缝
      [3, 7, 11].forEach(function (sy) { ctx.fillRect(ox, oy + sy, 16, 1); });
      ctx.fillStyle = "#a8a38e";                              // 错位钉点
      [[2, 1], [13, 5], [6, 9], [12, 13]].forEach(function (p) {
        ctx.fillRect(ox + p[0], oy + p[1], 1, 1);
      });
    });

    // 6 个状态 ID 必须在本 mod 末尾才分配（见文件尾部 registerGate 调用）：
    // 追加在灯/围栏/玻璃窗变体之后，旧存档中既有方块 ID 才不会漂移。
    let gateCX, gateCZ, gateXN, gateXS, gateZW, gateZE;
    const GATE_ALL = [];
    const GATE_RAIL_Y1 = [0.28, 0.42], GATE_RAIL_Y2 = [0.62, 0.76];

    // 栅门的网格 / 碰撞 / 交互 / 放置在 ID 分配后一次性注册
    function registerGate() {
      function gateDef(solid, drop) {
        const def = { name: "木栅门", tiles: tGate, dig: [1.5], opaque: false };
        if (!solid) def.solid = false;
        if (drop !== undefined) def.drop = drop;
        return R.block(def);
      }
      gateCX = gateDef(true);              // 关：横杆沿 x（挡 z 向通行，基准ID，物品栏持有）
      gateCZ = gateDef(true, gateCX);       // 关：横杆沿 z
      gateXN = gateDef(false, gateCX);      // 开：两扇甩向 -z
      gateXS = gateDef(false, gateCX);      // 开：两扇甩向 +z
      gateZW = gateDef(false, gateCX);      // 开：两扇甩向 -x
      gateZE = gateDef(false, gateCX);      // 开：两扇甩向 +x
      GATE_ALL.push(gateCX, gateCZ, gateXN, gateXS, gateZW, gateZE);

      // 横杆高度与围栏双横栏一致，相邻时横栏正好对齐
      R.customMeshes[gateCX] = function (api) {
        api.box(0, 0, 0.375, 0.1875, 1, 0.625, tGate);        // 两端立柱
        api.box(0.8125, 0, 0.375, 1, 1, 0.625, tGate);
        api.box(0, GATE_RAIL_Y1[0], 0.4375, 1, GATE_RAIL_Y1[1], 0.5625, tGate);
        api.box(0, GATE_RAIL_Y2[0], 0.4375, 1, GATE_RAIL_Y2[1], 0.5625, tGate);
      };
      R.customMeshes[gateCZ] = function (api) {
        api.box(0.375, 0, 0, 0.625, 1, 0.1875, tGate);
        api.box(0.375, 0, 0.8125, 0.625, 1, 1, tGate);
        api.box(0.4375, GATE_RAIL_Y1[0], 0, 0.5625, GATE_RAIL_Y1[1], 1, tGate);
        api.box(0.4375, GATE_RAIL_Y2[0], 0, 0.5625, GATE_RAIL_Y2[1], 1, tGate);
      };
      // 开门四态：每扇 = 甩到远端的立柱 + 两条横杆（各占半格）
      R.customMeshes[gateXN] = function (api) {
        api.box(0, 0, 0, 0.1875, 1, 0.1875, tGate);
        api.box(0.8125, 0, 0, 1, 1, 0.1875, tGate);
        api.box(0, GATE_RAIL_Y1[0], 0, 0.1875, GATE_RAIL_Y1[1], 0.5, tGate);
        api.box(0, GATE_RAIL_Y2[0], 0, 0.1875, GATE_RAIL_Y2[1], 0.5, tGate);
        api.box(0.8125, GATE_RAIL_Y1[0], 0, 1, GATE_RAIL_Y1[1], 0.5, tGate);
        api.box(0.8125, GATE_RAIL_Y2[0], 0, 1, GATE_RAIL_Y2[1], 0.5, tGate);
      };
      R.customMeshes[gateXS] = function (api) {
        api.box(0, 0, 0.8125, 0.1875, 1, 1, tGate);
        api.box(0.8125, 0, 0.8125, 1, 1, 1, tGate);
        api.box(0, GATE_RAIL_Y1[0], 0.5, 0.1875, GATE_RAIL_Y1[1], 1, tGate);
        api.box(0, GATE_RAIL_Y2[0], 0.5, 0.1875, GATE_RAIL_Y2[1], 1, tGate);
        api.box(0.8125, GATE_RAIL_Y1[0], 0.5, 1, GATE_RAIL_Y1[1], 1, tGate);
        api.box(0.8125, GATE_RAIL_Y2[0], 0.5, 1, GATE_RAIL_Y2[1], 1, tGate);
      };
      R.customMeshes[gateZW] = function (api) {
        api.box(0, 0, 0, 0.1875, 1, 0.1875, tGate);
        api.box(0, 0, 0.8125, 0.1875, 1, 1, tGate);
        api.box(0, GATE_RAIL_Y1[0], 0, 0.5, GATE_RAIL_Y1[1], 0.1875, tGate);
        api.box(0, GATE_RAIL_Y2[0], 0, 0.5, GATE_RAIL_Y2[1], 0.1875, tGate);
        api.box(0, GATE_RAIL_Y1[0], 0.8125, 0.5, GATE_RAIL_Y1[1], 1, tGate);
        api.box(0, GATE_RAIL_Y2[0], 0.8125, 0.5, GATE_RAIL_Y2[1], 1, tGate);
      };
      R.customMeshes[gateZE] = function (api) {
        api.box(0.8125, 0, 0, 1, 1, 0.1875, tGate);
        api.box(0.8125, 0, 0.8125, 1, 1, 1, tGate);
        api.box(0.5, GATE_RAIL_Y1[0], 0, 1, GATE_RAIL_Y1[1], 0.1875, tGate);
        api.box(0.5, GATE_RAIL_Y2[0], 0, 1, GATE_RAIL_Y2[1], 0.1875, tGate);
        api.box(0.5, GATE_RAIL_Y1[0], 0.8125, 1, GATE_RAIL_Y1[1], 1, tGate);
        api.box(0.5, GATE_RAIL_Y2[0], 0.8125, 1, GATE_RAIL_Y2[1], 1, tGate);
      };
      // 碰撞：关 = 与围栏同高的薄挡板；开 = 两侧门板，中央通道净宽 0.625
      R.collisionBoxes[gateCX] = [[0, 0, 0.375, 1, 1.5, 0.625]];
      R.collisionBoxes[gateCZ] = [[0.375, 0, 0, 0.625, 1.5, 1]];
      R.collisionBoxes[gateXN] = [[0, 0, 0, 0.1875, 1, 0.5], [0.8125, 0, 0, 1, 1, 0.5]];
      R.collisionBoxes[gateXS] = [[0, 0, 0.5, 0.1875, 1, 1], [0.8125, 0, 0.5, 1, 1, 1]];
      R.collisionBoxes[gateZW] = [[0, 0, 0, 0.5, 1, 0.1875], [0, 0, 0.8125, 0.5, 1, 1]];
      R.collisionBoxes[gateZE] = [[0.5, 0, 0, 1, 1, 0.1875], [0.5, 0, 0.8125, 1, 1, 1]];
      // 右键开关：开门方向与活板门一致——门板甩到视线去向的反侧
      function gateInteract(ctx) {
        const id = ctx.id;
        let next;
        if (id === gateCX) {
          next = (-Math.cos(ctx.yaw)) >= 0 ? gateXN : gateXS;
        } else if (id === gateCZ) {
          next = (-Math.sin(ctx.yaw)) >= 0 ? gateZW : gateZE;
        } else if (id === gateXN || id === gateXS) {
          next = gateCX;
        } else {
          next = gateCZ;
        }
        ctx.world.setBlock(ctx.x, ctx.y, ctx.z, next);
        ctx.remesh(ctx.x, ctx.z);
        return true;
      }
      GATE_ALL.forEach(function (id) { R.interactions[id] = gateInteract; });
      // 放置：需落在实心方块顶上；优先与相邻围栏 / 栅门同轴，否则按视线定向
      R.placeHooks[gateCX] = function (ctx) {
        const t = ctx.hit;
        const tx = t.x + t.nx, ty = t.y + t.ny, tz = t.z + t.nz;
        const w = ctx.world;
        if (!w.inBounds(tx, ty, tz)) return false;
        const cur = w.getBlock(tx, ty, tz);
        if (cur !== B.AIR && cur !== B.WATER) return false;
        if (!window.isSolid(w.getBlock(tx, ty - 1, tz))) return false;
        const alongX = function (id) { return id === fence || id === gateCX; };
        const alongZ = function (id) { return id === fence || id === gateCZ; };
        const ax = alongX(w.getBlock(tx - 1, ty, tz)) || alongX(w.getBlock(tx + 1, ty, tz));
        const az = alongZ(w.getBlock(tx, ty, tz - 1)) || alongZ(w.getBlock(tx, ty, tz + 1));
        let axis;
        if (ax && !az) axis = "X";
        else if (az && !ax) axis = "Z";
        else {
          const fx = -Math.sin(ctx.yaw), fz = -Math.cos(ctx.yaw);
          axis = Math.abs(fx) > Math.abs(fz) ? "Z" : "X";
        }
        w.setBlock(tx, ty, tz, axis === "X" ? gateCX : gateCZ);
        ctx.remesh(tx, tz);
        ctx.consume();
        return true;
      };
      // 桦木原木 + 木棍：棍 / 桦 / 棍 两行（工作台 3×2）
      R.registerRecipe([[S, BL, S], [S, BL, S]], gateCX, 1);
    }

    /* ============================================================
     * 围栏：中心柱 + 朝邻居（围栏 / 木栅门 / 实心方块）延伸的双横栏；
     * 碰撞盒 1.5 格高，人和动物都跳不过去
     * ============================================================ */
    const fence = R.block({ name: "围栏", tiles: PLANKS, dig: [1.8], opaque: false });
    R.customMeshes[fence] = function (api) {
      api.box(0.375, 0, 0.375, 0.625, 1, 0.625, PLANKS);   // 中心柱
      const w = api.world;
      // 横栏只连向关闭且同轴的栅门（开门后横栏不应伸出）
      const connect = function (dx, dz) {
        const nid = w.getBlock(api.x + dx, api.y, api.z + dz);
        return nid === fence || nid === (dz === 0 ? gateCX : gateCZ) ||
               (window.isSolid(nid) && window.isOpaque(nid));
      };
      // 双横栏：y 0.28..0.42 / 0.62..0.76，厚 0.125
      if (connect(1, 0)) {
        api.box(0.625, 0.28, 0.4375, 1, 0.42, 0.5625, PLANKS);
        api.box(0.625, 0.62, 0.4375, 1, 0.76, 0.5625, PLANKS);
      }
      if (connect(-1, 0)) {
        api.box(0, 0.28, 0.4375, 0.375, 0.42, 0.5625, PLANKS);
        api.box(0, 0.62, 0.4375, 0.375, 0.76, 0.5625, PLANKS);
      }
      if (connect(0, 1)) {
        api.box(0.4375, 0.28, 0.625, 0.5625, 0.42, 1, PLANKS);
        api.box(0.4375, 0.62, 0.625, 0.5625, 0.76, 1, PLANKS);
      }
      if (connect(0, -1)) {
        api.box(0.4375, 0.28, 0, 0.5625, 0.42, 0.375, PLANKS);
        api.box(0.4375, 0.62, 0, 0.5625, 0.76, 0.375, PLANKS);
      }
    };
    R.collisionBoxes[fence] = [[0, 0, 0, 1, 1.5, 1]];

    /* ============================================================
     * 玻璃窗扩展状态（追加分配在末尾，保证旧存档里灯/围栏 id 不漂移）：
     * ⊥z 关窗 + 两轴开窗；放置时按所贴墙面/视线选轴
     * ============================================================ */
    function winVarDef(solid) {
      const def = { name: "玻璃窗", tiles: tWindow, dig: [0.6], opaque: false, drop: win };
      if (!solid) def.solid = false;
      return R.block(def);
    }
    const winZ = winVarDef(true);           // 关、板面 ⊥z
    const winXO = winVarDef(false);         // 开：板折到 -z 边
    const winZO = winVarDef(false);         // 开：板折到 -x 边
    WIN_AXIS[winZ] = "Z"; WIN_AXIS[winXO] = "X"; WIN_AXIS[winZO] = "Z";
    WIN_CLOSED[winZ] = "Z";
    WIN_TOGGLE[win] = winXO; WIN_TOGGLE[winXO] = win;
    WIN_TOGGLE[winZ] = winZO; WIN_TOGGLE[winZO] = winZ;
    R.customMeshes[winZ] = winMeshClosed("Z");
    R.customMeshes[winXO] = function (api) {
      const b = WIN_BOX.XO; api.cutoutBox(b[0], b[1], b[2], b[3], b[4], b[5], tWindow);
    };
    R.customMeshes[winZO] = function (api) {
      const b = WIN_BOX.ZO; api.cutoutBox(b[0], b[1], b[2], b[3], b[4], b[5], tWindow);
    };
    R.collisionBoxes[winZ] = [WIN_BOX.Z];
    R.collisionBoxes[winXO] = [WIN_BOX.XO];
    R.collisionBoxes[winZO] = [WIN_BOX.ZO];
    [winZ, winXO, winZO].forEach(function (id) { R.interactions[id] = winInteract; });
    // 放置选轴（优先级）：
    //  1) 嵌在墙洞里：排除被点击的靠背方块后，x 两侧有实心墙垛 → 墙沿 x 走 → 板面 ⊥z；
    //     z 两侧有实心 → ⊥x
    //  2) 贴在墙面上：板面与所贴墙面平行（点 ±x 面 → ⊥x，点 ±z 面 → ⊥z）
    //  3) 兜底按玩家视线方向（与门一致）
    R.placeHooks[win] = function (ctx) {
      const t = ctx.hit;
      const tx = t.x + t.nx, ty = t.y + t.ny, tz = t.z + t.nz;
      const w = ctx.world;
      if (!w.inBounds(tx, ty, tz)) return false;
      const cur = w.getBlock(tx, ty, tz);
      if (cur !== B.AIR && cur !== B.WATER) return false;
      const solidAt = function (x, z) {
        if (x === t.x && z === t.z) return false;   // 靠背方块不算墙垛
        return window.isSolid(w.getBlock(x, ty, z));
      };
      const sx = solidAt(tx - 1, tz) || solidAt(tx + 1, tz);
      const sz = solidAt(tx, tz - 1) || solidAt(tx, tz + 1);
      let ax;
      if (sx && !sz) ax = "Z";
      else if (sz && !sx) ax = "X";
      else if (t.nx !== 0) ax = "X";
      else if (t.nz !== 0) ax = "Z";
      else {
        const fx = -Math.sin(ctx.yaw), fz = -Math.cos(ctx.yaw);
        ax = Math.abs(fx) > Math.abs(fz) ? "X" : "Z";
      }
      w.setBlock(tx, ty, tz, ax === "X" ? win : winZ);
      ctx.remesh(tx, tz);
      ctx.consume();
      return true;
    };

    /* ============================================================
     * 合成配方
     * ============================================================ */
    const P = B.PLANKS;
    R.registerRecipe([[P, P, P]], slab, 6);                          // 台阶 ×6
    R.registerRecipe([[P, 0, 0], [P, P, 0], [P, P, P]], stairN, 4);  // 楼梯 ×4
    R.registerRecipe([[P, P], [P, P], [P, P]], doorBX, 1);           // 木门
    R.registerRecipe([[0, S, 0], [S, 0, S], [0, S, 0]], win, 2);     // 玻璃窗 ×2
    R.registerRecipe([[P, P, P], [P, P, P]], trap, 2);               // 活板门 ×2
    R.registerRecipe([[W, W, W], [P, P, P]], bed, 1);                // 床
    R.registerRecipe([[0, P, 0], [P, B.TORCH, P], [0, P, 0]], lamp, 1); // 灯
    R.registerRecipe([[P, S, P], [P, S, P]], fence, 3);              // 围栏 ×3

    // 木栅门 6 个状态 ID 最后分配，保证灯 / 围栏 / 玻璃窗变体的旧存档 ID 不漂移
    registerGate();

    /* ============================================================
     * 白桦木板：白桦原木的下游基础材料（最后分配，旧存档 ID 不漂移）。
     * ============================================================ */
    const birchPlanks = R.block({
      name: "白桦木板",
      tiles: tBirchPlanks,
      dig: [1.8]          // 与内置木板同档徒手耗时
    });
    R.axeDig[birchPlanks] = 0.3;          // 同内置木板的斧速
    R.axeDig[birchPlate] = 0.3;
    R.registerFuel(birchPlanks, 1);       // 木板可当燃料
    R.particleColors[birchPlanks] = 0xb09d6e;
    R.particleColors[birchPlate] = 0xb09d6e;
    R.blockIconSrc[birchPlanks] = "assets/birch-planks-icon.png?v=20261012a";
    R.blockIconSrc[birchPlate] = "assets/birch-plate-icon.png?v=20261012a";
    // 白桦原木 → 白桦木板 ×4（对应内置原木→木板链）
    R.registerRecipe([[BL]], birchPlanks, 4);
    // 两块白桦木板横排 → 白桦木压力板
    R.registerRecipe([[birchPlanks, birchPlanks]], birchPlate, 1);

    // 调试钩子：控制台 FurnitureMod.door / .bed / .lamp ... 取用 id
    window.FurnitureMod = {
      slab: slab, stair: stairN, door: doorBX, trap: trap,
      bed: bed, window: win, windowZ: winZ, windowOpen: winXO, windowOpenZ: winZO,
      lamp: lamp, fence: fence, gate: gateCX, plate: birchPlate,
      birchPlanks: birchPlanks
    };
  });
})();
