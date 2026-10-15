/* ============================================================
 * world.js — 体素世界：稀疏区块存储、无限地形生成、区块网格与流送
 * 世界：水平方向无限（区块按需确定性生成），高 48；区块 16 x 16
 * 区块坐标可为负；离开视野的纯净区块数据/网格被回收，需要时按种子
 * 逐字节重建；玩家改动过的区块（dirty）永久保留内存并写入存档。
 * 地形管线: 大陆性噪声(海/陆分布) → 山脉掩膜+刃脊(尖峭山峰) → 丘陵/细节，
 * 生物群系: 深海/海洋/沙滩/平原/橡树林/桦木林/沙漠/岩山/雪峰/冰川/火山，
 * 地下: 3D 噪声雕刻的蜿蜒隧道与充水溶洞，深层岩浆
 * ============================================================ */
(function (global) {
  "use strict";

  const CHUNK = 16;

  // 六个面。每面 4 个角点 A B C D，三角形为 (A,B,C) 与 (C,B,D)，
  // 绕序经叉积校验，法线朝外（three 默认正面为逆时针）。
  // uv: (u,v)，v=1 对应纹理顶边 / y=1 的角
  const FACES = [
    { // 0: -x
      dir: [-1, 0, 0], slot: 1,
      p: [[0,1,0],[0,0,0],[0,1,1],[0,0,1]],
      uv: [[0,1],[0,0],[1,1],[1,0]]
    },
    { // 1: +x
      dir: [1, 0, 0], slot: 1,
      p: [[1,1,1],[1,0,1],[1,1,0],[1,0,0]],
      uv: [[0,1],[0,0],[1,1],[1,0]]
    },
    { // 2: -y 底
      dir: [0, -1, 0], slot: 2,
      p: [[1,0,1],[0,0,1],[1,0,0],[0,0,0]],
      uv: [[1,0],[0,0],[1,1],[0,1]]
    },
    { // 3: +y 顶
      dir: [0, 1, 0], slot: 0,
      p: [[0,1,1],[1,1,1],[0,1,0],[1,1,0]],
      uv: [[1,1],[0,1],[1,0],[0,0]]
    },
    { // 4: -z
      dir: [0, 0, -1], slot: 1,
      p: [[1,1,0],[1,0,0],[0,1,0],[0,0,0]],
      uv: [[0,1],[0,0],[1,1],[1,0]]
    },
    { // 5: +z
      dir: [0, 0, 1], slot: 1,
      p: [[0,1,1],[0,0,1],[1,1,1],[1,0,1]],
      uv: [[0,1],[0,0],[1,1],[1,0]]
    }
  ];

  // 六面基础明暗（顶最亮、底最暗，类似经典体素渲染）
  const FACE_SHADE = [0.72, 0.72, 0.52, 1.0, 0.86, 0.86];

  // 带朝向方块的逐面 tile 选择：meta 存熔炉正面的 FACES 索引（0/1/4/5），
  // 正面用 FURNACE_FRONT，其余水平侧面用 FURNACE_SIDE；顶/底及其他方块走三槽映射
  function faceTile(id, f, slot, tiles, meta) {
    if (id === BLOCK.FURNACE && (f === 0 || f === 1 || f === 4 || f === 5)) {
      return f === meta ? TILE.FURNACE_FRONT : TILE.FURNACE_SIDE;
    }
    return tiles[slot];
  }
  // AO 等级：边/角遮挡越多越暗
  const AO_LEVELS = [0.5, 0.66, 0.82, 1.0];

  /* ---------------- 岩浆流动参数 ---------------- */
  const LAVA_SPREAD = 3;        // 距源头最远水平扩散格数
  const LAVA_FALL_TICK = 0.22;  // 向下流动的尝试间隔（秒，岩浆下落较快）
  const LAVA_SPREAD_TICK = 0.9; // 水平扩散 / 断流校验间隔（秒，岩浆粘稠缓慢）
  const LAVA_MAX_FLOW = 700;    // 流动岩浆格上限（防止失控蔓延）
  const LAVA_STEP_BUDGET = 40;  // 每帧最多处理的岩浆格数（形成逐格倾泻的节奏感）
  const LAVA_DIRS4 = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];

  // 生物群系 id（存入 world.biomeMap）
  // 高度由多层噪声决定（大陆性 → 山脉 → 丘陵 → 细节），群系按海拔/气候归类，
  // 因此山脉、谷地、平原之间是平滑过渡，不再是固定网格切块
  const BIOME = {
    PLAINS: 0, DESERT: 1, OCEAN: 2, GLACIER: 3, VOLCANO: 4, BIRCH_FOREST: 5,
    FOREST: 6,        // 橡树林（和缓草地 + 密集橡树）
    MOUNTAINS: 7,     // 尖峭山峰（岩石山坡）
    DEEP_OCEAN: 8,    // 深海（远海深水床）
    PEAKS: 9,         // 雪峰（雪线以上的山顶）
    BAMBOO: 10,       // 竹林（和缓草地 + 成片细竹竿）
    CHERRY: 11        // 樱花林（和缓草地 + 多层宽冠樱花树）
  };

  // 两个 int -> uint32 的确定性哈希（无限图上气候洗牌/矿脉/植被用）
  function hash2i(a, b, seed) {
    let h = Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(seed | 0, 1442695040);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return h >>> 0;
  }
  const cKey = (cx, cz) => cx + "," + cz;

  class World {
    // opts.headless：仅用于联机 diff 的临时世界——只按区块生成/读数据，
    // 不创建任何 THREE 材质，也绝不构建网格
    constructor(scene, atlasTexture, seed, emissiveTexture, lavaTexture, lavaEmissiveTexture, waterTexture, opts) {
      opts = opts || {};
      this.headless = !!opts.headless;
      this.scene = this.headless ? null : scene;
      this.H = 48;
      this.SEA = 14;                 // 海平面高度(水填充到这一层)
      this.CHUNK = CHUNK;
      this.CH = CHUNK * CHUNK * this.H;   // 每区块体素数 12288
      this.seed = seed == null ? 20260930 : seed;

      // 流送半径：网格 MESH_R 环，数据至少保留 MESH_R+2（建网要读一圈邻居；
      // 特性（树冠/矿脉）会跨界写入 2 格 / 蔓延 9 格，生成时另做按需级联）
      this.MESH_R = 6;
      this.DATA_R = this.MESH_R + 2;

      // 稀疏区块数据：key "cx,cz" ->
      // { d:Uint8Array(CH), hm/bm/wt:Uint8Array(256), terrain, feat, dirty }
      this.cdata = new Map();
      this.chunks = new Map();       // key -> {opaque, transparent, lava, ...} 网格
      this._tileCenters = new Map();   // 宏观气候牌内 16 个气候中心缓存
      this._tileBasins = new Map();    // 宏观气候牌内海盆缓存
      this._veinCache = new Map();     // 区块矿脉清单缓存
      this._streamQ = [];              // 待建网格的区块（按距离排序）
      this._streamSet = new Set();
      this._streamCenter = null;       // 当前流送中心（区块坐标）
      this._homeVolcano = null;

      if (!this.headless) {
      // vertexColors：烘焙“六面明暗 + 顶点环境光遮蔽”
      // emissiveMap：发光图集中只有岩浆是亮的 → 夜晚仍自发光
      this.opaqueMaterial = new THREE.MeshLambertMaterial({
        map: atlasTexture,
        vertexColors: true,
        emissive: 0xffffff,
        emissiveMap: emissiveTexture || null,
        emissiveIntensity: 0
      });
      // 水专用材质：独立可滚动贴图（逐格 0..1 UV，每帧 offset 下滚）+ 顶面微波。
      // 网格顶点坐标本就是世界坐标（mesh 位于原点），波浪相位按世界 xz 计算，
      // 区块边界两侧顶点位移公式一致，不会开裂。
      this.waterUniforms = { uTime: { value: 0 } };
      this.waterMaterial = new THREE.MeshLambertMaterial({
        map: waterTexture || null,
        vertexColors: true,
        transparent: true,
        opacity: 0.74,
        depthWrite: false
      });
      this.waterMaterial.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = this.waterUniforms.uTime;
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>",
            "#include <common>\nuniform float uTime;")
          .replace("#include <begin_vertex>",
            "#include <begin_vertex>\n" +
            "float wTop = step(0.5, position.y);\n" +
            "transformed.y += wTop * (0.045 * sin(uTime * 1.7 + position.x * 0.9 + position.z * 0.7)\n" +
            "           + 0.03 * sin(uTime * 2.5 + position.x * 1.9 - position.z * 1.4));");
      };
      // 岩浆专用材质：独立可滚动贴图（uv 0..1 平铺一格），表面持续流动
      this.lavaMaterial = new THREE.MeshLambertMaterial({
        map: lavaTexture || null,
        vertexColors: true,
        emissive: 0xffffff,
        emissiveMap: lavaEmissiveTexture || null,
        emissiveIntensity: 0.5
      });
      // 火把专用材质：无贴图、顶点色、不受光照（火头昼夜常亮）
      this.torchMaterial = new THREE.MeshBasicMaterial({ vertexColors: true });
      // 自发光图集材质：带纹理但不受场景光照（灯等 mod 方块昼夜恒亮）
      this.unlitMaterial = new THREE.MeshBasicMaterial({ map: atlasTexture, vertexColors: true });

      // 小草材质：图集贴图 + 顶点色 + 透明裁切；顶点着色器注入风力摇摆
      this.grassUniforms = { uWindTime: { value: 0 } };
      this.grassMaterial = new THREE.MeshLambertMaterial({
        map: atlasTexture,
        vertexColors: true,
        alphaTest: 0.5,
        side: THREE.DoubleSide
      });
      this.grassMaterial.onBeforeCompile = (shader) => {
        shader.uniforms.uWindTime = this.grassUniforms.uWindTime;
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>",
            "#include <common>\nattribute float aSway;\nuniform float uWindTime;")
          .replace("#include <begin_vertex>",
            "#include <begin_vertex>\n" +
            "transformed.x += sin(uWindTime * 1.7 + position.x * 0.9 + position.z * 0.6) * 0.085 * aSway;\n" +
            "transformed.z += cos(uWindTime * 1.3 + position.z * 0.8) * 0.045 * aSway;");
      };
      }

      // 岩浆流动调度：idx(线性下标) -> 该格下一次该被处理的游戏时间
      this.lavaQueue = new Map();
      this.lavaClock = 0;
      this.flowCount = 0;            // 当前流动岩浆格数（不含源头）
      this.flowCountKnown = false;

      // 联机方块同步（Task 4）
      // netMode：off=单机；host=房主，setBlock 收口记入 dirtyBlocks；guest=客人，
      // 只接受 applyNetBlock 广播，自身一切模拟（岩浆等）短路
      this.netMode = opts.netMode || "off";
      this.silent = false;          // generate/applyData 批量写入期间不记脏
      this.dirtyBlocks = this.netMode === "host" ? new Map() : null;
    }

    // 联机角色切换（建连完成后由玩法层设置）
    setNetMode(mode) {
      this.netMode = mode;
      if (mode === "host") {
        if (!this.dirtyBlocks) this.dirtyBlocks = new Map();
      } else if (mode !== "host") {
        this.dirtyBlocks = null;
      }
    }

    // 房主每帧末取走本帧脏块（"x,y,z"->[id,meta] 已按坐标去重，保留最终值），
    // 返回 [[x,y,z,id,meta]...]
    takeDirtyBlocks() {
      const m = this.dirtyBlocks;
      if (!m || !m.size) return null;
      const out = [];
      for (const [k, v] of m) {
        const p = k.split(",");
        out.push([+p[0], +p[1], +p[2], v[0], v[1]]);
      }
      m.clear();
      return out;
    }

    // 客人应用房主广播的方块变更：目标区块尚未生成时按需确定性生成
    applyNetBlock(x, y, z, id, meta) {
      if (y < 0 || y >= this.H) return;
      this.setBlock(x, y, z, id, meta || 0);
      this.remeshAround(x, z);
    }

    // 客人首次 welcome 的全量脏块：只写数据，最后只重建“当前已有网格”的区块，
    // 没建网的区块不建（随后 initialBuild 会按最终数据一次性建网）
    applyNetBlocks(list) {
      const meshKeys = new Set();
      for (const d of list) {
        if (!d || d.length < 4) continue;
        const x = d[0] | 0, y = d[1] | 0, z = d[2] | 0, id = d[3] & 0xff;
        const meta = d.length > 4 ? d[4] | 0 : 0;
        if (y < 0 || y >= this.H) continue;
        this.setBlock(x, y, z, id, meta);
        const cx = x >> 4, cz = z >> 4;
        const lx = x & 15, lz = z & 15;
        if (this.chunks.has(cKey(cx, cz))) meshKeys.add(cKey(cx, cz));
        if (lx === 0 && this.chunks.has(cKey(cx - 1, cz))) meshKeys.add(cKey(cx - 1, cz));
        if (lx === 15 && this.chunks.has(cKey(cx + 1, cz))) meshKeys.add(cKey(cx + 1, cz));
        if (lz === 0 && this.chunks.has(cKey(cx, cz - 1))) meshKeys.add(cKey(cx, cz - 1));
        if (lz === 15 && this.chunks.has(cKey(cx, cz + 1))) meshKeys.add(cKey(cx, cz + 1));
      }
      for (const k of meshKeys) {
        const p = k.indexOf(",");
        this.buildChunk(+k.slice(0, p), +k.slice(p + 1));
      }
    }

    /* ---------------- 数据访问（稀疏区块） ---------------- */

    // 无限世界只有垂直边界；水平方向任何整数坐标都合法
    inBounds(x, y, z) {
      return y >= 0 && y < this.H;
    }

    _chunkIdx(cx, cz) { return this.cdata.get(cKey(cx, cz)); }

    // 区块内体素下标：lx,lz ∈ 0..15
    static CI(y, lx, lz) { return (y * CHUNK + lz) * CHUNK + lx; }

    getBlock(x, y, z) {
      if (y < 0) return BLOCK.BEDROCK;          // 世界底部外：基岩
      if (y >= this.H) return BLOCK.AIR;
      x = Math.floor(x); z = Math.floor(z);
      const c = this.cdata.get(cKey(x >> 4, z >> 4));
      if (!c) return BLOCK.BEDROCK;             // 尚未生成的区域视为实心墙（流送会提前补上）
      return c.d[(y * CHUNK + (z & 15)) * CHUNK + (x & 15)];
    }

    setBlock(x, y, z, id, meta) {
      if (y < 0 || y >= this.H) return;
      x = Math.floor(x); z = Math.floor(z);
      const cx = x >> 4, cz = z >> 4;
      let c = this.cdata.get(cKey(cx, cz));
      if (!c) {
        // 客人应用远处脏块等情形：先确定性生成纯净区块，再覆盖该格
        c = this._genChunk(cx, cz);
      }
      const vi = (y * CHUNK + (z & 15)) * CHUNK + (x & 15);
      c.d[vi] = id;
      // meta：方块附加状态（熔炉正面朝向，存 FACES 面索引 0/1/4/5）。
      // 挖成空气时一并清零；其余未传 meta 的写入（岩浆等）保持原值。
      if (c.mt) c.mt[vi] = meta !== undefined ? (meta & 0xff)
                       : (id === BLOCK.AIR ? 0 : c.mt[vi]);
      // 运行时一切方块变更（挖掘/放置/岩浆/mod）都使区块偏离纯净地形
      if (!this.silent) c.dirty = true;
      if (this.netMode === "host" && !this.silent && this.dirtyBlocks) {
        this.dirtyBlocks.set(x + "," + y + "," + z, [id, c.mt ? c.mt[vi] : 0]);
      }
    }

    // 读取方块附加状态（朝向等）；非脏区块/越界一律 0
    getBlockMeta(x, y, z) {
      if (y < 0 || y >= this.H) return 0;
      x = Math.floor(x); z = Math.floor(z);
      const c = this.cdata.get(cKey(x >> 4, z >> 4));
      if (!c || !c.mt) return 0;
      return c.mt[(y * CHUNK + (z & 15)) * CHUNK + (x & 15)];
    }

    // 地表高度（mobs/drops 用）；目标区块未生成时确定性补生成
    heightAt(x, z) {
      x = Math.floor(x); z = Math.floor(z);
      const c = this._chunkIdx(x >> 4, z >> 4) || this._genChunk(x >> 4, z >> 4);
      return c.hm[(z & 15) * CHUNK + (x & 15)];
    }

    biomeAt(x, z) {
      x = Math.floor(x); z = Math.floor(z);
      const c = this._chunkIdx(x >> 4, z >> 4) || this._genChunk(x >> 4, z >> 4);
      return c.bm[(z & 15) * CHUNK + (x & 15)];
    }

    // 旧档全量读档入口已废弃（无限世界只接受区块档）
    applyData(bytes) { return false; }

    /* ---------------- 存档：只存偏离纯净地形的脏区块 ---------------- */

    // [{cx,cz,d:Uint8Array(CH),hm/bm:Uint8Array(256)}...]
    serializeDirtyChunks() {
      const out = [];
      for (const [k, c] of this.cdata) {
        if (!c.dirty) continue;
        const p = k.split(",");
        out.push({ cx: +p[0], cz: +p[1], d: c.d.slice(), mt: c.mt.slice(), hm: c.hm.slice(), bm: c.bm.slice() });
      }
      return out;
    }

    // 联机：把全部 dirty 区块与同种子纯净世界逐格对比，返回 [[x,y,z,id]...]。
    // 客人晚加入时用它做全量对齐（重载后的房主也适用：脏区块永不卸载）
    diffDirtyChunks() {
      if (!this._pristineWorld || this._pristineWorld.seed !== this.seed) {
        this._pristineWorld = new World(null, null, this.seed, null, null, null, null, { headless: true });
      }
      const pw = this._pristineWorld;
      const out = [];
      for (const [k, rec] of this.cdata) {
        if (!rec.dirty) continue;
        const p = k.split(",");
        const cx = +p[0], cz = +p[1];
        const pref = pw.pristineChunk(cx, cz);
        const x0 = cx * CHUNK, z0 = cz * CHUNK;
        const d = rec.d, pd = pref.d;
        for (let i = 0; i < d.length; i++) {
          if (d[i] === pd[i]) continue;
          const y = (i / 256) | 0;
          const t = i - y * 256;
          const lz = (t / 16) | 0;
          const lx = t - lz * 16;
          out.push([x0 + lx, y, z0 + lz, d[i], rec.mt ? rec.mt[i] : 0]);
        }
      }
      return out;
    }

    // 启动时恢复存档区块：直接作为已完成生成+特性的区块放入，标记 dirty；
    // 邻区生成特性时不会跨界写入脏区块（避免复活已砍的树/已挖的矿）
    applySavedChunks(list) {
      if (!Array.isArray(list)) return 0;
      let n = 0;
      const wasSilent = this.silent;
      this.silent = true;
      for (const e of list) {
        if (!e || !(e.d instanceof Uint8Array) || e.d.length !== this.CH) continue;
        const cx = e.cx | 0, cz = e.cz | 0;
        const d = new Uint8Array(this.CH);
        d.set(e.d);
        const mt = new Uint8Array(this.CH);
        if (e.mt instanceof Uint8Array && e.mt.length === this.CH) mt.set(e.mt);
        const hm = new Uint8Array(CHUNK * CHUNK);
        if (e.hm instanceof Uint8Array && e.hm.length === CHUNK * CHUNK) hm.set(e.hm);
        const bm = new Uint8Array(CHUNK * CHUNK);
        if (e.bm instanceof Uint8Array && e.bm.length === CHUNK * CHUNK) bm.set(e.bm);
        const rec = { d: d, mt: mt, hm: hm, bm: bm, wt: new Uint8Array(256),
                      terrain: true, feat: true, dirty: true };
        this.cdata.set(cKey(cx, cz), rec);
        n++;
      }
      this.silent = wasSilent;
      this.flowCountKnown = false;
      return n;
    }

    // 换种子/客人对齐房主：清空一切数据与网格
    resetWorld(seed) {
      if (seed != null) this.seed = seed >>> 0;
      for (const rec of this.chunks.values()) this.disposeChunkMeshes(rec);
      this.chunks.clear();
      this.cdata.clear();
      this._tileCenters.clear();
      this._tileBasins.clear();
      this._veinCache.clear();
      this._n = null;                 // 噪声缓存按种子绑定，换种子必须丢弃
      this._pristineWorld = null;
      this._streamQ = [];
      this._streamSet.clear();
      this._streamCenter = null;
      this._homeVolcano = null;
      this.lavaQueue.clear();
      this.flowCount = 0;
      this.flowCountKnown = false;
      if (this.dirtyBlocks) this.dirtyBlocks.clear();
    }

    // headless 用：强制生成某区块并返回其记录（联机 diff 纯净对照）
    pristineChunk(cx, cz) {
      cx = cx | 0; cz = cz | 0;
      const existing = this.cdata.get(cKey(cx, cz));
      if (existing) return existing;
      return this._genChunk(cx, cz);
    }

    /* ---------------- 地形生成（多层噪声：大陆 / 山脉 / 群系 / 洞穴） ---------------- */

    /* ============================================================
     * 无限地形：所有结果只依赖世界绝对坐标 + seed，任意区块都能独立、
     * 确定性地重建，房主/客人/重载后逐字节一致。
     *
     * 区块生成分两阶段：
     *  A. terrain：本区块 16×16 列地形 + 海水 + 3D 洞穴（无跨界依赖）
     *  B. features：矿脉（来源为本区块及 2 圈内区块的确定性游走矿脉）、
     *     树/仙人掌（评估本区块外扩 2 圈的列，跨界写入邻居）。
     *  特性写入全部是条件幂等（只替换 STONE / 只在 AIR 或 LEAVES 上长），
     *  且不写入 dirty 区块，因此生成顺序不影响最终结果。
     * ============================================================ */

    // 兼容旧启动流程：客人 welcome 改用 resetWorld + 流送，单机不再全量生成
    generate() { /* no-op：无限世界按需生成 */ }

    _N(s) {
      if (!this._n) this._n = {};
      return this._n[s] || (this._n[s] = new Noise(this.seed ^ s));
    }

    // 宏观气候牌（256×256 一块）：4×4 个抖动 Voronoi 中心，洗牌袋保证
    // 每块牌上各陆地气候都出现；火山中心在牌内钳制不被牌边截断
    _tileInfo(tx, tz) {
      const k = tx + "," + tz;
      let info = this._tileCenters.get(k);
      if (info) return info;
      const TILE = 256, CELLS = 4, cellW = TILE / CELLS;
      const rng = mulberry32(hash2i(tx, tz, this.seed ^ 0xc0ffee));
      // 洗牌袋：每块气候牌上 16 个群系中心的配额。
      // 绿色地貌（平原/橡林/桦林/竹林/樱花林）占绝大多数，沙漠/冰川各留一处，
      // 火山保留一处特色地貌
      const bag = [
        BIOME.PLAINS, BIOME.FOREST, BIOME.BIRCH_FOREST, BIOME.DESERT,
        BIOME.GLACIER, BIOME.VOLCANO,
        BIOME.PLAINS, BIOME.FOREST, BIOME.BIRCH_FOREST, BIOME.FOREST,
        BIOME.CHERRY, BIOME.FOREST, BIOME.CHERRY,
        BIOME.PLAINS, BIOME.BAMBOO, BIOME.BAMBOO
      ];
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const t = bag[i]; bag[i] = bag[j]; bag[j] = t;
      }
      const centers = [];
      let bi = 0;
      const x0 = tx * TILE, z0 = tz * TILE;
      for (let gx = 0; gx < CELLS; gx++) {
        for (let gz = 0; gz < CELLS; gz++) {
          const b = bag[bi++];
          let cx = x0 + (gx + 0.5) * cellW + (rng() * 2 - 1) * cellW * 0.3;
          let cz = z0 + (gz + 0.5) * cellW + (rng() * 2 - 1) * cellW * 0.3;
          if (b === BIOME.VOLCANO) {
            cx = Math.max(x0 + 32, Math.min(x0 + TILE - 32, cx));
            cz = Math.max(z0 + 32, Math.min(z0 + TILE - 32, cz));
          }
          centers.push({ x: cx, z: cz, b: b });
        }
      }
      // 每块牌 1~2 个海盆（40% 概率两个），位置/规模确定性
      const brng = mulberry32(hash2i(tx, tz, this.seed ^ 0x0cea11));
      const basins = [];
      const basinCount = brng() < 0.4 ? 2 : 1;
      for (let k2 = 0; k2 < basinCount; k2++) {
        basins.push({
          x: x0 + 36 + brng() * (TILE - 72),
          z: z0 + 36 + brng() * (TILE - 72),
          r: 46 + brng() * 16,
          d: 0.54 + brng() * 0.06
        });
      }
      info = { centers: centers, basins: basins };
      this._tileCenters.set(k, info);
      this._tileBasins.set(k, basins);
      return info;
    }

    // 离给定点最近的火山气候中心（在其周围 ring 圈气候牌内找），找不到 null
    findVolcano(wx, wz, ring) {
      ring = ring || 2;
      const gx = Math.floor(Math.floor(wx / 64) / 4);
      const gz = Math.floor(Math.floor(wz / 64) / 4);
      let best = null, bd = Infinity;
      for (let tx = gx - ring; tx <= gx + ring; tx++) {
        for (let tz = gz - ring; tz <= gz + ring; tz++) {
          for (const c of this._tileInfo(tx, tz).centers) {
            if (c.b !== BIOME.VOLCANO) continue;
            const dd = (c.x - wx) * (c.x - wx) + (c.z - wz) * (c.z - wz);
            if (dd < bd) { bd = dd; best = c; }
          }
        }
      }
      return best;
    }

    // 单列地貌计算（与旧有限世界公式逐行一致，只是气候中心/海盆改为无限牌扫描）
    _composeColumn(x, z) {
      const SEA = this.SEA;
      const warpNoiseX = this._N(0xa51a1);
      const warpNoiseZ = this._N(0x7e57da);
      const contNoise = this._N(0x1234abcd);
      const heightNoise = this._N(this.seed | 0);
      const detailNoise = this._N(0x9e3779b9);
      const maskNoiseA = this._N(0x33aaff);
      const maskNoiseB = this._N(0x77ccdd);
      const ridgeNoise = this._N(0x5151a7);

      const gx = Math.floor(Math.floor(x / 64) / 4);
      const gz = Math.floor(Math.floor(z / 64) / 4);
      const wx = x + (warpNoiseX.fbm(x * 0.012, z * 0.012, 3) - 0.5) * 48;
      const wz = z + (warpNoiseZ.fbm(x * 0.012 + 317.3, z * 0.012 + 317.3, 3) - 0.5) * 48;
      let region = null, bd = Infinity;
      for (let tx = gx - 1; tx <= gx + 1; tx++) {
        for (let tz = gz - 1; tz <= gz + 1; tz++) {
          for (const c of this._tileInfo(tx, tz).centers) {
            const ddx = wx - c.x, ddz = wz - c.z;
            const dd = ddx * ddx + ddz * ddz;
            if (dd < bd) { bd = dd; region = c; }
          }
        }
      }
      const cover = region.b;

      const clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;
      const smoothstep = (a, b, v) => {
        const t = clamp01((v - a) / (b - a));
        return t * t * (3 - 2 * t);
      };

      let cont = contNoise.fbm(x * 0.0076, z * 0.0076, 4);
      let basinF = 0, basinD = 0;
      for (let tx = gx - 1; tx <= gx + 1; tx++) {
        for (let tz = gz - 1; tz <= gz + 1; tz++) {
          for (const bq of this._tileInfo(tx, tz).basins) {
            const bdx = x - bq.x, bdz = z - bq.z;
            const f = 1 - smoothstep(0.35, 1, Math.sqrt(bdx * bdx + bdz * bdz) / bq.r);
            if (f > basinF) { basinF = f; basinD = bq.d; }
          }
        }
      }
      cont = clamp01(cont - basinF * basinD);
      const e = heightNoise.fbm(x * 0.03, z * 0.03, 3, 2, 0.5);
      const m = detailNoise.fbm(x * 0.085 + 100, z * 0.085 + 100, 2);
      const mm = Math.max(
        maskNoiseA.fbm(x * 0.0065 + 31.7, z * 0.0065 + 11.3, 3),
        maskNoiseB.fbm(x * 0.0135 - 70.2, z * 0.0135 + 90.4, 2) * 0.97
      ) * (1 - basinF * 0.92);
      // 山脉门槛抬高：mm 需更强才隆起高山，和缓平原/森林的面积更大；
      // 越过门槛后仍可拔高成尖锐山脊（绿色山林丘陵，而非整片石山坡）
      const mf = smoothstep(0.55, 0.79, mm);
      const ridge = ridgeNoise.ridged(x * 0.0165, z * 0.0165, 4);

      const VCONE_R = 26, VCONE_H = 25;
      const SNOW_LINE = 30, ROCK_LINE = 23, PEAK_LINE = 34;
      let h;
      let top = BLOCK.GRASS, sub = BLOCK.DIRT, subN = 3;
      let frozen = false, lavaChannel = false, craterLava = 0;
      let biome;

      if (cover === BIOME.VOLCANO) {
        const base = SEA + 1 + Math.floor(e * 3);
        const rdx = x - region.x, rdz = z - region.z;
        const r = Math.sqrt(rdx * rdx + rdz * rdz);
        h = base;
        if (r < VCONE_R) {
          const cone = Math.floor(VCONE_H * Math.pow(1 - r / VCONE_R, 1.4));
          h = Math.max(base, SEA + cone);
        }
        top = BLOCK.BASALT; sub = BLOCK.BASALT; subN = 3;
        if (r < 2.3) {
          h = Math.max(base, h - 7);
          craterLava = 1;
        } else if (r >= 5 && r <= 20) {
          const onX = Math.abs(rdz) < 0.6 && Math.abs(rdx) > 3;
          const onZ = Math.abs(rdx) < 0.6 && Math.abs(rdz) > 3;
          if (onX || onZ) lavaChannel = true;
        }
        biome = BIOME.VOLCANO;
      } else if (cover === BIOME.GLACIER) {
        h = SEA - 2 + Math.floor(e * e * 26 + m * 3);
        if (h < SEA) {
          top = BLOCK.SAND; sub = BLOCK.SANDSTONE; subN = 1;
          frozen = true;
        } else if (h === SEA) {
          h = SEA; top = BLOCK.ICE; sub = BLOCK.SNOW; subN = 1;
        } else if (h === SEA + 1) {
          top = BLOCK.ICE; sub = BLOCK.SNOW; subN = 1;
        } else {
          top = BLOCK.SNOW; sub = BLOCK.SNOW; subN = 2;
        }
        biome = BIOME.GLACIER;
      } else {
        if (cont < 0.32) {
          h = 3 + Math.floor(cont / 0.32 * 4);
        } else if (cont < 0.42) {
          h = 7 + Math.floor((cont - 0.32) / 0.10 * 4);
        } else if (cont < 0.465) {
          h = 11 + Math.floor((cont - 0.42) / 0.045 * 3);
        } else {
          const t = (cont - 0.465) / 0.535;
          h = SEA + 1 + Math.floor(t * 6 + (e - 0.5) * 5);
          if (cover === BIOME.PLAINS && mf < 0.22) {
            // 平原：低而开阔（山脉门槛抬高后平坦化范围同步放宽，平原更辽阔）
            h = SEA + 2 + Math.floor(e * 3);
          } else if (cover === BIOME.DESERT) {
            h += Math.floor((m - 0.5) * 6);
          }
        }
        if (mf > 0.12) {
          const rr = Math.pow(ridge, 1.6);
          const base = h >= SEA - 1 ? h : SEA - 1;
          h = base + Math.floor(mf * (8 + rr * 27) + mf * (e - 0.5) * 5);
        }

        if (h <= 6) {
          biome = BIOME.DEEP_OCEAN;
          top = BLOCK.STONE; sub = BLOCK.STONE; subN = 2;
        } else if (h < SEA) {
          biome = BIOME.OCEAN;
          top = BLOCK.SAND; sub = BLOCK.SANDSTONE; subN = 2;
        } else if (h >= PEAK_LINE) {
          biome = BIOME.PEAKS;
          top = BLOCK.SNOW; sub = BLOCK.SNOW; subN = 2;
        } else if (h >= ROCK_LINE) {
          biome = BIOME.MOUNTAINS;
          // 山体也要覆盖植被：草皮 + 泥土表壳，石头只藏在泥土下面
          // （只有洞穴/陡峭岩壁截面才会裸露出石头、煤矿与铁矿）；
          // 雪线以上的尖峰才积雪
          if (h >= SNOW_LINE && m > 0.58) {
            top = BLOCK.SNOW; sub = BLOCK.SNOW; subN = 2;
          } else {
            top = BLOCK.GRASS; sub = BLOCK.DIRT; subN = 3;
          }
        } else {
          biome = cover;
          if (cover === BIOME.DESERT) {
            top = BLOCK.SAND; sub = BLOCK.SANDSTONE;
          } else if (h <= SEA + 1) {
            top = BLOCK.SAND; sub = BLOCK.SANDSTONE; subN = 2;
          }
        }
      }

      if (h > this.H - 5) h = this.H - 5;
      if (h < 1) h = 1;
      return { h: h, top: top, sub: sub, subN: subN, frozen: frozen,
               lavaChannel: lavaChannel, craterLava: craterLava, biome: biome };
    }

    // 阶段 A：地形列 + 海水/冰 + 洞穴（纯本区块数据，无跨界读写）
    _genTerrain(cx, cz, rec) {
      const H = this.H, SEA = this.SEA;
      const x0 = cx * CHUNK, z0 = cz * CHUNK;
      const tunnelA = this._N(0xca11e1);
      const tunnelB = this._N(0xca11e2);
      const roomNoise = this._N(0xca11e3);
      const waterNoise = this._N(0x1a2b3c);
      const T_TUBE_A = 0.68, T_TUBE_B = 0.71, T_ROOM = 0.72;

      for (let lz = 0; lz < CHUNK; lz++) {
        for (let lx = 0; lx < CHUNK; lx++) {
          const x = x0 + lx, z = z0 + lz;
          const col = this._composeColumn(x, z);
          const h = col.h;
          const ci = lz * CHUNK + lx;
          rec.hm[ci] = h;
          rec.bm[ci] = col.biome;
          if (h >= SEA) rec.wt[ci] = 10 + Math.floor(waterNoise.fbm(x * 0.05, z * 0.05, 2) * 3);

          for (let y = 0; y <= h; y++) {
            let id;
            if (y === 0) id = BLOCK.BEDROCK;
            else if (y === h) id = col.top;
            else if (y >= h - col.subN) id = col.sub;
            else id = BLOCK.STONE;
            rec.d[(y * CHUNK + lz) * CHUNK + lx] = id;
          }
          if (col.lavaChannel) rec.d[(h * CHUNK + lz) * CHUNK + lx] = BLOCK.LAVA;
          if (col.craterLava > 0 && h + col.craterLava < H) {
            rec.d[((h + col.craterLava) * CHUNK + lz) * CHUNK + lx] = BLOCK.LAVA;
          }
          if (h < SEA) {
            if (col.frozen) {
              for (let y = h + 1; y < SEA; y++) rec.d[(y * CHUNK + lz) * CHUNK + lx] = BLOCK.WATER;
              rec.d[(SEA * CHUNK + lz) * CHUNK + lx] = BLOCK.ICE;
            } else {
              for (let y = h + 1; y <= SEA; y++) rec.d[(y * CHUNK + lz) * CHUNK + lx] = BLOCK.WATER;
            }
          }

          // —— 洞穴雕刻（海床不挖；草山与平原留 2 格顶盖保住草皮/泥土表壳，
          //    只有雪峰可开到 h-1；洞壁仍会裸露石头、煤矿、铁矿）——
          if (h < SEA) continue;
          const topY = col.biome === BIOME.PEAKS ? h - 1 : h - 2;
          const wt = rec.wt[ci];
          for (let y = 2; y <= topY; y++) {
            const idx = (y * CHUNK + lz) * CHUNK + lx;
            const id = rec.d[idx];
            if (id !== BLOCK.STONE && id !== BLOCK.DIRT && id !== BLOCK.SANDSTONE) continue;
            const a = tunnelA.fbm3(x * 0.085, y * 0.12, z * 0.085, 3);
            let hollow = a > T_TUBE_A;
            let isRoom = false;
            if (!hollow) {
              const b = tunnelB.fbm3(x * 0.085 + 31.4, y * 0.12 - 17.9, z * 0.085 + 8.1, 3);
              hollow = b > T_TUBE_B;
            }
            if (!hollow) {
              const c = roomNoise.fbm3(x * 0.046, y * 0.078, z * 0.046, 4);
              if (c > T_ROOM) { hollow = true; isRoom = true; }
            }
            if (!hollow) continue;
            if (y <= 2 && isRoom) rec.d[idx] = BLOCK.LAVA;
            else if (isRoom && wt && y <= wt) rec.d[idx] = BLOCK.WATER;
            else rec.d[idx] = BLOCK.AIR;
          }
        }
      }
      rec.terrain = true;
    }

    // 某区块的确定性矿脉清单（旧密度：煤 260/256区块 ≈1.02/区块，铁 110/256≈0.43/区块）
    // 每条矿脉是一串世界绝对坐标；来源区块的矿脉可游走进邻居，故应用时扫 2 圈
    _chunkVeins(scx, scz) {
      const k = scx + "," + scz;
      let list = this._veinCache.get(k);
      if (list) return list;
      const rng = mulberry32(hash2i(scx, scz, this.seed ^ 0x04e5));
      const defs = [
        { id: BLOCK.COAL_ORE, density: 260 / 256, minY: 3, maxY: this.SEA - 1, sMin: 4, sMax: 9 },
        { id: BLOCK.IRON_ORE, density: 110 / 256, minY: 2, maxY: 9, sMin: 3, sMax: 6 }
      ];
      for (const o of GameRegistry.ores) {
        defs.push({ id: o.block, density: o.count / 256, minY: o.minY, maxY: o.maxY,
                    sMin: o.sizeMin, sMax: o.sizeMax });
      }
      const dirs = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
      list = [];
      for (const df of defs) {
        const n = Math.floor(df.density + rng());
        for (let i = 0; i < n; i++) {
          let vx = scx * CHUNK + Math.floor(rng() * CHUNK);
          let vz = scz * CHUNK + Math.floor(rng() * CHUNK);
          let vy = df.minY + Math.floor(rng() * (df.maxY - df.minY + 1));
          const len = df.sMin + Math.floor(rng() * (df.sMax - df.sMin + 1));
          const cells = [];
          for (let s = 0; s < len; s++) {
            cells.push([vx, vy, vz]);
            const d = dirs[Math.floor(rng() * 6)];
            vx += d[0]; vy += d[1]; vz += d[2];
            if (vy < 1) vy = 1; if (vy > this.H - 2) vy = this.H - 2;
          }
          list.push({ id: df.id, cells: cells });
        }
      }
      this._veinCache.set(k, list);
      return list;
    }

    // 阶段 B：矿脉 + 树 + 仙人掌
    _genFeatures(cx, cz, rec) {
      const x0 = cx * CHUNK, z0 = cz * CHUNK;
      const wasSilent = this.silent;
      this.silent = true;
      try {
        // —— 矿脉：扫来源 2 圈（游走最长 9 格，最远落进 2 圈邻居）——
        for (let scx = cx - 2; scx <= cx + 2; scx++) {
          for (let scz = cz - 2; scz <= cz + 2; scz++) {
            for (const vein of this._chunkVeins(scx, scz)) {
              for (const [vx, vy, vz] of vein.cells) {
                if (vx < x0 || vx >= x0 + CHUNK || vz < z0 || vz >= z0 + CHUNK) continue;
                if (rec.dirty) continue;
                const idx = (vy * CHUNK + (vz - z0)) * CHUNK + (vx - x0);
                if (rec.d[idx] === BLOCK.STONE) rec.d[idx] = vein.id;
              }
            }
          }
        }

        // —— 树 / 仙人掌：评估外扩 5 列（樱花树冠半径 5），跨界写入对应区块 ——
        // 该圈区块只需地形阶段（_ensureTerrain 不会级联跑特性，无递归）；
        // 5 列仍落在紧邻一圈区块内，3×3 地形环即可覆盖
        for (let tx = cx - 1; tx <= cx + 1; tx++) {
          for (let tz = cz - 1; tz <= cz + 1; tz++) this._ensureTerrain(tx, tz);
        }
        for (let x = x0 - 5; x <= x0 + CHUNK + 4; x++) {
          for (let z = z0 - 5; z <= z0 + CHUNK + 4; z++) {
            const ocx = x >> 4, ocz = z >> 4, lx = x & 15, lz = z & 15;
            const tRec = this.cdata.get(cKey(ocx, ocz));
            if (!tRec) continue;
            const bi = tRec.bm[lz * CHUNK + lx];
            const h = tRec.hm[lz * CHUNK + lx];
            const topId = tRec.d[(h * CHUNK + lz) * CHUNK + lx];
            // 仙人掌（沙漠沙地，约 0.6% 列，1~3 格高）
            if (bi === BIOME.DESERT && h > this.SEA + 1 && topId === BLOCK.SAND) {
              const r = mulberry32(hash2i(x, z, this.seed ^ 0xca17ca));
              if (r() < 0.006) {
                const n = 1 + Math.floor(r() * 3);
                for (let i = 0; i < n; i++) this._featPut(x, h + 1 + i, z, BLOCK.CACTUS, "air");
              }
              continue;
            }
            // 竹林：约 13% 列长出 4~7 格高细竹竿（成片），另有约 5% 列是竹笋
            if (bi === BIOME.BAMBOO) {
              if (h > this.SEA + 1 && topId === BLOCK.GRASS && window.BambooMod) {
                const br = mulberry32(hash2i(x, z, this.seed ^ 0x5ab00));
                const roll = br();
                if (roll < 0.13) {
                  const n = 4 + Math.floor(br() * 4);
                  for (let i = 0; i < n; i++) {
                    this._featPut(x, h + 1 + i, z, window.BambooMod.stalk, "air");
                  }
                } else if (roll < 0.18) {
                  this._featPut(x, h + 1, z, window.BambooMod.shoot, "air");
                }
              }
              continue;
            }
            // 樱花林：约 3% 列长出粗短树干 + 多层宽冠的樱花树
            if (bi === BIOME.CHERRY) {
              if (h > this.SEA + 1 && topId === BLOCK.GRASS && window.CherryMod) {
                const cr = mulberry32(hash2i(x, z, this.seed ^ 0xc4e77));
                if (cr() < 0.03) this._featCherry(x, h + 1, z, cr);
              }
              continue;
            }
            // 桦林 5% / 橡林 5.5% / 平原 0.35%
            let chance = 0, birch = false;
            if (bi === BIOME.BIRCH_FOREST) { chance = 0.05; birch = true; }
            else if (bi === BIOME.FOREST) chance = 0.055;
            else if (bi === BIOME.PLAINS) chance = 0.0035;
            else if (bi === BIOME.MOUNTAINS) chance = 0.008;  // 草山上的稀疏山林
            else continue;
            if (h <= this.SEA + 1 || topId !== BLOCK.GRASS) continue;
            const rng = mulberry32(hash2i(x, z, this.seed ^ 0x55aa55));
            if (rng() >= chance) continue;
            if (birch) this._featBirch(x, h + 1, z, rng);
            else this._featTree(x, h + 1, z, rng);
          }
        }
      } finally {
        this.silent = wasSilent;
        rec.feat = true;
      }
    }

    // 特性写入：按世界坐标定位区块；dirty 区块（玩家改动/存档恢复）一律不写，
    // mode: stone=只替换石头（矿）；air=只填空气（叶/仙人掌）；log=空气或树叶（树干）
    _featPut(x, y, z, id, mode) {
      if (y < 0 || y >= this.H) return;
      const cx = x >> 4, cz = z >> 4, lx = x & 15, lz = z & 15;
      const rec = this.cdata.get(cKey(cx, cz));
      if (!rec || rec.dirty) return;
      const i = (y * CHUNK + lz) * CHUNK + lx;
      const v = rec.d[i];
      if (mode === "stone") { if (v === BLOCK.STONE) rec.d[i] = id; }
      else if (mode === "log") { if (v === BLOCK.AIR || v === BLOCK.LEAVES) rec.d[i] = id; }
      else { if (v === BLOCK.AIR) rec.d[i] = id; }
    }

    _featTree(x, y, z, rng) {
      const trunk = 4 + Math.floor(rng() * 2);
      for (let i = 0; i < trunk; i++) this._featPut(x, y + i, z, BLOCK.LOG, "log");
      const top = y + trunk;
      for (let ly = -2; ly <= 1; ly++) {
        const r = ly >= 1 ? 1 : 2;
        const cy = top + ly;
        for (let dx = -r; dx <= r; dx++) {
          for (let dz = -r; dz <= r; dz++) {
            if (r === 2 && Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
            if (dx === 0 && dz === 0 && ly <= 0) continue;
            this._featPut(x + dx, cy, z + dz, BLOCK.LEAVES, "air");
          }
        }
      }
    }

    _featBirch(x, y, z, rng) {
      const trunk = 5 + Math.floor(rng() * 3);
      for (let i = 0; i < trunk; i++) this._featPut(x, y + i, z, BLOCK.BIRCH_LOG, "log");
      const top = y + trunk;
      const radii = [2, 2, 1, 0];
      for (let li = 0; li < radii.length; li++) {
        const ly = li - 3;
        const r = radii[li];
        const cy = top + ly;
        for (let dx = -r; dx <= r; dx++) {
          for (let dz = -r; dz <= r; dz++) {
            if (r === 2 && Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
            if (dx === 0 && dz === 0 && ly < 0) continue;
            this._featPut(x + dx, cy, z + dz, BLOCK.LEAVES, "air");
          }
        }
      }
    }

    // 樱花树：4~5 格粗短深粉树干 + 顶部 2~3 根横向分叉枝，
    // 上方覆盖 5 层阶梯圆盘状宽粉冠（半径最大 5），外沿随机缺口形成蓬松轮廓
    _featCherry(x, y, z, rng) {
      const LOG = window.CherryMod.log, LEAF = window.CherryMod.leaves;
      const trunk = 4 + Math.floor(rng() * 2);
      for (let i = 0; i < trunk; i++) this._featPut(x, y + i, z, LOG, "log");
      // 横向分叉枝：顶两层向 2~3 个水平方向平伸 1~2 格
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (let i = dirs.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const t = dirs[i]; dirs[i] = dirs[j]; dirs[j] = t;
      }
      const arms = 2 + Math.floor(rng() * 2);
      for (let a = 0; a < arms; a++) {
        const d = dirs[a], len = 1 + Math.floor(rng() * 2);
        const ay = y + trunk - 1 - (a % 2);
        for (let i = 1; i <= len; i++) this._featPut(x + d[0] * i, ay, z + d[1] * i, LOG, "log");
      }
      // 多层宽冠（相对树干顶端的层偏移 + 圆盘半径）
      const top = y + trunk;
      const layers = [[-1, 3], [0, 5], [1, 5], [2, 4], [3, 2]];
      for (const layer of layers) {
        const ly = layer[0], r = layer[1], cy = top + ly;
        const inner = (r - 1) * (r - 1);
        for (let dx = -r; dx <= r; dx++) {
          for (let dz = -r; dz <= r; dz++) {
            const d2 = dx * dx + dz * dz;
            if (d2 > r * r + 1) continue;
            // 外沿一圈随机镂空，形成参考图那种参差蓬松的冠缘
            if (d2 >= inner && rng() < 0.25) continue;
            // 顶层以下中轴留给树干/横枝
            if (dx === 0 && dz === 0 && ly <= 0) continue;
            this._featPut(x + dx, cy, z + dz, LEAF, "air");
          }
        }
      }
    }

    // 确保区块完成地形阶段（不跑特性）；递归只到地形层，必然终止
    _ensureTerrain(cx, cz) {
      let rec = this.cdata.get(cKey(cx, cz));
      if (rec) {
        if (!rec.terrain) this._genTerrain(cx, cz, rec);
        return rec;
      }
      rec = { d: new Uint8Array(this.CH), mt: new Uint8Array(this.CH),
              hm: new Uint8Array(CHUNK * CHUNK),
              bm: new Uint8Array(CHUNK * CHUNK), wt: new Uint8Array(CHUNK * CHUNK),
              terrain: false, feat: false, dirty: false };
      this.cdata.set(cKey(cx, cz), rec);   // 先入表，阻断级联递归
      this._genTerrain(cx, cz, rec);
      return rec;
    }

    // 生成一个完整区块（地形 + 特性）并返回记录
    _genChunk(cx, cz) {
      const rec = this._ensureTerrain(cx, cz);
      if (!rec.feat) this._genFeatures(cx, cz, rec);
      return rec;
    }

    /* ---------------- 出生点 / 初始载入 ---------------- */

    // 生成原点周围小数据环后，找一个安全的草地出生点（Vector3）；
    // findSpawn 找不到时会自行扩大数据环
    prepareSpawn() {
      this.ensureDataRing(0, 0, 2);
      return this.findSpawn();
    }

    // 找一个安全的草地出生点：优先平原，其次橡树林 / 桦木林，最后任意草地。
    // 从原点 (0,0) 螺旋外扩；找不到就扩大数据环继续找
    findSpawn() {
      const cx = 0, cz = 0;
      let forestFallback = null, fallback = null;
      for (let ring = 0; ring < 8; ring++) {
        const rMax = 8 + ring * 16;
        const r0 = ring === 0 ? 0 : rMax - 16 + 1;
        if (ring > 0) this.ensureDataRing(0, 0, Math.ceil(rMax / CHUNK) + 1);
        for (let r = r0; r <= rMax; r++) {
          for (let dx = -r; dx <= r; dx++) {
            for (let dz = -r; dz <= r; dz++) {
              if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
              const x = cx + dx, z = cz + dz;
              const h = this.heightAt(x, z);
              // 草地、远离水面，且头顶两格无树叶等障碍
              if (h > this.SEA + 1 && this.getBlock(x, h, z) === BLOCK.GRASS &&
                  this.getBlock(x, h + 1, z) === BLOCK.AIR &&
                  this.getBlock(x, h + 2, z) === BLOCK.AIR) {
                const v = new THREE.Vector3(x + 0.5, h + 1, z + 0.5);
                const b = this.biomeAt(x, z);
                if (b === BIOME.PLAINS) return v;
                if (!forestFallback && (b === BIOME.FOREST || b === BIOME.BIRCH_FOREST)) {
                  forestFallback = v;
                }
                if (!fallback) fallback = v;
              }
            }
          }
        }
        if (forestFallback) return forestFallback;
        if (fallback) return fallback;
      }
      return new THREE.Vector3(cx + 0.5, 30, cz + 0.5);
    }

    // 同步生成 (wx,wz) 周围 r 圈区块的全部数据（地形+特性），由近及远
    ensureDataRing(wx, wz, r) {
      const pcx = Math.floor(wx / CHUNK), pcz = Math.floor(wz / CHUNK);
      for (let ring = 0; ring <= r; ring++) {
        for (let dx = -ring; dx <= ring; dx++) {
          for (let dz = -ring; dz <= ring; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
            this._genChunk(pcx + dx, pcz + dz);
          }
        }
      }
    }

    // 传送/突发情况：同步补齐脚下数据（2 圈）与网格（1 圈），避免踩空
    loadAreaNow(wx, wz) {
      const pcx = Math.floor(wx / CHUNK), pcz = Math.floor(wz / CHUNK);
      this.ensureDataRing(wx, wz, 2);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) this.buildChunk(pcx + dx, pcz + dz);
      }
    }

    // 启动/客人加入：分批构建出生点周围 r 圈网格，进度回调，全部完成回调
    initialBuild(wx, wz, r, batch, onProgress, onDone) {
      const pcx = Math.floor(wx / CHUNK), pcz = Math.floor(wz / CHUNK);
      this.ensureDataRing(wx, wz, r + 1);
      const list = [];
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          const ring = Math.max(Math.abs(dx), Math.abs(dz));
          list.push([pcx + dx, pcz + dz, ring]);
        }
      }
      list.sort((a, b) => (a[2] - b[2]) || ((a[0] + a[1]) - (b[0] + b[1])));
      const total = list.length;
      let i = 0;
      const self = this;
      function step() {
        const end = Math.min(i + batch, list.length);
        for (; i < end; i++) {
          const cc = list[i];
          if (!self.chunks.has(cKey(cc[0], cc[1]))) self.buildChunk(cc[0], cc[1]);
        }
        if (onProgress) onProgress(i, total);
        if (i < list.length) setTimeout(step, 0);
        else if (onDone) onDone();
      }
      setTimeout(step, 0);
    }

    /* ---------------- 区块流送（每帧调用，预算毫秒内完成） ---------------- */

    // 以玩家所在区块为中心：补数据（DATA_R 环）→ 建网格（MESH_R 环）→
    // 卸载过远网格与纯净数据（dirty 数据永不卸载，等存档落盘）
    updateStreaming(wx, wz, budgetMs) {
      const t0 = performance.now();
      const pcx = wx >> 4, pcz = wz >> 4;   // 负坐标必须用 >>4（向负无穷取整）

      // 1) 数据环：由近及远逐圈生成
      for (let ring = 0; ring <= this.DATA_R; ring++) {
        for (let dx = -ring; dx <= ring; dx++) {
          for (let dz = -ring; dz <= ring; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
            const cx = pcx + dx, cz = pcz + dz;
            if (!this.cdata.has(cKey(cx, cz))) {
              this._genChunk(cx, cz);
              if (performance.now() - t0 >= budgetMs) break;
            }
          }
          if (performance.now() - t0 >= budgetMs) break;
        }
        if (performance.now() - t0 >= budgetMs) break;
      }

      // 2) 网格环：本块与 8 邻居数据齐备才建（保证面剔除/AO 正确）
      for (let ring = 0; ring <= this.MESH_R; ring++) {
        for (let dx = -ring; dx <= ring; dx++) {
          for (let dz = -ring; dz <= ring; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
            const cx = pcx + dx, cz = pcz + dz;
            if (this.chunks.has(cKey(cx, cz))) continue;
            if (!this._neighborsReady(cx, cz)) continue;
            this.buildChunk(cx, cz);
            if (performance.now() - t0 >= budgetMs) return;
          }
        }
      }

      // 3) 卸载：网格离中心 > MESH_R+1；数据离中心 > DATA_R+1 且非 dirty
      for (const [k, rec] of this.chunks) {
        const p = k.indexOf(",");
        const cx = +k.slice(0, p), cz = +k.slice(p + 1);
        if (Math.max(Math.abs(cx - pcx), Math.abs(cz - pcz)) > this.MESH_R + 1) {
          this.disposeChunkMeshes(rec);
          this.chunks.delete(k);
        }
      }
      for (const [k, rec] of this.cdata) {
        const p = k.indexOf(",");
        const cx = +k.slice(0, p), cz = +k.slice(p + 1);
        if (Math.max(Math.abs(cx - pcx), Math.abs(cz - pcz)) > this.DATA_R + 1 && !rec.dirty) {
          const meshRec = this.chunks.get(k);
          if (meshRec) { this.disposeChunkMeshes(meshRec); this.chunks.delete(k); }
          this.cdata.delete(k);
        }
      }
    }

    _neighborsReady(cx, cz) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (!this.cdata.has(cKey(cx + dx, cz + dz))) return false;
        }
      }
      return true;
    }

    // 遍历已生成区块（调试/火山灯扫描用），回调 (rec,cx,cz)
    forEachLoadedChunk(cb) {
      for (const [k, rec] of this.cdata) {
        const p = k.indexOf(",");
        cb(rec, +k.slice(0, p), +k.slice(p + 1));
      }
    }

    // 计算某面第 k 个顶点的烘焙亮度 = 面明暗 × 环境光遮蔽
    vertexBrightness(x, y, z, f, k) {
      const face = FACES[f];
      const pp = face.p[k];
      const [a1, a2] = f < 2 ? [1, 2] : f < 4 ? [0, 2] : [0, 1];
      const v = [x + pp[0], y + pp[1], z + pp[2]];
      const n = face.dir;
      const o1 = n.slice(), o2 = n.slice(), oc = n.slice();
      o1[a1] += pp[a1] === 1 ? 1 : -1;
      o2[a2] += pp[a2] === 1 ? 1 : -1;
      oc[a1] += pp[a1] === 1 ? 1 : -1;
      oc[a2] += pp[a2] === 1 ? 1 : -1;
      const s1 = isOpaque(this.getBlock(v[0] + o1[0], v[1] + o1[1], v[2] + o1[2])) ? 1 : 0;
      const s2 = isOpaque(this.getBlock(v[0] + o2[0], v[1] + o2[1], v[2] + o2[2])) ? 1 : 0;
      const cc = isOpaque(this.getBlock(v[0] + oc[0], v[1] + oc[1], v[2] + oc[2])) ? 1 : 0;
      const level = (s1 && s2) ? 0 : 3 - (s1 + s2 + cc);
      return FACE_SHADE[f] * AO_LEVELS[level];
    }

    /* ---------------- 区块网格 ---------------- */

    // 修改方块后重建：本区块 + 跨边界相邻区块（邻居未生成时先补数据再建网）
    remeshAround(x, z) {
      x = Math.floor(x); z = Math.floor(z);
      const cx = x >> 4, cz = z >> 4;
      this.buildChunk(cx, cz);
      const lx = x & 15, lz = z & 15;
      const want = [];
      if (lx === 0) want.push([cx - 1, cz]);
      if (lx === CHUNK - 1) want.push([cx + 1, cz]);
      if (lz === 0) want.push([cx, cz - 1]);
      if (lz === CHUNK - 1) want.push([cx, cz + 1]);
      for (const [nx, nz] of want) {
        if (!this.cdata.has(cKey(nx, nz))) continue;   // 未载入的邻居无需建网
        this.buildChunk(nx, nz);
      }
    }

    disposeChunkMeshes(rec) {
      if (!rec) return;
      this.scene.remove(rec.opaque);
      this.scene.remove(rec.transparent);
      if (rec.lava) this.scene.remove(rec.lava);
      if (rec.torch) this.scene.remove(rec.torch);
      if (rec.grass) this.scene.remove(rec.grass);
      if (rec.unlit) this.scene.remove(rec.unlit);
      rec.opaque.geometry.dispose();
      rec.transparent.geometry.dispose();
      if (rec.lava) rec.lava.geometry.dispose();
      if (rec.torch) rec.torch.geometry.dispose();
      if (rec.grass) rec.grass.geometry.dispose();
      if (rec.unlit) rec.unlit.geometry.dispose();
    }

    // 岩浆格的液面视觉高度：源头/下落柱满格，其余按距源头的档位降低
    lavaHeightAt(x, y, z, id) {
      if (id == null) id = this.getBlock(x, y, z);
      if (id === BLOCK.LAVA) return 1;
      if (this.getBlock(x, y - 1, z) === BLOCK.AIR) return 1;  // 正在下坠的岩浆柱
      return Math.max(0.25, 1 - (id - BLOCK.FLOW_LAVA + 1) * 0.125);
    }

    buildChunk(cx, cz) {
      const key = cx + "," + cz;
      const rec = this.cdata.get(key);
      if (!rec || !rec.terrain) return;        // 无数据不建网
      this.disposeChunkMeshes(this.chunks.get(key));

      // 不透明几何 / 透明(水)几何 / 岩浆几何 / 火把几何 / 小草几何 / 自发光几何；C/TC = 烘焙的顶点色（明暗+AO）
      const P = [], N = [], U = [], C = [], I = [];
      const TP = [], TN = [], TU = [], TC = [], TI = [];
      const LP = [], LN = [], LU = [], LC = [], LI = [];
      const GP = [], GC = [], GI = [];
      const BP = [], BN = [], BU = [], BC = [], BI = [], BS = [];
      const UP = [], UN = [], UU = [], UC = [], UI = [];

      const x0 = cx * CHUNK, z0 = cz * CHUNK;
      const H = this.H;
      const data = rec.d;
      const mdata = rec.mt;

      for (let y = 0; y < H; y++) {
        for (let lz = 0; lz < CHUNK; lz++) {
          for (let lx = 0; lx < CHUNK; lx++) {
            const x = x0 + lx, z = z0 + lz;
            const vi = (y * CHUNK + lz) * CHUNK + lx;
            const id = data[vi];
            if (id === BLOCK.AIR) continue;
            // 火把：细棍 + 火头的特殊小盒模型，不走整方块六面
            if (id === BLOCK.TORCH) { this.pushTorch(GP, GC, GI, x, y, z); continue; }
            // Mod 自定义网格（门 / 床 / 楼梯 / 台阶 / 围栏 / 灯 / 玻璃窗等异形方块）
            const cmb = GameRegistry.customMeshes[id];
            if (cmb) {
              cmb(this.makeMeshApi(x, y, z,
                { P: P, N: N, U: U, C: C, I: I },
                { P: UP, N: UN, U: UU, C: UC, I: UI },
                { P: BP, N: BN, U: BU, C: BC, I: BI, S: BS },
                { P: GP, C: GC, I: GI }));
              continue;
            }
            // 露天草方块顶部长一丛小草（交叉面片，顶点着色器随风摆动）
            if (id === BLOCK.GRASS && y + 1 < H &&
                data[((y + 1) * CHUNK + lz) * CHUNK + lx] === BLOCK.AIR) {
              this.pushBlade(BP, BN, BU, BC, BI, BS, x, y, z);
            }
            const isWater = id === BLOCK.WATER;
            const lava = isLava(id);
            const tiles = lava ? null : BLOCK_TILES[id];
            // 液面高度：源头/下落柱满格，流动格按档位降低（侧面上沿随之下降）
            const lH = lava ? this.lavaHeightAt(x, y, z, id) : 0;

            for (let f = 0; f < 6; f++) {
              const face = FACES[f];
              const nx = x + face.dir[0], ny = y + face.dir[1], nz = z + face.dir[2];
              const nb = this.getBlock(nx, ny, nz);

              if (lava) {
                // 岩浆：对不透明邻居剔除；岩浆相邻时，侧面只在“邻居液面更低”时画
                if (isOpaque(nb)) continue;
                if (isLava(nb)) {
                  if (f === 2 || f === 3) continue;
                  if (this.lavaHeightAt(nx, ny, nz, nb) >= lH) continue;
                }
                this.pushLavaFace(LP, LN, LU, LC, LI, x, y, z, f, lH, id);
                continue;
              }

              if (isWater) {
                // 水：只对空气暴露的面
                if (nb !== BLOCK.AIR) continue;
              } else {
                // 不透明方块：邻居是不透明则剔除（邻水/空气都画）
                if (isOpaque(nb)) continue;
              }

              const tPos = isWater ? TP : P;
              const tNor = isWater ? TN : N;
              const tUv  = isWater ? TU : U;
              const tCol = isWater ? TC : C;
              const tIdx = isWater ? TI : I;

              // 水走独立滚动贴图：每面 0..1 原生 UV（随材质 offset 整体下滚）；
              // 其余方块仍取图集 UV
              const wuv = isWater ? [0, 0, 1, 1] : tileUV(faceTile(id, f, face.slot, tiles, mdata ? mdata[vi] : 0));
              const u0 = wuv[0], v0 = wuv[1], u1 = wuv[2], v1 = wuv[3];
              const base = tPos.length / 3;

              // 4 个顶点各自的烘焙亮度（水保持均匀，只做轻微面明暗）
              const b = [0, 0, 0, 0];
              for (let k = 0; k < 4; k++) {
                const pp = face.p[k];
                tPos.push(x + pp[0], y + pp[1], z + pp[2]);
                tNor.push(face.dir[0], face.dir[1], face.dir[2]);
                const uu = face.uv[k][0];
                const vv = face.uv[k][1];
                tUv.push(uu === 0 ? u0 : u1, vv === 0 ? v0 : v1);
                b[k] = isWater ? 0.96 : this.vertexBrightness(x, y, z, f, k);
                tCol.push(b[k], b[k], b[k]);
              }
              // 按对角 AO 强度选择拆分方式，避免四边形出现明暗拉伸
              if (!isWater && b[0] + b[2] > b[1] + b[3]) {
                tIdx.push(base, base + 1, base + 3, base, base + 3, base + 2);
              } else {
                tIdx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
              }
            }
          }
        }
      }

      const opaque = new THREE.Mesh(this.makeGeometry(P, N, U, C, I), this.opaqueMaterial);
      const transparent = new THREE.Mesh(this.makeGeometry(TP, TN, TU, TC, TI), this.waterMaterial);
      transparent.renderOrder = 1;
      const lavaMesh = new THREE.Mesh(this.makeGeometry(LP, LN, LU, LC, LI), this.lavaMaterial);
      this.scene.add(opaque);
      this.scene.add(transparent);
      this.scene.add(lavaMesh);
      // 本区块有火把时才建 mesh（避免 144 个空 draw call）
      let torchMesh = null;
      if (GI.length) {
        torchMesh = new THREE.Mesh(this.makeColoredGeometry(GP, GC, GI), this.torchMaterial);
        this.scene.add(torchMesh);
      }
      // 本区块有小草时才建 mesh
      let grassMesh = null;
      if (BI.length) {
        grassMesh = new THREE.Mesh(this.makeGrassGeometry(BP, BN, BU, BC, BI, BS), this.grassMaterial);
        grassMesh.renderOrder = 2;
        this.scene.add(grassMesh);
      }
      // 本区块有自发光方块（灯）时才建 mesh
      let unlitMesh = null;
      if (UI.length) {
        unlitMesh = new THREE.Mesh(this.makeGeometry(UP, UN, UU, UC, UI), this.unlitMaterial);
        this.scene.add(unlitMesh);
      }
      this.chunks.set(key, {
        opaque: opaque, transparent: transparent, lava: lavaMesh,
        torch: torchMesh, grass: grassMesh, unlit: unlitMesh
      });
    }

    // 兼容旧接口：确保某世界坐标周围数据+网格已就绪（同步，玩家脚下兜底）
    ensureChunkAt(x, z) {
      this.loadAreaNow(x, z);
    }

    // 小草：两片交叉四边形（X 形），顶点 aSway 根部 0 / 尖部 1，供风力着色器摆动
    pushBlade(P, N, U, C, I, S, x, y, z) {
      const [u0, v0, u1, v1] = tileUV(TILE.GRASS_BLADES);
      // 用草方块顶面（+y，f=3）四角的烘焙亮度（含 AO）
      const b = [0, 1, 2, 3].map(k => this.vertexBrightness(x, y, z, 3, k));
      const hgt = 0.72, inset = 0.16;
      // 两条对角线：[底a, 底b, 顶a, 顶b]（底 y，顶 y+hgt）
      const quads = [
        [[x + inset, y + 0.02, z + inset], [x + 1 - inset, y + 0.02, z + 1 - inset],
         [x + inset, y + hgt, z + inset],     [x + 1 - inset, y + hgt, z + 1 - inset]],
        [[x + 1 - inset, y + 0.02, z + inset], [x + inset, y + 0.02, z + 1 - inset],
         [x + 1 - inset, y + hgt, z + inset], [x + inset, y + hgt, z + 1 - inset]]
      ];
      for (const q of quads) {
        const base = P.length / 3;
        // 顶点顺序：底a, 底b, 顶a, 顶b；UV 下→上
        const uvk = [[u0, v0], [u1, v0], [u0, v1], [u1, v1]];
        for (let k = 0; k < 4; k++) {
          P.push(q[k][0], q[k][1], q[k][2]);
          N.push(0, 1, 0);
          U.push(uvk[k][0], uvk[k][1]);
          // 两个底角取顶面前沿亮度，简单起见四角都用同一亮度
          C.push(b[k % 4], b[k % 4], b[k % 4]);
          S.push(k < 2 ? 0 : 1);
        }
        I.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
      }
    }

    makeGrassGeometry(pos, nor, uv, col, idx, sway) {
      const g = this.makeGeometry(pos, nor, uv, col, idx);
      g.setAttribute("aSway", new THREE.Float32BufferAttribute(sway, 1));
      return g;
    }

    // 作物交叉面片：两片 X 形四边形推入透明裁切通道（aSway 恒 0，不随风摆）
    pushCutCross(cut, x, y, z, tile, hgt, inset) {
      const [u0, v0, u1, v1] = tileUV(tile);
      const b = [0, 1, 2, 3].map(k => this.vertexBrightness(x, y, z, 3, k));
      const P = cut.P, N = cut.N, U = cut.U, C = cut.C, I = cut.I, S = cut.S;
      const quads = [
        [[x + inset, y, z + inset], [x + 1 - inset, y, z + 1 - inset],
         [x + inset, y + hgt, z + inset],     [x + 1 - inset, y + hgt, z + 1 - inset]],
        [[x + 1 - inset, y, z + inset], [x + inset, y, z + 1 - inset],
         [x + 1 - inset, y + hgt, z + inset], [x + inset, y + hgt, z + 1 - inset]]
      ];
      for (const q of quads) {
        const base = P.length / 3;
        const uvk = [[u0, v0], [u1, v0], [u0, v1], [u1, v1]];
        for (let k = 0; k < 4; k++) {
          P.push(q[k][0], q[k][1], q[k][2]);
          N.push(0, 1, 0);
          U.push(uvk[k][0], uvk[k][1]);
          C.push(b[k % 4], b[k % 4], b[k % 4]);
          S.push(0);
        }
        I.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
      }
    }

    // 风的时间由主循环每帧推进
    updateWind(t) {
      this.grassUniforms.uWindTime.value = t;
    }

    // 火把模型：短棍 + 顶端双层火焰，全部用顶点色（MeshBasicMaterial 常亮）
    pushTorch(GP, GC, GI, x, y, z) {
      // 棕色短棍（底暗顶亮一点）
      this.pushColoredBox(GP, GC, GI, x + 0.42, y, z + 0.42, x + 0.58, y + 0.60, z + 0.58,
                          0.42, 0.27, 0.13, 0.55);
      // 束棍头
      this.pushColoredBox(GP, GC, GI, x + 0.40, y + 0.60, z + 0.40, x + 0.60, y + 0.68, z + 0.60,
                          0.34, 0.21, 0.10, 0.6);
      // 外焰（橙红）
      this.pushColoredBox(GP, GC, GI, x + 0.30, y + 0.66, z + 0.30, x + 0.70, y + 0.86, z + 0.70,
                          1.0, 0.45, 0.08, 0.95);
      // 内焰（亮黄）
      this.pushColoredBox(GP, GC, GI, x + 0.38, y + 0.70, z + 0.38, x + 0.62, y + 0.95, z + 0.62,
                          1.0, 0.80, 0.28, 1.0);
    }

    /* ============================================================
     * Mod 自定义网格支持（家具模组等）
     * makeMeshApi 返回给 mod 的绘制接口；pushTexBox 是通用纹理盒绘制
     * ============================================================ */

    // opq=不透明通道 unlit=自发光通道 cut=透明裁切通道 torch=纯色不受光通道
    makeMeshApi(x, y, z, opq, unlit, cut, torch) {
      const self = this;
      return {
        world: this, x: x, y: y, z: z,
        // 受光照图集纹理盒（坐标为格内相对 0..1，六面带明暗）
        // fit=true 时每个面铺满整张纹理（装饰性小零件用，避免只取到一条边）
        box: function (x0, y0, z0, x1, y1, z1, tile, fit) {
          self.pushTexBox(opq, x, y, z, x0, y0, z0, x1, y1, z1, tile, true, !!fit);
        },
        // 自发光图集纹理盒（不受场景光照，昼夜恒亮；灯用）
        unlitBox: function (x0, y0, z0, x1, y1, z1, tile, fit) {
          self.pushTexBox(unlit, x, y, z, x0, y0, z0, x1, y1, z1, tile, false, !!fit);
        },
        // 透明裁切纹理盒（alphaTest 镂空，透明像素不绘制；玻璃窗用）
        cutoutBox: function (x0, y0, z0, x1, y1, z1, tile, fit) {
          self.pushTexBox(cut, x, y, z, x0, y0, z0, x1, y1, z1, tile, true, !!fit);
        },
        // 透明裁切 X 形交叉面片（作物用）：height 株高 / inset 根部内缩
        cross: function (tile, height, inset) {
          self.pushCutCross(cut, x, y, z, tile,
            height == null ? 1 : height, inset == null ? 0.14 : inset);
        },
        // 纯色盒（不受光照；火把通道）
        glowBox: function (x0, y0, z0, x1, y1, z1, r, g, b, floor) {
          self.pushColoredBox(torch.P, torch.C, torch.I,
            x + x0, y + y0, z + z0, x + x1, y + y1, z + z1, r, g, b, floor == null ? 0.5 : floor);
        }
      };
    }

    // 通用纹理盒：8 顶点 6 面，绕序与 FACES 一致。
    // UV 默认按格内相对坐标比例取样（薄板只占 tile 的一条边，不会被拉伸）；
    // fit=true 时 UV 归一化到盒自身范围，每面铺满整张纹理（装饰小零件用）。
    // 面贴到格边界且邻居不透明 / 同 id 时剔除，避免墙体穿插与双面闪烁。
    pushTexBox(arr, x, y, z, x0, y0, z0, x1, y1, z1, tile, shade, fit) {
      const rel = [
        [x0, y0, z0], [x1, y0, z0], [x0, y1, z0], [x1, y1, z0],
        [x0, y0, z1], [x1, y0, z1], [x0, y1, z1], [x1, y1, z1]
      ];
      // 每面 4 个角点在 rel 中的索引（与 pushColoredBox 的 faceVerts 一致）
      const faceVerts = [
        [2, 0, 6, 4], // -x
        [7, 5, 3, 1], // +x
        [5, 4, 1, 0], // -y
        [6, 7, 2, 3], // +y
        [3, 1, 2, 0], // -z
        [6, 4, 7, 5]  // +z
      ];
      // 每面 uv 取自哪个局部轴：[u轴, v轴, u反向, v反向]（v=1 对应纹理顶边）
      const UV_AXIS = [
        [2, 1, false, false],  // -x: u=z,  v=y
        [2, 1, true,  false],  // +x: u=1-z, v=y
        [0, 2, false, true],   // -y: u=x,  v=1-z
        [0, 2, true,  false],  // +y: u=1-x, v=z
        [0, 1, true,  false],  // -z: u=1-x, v=y
        [0, 1, false, false]   // +z: u=x,  v=y
      ];
      const selfId = this.getBlock(x, y, z);
      const mins = [x0, y0, z0], maxs = [x1, y1, z1];
      const uv = tileUV(tile);
      const u0 = uv[0], v0 = uv[1], u1 = uv[2], v1 = uv[3];
      for (let f = 0; f < 6; f++) {
        const d = FACES[f].dir;
        const ax = d[0] !== 0 ? 0 : (d[1] !== 0 ? 1 : 2);
        const atBoundary = d[ax] > 0 ? maxs[ax] === 1 : mins[ax] === 0;
        if (atBoundary) {
          const nb = this.getBlock(x + d[0], y + d[1], z + d[2]);
          if (isOpaque(nb) || nb === selfId) continue;
        }
        const sh = shade ? FACE_SHADE[f] : 1;
        const base = arr.P.length / 3;
        const vis = faceVerts[f];
        const ua = UV_AXIS[f];
        for (let k = 0; k < 4; k++) {
          const r = rel[vis[k]];
          arr.P.push(x + r[0], y + r[1], z + r[2]);
          if (arr.N) arr.N.push(d[0], d[1], d[2]);
          let uu, vv;
          if (fit) {
            // 归一化到盒自身范围，每面铺满整张纹理
            const du = Math.max(1e-6, maxs[ua[0]] - mins[ua[0]]);
            const dv = Math.max(1e-6, maxs[ua[1]] - mins[ua[1]]);
            uu = (r[ua[0]] - mins[ua[0]]) / du;
            vv = (r[ua[1]] - mins[ua[1]]) / dv;
          } else {
            uu = r[ua[0]];
            vv = r[ua[1]];
          }
          if (ua[2]) uu = 1 - uu;
          if (ua[3]) vv = 1 - vv;
          arr.U.push(u0 + uu * (u1 - u0), v0 + vv * (v1 - v0));
          arr.C.push(sh, sh, sh);
          if (arr.S) arr.S.push(0);   // 裁切通道与小草共用材质，风力摆幅固定为 0
        }
        arr.I.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
      }
    }

    // 轴对齐彩色盒：8 顶点 12 三角形，绕序与 FACES 一致（法线朝外）。
    // floor 为底面亮度下限，避免火头底面发黑。
    pushColoredBox(P, C, I, x0, y0, z0, x1, y1, z1, r, g, b, floor) {
      const corner = [
        [x0, y0, z0], [x1, y0, z0], [x0, y1, z0], [x1, y1, z0],
        [x0, y0, z1], [x1, y0, z1], [x0, y1, z1], [x1, y1, z1]
      ];
      // 每面：FACES 的 4 个角点在 corner 中的索引（与 FACES.p 一一对应）
      const faceVerts = [
        [2, 0, 6, 4], // -x: p [[0,1,0],[0,0,0],[0,1,1],[0,0,1]]
        [7, 5, 3, 1], // +x: [[1,1,1],[1,0,1],[1,1,0],[1,0,0]]
        [5, 4, 1, 0], // -y: [[1,0,1],[0,0,1],[1,0,0],[0,0,0]]
        [6, 7, 2, 3], // +y: [[0,1,1],[1,1,1],[0,1,0],[1,1,0]]
        [3, 1, 2, 0], // -z: [[1,1,0],[1,0,0],[0,1,0],[0,0,0]]
        [6, 4, 7, 5]  // +z: [[0,1,1],[0,0,1],[1,1,1],[1,0,1]]
      ];
      for (let f = 0; f < 6; f++) {
        let sh = FACE_SHADE[f];
        if (sh < floor) sh = floor;
        const base = P.length / 3;
        const vis = faceVerts[f];
        for (let k = 0; k < 4; k++) {
          const v = corner[vis[k]];
          P.push(v[0], v[1], v[2]);
          C.push(Math.min(1, r * sh), Math.min(1, g * sh), Math.min(1, b * sh));
        }
        I.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
      }
    }

    makeColoredGeometry(pos, col, idx) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(idx);
      return g;
    }

    // 压入一个岩浆面：UV 直接取 0..1（独立滚动贴图），上角点 y 降到液面高度
    pushLavaFace(LP, LN, LU, LC, LI, x, y, z, f, topH, id) {
      const face = FACES[f];
      const base = LP.length / 3;
      // 流动越远颜色越暗（源头最亮），顶/侧/底再做轻微面明暗
      let g = id === BLOCK.LAVA ? 1 : Math.max(0.55, 1 - (id - BLOCK.FLOW_LAVA + 1) * 0.09);
      if (f === 2) g *= 0.7;
      else if (f !== 3) g *= 0.92;
      for (let k = 0; k < 4; k++) {
        const pp = face.p[k];
        let py = pp[1];
        if (py === 1 && f !== 2) py = topH;   // 顶面整面下沉，侧面只沉上角点；底面保持 0
        LP.push(x + pp[0], y + py, z + pp[2]);
        LN.push(face.dir[0], face.dir[1], face.dir[2]);
        LU.push(face.uv[k][0], face.uv[k][1]);
        LC.push(g, g, g);
      }
      LI.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
    }

    makeGeometry(pos, nor, uv, col, idx) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
      g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(idx);
      return g;
    }

    /* ============================================================
     * 岩浆流动模拟（元胞式调度，仅在挖/放方块惊动附近岩浆时启动）
     *
     * 规则（贴近我的世界手感）：
     *  - 岩浆源头无限；下方是空气时生成 1 档岩浆并继续下坠（落差会重置档位）
     *  - 落地后向四侧水平扩散，最远 LAVA_SPREAD 格，液面随档位降低
     *  - 流动格一旦失去上游补给就逐格回收（填回方块 / 源头被封时）
     *  - 岩浆遇水原地凝固成玄武岩（既防止灌入海洋，又有水火交融的反馈）
     * ============================================================ */

    lavaIdx(x, y, z) { return x + "," + y + "," + z; }
    lavaCoord(k) {
      const parts = k.split(",");
      return [+parts[0], +parts[1], +parts[2]];
    }
    // 0=源头，1..3=流动档位，-1=不是岩浆
    lavaLevelOf(id) {
      if (id === BLOCK.LAVA) return 0;
      if (id >= BLOCK.FLOW_LAVA && id <= BLOCK.FLOW_LAVA_3) return id - BLOCK.FLOW_LAVA + 1;
      return -1;
    }

    scheduleLava(idx, delay) {
      const due = this.lavaClock + delay;
      const old = this.lavaQueue.get(idx);
      if (old === undefined || due < old) this.lavaQueue.set(idx, due);
    }

    // 方块被挖/放后调用：惊动该格六邻内的岩浆，让它们重新决定流向
    notifyLava(x, y, z) {
      const cand = [
        [x, y, z], [x + 1, y, z], [x - 1, y, z],
        [x, y + 1, z], [x, y - 1, z], [x, y, z + 1], [x, y, z - 1]
      ];
      for (const c of cand) {
        if (!this.inBounds(c[0], c[1], c[2])) continue;
        if (isLava(this.getBlock(c[0], c[1], c[2]))) {
          this.scheduleLava(this.lavaIdx(c[0], c[1], c[2]), 0.05 + Math.random() * 0.18);
        }
      }
    }

    // 新生成/消失一格岩浆后：安排自身与周围岩浆尽快复检（继续扩散或连锁回收）
    armLavaAround(x, y, z, fast) {
      const delay = fast ? 0.03 + Math.random() * 0.1 : 0.12 + Math.random() * 0.25;
      const cand = [
        [x, y, z],
        [x + 1, y, z], [x - 1, y, z], [x, y + 1, z],
        [x, y - 1, z], [x, y, z + 1], [x, y, z - 1]
      ];
      for (const c of cand) {
        if (!this.inBounds(c[0], c[1], c[2])) continue;
        if (isLava(this.getBlock(c[0], c[1], c[2]))) {
          this.scheduleLava(this.lavaIdx(c[0], c[1], c[2]), delay);
        }
      }
    }

    ensureFlowCount() {
      if (this.flowCountKnown) return;
      // 流动岩浆只可能出现在玩家编辑过（dirty）的区块，而 dirty 区块永不卸载，
      // 所以扫一遍当前已加载数据即可得到全量准确计数
      let n = 0;
      for (const rec of this.cdata.values()) {
        const d = rec.d;
        for (let i = 0; i < d.length; i++) {
          const v = d[i];
          if (v >= BLOCK.FLOW_LAVA && v <= BLOCK.FLOW_LAVA_3) n++;
        }
      }
      this.flowCount = n;
      this.flowCountKnown = true;
    }

    // 在空气格放入一档流动岩浆；超过总量上限时放弃
    placeFlow(x, y, z, level) {
      if (this.getBlock(x, y, z) !== BLOCK.AIR) return false;
      this.ensureFlowCount();
      if (this.flowCount >= LAVA_MAX_FLOW) return false;
      this.setBlock(x, y, z, BLOCK.FLOW_LAVA - 1 + level);  // 19,20,21
      this.flowCount++;
      return true;
    }

    // 流动格是否仍有补给：正上方是任意岩浆（下坠柱），或四侧有刚好小一档的岩浆
    lavaFed(x, y, z, level) {
      if (isLava(this.getBlock(x, y + 1, z))) return true;
      const needId = level === 1 ? BLOCK.LAVA : BLOCK.FLOW_LAVA - 1 + (level - 1);
      for (const d of LAVA_DIRS4) {
        if (this.getBlock(x + d[0], y, z + d[2]) === needId) return true;
      }
      return false;
    }

    // 处理单格岩浆的一次流动决策；发生方块变化时把所在列记入 cols
    tickLava(x, y, z, cols) {
      const id = this.getBlock(x, y, z);
      const level = this.lavaLevelOf(id);
      if (level < 0) return;
      const mark = (cx, cz) => cols.add(cx + "," + cz);

      // 1) 向下：空气则倾洒一档新岩浆（下坠后档位重置，可沿坡流很远）
      const down = this.getBlock(x, y - 1, z);
      if (down === BLOCK.AIR) {
        if (this.placeFlow(x, y - 1, z, 1)) {
          mark(x, z);
          this.armLavaAround(x, y - 1, z, true);
        }
        this.scheduleLava(this.lavaIdx(x, y, z), LAVA_FALL_TICK);
        return;
      }
      // 2) 岩浆压到水面：水被烤凝成玄武岩
      if (down === BLOCK.WATER) {
        this.setBlock(x, y - 1, z, BLOCK.BASALT);
        mark(x, z);
        this.armLavaAround(x, y - 1, z, false);
        return;
      }

      // 3) 断流回收：失去补给的流动格消失，并通知连锁复检
      if (level > 0 && !this.lavaFed(x, y, z, level)) {
        this.setBlock(x, y, z, BLOCK.AIR);
        this.ensureFlowCount();
        this.flowCount = Math.max(0, this.flowCount - 1);
        mark(x, z);
        this.armLavaAround(x, y, z, false);
        return;
      }

      // 4) 落地后水平扩散
      let activeEdge = false;
      if (level < LAVA_SPREAD) {
        for (const d of LAVA_DIRS4) {
          const nx = x + d[0], ny = y, nz = z + d[2];
          if (!this.inBounds(nx, ny, nz)) continue;
          const nb = this.getBlock(nx, ny, nz);
          if (nb === BLOCK.WATER) {
            // 侧遇水：接触面凝成玄武岩，岩浆不进入水域
            this.setBlock(nx, ny, nz, BLOCK.BASALT);
            mark(nx, nz);
            activeEdge = true;
            this.armLavaAround(nx, ny, nz, false);
            continue;
          }
          if (nb !== BLOCK.AIR) continue;
          if (isLava(this.getBlock(nx, ny + 1, nz))) continue;  // 上方有更近的岩浆，让位
          if (this.placeFlow(nx, ny, nz, level + 1)) {
            mark(nx, nz);
            activeEdge = true;
            this.armLavaAround(nx, ny, nz, false);
          }
        }
      }

      // 流动格持续复检（扩散/回收）；静止的源头重新休眠，等下次 notify
      if (level > 0 || activeEdge) {
        this.scheduleLava(this.lavaIdx(x, y, z), LAVA_SPREAD_TICK + Math.random() * 0.4);
      }
    }

    // 游戏主循环每帧调用（仅在玩家在场时推进）
    updateLava(dt) {
      if (this.netMode === "guest") return;   // 客人世界不做任何流体模拟
      if (!this.lavaQueue.size) return;
      this.lavaClock += dt;

      const due = [];
      for (const [idx, t] of this.lavaQueue) {
        if (t <= this.lavaClock) {
          due.push(idx);
          if (due.length >= LAVA_STEP_BUDGET) break;
        }
      }
      if (!due.length) return;

      const cols = new Set();
      for (const idx of due) {
        this.lavaQueue.delete(idx);
        const [x, y, z] = this.lavaCoord(idx);
        this.tickLava(x, y, z, cols);
      }
      // 批量重建受影响列（remeshAround 会顺带处理跨区块边界）
      for (const key of cols) {
        const p = key.indexOf(",");
        this.remeshAround(+key.slice(0, p), +key.slice(p + 1));
      }
    }
  }

  global.World = World;
  global.BIOME = BIOME;
  global.CHUNK_SIZE = CHUNK;
  global.FACES = FACES;
})(window);
