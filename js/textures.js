/* ============================================================
 * textures.js — 用 Canvas 程序化生成 16x16 像素纹理图集
 * 无需任何外部图片资源
 * 图集布局: 4 列 x 6 行，每格 16px
 * ============================================================ */
(function (global) {
  "use strict";

  const TILE_PX = 16;
  const COLS = 4;
  // 图集行数随 mod 注册的 tile 数量动态扩展（mod 脚本须先于本文件加载）
  const ROWS = Math.max(8, Math.ceil(GameRegistry.nextTile / COLS));

  function createAtlasCanvas() {
    const canvas = document.createElement("canvas");
    canvas.width = COLS * TILE_PX;
    canvas.height = ROWS * TILE_PX;
    const ctx = canvas.getContext("2d");

    // 固定种子的随机数，保证每次纹理一致
    let seed = 987654321;
    function rnd() {
      seed = (Math.imul(seed ^ (seed >>> 15), seed | 1) + Math.imul(seed ^ (seed >>> 7), seed | 61)) ^ seed;
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      return (seed >>> 0) / 4294967296;
    }
    function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }

    // 柔和橄榄草色：按玩家提供的 Minecraft 实机画面取色校准
    // （原版草顶/草沿/小草贴图本身是灰度图，由群系色调染色；
    //   这里把固定的橄榄色调乘到原版 1:1 灰度像素图案上）
    const GRASS_TINT = [140, 175, 86];
    function toHex2(v) { return Math.round(v).toString(16).padStart(2, "0"); }
    function gt(gray) {
      return "#" + toHex2(gray * GRASS_TINT[0] / 255) +
                    toHex2(gray * GRASS_TINT[1] / 255) +
                    toHex2(gray * GRASS_TINT[2] / 255);
    }
    // 逐格绘制 16x16 像素图：rows 为空格分隔的 token，cell(token) 返回
    // 颜色字符串；返回 null/透明 token("." 或 "..") 则跳过该像素
    function paintGrid(i, rows, cell) {
      const n = Math.min(TILE_PX, rows.length);
      for (let y = 0; y < n; y++) {
        const toks = rows[y].split(" ");
        for (let x = 0; x < TILE_PX; x++) {
          const t = toks[x];
          if (!t || t === "." || t === "..") continue;
          const col = cell(t);
          if (col) dot(i, x, y, col);
        }
      }
    }
    // 原版 1.20 泥土像素图（颜色 token）
    const DIRT_ROWS = [
      "b9 96 96 79 79 b9 96 96 79 79 59 79 79 b9 79 b9",
      "79 96 59 79 79 96 87 59 79 b9 96 79 b9 96 59 59",
      "b9 79 79 59 b9 79 79 79 b9 79 79 79 59 59 b9 79",
      "96 6c b9 79 96 59 79 b9 96 96 79 96 79 b9 96 79",
      "96 79 96 b9 59 96 79 79 96 59 79 6c 79 96 59 79",
      "79 59 96 96 79 96 59 59 59 79 79 59 79 79 79 b9",
      "b9 79 79 79 87 79 79 b9 b9 79 b9 b9 79 96 79 96",
      "79 79 b9 b9 96 96 79 79 96 59 96 96 79 79 96 96",
      "96 79 79 96 79 96 79 59 79 96 96 79 79 79 59 79",
      "79 96 59 79 79 59 59 79 79 79 79 79 b9 b9 79 96",
      "79 96 79 b9 b9 79 b9 96 59 b9 b9 59 96 96 87 79",
      "96 79 79 96 96 b9 79 96 6c 96 96 79 59 96 79 59",
      "79 59 96 79 96 96 b9 79 79 79 79 79 79 79 b9 b9",
      "79 96 79 79 74 79 96 96 79 59 b9 59 79 b9 96 96",
      "96 79 59 b9 79 59 79 59 b9 b9 79 96 79 79 96 96",
      "96 79 b9 96 96 79 87 79 96 96 79 79 96 96 79 59"
    ];
    const DIRT_COLORS = {
      b9: "#b9855c", 96: "#966c4a", 79: "#79553a", 59: "#593d29",
      "87": "#878787", "6c": "#6c6c6c", "74": "#745844"
    };
    // 原版 1.20 草顶灰度像素图（运行时乘 GRASS_TINT）
    const GRASS_TOP_ROWS = [
      "94 c3 93 86 86 8f 7f 8c 9e 96 8a 87 89 a7 70 8d",
      "95 8c a0 97 99 80 99 82 7f a9 a6 93 c3 8c 87 8b",
      "a3 8d 7d 84 89 88 90 90 94 9f a8 ad 87 77 80 b6",
      "76 85 8a 97 91 99 7d 92 7f 83 8d 97 8f 8b a7 7d",
      "a2 83 ad 83 ac ae 88 ac ba 75 80 a7 ab 7e 88 8d",
      "99 98 78 a6 81 96 95 9b 87 95 88 83 78 88 8e 94",
      "7e 9c a5 90 92 83 8a 7f 84 87 b5 ac 91 a7 97 8f",
      "8f 87 9d 8b 90 7c a4 84 97 ad 87 81 8f a0 7f a9",
      "a7 9b b6 aa ac 81 ad 9c b3 aa 82 92 85 93 9e 7e",
      "97 82 b7 8d 8c 98 aa 80 87 91 92 a9 8e b3 8f 81",
      "9b 9e 97 a5 82 b6 8e 93 c0 79 a7 83 8f 88 97 8f",
      "84 ad 86 a3 97 84 92 89 97 92 8c 7b b3 7f 7d 8a",
      "ba 97 81 8a 99 91 85 7a 8a 91 8a 7d 9f a5 79 97",
      "81 a8 76 92 7d 99 81 c3 a1 93 a8 9b a0 88 a8 ae",
      "a3 a1 c0 7b b3 ab 94 93 7e 95 95 87 a9 9d 8b 79",
      "85 96 88 89 a4 98 94 93 8e bf 7c a9 84 90 88 9e"
    ];
    // 原版 1.20 草侧沿灰度覆盖图（前 3 行，其余透明）
    const GRASS_OVERLAY_ROWS = [
      "a9 90 96 8c a9 90 a9 96 96 9f a9 9f b2 81 9f 96",
      "a9 8c a9 90 b2 . a9 82 b2 96 a9 93 a9 8c a9 8b",
      "96 . b2 84 a9 . 90 . a9 9f 96 ad . 77 96 .",
      ". . . . 91 . . . 7f . 8d . . . . ."
    ];
    // 原版 1.20 小草(short grass)灰度面片图，交叉面片用，同乘草色
    const GRASS_BLADES_ROWS = [
      ". . . . . . . . . . . . . . . .",
      ". . . . . . . . . . . . . . . .",
      ". . . . a0 . . a0 . . b8 . . a0 . .",
      ". . . . . a0 . b8 . . b8 . a0 . . .",
      ". . . a0 . b8 . b8 . 82 a0 . b8 . . .",
      ". a0 . . a0 b8 . a0 . a0 . b8 . . b8 .",
      ". . b8 . 76 a0 . a0 82 b8 . a0 . b8 . .",
      ". . b8 . . a0 91 . 91 b8 . 82 . b8 . .",
      ". . b8 76 . 91 a0 76 82 91 b8 76 . a0 . .",
      "a0 . a0 91 . b8 . 76 a0 . a0 76 b8 . 76 .",
      "a0 . 91 a0 . a0 76 . a0 82 91 . a0 . 76 a0",
      "a0 82 . a0 a0 91 76 . 91 82 a0 . 91 a0 . 91",
      "91 . 82 91 76 91 76 91 76 82 a0 91 82 91 91 82",
      "91 91 82 82 76 91 82 91 82 76 a0 76 82 82 91 .",
      ". 82 76 a0 6c 82 76 a0 82 6c 91 76 a0 82 82 82",
      "91 82 6c a0 6c 82 6c a0 82 6c 82 6c a0 6c 82 76"
    ];

    function origin(i) {
      return [(i % COLS) * TILE_PX, Math.floor(i / COLS) * TILE_PX];
    }
    function base(i, color) {
      const [ox, oy] = origin(i);
      ctx.fillStyle = color;
      ctx.fillRect(ox, oy, TILE_PX, TILE_PX);
    }
    function dot(i, x, y, color) {
      const [ox, oy] = origin(i);
      ctx.fillStyle = color;
      ctx.fillRect(ox + x, oy + y, 1, 1);
    }
    // 用调色板为每个像素加噪点
    function noisy(i, palette, density) {
      density = density == null ? 0.5 : density;
      for (let y = 0; y < TILE_PX; y++) {
        for (let x = 0; x < TILE_PX; x++) {
          if (rnd() < density) dot(i, x, y, pick(palette));
        }
      }
    }

    /* ---------- 0 草顶（原版 1.20 灰度像素图 × 柔和橄榄色调） ---------- */
    paintGrid(TILE.GRASS_TOP, GRASS_TOP_ROWS, (g) => gt(parseInt(g, 16)));

    /* ---------- 1 草侧(原版泥土像素图 + 顶部草沿覆盖) ---------- */
    paintGrid(TILE.GRASS_SIDE, DIRT_ROWS, (t) => DIRT_COLORS[t]);
    paintGrid(TILE.GRASS_SIDE, GRASS_OVERLAY_ROWS, (t) => t === "." ? null : gt(parseInt(t, 16)));

    /* ---------- 2 泥土（原版 1.20 像素图，暖棕带少量石子） ---------- */
    paintGrid(TILE.DIRT, DIRT_ROWS, (t) => DIRT_COLORS[t]);

    /* ---------- 3 石头（原版 1.21 stone.png 16×16 像素 1:1，用户等距参考图反投影零失配确认） ---------- */
    const STONE_ROWS = [
      "8f 8f 8f 8f 7f 74 74 7f 74 68 74 74 7f 7f 7f 7f",
      "7f 7f 74 7f 74 7f 7f 7f 7f 7f 7f 68 68 74 7f 74",
      "7f 74 68 68 74 74 74 68 74 74 74 7f 7f 7f 7f 7f",
      "7f 7f 8f 8f 7f 8f 7f 7f 8f 8f 7f 7f 7f 74 74 74",
      "74 7f 7f 74 74 74 7f 74 7f 8f 8f 8f 8f 74 7f 7f",
      "7f 8f 7f 7f 7f 7f 7f 7f 7f 74 74 68 74 68 74 8f",
      "74 7f 7f 8f 8f 8f 74 8f 8f 74 74 74 7f 7f 7f 7f",
      "74 74 68 68 74 68 74 74 7f 7f 74 74 74 7f 7f 7f",
      "8f 8f 8f 7f 8f 7f 7f 8f 8f 8f 7f 7f 7f 7f 7f 74",
      "7f 7f 8f 7f 7f 7f 8f 8f 8f 7f 7f 8f 8f 8f 8f 7f",
      "68 7f 74 7f 74 74 68 68 74 7f 74 7f 7f 74 74 74",
      "7f 7f 7f 7f 7f 8f 8f 7f 7f 7f 7f 7f 8f 8f 7f 8f",
      "7f 74 74 74 7f 8f 7f 74 74 7f 7f 68 68 74 68 74",
      "8f 8f 7f 74 74 7f 7f 74 74 74 7f 7f 74 74 74 8f",
      "7f 74 74 7f 7f 7f 7f 7f 7f 7f 7f 7f 8f 8f 8f 8f",
      "7f 7f 7f 7f 7f 7f 74 74 7f 8f 8f 7f 7f 74 7f 7f"
    ];
    const STONE_COLORS = {
      "68": "#686868", "74": "#747474", "7f": "#7f7f7f", "8f": "#8f8f8f"
    };
    paintGrid(TILE.STONE, STONE_ROWS, (t) => STONE_COLORS[t]);

    /* ---------- 4 原木侧(纵向树皮，参考图等距渲染反投影提取) ---------- */
    const LOG_SIDE_ROWS = [
      "h e i g g b i g g b g i f i g f",
      "g e j f g b j f h b g i f g g f",
      "h a f f g b j f h d g f d g g f",
      "j a g f g d g f g f g b d g i f",
      "i f g f g b g f j f g f h c i g",
      "i h e g i c g e j f i e g c i g",
      "f g d g i f f g i g i g g d i g",
      "f g a g i h f i g g j f g f i g",
      "h f a j g g f i g f i f j f i g",
      "g h c j g g f g g f i d i g b g",
      "g g g i g f g b g f g d i g b g",
      "g e g i g f g a j g g b j g f g",
      "j f g g i f i b j f g a g g f g",
      "j h e h i g g f i f g c h g g g",
      "i g d i g g i b g d g c e i g g",
      "i g d i e g i f g d g h c i g f"
    ];
    const LOG_SIDE_COLORS = {
      a: "#242412", b: "#362412", c: "#363612", d: "#363624",
      e: "#483612", f: "#483624", g: "#5a4824", h: "#5a4836",
      i: "#6c5a36", j: "#7e5a36"
    };
    paintGrid(TILE.LOG_SIDE, LOG_SIDE_ROWS, (t) => LOG_SIDE_COLORS[t]);

    /* ---------- 5 原木横切(同心方框年轮，参考图反投影提取) ---------- */
    const LOG_TOP_ROWS = [
      "e b d d d b d d g b d d a g f d",
      "d m m m m m m m m p m m m m m d",
      "e m k j k i j i i j j i i j m d",
      "b m k m m m m m m m m o m j m c",
      "d l k m m m m m m m m m m i l d",
      "d l i m m i j h j k k m m k m d",
      "b l k m m i m l m m k m m i m b",
      "d l k m m i m k i m i m m i m d",
      "d m k m m j m k k m k m m k l d",
      "d m i m m h m m m m i m m i m d",
      "b m k m m i i k k i i m m i l b",
      "d m i m m m m m l m m m m k m d",
      "d m h q q m m m m m m m m i m d",
      "d n h h i j k j k k k k i i n d",
      "b m m m n m m m o m l m n m n b",
      "d b d g d b e d g b d e b d d e"
    ];
    const LOG_TOP_COLORS = {
      a: "#483612", b: "#483624", c: "#5a3624", d: "#5a4824",
      e: "#5a4836", f: "#6c4824", g: "#6c5a36", h: "#7e5a36",
      i: "#906c36", j: "#906c48", k: "#a27e48", l: "#a2905a",
      m: "#b4905a", n: "#b4906c", o: "#b4a26c", p: "#c6a25a",
      q: "#c6a26c"
    };
    paintGrid(TILE.LOG_TOP, LOG_TOP_ROWS, (t) => LOG_TOP_COLORS[t]);

    /* ---------- 6 树叶（参考图等距渲染反投影提取的 16×16 像素图） ----------
     * 经典橡树叶片斑驳图；"." 为透明像素（真孔洞，配合 cutout 材质 alphaTest 镂空），
     * 不是深色假孔——透过孔洞可见天空与邻接方块 */
    const LEAVES_ROWS = [
      "d c a a . j e m b . b h f j . .",
      "c h d . . e j . . . b d c d h .",
      "c j h . n c a c a . . b c c h n",
      "d h . . j c c d d h . h f j c l",
      "d . g j e l f . d c h j j j c e",
      "d . d l i l . b c c h h . j c c",
      "b b . j j j . b a c c h j . j c",
      "c g b c l e f . d h c f j . j f",
      "k . a a j c j h . j f f h . j j",
      ". . . a a a c j . k j j . . . j",
      ". . a . f j c l j j k . . . . .",
      "j j . b . j j e j j d h h . . .",
      "c a b . . . j j j n d c d n . j",
      "c c b k h . . j . b a c c j . j",
      "f j . e f . . k g b h i j c f j",
      "i . j c a b . . a . j j j f j ."
    ];
    const LEAVES_COLORS = {
      a: "#183000", b: "#183018", c: "#184800", d: "#184818",
      e: "#186000", f: "#186018", g: "#303018", h: "#304818",
      i: "#306000", j: "#306018", k: "#306030", l: "#307818",
      m: "#307830", n: "#486030"
    };
    paintGrid(TILE.LEAVES, LEAVES_ROWS, (t) => LEAVES_COLORS[t]);

    /* ---------- 7 沙子 ---------- */
    base(TILE.SAND, "#e3d7a0");
    noisy(TILE.SAND, ["#d9cc92", "#ede3b2", "#d3c588"], 0.45);

    /* ---------- 8 水（斜向流光点阵：暗流条斜向下淌、亮斑随滚动上移） ----------
     * 图案按 16 行无缝循环设计，独立水贴图逐格 RepeatWrapping 下滚即流动；
     * 七档蓝：k 深流谷 / D,d 暗流条 / m 主水色 / b 亮流条 / l 浪光 / h 浪花 / w 高光点 */
    base(TILE.WATER, "#3567d8");
    const WATER_ROWS = [
      "m m d d m m b b m l b m m d D m",
      "m m m d d m m b b l b m m m d D",
      "D m m m d d m m b l l b b m m d",
      "d D m m m d d m m b l h b b m m",
      "m d D m m m d d m m b l l b b m",
      "m m d D m m m d d m m b l w b m",
      "b m m d D m m m d d m m b l l b",
      "b b m m d D m m m d d m m b l l",
      "l b b m m d D m m m d D m m b b",
      "l l b b m m d D m m m d d m m b",
      "h l l b b m m d D m m m d d m m",
      "b h l l b b m m d D m m m d d D",
      "m b h l l b b b m m d D m m d d",
      "m m b l w l b b b m m d D m m d",
      "D m m b l l l b b b m m d D m m",
      "k D m m b l l b b b m m m d D m"
    ];
    const WATER_COLORS = {
      k: "#1d3a90", D: "#2447a8", d: "#2a52bb", m: "#3567d8",
      b: "#3f73e6", l: "#5f8eee", h: "#8aa9f6", w: "#c3d4ff"
    };
    paintGrid(TILE.WATER, WATER_ROWS, (t) => WATER_COLORS[t] || "#3567d8");

    /* ---------- 9 木板（原版 1.21 oak_planks.png 16x16 逐格复刻，四条横板） ---------- */
    const PLANKS_ROWS = [
      "a b a c c c c c a c c c c c a d",
      "a a b b d e b a a a b b a a e e",
      "b a a a b a b e e e e b b a a d",
      "d f f d d f g g f f g f g g f g",
      "a c e c c c c e c c c a b b e a",
      "b a a b e b e d e b b a a a a b",
      "e e b a b b b d a a a b b e e e",
      "g g f f d f g g g g f f f d f g",
      "a c c a b b c c c c c c c c a e",
      "a b a a a a b e e e b e b e e d",
      "c a b b e e e e b b b b e e a e",
      "g g f d d f g g g f d f f g g g",
      "c e a c c a a e c c c e c a c c",
      "b b a a e e b e e a a b a b b b",
      "b e e b a b e d a a b e e e e e",
      "g f f g g f d d d f g f g g g g"
    ];
    const PLANKS_COLORS = {
      a: "#b8945f", b: "#af8f55", c: "#c29d62", d: "#967441",
      e: "#9f844d", f: "#7e6237", g: "#67502c"
    };
    paintGrid(TILE.PLANKS, PLANKS_ROWS, (t) => PLANKS_COLORS[t]);

    /* ---------- 10 圆石（原版 1.21 cobblestone.png 16×16 像素 1:1，用户等距参考图反投影零失配确认） ---------- */
    const COBBLE_ROWS = [
      "6e 61 a6 a6 52 61 61 a6 b5 a6 88 61 88 b5 a6 88",
      "61 a6 b5 88 88 52 b5 b5 a6 88 88 52 61 88 6e 88",
      "61 a6 88 a6 6e 61 a6 88 88 a6 6e 61 52 61 88 6e",
      "61 61 88 6e 61 61 88 6e 88 6e 61 88 a6 88 61 52",
      "52 6e 61 88 b5 a6 61 88 61 61 b5 a6 a6 a6 88 61",
      "b5 6e a6 b5 88 88 6e 61 52 88 88 b5 a6 88 6e 88",
      "a6 88 61 88 a6 88 88 6e 61 61 6e a6 88 6e 61 b5",
      "88 88 6e 6e 88 88 6e 61 88 b5 a6 61 6e 88 61 88",
      "6e 61 b5 a6 6e 6e 61 88 b5 88 88 88 61 61 52 6e",
      "61 b5 a6 88 6e 88 6e 6e 88 88 61 6e 61 88 a6 61",
      "88 6e 88 6e 88 61 61 52 61 6e 6e 61 52 a6 a6 b5",
      "88 6e 6e 61 61 6e 88 b5 a6 61 61 52 88 b5 b5 88",
      "6e 88 b5 a6 6e 61 b5 a6 88 a6 6e 61 88 88 6e 88",
      "61 b5 a6 88 88 61 a6 88 6e 88 88 6e 61 61 88 6e",
      "a6 a6 88 6e 88 6e 61 6e 88 88 6e 61 a6 88 61 61",
      "61 88 61 61 6e 88 6e 61 6e 61 61 88 b5 a6 88 6e"
    ];
    const COBBLE_COLORS = {
      "52": "#525252", "61": "#616161", "6e": "#6e6d6d", "88": "#888788",
      "a6": "#a6a6a6", "b5": "#b5b5b5"
    };
    paintGrid(TILE.COBBLE, COBBLE_ROWS, (t) => COBBLE_COLORS[t]);

    /* ---------- 11 基岩 ---------- */
    base(TILE.BEDROCK, "#4a4a4a");
    noisy(TILE.BEDROCK, ["#333333", "#5c5c5c", "#222222", "#666666"], 0.8);

    /* ---------- 12 工作台顶面（参考图等距渲染 1:1 反投影提取的 16×16 像素图） ----------
     * 橙棕面板 + 深色 3x3 工具网格，四角米色装饰点，外沿红棕暗框 */
    const TABLE_TOP_COLORS = {
      "00": "#aa643a",  // 面板橙棕
      "01": "#533420",  // 网格深棕
      "02": "#442411",  // 网格暗影棕
      "03": "#733417",  // 外沿红棕
      "04": "#130e07",  // 近黑角框
      "05": "#995731",  // 中橙棕噪点
      "06": "#b39160",  // 米色装饰
      "07": "#431b03",  // 深红褐勾边
      "08": "#a76b49",  // 浅橙高光
      "09": "#6c3b27",  // 暗影红棕
      "0a": "#030303",  // 纯黑
      "0b": "#bb9357"   // 亮米黄装饰
    };
    paintGrid(TILE.TABLE_TOP, [
      "04 0a 04 04 02 03 03 03 03 03 03 02 04 04 04 04",
      "04 0b 06 07 05 00 00 00 00 00 00 05 07 06 06 04",
      "04 06 07 00 00 00 00 00 00 00 00 00 00 07 06 04",
      "04 02 00 01 01 01 01 01 02 02 02 01 01 00 02 04",
      "02 05 00 01 05 00 01 00 00 02 00 00 01 00 05 02",
      "03 00 00 01 00 00 02 05 08 01 05 00 01 00 00 09",
      "03 00 00 01 01 02 01 01 01 01 01 02 01 00 00 03",
      "03 00 00 01 00 00 01 00 00 01 08 00 01 00 00 03",
      "09 00 00 01 00 00 01 00 00 01 00 08 01 00 00 09",
      "03 00 00 01 02 02 01 02 02 01 01 01 01 00 00 03",
      "03 00 00 02 05 00 02 00 05 02 00 00 01 00 00 09",
      "07 05 00 01 05 00 02 00 00 02 05 00 01 00 05 02",
      "04 02 00 01 01 01 01 01 01 01 01 01 01 00 07 04",
      "04 06 02 08 00 00 00 00 00 00 00 00 00 02 06 04",
      "04 0b 06 02 05 00 00 00 00 00 00 05 02 06 06 04",
      "04 04 04 04 02 03 03 09 03 03 09 02 04 04 04 04"
    ], (t) => TABLE_TOP_COLORS[t]);

    /* ---------- 13 工作台侧面（参考图等距渲染 1:1 反投影提取的 16×16 像素图） ----------
     * 木板墙面 + 深色立柱，左挂铁锤、右挂白钢锯 */
    const TABLE_SIDE_COLORS = {
      "00": "#8d7245",  // 木板主色
      "01": "#131309",  // 边缘近黑柱
      "02": "#9a7c4c",  // 亮木板
      "03": "#2b1b10",  // 深棕立柱
      "04": "#634b29",  // 横向暗板缝
      "05": "#ababab",  // 金属灰
      "06": "#3b2313",  // 深棕
      "07": "#524121",  // 暗橄榄棕
      "08": "#7b6a3b",  // 暗橄榄木板
      "09": "#785b33",  // 中棕
      "0a": "#cbcbcb",  // 锯片亮白
      "0b": "#919191",  // 锤头中灰
      "0c": "#331b03",  // 深褐柄
      "0d": "#211505",  // 近黑棕
      "0e": "#572b1b"   // 顶部红棕阴影梁
    };
    paintGrid(TILE.TABLE_SIDE, [
      "01 00 00 02 02 03 0e 06 06 0e 03 02 02 02 00 01",
      "01 00 00 00 09 08 03 06 06 03 00 00 00 00 08 01",
      "01 00 00 00 00 00 00 03 03 08 08 00 00 00 00 01",
      "01 04 04 09 09 04 07 01 01 04 07 03 03 0c 04 01",
      "01 02 00 02 02 02 02 06 06 02 02 0d 00 0d 00 01",
      "01 00 00 0c 00 00 08 03 03 00 00 01 03 03 00 01",
      "01 08 00 0d 00 00 00 03 03 00 00 0b 0b 0b 08 01",
      "01 07 04 0d 09 04 07 01 01 07 04 0a 05 05 04 01",
      "01 02 02 0d 00 00 02 06 06 02 02 0a 05 05 00 01",
      "01 00 05 05 05 00 00 03 03 00 00 08 05 05 00 01",
      "01 00 0b 05 0a 08 00 03 03 00 00 00 0a 05 00 01",
      "01 07 04 09 09 04 07 01 01 04 09 04 04 05 07 01",
      "01 08 00 02 02 00 00 06 06 02 02 00 02 0a 02 01",
      "01 00 00 00 08 08 00 03 03 00 00 00 00 00 00 01",
      "01 00 00 00 00 00 00 03 03 00 00 08 00 00 00 01",
      "01 04 04 07 07 04 09 01 01 04 07 04 07 07 07 01"
    ], (t) => TABLE_SIDE_COLORS[t]);

    /* ---------- 14 石砖 ---------- */
    base(TILE.STONE_BRICKS, "#838383");
    noisy(TILE.STONE_BRICKS, ["#797979", "#8e8e8e", "#727272"], 0.35);
    {
      const [ox, oy] = origin(TILE.STONE_BRICKS);
      ctx.fillStyle = "#585858";
      // 两排砖之间的横缝
      ctx.fillRect(ox, oy + 7, TILE_PX, 1);
      ctx.fillRect(ox, oy + 15, TILE_PX, 1);
      ctx.fillRect(ox, oy, TILE_PX, 1);
      // 上排竖缝(错缝)
      ctx.fillRect(ox + 5, oy + 1, 1, 6);
      ctx.fillRect(ox + 10, oy + 1, 1, 6);
      // 下排竖缝
      ctx.fillRect(ox + 2, oy + 8, 1, 7);
      ctx.fillRect(ox + 7, oy + 8, 1, 7);
      ctx.fillRect(ox + 12, oy + 8, 1, 7);
      ctx.fillRect(ox, oy + 8, 1, 7);
    }

    /* ---------- 15 雪 ---------- */
    base(TILE.SNOW, "#f3f7fc");
    noisy(TILE.SNOW, ["#ffffff", "#e6eef8", "#dce7f3", "#f8fbff"], 0.45);

    /* ---------- 16 冰（淡青 + 斜向裂纹） ---------- */
    base(TILE.ICE, "#a7d8ef");
    noisy(TILE.ICE, ["#98cde8", "#b6e2f6", "#8fc3e2", "#cdeffc"], 0.5);
    ctx.strokeStyle = "rgba(255,255,255,.65)";
    {
      const [ox, oy] = origin(TILE.ICE);
      ctx.fillStyle = "rgba(255,255,255,.7)";
      ctx.fillRect(ox + 2, oy + 5, 4, 1);
      ctx.fillRect(ox + 6, oy + 6, 1, 3);
      ctx.fillRect(ox + 9, oy + 10, 5, 1);
      ctx.fillRect(ox + 13, oy + 11, 1, 3);
      ctx.fillStyle = "rgba(96,160,200,.35)";
      ctx.fillRect(ox + 3, oy + 12, 5, 1);
    }

    /* ---------- 17 仙人掌侧面（深绿棱面 + 刺点） ---------- */
    base(TILE.CACTUS_SIDE, "#3c7a32");
    noisy(TILE.CACTUS_SIDE, ["#35702c", "#468a3b", "#2e6327", "#4f9444"], 0.55);
    {
      const [ox, oy] = origin(TILE.CACTUS_SIDE);
      // 两侧内凹暗棱
      ctx.fillStyle = "#28551f";
      ctx.fillRect(ox, oy, 1, 16);
      ctx.fillRect(ox + 15, oy, 1, 16);
      // 棱上高光
      ctx.fillStyle = "#57a34a";
      ctx.fillRect(ox + 2, oy, 1, 16);
      ctx.fillRect(ox + 13, oy, 1, 16);
      // 小白刺
      ctx.fillStyle = "#e8f0d8";
      dot(TILE.CACTUS_SIDE, 5, 3, "#e8f0d8");
      dot(TILE.CACTUS_SIDE, 10, 6, "#e8f0d8");
      dot(TILE.CACTUS_SIDE, 6, 10, "#e8f0d8");
      dot(TILE.CACTUS_SIDE, 11, 13, "#e8f0d8");
    }

    /* ---------- 18 仙人掌顶面（棱边 + 芯） ---------- */
    base(TILE.CACTUS_TOP, "#468a3b");
    noisy(TILE.CACTUS_TOP, ["#3f7e35", "#4f9444", "#38702f"], 0.5);
    {
      const [ox, oy] = origin(TILE.CACTUS_TOP);
      ctx.fillStyle = "#28551f";
      ctx.fillRect(ox, oy, 16, 1);
      ctx.fillRect(ox, oy + 15, 16, 1);
      ctx.fillRect(ox, oy, 1, 16);
      ctx.fillRect(ox + 15, oy, 1, 16);
      ctx.fillStyle = "#5fae51";
      ctx.fillRect(ox + 6, oy + 6, 4, 4);
      ctx.fillStyle = "#e8f0d8";
      ctx.fillRect(ox + 7, oy + 7, 2, 2);
    }

    /* ---------- 19 玄武岩（火山深色岩 + 暗红裂缝） ---------- */
    base(TILE.BASALT, "#3c3a42");
    noisy(TILE.BASALT, ["#322f37", "#47444f", "#2a282e", "#524e5b"], 0.65);
    {
      const [ox, oy] = origin(TILE.BASALT);
      ctx.fillStyle = "#1d1b20";
      ctx.fillRect(ox + 3, oy + 2, 1, 5);
      ctx.fillRect(ox + 4, oy + 6, 5, 1);
      ctx.fillRect(ox + 9, oy + 8, 1, 5);
      ctx.fillRect(ox + 10, oy + 12, 4, 1);
      // 暗红余烬点
      ctx.fillStyle = "#7a2a1c";
      ctx.fillRect(ox + 12, oy + 3, 1, 1);
      ctx.fillRect(ox + 4, oy + 13, 1, 1);
    }

    /* ---------- 20 岩浆（橙底 + 亮黄裂纹） ---------- */
    base(TILE.LAVA, "#dd4412");
    noisy(TILE.LAVA, ["#ff6b1c", "#b82e08", "#ff8f2e", "#c83a0c", "#ffb347"], 0.6);
    {
      const [ox, oy] = origin(TILE.LAVA);
      ctx.fillStyle = "#ffd24a";
      // 弯曲亮纹
      ctx.fillRect(ox + 1, oy + 4, 6, 1);
      ctx.fillRect(ox + 6, oy + 5, 3, 1);
      ctx.fillRect(ox + 9, oy + 5, 5, 1);
      ctx.fillRect(ox + 2, oy + 11, 4, 1);
      ctx.fillRect(ox + 7, oy + 12, 7, 1);
      ctx.fillStyle = "#fff0a8";
      ctx.fillRect(ox + 3, oy + 4, 2, 1);
      ctx.fillRect(ox + 10, oy + 5, 2, 1);
      ctx.fillRect(ox + 8, oy + 12, 2, 1);
    }

    /* ---------- 21 沙岩（沙色 + 水平层理） ---------- */
    base(TILE.SANDSTONE, "#d9c98e");
    noisy(TILE.SANDSTONE, ["#cdbd82", "#e4d69e", "#c4b378", "#ecdca8"], 0.5);
    {
      const [ox, oy] = origin(TILE.SANDSTONE);
      ctx.fillStyle = "rgba(150,132,78,.55)";
      ctx.fillRect(ox, oy + 5, 16, 1);
      ctx.fillRect(ox, oy + 11, 16, 1);
    }

    /* ---------- 22 煤矿石（图1 等距渲染顶面 1:1 提取的 16×16 像素图） ---------- */
    const COAL_ORE_COLORS = {
      a: "#8f8f8f", b: "#7f7f7f", c: "#747474", d: "#686868", e: "#5c5c5c",
      f: "#252525", g: "#363636", h: "#494b3f", i: "#393c36", j: "#2e2e2e"
    };
    paintGrid(TILE.COAL_ORE, [
      "a b b b c b c c a b d b b a b b",
      "a b c e f a a e c a b b e c c b",
      "a c d c g a b c b c a e f e c c",
      "a b d c c b c e f e c e h i c c",
      "b c c b c c e f i j e c g f b c",
      "c b e j c b c i h g e e f e b b",
      "c e f i e a c j g e b b f c g a",
      "b e i g j a c e j c c b a c j c",
      "c e g h f a b b b c b c a c b b",
      "d b e j f c c b c a c b e e b a",
      "c b c f e c i e b a c e h g e a",
      "c d b b c e j i c b c e i f b b",
      "b d j b c e i h c b e c f e b b",
      "b e g c c d e b c e f c c c b c",
      "b b b c b c b a b e i c d c a b",
      "b c b c b a b a c b d c d b a b"
    ], (t) => COAL_ORE_COLORS[t]);

    /* ---------- 23 铁矿石（图1 等距渲染顶面 1:1 提取的 16×16 像素图） ---------- */
    const IRON_ORE_COLORS = {
      a: "#8c8c8c", b: "#7c7c7c", c: "#727272", d: "#666666",
      e: "#857253", f: "#ac8b75", g: "#75654d", h: "#d4ac90", i: "#ddbca7"
    };
    paintGrid(TILE.IRON_ORE, [
      "a b b b c b c c a b d b b a b b",
      "b b c e a a b c a a b b c e a b",
      "b c e f a b b b d g a b d f e a",
      "b d f h a b a d e f a b c c g a",
      "b d e a c e a d f f h a e b c b",
      "c b c b d f a c d h i a f a b b",
      "c b b c d h f a d h a b a b b c",
      "b a d d e h h a c a d a c c b c",
      "c a c d e i h a b b c b g a b b",
      "d b c d f h a b g a b b e f a b",
      "c g b c f f b c e f a b f h a a",
      "c e e b e b c d f h a g h i a a",
      "c e f b d c b d g a b e h f a b",
      "c g b c d e a b c a c a f a b c",
      "a b b c c f a b b a c b e a b b",
      "a c b c b a b b c b c a c b b b"
    ], (t) => IRON_ORE_COLORS[t]);

    /* ---------- 熔炉三面（原版 furnace 16×16 像素 1:1 复刻） ----------
       正面=上料口/下炉膛双黑洞 + 中部亮带；侧面=碎石纹 + 下方亮带；
       顶面=碎石纹。世界方块按放置朝向选正面（见 world.js）。 */
    const FURNACE_PAL = {
      O: "#504e4e", K: "#3c3b3b", D: "#5d5b5b", d: "#686868", m: "#777777",
      M: "#858585", l: "#919191", L: "#9d9d9d", f: "#7f7f7f", a: "#a8a8a8",
      b: "#b0b0b0", c: "#c5c5c5", X: "#212121", N: "#111111"
    };

    /* 24 侧面 */
    paintGrid(TILE.FURNACE_SIDE, [
      "O O O O K O O O K K K O K K O O",
      "O D d d m d M m d d d m d d D O",
      "O D m l l D d D M M m d M M m O",
      "O d M M M l D d m l M M d M M O",
      "O D m M M m D m d M l M D m d K",
      "K D D d d D M l M d m M d O O K",
      "O d l l m d M M l M d d m m D O",
      "K m M M l d M M m D l M M M m K",
      "K d m m d D D m D l M M M m d O",
      "O c b c c c c c c c c c c c a O",
      "O L a a b a b b b b b b L b L K",
      "K L L a a a a a a a a a a a l O",
      "K l L L L L a L a a a a a L l O",
      "O f l L l L L L L a L l L l f O",
      "O d d m m d m m m m m m d d d O",
      "O O O O K O O O K K K K O O O O"
    ], (t) => FURNACE_PAL[t]);

    /* 25 顶面 */
    paintGrid(TILE.FURNACE_TOP, [
      "O O O O K O O O K K K O K K O O",
      "O D D D d M M m D d d m M d D O",
      "O D m l l m m D M l M d M M m O",
      "O d l M l l D m l l l M d m m O",
      "O m M l M m D d m l l l D m d K",
      "K d D d d D M m d d m M D D O K",
      "O D M l d M l l l M D D M M d O",
      "K m l l M d l l l d M l l l m K",
      "K l l l l m m M d M l l l m M O",
      "O l l l l M d d M d m M M M O O",
      "O m l l l m M l l l M d D D d K",
      "K D m M m d l l l l l M d l m O",
      "K M D D d D m M l l l m M M M O",
      "O m l D D m D d m m m d M M m O",
      "O D m d m M m O D d d D d m d O",
      "O O O O K O O O K K K K O O O O"
    ], (t) => FURNACE_PAL[t]);

    /* 30 正面（双炉口） */
    paintGrid(TILE.FURNACE_FRONT, [
      "O O O O K O O O K K K O K K O O",
      "O d d m m d m d m m d m d m D O",
      "K D m l m M d m M l M l m d m O",
      "O d M M K X X X X X X K M m d O",
      "O m M K N N N N N N N N K m D K",
      "K m d N N N X X X X N N N l D K",
      "O m d N N K K K K K K N N l D O",
      "K m l a a b b b b b b a a l m K",
      "K m M m d D m d D d m d m d d O",
      "O c b c c c c c c c c c c c a O",
      "O a a a b a M M M M a b a b L K",
      "O L a l D X N N N N X D l a L O",
      "O l l O N N N N N N N N O m L O",
      "O m l N N N X X X X N N N L l O",
      "K l m N X X X X X X X X N m L K",
      "K d K K K O O O O O O K K K d K"
    ], (t) => FURNACE_PAL[t]);

    /* ---------- 26 火把（透明底：棕色短棍 + 黄橙火头，仅 UI / 手持用） ---------- */
    {
      const [ox, oy] = origin(TILE.TORCH);
      // 棍
      ctx.fillStyle = "#6b4a26";
      ctx.fillRect(ox + 7, oy + 7, 2, 9);
      ctx.fillStyle = "#835e34";
      ctx.fillRect(ox + 7, oy + 7, 1, 9);
      // 火头：外橙内黄
      ctx.fillStyle = "#ff7a1c";
      ctx.fillRect(ox + 5, oy + 2, 6, 5);
      ctx.fillRect(ox + 6, oy + 1, 4, 1);
      ctx.fillStyle = "#ffb13a";
      ctx.fillRect(ox + 6, oy + 3, 4, 3);
      ctx.fillStyle = "#ffe27a";
      ctx.fillRect(ox + 7, oy + 4, 2, 2);
      ctx.fillStyle = "#c6561a";       // 火头暗边
      ctx.fillRect(ox + 5, oy + 6, 1, 1);
      ctx.fillRect(ox + 10, oy + 6, 1, 1);
    }

    /* ---------- 27 小草（原版 short grass 面片像素图 × 草色，交叉面片用） ---------- */
    {
      const [ox, oy] = origin(TILE.GRASS_BLADES);
      ctx.clearRect(ox, oy, TILE_PX, TILE_PX);
      paintGrid(TILE.GRASS_BLADES, GRASS_BLADES_ROWS, (t) => t === "." ? null : gt(parseInt(t, 16)));
    }

    /* ---------- 28 白桦原木侧面（白皮 + 灰黑横向斑纹，逐像素采样参考图） ---------- */
    {
      const BARK_P = ["#C6C5C4", "#B4B2AE", "#ADADA5", "#A09F95",
                      "#98988B", "#4D4B43", "#44433B", "#2B2A22"];
      const BARK_M = [
        "2222000212002200",
        "0000000000222220",
        "0222200000002000",
        "2445775200000020",
        "0224557522000254",
        "2220222200222577",
        "0002220000000024",
        "2000000022220002",
        "2200000000000000",
        "2210000000000220",
        "0020000000122000",
        "0000000000000002",
        "0000000000002457",
        "2000220000025777",
        "0000000212222455",
        "5222200002522220"
      ];
      const [ox, oy] = origin(TILE.BIRCH_LOG_SIDE);
      for (let y = 0; y < TILE_PX; y++) {
        const row = BARK_M[y];
        for (let x = 0; x < TILE_PX; x++) {
          ctx.fillStyle = BARK_P[+row[x]];
          ctx.fillRect(ox + x, oy + y, 1, 1);
        }
      }
    }

    /* ---------- 29 白桦原木顶面（黄褐同心年轮） ---------- */
    {
      const RING_P = ["#B3A374", "#C6B479", "#D3BD82", "#D3C78A", "#DCD6B6"];
      const RING_M = [
        "2000000131122224",
        "2033220000000023",
        "1023222221222022",
        "2022111111112002",
        "2022100000012001",
        "1001101000012201",
        "1001101111011102",
        "1022101001011201",
        "1002101001001201",
        "1002101111001201",
        "1002100010001101",
        "1002100000001201",
        "1002111111111201",
        "2002212222223201",
        "2000000000000001",
        "2222112111311222"
      ];
      const [ox, oy] = origin(TILE.BIRCH_LOG_TOP);
      for (let y = 0; y < TILE_PX; y++) {
        const row = RING_M[y];
        for (let x = 0; x < TILE_PX; x++) {
          ctx.fillStyle = RING_P[+row[x]];
          ctx.fillRect(ox + x, oy + y, 1, 1);
        }
      }
    }

    /* ---------- Mod 动态注册的 tile（painter 由模组提供） ---------- */
    for (const t in GameRegistry.tilePainters) {
      const tile = +t;
      const [mox, moy] = origin(tile);
      GameRegistry.tilePainters[tile](ctx, mox, moy, TILE_PX);
    }

    return canvas;
  }

  // 发光图集：与主图集同尺寸，全黑底上只保留需要自发光的 tile
  // （目前只有岩浆）。作为材质的 emissiveMap，夜晚仍保持明亮。
  function createEmissiveCanvas(srcCanvas) {
    const c = document.createElement("canvas");
    c.width = srcCanvas.width;
    c.height = srcCanvas.height;
    const x = c.getContext("2d");
    x.fillStyle = "#000";
    x.fillRect(0, 0, c.width, c.height);
    // 岩浆 tile 原样拷贝，再提亮一档，让夜晚“烧”得更明显
    const glowTiles = [TILE.LAVA];
    for (const t of glowTiles) {
      const ox = (t % COLS) * TILE_PX;
      const oy = Math.floor(t / COLS) * TILE_PX;
      x.drawImage(srcCanvas, ox, oy, TILE_PX, TILE_PX, ox, oy, TILE_PX, TILE_PX);
      x.globalCompositeOperation = "lighter";
      x.globalAlpha = 0.35;
      x.drawImage(srcCanvas, ox, oy, TILE_PX, TILE_PX, ox, oy, TILE_PX, TILE_PX);
      x.globalAlpha = 1;
      x.globalCompositeOperation = "source-over";
    }
    return c;
  }

  function createAtlasTexture() {
    const canvas = createAtlasCanvas();
    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;   // 像素风
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.encoding = THREE.sRGBEncoding;
    const emissiveTex = new THREE.CanvasTexture(createEmissiveCanvas(canvas));
    emissiveTex.magFilter = THREE.NearestFilter;
    emissiveTex.minFilter = THREE.NearestFilter;
    emissiveTex.generateMipmaps = false;
    emissiveTex.wrapS = THREE.ClampToEdgeWrapping;
    emissiveTex.wrapT = THREE.ClampToEdgeWrapping;
    emissiveTex.encoding = THREE.sRGBEncoding;
    const lava = createLavaTextures(canvas);
    const water = createWaterTexture(canvas);
    return {
      texture: tex, canvas: canvas, emissiveTexture: emissiveTex,
      lavaTexture: lava.map, lavaEmissiveTexture: lava.emissiveMap,
      waterTexture: water
    };
  }

  // 从图集中裁出水 tile，做成可循环滚动的独立贴图（水流下滚动画用，同岩浆方案）
  function createWaterTexture(srcCanvas) {
    const ox = (TILE.WATER % COLS) * TILE_PX;
    const oy = Math.floor(TILE.WATER / COLS) * TILE_PX;

    const c = document.createElement("canvas");
    c.width = TILE_PX; c.height = TILE_PX;
    c.getContext("2d").drawImage(srcCanvas, ox, oy, TILE_PX, TILE_PX, 0, 0, TILE_PX, TILE_PX);

    const t = new THREE.CanvasTexture(c);
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.encoding = THREE.sRGBEncoding;
    return t;
  }

  // 从图集中裁出岩浆 tile，做成可循环滚动的独立贴图（流动动画用）。
  // 返回 { map, emissiveMap }，二者共用同一 offset 即可保持明暗对齐。
  function createLavaTextures(srcCanvas) {
    const ox = (TILE.LAVA % COLS) * TILE_PX;
    const oy = Math.floor(TILE.LAVA / COLS) * TILE_PX;

    const c = document.createElement("canvas");
    c.width = TILE_PX; c.height = TILE_PX;
    c.getContext("2d").drawImage(srcCanvas, ox, oy, TILE_PX, TILE_PX, 0, 0, TILE_PX, TILE_PX);

    const glow = document.createElement("canvas");
    glow.width = TILE_PX; glow.height = TILE_PX;
    const gx = glow.getContext("2d");
    gx.drawImage(c, 0, 0);
    gx.globalCompositeOperation = "lighter";
    gx.globalAlpha = 0.35;
    gx.drawImage(c, 0, 0);
    gx.globalAlpha = 1;
    gx.globalCompositeOperation = "source-over";

    function makeTexture(canvas) {
      const t = new THREE.CanvasTexture(canvas);
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      t.encoding = THREE.sRGBEncoding;
      return t;
    }
    return { map: makeTexture(c), emissiveMap: makeTexture(glow) };
  }

  // 给定 tile 索引，返回该 tile 在图集中的 UV 边界(u0,v0,u1,v1)，v0 为底
  function tileUV(index) {
    const c = index % COLS;
    const r = Math.floor(index / COLS); // 自顶向下
    const pad = 0.5 / (COLS * TILE_PX); // 半像素保护，防止边缘串色
    const u0 = c / COLS + pad;
    const u1 = (c + 1) / COLS - pad;
    const v1 = 1 - r / ROWS - pad;
    const v0 = 1 - (r + 1) / ROWS + pad;
    return [u0, v0, u1, v1];
  }

  /* ============================================================
   * 物品图标：为非方块物品(木棍/镐)生成 16x16 像素 dataURL
   * 返回 { itemId: dataURL }
   * ============================================================ */
  function createItemIcons() {
    function makeCanvas() {
      const c = document.createElement("canvas");
      c.width = TILE_PX; c.height = TILE_PX;
      return c;
    }
    // 斜向木棍
    function stickIcon() {
      const c = makeCanvas();
      const x = c.getContext("2d");
      x.fillStyle = "#7a5a30";
      for (let i = 0; i < 11; i++) {
        const px = 3 + i, py = 12 - i;
        x.fillRect(px, py, 1, 1);
        x.fillRect(px + 1, py, 1, 1);
      }
      // 高光边
      x.fillStyle = "#9a753f";
      for (let i = 0; i < 11; i++) x.fillRect(3 + i, 12 - i, 1, 1);
      return c.toDataURL();
    }
    // 镐：按玩家提供的石镐参考图 1:1 逐格复刻的 16×16 点阵（与 MC 原版
    // stone_pickaxe.png 逐格全等）——五格顶梁、短左尖、拱形镐头、长右钩
    // 尖、斜收木柄（柄尾双格深棕木楔）。pal 给镐头五档材质色
    // {O 描边 / K 底影 / M 主色 / L 中间调 / H 最亮受光}；
    // 木柄四档（u 左上棱 / s 柄身 / p 受光 / e 右下暗棱），默认木色
    // 四把镐统一，木镐的 s/p 与其镐头 M/H 同色需显式传入。
    function pickIcon(pal) {
      return pixelsIcon([
        "................",
        "................",
        "......OOOOO.....",
        ".....OHLMMLOus..",
        "......OKKKMMpe..",
        "..........uLMK..",
        ".........useMLK.",
        "........upe.KMK.",
        ".......use..KMK.",
        "......upe...KLK.",
        ".....use....KHK.",
        "....upe......K..",
        "...use..........",
        "..upe...........",
        "..ee............",
        "................"
      ], {
        O: pal.O, K: pal.K, M: pal.M, L: pal.L, H: pal.H,
        u: pal.u || "#493615", s: pal.s || "#684e1e",
        p: pal.p || "#896727", e: pal.e || "#281e0b"
      });
    }
    // 斧头：按玩家提供的木斧参考图 1:1 逐格复刻的 16×16 点阵——
    // 顶部短横梁、宽弧斧刃、右下卷边 + 斜收木柄。pal 给斧头九档
    // 材质色（O 主描边 / K 最深角影 / D 刃口深影 / Q 头暗部 /
    // m 头内阴影带 / S 侧沿影 / M 主面 / H 受光 / L 高光）；
    // 木柄四档（u 柄左上棱 / s 柄身 / p 柄受光高光 / e 柄右下棱）
    // 三档材质斧头统一为木柄。
    function axeIcon(pal) {
      return pixelsIcon([
        "................",
        "........OO......",
        ".......OLLO.....",
        "......OLMHO.....",
        ".....OLMMMQS....",
        ".....KLHMmMD....",
        "......KKQMmMK...",
        ".......useMMK...",
        "......upe.KK....",
        ".....use........",
        "....use.........",
        "...upe..........",
        "..use...........",
        ".upe............",
        ".ee.............",
        "................"
      ], {
        O: pal.O, K: pal.K, D: pal.D, Q: pal.Q, m: pal.m,
        S: pal.S, M: pal.M, H: pal.H, L: pal.L,
        u: "#493615", s: "#684e1e", p: "#896727", e: "#281e0b"
      });
    }
    // 通用像素点阵绘制：rows 为等长字符串数组，ch 映射到颜色
    function pixelsIcon(rows, map, bg) {
      const c = makeCanvas();
      const x = c.getContext("2d");
      for (let r = 0; r < rows.length; r++) {
        for (let col = 0; col < rows[r].length; col++) {
          const ch = rows[r][col];
          if (ch === "." || ch === " ") continue;
          x.fillStyle = map[ch];
          x.fillRect(col, r, 1, 1);
        }
      }
      return c.toDataURL();
    }
    // 一块带骨头的肉排（肉色 + 白色骨棒）
    function meatIcon(meat, dark, bone) {
      return pixelsIcon([
        "................",
        "................",
        ".....mmmmm......",
        "....mmmmmmmm.b..",
        "...mmmmmmmmm.b..",
        "..mmmmmmm.bbb...",
        "..mmmmmm.bb.....",
        "..mmmmmm.b......",
        "...mmmm.b.......",
        "....mm.b........",
        ".....bb.........",
        "................",
        "................",
        "................",
        "................",
        "................"
      ], { m: meat, d: dark, b: bone || "#e8e2d2" });
    }
    // 生猪排：整块粉肉厚切，深红外皮勾边 + 右下最深阴影，
    // 肉面自下而上有亮粉高光（按玩家提供的像素图逐格复刻）
    function porkchopIcon() {
      return pixelsIcon([
        ".........SSSS...",
        ".......SSmmmrDD.",
        "......SmmmrppSSD",
        "......SmmmrppSSD",
        ".....SlppmmrlmmD",
        "..SSSrmpprrplrrD",
        ".SpppmmrrrrplmmK",
        ".SrrlrmmmrlllDDK",
        ".SrrlrmmmrlllDDK",
        "SmmmplmrrlhlmDD.",
        "SmmmrlhllhlmDKK.",
        "SmrrrhhhhlmDK...",
        ".DSSlhhppDKK....",
        ".DDDSlrDDK......",
        ".DDDSlrDDK......",
        "....KKKKK......."
      ], {
        K: "#512626",   // 最深阴影（底/右外缘）
        D: "#853e3e",   // 深红勾边
        S: "#a75353",   // 暗红外皮
        m: "#ef7070",   // 肉色基底
        r: "#ff7777",   // 亮红
        p: "#ff8c8c",   // 浅粉
        l: "#ffadad",   // 亮粉
        h: "#ffc6c6"    // 最亮高光
      });
    }
    // 生牛排：整块红肉，深红厚皮勾边 + 右下深褐阴影，肉面散布粉红高光
    // （按玩家提供的像素图 1:1 逐格复刻；10px 网格相位 x≡5/y≡6 三采样验证）
    function beefIcon() {
      return pixelsIcon([
        "................",
        "................",
        "..........BBBB..",
        ".........BLmRsB.",
        "........BLrRsmRB",
        ".......BmrrrRmRD",
        ".....BBRrrmRrLBK",
        "....BRrrRmRrLRDK",
        "....BrmRsrrmRDKK",
        "...BRLRrrmsRDDK.",
        "...BLrrmssRDDK..",
        "...KBLLsRBBDK...",
        "....KBBBBDKK....",
        ".....KKKKK......",
        "................",
        "................"
      ], {
        K: "#470a06",   // 最深褐红阴影（底/右外缘）
        D: "#7b1713",   // 深酒红
        B: "#ad1d17",   // 深红厚皮勾边
        R: "#e03e35",   // 鲜红
        r: "#e2534a",   // 中红
        m: "#e2625a",   // 浅红
        s: "#e27269",   // 肉粉
        L: "#ea8873"    // 最亮高光（粉肉粒）
      });
    }
    // 生羊肉：弯条状红肉，深酒红厚皮勾边 + 右下最深褐红阴影，
    // 肉面鲜红块与粉红高光交错（按玩家提供的像素图 1:1 逐格复刻；
    // 原图每格 10px，bbox 12×15，居中于 16×16 画框 x 偏移 2）
    function muttonIcon() {
      return pixelsIcon([
        "............AA..",
        "..........BCAA..",
        "..........BCBA..",
        ".........BCCBA..",
        ".........BCDAE..",
        "........BDFDAE..",
        ".......BDFBCAE..",
        ".....BBCDCFCA...",
        "....BDDCFDCCA...",
        "...BDCBBBCDAE...",
        "..BDFBBBBFDAE...",
        "..BDCFBBFCBA....",
        "..AACCDDCAAE....",
        "..EAAAAAEE......",
        "...EEEEE........",
        "................"
      ], {
        E: "#470a06",   // 最深褐红阴影（底/右外缘）
        A: "#96211b",   // 深酒红勾边
        B: "#ad332e",   // 暗红厚皮
        F: "#dd3830",   // 鲜红肉块
        C: "#e2625a",   // 浅红
        D: "#e88a82"    // 粉红高光
      });
    }
    const icons = {};
    icons[ITEM.STICK] = stickIcon();
    // 三把镐轮廓完全相同（MC 原版 1:1），仅镐头五档色随材质变化。
    // 木镐：全木色，柄身/受光与镐头 M/H 同色；石镐：灰岩五档（含 #89 中间调）；
    // 铁镐：冷钢灰，最亮一档为纯白高光（与原版 iron_pickaxe.png 逐格同色）。
    icons[ITEM.WOOD_PICKAXE] = pickIcon({
      O: "#372910", K: "#20180a", M: "#6a501e", L: "#755821", H: "#886626",
      u: "#493615", s: "#6a501e", p: "#886626", e: "#281e0b"
    });
    icons[ITEM.STONE_PICKAXE] = pickIcon({
      O: "#494949", K: "#181818", M: "#7f7f7f", L: "#898989", H: "#9a9a9a"
    });
    icons[ITEM.IRON_PICKAXE] = pickIcon({
      O: "#444444", K: "#181818", M: "#c1c1c1", L: "#d8d8d8", H: "#ffffff"
    });
    // 木斧九档棕色按参考图逐格取色；石斧 / 铁斧沿用同一构型，仅替换
    // 斧头九档为灰岩 / 冷铁灰阶（木柄四档三色统一不变）
    icons[ITEM.WOOD_AXE] = axeIcon({
      O: "#372910", K: "#20180a", D: "#281e0b", Q: "#493615", m: "#594319",
      S: "#684e1e", M: "#6b511f", H: "#755821", L: "#866526"
    });
    icons[ITEM.STONE_AXE] = axeIcon({
      O: "#555555", K: "#262626", D: "#2e2e2e", Q: "#5f5f5f", m: "#6e6e6e",
      S: "#808080", M: "#929292", H: "#a0a0a0", L: "#aeaeae"
    });
    icons[ITEM.IRON_AXE] = axeIcon({
      O: "#43474d", K: "#171717", D: "#1f2226", Q: "#4f565d", m: "#7d838a",
      S: "#9aa0ab", M: "#c8ccd2", H: "#d8dade", L: "#eceef2"
    });
    icons[ITEM.PORKCHOP] = porkchopIcon();
    icons[ITEM.BEEF] = beefIcon();
    icons[ITEM.MUTTON] = muttonIcon();
    // 皮革：不规则兽皮轮廓 + 深色边
    icons[ITEM.LEATHER] = pixelsIcon([
      "................",
      "....dddd........",
      "...dLLLLdd......",
      "..dLLLLLLLd.....",
      ".dLLLdLLLLLd....",
      ".dLLLLLLLLLd....",
      "dLLLLLLdLLLLd...",
      "dLLLLLLLLLLd....",
      "dLLLLLdLLLLd....",
      ".dLLLLLLLLd.....",
      ".dLLLdLLLLd.....",
      "..dLLLLLLd......",
      "...dddddd......."
    ], { L: "#8a5a2b", d: "#5e3a18" });
    // 羊毛：等距视角白羊毛方块（按玩家提供的方块图 1:1 逐格复刻；
    // 几何由原图轮廓反推：顶面亮白菱形 4 行高，两侧面等长，下沿 V 字收尖；
    // 三个面各自散布绒面噪点，保持与 3D 渲染一致的顶亮 / 左浅 / 右深）
    icons[ITEM.WOOL] = pixelsIcon([
      ".......Qt.......",
      ".....QtTtQt.....",
      "..QtTtTQQtTtTt..",
      "QtTtQTtWtTQttTtW",
      "WLWLWLLWrKrRrrKr",
      "LWWLWLWWRrrKrRrr",
      "WLWLLWWLrrKrRrrK",
      "WWLWWLWLKrRrrKrR",
      "LWLWWLWWrrKrRrrK",
      "WLLWLWLWrRrrKrRr",
      "LWWLWLLWKrRrrKrR",
      "WLWLWLWWrKrRrrKr",
      "LWWLLWLWRrrKrRrr",
      "..WLWWLWrrKrRr..",
      ".....LWWrRr.....",
      ".......Lr......."
    ], {
      Q: "#eceeed",   // 顶面最亮绒白
      T: "#dfe2e3",   // 顶面亮白
      t: "#d3d8d9",   // 顶面灰白
      W: "#c3c4c5",   // 顶面暗粒 / 左面亮粒
      L: "#b1b4b5",   // 左面基底
      R: "#989898",   // 右面亮粒
      r: "#8f9191",   // 右面基底
      K: "#858888"    // 右面暗粒
    });
    // 羊毛帽：圆顶 + 两侧护耳，下方露出脸的缺口
    icons[ITEM.WOOL_HELMET] = pixelsIcon([
      "....ssssss....",
      "...swwwwwws...",
      "..swwwwwwwws..",
      "..swddddddws..",
      "..swddddddws..",
      "..swwwwwwwws..",
      ".sswwwwwwwwss.",
      ".s..........s."
    ], { w: "#f2efe6", s: "#cfc9ba", d: "#3a3a42" });
    // 羊毛衣：肩带 + 衣身
    icons[ITEM.WOOL_CHEST] = pixelsIcon([
      ".ss......ss...",
      "swws....swws..",
      "swwwwwwwwwws..",
      "swwwwwwwwwws..",
      "swwwwwwwwwws..",
      "swwwwwwwwwws..",
      ".swwwwwwwws...",
      "..swwwwwws....",
      "...ssssss....."
    ], { w: "#f2efe6", s: "#cfc9ba" });
    // 羊毛裤：腰臀 + 两条裤腿
    icons[ITEM.WOOL_LEGS] = pixelsIcon([
      "..ssssssssss..",
      ".swwwwwwwwwws.",
      "swwwwwwwwwwww.",
      "swwwwwwwwwwww.",
      ".sswwwwwwss...",
      "..sww..wws....",
      "..sww..wws....",
      "..sww..wws....",
      "..ss....ss...."
    ], { w: "#f2efe6", s: "#cfc9ba" });
    // 皮革背包：翻盖 + 金属扣 + 背带侧影
    icons[ITEM.BACKPACK] = pixelsIcon([
      "................",
      ".....dddddd.....",
      "....dLLLLLLd....",
      "...dLhhhhhhLd...",
      "..dLhhhhhhhhLd..",
      "..dLhLLLLLLhLd..",
      "..dLLkkkkkkLLd..",
      "..dLLkLLLLkLLd..",
      "..dLLLLLLLLLLd..",
      "..dLsLLLLLLsLd..",
      "..dLLLLLLLLLLd..",
      "..dLLLLLLLLLLd..",
      "..dLLLLLLLLLLd..",
      "...dLLLLLLLLd...",
      "....dddddddd....",
      "................"
    ], { L: "#8a5a30", d: "#5d3d22", h: "#a8723f", k: "#d9c9a0", s: "#6e4525" });
    // 龙肉：火灼暗红色肉排 + 白骨（去紫，与红眼/火焰同色系）
    icons[ITEM.DRAGON_MEAT] = meatIcon("#c04438", "#7e2018", "#ece2d0");
    // 龙皮：灰黑龙兽皮轮廓 + 中灰鳞片（图纸灰阶 H5/H6/H4）
    icons[ITEM.DRAGON_HIDE] = pixelsIcon([
      "................",
      "....dddd........",
      "...dLLLLdd......",
      "..dLhLLLLLd.....",
      ".dLLLhLLLLLd....",
      ".dLLLLLLhLLd....",
      "dLLhLLLLLLLLd...",
      "dLLLLLLhLLLLd...",
      "dLLLLLLLLhLLd...",
      ".dLLhLLLLLLd....",
      ".dLLLLhLLLLd....",
      "..dLLLLLLd......",
      "...dddddd......."
    ], { L: "#515056", d: "#312c32", h: "#8d8a8f" });
    // 煤：图2 参考图 1:1 提取的 16×16 黑色团块（含蓝灰高光与暗紫下半身）
    icons[ITEM.COAL] = pixelsIcon([
      "................",
      "................",
      ".....AAAA.......",
      "....ABCCBA......",
      "...ADEFCDDA.....",
      "...AEDCBCBDA....",
      "...AGGDEFECDA...",
      "..ADBDGDEEBDCH..",
      "..ABFCDBBBDGDH..",
      "..ADBBBDDDBGGGH.",
      "..ADDDGDBGDIDIH.",
      "..AIGDGGGGGIGIH.",
      "...HIIGDIGGIIH..",
      "....HIIIIHHHH...",
      ".....HHHH.......",
      "................"
    ], {
      A: "#1c1c1e", B: "#2e2e2e", C: "#323232", D: "#252525", E: "#363636",
      F: "#393e46", G: "#261e24", H: "#101015", I: "#1f1721"
    });
    // 粗铁：图2 参考图 1:1 提取的 16×16 生铁矿团块（黑描边 + 米黄高光 + 棕褐阴影）
    icons[ITEM.RAW_IRON] = pixelsIcon([
      "................",
      "..AAAAA.........",
      ".ABCCDBAA.......",
      ".ACECECDBAAA....",
      "ADEEECECCCDBA...",
      "ADBDEECCCDBDBA..",
      "FDGGDBGGHGBGBA..",
      "FBHGBGGGAAHGGA..",
      "FBHHBGGHAAAAHF..",
      "FGGHHAAADDCBGHF.",
      ".FGHHHFFDDBHAAF.",
      "..FFFF..GGGHAAF.",
      "........FGGAAF..",
      ".........FFFF...",
      "................",
      "................"
    ], {
      A: "#574d39", B: "#d8af93", C: "#fedec8", D: "#e9c8b1",
      E: "#fef4ed", F: "#3b3429", G: "#af8e77", H: "#887455"
    });
    // 铁锭：图3 参考图 1:1 提取的 16×16 银灰锭（横向锭形 + 白色高光 + 深灰描边）
    icons[ITEM.IRON_INGOT] = pixelsIcon([
      "................",
      "................",
      "..........AA....",
      ".......AAABBC...",
      "....AAABDDDDBC..",
      ".AAABDDDDDDDDBC.",
      "A.DDDDDDDDDD..DC",
      "AB.DDDDDD...DCBE",
      "ABB.DD...DFCCFBE",
      "ABBB..DFCCCCBBBE",
      "AFBBDFCCCCBBFEE.",
      ".AFBDFCCFFEEE...",
      "..AFBFGEEE......",
      "...AAEE.........",
      "................",
      "................"
    ], {
      A: "#5e5e5e", B: "#a8a8a8", C: "#727272", D: "#d8d8d8",
      E: "#353535", F: "#828282", G: "#585858"
    });
    // 蜘蛛丝：一团盘绕的白色丝线（椭圆线圈 + 交错丝缕）
    icons[ITEM.SPIDER_SILK] = pixelsIcon([
      "................",
      "......ssss......",
      "....ssWWWWss....",
      "...sWWWWWWWWs...",
      "..sWWWs..sWWWs..",
      "..sWW......WWs..",
      ".sWW..ss...WWs..",
      ".sW...WW....Ws..",
      ".sW...WW....Ws..",
      ".sWW..ss...WWs..",
      "..sWW......WWs..",
      "..sWWWs..sWWWs..",
      "...sWWWWWWWWs...",
      "....ssWWWWss....",
      "......ssss......",
      "................"
    ], { W: "#f0efe8", s: "#b4b4ac" });
    // 合并 mod 注册的物品图标
    for (const id in GameRegistry.itemIcons) icons[id] = GameRegistry.itemIcons[id];
    return icons;
  }

  global.createAtlasTexture = createAtlasTexture;
  global.createItemIcons = createItemIcons;
  global.tileUV = tileUV;
  global.ATLAS_COLS = COLS;
  global.ATLAS_ROWS = ROWS;
})(window);
