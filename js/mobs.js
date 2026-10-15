/* ============================================================
 * mobs.js — 动物：猪 / 狗 / 牛 / 羊
 *
 * 像素方块风：所有动物都由 1x1x1 单位立方体缩放拼成，几何体
 * 全局共享，材质按颜色复用，控制 draw call 与内存。
 *
 * 行为系统（FSM 优先级：骑乘 > 坐下 > 战斗追击 > 逃跑 >
 *           愤怒反击 > 跟随主人 > 游荡）：
 *   - 游荡 / 发呆 / 重力 / 方块碰撞 / 走路动画（原版保留）
 *   - 血量、受击无敌帧、击退、死亡掉落物（可被吸入背包）
 *   - 喂生肉驯服：驯服后跟随主人；狗还能坐下 / 协攻 / 护主
 *   - 猪 / 羊被打会逃；牛 / 野狗被打会愤怒反击玩家
 *   - 驯服的猪可以骑：WASD 转向、空格跳跃、Shift 下猪
 * ============================================================ */
(function (global) {
  "use strict";

  const GEO = new THREE.BoxGeometry(1, 1, 1);
  const matCache = {};
  function mat(color) {
    if (!matCache[color]) {
      matCache[color] = new THREE.MeshLambertMaterial({ color: color });
    }
    return matCache[color];
  }

  // 麦子（农耕 mod 动态物品 id，mobs.js 在 farming_mod.js 之后加载）；
  // 牛 / 羊吃麦子繁殖，不吃生肉
  function wheatId() { return global.FarmingMod ? global.FarmingMod.wheat : -1; }
  // 竹子 / 竹笋（竹林 mod 动态 id）：熊猫的食物，手持还会吸引熊猫靠近
  function isPandaFood(id) {
    return !!global.BambooMod &&
           (id === global.BambooMod.bamboo || id === global.BambooMod.shoot);
  }

  // 繁殖参数
  const BREEDABLE = { cow: true, sheep: true, panda: true };  // 牛/羊吃麦子，熊猫吃竹子
  function isBreedable(type) { return !!BREEDABLE[type]; }
  // 各动物繁殖 / 催长所用的食物 id
  function breedFoodId(type) { return type === "panda" && global.BambooMod ? global.BambooMod.bamboo : wheatId(); }
  function breedFoodName(type) { return type === "panda" ? "竹子" : "麦子"; }
  const LOVE_TIME = 30;        // 恋爱模式持续秒数（期间寻找同伴）
  const BREED_TIME = 2.4;      // 配对后走向彼此到生下幼崽的秒数
  const BREED_COOLDOWN = 120;  // 繁殖后再次可喂食的冷却
  const BREED_RANGE = 4.5;     // 两只恋爱动物的配对距离
  const GROW_TIME = 180;       // 幼崽长到成年的秒数
  const BABY_SCALE = 0.5;      // 幼崽模型 / 碰撞缩放
  const LAMB_HEAD_SCALE = 1.8; // 幼羊头部相对身体的放大倍数（原版幼崽大头比例）
  const CALF_HEAD_SCALE = 1.55; // 幼牛头部相对身体的放大倍数（原版幼崽大头比例）
  const PIGLET_HEAD_SCALE = 1.85; // 幼猪头部相对身体的放大倍数（原版幼崽大头比例）
  const PANDA_CUB_HEAD_SCALE = 1.5; // 幼熊猫头部相对身体的放大倍数
  const PUPPY_HEAD_SCALE = 2.0;   // 幼狼头部相对身体的放大倍数（原版幼狼头=成体大小，整体 .5）
  const BABY_HEAD_SCALE = { sheep: LAMB_HEAD_SCALE, cow: CALF_HEAD_SCALE, pig: PIGLET_HEAD_SCALE, panda: PANDA_CUB_HEAD_SCALE, dog: PUPPY_HEAD_SCALE };
  const PANDA_ANGRY_TIME = 12; // 熊猫挨打后愤怒追击持续秒数（追咬一阵后平息）
  const PANDA_GIVEUP_DIST = 22; // 玩家跑远超过这个距离，愤怒熊猫放弃追击
  const PANDA_TEMPT_RANGE = 11; // 手持竹子能吸引熊猫的最远距离

  // 各类型权威配置：尺寸 / 速度 / 血量 / 伤害 / 掉落 / 配色 / 建模参数
  const TYPES = {
    pig: {
      name: "猪", width: 0.62, height: 0.88, speed: 1.15,
      hp: 10, behavior: "flee",
      drops: [[ITEM.PORKCHOP, 1, 2]],
      deathColor: 0xd8878c,
      bodyLen: 0.92, bodyW: 0.58, bodyH: 0.56, legLen: 0.32, legW: 0.18,
      colors: {
        skin: 0x9c3c3e, skinLight: 0xf44c5c, skinMid: 0x7a2830,
        skinDark: 0x66222c, skinDeep: 0x541e26,
        hoof: 0x4e2028, eye: 0x171313, eyeLight: 0xececec
      }
    },
    dog: {
      name: "狗", width: 0.50, height: 0.70, speed: 1.75,
      hp: 8, tamedHp: 20, damage: 3, tamedDamage: 4, behavior: "anger",
      drops: [],
      deathColor: 0x8a8a90,
      chaseSpeed: 2.7, biteRange: 1.5, biteInterval: 0.7,
      // 1:1 复刻 MC 狼（ModelWolf）：1 texel = 0.06 格（腿2×8×2 / 躯干6×6×9 / 鬃8×7×6 / 头6×6×4 / 吻3×3×4 / 耳2×2×1 / 尾2×8×2）
      bodyLen: 0.66, bodyW: 0.48, bodyH: 0.36, legLen: 0.48,
      colors: {
        // 灰阶层次对齐原版 wolf.png（#DDDADB/#D3CFCF/#CAC7C8/#C1BEBE/#B0AAA7/#9F9A96/#9A9591）；
        // 除近白 W 外均按本机正午 Hemi+ACES 响应做光照补偿，否则阴面会整体抬成近白
        furW: 0xcfcfd0, // 近白斑（背顶 / 额头，顶面受直射光≈#df）
        furBase: 0x929295, // 主浅灰（体侧上半 / 腿上半亮格）
        furL: 0x7d7d80, // 次浅灰（斑驳亮格 / 耳根）
        furM: 0x68686b, // 亮中灰（斑驳暗格 / 头侧基色）
        furD: 0x55565a, // 深斑（体侧下缘 / 尾腹渐变）
        furSock: 0x47484c, // 爪袜主色
        furSockX: 0x343438, // 爪袜最暗格 / 尾尖
        black: 0x1d1d1c, // 耳内 / 眼 / 鼻 / 嘴
        tan: 0xceaf96,  // 吻顶 / 脸颊亮棕（原版 #CEAF96）
        tanDeep: 0x947b68, // 脸颊深棕（原版 #947B68）
        tanStripe: 0xa78f7e, // 吻侧中棕（原版 #A78F7E）
        muzzle: 0xe4d8d9, // 吻端鼻侧近白粉
        collar: 0x6e1d18 // 驯化红项圈（参考图侧主面屏色 #531613 反算 albedo）
      }
    },
    cow: {
      name: "牛", width: 0.72, height: 1.05, speed: 1.05,
      hp: 12, damage: 3, behavior: "anger",
      drops: [[ITEM.BEEF, 1, 2], [ITEM.LEATHER, 0, 1]],
      deathColor: 0x3e2c20,
      chaseSpeed: 1.7, biteRange: 1.7, biteInterval: 1.0,
      bodyLen: 1.00, bodyW: 0.62, bodyH: 0.66, legLen: 0.48, legW: 0.21,
      colors: {
        hide: 0x2e231a, hideDark: 0x211810,       // 深巧克力棕
        patch: 0xc6cac7, patchShade: 0x9aa09d,    // 冷灰白斑 + 中灰颗粒
        horn: 0x555b5f, hornDark: 0x4c5154,       // 深灰小角
        muzzle: 0xb4b4af, nose: 0x5d5a55, eye: 0x080706,
        pink: 0xca7683, pinkDark: 0xb35f6d,       // 内耳 / 乳房
        hoof: 0x0c0a09                            // 近黑蹄与尾梢
      }
    },
    sheep: {
      name: "羊", width: 0.62, height: 0.82, speed: 1.20,
      hp: 8, behavior: "flee",
      drops: [[ITEM.MUTTON, 1, 1], [ITEM.WOOL, 1, 1]],
      deathColor: 0xd9dad8,
      bodyLen: 0.82, bodyW: 0.62, bodyH: 0.62, legLen: 0.34,
      colors: {
        wool: 0xe7e8e6, woolLight: 0xf4f5f4, woolShade: 0xc7c9c8,
        skin: 0xc09a76, skinDark: 0xa37f5e,
        nose: 0xd28f88, noseDark: 0xbd7470, eye: 0x2b2723, hoof: 0x3f3a36
      }
    },
    panda: {
      // 竹林里的温和大块头：平时不主动攻击玩家；但挨打后会皱眉怒目、冲过来抱腿撕咬，
      // 一阵后平息。玩家手持竹子 / 竹笋会把它吸引过来；喂两只成年熊猫吃竹子会生下小熊猫
      name: "熊猫", width: 0.82, height: 1.12, speed: 1.0,
      hp: 20, behavior: "passive",
      damage: 3, chaseSpeed: 1.7, biteRange: 1.7, biteInterval: 1.1,
      drops: [],
      deathColor: 0x1b1b20,
      bodyLen: 1.18, bodyW: 0.78, bodyH: 0.78, legLen: 0.42, legW: 0.22,
      colors: {
        fur: 0xe9eae8, furLight: 0xf7f8f6, furShade: 0xcacbc9, furDeep: 0xacadab,
        black: 0x1d1d22, blackDeep: 0x0f0f13, blackMid: 0x2c2c32,
        eye: 0x0b0b0e, muzzle: 0xdedfdd
      }
    },
    zombie: {
      // 夜晚出没的敌对人形怪：主动追击并撕咬玩家，白天露天会自燃
      name: "僵尸", width: 0.55, height: 1.82, speed: 1.05,
      hp: 12, damage: 3, behavior: "hunt", hostile: true,
      drops: [],
      deathColor: 0x4f7f3d,
      chaseSpeed: 2.15, biteRange: 1.7, biteInterval: 1.0,
      legLen: 0.66, torsoH: 0.72,
      colors: { skin: 0x5a8a45, shirt: 0x3e5a86, pants: 0x30384f, eye: 0x202028 }
    },
    spider: {
      // 夜晚出没的敌对节肢怪：贴地疾跑、中距离扑击玩家；
      // 白天烈日下不燃烧，但转为中立游荡，被攻击后会短暂反击
      name: "蜘蛛", width: 1.0, height: 0.66, speed: 1.9,
      hp: 10, damage: 2, behavior: "hunt", hostile: true, sunBurn: false,
      drops: [[ITEM.SPIDER_SILK, 1, 2]],
      deathColor: 0x2a2426,
      chaseSpeed: 3.2, biteRange: 1.5, biteInterval: 0.9,
      colors: { body: 0x332b2c, bodyDark: 0x1f1a1b, leg: 0x262022, mark: 0x7a2320, eye: 0xd82b1e, fang: 0xe6e0d2 }
    },
    dragon: {
      // 火山 Boss：紫黑龙。盘踞火山口上空，靠近火山顶即苏醒；
      // 飞行盘旋、俯冲撕咬、喷吐火球与锥形火焰，血量极厚
      name: "紫黑龙", width: 2.0, height: 2.7, speed: 7.5,
      hp: 120, damage: 6, behavior: "hunt", hostile: true, boss: true,
      drops: [[ITEM.DRAGON_MEAT, 3, 5], [ITEM.DRAGON_HIDE, 2, 3]],
      deathColor: 0x312c32,
      chaseSpeed: 9.5, biteRange: 3.8, biteInterval: 1.3,
      // 外观为 buildDragon 低模切面雕塑：五档灰 H6/H5/H4/H3/H11 + 亮红眼，无任何紫色
      colors: { beadH6: 0x312c32 }
    }
  };

  // populate() 只投放友好动物；僵尸由游戏主循环在夜晚单独生成；
  // 熊猫不参加均匀投放，只在竹林群系单独成组生成（见 populate 尾部）
  const ANIMAL_TYPES = ["pig", "dog", "cow", "sheep"];

  // 掉落物在世界中的小方块颜色
  const DROP_COLORS = {};
  DROP_COLORS[ITEM.PORKCHOP] = 0xe89494;
  DROP_COLORS[ITEM.BEEF] = 0xa83c34;
  DROP_COLORS[ITEM.MUTTON] = 0xb83a32;
  DROP_COLORS[ITEM.LEATHER] = 0x8a5a2b;
  DROP_COLORS[ITEM.WOOL] = 0xd3d8d9;
  DROP_COLORS[ITEM.DRAGON_MEAT] = 0xc04438;
  DROP_COLORS[ITEM.DRAGON_HIDE] = 0x312c32;
  DROP_COLORS[ITEM.SPIDER_SILK] = 0xe9e9e2;

  // 快捷构造一个缩放方块：parent / 材质 / 位置 / (sx,sy,sz)
  function box(parent, m, x, y, z, sx, sy, sz) {
    const mesh = new THREE.Mesh(GEO, m);
    mesh.position.set(x, y, z);
    mesh.scale.set(sx, sy, sz);
    parent.add(mesh);
    return mesh;
  }

  /* ---------------- 建模（统一朝向：头朝 -Z） ---------------- */

  function buildPig(t) {
    const c = t.colors, g = new THREE.Group(), parts = { legs: [] };
    const bodyGroup = new THREE.Group();
    g.add(bodyGroup); parts.bodyGroup = bodyGroup;

    const L = t.bodyLen, W = t.bodyW, H = t.bodyH, leg = t.legLen;
    const top = leg + H;

    // 躯干：粉色长方块
    box(bodyGroup, mat(c.skin), 0, leg + H / 2, 0, W, H, L);

    /* ===== 背部粉色像素颗粒：L 浅粉 / m 中粉 / . 底色（稀疏长条） ===== */
    const TILE = 0.116;
    const backRows = [
      [-0.420, ".L..."],
      [-0.315, "..m.."],
      [-0.210, "L.LL."],
      [-0.105, ".m.L."],
      [ 0.000, "L..m."],
      [ 0.105, ".LL.."],
      [ 0.210, "m.L.L"],
      [ 0.315, "..m.."],
      [ 0.420, ".L..."]
    ];
    for (const row of backRows) {
      for (let i = 0; i < 5; i++) {
        const ch = row[1][i];
        if (ch === ".") continue;
        box(bodyGroup, mat(ch === "m" ? c.skinMid : c.skinLight),
            -0.232 + i * TILE, top + 0.003, row[0], TILE, 0.006, TILE);
      }
    }

    /* ===== 两肋像素：m 中粉 / d 深粉，中间一条横贯的深粉纹理带 ===== */
    const sideRows = [
      [0.78, "...m....."],
      [0.70, "m....m..."],
      [0.62, "..m......"],
      [0.47, "mdm.mmd.m"],
      [0.40, ".d..d..d."],
      [0.34, "m.m..m..."]
    ];
    for (const sx of [-1, 1]) {
      // 横贯侧腹的深粉纹理带
      box(bodyGroup, mat(c.skinMid), sx * (W / 2 + 0.003), 0.545, 0.02,
          0.005, 0.07, L * 0.86);
      for (let ri = 0; ri < sideRows.length; ri++) {
        const row = sideRows[ri];
        for (let i = 0; i < 9; i++) {
          const ch = row[1][i];
          if (ch === ".") continue;
          // 上三行只用轻微加深的像素，腹带及以下用中粉/深粉
          let mhex;
          if (ri < 3) mhex = 0x8c353b;
          else mhex = ch === "d" ? c.skinDark : c.skinMid;
          box(bodyGroup, mat(mhex),
              sx * (W / 2 + 0.003), row[0], -0.4 + i * 0.1, 0.005, 0.062, 0.095);
        }
      }
      // 臀部上方两块深粉
      box(bodyGroup, mat(c.skinMid), sx * (W / 2 + 0.003), 0.78, L / 2 - 0.12, 0.006, 0.10, 0.12);
      box(bodyGroup, mat(c.skinDark), sx * (W / 2 + 0.003), 0.62, L / 2 - 0.10, 0.006, 0.08, 0.08);
    }
    // 腹下阴影
    box(bodyGroup, mat(c.skinMid), 0, leg - 0.005, 0, W * 0.55, 0.04, L * 0.72);

    /* ===== 头：大头方块 + 突出的大拱嘴 + 黑白眼 + 脸颊深纹 ===== */
    const head = new THREE.Group();
    head.position.set(0, leg + H * 0.62, -L / 2 - 0.17);
    bodyGroup.add(head); parts.head = head;
    box(head, mat(c.skin), 0, 0, 0, 0.54, 0.52, 0.46);
    // 头顶后侧两角的淡粉耳痕（幼崽不显示）
    parts.pigEars = [
      box(head, mat(0x85333a), -0.20, 0.263, 0.11, 0.085, 0.008, 0.085),
      box(head, mat(0x85333a),  0.20, 0.263, 0.11, 0.085, 0.008, 0.085)
    ];
    // 眼睛：黑方块 + 内上方白色像素
    for (const sx of [-1, 1]) {
      box(head, mat(c.eye), sx * 0.16, -0.005, -0.236, 0.075, 0.085, 0.014);
      box(head, mat(c.eyeLight), sx * 0.16 - sx * 0.022, 0.03, -0.238, 0.034, 0.034, 0.016);
    }
    // 两颊深粉竖纹：三块错列像素（参考图吻侧的深色脸颊纹）
    for (const sx of [-1, 1]) {
      box(head, mat(c.skinMid),  sx * 0.276,  0.08, -0.16, 0.01, 0.075, 0.075);
      box(head, mat(c.skinDark), sx * 0.276,  0.00, -0.14, 0.01, 0.075, 0.075);
      box(head, mat(c.skinDark), sx * 0.276, -0.08, -0.12, 0.01, 0.075, 0.075);
    }
    // 拱嘴：浅粉大鼻突 + 中粉吻面 + 两个深褐红鼻孔 + 淡粉吻顶
    box(head, mat(c.skin), 0, -0.11, -0.245, 0.30, 0.23, 0.13);
    box(head, mat(c.skinMid), 0, -0.11, -0.316, 0.31, 0.23, 0.01);
    box(head, mat(c.skinLight), 0, 0.01, -0.245, 0.24, 0.018, 0.10);
    box(head, mat(c.hoof), -0.085, -0.125, -0.323, 0.055, 0.07, 0.012);
    box(head, mat(c.hoof),  0.085, -0.125, -0.323, 0.055, 0.07, 0.012);

    // 头部基准位姿：幼猪在此基础上放大头部（大头小身，见 applyBabyLook）
    parts.headBase = {
      pos: head.position.clone(),
      babyPos: head.position.clone().add(new THREE.Vector3(0, 0.13, -0.26))
    };

    /* ===== 小尾巴：身后上方的粉色小揪 ===== */
    const tail = new THREE.Group();
    tail.position.set(0, leg + H * 0.82, L / 2);
    tail.rotation.x = -0.5;
    bodyGroup.add(tail); parts.tail = tail;
    box(tail, mat(c.skinDark), 0, 0.05, 0.02, 0.05, 0.10, 0.05);

    // 短粗粉腿（粉色到底，不做全包围蹄），正面两块深脚趾 + 深色脚底
    addLegs(g, parts, t, null, c.skin, null);
    const lw = t.legW || 0.13;
    for (const legInfo of parts.legs) {
      const pv = legInfo.pivot;
      for (const tx of [-0.045, 0.045]) {
        box(pv, mat(c.hoof), tx, -leg + 0.045, -(lw / 2 + 0.003), 0.05, 0.09, 0.008);
      }
      box(pv, mat(c.hoof), 0, -leg + 0.015, 0, lw - 0.02, 0.03, lw - 0.02);
    }

    // 驯服后出现的马鞍
    const tag = new THREE.Group();
    tag.visible = false;
    box(tag, mat(0x6b4220), 0, leg + H + 0.025, -0.02, W * 0.72, 0.06, L * 0.55);
    box(tag, mat(0x4a2d12), 0, leg + H + 0.08, -L * 0.18, 0.10, 0.10, 0.10);
    g.add(tag); parts.tag = tag;
    return { root: g, parts: parts };
  }

  // ===== 狗 / 狼：1:1 复刻 MC 狼（1.21.5 新狼几何 + wolf.png UV，1 texel = 0.06 格，头朝 -Z，脚 y=0）=====
  // 权威比例：四腿 2×8×2（前 z-4 / 后 z7），躯干 6×6×9（y7..13, z-5..4，前端贴头后端），颈鬃 8×7×6（x -5..3,
  // y7..14, z-1..5），头 6×6×4（枢轴 -1,10.5,-7），吻 3×3×4，耳 2×2×1 平板，尾 2×8×2（枢轴 -1,12,8）。
  // 躯干/颈鬃在原版绕 X 旋转 90°，这里直接按旋转后的场景朝向摆盒，纹理面按旋转后的归属铺贴。
  function buildDog(t) {
    const c = t.colors, g = new THREE.Group(), parts = { legs: [] };
    const bodyGroup = new THREE.Group();
    g.add(bodyGroup); parts.bodyGroup = bodyGroup;

    const P = 0.06;
    // 坐标单位为 texel 的快捷盒：B(父, 色, x, y, z, 宽, 高, 深)
    function B(parent, col, x, y, z, sx, sy, sz) {
      return box(parent, mat(col), x * P, y * P, z * P, sx * P, sy * P, sz * P);
    }
    // 水平面贴片：rows 沿 z（前→后），字符沿 x（左→右），y/x0/z0 为格中心（texel）。
    // 顶面几乎无缝（0.98），否则中灰基色在近白背顶间形成棋盘格暗缝
    function topTiles(parent, rows, pal, y, x0, z0) {
      for (let r = 0; r < rows.length; r++)
        for (let i = 0; i < rows[r].length; i++) {
          const col = pal[rows[r][i]];
          if (col) B(parent, col, x0 + i, y, z0 + r, 0.98, 0.1, 0.98);
        }
    }
    // 朝 ±X 立面贴片：rows 自上而下，字符沿 z 前→后；yTop 为最上格中心。
    // 垂直面固定用 PALV（垂直光照补偿色板），pal 参数仅为保持调用一致而保留
    function sideTiles(parent, rows, pal, x, yTop, z0) {
      for (let r = 0; r < rows.length; r++)
        for (let i = 0; i < rows[r].length; i++) {
          const col = PALV[rows[r][i]];
          if (col) B(parent, col, x, yTop - r, z0 + i, 0.1, 0.98, 0.98);
        }
    }
    // 朝 ±Z 立面贴片：rows 自上而下，字符沿 x
    function frontTiles(parent, rows, pal, z, yTop, x0) {
      for (let r = 0; r < rows.length; r++)
        for (let i = 0; i < rows[r].length; i++) {
          const col = PALV[rows[r][i]];
          if (col) B(parent, col, x0 + i, yTop - r, z, 0.98, 0.98, 0.1);
        }
    }
    // 七档灰（浅档受光补偿）+ 五档棕（原版 #C4AB9C/#A78F7E/#947B68/#8C6F52）+ 鼻粉 g + 纯黑 N。
    // 正午锁定光照（phase=0.25，太阳方位正南）下用标定墙实测三条 albedo→screen 曲线：
    //   gx(+X 立面，无直射) 0x2a→#4B 0x38→#5C 0x46→#6C 0x54→#79 0x62→#84 0x70→#8F 0x80→#99 0x95→#A4
    //   gz(+Z 立面，少量直射) 0x2a→#5A 0x46→#7E 0x62→#98 0x80→#AB 0x95→#B7
    //   tp(+Y 顶面，全直射) 0x4a→#B0 0x6e→#C2 0x80→#CA 0x92→#D0
    // 色值全部按「参考图屏幕目标色」反算。PAL=顶面(tp)；PALV=垂直面(gx/gz)。
    const PAL = { W: 0x909194, w: 0x5a5b5e, c: 0x3e3f42, l: 0x26272a, m: 0x18191c,
                  d: c.furSock, x: c.furSockX,
                  K: c.black, N: 0x121416, T: 0xd8a883, t: 0xc89a76,
                  s: 0x8a6a50, u: 0x9c7650, q: 0x5c4438, g: 0x8f8787,
                  z: 0x34373b };
    // 头/耳/腿/尾共用浅毛七档（立面目标 #B0/#9A/#84/#6E/#60/#5A/#4F）；
    // 数字 1-7=体侧（#A2/#72/#61/#51/#43/#38/#29）；字母 A-F=颈鬃（#B8/#85/#72/#5F/#4C/#40）；
    // 棕调：T/t 吻侧沙棕、s 颊、u 颌侧、q 深棕描边、g 吻端鼻粉
    const PALV = { W: 0xc0c1c4, w: 0x8d8e91, c: 0x626366, l: 0x48494c, m: 0x3b3c3f,
                   d: 0x353639, x: 0x2c2d30,
                   '1': 0x919295, '2': 0x4d4e51, '3': 0x3d3e41, '4': 0x313235,
                   '5': 0x232427, '6': 0x1a1b1e, '7': 0x0d0e11,
                   A: 0x808184, B: 0x57585b, C: 0x46474a, D: 0x38393c, E: 0x292a2d, F: 0x202124,
                   z: 0x34373b,
                   K: c.black, N: 0x121416, T: 0xeaae92, t: 0xc29a7e,
                   s: 0x423228, u: 0x6e5a44, q: 0x241c14, g: 0x706a6a };
    // 旋转面转置：提取阵列 rows(纹理 v→场景 z 前→后)×cols(u→场景 y 上→下)
    //          转成 sideTiles 需要的 rows(场景 y 上→下)×每行(场景 z 前→后)
    function tr(rows) {
      const out = [];
      for (let j = 0; j < rows[0].length; j++) {
        let s = "";
        for (let r = 0; r < rows.length; r++) s += rows[r][j];
        out.push(s);
      }
      return out;
    }
    const rev2 = s => s.split("").reverse().join("");
    const revRows = rows => rows.map(rev2);
    // 躯干/颈鬃立面使用各自专用灰度档（参考图躯干近脸 0.78 影、颈鬃更亮一档）
    const bodyDim = { W: '1', w: '2', c: '3', l: '4', m: '5', d: '6', x: '7' };
    const maneDim = { W: 'A', w: 'B', c: 'C', l: 'D', m: 'E', d: 'F', x: 'F' };
    const dimRows = (rows, map) => rows.map(s => s.split("").map(ch => map[ch] || ch).join(""));

    /* ---- 四条直腿（髋部为轴）2×8×2：前腿 z=-4、后腿 z=7（原版四腿共用 UV (0,18)）。
            每腿四面 2×8：上 5 格浅灰斑驳，第 6-7 行深爪袜，第 8 行浅灰，爪底 2×2 棕 ---- */
    const legSideNX = ["cl","wc","ww","wc","cl","xm","md","lc"];
    const legFaceNZ = ["wl","wc","cc","lc","cl","dx","xd","cW"];
    const legFacePZ = ["wl","lc","lw","cc","wl","mm","xd","WW"];
    const legSidePX = ["cc","wl","wc","ww","cl","xd","dm","cl"];
    const legPaw = ["uu","uu"];
    // [x,z,摆腿相位,是否前腿]：对角两腿同相；-X 腿按原版 mirror 翻转纹理
    const legDefs = [[-1.5,-4,0,true],[1.5,-4,1,true],[-1.5,7,1,false],[1.5,7,0,false]];
    for (const [lx, lz, phase, front] of legDefs) {
      const hip = new THREE.Group();
      hip.position.set(lx * P, 8 * P, lz * P);
      B(hip, c.furM, 0, -4, 0, 2, 8, 2);
      const mir = lx < 0;
      sideTiles(hip, mir ? revRows(legSideNX) : legSideNX, PAL, -1.06, -0.5, -0.5);
      sideTiles(hip, mir ? revRows(legSidePX) : legSidePX, PAL, 1.06, -0.5, -0.5);
      frontTiles(hip, mir ? revRows(legFaceNZ) : legFaceNZ, PAL, -1.06, -0.5, -0.5);
      frontTiles(hip, mir ? revRows(legFacePZ) : legFacePZ, PAL, 1.06, -0.5, -0.5);
      topTiles(hip, legPaw, PAL, -8.06, -0.5, -0.5);
      g.add(hip);
      parts.legs.push({ pivot: hip, phase: phase, front: front });
    }

    /* ---- 躯干 6×6×9（中心 (0,10,-0.5)，y7..13 z-5..4；原版 body UV (18,14) 绕 X 转 90°。
            z 用 1.21.5 新狼几何：旧几何躯干在 z0..9，前端与头后端(z-5)空出 4 格脖子空档，
            侧面看身子断成两截；整体前移 5 texel 后前端 z=-5 紧贴头后端 ---- */
    const body = new THREE.Group();
    bodyGroup.add(body);
    B(body, c.furD, 0, 10, -0.5, 6, 6, 9);
    // 背顶（原 -Z 面旋到水平）：浅灰斑驳 6×9
    const bodyTop = ["llccll","lcwwcl","lcwcll","cwwwwc","lcwwll","llcwcl","lcccll","llclll","llccll"];
    topTiles(body, bodyTop, PAL, 13.06, -2.5, -4.5);
    const bodyUnder = ["WWWwll","WwWwwl","WwWWwl","WWWWwc","WWwWWc","WWcwwc","wWlwcl","cwlccl","lclcll"];
    topTiles(body, bodyUnder, PAL, 6.94, -2.5, -4.5);
    // 两侧（原 ±X 面）：纹理面需转置——行=场景 y（上→下），字=场景 z（前→后）
    const bodySideNX = ["llwWWW","lwwWwW","lwWWwW","cwWWWW","cWWwWW","cwwcWW","lcwlWw","lcclwc","llclcl"];
    const bodySidePX = ["WwWmww","WclmwW","WwmlWW","wWdlWw","wWdlwW","WwdmcW","wcmdcw","wcldcc","wccmlc"];
    sideTiles(body, tr(dimRows(bodySideNX, bodyDim)), PAL, -3.06, 12.5, -4.5);
    sideTiles(body, tr(dimRows(bodySidePX, bodyDim)), PAL, 3.06, 12.5, -4.5);
    // 前胸（原底面旋到垂直 -Z）6×6，贴 z=-5 被头挡住仅露棱；后端面 z=4 原版纹理透明，
    // 露出基色，处于两条后腿与尾根之间
    const bodyChest = ["lWWwWl","wWWWWw","WwlmwW","lwddlm","mlddlm","mmmdmm"];
    frontTiles(body, dimRows(bodyChest, bodyDim), PAL, -5.06, 12.5, -2.5);

    /* ---- 颈鬃 8×7×6（中心 (-1,10.5,2)，y7..14 z-1..5；原版 mane UV (21,0) 绕 X 转 90°） ---- */
    const mane = new THREE.Group();
    bodyGroup.add(mane);
    B(mane, c.furD, -1, 10.5, 2, 8, 7, 6);
    // 颈背顶（原 -Z 面）8×6
    const maneTop = ["lwWWwwWW","WWwwwcwW","Wwcccccw","lWwccccc","lWWwcwww","lwWWwWww"];
    topTiles(mane, maneTop, PAL, 14.06, -4.5, -0.5);
    // 两侧 7(高)×6(长)，同样转置
    const maneSideNX = ["llcwWWw","wWWWwcl","ccwwlll","lclcwml","clmlcdc","cmdmldm"];
    const maneSidePX = ["wlWlcwc","WlWcWWw","WcwcwWW","wcwcwlW","wmclcml","ldmlmdm"];
    sideTiles(mane, tr(dimRows(maneSideNX, maneDim)), PAL, -4.06, 13.5, -0.5);
    sideTiles(mane, tr(dimRows(maneSidePX, maneDim)), PAL, 4.06, 13.5, -0.5);
    // 颈胸（原底面旋到 -Z）8×7；后端面在体内被躯干遮挡，不贴
    const maneChest = ["lwlwlclc","wwlwccww","wWcWwlwW","WWcWwcWW","WwcWWcWW","wwlwWcww","cwllwlcw"];
    frontTiles(mane, dimRows(maneChest, maneDim), PAL, -1.06, 13.5, -4.5);

    /* ---- 头 6×6×4（枢轴 (-1,10.5,-7)）；原版 head UV (0,0) ---- */
    const head = new THREE.Group();
    head.position.set(-1 * P, 10.5 * P, -7 * P);
    bodyGroup.add(head); parts.head = head;
    B(head, c.furM, 0, 0, 0, 6, 6, 4);
    // 脸（-Z，带双眼）与后脑（+Z）
    const headFace = ["lwWWwl","llwwlc","WNssNW","sqssqs","qssssq","swwwws"];
    const headBack = ["wcllcw","wwWwwW","wWwwcW","lwwclc","swccll","ssllll"];
    frontTiles(head, headFace, PAL, -2.06, 2.5, -2.5);
    frontTiles(head, headBack, PAL, 2.06, 2.5, -2.5);
    // 两侧 4(深)×6(高)
    const headSideNX = ["lwcl","cWwc","wwWw","cwwl","ccws","llss"];
    const headSidePX = ["clcl","Wwcl","wcwl","wlwc","clcl","llll"];
    sideTiles(head, headSideNX, PAL, -3.06, 2.5, -1.5);
    sideTiles(head, headSidePX, PAL, 3.06, 2.5, -1.5);
    // 头顶 6×4：前→后
    const headTop = ["wWwWwc","wwWccw","wWWwWW","ccWWwc"];
    topTiles(head, headTop, PAL, 3.06, -2.5, -1.5);

    // 两只 2×2×1 立耳（耳顶全黑，正面浅灰、背面一侧黑边；原版耳 UV (16,14)）
    const earFaceNZ = ["WW","ww"], earFacePZ = ["Kw","KW"];
    const earSideNX = ["K","K"], earSidePX = ["W","w"];
    for (const ex of [-2, 2]) {
      const ear = new THREE.Group();
      ear.position.set(ex * P, 4 * P, 0.5 * P);
      head.add(ear);
      B(ear, c.furL, 0, 0, 0, 2, 2, 1);
      frontTiles(ear, earFaceNZ, PAL, -0.06, 0.5, -0.5);
      frontTiles(ear, earFacePZ, PAL, 1.06, 0.5, -0.5);
      sideTiles(ear, earSideNX, PAL, -1.06, 0.5, 0.5);
      sideTiles(ear, earSidePX, PAL, 1.06, 0.5, 0.5);
      topTiles(ear, ["KK"], PAL, 1.06, -0.5, 0.5);
    }

    /* ---- 吻 3×3×4（头组内中心 (0,-1.5,-3)；原版 snout UV (0,10)） ---- */
    const snout = new THREE.Group();
    snout.position.set(0, -1.5 * P, -3 * P);
    head.add(snout);
    B(snout, c.tan, 0, 0, 0, 3, 3, 4);
    // 吻端（-Z）：中央黑鼻 N + 黑嘴 KKK，两侧鼻粉 g
    const snoutTip = ["gNg","ggg","KKK"];
    frontTiles(snout, snoutTip, PAL, -2.06, 1, -1);
    // 两侧 4(长)×3(高)
    const snoutSideNX = ["TTgg","TTTg","uNKK"];
    const snoutSidePX = ["TttT","tuut","tuut"];
    // 吻盒半宽/半高 1.5 texel：侧片贴 ±1.56（旧误写 ±2.06 外飘半格，
    // 底片悬空露出受光顶面，从低角度看就是下颌一块亮板）
    sideTiles(snout, snoutSideNX, PAL, -1.56, 1, -1.5);
    sideTiles(snout, snoutSidePX, PAL, 1.56, 1, -1.5);
    // 吻顶：沙棕 + 中央 u 暗纹 + 前端 K 鼻顶；纹理 v13 为前端，故前→后倒序
    topTiles(snout, ["TKT","TuT","TuT","tut"], PAL, 1.56, -1, -1.5);
    topTiles(snout, ["TuT","tut","tut","tut"], PAL, -1.56, -1, -1.5);

    /* ---- 尾 2×8×2（枢轴 (-1,12,8)，自然下垂；野生后倾、驯服上翘，见 updateAnimation） ---- */
    const tail = new THREE.Group();
    tail.position.set(-1 * P, 12 * P, 8 * P);
    bodyGroup.add(tail); parts.tail = tail;
    const tailBase = B(tail, c.furM, 0, -4, 0, 2, 8, 2);
    // 基盒中心 y=-4（B() 为中心坐标，盒子跨 0..-8 与贴片对齐；切勿写 -8，
    // 否则盒子跨 -4..-12 多出 4 格裸 furM，翘尾时亮成白尾尖）。
    // 尾绕 X 转姿态角后：±X 面永远竖直（两姿态都可见，gx 影，c/l 混搭≈#7A）；
    // NZ 只在野生低尾时朝相机（阴影面）；PZ 在驯化翘尾(-1.8)时朝斜上方受光，
    // 必须用暗档 z（全直射下≈#88），野生时该面朝外不可见。
    const tailSideNX = ["cl","lc","cl","cl","cl","lc","cl","lc"];
    const tailFaceNZ = ["lc","cl","lc","cl","cl","lc","cl","lc"];
    const tailFacePZ = ["zz","zz","mz","zz","zz","mz","zz","zz"];
    const tailSidePX = ["lc","cl","lc","cl","cl","lc","lc","cl"];
    sideTiles(tail, tailSideNX, PAL, -1.06, -0.5, -0.5);
    sideTiles(tail, tailSidePX, PAL, 1.06, -0.5, -0.5);
    frontTiles(tail, tailFaceNZ, PAL, -1.06, -0.5, -0.5);
    frontTiles(tail, tailFacePZ, PAL, 1.06, -0.5, -0.5);
    topTiles(tail, ["KK","KK"], PAL, 0.06, -0.5, -0.5);      // 尾根端面黑（藏在臀内）
    topTiles(tail, ["zc","cz"], PAL, -8.06, -0.5, -0.5);     // 尾尖端面 2×2（z/c 灰格）
    // 0.98 贴片在掠视角会沿棱漏出基色亮线：尾贴片 0.98→1.00 恰好铺满棱边
    // （同面贴片共边、零面积，无 z-fight；厚度 0.1 不动）
    tail.children.forEach(o => {
      if (!o.isMesh || o === tailBase) return;
      if (o.scale.x > 0.05) o.scale.x = 0.06;
      if (o.scale.y > 0.05) o.scale.y = 0.06;
      if (o.scale.z > 0.05) o.scale.z = 0.06;
    });

    /* ---- 驯化红项圈：原版 WolfCollarLayer 同款——与颈鬃同大、略放大的整圈盒，
       贴在鬃毛最前缘（z -1..1，2 texel 宽）。等距侧视时：±X 面凸出鬃侧 0.06 呈现
       满颈高 7 texel 的暗红竖条，-Z 前脸被头挡住只露棱，顶面在两耳间露小截（参考图2）。 ---- */
    const tag = new THREE.Group();
    tag.visible = false;
    B(tag, c.collar, -1, 10.5, 0, 8.12, 7.12, 2.06);
    bodyGroup.add(tag); parts.tag = tag;

    // 幼崽基准（原版幼狼：整体 0.5，头保持成体大小=相对 ×2，头上抬 0.3125/后移 0.125 世界单位，
    // 因 head 在 root×0.5 内，子坐标偏移需 ×2）
    parts.headBase = {
      pos: head.position.clone(),
      babyPos: head.position.clone().add(new THREE.Vector3(0, 0.625, -0.25))
    };
    return { root: g, parts: parts };
  }

  function buildCow(t) {
    const c = t.colors, g = new THREE.Group(), parts = { legs: [] };
    const bodyGroup = new THREE.Group();
    g.add(bodyGroup); parts.bodyGroup = bodyGroup;

    const L = t.bodyLen, W = t.bodyW, H = t.bodyH, leg = t.legLen;
    const top = leg + H;

    // 躯干：深巧克力棕
    box(bodyGroup, mat(c.hide), 0, leg + H / 2, 0, W, H, L);

    /* ===== 背部不规则白斑：W 白 / g 灰色颗粒 / . 棕，
       每行对应一个 z 行、5 列 x，拼出原版花斑的像素感 ===== */
    const TILE = 0.116;
    const backRows = [
      [-0.46, ".WPg."],
      [-0.355, "WPPgg"],
      [-0.25, "gWPPP"],
      [-0.145, "gPPPg"],
      [-0.04, "..Pg."],
      [ 0.065, "..gPP"],
      [ 0.17, ".gPPg"],
      [ 0.275, ".PPg."],
      [ 0.38, "..gP."],
      [ 0.475, "..P.."]
    ];
    for (const row of backRows) {
      for (let i = 0; i < 5; i++) {
        const ch = row[1][i];
        if (ch === ".") continue;
        box(bodyGroup, mat(ch === "g" ? c.patchShade : c.patch),
            -0.232 + i * TILE, top + 0.006, row[0], TILE, 0.012, TILE);
      }
    }

    /* ===== 两肋花斑（左右镜像），9 列 z ===== */
    const sideRows = [
      [1.00, ".Pg......"],
      [0.93, ".Pgg..gP."],
      [0.86, "..gPPPPPg"],
      [0.79, "...gPPPg."],
      [0.70, "....gP..."],
      [0.63, "...gPPPg."],
      [0.56, "....g...."]
    ];
    for (const sx of [-1, 1]) {
      for (const row of sideRows) {
        for (let i = 0; i < 9; i++) {
          const ch = row[1][i];
          if (ch === ".") continue;
          box(bodyGroup, mat(ch === "g" ? c.patchShade : c.patch),
              sx * (W / 2 + 0.006), row[0], -0.4 + i * 0.1, 0.012, 0.09, 0.095);
        }
      }
    }
    // 前胸白斑（与肩部大斑相连）
    box(bodyGroup, mat(c.patch), 0, 0.98, -L / 2 - 0.006, 0.24, 0.18, 0.012);
    box(bodyGroup, mat(c.patchShade), -0.08, 0.92, -L / 2 - 0.006, 0.08, 0.08, 0.014);

    /* ===== 粉色乳房（腹下偏后，侧下方也露出一点） ===== */
    box(bodyGroup, mat(c.pink), 0, leg + 0.03, 0.18, 0.20, 0.08, 0.18);
    for (const sx of [-1, 1]) {
      box(bodyGroup, mat(c.pink), sx * (W / 2 + 0.007), leg + 0.05, 0.18, 0.012, 0.08, 0.12);
    }
    for (const tx of [-0.06, 0.06]) {
      for (const tz of [0.13, 0.23]) {
        box(bodyGroup, mat(c.pinkDark), tx, leg - 0.02, tz, 0.04, 0.05, 0.04);
      }
    }

    /* ===== 头：棕颅顶 + 白色脸 blaze + 黑方眼 + 灰色鼻吻 ===== */
    const head = new THREE.Group();
    head.position.set(0, leg + H * 0.72, -L / 2 - 0.12);
    bodyGroup.add(head); parts.head = head;
    box(head, mat(c.hide), 0, 0, 0, 0.46, 0.44, 0.40);
    // 额头到鼻梁的白色 blaze（窄于脸，两侧留棕，含灰色像素）
    box(head, mat(c.patch), 0, 0.075, -0.206, 0.30, 0.21, 0.014);
    box(head, mat(c.patchShade), -0.09, 0.145, -0.208, 0.06, 0.06, 0.016);
    box(head, mat(c.patchShade), 0.02, 0.11, -0.208, 0.05, 0.05, 0.016);
    box(head, mat(c.patchShade), 0.07, 0.02, -0.208, 0.05, 0.05, 0.016);
    // 头顶白（小斑块）
    box(head, mat(c.patch), 0, 0.226, -0.07, 0.26, 0.014, 0.18);
    box(head, mat(c.patchShade), 0.08, 0.226, -0.02, 0.06, 0.016, 0.07);
    // 黑色方眼睛（紧贴 blaze 外缘）
    box(head, mat(c.eye), -0.10, 0.055, -0.215, 0.07, 0.075, 0.014);
    box(head, mat(c.eye),  0.10, 0.055, -0.215, 0.07, 0.075, 0.014);
    // 灰色鼻吻：浅灰吻部 + 深色鼻端 + 两个黑鼻孔
    box(head, mat(c.muzzle), 0, -0.12, -0.22, 0.29, 0.16, 0.08);
    box(head, mat(c.nose), 0, -0.16, -0.264, 0.29, 0.08, 0.012);
    box(head, mat(c.eye), -0.095, -0.16, -0.272, 0.045, 0.05, 0.012);
    box(head, mat(c.eye),  0.095, -0.16, -0.272, 0.045, 0.05, 0.012);

    // 耳朵：水平向两侧伸出，棕色外耳 + 粉色内耳（正面/外侧可见）
    for (const sx of [-1, 1]) {
      const ear = new THREE.Group();
      ear.position.set(sx * 0.275, 0.05, -0.02);
      box(ear, mat(c.hide), 0, 0, 0, 0.13, 0.05, 0.22);
      // 内耳粉色块：耳根正面的一小块竖斑
      box(ear, mat(c.pink), 0, 0, -0.045, 0.08, 0.036, 0.012);
      head.add(ear);
    }
    // 深灰小角：头顶后侧两角的短桩
    for (const sx of [-1, 1]) {
      box(head, mat(c.horn), sx * 0.17, 0.25, 0.15, 0.06, 0.06, 0.06);
    }

    // 头部基准位姿：幼牛在此基础上放大头部（大头小身，见 applyBabyLook）
    parts.headBase = {
      pos: head.position.clone(),
      babyPos: head.position.clone().add(new THREE.Vector3(0, 0.07, -0.05))
    };

    /* ===== 尾巴 + 黑色尾梢 ===== */
    const tail = new THREE.Group();
    tail.position.set(0, top - 0.02, L / 2);
    bodyGroup.add(tail); parts.tail = tail;
    box(tail, mat(c.hide), 0, -0.16, 0.02, 0.05, 0.30, 0.05);
    box(tail, mat(c.hoof), 0, -0.32, 0.02, 0.09, 0.10, 0.09);

    // 深棕小腿 + 近黑蹄
    addLegs(g, parts, t, c.hoof, c.hide, null);
    // 腿部花斑：前腿下半大片白（正面+外侧），后腿仅小块白斑
    const lw = t.legW || 0.13, hx = lw / 2 + 0.003;
    for (const legInfo of parts.legs) {
      const pv = legInfo.pivot, sx = Math.sign(pv.position.x);
      if (legInfo.front) {
        box(pv, mat(c.patch), sx * hx, -leg * 0.30, 0, 0.008, leg * 0.50, lw + 0.004);
        box(pv, mat(c.patch), 0, -leg * 0.32, -hx, lw * 0.72, leg * 0.44, 0.008);
        box(pv, mat(c.patchShade), sx * hx, -leg * 0.60, 0, 0.008, 0.08, lw + 0.004);
      } else {
        box(pv, mat(c.patch), sx * hx, -leg * 0.45, 0, 0.008, 0.10, lw + 0.004);
        box(pv, mat(c.patchShade), sx * hx, -leg * 0.60, 0, 0.008, 0.06, lw + 0.004);
      }
    }

    // 驯服后的红项圈 + 铃铛
    const tag = new THREE.Group();
    tag.visible = false;
    box(tag, mat(0xe0413e), 0, leg + H * 0.52, -L / 2 + 0.04, 0.34, 0.10, 0.10);
    box(tag, mat(0xffd94d), 0, leg + H * 0.36, -L / 2 + 0.04, 0.08, 0.08, 0.08);
    g.add(tag); parts.tag = tag;
    return { root: g, parts: parts };
  }

  function buildSheep(t) {
    const c = t.colors, g = new THREE.Group(), parts = { legs: [] };
    const bodyGroup = new THREE.Group();
    g.add(bodyGroup); parts.bodyGroup = bodyGroup;

    const L = t.bodyLen, W = t.bodyW, H = t.bodyH, leg = t.legLen;
    const top = leg + H;

    /* ===== 蓬松羊毛躯干（厚实长方体） ===== */
    box(bodyGroup, mat(c.wool), 0, leg + H / 2, 0, W, H, L);

    // 背部像素绒块：深浅交错，还原原版羊毛颗粒感
    const bumpXs = [-0.20, 0, 0.20], bumpZs = [-0.27, -0.09, 0.09, 0.27];
    for (let ix = 0; ix < bumpXs.length; ix++) {
      for (let iz = 0; iz < bumpZs.length; iz++) {
        const dark = (ix + iz * 2) % 3 === 0;
        box(bodyGroup, mat(dark ? c.woolShade : c.woolLight),
            bumpXs[ix], top + 0.02, bumpZs[iz], 0.13, 0.05, 0.13);
      }
    }
    // 两肋暗斑像素
    for (const sx of [-1, 1]) {
      const spots = [[-0.20, 0.24], [0.04, 0.32], [0.24, 0.18]];
      for (const sp of spots) {
        box(bodyGroup, mat(c.woolShade), sx * (W / 2 + 0.004),
            leg + sp[1], sp[0], 0.02, 0.11, 0.11);
      }
    }

    /* ===== 下垂羊毛"裙摆"：两侧与臀部整块下垂（贴在腿外），
       前胸只在两角留毛、中间留出脖子缺口（参考图造型） ===== */
    const skirtY = leg - 0.02;
    box(bodyGroup, mat(c.woolShade), -(W / 2 + 0.025), skirtY, 0, 0.10, 0.20, L - 0.20);
    box(bodyGroup, mat(c.woolShade),  (W / 2 + 0.025), skirtY, 0, 0.10, 0.20, L - 0.20);
    box(bodyGroup, mat(c.woolShade), 0, skirtY, L / 2 - 0.05, 0.76, 0.18, 0.10);
    box(bodyGroup, mat(c.woolShade), -0.27, skirtY + 0.02, -L / 2 + 0.05, 0.23, 0.15, 0.10);
    box(bodyGroup, mat(c.woolShade),  0.27, skirtY + 0.02, -L / 2 + 0.05, 0.23, 0.15, 0.10);

    /* ===== 头：棕色脸 + 白色羊毛帽，黑眼白高光，粉色鼻 ===== */
    const head = new THREE.Group();
    head.position.set(0, leg + H * 0.55, -L / 2 - 0.10);
    bodyGroup.add(head); parts.head = head;
    box(head, mat(c.skin), 0, 0, 0, 0.34, 0.34, 0.32);
    // 头顶羊毛帽（向两侧略微探出）+ 后脑垂毛
    box(head, mat(c.wool), 0, 0.205, 0.02, 0.38, 0.13, 0.30);
    box(head, mat(c.woolShade), 0, 0.10, 0.165, 0.34, 0.12, 0.07);
    // 眼睛：黑方块 + 内上角白色像素
    box(head, mat(c.eye), -0.10, 0.05, -0.17, 0.085, 0.085, 0.02);
    box(head, mat(c.eye),  0.10, 0.05, -0.17, 0.085, 0.085, 0.02);
    box(head, mat(c.wool), -0.058, 0.086, -0.172, 0.045, 0.045, 0.022);
    box(head, mat(c.wool),  0.058, 0.086, -0.172, 0.045, 0.045, 0.022);
    // 粉色鼻子 + 下方深色小唇
    box(head, mat(c.nose), 0, -0.07, -0.17, 0.14, 0.10, 0.02);
    box(head, mat(c.noseDark), 0, -0.135, -0.17, 0.05, 0.035, 0.02);

    // 头部基准位姿：幼羊在此基础上放大头部（大头小身，见 applyBabyLook）
    parts.headBase = {
      pos: head.position.clone(),
      babyPos: head.position.clone().add(new THREE.Vector3(0, 0.10, -0.04))
    };

    /* ===== 小绒尾 ===== */
    const tail = new THREE.Group();
    tail.position.set(0, leg + H * 0.82, L / 2 + 0.02);
    bodyGroup.add(tail); parts.tail = tail;
    box(tail, mat(c.wool), 0, 0.03, 0, 0.15, 0.15, 0.12);

    // 棕色小腿 + 深色蹄（小腿下段略深）
    addLegs(g, parts, t, c.hoof, c.skin, c.skinDark);

    // 驯服后的红领结
    const tag = new THREE.Group();
    tag.visible = false;
    box(tag, mat(0xe0413e), 0, leg + H * 0.62, -L / 2 + 0.04, 0.24, 0.10, 0.08);
    g.add(tag); parts.tag = tag;
    return { root: g, parts: parts };
  }

  /* ---------------- 熊猫（统一朝向：头朝 -Z） ----------------
   * 白底 + 黑色肩披 / 黑腿 / 黑耳；脸上三套独立部件按状态切换：
   *   normal 成年黑眼圈小眼 · baby 幼崽大圆眼 · angry 斜眉怒目。
   * 鼻吻成年 / 幼年各一套，随幼崽缩放一起换。 */
  function buildPanda(t) {
    const c = t.colors, g = new THREE.Group(), parts = { legs: [] };
    const bodyGroup = new THREE.Group();
    g.add(bodyGroup); parts.bodyGroup = bodyGroup;

    const L = t.bodyLen, W = t.bodyW, H = t.bodyH, leg = t.legLen;
    const top = leg + H;

    // 躯干：白色长方体
    box(bodyGroup, mat(c.fur), 0, leg + H / 2, 0, W, H, L);

    /* ===== 黑色肩披：前身约 40% 整圈黑色，与两条前腿连成一体 ===== */
    box(bodyGroup, mat(c.black), 0, leg + H / 2, -L / 2 + 0.235, W + 0.03, H + 0.03, 0.48);
    // 肩披后缘参差像素（顶面 + 两肋），避免笔直接缝
    box(bodyGroup, mat(c.black), 0, top + 0.004, -0.01, 0.20, 0.01, 0.10);
    box(bodyGroup, mat(c.blackMid), -0.17, top + 0.004, 0.03, 0.10, 0.01, 0.07);
    box(bodyGroup, mat(c.blackMid), 0.15, top + 0.004, -0.04, 0.08, 0.01, 0.06);
    for (const sx of [-1, 1]) {
      box(bodyGroup, mat(c.black), sx * (W / 2 + 0.004), leg + H * 0.74, 0.03, 0.01, 0.12, 0.10);
      box(bodyGroup, mat(c.blackMid), sx * (W / 2 + 0.004), leg + H * 0.52, -0.03, 0.01, 0.10, 0.08);
    }
    // 肩披表面深灰颗粒
    for (const p of [[-0.18, -0.42], [0.12, -0.32], [-0.06, -0.20], [0.20, -0.14], [-0.22, -0.12]]) {
      box(bodyGroup, mat(c.blackMid), p[0], top + 0.007, p[1], 0.10, 0.008, 0.10);
    }

    /* ===== 白色后背 / 臀部绒毛：浅 / 灰交错像素点 ===== */
    const backRows = [
      [0.07, ".l.s."],
      [0.17, "s..l."],
      [0.27, ".l..s"],
      [0.37, "s.l.."],
      [0.47, ".s.l."]
    ];
    for (const row of backRows) {
      for (let i = 0; i < 5; i++) {
        const ch = row[1][i];
        if (ch === ".") continue;
        box(bodyGroup, mat(ch === "s" ? c.furShade : c.furLight),
            -0.232 + i * 0.116, top + 0.005, row[0], 0.11, 0.008, 0.10);
      }
    }
    // 两肋（白色后半段）灰色绒影 + 臀侧暗边
    for (const sx of [-1, 1]) {
      for (const p of [[0.98, 0.30], [0.88, 0.14], [0.78, 0.42], [0.68, 0.22], [0.60, 0.40]]) {
        box(bodyGroup, mat(c.furShade), sx * (W / 2 + 0.004), p[0], p[1], 0.01, 0.09, 0.09);
      }
      box(bodyGroup, mat(c.furShade), sx * 0.24, top - 0.06, L / 2 + 0.004, 0.16, 0.10, 0.01);
    }
    // 腹下阴影
    box(bodyGroup, mat(c.furShade), 0, leg - 0.004, 0.12, W * 0.6, 0.05, L * 0.62);

    /* ===== 大头：白颅 + 头顶两只黑耳（耳心深黑） ===== */
    const head = new THREE.Group();
    head.position.set(0, leg + H * 0.74, -L / 2 - 0.12);
    bodyGroup.add(head); parts.head = head;
    box(head, mat(c.fur), 0, 0, 0, 0.62, 0.56, 0.52);
    // 头顶 / 脸颊浅绒像素
    box(head, mat(c.furLight), 0, 0.285, -0.04, 0.30, 0.012, 0.22);
    box(head, mat(c.furShade), -0.31, -0.14, -0.08, 0.012, 0.10, 0.14);
    box(head, mat(c.furShade), 0.31, -0.14, -0.08, 0.012, 0.10, 0.14);
    for (const sx of [-1, 1]) {
      box(head, mat(c.black), sx * 0.22, 0.31, 0.13, 0.17, 0.20, 0.16);
      // 耳心深色凹陷（朝前内面）
      box(head, mat(c.blackDeep), sx * 0.22, 0.30, 0.055, 0.085, 0.10, 0.014);
    }

    /* ===== 面部三套可切换部件（z 向逐层外贴，避免闪烁） ===== */
    const fNormal = new THREE.Group();
    const fBaby = new THREE.Group();
    const fAngry = new THREE.Group();
    head.add(fNormal); head.add(fBaby); head.add(fAngry);
    fBaby.visible = false; fAngry.visible = false;

    // 成年脸：大块黑色眼圈（不规则补块）+ 小眼里一点白仁黑瞳
    for (const sx of [-1, 1]) {
      box(fNormal, mat(c.black), sx * 0.135, -0.01, -0.268, 0.14, 0.17, 0.014);
      box(fNormal, mat(c.black), sx * 0.205, 0.06, -0.268, 0.06, 0.07, 0.014);  // 外上补块
      box(fNormal, mat(c.black), sx * 0.075, -0.10, -0.268, 0.05, 0.06, 0.014); // 内下补块
      box(fNormal, mat(c.furLight), sx * 0.132, 0.035, -0.278, 0.036, 0.036, 0.012);
      box(fNormal, mat(c.eye), sx * 0.144, 0.026, -0.286, 0.018, 0.018, 0.012);
      box(fNormal, mat(c.furShade), sx * 0.205, -0.165, -0.268, 0.07, 0.06, 0.012);
    }

    // 幼年脸：短小下黑斑 + 大圆眼（内上方大白高光 + 小黑瞳）
    for (const sx of [-1, 1]) {
      box(fBaby, mat(c.black), sx * 0.135, -0.14, -0.266, 0.09, 0.07, 0.014);
      box(fBaby, mat(c.eye), sx * 0.135, -0.045, -0.272, 0.105, 0.12, 0.014);
      box(fBaby, mat(c.furLight), sx * 0.112, 0.0, -0.282, 0.05, 0.05, 0.012);
      box(fBaby, mat(c.eye), sx * 0.124, -0.006, -0.290, 0.024, 0.024, 0.012);
      box(fBaby, mat(c.furShade), sx * 0.20, -0.175, -0.266, 0.06, 0.05, 0.012);
    }

    // 愤怒脸：斜挑怒眉（内低外高）+ 眯起的白眼仁黑瞳 + 颊下黑斑
    for (const sx of [-1, 1]) {
      const brow = box(fAngry, mat(c.black), sx * 0.135, 0.075, -0.272, 0.05, 0.17, 0.014);
      brow.rotation.z = -sx * 0.5;
      box(fAngry, mat(c.black), sx * 0.075, 0.02, -0.272, 0.07, 0.07, 0.014);
      box(fAngry, mat(c.black), sx * 0.135, -0.12, -0.268, 0.09, 0.08, 0.014);
      box(fAngry, mat(c.furLight), sx * 0.14, -0.035, -0.280, 0.075, 0.045, 0.012);
      box(fAngry, mat(c.eye), sx * 0.15, -0.04, -0.289, 0.03, 0.03, 0.012);
    }

    /* ===== 鼻吻：成年（normal / angry 共用）与幼年各一套 ===== */
    const muzzleA = new THREE.Group();
    head.add(muzzleA);
    box(muzzleA, mat(c.muzzle), 0, -0.12, -0.286, 0.32, 0.22, 0.14);
    box(muzzleA, mat(c.furLight), 0, -0.04, -0.286, 0.20, 0.018, 0.10);   // 吻顶高光
    box(muzzleA, mat(c.furShade), 0, -0.215, -0.286, 0.26, 0.03, 0.10);   // 吻底阴影
    box(muzzleA, mat(c.blackDeep), 0, -0.075, -0.360, 0.16, 0.09, 0.014); // 黑鼻端
    box(muzzleA, mat(c.blackDeep), 0, -0.034, -0.330, 0.11, 0.012, 0.07); // 鼻面向上包沿
    box(muzzleA, mat(c.blackDeep), 0, -0.145, -0.360, 0.022, 0.05, 0.014);// 唇中竖线
    parts.pandaMuzzle = muzzleA;

    box(fBaby, mat(c.muzzle), 0, -0.13, -0.278, 0.26, 0.18, 0.11);
    box(fBaby, mat(c.furLight), 0, -0.06, -0.278, 0.15, 0.014, 0.07);
    box(fBaby, mat(c.blackDeep), 0, -0.10, -0.338, 0.115, 0.065, 0.014);

    parts.pandaFace = { normal: fNormal, baby: fBaby, angry: fAngry };

    // 头部基准位姿：幼熊猫在此基础上放大头部（大头小身，见 applyBabyLook）
    parts.headBase = {
      pos: head.position.clone(),
      babyPos: head.position.clone().add(new THREE.Vector3(0, 0.11, -0.07))
    };

    /* ===== 白色小绒尾 ===== */
    const tail = new THREE.Group();
    tail.position.set(0, top - 0.06, L / 2);
    bodyGroup.add(tail); parts.tail = tail;
    box(tail, mat(c.fur), 0, 0.05, 0, 0.13, 0.13, 0.10);

    // 四条黑腿：上段黑、下段近黑（无蹄）
    addLegs(g, parts, t, null, c.black, c.blackDeep);
    return { root: g, parts: parts };
  }

  // 四条腿：髋部为旋转支点，左右/前后对称
  function addLegs(g, parts, t, hoofColor, legColor, lowerColor) {
    const legMat = mat(legColor || 0xffffff);
    const hoofMat = hoofColor != null ? mat(hoofColor) : null;
    const lowMat = lowerColor != null ? mat(lowerColor) : null;
    const legW = t.legW || 0.13;
    const xs = [-1, 1], zs = [-1, 1];
    for (const sx of xs) {
      for (const sz of zs) {
        const hip = new THREE.Group();
        hip.position.set(sx * (t.bodyW / 2 - legW / 2 - 0.02),
                         t.legLen,
                         sz * (t.bodyLen / 2 - 0.14));
        const leg = box(hip, lowMat || legMat, 0, -t.legLen / 2, 0, legW, t.legLen, legW);
        if (lowMat && legColor) {
          box(hip, legMat, 0, -t.legLen * 0.28, 0, legW + 0.005, t.legLen * 0.5, legW + 0.005);
        }
        if (hoofMat) box(hip, hoofMat, 0, -t.legLen + 0.04, 0, legW + 0.01, 0.08, legW + 0.01);
        g.add(hip);
        parts.legs.push({ pivot: hip, phase: (sx === sz ? 0 : 1), front: sz === -1 });
      }
    }
  }

  // 僵尸：直立人形，双腿走路、双臂前伸（经典僵尸姿势），统一朝向 -Z
  function buildZombie(t) {
    const c = t.colors, g = new THREE.Group(), parts = { legs: [], arms: [] };
    const bodyGroup = new THREE.Group();
    g.add(bodyGroup); parts.bodyGroup = bodyGroup;
    const legLen = t.legLen, legW = 0.17;

    // 双腿：髋部为支点
    for (const sx of [-1, 1]) {
      const hip = new THREE.Group();
      hip.position.set(sx * 0.15, legLen, 0);
      box(hip, mat(c.pants), 0, -legLen / 2, 0, legW, legLen, legW + 0.02);
      bodyGroup.add(hip);
      parts.legs.push({ pivot: hip, phase: sx < 0 ? 0 : 1, front: false });
    }

    // 躯干（破旧蓝衣）
    box(bodyGroup, mat(c.shirt), 0, legLen + t.torsoH / 2, 0, 0.52, t.torsoH, 0.28);

    // 头 + 眼睛 + 嘴
    const head = new THREE.Group();
    head.position.set(0, legLen + t.torsoH + 0.23, 0);
    box(head, mat(c.skin), 0, 0, 0, 0.46, 0.46, 0.46);
    box(head, mat(c.eye), -0.11, 0.05, -0.235, 0.10, 0.10, 0.02);
    box(head, mat(c.eye), 0.11, 0.05, -0.235, 0.10, 0.10, 0.02);
    box(head, mat(c.eye), 0, -0.12, -0.235, 0.18, 0.06, 0.02);
    bodyGroup.add(head); parts.head = head;

    // 双臂：肩部为支点，前伸约 83°
    const shoulderY = legLen + t.torsoH - 0.1;
    for (const sx of [-1, 1]) {
      const sh = new THREE.Group();
      sh.position.set(sx * 0.33, shoulderY, 0);
      box(sh, mat(c.shirt), 0, -0.10, 0, 0.16, 0.24, 0.16);
      box(sh, mat(c.skin), 0, -0.42, 0, 0.14, 0.50, 0.14);
      sh.rotation.x = 1.45;
      bodyGroup.add(sh);
      parts.arms.push({ pivot: sh, phase: sx < 0 ? 0 : 1 });
    }
    return { root: g, parts: parts };
  }

  /* ---------------- 蜘蛛（统一朝向：头朝 -Z） ---------------- */

  function buildSpider(t) {
    const c = t.colors, g = new THREE.Group(), parts = { legs: [] };
    const bodyGroup = new THREE.Group();
    g.add(bodyGroup); parts.bodyGroup = bodyGroup;

    // 腹部（后段，大而扁圆）+ 暗红背纹
    box(bodyGroup, mat(c.bodyDark), 0, 0.42, 0.20, 0.62, 0.42, 0.60);
    box(bodyGroup, mat(c.body), 0, 0.47, 0.18, 0.50, 0.30, 0.44);
    box(bodyGroup, mat(c.mark), 0, 0.50, 0.42, 0.15, 0.10, 0.12);
    box(bodyGroup, mat(c.mark), 0, 0.635, 0.16, 0.07, 0.03, 0.20);
    // 头胸部（前段，略小略低）
    box(bodyGroup, mat(c.body), 0, 0.38, -0.26, 0.48, 0.34, 0.44);
    box(bodyGroup, mat(c.bodyDark), 0, 0.32, -0.30, 0.36, 0.15, 0.30);

    // 头部：四只红色复眼（自发光材质，暗里也醒目）+ 两颗毒牙
    const head = new THREE.Group();
    head.position.set(0, 0.40, -0.50);
    bodyGroup.add(head); parts.head = head;
    const mEye = new THREE.MeshBasicMaterial({ color: c.eye });
    box(head, mEye, -0.12, 0.04, -0.02, 0.10, 0.08, 0.04);
    box(head, mEye, 0.12, 0.04, -0.02, 0.10, 0.08, 0.04);
    box(head, mEye, -0.035, 0.065, -0.02, 0.05, 0.05, 0.03);
    box(head, mEye, 0.035, 0.065, -0.02, 0.05, 0.05, 0.03);
    box(head, mat(c.fang), -0.06, -0.10, 0.0, 0.05, 0.10, 0.04);
    box(head, mat(c.fang), 0.06, -0.10, 0.0, 0.05, 0.10, 0.04);

    // 八条腿：每侧四条，髋部在身体两侧；上段腿自带外展 + 前后扇角，
    // 下段腿折到地面。动画只绕髋部 x 轴前后摆动，对角四腿为一组交替
    const legZ = [-0.30, -0.11, 0.11, 0.30];    // 前 -> 后髋点
    const fan = [-0.5, -0.16, 0.16, 0.5];       // 每条腿的前后张角
    for (const sx of [-1, 1]) {
      for (let i = 0; i < 4; i++) {
        const hip = new THREE.Group();
        hip.position.set(sx * 0.24, 0.42, legZ[i]);
        const femur = box(hip, mat(c.leg), sx * 0.17, -0.09, 0, 0.08, 0.30, 0.08);
        femur.rotation.z = sx * 0.62;
        femur.rotation.y = fan[i];
        const knee = new THREE.Group();
        knee.position.set(sx * 0.26, -0.20, 0);
        const tibia = box(knee, mat(c.bodyDark), sx * 0.10, -0.10, 0, 0.06, 0.22, 0.06);
        tibia.rotation.z = sx * -0.35;
        hip.add(knee);
        bodyGroup.add(hip);
        // 对角步态：一侧 0/2 与另一侧 1/3 同相
        parts.legs.push({ pivot: hip, phase: (i + (sx > 0 ? 1 : 0)) % 2, front: i === 0 });
      }
    }
    return { root: g, parts: parts };
  }

  /* ---------------- 紫黑龙 Boss（低模切面雕塑：统一头朝 -Z；沿用拼豆版标定的五档灰+红眼 7 色） ----------------
     结构契约（updateDragonAnim / 联机镜像 / 喷火锚点依赖，勿改名）：
     bodyGroup 起伏 · pose 肩部俯仰 · neck 头颈 · jaw 下颌 · wings[{pivot,sx}] 扇翅
     arms[{pivot}] 前肢 · legs[{pivot,phase,front}] 后肢 · tail 盘尾 · mouth/mouthLight 喷火口
     所有几何按「枢轴 × 色号」合并三角汤，computeVertexNormals 后天然平面着色（切面感），约 40 批次 */

  function buildDragon(t) {
    const g = new THREE.Group();
    const parts = { legs: [], wings: [], arms: [], tailSegs: [] };

    // 五档灰 raw 值沿用拼豆版在 r128 光照管线下实机标定的反线性化值；红眼 MeshBasic 不受光
    const PAL = { H11: 0xf6f7ee, H3: 0xcaccc8, H4: 0x706e72, H5: 0x2e2d31, H6: 0x171518 };
    const lpCache = {};
    function lpMat(key) {
      if (!lpCache[key]) lpCache[key] = new THREE.MeshLambertMaterial({ color: PAL[key], flatShading: true });
      return lpCache[key];
    }
    const mMembrane = new THREE.MeshLambertMaterial({
      color: PAL.H6, flatShading: true, side: THREE.DoubleSide
    });
    const mEye = new THREE.MeshBasicMaterial({ color: 0xc01917, toneMapped: false });

    // ---- 几何收集器：同一枢轴、同一色号的所有三角面合并成一个 Mesh ----
    // 顶点逐面重复推入，computeVertexNormals 即得到平面法线，无需 smooth group
    const owners = new Map();
    function bag(owner, key) {
      let o = owners.get(owner);
      if (!o) { o = {}; owners.set(owner, o); }
      return o[key] || (o[key] = []);
    }
    const UP = new THREE.Vector3(0, 1, 0);
    const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _scl = new THREE.Vector3();
    const _va = new THREE.Vector3(), _vb = new THREE.Vector3();
    const _mid = new THREE.Vector3(), _dir = new THREE.Vector3();
    function bake(owner, key, geo, pos, scl) {
      if (geo.index) geo = geo.toNonIndexed();
      _m4.compose(pos, _q, scl);
      geo.applyMatrix4(_m4);
      const src = geo.attributes.position.array, out = bag(owner, key);
      for (let i = 0; i < src.length; i++) out.push(src[i]);
    }
    // 圆台段 a->b，两端半径 ra/rb，sides 边切面，sx/sz 为椭圆截面附加缩放
    function seg(owner, key, a, b, ra, rb, sides, sx, sz) {
      const geo = new THREE.CylinderGeometry(rb, ra, 1, sides, 1);
      _va.fromArray(a); _vb.fromArray(b);
      _dir.subVectors(_vb, _va); const len = _dir.length();
      _mid.addVectors(_va, _vb).multiplyScalar(0.5);
      _q.setFromUnitVectors(UP, _dir.normalize());
      _scl.set(sx || 1, len, sz || 1);
      bake(owner, key, geo, _mid, _scl);
    }
    // 锥形棘/角/爪：base 到 tip（tip 端为尖）
    function spike(owner, key, base, tip, r, sides) {
      const geo = new THREE.ConeGeometry(r, 1, sides || 5, 1);
      _va.fromArray(base); _vb.fromArray(tip);
      _dir.subVectors(_vb, _va); const len = _dir.length();
      _mid.addVectors(_va, _vb).multiplyScalar(0.5);
      _q.setFromUnitVectors(UP, _dir.normalize());
      _scl.set(1, len, 1);
      bake(owner, key, geo, _mid, _scl);
    }
    function block(owner, key, c, w, h, d, rx, ry, rz) {
      _q.setFromEuler(new THREE.Euler(rx || 0, ry || 0, rz || 0));
      _scl.set(1, 1, 1);
      bake(owner, key, new THREE.BoxGeometry(w, h, d), _mid.fromArray(c), _scl);
    }
    function flush(owner) {
      const o = owners.get(owner);
      if (!o) return;
      for (const key in o) {
        const data = o[key];
        if (!data.length) continue;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute(data, 3));
        geo.computeVertexNormals();
        owner.add(new THREE.Mesh(geo, lpMat(key)));
      }
    }

    // 蝙蝠翼：肩->肘->腕为前缘，4 根指骨撑开波浪形后缘；翼膜为 DoubleSide 面片
    function makeWing(pivot, s) {
      const sh = [0, 0, 0], el = [s * .30, .13, -.04], wr = [s * .62, .26, .02];
      const p1 = [s * 1.55, .42, .05], p2 = [s * 1.60, -.06, .05],
            p3 = [s * 1.28, -.46, .05], p4 = [s * .78, -.58, .05], rb = [s * .05, -.34, .05];
      // 相邻指骨间的内凹点（朝腕部回拉 k，略下沉），做出翼膜扇贝波浪
      function scoop(a, b, k) {
        const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2 + .03];
        return [m[0] + (wr[0] - m[0]) * k, m[1] + (wr[1] - m[1]) * k, m[2]];
      }
      const ring = [el, wr, p1, scoop(p1, p2, .14), p2, scoop(p2, p3, .14),
                    p3, scoop(p3, p4, .14), p4, scoop(p4, rb, .20), rb];
      // 以肩为极点扇形三角化（翼形相对肩为星形多边形）
      const v = [];
      const pushP = p => v.push(p[0], p[1], p[2]);
      for (let i = 0; i < ring.length - 1; i++) { pushP(sh); pushP(ring[i]); pushP(ring[i + 1]); }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
      geo.computeVertexNormals();
      pivot.add(new THREE.Mesh(geo, mMembrane));
      // 翼骨 + 翼爪 + 肩肌
      seg(pivot, "H5", sh, el, .085, .060, 6);
      seg(pivot, "H5", el, wr, .060, .045, 6);
      seg(pivot, "H5", wr, p1, .045, .016, 5);
      seg(pivot, "H5", wr, p2, .040, .013, 5);
      seg(pivot, "H5", wr, p3, .034, .011, 5);
      seg(pivot, "H5", wr, p4, .028, .010, 5);
      seg(pivot, "H6", sh, rb, .038, .020, 5);
      spike(pivot, "H6", wr, [wr[0] + s * .18, wr[1] - .05, wr[2] + .10], .026, 4);
      block(pivot, "H6", [s * .06, -.02, 0], .16, .14, .14);
      flush(pivot);
    }

    // 层级：g -> bodyGroup（起伏）-> pose（肩部俯仰）-> form（平移到设计坐标原点）
    const bodyGroup = new THREE.Group();
    g.add(bodyGroup); parts.bodyGroup = bodyGroup;
    const pose = new THREE.Group();
    pose.position.set(0, 1.55, 0.18);
    bodyGroup.add(pose); parts.pose = pose;
    const form = new THREE.Group();
    form.position.set(0, -1.55, -0.18);
    pose.add(form);

    /* ----- 躯干（form 内为设计坐标，肩点 0,1.55,.18） ----- */
    seg(form, "H6", [0, .42, .10], [0, .58, .11], .34, .38, 8, 1, .9);       // 臀下暗底
    seg(form, "H5", [0, .50, .12], [0, 1.10, .12], .40, .34, 8, 1, .92);     // 臀核
    seg(form, "H5", [0, 1.00, -.02], [0, 1.74, -.02], .33, .40, 8, .86, .82);// 胸腔上扩
    seg(form, "H6", [0, 1.66, .04], [0, 1.84, .06], .30, .26, 7, .9, .85);   // 颈领
    block(form, "H4", [0, 1.30, -.33], .42, .58, .10, -.12, 0, 0);           // 胸前亮板
    block(form, "H4", [0, .86, -.24], .30, .20, .08);                        // 腹前亮鳞
    const spineBase = [[0, .58, .46], [0, .82, .48], [0, 1.06, .44], [0, 1.30, .36], [0, 1.52, .28]];
    for (const p of spineBase) spike(form, "H6", p, [p[0], p[1] + .13, p[2] + .05], .05, 5);

    /* ----- 颈（枢轴设计点 0,1.80,.12；以下为颈局部坐标） ----- */
    const neck = new THREE.Group();
    neck.position.set(0, 1.80, .12);
    form.add(neck); parts.neck = neck; parts.head = neck;
    seg(neck, "H5", [0, -.20, .03], [0, .06, .02], .245, .255, 7, .82, .95);
    seg(neck, "H5", [0, .06, .02], [0, .30, -.06], .255, .22, 7, .82, .95);
    seg(neck, "H5", [0, .30, -.06], [0, .52, -.16], .22, .19, 7, .82, .95);
    seg(neck, "H5", [0, .52, -.16], [0, .72, -.26], .19, .165, 7, .82, .95);
    block(neck, "H4", [0, .14, -.20], .22, .10, .06);                        // 喉鳞
    block(neck, "H4", [0, .38, -.29], .18, .09, .05);
    spike(neck, "H6", [0, -.04, .25], [0, -.02, .38], .05, 5);
    spike(neck, "H6", [0, .20, .19], [0, .22, .32], .045, 5);
    spike(neck, "H6", [0, .42, .07], [0, .45, .20], .042, 5);
    spike(neck, "H6", [0, .60, -.07], [0, .64, .05], .038, 5);

    /* ----- 头颅（颈局部） ----- */
    block(neck, "H5", [0, .86, -.26], .50, .40, .46);                        // 脑壳
    block(neck, "H5", [0, 1.00, -.17], .34, .15, .30);                       // 颅顶
    seg(neck, "H5", [0, .76, -.36], [0, .76, -.78], .19, .13, 6, 1.25, .85); // 锥形吻
    block(neck, "H6", [0, .99, -.42], .52, .09, .10);                        // 眉脊
    block(neck, "H4", [0, .87, -.58], .26, .05, .28);                        // 鼻梁
    block(neck, "H6", [-.09, .79, -.80], .055, .045, .03);                   // 鼻孔
    block(neck, "H6", [ .09, .79, -.80], .055, .045, .03);
    for (const s of [-1, 1]) {
      seg(neck, "H6", [s * .16, .96, -.12], [s * .25, 1.16, -.03], .075, .05, 6);  // 大角 2 节
      seg(neck, "H6", [s * .25, 1.16, -.03], [s * .21, 1.36, .13], .05, .018, 6);
      seg(neck, "H6", [s * .07, .98, .00], [s * .05, 1.14, .12], .04, .012, 5);     // 副角
      spike(neck, "H6", [s * .25, .80, -.22], [s * .39, .85, -.18], .045, 5);       // 上颊刺
      spike(neck, "H6", [s * .22, .64, -.10], [s * .34, .57, -.07], .04, 5);        // 下颊刺
    }
    spike(neck, "H6", [0, 1.00, -.34], [0, 1.13, -.38], .04, 5);             // 鼻角
    for (const s of [-1, 1]) {
      block(neck, "H6", [s * .175, .87, -.46], .15, .09, .04, 0, s * -.22, 0);     // 眼窝
      const eye = new THREE.Mesh(new THREE.BoxGeometry(.11, .05, .04), mEye);       // 发光红眼缝
      eye.position.set(s * .185, .88, -.505);
      eye.rotation.y = s * -.22;
      neck.add(eye);
    }
    flush(neck);

    /* ----- 下颌（枢轴在头后铰链，喷火时绕 X 张开） ----- */
    const jaw = new THREE.Group();
    jaw.position.set(0, .62, -.22);
    neck.add(jaw); parts.jaw = jaw;
    seg(jaw, "H6", [0, .02, -.02], [0, 0, -.44], .13, .09, 6, 1.25, .75);
    block(jaw, "H6", [0, 0, -.47], .20, .10, .08);
    block(jaw, "H4", [0, .05, -.20], .16, .04, .18);
    spike(jaw, "H11", [-.08, 0, -.36], [-.08, -.09, -.39], .02, 4);
    spike(jaw, "H11", [ .08, 0, -.36], [ .08, -.09, -.39], .02, 4);
    flush(jaw);

    /* ----- 前肢（小；枢轴设计点 ±.30,1.20,.10） ----- */
    for (const s of [-1, 1]) {
      const a = new THREE.Group();
      a.position.set(s * .30, 1.20, .10);
      form.add(a); parts.arms.push({ pivot: a });
      seg(a, "H6", [0, .04, .04], [s * .04, -.06, -.06], .11, .10, 6);          // 肩甲
      seg(a, "H5", [0, 0, 0], [s * .06, -.22, -.16], .10, .075, 6, .9, 1);      // 上臂
      seg(a, "H6", [s * .06, -.22, -.16], [s * .10, -.42, -.32], .075, .055, 6);// 前臂
      block(a, "H4", [s * .07, -.24, -.15], .08, .08, .08);
      block(a, "H5", [s * .10, -.47, -.42], .14, .10, .18);                     // 手
      for (const k of [-1, 0, 1])
        spike(a, "H6", [s * (.09 + .04 * k), -.51, -.49], [s * (.11 + .04 * k), -.55, -.59], .022, 4);
      flush(a);
    }

    /* ----- 后肢（粗壮蹲坐；枢轴设计点 ±.40,.80,.12） ----- */
    for (const s of [-1, 1]) {
      const l = new THREE.Group();
      l.position.set(s * .40, .80, .12);
      form.add(l); parts.legs.push({ pivot: l, phase: s > 0 ? 0 : 1, front: false });
      block(l, "H6", [0, 0, .02], .22, .18, .22);                              // 髋臼
      seg(l, "H5", [0, .02, .02], [s * .10, -.28, .10], .19, .15, 7, 1.05, 1); // 大腿
      block(l, "H4", [s * .12, -.30, .05], .13, .09, .10);                     // 膝甲
      seg(l, "H6", [s * .10, -.28, .08], [s * .14, -.50, -.14], .14, .10, 7);  // 小腿
      block(l, "H5", [s * .15, -.55, -.30], .24, .13, .36);                    // 脚掌
      block(l, "H4", [s * .15, -.50, -.40], .22, .05, .12);
      for (const k of [-1, 0, 1])
        spike(l, "H6", [s * (.09 + .06 * k), -.58, -.46], [s * (.09 + .06 * k), -.61, -.58], .03, 4);
      flush(l);
    }

    /* ----- 粗长盘尾（枢轴在臀核 0,.88,.28；路径沿趴姿「贴地向后」方向设计：
       局部 (0,-.95,.32) 经 pose -1.30° 横卧后恰好水平指地，随后向右盘绕收尖，
       背部（局部 +Z）一列渐矮棘刺；飞行时随枢轴旋转整体后拖） ----- */
    const tail = new THREE.Group();
    tail.position.set(0, .88, .28);
    form.add(tail); parts.tail = tail;
    const TAIL_P = [
      [0, -.02, -.02], [0, -.22, .05], [0, -.42, .12], [.01, -.62, .18],
      [.04, -.82, .22], [.10, -1.00, .24], [.20, -1.16, .22], [.34, -1.28, .16],
      [.50, -1.34, .06], [.66, -1.32, -.06], [.80, -1.22, -.18], [.90, -1.06, -.28],
      [.92, -.88, -.34], [.82, -.72, -.36]
    ];
    const TAIL_R = [.205, .20, .19, .175, .16, .142, .124, .106, .09, .074, .058, .042, .03];
    for (let i = 0; i < TAIL_P.length - 1; i++) {
      seg(tail, i < 4 ? "H5" : "H6", TAIL_P[i], TAIL_P[i + 1], TAIL_R[i], TAIL_R[i + 1] || .012, 7);
    }
    spike(tail, "H6", TAIL_P[12], TAIL_P[13], .03, 6);                        // 尖尾梢
    const spineN = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    for (let i = 0; i < spineN.length; i++) {
      const P = TAIL_P[spineN[i]], r = TAIL_R[spineN[i]], h = .19 - i * .013;
      spike(tail, i < 3 ? "H5" : "H6",
            [P[0], P[1], P[2] + r * .85], [P[0], P[1], P[2] + r * .85 + h],
            Math.max(.022, .045 - i * .0025), 5);
    }
    flush(tail);

    /* ----- 翼（枢轴设计点 ±.42,1.60,.06；rotation.z = sx*raise 扇翅） ----- */
    for (const s of [-1, 1]) {
      const w = new THREE.Group();
      w.position.set(s * .42, 1.60, .06);
      form.add(w); parts.wings.push({ pivot: w, sx: s });
      makeWing(w, s);
    }
    flush(form);

    // 喷火口贴在吻尖（火球/锥形火焰出生点）+ 动态火光
    const mouth = new THREE.Object3D();
    mouth.position.set(0, .78, -.84);
    neck.add(mouth); parts.mouth = mouth;
    const mouthLight = new THREE.PointLight(0xff7a24, 0, 18, 2);
    mouth.add(mouthLight); parts.mouthLight = mouthLight;

    return { root: g, parts: parts };
  }

  const BUILDERS = { pig: buildPig, dog: buildDog, cow: buildCow, sheep: buildSheep, panda: buildPanda, zombie: buildZombie, spider: buildSpider, dragon: buildDragon };

  /* ---------------- 头顶血条（懒加载精灵） ---------------- */

  function createHealthBar() {
    const canvas = document.createElement("canvas");
    canvas.width = 64; canvas.height = 12;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(canvas), depthTest: true, depthWrite: false
    }));
    sprite.scale.set(0.95, 0.18, 1);
    sprite.visible = false;
    return { sprite: sprite, canvas: canvas };
  }

  function drawHealthBar(bar, ratio, boss) {
    const ctx = bar.canvas.getContext("2d");
    ctx.clearRect(0, 0, 64, 12);
    ctx.fillStyle = "rgba(0,0,0,.7)";
    ctx.fillRect(0, 0, 64, 12);
    const w = Math.max(0, Math.round(58 * ratio));
    if (boss) {
      // 与屏幕顶部 Boss 血条同系：火橙 → 灼红 → 暗红（紫黑龙配色去除一切紫色）
      ctx.fillStyle = ratio > 0.5 ? "#ff7a2e" : ratio > 0.25 ? "#e0463a" : "#a41d12";
    } else {
      ctx.fillStyle = ratio > 0.5 ? "#5fd35f" : ratio > 0.25 ? "#e8c341" : "#e04a3a";
    }
    ctx.fillRect(3, 3, w, 6);
    spriteTexture(bar).needsUpdate = true;
  }
  function spriteTexture(bar) { return bar.sprite.material.map; }

  /* ---------------- 实体 / 掉落物 ---------------- */

  let scene = null;
  let world = null;
  let mobs = [];
  let drops = [];
  let walkPhaseT = 0;
  let mountMob = null;
  let sunBurnActive = false;   // 白天烈日：露天僵尸燃烧（由天气系统驱动）
  let dragonSlain = false;     // 本局紫黑龙是否已被击杀（存档用）
  const bossFires = [];        // 龙炎留下的地面火焰
  const bossFireballs = [];    // 龙吐出的火球
  let fxTime = 0;
  const _mouthPos = new THREE.Vector3();
  const _lightPos = new THREE.Vector3();
  let hooks = {
    burst: function () {},   // (x, y, z, colorHex)
    hurtPlayer: function () { return false; },  // (amount, attackerMob) -> 是否真的造成伤害
    toast: function () {},
    // 房主侧：Boss 吐出火球时回调，balls=[{x,y,z,vx,vy,vz}]，由玩法层转发给客人做纯表现镜像
    bossBalls: function () {}
  };

  // 掉落物专用：物品栏 16×16 图标 dataURL（由 game.init 传入），
  // 以及 dataURL -> THREE 纹理缓存
  let itemIcons = null;
  // 世界纹理图集：方块掉落物直接取 [顶,侧,底] tile 贴迷你 3D 方块，
  // 外观与世界中放置的方块逐像素一致（草顶/草沿/泥侧）
  let atlasTexture = null;
  const dropIconTex = {};
  const dropTileMats = {};
  function dropIconTexture(itemId) {
    if (dropIconTex[itemId]) return dropIconTex[itemId];
    const url = itemIcons && itemIcons[itemId];
    if (!url) return null;
    const img = new Image();
    const tex = new THREE.Texture(img);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    // 与手持图标一致显式 sRGB，否则颜色发白
    if (THREE.sRGBEncoding) tex.encoding = THREE.sRGBEncoding;
    img.onload = function () { tex.needsUpdate = true; };
    img.src = url;
    dropIconTex[itemId] = tex;
    return tex;
  }

  // 方块掉落物的边长（约 1/4 格，贴近原版掉落方块比例）
  const DROP_BLOCK_SIZE = 0.26;

  // 图集某 tile 的 Lambert 材质（克隆图集纹理后按 tile 设 repeat/offset）。
  // 与世界 / 手持共用同一张 CanvasTexture，最近邻过滤保留像素颗粒。
  function dropTileMaterial(tile) {
    if (dropTileMats[tile]) return dropTileMats[tile];
    const tex = atlasTexture.clone();
    tex.needsUpdate = true;
    const uv = tileUV(tile);              // [u0, v0, u1, v1]
    tex.repeat.set(uv[2] - uv[0], uv[3] - uv[1]);
    tex.offset.set(uv[0], uv[1]);
    // alphaTest：火把 / 玻璃等镂空 tile 的透明像素不绘制，普通方块无影响。
    // emissiveMap 用同一 tile 轻微自发光：夜晚掉落物也清晰可辨（贴近原版），
    // 白天光照充足时几乎看不出差异
    const m = new THREE.MeshLambertMaterial({
      map: tex, alphaTest: 0.5,
      emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.18
    });
    dropTileMats[tile] = m;
    return m;
  }

  // 普通方块掉落物：六面按 [顶,侧,底] 贴图的迷你立方体（草方块 = 草顶 + 草沿泥侧 + 泥底）
  function buildDropBlockCube(itemId) {
    const tiles = BLOCK_TILES[itemId];
    if (!tiles) return null;
    const side = dropTileMaterial(tiles[1]);
    const top = dropTileMaterial(tiles[0]);
    const bottom = dropTileMaterial(tiles[2]);
    // BoxGeometry 材质顺序：+x, -x, +y(顶), -y(底), +z, -z
    const cube = new THREE.Mesh(GEO, [side, side, top, bottom, side, side]);
    cube.scale.set(DROP_BLOCK_SIZE, DROP_BLOCK_SIZE, DROP_BLOCK_SIZE);
    return cube;
  }

  // mod 异形方块（半砖 / 楼梯 / 门 / 玻璃 / 灯…）：重放 customMeshes 盒列表
  // 生成迷你 3D 模型，与手持外观一致；重放失败（如交叉面片作物）回退整方块
  function buildDropCustomBlock(itemId) {
    const boxes = [];
    const api = {
      world: { getBlock: function () { return 0; } },
      x: 0, y: 0, z: 0,
      box: function (x0, y0, z0, x1, y1, z1, tile) { boxes.push({ b: [x0, y0, z0, x1, y1, z1], tile: tile, unlit: false }); },
      unlitBox: function (x0, y0, z0, x1, y1, z1, tile) { boxes.push({ b: [x0, y0, z0, x1, y1, z1], tile: tile, unlit: true }); },
      cutoutBox: function (x0, y0, z0, x1, y1, z1, tile) { boxes.push({ b: [x0, y0, z0, x1, y1, z1], tile: tile, unlit: false }); },
      glowBox: function () {}
    };
    try {
      GameRegistry.customMeshes[itemId](api);
    } catch (e) {
      return buildDropBlockCube(itemId);
    }
    if (!boxes.length) return buildDropBlockCube(itemId);
    const g = new THREE.Group();
    for (const it of boxes) {
      const b = it.b;
      const w = Math.max(0.001, b[3] - b[0]), h = Math.max(0.001, b[4] - b[1]), d = Math.max(0.001, b[5] - b[2]);
      let m = dropTileMaterial(it.tile);
      if (it.unlit) {
        const key = "u" + it.tile;
        if (!dropTileMats[key]) dropTileMats[key] = new THREE.MeshBasicMaterial({ map: m.map });
        m = dropTileMats[key];
      }
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      mesh.position.set((b[0] + b[3]) / 2 - 0.5, (b[1] + b[4]) / 2 - 0.5, (b[2] + b[5]) / 2 - 0.5);
      g.add(mesh);
    }
    g.scale.setScalar(DROP_BLOCK_SIZE);
    return g;
  }

  // 拥有像素图标的掉落物（生猪排 / 生牛排 / 生羊肉 / 羊毛）：在世界里竖立
  // 一张双面图标片旋转浮动，外观与背包 / 手持完全一致；其余掉落物仍是彩色小方块。
  // 玩家主动丢弃的物品强制使用背包图标（工具 / 装备都能一眼认出）
  const ICON_DROP_SIZE = {};
  ICON_DROP_SIZE[ITEM.PORKCHOP] = 0.3;
  ICON_DROP_SIZE[ITEM.BEEF] = 0.3;
  ICON_DROP_SIZE[ITEM.MUTTON] = 0.3;
  ICON_DROP_SIZE[ITEM.WOOL] = 0.3;
  function buildDropMesh(itemId, forceIcon) {
    // 方块：优先渲染与世界同款的迷你 3D 贴图方块（图2 的草方块效果），
    // mod 异形方块回放其自定义模型
    if (atlasTexture && BLOCK_TILES[itemId]) {
      if (typeof GameRegistry !== "undefined" && GameRegistry.customMeshes[itemId]) {
        const custom = buildDropCustomBlock(itemId);
        if (custom) return custom;
      } else {
        return buildDropBlockCube(itemId);
      }
    }
    let size = ICON_DROP_SIZE[itemId];
    // 注册过背包像素图标的物品（含 mod 物品 / 玩家丢弃物）在世界里一律竖图标片，
    // 与物品栏外观一致；没有图标的才退化为彩色小方块
    if (!size && itemIcons && itemIcons[itemId]) size = 0.32;
    if (size) {
      const tex = dropIconTexture(itemId);
      if (tex) {
        return new THREE.Mesh(
          new THREE.PlaneGeometry(size, size),
          new THREE.MeshBasicMaterial({
            map: tex, transparent: true, alphaTest: 0.5,
            side: THREE.DoubleSide
          })
        );
      }
    }
    const cube = new THREE.Mesh(GEO, mat(DROP_COLORS[itemId] || 0xffffff));
    cube.scale.set(0.24, 0.24, 0.24);
    return cube;
  }

  const Mobs = {
    init(scn, icons, atlasTex) {
      scene = scn;
      itemIcons = icons || null;
      atlasTexture = atlasTex || null;
      mobs = [];
      drops = [];
      mountMob = null;
      dragonSlain = false;
      clearBossFx();
      hideBossHud();
    },

    bindHooks(h) { for (const k in h) hooks[k] = h[k]; },

    // 存档：只序列化已驯服的动物（野生动物读档后重新随机投放）
    serializeTamed() {
      const out = [];
      for (const m of mobs) {
        if (!m.owner || m.dead) continue;
        out.push({
          type: m.type,
          x: m.pos.x, y: m.pos.y, z: m.pos.z,
          yaw: m.yaw,
          hp: Math.min(m.hp, m.maxHp),
          sitting: !!m.sitting
        });
      }
      return out;
    },

    // 读档：在野生动物投放完成后恢复驯服动物
    restoreTamed(list) {
      let n = 0;
      for (const r of list || []) {
        if (!TYPES[r.type]) continue;
        const m = this.spawn(r.type, r.x, r.y, r.z);
        m.owner = true;
        m.sitting = !!r.sitting;
        m.mode = "idle"; m.modeT = 0;
        m.target = null;
        m.maxHp = TYPES[r.type].tamedHp || TYPES[r.type].hp;
        m.hp = Math.max(1, Math.min(r.hp || m.maxHp, m.maxHp));
        m.yaw = r.yaw || 0;
        m.renderYaw = m.yaw;
        m.root.rotation.y = m.renderYaw;
        if (m.parts.tag) m.parts.tag.visible = true;
        n++;
      }
      return n;
    },

    get count() { return mobs.length; },
    // 调试用：返回真实 mob 对象数组（供控制台/自动化测试）
    debugRaw() { return mobs.slice(); },
    // 调试用：掉落物快照
    debugDrops() { return drops.map(d => ({ id: d.id, count: d.count, dur: d.dur, x: d.group.position.x, y: d.group.position.y, z: d.group.position.z, age: d.age })); },
    // 调试用：Boss 特效计数（地面龙炎 / 飞行火球）
    debugBossFx() { return { fires: bossFires.length, fireballs: bossFireballs.length, slain: dragonSlain }; },
    list() {
      return mobs.map(m => ({
        type: m.type, name: TYPES[m.type].name,
        x: m.pos.x, y: m.pos.y, z: m.pos.z,
        hp: m.hp, maxHp: m.maxHp,
        tamed: !!m.owner, sitting: !!m.sitting,
        mode: m.dead ? "dead" : (m.target ? "fight" : m.mode),
        ridden: m === mountMob,
        baby: !!m.baby, grow: Math.ceil(m.growT),
        love: m.loveT > 0, breeding: m.breedT > 0,
        breedCd: Math.ceil(m.breedCd)
      }));
    },

    // 在世界草地上随机投放动物（带尝试上限与计数，避免随机落空）
    populate(w, opts) {
      world = w;
      opts = opts || {};
      const perType = opts.perType != null ? opts.perType : 6;
      const maxAttempts = opts.maxAttempts || 1200;
      const avoid = opts.avoidCenter || null;
      const types = ANIMAL_TYPES;
      const got = {};
      for (const ty of types) got[ty] = 0;
      let target = perType * types.length;
      let attempts = 0;

      while (target > 0 && attempts < maxAttempts) {
        attempts++;
        const type = types[attempts % types.length];
        if (got[type] >= perType) continue;
        // 无限世界：动物只投放在出生点周围 ±120 格（远离的区域靠探索时不主动刷动物）
        const ax = avoid ? avoid.x : 0, az = avoid ? avoid.z : 0;
        const x = Math.floor(ax - 120 + Math.random() * 240);
        const z = Math.floor(az - 120 + Math.random() * 240);
        const h = w.heightAt(x, z);
        if (h <= w.SEA + 1) continue;
        if (w.getBlock(x, h, z) !== BLOCK.GRASS) continue;
        if (w.getBlock(x, h + 1, z) !== BLOCK.AIR) continue;
        if (w.getBlock(x, h + 2, z) !== BLOCK.AIR) continue;
        if (avoid && Math.abs(x - avoid.x) < 6 && Math.abs(z - avoid.z) < 6) continue;
        this.spawn(type, x + 0.5, h + 1, z + 0.5);
        got[type]++;
        target--;
      }

      // 熊猫：珍稀动物，只栖身在竹林群系。扫描出生点周围并把相邻的竹林格子
      // 聚成一片片竹林；【每片竹林独立掷骰】——多数竹林遇不到熊猫，有幸遇到
      // 的那片也只有一两只，绝不成群。不同竹林互不影响。
      const BAMBOO_BIOME = global.BIOME ? global.BIOME.BAMBOO : 10;
      got.panda = 0;
      let pandaAttempts = 0;
      const self = this;
      const pandaSpotOK = function (x, z) {
        if (w.biomeAt && w.biomeAt(x, z) !== BAMBOO_BIOME) return false;
        const h = w.heightAt(x, z);
        if (h <= w.SEA + 1) return false;
        if (w.getBlock(x, h, z) !== BLOCK.GRASS) return false;
        if (w.getBlock(x, h + 1, z) !== BLOCK.AIR) return false;
        if (w.getBlock(x, h + 2, z) !== BLOCK.AIR) return false;
        if (avoid && Math.abs(x - avoid.x) < 6 && Math.abs(z - avoid.z) < 6) return false;
        return h;
      };

      // 在一片竹林的采样格中选点投放一只熊猫，连续找 12 个点都不合用则放弃
      const placeOneInPatch = function (cells, N, ax0, az0) {
        for (let t = 0; t < 12; t++) {
          pandaAttempts++;
          const id = cells[(Math.random() * cells.length) | 0];
          const ci = id / N | 0, cj = id % N;
          const x = ax0 - 120 + ci * 4 + ((Math.random() * 4) | 0);
          const z = az0 - 120 + cj * 4 + ((Math.random() * 4) | 0);
          const h = pandaSpotOK(x, z);
          if (h) { self.spawn("panda", x + 0.5, h + 1, z + 0.5); got.panda++; return true; }
        }
        return false;
      };

      if (opts.pandas != null) {
        // 显式总数覆盖（调试用）：在范围内随机竹林里补到指定数量
        let guard = 0;
        while (got.panda < opts.pandas && guard++ < 1800) {
          const x = Math.floor((avoid ? avoid.x : 0) - 120 + Math.random() * 240);
          const z = Math.floor((avoid ? avoid.z : 0) - 120 + Math.random() * 240);
          const h = pandaSpotOK(x, z);
          if (h) { this.spawn("panda", x + 0.5, h + 1, z + 0.5); got.panda++; }
        }
      } else if (w.biomeAt) {
        const ax0 = avoid ? avoid.x : 0, az0 = avoid ? avoid.z : 0;
        // 步长 4 采样 ±120 格的竹林网格（61×61）
        const N = 61;
        const grid = new Uint8Array(N * N);
        for (let i = 0; i < N; i++) {
          for (let j = 0; j < N; j++) {
            if (w.biomeAt(ax0 - 120 + i * 4, az0 - 120 + j * 4) === BAMBOO_BIOME) {
              grid[i * N + j] = 1;
            }
          }
        }
        // 4 邻接连通域 = 一片竹林；面积太小（<5 个采样格 ≈ 80㎡）的不算
        const seen = new Uint8Array(N * N);
        for (let s = 0; s < N * N; s++) {
          if (!grid[s] || seen[s]) continue;
          const cells = [];
          const stack = [s]; seen[s] = 1;
          while (stack.length) {
            const id = stack.pop();
            cells.push(id);
            const ci = id / N | 0, cj = id % N;
            const nb = [id - N, id + N, cj > 0 ? id - 1 : -1, cj < N - 1 ? id + 1 : -1];
            for (const q of nb) {
              if (q >= 0 && grid[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
            }
          }
          if (cells.length < 5) continue;
          // 本片竹林的熊猫数量权重：0 只=65（多数遇不到），1 只=25（偶遇），2 只=10（运气好）
          const W = [65, 25, 10];
          let r = Math.random() * 100, want = 0, acc = 0;
          for (let q = 0; q < W.length; q++) { acc += W[q]; if (r < acc) { want = q; break; } }
          for (let k = 0; k < want; k++) placeOneInPatch(cells, N, ax0, az0);
        }
      }
      return { placed: got, attempts: attempts, pandaAttempts: pandaAttempts };
    },

    // 夜晚在玩家周围 14~28 格环形地表生成一只僵尸（失败返回 null）
    spawnZombie(w, p) {
      w = w || world;
      if (!w || !p) return null;
      for (let i = 0; i < 24; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = 14 + Math.random() * 14;
        const x = Math.floor(p.x + Math.cos(a) * r);
        const z = Math.floor(p.z + Math.sin(a) * r);
        const h = w.heightAt(x, z);
        if (h <= w.SEA + 1) continue;
        if (w.getBlock(x, h, z) === BLOCK.WATER) continue;
        if (w.getBlock(x, h + 1, z) !== BLOCK.AIR) continue;
        if (w.getBlock(x, h + 2, z) !== BLOCK.AIR) continue;
        const m = this.spawn("zombie", x + 0.5, h + 1, z + 0.5);
        m.mode = "hunt";
        return m;
      }
      return null;
    },

    // 夜晚在玩家周围 12~26 格环形地表生成一只蜘蛛（低矮，一格净空即可；失败返回 null）
    spawnSpider(w, p) {
      w = w || world;
      if (!w || !p) return null;
      for (let i = 0; i < 24; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = 12 + Math.random() * 14;
        const x = Math.floor(p.x + Math.cos(a) * r);
        const z = Math.floor(p.z + Math.sin(a) * r);
        const h = w.heightAt(x, z);
        if (h <= w.SEA + 1) continue;
        if (w.getBlock(x, h, z) === BLOCK.WATER) continue;
        if (w.getBlock(x, h + 1, z) !== BLOCK.AIR) continue;
        const m = this.spawn("spider", x + 0.5, h + 1, z + 0.5);
        m.mode = "hunt";
        m.leapCd = 0.6 + Math.random();
        return m;
      }
      return null;
    },

    // 当前存活的敌对生物数量（Boss 不占僵尸刷怪上限）
    countMonsters() {
      let n = 0;
      for (const m of mobs) if (!m.dead && m.cfg.hostile && !m.cfg.boss) n++;
      return n;
    },

    /* ---------------- 火山 Boss：紫黑龙 ---------------- */

    // 在火山口上空生成紫黑龙；已存在则直接返回。
    // vc：游戏层探测到的火山中心 {x,z}（无限世界用 world.findVolcano 得到）；
    // 缺省时退回在原点宏观牌范围内搜索。找不到火山返回 null
    spawnDragon(w, vc) {
      w = w || world;
      if (!w) return null;
      world = w;
      const existing = mobs.find(m => m.type === "dragon" && !m.dead);
      if (existing) return existing;
      if (!vc) vc = w.findVolcano ? w.findVolcano(0, 0, 8) : null;
      if (!vc) return null;

      // 火山口周围半径 9 内的最高一格，作为盘旋高度基准
      const hx = Math.round(vc.x), hz = Math.round(vc.z);
      let top = w.SEA || 14;
      for (let x = hx - 9; x <= hx + 9; x++) {
        for (let z = hz - 9; z <= hz + 9; z++) {
          const h = w.heightAt(x, z);
          if (h > top) top = h;
        }
      }
      // 趴伏点：火口外肩（r6-8）上「岩浆最少、足够高」的扇区。火山锥上部被熔岩湖与
      // 放射状岩浆河密布、还插着固定岩浆点光，自然地形既放不下横卧龙躯+整根盘尾，侧身还会
      // 被映成奶白。故在此扇区铺一块天然玄武岩趴台（龙背朝火口、头颈朝崖外前伸）。
      const SEA_L = w.SEA || 14;
      const isLavaId = id => id === BLOCK.LAVA || id === BLOCK.FLOW_LAVA ||
                            id === BLOCK.FLOW_LAVA_2 || id === BLOCK.FLOW_LAVA_3;
      let site = null, siteScore = -Infinity;
      for (let r = 6; r <= 8; r++) {
        for (let k = 0; k < 64; k++) {
          const ang = k / 64 * Math.PI * 2;
          const ax = Math.round(vc.x + Math.cos(ang) * r), az = Math.round(vc.z + Math.sin(ang) * r);
          const ah = w.heightAt(ax, az);
          if (ah <= SEA_L + 6) continue;                 // 必须仍在火山肩高位
          if (w.getBlock(ax, ah + 1, az) !== 0) continue;
          let lavaN = 0;
          for (let dx = -6; dx <= 6; dx++) {
            for (let dz = -6; dz <= 6; dz++) {
              if (dx * dx + dz * dz > 40) continue;
              for (let dy = -3; dy <= 5; dy++) if (isLavaId(w.getBlock(ax + dx, ah + dy, az + dz))) lavaN++;
            }
          }
          let flat = 0;
          for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
              const nh = w.heightAt(ax + dx, az + dz);
              if (Math.abs(nh - ah) <= 1 && w.getBlock(ax + dx, nh + 1, az + dz) === 0) flat++;
            }
          }
          // 崖外视野硬约束：龙朝径向外侧趴，u+3..8 必须是下行开阔坡。
          // 否则会选到「面朝高山脊 / 陡海崖」的扇区，岩舌削不动、坡下仰望只见墙。
          let outMax = -1, outFar = ah;
          for (let ou = 3; ou <= 8; ou++) {
            const oh = w.heightAt(Math.round(ax + Math.cos(ang) * ou),
                                  Math.round(az + Math.sin(ang) * ou));
            if (oh > outMax) outMax = oh;
            if (ou === 8) outFar = oh;
          }
          if (outMax > ah + 2 || outFar > ah - 1) continue;
          const score = -lavaN * 4 + ah * 0.8 + flat * 0.3 - r * 0.3
                        + (ah - outMax) * 0.5;   // 同等条件优先选崖外更开阔的扇区
          if (score > siteScore) { siteScore = score; site = { x: ax, z: az, y: ah, a: ang, lavaN }; }
        }
      }
      if (!site) site = { x: Math.round(vc.x), z: Math.round(vc.z), y: top, a: 0, lavaN: 0 };

      // 沿径向铺台（u>0 朝崖外=头颈探出方向，u<0 朝火口=盘尾侧，v 切向）。
      // 实测天然地形：台心 L=28，外崖 u5+ 陡降到 17，火口侧 u-6/-7 立着 33/35 的内缘墙、
      // 墙后熔岩湖表面 y30——墙不削，坡下仰望只见黑墙；全削开，岩浆会改道漫台。
      // 故：台心 7×7 压平 L（容折翼+盘尾）；外崖修三级粗岩舌当前景；火口侧削两级低槛
      //（-5/-6→L、-7→L+2），槛后湖面火光恰好从龙尾后面漫上来，低槛本身即挡岩浆坝。
      const L = site.y;
      const dirx = Math.cos(site.a), dirz = Math.sin(site.a);
      const tanx = -Math.sin(site.a), tanz = Math.cos(site.a);
      // 整柱统一成玄武岩：火山锥只有表层是玄武岩壳、内部是浅灰石头，若只切不换，
      // 削切面会露出大片浅色内核（像白色废墟）。台面以下全部填实、台面以上全部净空。
      const flatten = (colX, colZ, T) => {
        colX = Math.round(colX); colZ = Math.round(colZ);
        for (let y = L - 8; y <= T; y++) w.setBlock(colX, y, colZ, BLOCK.BASALT);
        for (let y = T + 1; y <= T + 8; y++) w.setBlock(colX, y, colZ, BLOCK.AIR);
        const c = w._chunkIdx(colX >> 4, colZ >> 4);     // 龙的离地判定走静态 heightAt，需同步 hm
        if (c) c.hm[((colZ & 15) * 16) + (colX & 15)] = T;
        flatMap.set(colX + "," + colZ, T);
      };
      const flatMap = new Map();
      const at = (u, v) => [site.x + dirx * u + tanx * v, site.z + dirz * u + tanz * v];
      // A. 台心压平（u -3..1、v ±2，刚好包住折翼+尾盘）；台口 u=2 另见 A2 踏步。
      // 台形收紧：趴龙实际占地约 2.5×2.5、尾盘到 u≈-2.8，岩台只比龙大一圈，
      // 绝不修成山顶广场（俯拍像停车场）。
      for (let u = -3; u <= 1; u++) {
        for (let v = -2; v <= 2; v++) {
          const p = at(u, v); flatten(p[0], p[1], L);
        }
      }
      // A2. 台口踏步：龙趴姿头/背仅高于台面约 1.6~2.4 格，台口若与台面齐平，
      // 坡下沿坡仰望时台口永远切掉龙头。u=2 一排 v±2 整体下沉两格（与岩舌首级同高），
      // 形成 29→27 的台口坎，坎后仍是完整台面，龙鼻探出方向不悬空。
      for (let v = -2; v <= 2; v++) {
        const p = at(2, v); flatten(p[0], p[1], L - 2);
      }
      // B. 火口侧两级低槛（兼挡岩浆坝；-7 留 L+2 高槛，切槽只到 v±2，两侧留天然岩柱）
      for (let v = -2; v <= 2; v++) {
        let p = at(-5, v); flatten(p[0], p[1], L);
        p = at(-6, v); flatten(p[0], p[1], L);
      }
      for (let v = -2; v <= 2; v++) {
        const p = at(-7, v); flatten(p[0], p[1], L + 2);
      }
      // C. 外崖三级粗岩舌：顶面 = min(天然高, L-drop)，只削不垫高，顺崖势逐级下落，
      // 避免在火山锥上劈出深槽或长出高柱（drop 是相对台面 L 的下沉格数，不是绝对高度）。
      // drop 取 2/3/4：首级与台口踏步同高（L-2），坡下走到 u4/u5 脊上就能越过岩舌看见龙。
      // u3 与台口同宽（前爪搭台），u4/u5 收成 3 格窄脊，远看像天然岩脉而非铺路
      const tongue = [[3, 2, 2], [4, 3, 1], [5, 4, 1]];
      for (const [u, drop, hv] of tongue) {
        for (let v = -hv; v <= hv; v++) {
          if (Math.abs(v) === hv && u === 3) continue;
          const p = at(u, v);
          const natH = w.heightAt(Math.round(p[0]), Math.round(p[1]));
          flatten(p[0], p[1], Math.min(natH, L - drop));
        }
      }
      // D2. 切口四邻的天然高柱：把露出的浅灰内核侧面贴成玄武岩壳（不动岩浆柱，保湖景）
      flatMap.forEach((T0, key) => {
        const [fx0, fz0] = key.split(",").map(Number);
        for (const [nx, nz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const qx = fx0 + nx, qz = fz0 + nz;
          if (flatMap.has(qx + "," + qz)) continue;
          const qTop = w.heightAt(qx, qz);
          if (qTop <= T0) continue;
          if (isLavaId(w.getBlock(qx, qTop, qz))) continue;
          for (let y = T0 + 1; y <= Math.min(qTop, T0 + 8); y++) {
            if (!isLavaId(w.getBlock(qx, y, qz))) w.setBlock(qx, y, qz, BLOCK.BASALT);
          }
        }
      });
      // E. 外缘一圈残余流动岩浆换玄武岩，双保险防止漫台（火口侧 -7 槛本身即坝，
      // 切勿再填 -8——那会把可见的熔岩湖最近一圈也封死）
      const ring = [];
      for (let v = -3; v <= 3; v++) ring.push(at(3, v));
      for (let u = -6; u <= 2; u++) { ring.push(at(u, 3)); ring.push(at(u, -3)); }
      for (const [bx0, bz0] of ring) {
        const bx = Math.round(bx0), bz = Math.round(bz0);
        for (let y = L - 1; y <= L + 3; y++) if (isLavaId(w.getBlock(bx, y, bz))) w.setBlock(bx, y, bz, BLOCK.BASALT);
      }
      const remeshPts = [[site.x, site.z]];
      for (const du of [-8, -7, 3, 5]) for (const dv of [-3, 3])
        remeshPts.push(at(du, dv));
      remeshPts.forEach(p => w.remeshAround(Math.round(p[0]), Math.round(p[1])));

      const perch = { x: site.x + 0.5, z: site.z + 0.5, y: L };
      const ox = perch.x - vc.x, oz = perch.z - vc.z;
      // 朝外趴伏（模型 yaw=0 朝 -Z，朝向 dir=(-sin yaw,-cos yaw)）；中心兜底点沿用 yaw=0
      perch.yaw = Math.abs(ox) + Math.abs(oz) > 0.01 ? Math.atan2(-ox, -oz) : 0;

      const m = this.spawn("dragon", perch.x, top + 5.5, perch.z);
      m.home = { x: vc.x, z: vc.z };
      m.perch = perch;
      m.roostY = top + 5.5;
      m.bossState = "idle";        // idle | engage | return
      m.cast = null;               // null | windup_breath | breath | windup_ball | recover
      m.castT = 0;
      m.skillCd = 2.2;
      m.swoopT = 3.5;
      m.strafeA = Math.random() * Math.PI * 2;
      m.aim = { x: 0, z: 1 };
      m.flapT = Math.random() * Math.PI * 2;
      m.flameTick = 0;
      m.aimPitch = 0;
      m.mouthGlow = 0;
      m.announced = false;
      m.breathWarned = false;
      dragonSlain = false;
      return m;
    },

    getDragon() {
      return mobs.find(m => m.type === "dragon" && !m.dead) || null;
    },

    // 存档：{dead:true} 或 {hp,x,y,z}；无龙可存返回 null
    serializeBoss() {
      const d = mobs.find(m => m.type === "dragon");
      if (d && !d.dead) {
        return { hp: Math.max(1, Math.round(d.hp)), x: d.pos.x, y: d.pos.y, z: d.pos.z };
      }
      return dragonSlain ? { dead: true } : null;
    },

    // 读档：必须先 spawnDragon()。dead -> 静默移除；否则恢复血量/位置
    restoreBoss(data) {
      const d = this.getDragon();
      if (!d || !data) return;
      if (data.dead) {
        despawn(d);
        const i = mobs.indexOf(d);
        if (i >= 0) mobs.splice(i, 1);
        dragonSlain = true;
        hideBossHud();
        return;
      }
      if (typeof data.hp === "number") {
        d.hp = Math.max(1, Math.min(data.hp, d.maxHp));
        showBar(d);
      }
      if (typeof data.x === "number" && typeof data.z === "number") {
        const nearHome = Math.hypot(data.x - d.home.x, data.z - d.home.z) < 45;
        if (nearHome) d.pos.set(data.x, data.y, data.z);
      }
    },

    spawn(type, x, y, z) {
      const t = TYPES[type];
      const model = BUILDERS[type](t);
      scene.add(model.root);
      const bar = createHealthBar();
      scene.add(bar.sprite);
      const mob = {
        type: type,
        cfg: t,
        parts: model.parts,
        root: model.root,
        bar: bar,
        pos: new THREE.Vector3(x, y, z),
        vel: new THREE.Vector3(),
        yaw: Math.random() * Math.PI * 2,
        renderYaw: Math.random() * Math.PI * 2,
        width: t.width,
        height: t.height,
        onGround: false,
        moving: false,
        stateT: Math.random() * 2,
        wantWalk: false,
        blockedT: 0,
        phase: Math.random() * Math.PI * 2,

        // 战斗 / 社交状态
        hp: t.hp, maxHp: t.hp, dead: false,
        hurtT: 0, barT: 0, biteCd: 0,
        angerT: 0,              // 蜘蛛白天被打后的反击计时
        leapCd: 0,              // 蜘蛛扑击冷却
        // 繁殖（牛 / 羊吃麦子）
        baby: false,            // 是否为幼崽
        growT: 0,               // 幼崽距离成年剩余秒数
        adultW: t.width, adultH: t.height,
        loveT: 0,               // 恋爱模式剩余秒数
        breedT: 0,              // 配对后交配倒计时
        breedCd: 0,             // 繁殖冷却
        mate: null,             // 配对的另一只 mob
        mode: "idle",              // idle | flee | anger
        modeT: 0,                  // 逃跑/愤怒剩余时间
        threatX: x, threatZ: z,    // 逃跑方向参考点
        target: null,              // 狗战斗目标（另一只 mob）
        owner: false,              // 是否被玩家驯服
        sitting: false,
        ridden: false
      };
      if (t.boss) bar.sprite.scale.set(3.6, 0.34, 1);
      bar.sprite.position.set(x, y + t.height + 0.7, z);
      model.root.position.copy(mob.pos);
      model.root.rotation.y = mob.renderYaw;
      mobs.push(mob);
      return mob;
    },

    /* ---------------- 玩家对动物的交互（喂食 / 坐下 / 骑乘） ---------------- */

    interact(m, heldStack) {
      if (!m || m.dead) return false;
      if (m.cfg.hostile) return false;  // 敌对生物不能喂食 / 驯服 / 骑乘
      const heldId = heldStack ? heldStack.id : 0;

      // 牛 / 羊手持麦子、熊猫手持竹子：幼崽吃食物加速长大；
      // 成年吃食物进入恋爱模式，两只配对后生下幼崽
      if (isBreedable(m.type) && heldId === breedFoodId(m.type)) {
        const foodName = breedFoodName(m.type);
        if (m.baby) {
          Crafting.consumeHeld(1);
          m.growT = Math.max(0, m.growT - 25);
          spawnHearts(m);
          if (m.growT === 0) growUp(m);
          hooks.toast("小" + TYPES[m.type].name + "吃下" + foodName + "，长得更快了");
          return true;
        }
        if (m.breedT > 0 || m.loveT > 0) {
          hooks.toast(TYPES[m.type].name + "已经准备好了，正在等待同伴");
          return false;  // 不消耗食物
        }
        if (m.breedCd > 0) {
          hooks.toast(TYPES[m.type].name + "刚刚繁殖过，还需要休息一会儿");
          return false;
        }
        Crafting.consumeHeld(1);
        m.loveT = LOVE_TIME;
        spawnHearts(m);
        hooks.toast(TYPES[m.type].name + "吃下了" + foodName + "，它在寻找同伴");
        return true;
      }

      // 食草 / 食竹动物不吃肉
      if (isBreedable(m.type) && isMeat(heldId)) {
        hooks.toast(TYPES[m.type].name + "不吃肉，它喜欢吃" + breedFoodName(m.type));
        return false;
      }

      // 手持生肉：喂食（驯服 / 回血）
      if (isMeat(heldId)) {
        Crafting.consumeHeld(1);
        spawnHearts(m);
        if (m.owner) {
          m.hp = Math.min(m.maxHp, m.hp + 4);
          showBar(m);
          hooks.toast(TYPES[m.type].name + " 吃下了肉，恢复了体力");
          return true;
        }
        if (m.type === "dog") {
          // 野狗需要取得信任：约 60% 概率一次驯服
          if (Math.random() < 0.6) tame(m);
          else hooks.toast("狗还在警惕你……再喂一块试试");
        } else {
          tame(m);
        }
        return true;
      }

      // 空手交互
      if (!heldId) {
        if (m.type === "dog" && m.owner) {
          m.sitting = !m.sitting;
          m.target = null;
          hooks.toast("狗：" + (m.sitting ? "坐下待命" : "跟随你"));
          return true;
        }
        if (m.type === "pig" && m.owner) {
          this.mount(m);
          return true;
        }
        if (m.owner) {
          spawnHearts(m);  // 摸摸其他已驯服动物
          return true;
        }
      }
      return false;
    },

    /* ---------------- 伤害 / 死亡 ---------------- */

    damageMob(m, amount, src) {
      if (!m || m.dead) return false;
      // 自己的动物不能打（群体内部免疫）
      if (m.owner && src && src.player) {
        spawnHearts(m);
        hooks.toast("这是你驯服的 " + TYPES[m.type].name + "，不能攻击");
        return false;
      }
      m.hp = Math.max(0, m.hp - amount);
      m.hurtT = 0.32;
      showBar(m);

      // 击退
      let kx = 0, kz = 0;
      if (src && src.player && src.from) {
        kx = m.pos.x - src.from.x; kz = m.pos.z - src.from.z;
        const l = Math.hypot(kx, kz) || 1;
        m.vel.x += kx / l * 4.2;
        m.vel.z += kz / l * 4.2;
        m.vel.y = 4.4;
      } else if (src && src.attacker) {
        kx = m.pos.x - src.attacker.pos.x; kz = m.pos.z - src.attacker.pos.z;
        const l = Math.hypot(kx, kz) || 1;
        m.vel.x += kx / l * 3.2;
        m.vel.z += kz / l * 3.2;
        m.vel.y = 3.6;
      }

      if (m.hp <= 0) { kill(m, src); return true; }

      // 反应：猪羊逃跑，牛/野狗愤怒反击，蜘蛛白天被打也会短暂反击
      const t = m.cfg;
      if (src && src.player) {
        if (m.type === "spider") {
          m.angerT = 9;
          m.sitting = false;
        }
        // 牛 / 羊 / 熊猫挨打会打断求偶与交配，双方各自退回普通状态
        if (isBreedable(m.type) && (m.loveT > 0 || m.breedT > 0)) {
          if (m.mate) {
            const o = m.mate;
            if (!o.dead) { o.mate = null; o.breedT = 0; o.loveT = Math.max(o.loveT, 8); }
          }
          m.mate = null; m.breedT = 0; m.loveT = 0;
        }
        if (m.type === "panda") {
          if (m.baby) {
            // 小熊猫挨打只会吓得抱头逃跑
            m.mode = "flee"; m.modeT = 5.5;
            m.threatX = src.from.x; m.threatZ = src.from.z;
          } else {
            // 成年熊猫：皱眉怒目冲过来追咬玩家一阵，时间到或玩家跑远后平息
            m.mode = "anger"; m.modeT = PANDA_ANGRY_TIME;
          }
        } else if (t.behavior === "flee") {
          m.mode = "flee"; m.modeT = 5.5;
          m.threatX = src.from.x; m.threatZ = src.from.z;
          m.sitting = false;
        } else if (t.behavior === "anger" && !m.owner) {
          m.mode = "anger"; m.modeT = 12;
          m.sitting = false;
        }
        // 所有驯服的狗协攻玩家攻击的目标（不打自家动物）
        for (const d of mobs) {
          if (d.dead || d.type !== "dog" || !d.owner) continue;
          if (m.owner) continue;
          if (!d.target || d.target.dead) d.target = m;
        }
      }
      return true;
    },

    // 玩家被某只动物攻击时：所有驯服的狗（含坐着的）立刻护主
    notifyPlayerAttacked(attacker) {
      for (const d of mobs) {
        if (d.dead || d.type !== "dog" || !d.owner) continue;
        if (attacker && attacker.owner) continue;
        d.sitting = false;
        d.target = attacker;
        d.mode = "idle";
      }
    },

    /* ---------------- 骑乘 ---------------- */

    mount(pig) {
      if (!pig || pig.dead || pig.type !== "pig" || !pig.owner) return false;
      mountMob = pig;
      pig.ridden = true;
      pig.sitting = false;
      hooks.toast("骑上猪了：WASD 移动，空格跳跃，Shift 下来");
      return true;
    },
    dismount() {
      if (!mountMob) return null;
      const m = mountMob;
      m.ridden = false;
      mountMob = null;
      return m;
    },
    isRiding() { return !!mountMob; },
    getMount() { return mountMob; },

    /* ---------------- 视线射线与动物 AABB（slab 法） ---------------- */

    raycast(o, d, maxDist) {
      let best = null, bestT = maxDist;
      // 客人端没有本地实体，射线目标全部是房主权威镜像（mirrors 仅客人端非空）
      const pool = mirrors.size ? Array.from(mirrors.values()) : mobs;
      for (const m of pool) {
        if (m.dead) continue;
        const hw = m.width / 2 + 0.08;
        const min = [m.pos.x - hw, m.pos.y, m.pos.z - hw];
        const max = [m.pos.x + hw, m.pos.y + m.height, m.pos.z + hw];
        let tmin = 0, tmax = Infinity;
        for (let a = 0; a < 3; a++) {
          const oa = a === 0 ? o.x : a === 1 ? o.y : o.z;
          const da = a === 0 ? d.x : a === 1 ? d.y : d.z;
          if (Math.abs(da) < 1e-8) {
            if (oa < min[a] || oa > max[a]) { tmin = Infinity; break; }
          } else {
            let t1 = (min[a] - oa) / da, t2 = (max[a] - oa) / da;
            if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
            tmin = Math.max(tmin, t1);
            tmax = Math.min(tmax, t2);
            if (tmin > tmax) { tmin = Infinity; break; }
          }
        }
        if (tmin <= tmax && tmin < bestT) { bestT = tmin; best = m; }
      }
      return best ? { mob: best, t: Math.max(0, bestT) } : null;
    },

    /* ---------------- 每帧更新（主循环单点挂载） ---------------- */

    update(dt, playerPos, opts) {
      opts = opts || {};
      if (!playerPos) return;
      sunBurnActive = !!opts.sunBurn;
      // 手持竹子 / 竹笋会吸引熊猫：holders = [{pos,id}]（房主 + 联机客人影子）
      temptHolders = opts.holders ||
        (opts.heldId ? [{ pos: playerPos, id: opts.heldId }] : []);
      // Boss 多目标：actors = [{id,pos,hurt(n,attacker)}]（房主本人 + 客人影子）。
      // 缺省退化为单机单目标（旧行为，hurt 走 hooks.hurtPlayer）
      const actors = (opts.actors && opts.actors.length) ? opts.actors : [{
        id: 0, pos: playerPos,
        hurt: function (n, attacker) { return hooks.hurtPlayer(n, attacker); }
      }];
      fxTime += dt;
      for (let i = mobs.length - 1; i >= 0; i--) {
        const m = mobs[i];
        if (m.dead) { mobs.splice(i, 1); continue; }
        // 距离剔除看最近的玩家：客人在怪物身边时即使房主走远也要保持模拟
        let d2 = Infinity;
        for (const a of actors) {
          const ddx = m.pos.x - a.pos.x, ddz = m.pos.z - a.pos.z;
          const dd = ddx * ddx + ddz * ddz;
          if (dd < d2) d2 = dd;
        }
        // 僵尸离玩家太远直接消散（夜晚会在身边重新刷出）；Boss 不消散
        if (m.cfg.hostile && !m.cfg.boss && !m.ridden && d2 > 46 * 46) {
          despawn(m);
          mobs.splice(i, 1);
          continue;
        }
        if (d2 > 64 * 64 && m !== mountMob) {
          restPose(m);
          updateBar(m, dt);
          continue;
        }
        if (m.cfg.boss) {
          updateDragon(m, dt, actors);
        } else {
          updateMob(m, dt, playerPos, opts.steer || null, actors);
          if (m.dead) continue;   // 烈日下可能在 AI 更新中燃尽
          updatePhysics(m, dt);
        }
        if (!m.dead) updateAnimation(m, dt);
        updateBar(m, dt);
      }
      separate();
      updateDrops(dt, playerPos, opts.collectors);
      updateBossFx(dt, actors);
    }
  };

  // 无声移除实体（不掉落、不爆粒子）
  function despawn(m) {
    scene.remove(m.root);
    scene.remove(m.bar.sprite);
    m.dead = true;
  }

  /* ---------------- 驯服 ---------------- */

  function tame(m) {
    m.owner = true;
    m.sitting = false;
    m.mode = "idle"; m.modeT = 0;
    m.target = null;
    // 狗驯服后血量上限提升（类似 MC 狼）
    if (m.cfg.tamedHp) { m.maxHp = m.cfg.tamedHp; m.hp = m.maxHp; }
    if (m.parts.tag) m.parts.tag.visible = true;
    spawnHearts(m);
    hooks.toast(TYPES[m.type].name + " 被你驯服了！它会跟随你" + (m.type === "dog" ? "，还会保护你" : m.type === "pig" ? "，空手右键可以骑" : ""));
  }

  function spawnHearts(m) {
    hooks.burst(m.pos.x, m.pos.y + m.height + 0.2, m.pos.z, 0xff8fc0);
  }

  function showBar(m) {
    m.barT = 3;
    drawHealthBar(m.bar, m.hp / m.maxHp, !!m.cfg.boss);
    m.bar.sprite.visible = true;
  }

  function updateBar(m, dt) {
    // Boss 战中血条常驻；非战斗态只做普通 3 秒淡出（旧实现 barT>0.1 时
    // 每帧重置 0.2，dt<0.1 的帧永远衰减不下去，导致受击/读档后血条永久挂头顶）
    if (m.cfg.boss && m.bossState === "engage") {
      m.barT = 0.2;
    }
    if (m.barT > 0) {
      m.barT -= dt;
      m.bar.sprite.visible = true;
      drawHealthBar(m.bar, m.hp / m.maxHp, !!m.cfg.boss);
      m.bar.sprite.position.set(m.pos.x, m.pos.y + m.height + 0.7, m.pos.z);
      if (m.barT <= 0 && !(m.cfg.boss && m.bossState === "engage")) m.bar.sprite.visible = false;
    }
  }

  /* ---------------- 死亡 / 掉落 ---------------- */

  function kill(m, src) {
    m.dead = true;
    scene.remove(m.root);
    scene.remove(m.bar.sprite);
    hooks.burst(m.pos.x, m.pos.y + m.height * 0.5, m.pos.z, m.cfg.deathColor);
    if (m === mountMob) { mountMob = null; }
    if (m.cfg.boss) {
      dragonSlain = true;
      hideBossHud();
      // 更盛大的黑灰鳞甲爆裂 + 火焰余烬（与新配色一致，无紫色）
      for (let i = 0; i < 5; i++) {
        hooks.burst(m.pos.x + (Math.random() - 0.5) * 1.6,
                    m.pos.y + 0.5 + Math.random() * m.height,
                    m.pos.z + (Math.random() - 0.5) * 1.6,
                    [0x312c32, 0xff7a24, 0x515056, 0xffc13b, 0x913847][i]);
      }
      hooks.toast("紫黑龙被击败了！它掉落了龙肉和龙皮");
    }
    // 掉落表：[itemId, 最少, 最多]；幼崽死亡不掉落任何物品。
    // mod 可通过 GameRegistry.mobDrops[类型] 追加掉落行（如僵尸 50% 掉火药）
    if (!m.baby) {
      const extra = GameRegistry.mobDrops[m.type];
      const rows = extra ? m.cfg.drops.concat(extra) : m.cfg.drops;
      for (const d of rows) {
        const n = d[1] + Math.floor(Math.random() * (d[2] - d[1] + 1));
        for (let i = 0; i < n; i++) spawnDrop(d[0], m.pos);
      }
    }
  }

  // opts:
  //   vel {x,y,z} 指定初速度（缺省随机迸溅）；count 整堆数量（拾取时一次收回）；
  //   dur 工具耐久；pickDelay 落地后多少秒内不允许拾取（防止玩家丢出即吸回）；
  //   icon 强制使用背包像素图标（玩家丢弃物）；
  //   life 世界保留秒数（缺省 90；挖方块掉落给更长时间，背包满时玩家来得及腾格子）
  function spawnDrop(itemId, pos, opts) {
    opts = opts || {};
    const g = new THREE.Group();
    g.add(buildDropMesh(itemId, !!opts.icon));
    g.position.set(pos.x + (Math.random() - 0.5) * 0.5,
                    pos.y + 0.5,
                    pos.z + (Math.random() - 0.5) * 0.5);
    scene.add(g);
    drops.push({
      id: itemId, group: g,
      vx: opts.vel ? opts.vel.x : (Math.random() - 0.5) * 2.4,
      vy: opts.vel ? opts.vel.y : 3 + Math.random() * 1.5,
      vz: opts.vel ? opts.vel.z : (Math.random() - 0.5) * 2.4,
      count: opts.count || 1,
      dur: opts.dur == null ? null : opts.dur,
      pickDelay: opts.pickDelay || 0,
      life: opts.life || 90,
      age: 0, spin: Math.random() * Math.PI * 2
    });
  }

  // 挖方块掉落：在被挖方块位置轻轻弹出一个掉落物实体（泥土 / 圆石 / 原木 / 矿石…）。
  // 背包有空位走近会自动磁吸拾取（updateDrops 裁决）；背包满时吸不动、留在原地，
  // 保留 5 分钟等玩家腾出格子，方块不会凭空消失。
  // opts.count 整堆数量（储物箱一次掉一整堆）；opts.dur 保留工具耐久。
  Mobs.spawnBlockDrop = function (itemId, bx, by, bz, opts) {
    opts = opts || {};
    spawnDrop(itemId, { x: bx + 0.5, y: by + 0.02, z: bz + 0.5 }, {
      vel: {
        x: (Math.random() - 0.5) * 1.4,
        y: 2.0 + Math.random(),
        z: (Math.random() - 0.5) * 1.4
      },
      // 方块（含 BLOCK_TILES 的物品）渲染迷你 3D 贴图方块；煤 / 粗铁等纯物品用背包像素图标
      icon: !BLOCK_TILES[itemId],
      life: 300,
      count: opts.count || 1,
      dur: opts.dur == null ? null : opts.dur
    });
  };

  // 玩家主动丢弃：从眼位朝视角方向抛出（整堆一个掉落物实体）
  Mobs.spawnPlayerDrop = function (itemId, count, dur, eye, dir) {
    const pos = {
      x: eye.x + dir.x * 0.35,
      y: eye.y - 0.18 + dir.y * 0.35,
      z: eye.z + dir.z * 0.35
    };
    const vel = {
      x: dir.x * 5.2,
      y: dir.y * 5.2 + 2.4,
      z: dir.z * 5.2
    };
    spawnDrop(itemId, pos, {
      vel: vel, count: count || 1, dur: dur,
      pickDelay: 0.45, icon: true
    });
  };

  // collectors：可选收集者列表 [{pos,roomFor(id,n),take(id)}]，
  // 房主联机时含房主本人与客人影子；缺省回退为本地玩家（单机/菜单）
  function updateDrops(dt, playerPos, collectors) {
    if (!collectors || !collectors.length) {
      collectors = [{
        pos: playerPos,
        roomFor: function (id, n) { return Crafting.roomFor(id, n); },
        take: function (id, n, dur) { Crafting.addItem(id, n, dur); }
      }];
    }
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      d.age += dt;
      if (d.age > d.life) { scene.remove(d.group); drops.splice(i, 1); continue; }

      // 找水平距离最近的收集者（磁吸/拾取都对它生效）
      let best = null, bestDx = 0, bestDz = 0, bestDist = Infinity;
      for (let ci = 0; ci < collectors.length; ci++) {
        const c = collectors[ci];
        const cx = c.pos.x - d.group.position.x;
        const cz = c.pos.z - d.group.position.z;
        const cd = Math.hypot(cx, cz);
        if (cd < bestDist) { bestDist = cd; bestDx = cx; bestDz = cz; best = c; }
      }
      // 玩家刚丢出的掉落物有短暂保护期：不磁吸也不拾取，避免出手就被吸回
      const canPick = d.age >= d.pickDelay;
      const canTake = canPick && !!(best && best.roomFor(d.id, d.count));
      // 落地支撑：从掉落物当前高度向下扫最近的实心方块，不能用 world.heightAt ——
      // 那是地形生成时写死的原始地表高度，挖掘/放置后从不更新；地下/洞穴挖矿时
      // 掉落物会被错误地钳到地表上方，玩家在下方垂直差超 2.2 永远吸不进背包。
      let floorY = null;
      const dpx = Math.floor(d.group.position.x), dpz = Math.floor(d.group.position.z);
      for (let dby = Math.floor(d.group.position.y); dby >= 0; dby--) {
        if (isSolid(world.getBlock(dpx, dby, dpz))) { floorY = dby + 1; break; }
      }

      // 靠近收集者且背包收得下：磁吸
      if (bestDist < 1.8 && canTake) {
        const pull = 6.5;
        d.vx += bestDx / (bestDist || 1) * pull * dt * 3;
        d.vz += bestDz / (bestDist || 1) * pull * dt * 3;
        d.vy += 2.2 * dt;
      } else {
        d.vy -= 14 * dt;
      }
      d.group.position.x += d.vx * dt;
      d.group.position.y += d.vy * dt;
      d.group.position.z += d.vz * dt;
      // 落地（脚下没有实心方块时继续下落，不做高度钳制）
      if (floorY !== null && d.group.position.y <= floorY + 0.12) {
        d.group.position.y = floorY + 0.12;
        d.vy = 0;
        d.vx *= 0.7; d.vz *= 0.7;
      }
      d.spin += dt * 2.2;
      d.group.rotation.y = d.spin;
      d.group.children[0].position.y = Math.sin(d.age * 3.2) * 0.05 + 0.06;

      // 拾取（由收集者的 take 决定入谁的背包：房主本地或客人影子）
      if (best && canTake && bestDist < 0.95 &&
          Math.abs(best.pos.y - d.group.position.y) < 2.2) {
        best.take(d.id, d.count, d.dur);
        scene.remove(d.group);
        drops.splice(i, 1);
      }
    }
  }

  /* ---------------- 熊猫：竹子吸引 ---------------- */

  // 当前手持物品的玩家快照（每帧由 Mobs.update 刷新）：{pos:{x,y,z}, id}
  let temptHolders = [];

  // 找到范围内手持竹子 / 竹笋、与熊猫高度差不大的最近玩家
  function nearestPandaFood(pos) {
    let best = null, bestD2 = PANDA_TEMPT_RANGE * PANDA_TEMPT_RANGE;
    for (const h of temptHolders) {
      if (!isPandaFood(h.id)) continue;
      if (Math.abs(h.pos.y - pos.y) > 2.4) continue;
      const d2 = (h.pos.x - pos.x) ** 2 + (h.pos.z - pos.z) ** 2;
      if (d2 < bestD2) { bestD2 = d2; best = h; }
    }
    return best;
  }

  // 熊猫面部三态切换：幼崽大圆眼；成年普通黑眼圈；挨打时斜眉怒目
  function applyPandaMood(m) {
    const f = m.parts && m.parts.pandaFace;
    if (!f) return;
    const baby = !!m.baby, angry = !baby && m.mode === "anger";
    f.normal.visible = !baby && !angry;
    f.baby.visible = baby;
    f.angry.visible = angry;
    if (m.parts.pandaMuzzle) m.parts.pandaMuzzle.visible = !baby;
  }

  /* ---------------- FSM：按优先级决定水平期望速度 ---------------- */

  // 索敌：取水平距离 maxDist 内最近的玩家（房主本人 / 联机客人影子），
  // 返回 {actor, d}；无玩家在范围内返回 null
  function nearestActor(m, actors, maxDist) {
    let best = null, bestD = maxDist;
    for (const a of actors) {
      const d = Math.hypot(a.pos.x - m.pos.x, a.pos.z - m.pos.z);
      if (d <= bestD) { bestD = d; best = a; }
    }
    return best ? { actor: best, d: bestD } : null;
  }

  function updateMob(m, dt, playerPos, steer, actors) {
    if (!actors || !actors.length) {
      actors = [{
        pos: playerPos,
        hurt: function (n, attacker) { return hooks.hurtPlayer(n, attacker); }
      }];
    }
    m.hurtT = Math.max(0, m.hurtT - dt);
    m.biteCd = Math.max(0, m.biteCd - dt);
    m.angerT = Math.max(0, m.angerT - dt);
    m.leapCd = Math.max(0, m.leapCd - dt);
    m.breedCd = Math.max(0, m.breedCd - dt);
    // 幼崽随时间长大
    if (m.baby) {
      m.growT -= dt;
      if (m.growT <= 0) growUp(m);
    }
    // 恋爱 / 交配倒计时（finishBreed 内部只允许先归零的一方处理一次）
    if (m.loveT > 0) {
      m.loveT -= dt; if (m.loveT < 0) m.loveT = 0;
      // 恋爱期间持续冒红心，让玩家一眼能认出准备好了的牛 / 羊
      if (!m.baby && Math.random() < dt * 1.2) {
        hooks.burst(m.pos.x + (Math.random() - 0.5) * 0.4,
                    m.pos.y + m.height + 0.15,
                    m.pos.z + (Math.random() - 0.5) * 0.4, 0xff8fc0);
      }
    }
    if (m.breedT > 0) {
      m.breedT -= dt;
      if (m.breedT <= 0) finishBreed(m);
    }
    if (m.modeT > 0) { m.modeT -= dt; if (m.modeT <= 0 && m.mode !== "idle") m.mode = "idle"; }

    // 僵尸白天露天自燃（有方块遮蔽则安全）；蜘蛛不怕晒，不走此逻辑
    if (m.cfg.hostile && m.cfg.sunBurn !== false && sunBurnActive && isExposedToSky(m)) {
      m.hp = Math.max(0, m.hp - 6 * dt);
      if (Math.random() < dt * 10) {
        hooks.burst(m.pos.x, m.pos.y + m.height * (0.3 + Math.random() * 0.7), m.pos.z, 0xff8a2a);
      }
      if (Math.random() < dt * 4) showBar(m);
      if (m.hp <= 0) { kill(m, null); return; }
    }

    let dx = 0, dz = 0, sp = m.cfg.speed, mMoving = false;

    // 熊猫面部三态（成年 / 幼年 / 愤怒）随状态切换
    if (m.type === "panda") applyPandaMood(m);
    // 手持竹子 / 竹笋的玩家会吸引熊猫（已配对正在交配的熊猫不分心）
    const temptHolder = m.type === "panda" && m.breedT <= 0 ? nearestPandaFood(m.pos) : null;

    /* 1) 被骑乘的猪：完全听骑手的 */
    if (m.ridden && steer) {
      const l = Math.hypot(steer.x, steer.z);
      if (l > 0) {
        dx = steer.x / l; dz = steer.z / l;
        m.yaw = Math.atan2(-dx, -dz);
        sp = 2.35; mMoving = true;
      }
      if (steer.jump && m.onGround) m.vel.y = 7.8;
      m.mode = "idle";
    } else if (m.sitting) {
      /* 2) 坐下待命（狗）：不走动 */
      dx = dz = 0;
    } else if (!m.baby && isBreedable(m.type) && m.mode === "idle" &&
               (m.breedT > 0 || m.loveT > 0)) {
      /* 2.5) 牛 / 羊求偶：已配对则走向伴侣；未配对称恋爱期寻找同伴，平时悠闲游荡 */
      if (m.breedT > 0 && m.mate && !m.mate.dead) {
        const mdx = m.mate.pos.x - m.pos.x, mdz = m.mate.pos.z - m.pos.z;
        const md = Math.hypot(mdx, mdz);
        if (md > 0.85) {
          dx = mdx / md; dz = mdz / md;
          m.yaw = Math.atan2(-dx, -dz);
          sp = m.cfg.speed * 0.95; mMoving = true;
        } else {
          // 已到伴侣身边：转头面向对方等待产崽
          m.yaw = Math.atan2(-mdx, -mdz);
        }
      } else {
        if (m.breedT <= 0 && !m.mate) {
          const mate = findMate(m);
          if (mate) {
            m.mate = mate; mate.mate = m;
            m.breedT = BREED_TIME; mate.breedT = BREED_TIME;
          }
        }
        wander(m, dt);
        dx = m._wdx || 0; dz = m._wdz || 0;
        sp = m.cfg.speed * 0.65; mMoving = m._wmoving;
      }
    } else if (m.cfg.hostile) {
      /* 3) 敌对怪：30 格内主动追击最近的玩家（房主 / 联机客人）并撕咬，太远则游荡。
            蜘蛛白天烈日下转为中立游荡（被打后 angerT 内仍会反击） */
      const aggressive = m.type !== "spider" || !sunBurnActive || m.angerT > 0;
      const goal = aggressive ? nearestActor(m, actors, 30) : null;
      if (goal) {
        const tp = goal.actor.pos, td = goal.d;
        tryBiteActor(m, goal.actor);
        if (td > (m.cfg.biteRange || 1.6) * 0.7) {
          dx = tp.x - m.pos.x; dz = tp.z - m.pos.z;
          const l = Math.hypot(dx, dz) || 1;
          dx /= l; dz /= l;
          m.yaw = Math.atan2(-dx, -dz);
          sp = m.cfg.chaseSpeed; mMoving = true;
          // 蜘蛛扑击：中距离贴地起跳扑向目标玩家
          if (m.type === "spider" && td > 1.8 && td < 5.5 &&
              m.onGround && m.leapCd <= 0) {
            m.leapCd = 1.4 + Math.random() * 0.9;
            m.vel.y = 7.6;
            m.vel.x += dx * 4.2;
            m.vel.z += dz * 4.2;
          }
        }
      } else {
        wander(m, dt);
        dx = m._wdx || 0; dz = m._wdz || 0; mMoving = m._wmoving;
      }
    } else if (m.type === "dog" && m.owner && m.target && !m.target.dead) {
      /* 3) 护主 / 协攻的狗追咬目标 */
      const tgt = m.target;
      const td = Math.hypot(tgt.pos.x - m.pos.x, tgt.pos.z - m.pos.z);
      const tooFar = Math.hypot(tgt.pos.x - playerPos.x, tgt.pos.z - playerPos.z) > 26;
      if (tooFar) { m.target = null; }
      else if (tryBite(m, tgt, m.cfg.tamedDamage, m.cfg.biteRange, m.cfg.biteInterval)) {
        // 咬到了
      } else if (td > m.cfg.biteRange * 0.7) {
        dx = tgt.pos.x - m.pos.x; dz = tgt.pos.z - m.pos.z;
        const l = Math.hypot(dx, dz) || 1;
        dx /= l; dz /= l;
        m.yaw = Math.atan2(-dx, -dz);
        sp = m.cfg.chaseSpeed; mMoving = true;
      }
    } else if (m.mode === "anger" && m.cfg.behavior === "anger") {
      /* 4) 愤怒反击：追最近的玩家并咬 */
      const goal = nearestActor(m, actors, 24);
      if (!goal) {
        m.mode = "idle";
      } else if (tryBiteActor(m, goal.actor)) {
        // 造成伤害
      } else if (goal.d > m.cfg.biteRange * 0.7) {
        const tp = goal.actor.pos;
        dx = tp.x - m.pos.x; dz = tp.z - m.pos.z;
        const l = Math.hypot(dx, dz) || 1;
        dx /= l; dz /= l;
        m.yaw = Math.atan2(-dx, -dz);
        sp = m.cfg.chaseSpeed || m.cfg.speed * 1.5; mMoving = true;
      }
    } else if (m.type === "panda" && m.mode === "anger") {
      /* 4.5) 熊猫愤怒：皱眉怒目冲向最近的玩家抱腿撕咬；玩家跑远则放弃，时间到自动平息 */
      const goal = nearestActor(m, actors, PANDA_GIVEUP_DIST);
      if (!goal) {
        m.mode = "idle"; m.modeT = 0;
        wander(m, dt);
        dx = m._wdx || 0; dz = m._wdz || 0; sp = m.cfg.speed; mMoving = m._wmoving;
      } else if (tryBiteActor(m, goal.actor)) {
        // 咬到了：原地发力
      } else if (goal.d > m.cfg.biteRange * 0.7) {
        const tp = goal.actor.pos;
        dx = tp.x - m.pos.x; dz = tp.z - m.pos.z;
        const l = Math.hypot(dx, dz) || 1;
        dx /= l; dz /= l;
        m.yaw = Math.atan2(-dx, -dz);
        sp = m.cfg.chaseSpeed; mMoving = true;
      }
    } else if (m.mode === "flee") {
      /* 5) 逃跑：远离威胁点 */
      dx = m.pos.x - m.threatX; dz = m.pos.z - m.threatZ;
      const l = Math.hypot(dx, dz);
      if (l > 0.01) { dx /= l; dz /= l; m.yaw = Math.atan2(-dx, -dz); }
      sp = m.cfg.speed * 1.45; mMoving = true;
    } else if (m.type === "panda" && temptHolder) {
      /* 5.2) 被竹子吸引：快步走向手持食物的玩家，到面前 1.8 格停下注视 */
      const tdx = temptHolder.pos.x - m.pos.x, tdz = temptHolder.pos.z - m.pos.z;
      const td = Math.hypot(tdx, tdz);
      if (td > 1.8) {
        dx = tdx / td; dz = tdz / td;
        m.yaw = Math.atan2(-dx, -dz);
        sp = m.cfg.speed * 1.4; mMoving = true;
      } else if (td > 0.01) {
        m.yaw = Math.atan2(-tdx / td, -tdz / td);
      }
    } else if (m.baby) {
      /* 5.5) 幼崽：小短腿快步跟随附近的成年同类，没有成年同类时独自游荡 */
      let ad = null, ad2 = 10 * 10;
      for (const o of mobs) {
        if (o.dead || o === m || o.type !== m.type || o.baby) continue;
        if (Math.abs(o.pos.y - m.pos.y) > 1.6) continue;
        const dd = (o.pos.x - m.pos.x) ** 2 + (o.pos.z - m.pos.z) ** 2;
        if (dd < ad2) { ad2 = dd; ad = o; }
      }
      if (ad && ad2 > 2.3 * 2.3) {
        dx = ad.pos.x - m.pos.x; dz = ad.pos.z - m.pos.z;
        const l = Math.hypot(dx, dz) || 1;
        dx /= l; dz /= l;
        m.yaw = Math.atan2(-dx, -dz);
        sp = m.cfg.speed * 1.2; mMoving = true;
      } else {
        wander(m, dt);
        dx = m._wdx || 0; dz = m._wdz || 0; sp = m.cfg.speed; mMoving = m._wmoving;
      }
    } else if (m.owner) {
      /* 6) 驯服的动物跟随主人（远了传送，近了游荡） */
      m.target = null;
      const td = Math.hypot(playerPos.x - m.pos.x, playerPos.z - m.pos.z);
      if (td > 20) {
        // 传送回主人身边（落到地表）
        const tx = Math.floor(playerPos.x + 1.2), tz = Math.floor(playerPos.z);
        const ty = world.heightAt(tx, tz) + 1;
        m.pos.set(tx + 0.5, ty, tz + 0.5);
        m.vel.set(0, 0, 0);
      } else if (td > 3.4) {
        dx = playerPos.x - m.pos.x; dz = playerPos.z - m.pos.z;
        const l = Math.hypot(dx, dz) || 1;
        dx /= l; dz /= l;
        m.yaw = Math.atan2(-dx, -dz);
        sp = m.cfg.speed * 1.25; mMoving = true;
      } else {
        wander(m, dt);
        dx = m._wdx || 0; dz = m._wdz || 0; sp = m.cfg.speed; mMoving = m._wmoving;
      }
    } else {
      /* 7) 普通游荡 */
      wander(m, dt);
      dx = m._wdx || 0; dz = m._wdz || 0; sp = m.cfg.speed; mMoving = m._wmoving;
    }

    // 平滑转向目标速度（受击击退仍由 vel 叠加体现）
    const k = Math.min(1, dt * (m.onGround ? 8 : 3));
    m.vel.x += (dx * sp - m.vel.x) * k;
    m.vel.z += (dz * sp - m.vel.z) * k;
    const speedNow = Math.hypot(m.vel.x, m.vel.z);
    m.moving = mMoving && speedNow > sp * 0.35;
    // 撞墙那一帧物理会把 vel 清零，导致 m.moving 恒 false、自动跳跃永不触发；
    // 用 FSM 的行走意图（而非被墙清零后的实际速度）决定要不要跳台阶
    m.wantMove = mMoving;
  }

  function wander(m, dt) {
    m.stateT -= dt;
    if (m.stateT <= 0) {
      m.wantWalk = Math.random() < 0.55;
      m.stateT = m.wantWalk ? 1.8 + Math.random() * 2.6 : 1.2 + Math.random() * 2.2;
      if (m.wantWalk) m.yaw = Math.random() * Math.PI * 2;
    }
    if (m.wantWalk) {
      m._wdx = -Math.sin(m.yaw);
      m._wdz = -Math.cos(m.yaw);
      m._wmoving = true;
    } else {
      m._wdx = 0; m._wdz = 0; m._wmoving = false;
    }
  }

  // 狗咬其他动物：距离够短且冷却结束 -> 造成伤害
  function tryBite(dog, target, damage, range, interval) {
    const dx = target.pos.x - dog.pos.x, dz = target.pos.z - dog.pos.z;
    const dy = Math.abs(target.pos.y - dog.pos.y);
    if (Math.hypot(dx, dz) <= range && dy < 1.1 && dog.biteCd <= 0) {
      dog.biteCd = interval;
      Mobs.damageMob(target, damage, { attacker: dog });
      return true;
    }
    return false;
  }

  // 撕咬玩家目标：actor.hurt 由调用方裁决（房主本人走本地 hurtPlayer，
  // 联机客人走房主权威 hostHurtGuest 后经 gh 消息在客人端扣血）
  function tryBiteActor(m, actor) {
    const p = actor.pos;
    const dx = p.x - m.pos.x, dz = p.z - m.pos.z;
    const dy = Math.abs(p.y - m.pos.y);
    const range = m.cfg.biteRange || 1.6;
    if (Math.hypot(dx, dz) <= range && dy < 1.4 && m.biteCd <= 0) {
      m.biteCd = m.cfg.biteInterval || 1;
      return actor.hurt(m.cfg.damage || 2, m);
    }
    return false;
  }

  /* ---------------- 牛 / 羊繁殖（麦子喂食 -> 恋爱 -> 配对 -> 幼崽） ---------------- */

  // 寻找 BREED_RANGE 内同类型、同为恋爱模式、尚未配对的成年动物
  function findMate(m) {
    let best = null, bestD2 = BREED_RANGE * BREED_RANGE;
    for (const o of mobs) {
      if (o === m || o.dead || o.type !== m.type || o.baby || o.ridden) continue;
      if (o.breedT > 0 || o.loveT <= 0 || o.mate) continue;
      if (Math.abs(o.pos.y - m.pos.y) > 1.6) continue;
      const d2 = (o.pos.x - m.pos.x) ** 2 + (o.pos.z - m.pos.z) ** 2;
      if (d2 < bestD2) { bestD2 = d2; best = o; }
    }
    return best;
  }

  // 幼崽 / 成年造型切换：整体缩放碰撞与模型；牛 / 羊的幼崽额外放大头部，
  // 形成原版"大头小身"的幼崽比例（房主与联网镜像共用）
  function applyBabyLook(m, baby) {
    const baseW = m.adultW || m.cfg.width, baseH = m.adultH || m.cfg.height;
    m.width = baby ? baseW * BABY_SCALE : baseW;
    m.height = baby ? baseH * BABY_SCALE : baseH;
    m.root.scale.setScalar(baby ? BABY_SCALE : 1);
    const p = m.parts;
    if (p && p.headBase) {
      const headScale = BABY_HEAD_SCALE[m.type] || 1;
      p.head.scale.setScalar(baby ? headScale : 1);
      p.head.position.copy(baby ? p.headBase.babyPos : p.headBase.pos);
    }
    if (p && p.pigEars) p.pigEars.forEach(function (e) { e.visible = !baby; });
    if (m.type === "panda") applyPandaMood(m);
  }

  // 把一只新生幼崽放到指定坐标的地表
  function spawnBabyAt(type, x, z) {
    const gx = Math.floor(x), gz = Math.floor(z);
    const gy = world.heightAt(gx, gz) + 1;
    const m = Mobs.spawn(type, gx + 0.5, gy, gz + 0.5);
    m.baby = true;
    m.growT = GROW_TIME;
    applyBabyLook(m, true);
    hooks.burst(m.pos.x, m.pos.y + 0.7, m.pos.z, 0xff8fc0);
    hooks.toast("两只" + TYPES[type].name + "生下了一只小" + TYPES[type].name + "！");
    return m;
  }

  // 交配倒计时结束：由双方中先归零的一方处理一次（立即解除双方 mate 引用）
  function finishBreed(m) {
    const a = m, b = m.mate;
    a.breedT = 0;
    a.mate = null;
    if (b) { b.breedT = 0; b.mate = null; }
    if (!b || b.dead || b.type !== a.type) {
      // 同伴消失：保留几秒恋爱时间重新寻找
      if (!a.dead && !a.baby) a.loveT = Math.max(a.loveT, 6);
      return;
    }
    const d = Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z);
    if (d > 3.2) {
      // 没能走到一起（被地形卡住等）：回到恋爱模式稍后重试
      a.loveT = Math.max(a.loveT, 8);
      b.loveT = Math.max(b.loveT, 8);
      return;
    }
    // 成功繁殖：双方进入冷却，在中间位置生下幼崽
    a.loveT = 0; b.loveT = 0;
    a.breedCd = BREED_COOLDOWN; b.breedCd = BREED_COOLDOWN;
    spawnBabyAt(a.type, (a.pos.x + b.pos.x) / 2, (a.pos.z + b.pos.z) / 2);
  }

  // 幼崽长大：恢复成年碰撞尺寸与模型缩放
  function growUp(m) {
    if (!m.baby) return;
    m.baby = false;
    m.growT = 0;
    applyBabyLook(m, false);
    hooks.burst(m.pos.x, m.pos.y + m.height * 0.6, m.pos.z, 0x9fe06a);
  }

  /* ---------------- 物理：重力 + 逐轴 AABB 碰撞（同玩家） ---------------- */

  // 头顶两格都是空气 = 暴露在天空下（洞穴 / 树荫 / 屋顶下不燃烧）
  function isExposedToSky(m) {
    if (!world) return true;
    const cx = Math.floor(m.pos.x), cz = Math.floor(m.pos.z);
    const y = Math.floor(m.pos.y + m.height * 0.55);
    return world.getBlock(cx, y, cz) === BLOCK.AIR &&
           world.getBlock(cx, y + 1, cz) === BLOCK.AIR;
  }

  function feetBlock(m, dy) {
    return world.getBlock(Math.floor(m.pos.x), Math.floor(m.pos.y + dy), Math.floor(m.pos.z));
  }

  function updatePhysics(m, dt) {
    const feetWater = feetBlock(m, 0.2) === BLOCK.WATER;
    if (feetWater) {
      m.vel.y -= 26 * 0.25 * dt;
      if (m.vel.y < 0 && feetBlock(m, -0.2) === BLOCK.WATER) m.vel.y = 2.4;
      m.vel.y = Math.max(-2.5, Math.min(2.6, m.vel.y));
    } else {
      m.vel.y -= 26 * dt;
      if (m.vel.y < -40) m.vel.y = -40;
    }

    const beforeX = m.pos.x, beforeZ = m.pos.z;
    m.onGround = false;
    moveAxis(m, "x", m.vel.x * dt);
    moveAxis(m, "z", m.vel.z * dt);
    moveAxis(m, "y", m.vel.y * dt);

    // 无限世界无水平边界；掉出世界（进未加载区等异常）时拉回地表
    if (m.pos.y < -8) {
      m.pos.y = world.heightAt(Math.floor(m.pos.x), Math.floor(m.pos.z)) + 1;
      m.vel.set(0, 0, 0);
    }

    // 走不动 -> 攒一会儿就跳（跨 1 格台阶 / 爬坡）。坐着的狗不跳
    if (m.wantMove && m.onGround && !m.sitting && !m.ridden) {
      const moved = Math.hypot(m.pos.x - beforeX, m.pos.z - beforeZ);
      if (moved < m.cfg.speed * dt * 0.35) {
        m.blockedT += dt;
        if (m.blockedT > 0.22 && !feetWater) { m.vel.y = 7.6; m.blockedT = 0; m.stateT = Math.min(m.stateT, 0.4); }
      } else {
        m.blockedT = 0;
      }
    }

    m.root.position.copy(m.pos);
    let dyaw = m.yaw - m.renderYaw;
    while (dyaw > Math.PI) dyaw -= Math.PI * 2;
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    m.renderYaw += dyaw * Math.min(1, dt * 8);
    m.root.rotation.y = m.renderYaw;
  }

  function moveAxis(m, axis, amount) {
    if (amount === 0) return;
    m.pos[axis] += amount;

    const hw = m.width / 2, p = m.pos;
    let minX = p.x - hw, maxX = p.x + hw;
    let minY = p.y, maxY = p.y + m.height;
    let minZ = p.z - hw, maxZ = p.z + hw;
    const eps = 1e-7;

    // 扫描范围外扩 1 格，避免漏检跨越格界的碰撞盒（1.5 格围栏 / 栅门、开门门板）
    const x0 = Math.floor(minX) - 1, x1 = Math.floor(maxX - eps) + 1;
    const y0 = Math.floor(minY) - 1, y1 = Math.floor(maxY - eps) + 1;
    const z0 = Math.floor(minZ) - 1, z1 = Math.floor(maxZ - eps) + 1;

    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          const boxes = collisionBoxesOf(world.getBlock(x, y, z));
          if (!boxes) continue;
          for (const b of boxes) {
            const bx0 = x + b[0], by0 = y + b[1], bz0 = z + b[2];
            const bx1 = x + b[3], by1 = y + b[4], bz1 = z + b[5];
            if (bx0 >= maxX || bx1 <= minX || by0 >= maxY || by1 <= minY || bz0 >= maxZ || bz1 <= minZ) continue;
            if (axis === "y") {
              if (amount < 0) { if (by1 > p.y) p.y = by1; m.onGround = true; }
              else { if (by0 - m.height < p.y) p.y = by0 - m.height; }
              m.vel.y = 0;
            } else if (axis === "x") {
              p.x = amount > 0 ? bx0 - hw - eps : bx1 + hw + eps;
              m.vel.x = 0;
            } else {
              p.z = amount > 0 ? bz0 - hw - eps : bz1 + hw + eps;
              m.vel.z = 0;
            }
            minX = p.x - hw; maxX = p.x + hw;
            minY = p.y;      maxY = p.y + m.height;
            minZ = p.z - hw; maxZ = p.z + hw;
          }
        }
      }
    }
  }

  // 动物间轻微互相推开（不参与尸体 / 骑手猪）
  function separate() {
    for (let i = 0; i < mobs.length; i++) {
      const a = mobs[i];
      if (a.dead || a.sitting) continue;
      for (let j = i + 1; j < mobs.length; j++) {
        const b = mobs[j];
        if (b.dead || b.sitting) continue;
        const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
        const minD = (a.width + b.width) * 0.5;
        const d2 = dx * dx + dz * dz;
        if (d2 > 0.0001 && d2 < minD * minD && Math.abs(a.pos.y - b.pos.y) < 0.6) {
          const d = Math.sqrt(d2), push = (minD - d) * 0.5;
          const px = dx / d * push, pz = dz / d * push;
          a.pos.x -= px; a.pos.z -= pz;
          b.pos.x += px; b.pos.z += pz;
        }
      }
    }
  }

  /* ---------------- 动画 ---------------- */

  function updateAnimation(m, dt) {
    const p = m.parts;
    if (m.cfg.boss) { updateDragonAnim(m, dt); return; }
    if (m.sitting && m.type === "dog") {
      // 坐姿：后腿蜷起、身体下沉（新模型腿更长，下沉 0.22）、前腿撑直
      for (const leg of p.legs) leg.pivot.rotation.x += ((leg.front ? 0 : 1.05) - leg.pivot.rotation.x) * 0.2;
      p.bodyGroup.position.y += (-0.22 - p.bodyGroup.position.y) * 0.2;
      if (p.head) p.head.rotation.x += (0.12 - p.head.rotation.x) * 0.2;
    } else if (m.moving) {
      // 幼崽小短腿倒得更快，更显活泼
      m.phase += dt * (5.5 + m.cfg.speed * 2.2) * (m.baby ? 1.6 : 1);
      const swing = Math.sin(m.phase) * 0.55;
      for (const leg of p.legs) leg.pivot.rotation.x = (leg.phase ? -swing : swing);
      if (p.arms) {
        // 僵尸前伸的双臂小幅度前后晃
        for (const a of p.arms) a.pivot.rotation.x = 1.45 + (a.phase ? -swing * 0.18 : swing * 0.18);
      }
      p.bodyGroup.position.y = Math.abs(Math.sin(m.phase)) * 0.025;
      if (p.head) p.head.rotation.x = 0.08 + Math.sin(m.phase) * 0.06;
    } else {
      restPose(m);
    }
    // 熊猫愤怒：冲锋时低头前扑；贴到玩家身边咬不到移动空间时原地瞪眼跺脚示威
    if (m.type === "panda" && m.mode === "anger") {
      if (p.head) p.head.rotation.x += ((m.moving ? 0.22 : -0.12) - p.head.rotation.x) * 0.18;
      if (!m.moving) {
        p.bodyGroup.position.y = Math.abs(Math.sin(performance.now() * 0.012)) * 0.035;
      }
    }
    // 受击闪白：整体材质切换成本高，用模型轻微后仰+一顿表现
    if (m.hurtT > 0) {
      p.bodyGroup.position.y += 0.02;
    }
    if (p.tail) {
      if (m.type === "dog") {
        // 尾自然下垂：野生向后倾 0.9（约水平线下 38°），驯服后近水平略翘 1.8（水平线上约 13°，参考图2）；驯服后摇得更欢
        const wag = m.owner ? 0.75 : 0.5;
        p.tail.rotation.y = Math.sin(performance.now() * (m.owner ? 0.02 : 0.012)) * wag;
        p.tail.rotation.x += ((m.owner ? -1.8 : -0.9) - p.tail.rotation.x) * 0.12;
      } else if (m.moving && m.type !== "cow") {
        p.tail.rotation.x = -0.25 + Math.sin(m.phase * 1.5) * 0.12;
      } else if (m.type !== "cow") {
        p.tail.rotation.x *= 0.85;
      }
    }
  }

  function restPose(m) {
    const p = m.parts;
    for (const leg of p.legs) leg.pivot.rotation.x *= 0.8;
    if (p.arms) {
      for (const a of p.arms) a.pivot.rotation.x += (1.45 - a.pivot.rotation.x) * 0.2;
    }
    p.bodyGroup.position.y *= 0.8;
    if (p.head) p.head.rotation.x *= 0.8;
  }

  /* ============================================================
   * 紫黑龙 Boss：飞行 AI + 喷火 / 火球技能 + 地面龙炎
   * ============================================================ */

  const DRAGON_AGGRO_R = 30;     // 玩家距火山中心这么近即遭攻击
  const DRAGON_DISENGAGE = 50;   // 被拉离火山这么远则脱战归巢
  const BREATH_LEN = 11;         // 火焰锥最大射程
  const FIRE_MAX = 42;           // 同屏地面火焰上限

  // 火焰 / 火球共享材质（自发光，夜里也明亮）
  let fireRes = null;
  function getFireRes() {
    if (!fireRes) {
      // 火是自发光体：跳过 ACES 色调映射，否则高饱和橙黄会被压成奶白色
      fireRes = {
        geo: new THREE.BoxGeometry(1, 1, 1),
        edge: new THREE.MeshBasicMaterial({ color: 0xd23f0c, toneMapped: false }),  // 外焰·深橙红
        outer: new THREE.MeshBasicMaterial({ color: 0xff7a1c, toneMapped: false }), // 外焰·橙
        mid: new THREE.MeshBasicMaterial({ color: 0xffc13b, toneMapped: false }),   // 内焰·金黄
        core: new THREE.MeshBasicMaterial({ color: 0xfff0a0, toneMapped: false }),  // 火芯·亮白黄
        ball: new THREE.MeshBasicMaterial({ color: 0xff7a1c, toneMapped: false }),
        ballCore: new THREE.MeshBasicMaterial({ color: 0xffe28a, toneMapped: false })
      };
    }
    return fireRes;
  }

  function groundAt(x, z) {
    return world.heightAt(Math.floor(x), Math.floor(z)) + 1;
  }

  /* ---------------- 地面龙炎 ---------------- */

  function spawnFire(x, z, owner) {
    if (!world) return;
    const gx = Math.floor(x), gz = Math.floor(z);
    const h = world.heightAt(gx, gz);
    const surface = world.getBlock(gx, h, gz);
    if (surface === BLOCK.WATER || isLava(surface)) return;
    if (world.getBlock(gx, h + 1, gz) !== BLOCK.AIR) return;
    // 同一格火焰只刷新持续时间
    for (const f of bossFires) {
      if (f.gx === gx && f.gz === gz) { f.ttl = Math.max(f.ttl, 3.6); return; }
    }
    if (bossFires.length >= FIRE_MAX) removeFire(0);
    const built = buildFireGroup();
    const g = built.group, tongues = built.tongues;
    g.position.set(gx + 0.5, h + 1, gz + 0.5);
    scene.add(g);
    bossFires.push({
      group: g, gx: gx, gz: gz, y: h + 1, ttl: 4.2, hurtT: 0, age: 0,
      actorHurt: {},
      phase: Math.random() * 6.28, gust: Math.random() * 6.28,
      owner: owner, tongues: tongues
    });
  }

  // 构建一簇地面龙炎的全部火舌 mesh（房主真身 / 客人镜像共用，保证双端外观一致）
  function buildFireGroup() {
    const r = getFireRes();
    const g = new THREE.Group();
    const tongues = [];
    // 一片火舌 = 根部枢轴组 + 盒体：缩放与摇摆都绕根部进行，顶端自然甩动
    const addTongue = (mat, ox, oz, w, bh, tiltX, tiltZ, amp, f1, f2) => {
      const pivot = new THREE.Group();
      pivot.position.set(ox, 0, oz);
      pivot.rotation.set(tiltX, 0, tiltZ);
      const m = new THREE.Mesh(r.geo, mat);
      m.position.y = bh / 2;
      m.scale.set(w, bh, w);
      pivot.add(m);
      g.add(pivot);
      tongues.push({
        pivot: pivot, mesh: m, w: w, h: bh, ox: ox, oz: oz,
        ph: Math.random() * Math.PI * 2, f1: f1, f2: f2,
        amp: amp, tiltX: tiltX, tiltZ: tiltZ,
        spin: 0.55 + Math.random() * 0.9
      });
    };
    // 底部小而深的红火床（根部，不做成宽台）
    addTongue(r.edge, 0, 0, 0.4, 0.14, 0, 0, 0.02, 7.5, 13);
    // 外圈深红：短而外撇，包住根部形成可见的红色火裙
    for (let k = 0; k < 3; k++) {
      const a = k * Math.PI * 2 / 3 + (Math.random() - 0.5) * 0.5;
      const rad = 0.15 + Math.random() * 0.05;
      const lean = 0.12 + Math.random() * 0.08;
      addTongue(r.edge,
        Math.cos(a) * rad, Math.sin(a) * rad,
        0.14 + Math.random() * 0.06, 0.55 + Math.random() * 0.25,
        Math.cos(a) * lean, Math.sin(a) * lean,
        0.13 + Math.random() * 0.05, 5.5 + Math.random() * 4, 10 + Math.random() * 5);
    }
    // 内圈橙：拔成最高的火冠
    for (let k = 0; k < 3; k++) {
      const a = k * Math.PI * 2 / 3 + Math.PI / 3 + (Math.random() - 0.5) * 0.4;
      const rad = 0.07 + Math.random() * 0.06;
      const lean = 0.04 + Math.random() * 0.06;
      addTongue(r.outer,
        Math.cos(a) * rad, Math.sin(a) * rad,
        0.12 + Math.random() * 0.06, 0.78 + Math.random() * 0.34,
        Math.cos(a) * lean, Math.sin(a) * lean,
        0.1 + Math.random() * 0.06, 6 + Math.random() * 4.5, 11 + Math.random() * 5);
    }
    // 金黄内焰：两条高火苗从橙舌缝隙里蹿出
    for (let k = 0; k < 2; k++) {
      const a = k * Math.PI + (Math.random() - 0.5) * 0.6;
      addTongue(r.mid,
        Math.cos(a) * 0.05, Math.sin(a) * 0.05,
        0.12 + Math.random() * 0.05, 0.72 + Math.random() * 0.3,
        (Math.random() - 0.5) * 0.08, (Math.random() - 0.5) * 0.08,
        0.12 + Math.random() * 0.05, 7 + Math.random() * 4, 12 + Math.random() * 5);
    }
    // 中心白亮火芯：两条细火苗，在根部最旺处跳动
    for (let k = 0; k < 2; k++) {
      addTongue(r.core,
        (Math.random() - 0.5) * 0.04, (Math.random() - 0.5) * 0.04,
        0.1 + Math.random() * 0.05, 0.55 + Math.random() * 0.25,
        (Math.random() - 0.5) * 0.06, (Math.random() - 0.5) * 0.06,
        0.08 + Math.random() * 0.04, 8 + Math.random() * 4, 14 + Math.random() * 4);
    }
    return { group: g, tongues: tongues };
  }

  function removeFire(i) {
    const f = bossFires[i];
    if (!f) return;
    scene.remove(f.group);
    bossFires.splice(i, 1);
  }

  function clearBossFx() {
    if (!scene) { bossFires.length = 0; bossFireballs.length = 0; return; }
    for (let i = bossFires.length - 1; i >= 0; i--) {
      scene.remove(bossFires[i].group);
      bossFires.splice(i, 1);
    }
    for (let i = bossFireballs.length - 1; i >= 0; i--) {
      scene.remove(bossFireballs[i].group);
      bossFireballs.splice(i, 1);
    }
  }

  /* ---------------- 火球 ---------------- */

  function buildFireballMesh() {
    const r = getFireRes();
    const g = new THREE.Group();
    const core = new THREE.Mesh(r.geo, r.ball); core.scale.set(0.36, 0.36, 0.36);
    const hot = new THREE.Mesh(r.geo, r.ballCore); hot.scale.set(0.18, 0.18, 0.18);
    g.add(core, hot);
    return g;
  }

  function launchDragonFireballs(m, pp, n) {
    m.root.updateMatrixWorld(true);
    m.parts.mouth.getWorldPosition(_mouthPos);
    const spawned = [];
    for (let i = 0; i < n; i++) {
      const spread = n > 1 ? (i - 1) * 0.16 : 0;
      let dx = pp.x - _mouthPos.x, dz = pp.z - _mouthPos.z;
      const l = Math.hypot(dx, dz) || 1;
      dx /= l; dz /= l;
      const cs = Math.cos(spread), sn = Math.sin(spread);
      const ax = dx * cs - dz * sn, az = dx * sn + dz * cs;
      const flight = l / 13;
      const vy = (pp.y + 1.1 - _mouthPos.y) / flight + 0.5 * 5.5 * flight;  // 带抛物线提前量

      const g = buildFireballMesh();
      g.position.copy(_mouthPos);
      scene.add(g);
      const vx = ax * 13, vz = az * 13;
      bossFireballs.push({ group: g, ttl: 3.2, owner: m, vel: new THREE.Vector3(vx, vy, vz) });
      // 同步给客人做纯表现镜像（物理确定性一致，命中/伤害仍由房主裁决）
      spawned.push({
        x: r3(_mouthPos.x), y: r3(_mouthPos.y), z: r3(_mouthPos.z),
        vx: r3(vx), vy: r3(vy), vz: r3(vz)
      });
    }
    if (spawned.length) hooks.bossBalls(spawned);
    for (let i = 0; i < 4; i++) {
      hooks.burst(Math.floor(_mouthPos.x), Math.floor(_mouthPos.y), Math.floor(_mouthPos.z),
                  i % 2 ? 0xff8a2a : 0xffc13b);
    }
  }

  /* ---------------- 喷火锥 ---------------- */

  function doDragonBreath(m, dt, actors, pp) {
    m.root.updateMatrixWorld(true);
    m.parts.mouth.getWorldPosition(_mouthPos);

    // 喷射方向缓慢追踪玩家，避免必中但又不会轻易甩脱
    const tdx = pp.x - _mouthPos.x, tdz = pp.z - _mouthPos.z;
    const tl = Math.hypot(tdx, tdz) || 1;
    const tk = Math.min(1, dt * 1.9);
    let ax = m.aim.x + (tdx / tl - m.aim.x) * tk;
    let az = m.aim.z + (tdz / tl - m.aim.z) * tk;
    const al = Math.hypot(ax, az) || 1;
    m.aim.x = ax / al; m.aim.z = az / al;
    m.aimPitch = Math.atan2(pp.y + 1.2 - _mouthPos.y, tl);

    // 火焰粒子：沿锥形喷射，侧向量 = (-az, ax)
    for (let i = 0; i < 4; i++) {
      const t = 0.25 + Math.random() * 0.75;
      const spread = 0.12 + t * 0.42;
      const side = (Math.random() - 0.5) * 2 * spread;
      const px = _mouthPos.x + m.aim.x * BREATH_LEN * t + (-m.aim.z) * side * BREATH_LEN * t * 0.5;
      const pz = _mouthPos.z + m.aim.z * BREATH_LEN * t + (m.aim.x) * side * BREATH_LEN * t * 0.5;
      let py = _mouthPos.y + m.aimPitch * BREATH_LEN * t - t * t * 1.5 + (Math.random() - 0.5) * 0.5;
      const fy = groundAt(px, pz);
      if (py < fy + 0.2) py = fy + 0.2 + Math.random() * 0.25;
      hooks.burst(Math.floor(px), Math.floor(py), Math.floor(pz),
                  [0xfff0a0, 0xffc13b, 0xff7a1c, 0xff4a12][Math.floor(Math.random() * 4)]);
      if (Math.random() < 0.16 && t > 0.35) spawnFire(px, pz, m);
    }

    // 玩家在锥内：每个目标独立判定，每 0.5 秒受 3 点火焰伤害
    const inCone = function (a) {
      const vx = a.pos.x - _mouthPos.x, vz = a.pos.z - _mouthPos.z;
      const hd = Math.hypot(vx, vz);
      const dot = hd > 0.01 ? (vx * m.aim.x + vz * m.aim.z) / hd : 0;
      const vertOk = a.pos.y < _mouthPos.y + 2.5 && a.pos.y > _mouthPos.y - 6;
      return hd < BREATH_LEN && dot > 0.62 && vertOk;
    };
    let anyInCone = false;
    for (const a of actors) if (inCone(a)) { anyInCone = true; break; }
    if (anyInCone) {
      m.flameTick -= dt;
      if (m.flameTick <= 0) {
        m.flameTick = 0.5;
        for (const a of actors) if (inCone(a)) a.hurt(3, m);
      }
    }
  }

  /* ---------------- 技能状态机 ---------------- */

  function updateDragonCast(m, dt, actors, pp, dPlayer) {
    const enraged = m.hp < m.maxHp * 0.4;
    if (m.cast === null) {
      m.mouthGlow = 0;
      // 提前决定下个技能：火球需要拉开距离，盘旋半径由 updateDragon 读取
      if (m.nextSkill === undefined) {
        m.nextSkill = Math.random() < (enraged ? 0.35 : 0.55) ? "breath" : "ball";
      }
      m.skillCd -= dt;
      if (m.skillCd <= 0 && dPlayer < 20) {
        // 距离修正：贴脸时改用吐息，拉远时改用火球
        let plan = m.nextSkill;
        if (plan === "ball" && dPlayer < 8) plan = "breath";
        if (plan === "breath" && dPlayer >= 13) plan = "ball";
        m.nextSkill = undefined;
        if (plan === "breath") { m.cast = "windup_breath"; m.castT = 0.8; }
        else { m.cast = "windup_ball"; m.castT = 0.5; }
      }
      return;
    }
    m.castT -= dt;
    if (m.cast === "windup_breath") {
      const p01 = 1 - Math.max(0, m.castT) / 0.8;
      m.mouthGlow = 1 + p01 * 3.5;
      if (!m.breathWarned) {
        m.breathWarned = true;
        hooks.toast("紫黑龙深吸一口气——它要喷火了！");
      }
      if (m.castT <= 0) {
        m.root.updateMatrixWorld(true);
        m.parts.mouth.getWorldPosition(_mouthPos);
        const dx = pp.x - _mouthPos.x, dz = pp.z - _mouthPos.z;
        const l = Math.hypot(dx, dz) || 1;
        m.aim.x = dx / l; m.aim.z = dz / l;
        m.aimPitch = Math.atan2(pp.y + 1.2 - _mouthPos.y, l);
        m.flameTick = 0;
        m.cast = "breath"; m.castT = 1.7;
      }
    } else if (m.cast === "breath") {
      m.mouthGlow = 5.5 + Math.random() * 2.5;
      doDragonBreath(m, dt, actors, pp);
      if (m.castT <= 0) {
        m.cast = "recover"; m.castT = 0.5;
        m.skillCd = enraged ? 3 + Math.random() * 1.8 : 5 + Math.random() * 3;
      }
    } else if (m.cast === "windup_ball") {
      const p01 = 1 - Math.max(0, m.castT) / 0.5;
      m.mouthGlow = 0.8 + p01 * 2.5;
      if (m.castT <= 0) {
        launchDragonFireballs(m, pp, enraged ? 3 : 1);
        m.cast = "recover"; m.castT = 0.4;
        m.skillCd = enraged ? 2.6 + Math.random() * 2 : 4.2 + Math.random() * 2.5;
      }
    } else if (m.cast === "recover") {
      m.mouthGlow *= 0.88;
      if (m.castT <= 0) {
        m.cast = null;
        // 为下一轮技能预摇：正常 55% 吐息，狂暴后火球更多
        m.nextSkill = Math.random() < (enraged ? 0.35 : 0.55) ? "breath" : "ball";
      }
    }
  }

  /* ---------------- Boss 主 AI（飞行，无地形碰撞，只做离地保护） ---------------- */

  function updateDragon(m, dt, actors) {
    m.hurtT = Math.max(0, m.hurtT - dt);
    m.biteCd = Math.max(0, m.biteCd - dt);
    m.flapT += dt * (m.bossState === "engage" ? 7.2 : 4.0);
    if (global.__freezeDragon) return;   // 调试：冻结 Boss AI 与位移（扇翅动画仍推进）

    // 多玩家：记录每人与巢 / 与龙的距离，主目标 pp = 离龙最近的人
    if (!m.biteActorCd) m.biteActorCd = {};
    for (const k in m.biteActorCd) m.biteActorCd[k] = Math.max(0, m.biteActorCd[k] - dt);
    let pp = actors[0].pos;
    let dPlayer = Infinity;
    let anyNear = false, allFar = true;
    for (const a of actors) {
      const dHome = Math.hypot(a.pos.x - m.home.x, a.pos.z - m.home.z);
      const d = Math.hypot(a.pos.x - m.pos.x, a.pos.z - m.pos.z);
      if (dHome < DRAGON_AGGRO_R || d < 16) anyNear = true;
      if (!(dHome > DRAGON_DISENGAGE && d > 24)) allFar = false;
      if (d < dPlayer) { dPlayer = d; pp = a.pos; }
    }
    const dpx = pp.x - m.pos.x, dpz = pp.z - m.pos.z;

    // 状态切换：任一人近火山顶 -> 交战；所有人都被拉远 -> 归巢
    if (m.bossState === "idle") {
      if (anyNear) {
        m.bossState = "engage";
        m.breathWarned = false;
        if (!m.announced) {
          m.announced = true;
          hooks.toast("你靠近了火山顶……紫黑龙被惊醒了！");
        }
        showBar(m);
      }
    } else if (m.bossState === "engage") {
      if (allFar) {
        m.bossState = "return";
        m.cast = null; m.castT = 0;
        hideBossHud();
      }
    } else if (m.bossState === "return") {
      m.hp = Math.min(m.maxHp, m.hp + 8 * dt);   // 归巢缓慢回血
      const dh = Math.hypot(m.home.x - m.pos.x, m.home.z - m.pos.z);
      if (dh < 4 && Math.abs(m.pos.y - m.roostY) < 2.5) m.bossState = "idle";
    }

    // 期望位置 / 速度 / 朝向
    let tx = m.pos.x, tz = m.pos.z, ty = m.pos.y, speed = m.cfg.speed;
    let faceX = 0, faceZ = 1;

    if (m.bossState === "idle") {
      // 无人靠近：落在火山 rim 趴伏点静止栖息（趴姿动画见 updateDragonAnim）
      const pc = m.perch || { x: m.home.x, z: m.home.z, y: m.roostY - 5.5, yaw: 0 };
      tx = pc.x; tz = pc.z;
      ty = pc.y - 0.62;
      speed = 1.6;
      faceX = -Math.sin(pc.yaw || 0); faceZ = -Math.cos(pc.yaw || 0);
      m.mouthGlow = 0;
    } else if (m.bossState === "return") {
      const a = m.flapT * 0.4;
      tx = m.home.x + Math.cos(a) * 3;
      tz = m.home.z + Math.sin(a) * 3;
      ty = m.roostY;
      speed = 8.5;
      faceX = tx - m.pos.x; faceZ = tz - m.pos.z;
      m.mouthGlow = 0;
    } else {
      // engage：技能 + 盘旋 + 俯冲撕咬
      const enraged = m.hp < m.maxHp * 0.4;
      updateDragonCast(m, dt, actors, pp, dPlayer);
      m.swoopT -= dt;
      if (m.swoopT <= -0.9) m.swoopT = enraged ? 4.2 + Math.random() * 1.5 : 6 + Math.random() * 2;
      const swooping = m.swoopT <= 0;
      const casting = m.cast !== null && m.cast !== "recover";

      m.strafeA += dt * (0.65 + (enraged ? 0.3 : 0));
      // 火球蓄势/预备火球时拉到 14 格距离，吐息贴近到 9 格，常规盘旋 7 格
      const ballMoment = m.cast === "windup_ball" || (!casting && m.nextSkill === "ball");
      const radius = swooping ? 1.8 : (casting ? (m.cast === "windup_ball" ? 14 : 9) : (ballMoment ? 14 : 7));
      tx = pp.x + Math.cos(m.strafeA) * radius;
      tz = pp.z + Math.sin(m.strafeA) * radius;
      ty = pp.y + (swooping ? 1.4 : 3.6) + Math.sin(m.flapT * 1.3) * 0.35;
      speed = swooping ? m.cfg.chaseSpeed + 1.5 : (casting ? 3.2 : m.cfg.chaseSpeed);
      faceX = dpx; faceZ = dpz;

      // 俯冲撕咬：每个在范围内的玩家独立判定（各自 1.3s 受击间隔），
      // 任一人实际掉血即结束本次俯冲
      if (swooping && !casting) {
        for (const a of actors) {
          const ad = Math.hypot(a.pos.x - m.pos.x, a.pos.z - m.pos.z);
          const dyBite = Math.abs((a.pos.y + 1.2) - (m.pos.y + 1.4));
          if (ad < m.cfg.biteRange && dyBite < 2.6 && (m.biteActorCd[a.id] || 0) <= 0) {
            if (a.hurt(m.cfg.damage, m)) {
              m.biteActorCd[a.id] = m.cfg.biteInterval;
              m.swoopT = enraged ? 4.2 + Math.random() * 1.5 : 6 + Math.random() * 2;
            }
          }
        }
      }
      showBossHud(m);
    }

    // 弹簧式速度追踪
    let dx = tx - m.pos.x, dz = tz - m.pos.z, dy = ty - m.pos.y;
    const dist = Math.hypot(dx, dz);
    let wantX = 0, wantZ = 0;
    if (dist > 0.05) {
      const sp = Math.min(speed, dist * 2.2);
      wantX = dx / dist * sp;
      wantZ = dz / dist * sp;
    }
    const wantY = THREE.MathUtils.clamp(dy * 2.2, -speed, speed);
    const kk = Math.min(1, dt * 3.5);
    m.vel.x += (wantX - m.vel.x) * kk;
    m.vel.z += (wantZ - m.vel.z) * kk;
    m.vel.y += (wantY - m.vel.y) * kk;
    m.pos.x += m.vel.x * dt;
    m.pos.y += m.vel.y * dt;
    m.pos.z += m.vel.z * dt;

    // 离地保护：飞行状态始终保持地表 1.8 格以上；idle 趴伏时允许落到台面
    const gy = groundAt(m.pos.x, m.pos.z);
    const minY = m.bossState === "idle" ? gy - 0.9 : gy + 1.8;
    if (m.pos.y < minY) { m.pos.y = minY; if (m.vel.y < 0) m.vel.y = 0; }

    // 朝向
    const fl = Math.hypot(faceX, faceZ);
    if (fl > 0.01) m.yaw = Math.atan2(-faceX, -faceZ);
    let dyaw = m.yaw - m.renderYaw;
    while (dyaw > Math.PI) dyaw -= Math.PI * 2;
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    m.renderYaw += dyaw * Math.min(1, dt * 7);
    m.root.position.copy(m.pos);
    m.root.rotation.y = m.renderYaw;
  }

  /* ---------------- Boss 动画 ---------------- */

  function updateDragonAnim(m, dt) {
    const p = m.parts;
    const engaged = m.bossState === "engage";
    const casting = m.cast && m.cast !== "recover";
    const swooping = engaged && m.swoopT <= 0;
    const resting = m.bossState === "idle";
    const k = 1 - Math.exp(-dt * 3.5);
    const L = rate => Math.min(1, dt * rate);

    // 姿态因子 f：0=悬停竖姿，1=俯冲平姿（四肢收拢、长尾拖后）；趴伏直接走完全横卧
    let fTarget;
    if (resting) fTarget = 1;
    else if (m.bossState === "return") fTarget = 0.8;
    else fTarget = casting ? 0.05 : (swooping ? 1 : 0.82);
    if (m.flightF === undefined) m.flightF = 0.5;
    m.flightF += (fTarget - m.flightF) * k;
    const f = m.flightF;

    // 身体绕肩部前俯（-Z 为脸朝向，负 X 旋转让躯干倒向水平）。趴伏≈完全横卧
    const pitch = resting ? -1.30 : -0.04 - 1.06 * f;
    p.pose.rotation.x += (pitch - p.pose.rotation.x) * L(5);

    // 翼：fold=绕躯干轴向内收拢量（趴伏时折叠贴背），raise=外侧上下拍动量
    let fold, raise;
    if (resting) {
      fold = 1.9;
      raise = 0.14 + Math.sin(m.flapT * 0.5) * 0.02;     // 折叠后仅翼尖轻翘 + 呼吸微起伏
    } else {
      fold = 0;
      let base = 0.06 + 0.32 * f, amp = 0.06 + (engaged ? 0.52 : 0.30) * f;
      if (m.cast === "windup_breath" || m.cast === "breath") { base = 0.12; amp = 0.05; }
      else if (m.cast === "windup_ball") { base = 0.22; amp = 0.08; }
      if (swooping) { base = 0.5; amp = 0.12; }
      raise = base + Math.sin(m.flapT) * amp;
    }
    // 趴伏额外绕肩前后轴把竖直翼膜放倒折叠到体侧/背上；飞行展翼时归零
    const wingDrop = resting ? 1.2 : 0;
    for (const w of p.wings) {
      w.pivot.rotation.x += (wingDrop - w.pivot.rotation.x) * L(4);
      w.pivot.rotation.y += (-w.sx * fold - w.pivot.rotation.y) * L(4);
      w.pivot.rotation.z += ( w.sx * raise - w.pivot.rotation.z) * L(6);
    }

    // 头颈：飞行俯姿时反向补偿保持朝向；趴伏时长颈昂起（警觉栖姿）——
    // 龙身横卧台面、整体只比台沿高约 1.6 格，头不抬则坡下仰望只见角；
    // 抬到 0.75 后坡下第一眼可见红眼昂首，爬上台口平视时长颈+前爪探出岩坎
    let neckX;
    if (resting) {
      neckX = 0.75;
    } else {
      let aim;
      if (m.cast === "windup_breath") aim = 0.34;
      else if (m.cast === "breath") aim = THREE.MathUtils.clamp(m.aimPitch, -0.72, 0.45);
      else if (m.cast === "windup_ball") aim = 0.16;
      else aim = -0.1 * f;
      neckX = -p.pose.rotation.x * 0.95 + aim;
    }
    p.neck.rotation.x += (neckX - p.neck.rotation.x) * L(8);
    p.neck.rotation.y += ((resting ? Math.sin(m.flapT * 0.25) * 0.05
                                  : Math.sin(m.flapT * 0.6) * 0.07) - p.neck.rotation.y) * L(4);
    let jaw = 0;
    if (m.cast === "breath") jaw = -0.5;
    else if (m.cast === "windup_breath") jaw = -0.12;
    p.jaw.rotation.x += (jaw - p.jaw.rotation.x) * Math.min(1, dt * 10);

    // 后腿：趴伏向前折叠收在身下；飞行向后收拢
    const legT = resting ? 1.05 : -0.12 - 0.95 * f;
    for (const leg of p.legs) {
      const t = resting ? legT
              : legT + (leg.front ? 0.08 : 0) + Math.sin(m.flapT + leg.phase) * 0.05 * f;
      leg.pivot.rotation.x += (t - leg.pivot.rotation.x) * L(6);
    }
    // 前肢：趴伏前伸趴地；飞行微收
    if (p.arms) {
      for (let i = 0; i < p.arms.length; i++) {
        const a = p.arms[i];
        const t = resting ? 1.22 : -0.05 - 0.6 * f + Math.sin(m.flapT * 1.3 + i) * 0.05;
        a.pivot.rotation.x += (t - a.pivot.rotation.x) * L(6);
      }
    }

    // 长尾：趴伏贴地后展（盘绕曲线已烘焙在模型里）；飞行向后拖展 + 轻摆
    const tailX = resting ? 0.02 : -0.04 - 1.15 * f;
    p.tail.rotation.x += (tailX - p.tail.rotation.x) * L(5);
    p.tail.rotation.y += ((resting ? Math.sin(m.flapT * 0.25) * 0.03
                                  : Math.sin(m.flapT * 0.7) * 0.12 * (0.3 + f)) - p.tail.rotation.y) * L(3);
    p.tail.rotation.z += ((resting ? 0 : Math.sin(m.flapT * 0.9) * 0.05 * f) - p.tail.rotation.z) * L(3);

    // 身体起伏：趴伏仅呼吸般微浮，飞行随扇翅起伏；受击时抬升
    let bob = resting ? 0.012 + Math.sin(m.flapT * 0.5) * 0.012
                      : Math.abs(Math.sin(m.flapT)) * (0.04 + 0.05 * f);
    if (m.hurtT > 0) bob += 0.05;
    p.bodyGroup.position.y += (bob - p.bodyGroup.position.y) * L(8);

    // 嘴部火光（蓄力 / 喷射时由 m.mouthGlow 驱动）
    if (p.mouthLight) {
      p.mouthLight.intensity += ((m.mouthGlow || 0) - p.mouthLight.intensity) * Math.min(1, dt * 10);
    }
  }

  /* ---------------- 火球 / 龙炎每帧更新 ---------------- */

  function fireballHit(b, actors, directR) {
    const gp = b.group.position;
    for (const a of actors) {
      if (Math.hypot(a.pos.x - gp.x, (a.pos.y + 0.9) - gp.y, a.pos.z - gp.z) < directR) return true;
    }
    return false;
  }

  // 一簇龙炎的纯表现动画（房主真身与客人镜像共用）
  function animateFire(f, dt) {
    f.age += dt;
    // 出生弹出（ease-out）/ 熄灭前整体收缩
    const pop = Math.min(1, f.age / 0.16);
    const born = 1 - (1 - pop) * (1 - pop);
    const lifeK = Math.max(0, Math.min(1, f.ttl / 0.45)) * born;
    // 整簇火共享的阵风：缓波叠快波，强弱随机交替
    const gust = 0.5 + 0.5 * Math.sin(fxTime * 0.9 + f.gust)
               + 0.25 * Math.sin(fxTime * 2.3 + f.gust * 1.7);
    for (const t of f.tongues) {
      // 上下抽长：双频正弦叠加，每片火舌错频，不再整齐胀缩
      const fy = 0.82
        + 0.13 * Math.sin(fxTime * t.f1 + t.ph)
        + 0.07 * Math.sin(fxTime * t.f2 + t.ph * 1.7);
      const sy = Math.max(0.001, t.h * fy * lifeK);
      const sk = 1.12 - 0.16 * fy;             // 拉高时横向收腰
      const sxz = t.w * sk * lifeK;
      t.mesh.scale.set(sxz, sy, sxz);
      // 绕根部飘动：倾斜方向缓慢打旋 + 高频微抖，阵风来时甩得更开
      const sw = t.amp * (0.55 + 0.45 * gust) * Math.min(1, lifeK * 1.4);
      const ang = fxTime * t.spin + t.ph;
      t.pivot.rotation.x = t.tiltX
        + Math.cos(ang) * sw
        + Math.sin(fxTime * 3.1 + t.ph) * sw * 0.4;
      t.pivot.rotation.z = t.tiltZ
        + Math.sin(ang) * sw
        + Math.cos(fxTime * 3.7 + t.ph * 1.3) * sw * 0.4;
      // 根部小幅横移，火焰如在热气流中游走
      const drift = 0.02 * lifeK;
      t.pivot.position.x = t.ox + Math.sin(fxTime * 1.2 + t.ph * 2.1) * drift;
      t.pivot.position.z = t.oz + Math.cos(fxTime * 1.0 + t.ph * 1.6) * drift;
    }
    // 整簇火轻微上下浮沉
    f.group.position.y = f.y + Math.sin(fxTime * 2.0 + f.phase) * 0.02;
    // 火星随火势增多（dt 限幅，极端卡顿帧不会一下喷出成片火星）
    if (Math.random() < Math.min(dt, 0.05) * (4 + Math.max(0, gust) * 3)) {
      hooks.burst(f.gx, f.y + (Math.random() < 0.55 ? 1 : 0), f.gz,
                  Math.random() < 0.5 ? 0xff7a1c : 0xffc13b);
    }
    return gust;
  }

  function updateBossFx(dt, actors) {
    if (!world) return;
    const FIRE_COLORS = [0xff7a1c, 0xffc13b, 0xff4a12, 0xfff0a0];

    // 火球
    for (let i = bossFireballs.length - 1; i >= 0; i--) {
      const b = bossFireballs[i];
      b.ttl -= dt;
      b.vel.y -= 5.5 * dt;
      b.group.position.addScaledVector(b.vel, dt);
      b.group.rotation.y += dt * 6;
      if (Math.random() < 0.7) {
        hooks.burst(Math.floor(b.group.position.x), Math.floor(b.group.position.y),
                    Math.floor(b.group.position.z), FIRE_COLORS[Math.floor(Math.random() * 3)]);
      }
      const gp = b.group.position;
      let hit = b.ttl <= 0;
      if (!hit) {
        if (gp.y <= groundAt(gp.x, gp.z) + 0.15) hit = true;
        else if (isSolid(world.getBlock(Math.floor(gp.x), Math.floor(gp.y), Math.floor(gp.z)))) hit = true;
        else hit = fireballHit(b, actors, 1.05);
      }
      if (!hit) continue;

      // 爆炸：粒子 + 范围伤害（每个玩家独立判定）+ 点燃地面
      for (let k = 0; k < 8; k++) {
        hooks.burst(
          Math.floor(gp.x + (Math.random() - 0.5) * 1.6),
          Math.floor(gp.y + Math.random() * 1.2),
          Math.floor(gp.z + (Math.random() - 0.5) * 1.6),
          FIRE_COLORS[Math.floor(Math.random() * FIRE_COLORS.length)]);
      }
      const attacker = b.owner && !b.owner.dead ? b.owner : null;
      for (const a of actors) {
        if (Math.hypot(a.pos.x - gp.x, (a.pos.y + 0.9) - gp.y, a.pos.z - gp.z) < 2.8) {
          a.hurt(5, attacker);
        }
      }
      spawnFire(gp.x, gp.z, attacker);
      for (let k = 0; k < 3; k++) {
        spawnFire(gp.x + (Math.random() - 0.5) * 2.4, gp.z + (Math.random() - 0.5) * 2.4, attacker);
      }
      scene.remove(b.group);
      bossFireballs.splice(i, 1);
    }

    // 地面龙炎
    for (let i = bossFires.length - 1; i >= 0; i--) {
      const f = bossFires[i];
      f.ttl -= dt;
      if (f.ttl <= 0) { removeFire(i); continue; }
      animateFire(f, dt);
      if (!f.actorHurt) f.actorHurt = {};
      // 灼烧站在火上的玩家：每玩家独立 0.55s 受击间隔
      for (const a of actors) {
        f.actorHurt[a.id] = Math.max(0, (f.actorHurt[a.id] || 0) - dt);
        if (Math.hypot(a.pos.x - (f.gx + 0.5), a.pos.z - (f.gz + 0.5)) < 1.05 &&
            Math.abs(a.pos.y - f.y) < 1.8 && f.actorHurt[a.id] <= 0) {
          f.actorHurt[a.id] = 0.55;
          a.hurt(2, f.owner && !f.owner.dead ? f.owner : null);
        }
      }
    }
  }

  /* ---------------- 屏幕顶部 Boss 血条 ---------------- */

  let bossHud = null;
  function getBossHud() {
    if (bossHud === null) {
      const root = document.getElementById("boss-bar");
      bossHud = root
        ? { root: root, fill: root.querySelector(".bb-fill"), name: root.querySelector(".bb-name") }
        : false;
    }
    return bossHud;
  }
  function showBossHud(m) {
    const h = getBossHud();
    if (!h) return;
    h.root.classList.remove("hidden");
    h.fill.style.width = Math.max(0, m.hp / m.maxHp * 100).toFixed(1) + "%";
  }
  function hideBossHud() {
    const h = getBossHud();
    if (h) h.root.classList.add("hidden");
  }

  /* ============================================================
   * 联机网络实体（Task 8 最小实现）
   *   房主：netId 懒分配；netSnapshot() 出慢状态全量 ea（2Hz 可靠），
   *         netTransforms() 出位置快快照 es（10Hz 不可靠）
   *   客人：本地不跑任何 AI / 物理，ea/es 驱动无 AI 镜像：
   *         transform 与 yaw 插值，走路相位由实际位移差速驱动，
   *         血条 / 受击 / 幼崽缩放 / 驯服牌 / 狗坐姿 / 龙扇翅均复用现有表现
   * ============================================================ */

  let netSeq = 0;
  function ensureNetId(o) { if (!o.netId) o.netId = ++netSeq; return o.netId; }
  const r2 = v => Math.round(v * 100) / 100;
  const r3 = v => Math.round(v * 1000) / 1000;

  // ---- 房主侧：快照 ----
  Mobs.netSnapshot = function () {
    const e = [], d = [];
    for (const m of mobs) {
      if (m.dead) continue;
      ensureNetId(m);
      const f = (m.baby ? 1 : 0) | (m.owner ? 2 : 0) | (m.sitting ? 4 : 0) |
                (m.ridden ? 8 : 0) |
                (m.type === "panda" && m.mode === "anger" ? 16 : 0);
      const row = {
        i: m.netId, k: m.type,
        x: r3(m.pos.x), y: r3(m.pos.y), z: r3(m.pos.z), a: r3(m.yaw),
        h: r2(m.hp), f: f
      };
      if (m.maxHp !== m.cfg.hp) row.mh = m.maxHp;
      if (m.cfg.boss) {
        row.bs = m.bossState || "idle";
        row.ct = m.cast || "";
        row.mg = r2(m.mouthGlow || 0);
        row.ap = r3(m.aimPitch || 0);
      }
      e.push(row);
    }
    for (const dp of drops) {
      ensureNetId(dp);
      const gp = dp.group.position;
      d.push([dp.netId, dp.id, r2(gp.x), r2(gp.y), r2(gp.z)]);
    }
    // Boss 地面龙炎对齐表（2Hz 可靠）：客人镜像按格生成 / 刷新 / 熄灭
    const bf = [];
    for (const f of bossFires) bf.push([f.gx, f.gz, Math.max(0, Math.round(f.ttl * 10) / 10)]);
    return { e: e, d: d, bf: bf };
  };

  // es 行：生物 6 元 [i,x,y,z,a,h]，掉落物 5 元 [i,id,x,y,z]
  Mobs.netTransforms = function () {
    const out = [];
    for (const m of mobs) {
      if (m.dead) continue;
      ensureNetId(m);
      out.push([m.netId, r3(m.pos.x), r3(m.pos.y), r3(m.pos.z), r3(m.yaw), r2(m.hp)]);
    }
    for (const dp of drops) {
      ensureNetId(dp);
      const gp = dp.group.position;
      out.push([dp.netId, dp.id, r2(gp.x), r2(gp.y), r2(gp.z)]);
    }
    return out;
  };

  // ---- 客人侧：镜像注册表 ----
  const mirrors = new Map();    // netId -> 仿 mob 结构的镜像对象
  const dropMirrors = new Map();
  // Boss 特效镜像（纯表现，无伤害判定）：飞行火球 + 地面龙炎（key "gx,gz"）
  const mirrorBalls = [];
  const mirrorFires = new Map();

  function netSpawnMirror(e) {
    const t = TYPES[e.k];
    if (!t) return null;
    const model = BUILDERS[e.k](t);
    scene.add(model.root);
    const bar = createHealthBar();
    if (t.boss) bar.sprite.scale.set(3.6, 0.34, 1);
    scene.add(bar.sprite);
    const mm = {
      netId: e.i, type: e.k, cfg: t,
      parts: model.parts, root: model.root, bar: bar,
      pos: new THREE.Vector3(e.x, e.y, e.z),
      tx: new THREE.Vector3(e.x, e.y, e.z),
      vel: new THREE.Vector3(),
      yaw: e.a || 0, renderYaw: e.a || 0, targetYaw: e.a || 0,
      width: t.width, height: t.height, onGround: true, moving: false,
      phase: Math.random() * Math.PI * 2,
      hp: typeof e.h === "number" ? e.h : t.hp, maxHp: t.hp, dead: false,
      hurtT: 0, barT: 0, biteCd: 0,
      baby: false, owner: false, sitting: false, ridden: false,
      mode: "idle",
      // Boss 镜像表现所需
      bossState: "idle", cast: null, mouthGlow: 0, aimPitch: 0,
      flapT: Math.random() * Math.PI * 2
    };
    bar.sprite.visible = false;
    model.root.position.copy(mm.pos);
    model.root.rotation.y = mm.renderYaw;
    mirrors.set(e.i, mm);
    return mm;
  }

  function netRemoveMirror(id) {
    const mm = mirrors.get(id);
    if (!mm) return;
    // Boss 镜像消失 = 房主端已击杀：客人端补播黑灰鳞甲 + 火焰死亡爆裂（伤害/掉落由房主权威）
    if (mm.cfg && mm.cfg.boss) {
      hideBossHud();
      for (let i = 0; i < 5; i++) {
        hooks.burst(mm.pos.x + (Math.random() - 0.5) * 1.6,
                    mm.pos.y + 0.5 + Math.random() * mm.height,
                    mm.pos.z + (Math.random() - 0.5) * 1.6,
                    [0x312c32, 0xff7a24, 0x515056, 0xffc13b, 0x913847][i]);
      }
    }
    scene.remove(mm.root);
    scene.remove(mm.bar.sprite);
    mirrors.delete(id);
  }

  /* ---- 客人侧：Boss 火球 / 龙炎纯表现镜像 ---- */

  Mobs.netSpawnBalls = function (list) {
    if (!Array.isArray(list) || !scene) return;
    for (const b of list) {
      const x = +b.x, y = +b.y, z = +b.z, vx = +b.vx, vy = +b.vy, vz = +b.vz;
      if (![x, y, z, vx, vy, vz].every(isFinite)) continue;
      const g = buildFireballMesh();
      g.position.set(x, y, z);
      scene.add(g);
      mirrorBalls.push({ group: g, ttl: 3.2, vel: new THREE.Vector3(vx, vy, vz) });
    }
  };

  function netSpawnFire(gx, gz, ttl) {
    const key = gx + "," + gz;
    const exist = mirrorFires.get(key);
    if (exist) {
      if (typeof ttl === "number") exist.ttl = Math.max(exist.ttl, ttl);
      else exist.ttl = Math.max(exist.ttl, 3.6);
      return;
    }
    if (!world) return;
    const h = world.heightAt(gx, gz);
    const surface = world.getBlock(gx, h, gz);
    if (surface === BLOCK.WATER || isLava(surface)) return;
    if (world.getBlock(gx, h + 1, gz) !== BLOCK.AIR) return;
    const built = buildFireGroup();
    built.group.position.set(gx + 0.5, h + 1, gz + 0.5);
    scene.add(built.group);
    mirrorFires.set(key, {
      group: built.group, gx: gx, gz: gz, y: h + 1,
      ttl: typeof ttl === "number" ? Math.max(ttl, 1) : 4.2, age: 0,
      phase: Math.random() * 6.28, gust: Math.random() * 6.28,
      tongues: built.tongues
    });
  }

  function netRemoveFire(key) {
    const f = mirrorFires.get(key);
    if (!f) return;
    scene.remove(f.group);
    mirrorFires.delete(key);
  }

  // ea 的 bf 行：[[gx,gz,ttl]] 权威存活集合
  function netSyncFires(rows) {
    const live = new Set();
    for (const row of rows || []) {
      if (!Array.isArray(row) || row.length < 2) continue;
      const gx = row[0] | 0, gz = row[1] | 0;
      live.add(gx + "," + gz);
      netSpawnFire(gx, gz, typeof row[2] === "number" ? row[2] : 3.6);
    }
    for (const key of Array.from(mirrorFires.keys())) {
      if (!live.has(key)) netRemoveFire(key);
    }
  }

  function netUpdateMirrorBalls(dt, fireColors) {
    for (let i = mirrorBalls.length - 1; i >= 0; i--) {
      const b = mirrorBalls[i];
      b.ttl -= dt;
      b.vel.y -= 5.5 * dt;
      b.group.position.addScaledVector(b.vel, dt);
      b.group.rotation.y += dt * 6;
      if (Math.random() < 0.7) {
        hooks.burst(Math.floor(b.group.position.x), Math.floor(b.group.position.y),
                    Math.floor(b.group.position.z), fireColors[Math.floor(Math.random() * 3)]);
      }
      const gp = b.group.position;
      let hit = b.ttl <= 0;
      if (!hit) {
        if (gp.y <= groundAt(gp.x, gp.z) + 0.15) hit = true;
        else if (isSolid(world.getBlock(Math.floor(gp.x), Math.floor(gp.y), Math.floor(gp.z)))) hit = true;
      }
      if (!hit) continue;
      for (let k = 0; k < 8; k++) {
        hooks.burst(
          Math.floor(gp.x + (Math.random() - 0.5) * 1.6),
          Math.floor(gp.y + Math.random() * 1.2),
          Math.floor(gp.z + (Math.random() - 0.5) * 1.6),
          fireColors[Math.floor(Math.random() * fireColors.length)]);
      }
      netSpawnFire(Math.floor(gp.x), Math.floor(gp.z));
      for (let k = 0; k < 3; k++) {
        netSpawnFire(Math.floor(gp.x + (Math.random() - 0.5) * 2.4),
                     Math.floor(gp.z + (Math.random() - 0.5) * 2.4));
      }
      scene.remove(b.group);
      mirrorBalls.splice(i, 1);
    }
  }

  function netUpdateMirrorFires(dt) {
    for (const key of Array.from(mirrorFires.keys())) {
      const f = mirrorFires.get(key);
      f.ttl -= dt;
      if (f.ttl <= 0) { netRemoveFire(key); continue; }
      animateFire(f, dt);
    }
  }

  function netClearBossFx() {
    if (scene) {
      for (const b of mirrorBalls) scene.remove(b.group);
      for (const f of mirrorFires.values()) scene.remove(f.group);
    }
    mirrorBalls.length = 0;
    mirrorFires.clear();
  }

  function netApplyMirrorSlow(mm, e) {
    const f = e.f || 0;
    const baby = !!(f & 1), owner = !!(f & 2), sitting = !!(f & 4);
    if (baby !== mm.baby) {
      mm.baby = baby;
      applyBabyLook(mm, baby);
    }
    if (owner !== mm.owner) {
      mm.owner = owner;
      if (mm.parts.tag) mm.parts.tag.visible = owner;
    }
    mm.sitting = sitting;
    mm.ridden = !!(f & 8);
    // 熊猫愤怒表情（客人端只做表现，无 AI）
    if (mm.type === "panda") {
      mm.mode = !!(f & 16) ? "anger" : "idle";
      applyPandaMood(mm);
    }
    if (typeof e.mh === "number" && e.mh !== mm.maxHp) {
      mm.maxHp = e.mh;
      if (mm.barT > 0) showBar(mm);
    }
    if (typeof e.h === "number") {
      if (e.h < mm.hp - 0.01) { mm.hurtT = 0.32; showBar(mm); }
      mm.hp = e.h;
    }
    if (typeof e.a === "number") mm.targetYaw = e.a;
    mm.tx.set(e.x, e.y, e.z);
    if (mm.cfg.boss) {
      mm.bossState = e.bs || "idle";
      mm.cast = e.ct || null;
      mm.mouthGlow = typeof e.mg === "number" ? e.mg : 0;
      if (typeof e.ap === "number") mm.aimPitch = e.ap;
    }
    if (!mm.placed) {
      mm.placed = true;
      mm.pos.copy(mm.tx);
      mm.renderYaw = mm.targetYaw;
      mm.root.rotation.y = mm.renderYaw;
    }
  }

  function netSpawnDropMirror(row) {
    const id = row[1];
    const g = new THREE.Group();
    g.add(buildDropMesh(id, true));
    g.position.set(row[2], row[3], row[4]);
    scene.add(g);
    const rec = {
      group: g, target: new THREE.Vector3(row[2], row[3], row[4]),
      age: Math.random() * 6.28, spin: Math.random() * Math.PI * 2
    };
    dropMirrors.set(row[0], rec);
    return rec;
  }

  // ea：实体集合权威（生成 / 消失）+ 慢状态（血量 / 幼崽 / 驯服 / 坐姿 / Boss 状态）
  Mobs.netApplySnapshot = function (snap) {
    if (!snap) return;
    const live = new Set();
    for (const e of snap.e || []) {
      if (!TYPES[e.k]) continue;
      live.add(e.i);
      let mm = mirrors.get(e.i);
      if (!mm) mm = netSpawnMirror(e);
      if (mm) netApplyMirrorSlow(mm, e);
    }
    for (const id of Array.from(mirrors.keys())) {
      if (!live.has(id)) netRemoveMirror(id);
    }
    const dlive = new Set();
    for (const row of snap.d || []) {
      dlive.add(row[0]);
      let dm = dropMirrors.get(row[0]);
      if (!dm) dm = netSpawnDropMirror(row);
      dm.target.set(row[2], row[3], row[4]);
    }
    for (const id of Array.from(dropMirrors.keys())) {
      if (!dlive.has(id)) {
        scene.remove(dropMirrors.get(id).group);
        dropMirrors.delete(id);
      }
    }
    // Boss 地面龙炎存活集合对齐
    netSyncFires(snap.bf);
  };

  // es：10Hz 位置 / 朝向 / 血量快快照
  Mobs.netApplyTransforms = function (list) {
    if (!Array.isArray(list)) return;
    for (const row of list) {
      if (!Array.isArray(row) || row.length < 5) continue;
      if (row.length >= 6) {
        const mm = mirrors.get(row[0]);
        if (!mm) continue;
        mm.tx.set(row[1], row[2], row[3]);
        mm.targetYaw = row[4];
        if (typeof row[5] === "number" && row[5] < mm.hp - 0.01) {
          mm.hurtT = 0.32;
          showBar(mm);
        }
        if (typeof row[5] === "number") mm.hp = row[5];
      } else {
        const dm = dropMirrors.get(row[0]);
        if (dm) dm.target.set(row[2], row[3], row[4]);
      }
    }
  };

  // 客人端每帧：只做插值与表现，绝无 AI / 物理 / 世界写入
  Mobs.netUpdate = function (dt) {
    fxTime += dt;
    let bossMirror = null;
    for (const mm of mirrors.values()) {
      const bx = mm.pos.x, bz = mm.pos.z;
      const k = 1 - Math.exp(-14 * dt);
      mm.pos.lerp(mm.tx, k);
      let dyaw = mm.targetYaw - mm.renderYaw;
      while (dyaw > Math.PI) dyaw -= Math.PI * 2;
      while (dyaw < -Math.PI) dyaw += Math.PI * 2;
      mm.renderYaw += dyaw * Math.min(1, dt * 10);
      mm.root.position.copy(mm.pos);
      mm.root.rotation.y = mm.renderYaw;
      // 用真实渲染位移反推步态，停顿即收腿
      const spd = Math.hypot(mm.pos.x - bx, mm.pos.z - bz) / Math.max(dt, 1e-4);
      mm.moving = spd > 0.35;
      mm.hurtT = Math.max(0, mm.hurtT - dt);
      if (mm.cfg.boss) {
        mm.flapT += dt * (mm.bossState === "engage" ? 7.2 : 4.0);
        updateDragonAnim(mm, dt);
        bossMirror = mm;
      } else {
        updateAnimation(mm, dt);
      }
      updateBar(mm, dt);
    }
    // Boss 顶部血条随房主权威状态显隐
    if (bossMirror) {
      if (bossMirror.bossState === "engage") showBossHud(bossMirror);
      else hideBossHud();
    }
    for (const dm of dropMirrors.values()) {
      dm.group.position.lerp(dm.target, 1 - Math.exp(-12 * dt));
      dm.age += dt;
      dm.spin += dt * 2.2;
      dm.group.rotation.y = dm.spin;
      dm.group.children[0].position.y = Math.sin(dm.age * 3.2) * 0.05 + 0.06;
    }
    // Boss 火球 / 地面龙炎纯表现镜像（命中与伤害只在房主端裁决）
    netUpdateMirrorBalls(dt, [0xff7a1c, 0xffc13b, 0xff4a12, 0xfff0a0]);
    netUpdateMirrorFires(dt);
  };

  // 客人 welcome 到达前曾以“假单机”启动（菜单内输入房间码加入的路径），
  // 清理本地误生成的友好动物 / Boss / 掉落物 / 龙炎，世界由房主镜像接管
  Mobs.netClearLocal = function () {
    for (const m of mobs) {
      scene.remove(m.root);
      scene.remove(m.bar.sprite);
    }
    mobs = [];
    for (const dp of drops) scene.remove(dp.group);
    drops = [];
    if (mountMob) { mountMob.ridden = false; mountMob = null; }
    dragonSlain = false;
    clearBossFx();
    hideBossHud();
  };

  // 客人断线 / 重新 welcome 时清空镜像
  Mobs.netClear = function () {
    for (const mm of mirrors.values()) {
      scene.remove(mm.root);
      scene.remove(mm.bar.sprite);
    }
    mirrors.clear();
    for (const dm of dropMirrors.values()) scene.remove(dm.group);
    dropMirrors.clear();
    netClearBossFx();
    hideBossHud();
  };

  // 调试用：真实实体数组（含 netId / cfg 的活引用；仅限 __mc 自动化探针使用）
  Mobs.debugEntities = function () { return mobs; };

  Mobs.netDebug = function () {
    return {
      mirrors: mirrors.size, drops: dropMirrors.size,
      balls: mirrorBalls.length, fires: mirrorFires.size,
      bossBar: (function () { const el = document.getElementById("boss-bar"); return el ? !el.classList.contains("hidden") : false; })(),
      list: Array.from(mirrors.values()).map(m => ({
        id: m.netId, type: m.type,
        x: r2(m.pos.x), y: r2(m.pos.y), z: r2(m.pos.z),
        tx: r2(m.tx.x), moving: m.moving, hp: r2(m.hp),
        bs: m.cfg.boss ? m.bossState : undefined,
        baby: m.baby, owner: m.owner, sitting: m.sitting
      }))
    };
  };

  global.Mobs = Mobs;
})(window);
