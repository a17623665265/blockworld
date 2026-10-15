/* ============================================================
 * viewmodel.js — 第一人称双手与手持物模型
 *
 * 用独立叠加场景渲染（世界渲染完清深度再画手），保证双手与
 * 手持物始终完整可见、不会穿进墙里。
 *
 * 构成：
 *  - 一条像素风肤色右臂从屏幕右下缘顺视线前伸（MC 式，空手不显示左手）
 *  - 右手为惯用手：手持方块显示为图集纹理小方块；
 *    手持工具显示为体素拼装的木棍 / 木镐 / 石镐
 *  - 动画：待机呼吸、行走节奏摆动、挖 / 放时以肩为轴挥手、低头时前探下沉
 * ============================================================ */
(function (global) {
  "use strict";

  // 体素颜色（与物品图标 / 世界调色板对齐）
  const COLORS = {
    skin: 0xd2966c,
    skinShade: 0xab744c,
    handle: 0x7a5633,
    handleHi: 0x9a7243,
    woodHead: 0xa97a38,
    woodHeadDark: 0x755122,
    stoneHead: 0x8e8e8e,
    stoneDark: 0x5a5a5a,
    coal: 0x23232a,
    coalHi: 0x3c3c46,
    ingot: 0xd8dade,
    ingotHi: 0xf2f4f8,
    ingotDark: 0x9aa0ab,
    seed: 0xb5863f,        // 种子粒
    seedDark: 0x8a6028,
    sprout: 0x7cc247,      // 嫩芽
    pork: 0xe89494, porkDark: 0xcf6f76, porkFat: 0xf2e6d4,
    beef: 0xa83c34, beefDark: 0x7c2823, beefFat: 0xe8e2d2,
    mutton: 0xd07068, muttonDark: 0xa84e48, muttonFat: 0xf0e8d8,
    dragonMeat: 0xc04438, dragonMeatDark: 0x7e2018, dragonMeatFat: 0xece2d0,
    leather: 0x8a5a2b, leatherDark: 0x5e3a18,
    wool: 0xf2efe6, woolShade: 0xcfc9ba,
    // 龙皮手持：受光补偿后的灰黑鳞甲（屏显还原图纸 H5/H6/H4 灰阶）
    hide: 0x3a3940, hideDark: 0x17151a, hideScale: 0x6f6d75,
    wheatStalk: 0x7cc247, wheatStem: 0x5f9e32,
    // 手枪：冷枪灰金属件 + 橄榄绿聚合物握把。色值为受光补偿后的材质本色
    // （叠加场景半球 0.72+方向光 0.42 下，受光面还原成图标原色 4d5157/494e40）
    gunSteel: 0x3a3e44, gunMid: 0x262a30, gunDark: 0x23262c,
    gunHi: 0x6f7378, gunBlack: 0x12141a,
    gunGrip: 0x383d30, gunGripHi: 0x464c3a, gunGripDark: 0x23271f
  };

  const ViewModel = {
    /* ---------------- 初始化 ---------------- */

    init(opts) {
      this.renderer = opts.renderer;
      this.mainCamera = opts.camera;
      this.atlasTexture = opts.atlasTexture;
      // 物品栏图标 dataURL（{itemId: dataURL}）：肉 / 工具等手持时直接贴这张图，
      // 保证与物品栏里的 16×16 像素外观一模一样
      this.itemIcons = opts.itemIcons || {};

      // 叠加场景：自己的相机与光照
      this.scene = new THREE.Scene();
      // FOV 与主相机一致（75），避免手与世界透视感脱节
      this.vmCamera = new THREE.PerspectiveCamera(75,
        window.innerWidth / window.innerHeight, 0.01, 3);
      this.scene.add(this.vmCamera);
      this.scene.add(new THREE.HemisphereLight(0xfff4e2, 0x8a7460, 0.72));
      const key = new THREE.DirectionalLight(0xfff3dd, 0.42);
      key.position.set(-0.6, 0.9, -1.2);
      this.scene.add(key);
      this.scene.add(new THREE.AmbientLight(0xffffff, 0.22));

      // 手臂根节点（相机空间：-Z 为视线方向）
      this.root = new THREE.Group();
      this.vmCamera.add(this.root);

      this.skinMat = new THREE.MeshLambertMaterial({ color: COLORS.skin });
      this.skinShadeMat = new THREE.MeshBasicMaterial({ color: COLORS.skinShade });
      this.tileMats = {};   // tile 索引 -> 材质缓存
      this.iconTex = {};   // 物品 id -> 图标 Canvas 纹理缓存

      // 第一人称只渲染惯用右手（与 MC 一致：空手不显示左手，避免屏幕下缘
      // 两边各戳一截手臂，低头看地时尤其违和）
      const arm = this.buildArm();
      this.armRoot = arm.root;   // 肩部节点：挥手 / 行走摆动 / 低头前探都转这里
      this.armDir = arm.dir;     // 手臂固定的前伸朝向
      this.root.add(this.armRoot);

      // 右手挂点在拳头处（手臂远端），手持物挂这里
      this.handAnchor = new THREE.Group();
      this.handAnchor.position.set(0, 0.58, 0);
      this.armDir.add(this.handAnchor);

      // 动画状态
      this.heldId = -1;
      this.swingT = 0;
      this.useT = 0;      // 右键使用动画进度（1→0），0 为空闲
      this.kickT = 0;     // 枪械开火后坐力进度（1→0），0 为空闲
      this.reloadT = 0;   // 枪械换弹动画进度（1→0），0 为空闲
      this.gunFlash = null;  // 当前持枪模型的枪口火光组（非持枪为 null）
      this.useKind = "";  // "scoop"（空桶舀取）/ "pour"（装液桶倾倒）
      this.heldBase = null;
      this.bobT = 0;

      this.setHeld(0);
      this.setVisible(false);
    },

    /* ---------------- 手臂构造 ---------------- */

    buildArm() {
      // 肩部根节点：藏在屏幕右下缘之外、离相机较近，整条手臂从下缘伸入画面
      const root = new THREE.Group();
      root.position.set(0.30, -0.56, -0.10);

      // 前伸朝向：局部 +Y（手臂生长方向）映射为“沿视线向前(-Z)、向上约 48°
      // 并向内收”。静止时手臂从右下缘斜向前伸、能看到手臂侧面（而不是正对
      // 镜头的大扁白条），拳头停在准星右下方
      const dir = new THREE.Group();
      dir.rotation.set(-0.84, 0, 0.14);

      // MC 式一整条方柱手臂（拳头与手臂同截面），长 0.58，拳头端在 y=0.58
      const limb = new THREE.Mesh(new THREE.BoxGeometry(0.078, 0.58, 0.078), this.skinMat);
      limb.position.y = 0.29;

      // 下侧暗棱 + 拳端暗影：体素风的明暗分界，分出立体感
      const underside = new THREE.Mesh(
        new THREE.BoxGeometry(0.08, 0.58, 0.008), this.skinShadeMat);
      underside.position.set(0, 0.29, -0.042);
      const fistCap = new THREE.Mesh(
        new THREE.BoxGeometry(0.08, 0.012, 0.08), this.skinShadeMat);
      fistCap.position.set(0, 0.586, 0);

      dir.add(limb, underside, fistCap);
      root.add(dir);
      return { root: root, dir: dir };
    },

    /* ---------------- 手持物 ---------------- */

    // 按物品 id 构建手持模型（纯工厂，第一人称与第三人称共用）。
    // 返回的 mesh 自带第一人称专用基座 position/rotation；第三人称复用时
    // 清除基座即可，并按 userData.heldKind（"block" / "icon" / "voxel"）
    // 另行缩放与摆放。返回 null 表示空手。
    buildHeldMesh(id) {
      let mesh = null;
      let kind = "voxel";
      if (id > 0 && id < 100 && BLOCK_TILES[id]) {
        // mod 自定义网格方块（灯/楼梯/门/围栏…）：手持渲染迷你 3D 模型而非整方块
        if (typeof GameRegistry !== "undefined" && GameRegistry.customMeshes[id]) {
          mesh = this.buildModBlockModel(id);
        } else {
          mesh = this.buildBlockModel(id);
        }
        kind = "block";
      } else if (id === ITEM.STICK || id === ITEM.WOOD_PICKAXE || id === ITEM.STONE_PICKAXE
        || id === ITEM.IRON_PICKAXE
        || id === ITEM.WOOD_AXE || id === ITEM.STONE_AXE || id === ITEM.IRON_AXE
        || id === ITEM.PORKCHOP || id === ITEM.BEEF || id === ITEM.MUTTON
        || id === ITEM.DRAGON_MEAT || id === ITEM.SPIDER_SILK || id === ITEM.WOOL
        || id === ITEM.COAL || id === ITEM.RAW_IRON) {
        // 工具 / 肉排 / 羊毛 / 煤 / 粗铁：直接把物品栏的 16×16 图标原样举在手里
        mesh = this.buildIconModel(id);
        kind = "icon";
      } else if (id === ITEM.IRON_INGOT) {
        mesh = this.buildIngotModel();
      } else if (id === ITEM.LEATHER) {
        mesh = this.buildLeatherModel(COLORS.leather, COLORS.leatherDark);
      } else if (id === ITEM.DRAGON_HIDE) {
        mesh = this.buildLeatherModel(COLORS.hide, COLORS.hideDark, COLORS.hideScale);
      } else if (id === ITEM.WOOL_HELMET) {
        mesh = this.buildWoolArmorModel("helmet");
      } else if (id === ITEM.WOOL_CHEST) {
        mesh = this.buildWoolArmorModel("chest");
      } else if (id === ITEM.WOOL_LEGS) {
        mesh = this.buildWoolArmorModel("legs");
      } else if (id === ITEM.BACKPACK) {
        mesh = this.buildBackpackModel();
      } else if (ITEM_INFO[id] && ITEM_INFO[id].heldModel) {
        // Mod 物品自描述手持模型：{model:"pick",head,dark} / {model:"gem",color,dark}
        const hm = ITEM_INFO[id].heldModel;
        if (hm.model === "pick" || hm.model === "axe") {
          // 镐 / 斧 / 锄等 mod 工具同样原样举物品栏图标
          mesh = this.buildIconModel(id);
          kind = "icon";
        } else if (hm.model === "gem") {
          mesh = this.buildGemModel(hm.color, hm.dark);
        } else if (hm.model === "seed") {
          mesh = this.buildSeedModel(hm.grain, hm.grainDark, hm.sprout);
        } else if (hm.model === "wheat") {
          mesh = this.buildWheatModel();
        } else if (hm.model === "icon") {
          // 自描述图标物品（竹子等）：原样举物品栏 16×16 像素图标
          mesh = this.buildIconModel(id);
          kind = "icon";
        } else if (hm.model === "bucket") {
          // 铁桶与斧/镐/锄一致：直接举物品栏像素图标（桶内液体颜色清晰可辨）
          mesh = this.buildIconModel(id);
          kind = "icon";
        } else if (hm.model === "gun") {
          // 手枪等枪械：真实体素 3D 模型（枪管指向视线前方，非图标面片）
          mesh = this.buildGunModel();
        }
      }
      if (mesh) mesh.userData.heldKind = kind;
      return mesh;
    },

    setHeld(id) {
      if (id === this.heldId) return;
      this.heldId = id;

      if (this.heldMesh) {
        this.handAnchor.remove(this.heldMesh);
        this.heldMesh = null;
      }
      this.gunFlash = null;   // 下方 traverse 挂接本 mesh 的火光；非枪保持 null
      this.heldMesh = this.buildHeldMesh(id);
      if (this.heldMesh) {
        this.handAnchor.add(this.heldMesh);
        // 只挂第一人称自己这把枪的火光（第三人称复用工厂的副本带同样标签但不取）
        this.heldMesh.traverse((o) => {
          if (o.userData && o.userData.gunFlash) this.gunFlash = o;
        });
        // 记录建造时的基础位姿，供右键使用动画叠加偏移并准确回位
        this.heldBase = {
          rx: this.heldMesh.rotation.x, ry: this.heldMesh.rotation.y,
          rz: this.heldMesh.rotation.z,
          x: this.heldMesh.position.x, y: this.heldMesh.position.y,
          z: this.heldMesh.position.z
        };
      } else {
        this.heldBase = null;
      }
      this.useT = 0;
      this.kickT = 0;
      this.reloadT = 0;
    },

    // 图集某一 tile 的材质（克隆纹理后设置 repeat/offset）
    tileMaterial(tile) {
      if (this.tileMats[tile]) return this.tileMats[tile];
      const tex = this.atlasTexture.clone();
      tex.needsUpdate = true;
      const uv = tileUV(tile);           // [u0, v0, u1, v1]
      tex.repeat.set(uv[2] - uv[0], uv[3] - uv[1]);
      tex.offset.set(uv[0], uv[1]);
      // alphaTest：镂空纹理（玻璃/玻璃窗）手持时透明像素不绘制，普通方块无影响
      const mat = new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5 });
      this.tileMats[tile] = mat;
      return mat;
    },

    // 物品栏图标的 THREE 纹理（dataURL → Texture，最近邻保留像素颗粒感）
    iconTexture(id) {
      if (this.iconTex[id]) return this.iconTex[id];
      const url = this.itemIcons[id];
      if (!url) return null;
      const img = new Image();
      const tex = new THREE.Texture(img);
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      // 与图集纹理保持一致的 sRGB 标记，否则颜色会被重复转换而整体发白
      if (THREE.sRGBEncoding) tex.encoding = THREE.sRGBEncoding;
      img.onload = () => { tex.needsUpdate = true; };
      img.src = url;
      this.iconTex[id] = tex;
      return tex;
    },

    // 物品栏图标原样手持：一张透明底像素面片。MeshBasicMaterial 不受光，
    // 颜色与物品栏完全一致；双面材质保证挥手翻面时不会消失。
    // 挂点随手臂前倾了约 48°（armDir.rotation.x=-0.84），这里反向转回
    // 近似正对相机；z 保持 0 竖直握持（工具头朝上，不再侧倾），仅留极轻微侧转。
    // 尺寸 0.36（比手中方块 0.20 更大，贴近 MC 物品在第一人称里的占比）
    buildIconModel(id) {
      const tex = this.iconTexture(id);
      if (!tex) return null;
      const s = 0.36;
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        alphaTest: 0.5,
        side: THREE.DoubleSide
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(s, s), mat);
      mesh.rotation.set(0.72, 0.08, 0);
      mesh.position.set(0.02, 0.07, -0.08);
      return mesh;
    },

    buildBlockModel(id) {
      const [top, side, bottom] = BLOCK_TILES[id];
      // BoxGeometry 材质顺序：+x, -x, +y(顶), -y(底), +z, -z
      // 熔炉：相机位于 +z，yaw 0.62 后可见 -x（居左）与 +z（居右），
      // 正面放 -x、侧面放 +z，与等距图标同一观感（正面 + 侧面 + 顶面）
      let mats;
      if (id === BLOCK.FURNACE) {
        const s = this.tileMaterial(TILE.FURNACE_SIDE);
        const f = this.tileMaterial(TILE.FURNACE_FRONT);
        const t = this.tileMaterial(TILE.FURNACE_TOP);
        mats = [s, f, t, t, s, s];
      } else {
        const s = this.tileMaterial(side), t = this.tileMaterial(top), b = this.tileMaterial(bottom);
        mats = [s, s, t, b, s, s];
      }
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.20, 0.20, 0.20),
        mats
      );
      mesh.position.set(0.01, 0.05, -0.06);
      mesh.rotation.set(-0.32, 0.62, 0.10);
      return mesh;
    },

    // mod 自定义网格方块的手持迷你模型：在世界坐标系外重放 customMeshes 的盒列表，
    // 每个盒按自身范围铺满整张纹理（与 world.js 的 fit 模式一致）
    buildModBlockModel(id) {
      const boxes = [];
      const api = {
        world: { getBlock: function () { return 0; } },
        x: 0, y: 0, z: 0,
        box: function (x0, y0, z0, x1, y1, z1, tile) { boxes.push({ b: [x0, y0, z0, x1, y1, z1], tile: tile, unlit: false }); },
        unlitBox: function (x0, y0, z0, x1, y1, z1, tile) { boxes.push({ b: [x0, y0, z0, x1, y1, z1], tile: tile, unlit: true }); },
        cutoutBox: function (x0, y0, z0, x1, y1, z1, tile) { boxes.push({ b: [x0, y0, z0, x1, y1, z1], tile: tile, unlit: false }); },
        // 交叉面片类方块（竹笋/作物）不构建手持迷你盒模型（此类方块通常不进物品栏）
        cross: function () {},
        glowBox: function () {}
      };
      try { GameRegistry.customMeshes[id](api); } catch (e) { return this.buildBlockModel(id); }
      const group = new THREE.Group();
      for (const it of boxes) {
        const b = it.b;
        const w = Math.max(0.001, b[3] - b[0]), h = Math.max(0.001, b[4] - b[1]), d = Math.max(0.001, b[5] - b[2]);
        let mat = this.tileMaterial(it.tile);
        if (it.unlit) {
          const key = "u" + it.tile;
          if (!this.tileMats[key]) {
            const tex = this.tileMaterial(it.tile).map;
            this.tileMats[key] = new THREE.MeshBasicMaterial({ map: tex });
          }
          mat = this.tileMats[key];
        }
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
        m.position.set((b[0] + b[3]) / 2 - 0.5, (b[1] + b[4]) / 2 - 0.5, (b[2] + b[5]) / 2 - 0.5);
        group.add(m);
      }
      group.scale.setScalar(0.30);
      group.position.set(0.01, 0.03, -0.06);
      group.rotation.set(-0.32, 0.62, 0.10);
      return group;
    },

    // 体素小方块快捷构造
    voxel(mat, x, y, z, u) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(u, u, u), mat);
      m.position.set(x * u, y * u, z * u);
      return m;
    },

    buildStickModel() {
      const u = 0.045;
      const g = new THREE.Group();
      const mat = new THREE.MeshLambertMaterial({ color: COLORS.handle });
      const hi = new THREE.MeshLambertMaterial({ color: COLORS.handleHi });
      g.add(this.voxel(mat, 0, 0, 0, u));
      g.add(this.voxel(mat, 0, -1, 0, u));
      g.add(this.voxel(hi, 0, 1, 0, u));    // 顶端高光
      g.rotation.set(-0.25, 0, 0.55);       // 像物品图标一样斜握
      g.position.set(0.01, 0.005, -0.05);
      return g;
    },

    buildPickModel(headColor, darkColor) {
      const u = 0.045;
      const g = new THREE.Group();
      const handle = new THREE.MeshLambertMaterial({ color: COLORS.handle });
      const handleHi = new THREE.MeshLambertMaterial({ color: COLORS.handleHi });
      const head = new THREE.MeshLambertMaterial({ color: headColor });
      const dark = new THREE.MeshLambertMaterial({ color: darkColor });

      // 镐头：顶部横梁 3 格 + 两端下垂（与物品图标同构）
      g.add(this.voxel(head, -1, 1, 0, u));
      g.add(this.voxel(head, 0, 1, 0, u));
      g.add(this.voxel(head, 1, 1, 0, u));
      g.add(this.voxel(dark, -1, 0, 0, u));
      g.add(this.voxel(dark, 1, 0, 0, u));
      // 木柄 3 节（带一条高光棱）
      g.add(this.voxel(handle, 0, 0, 0, u));
      g.add(this.voxel(handle, 0, -1, 0, u));
      g.add(this.voxel(handle, 0, -2, 0, u));
      g.add(this.voxel(handleHi, 0, -1, 0.5, u));

      g.rotation.set(-0.16, 0, 0.06);
      g.position.set(0.03, 0.055, -0.06);
      return g;
    },

    // 铁锭：扁平长条 + 两端略窄略低的锭头 + 顶面高光
    buildIngotModel() {
      const g = new THREE.Group();
      const mat = new THREE.MeshLambertMaterial({ color: COLORS.ingot });
      const dark = new THREE.MeshLambertMaterial({ color: COLORS.ingotDark });
      const hi = new THREE.MeshLambertMaterial({ color: COLORS.ingotHi });
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.035, 0.06), mat);
      const endL = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.026, 0.045), dark);
      endL.position.x = -0.072;
      const endR = endL.clone();
      endR.position.x = 0.072;
      const shine = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.008, 0.03), hi);
      shine.position.y = 0.02;
      g.add(body, endL, endR, shine);
      g.rotation.set(-0.32, 0.62, 0.10);
      g.position.set(0.01, 0.05, -0.06);
      return g;
    },

    // 宝石（mod 用）：亮台面 + 3x3 宽腰线 + 向下收尖的底锥，体素刻面
    buildGemModel(color, darkColor) {
      const u = 0.05;
      const g = new THREE.Group();
      const main = new THREE.MeshLambertMaterial({ color: color });
      const dark = new THREE.MeshLambertMaterial({ color: darkColor });
      const hiHex = new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.5).getHex();
      const hi = new THREE.MeshLambertMaterial({ color: hiHex });
      const add = (mat, x, y, z) => g.add(this.voxel(mat, x, y, z, u));
      add(hi, 0, 1, 0);                              // 顶部台面
      for (let x = -1; x <= 1; x++) {                // 腰线 3x3
        for (let z = -1; z <= 1; z++) add(main, x, 0, z);
      }
      add(dark, -1, -1, 0);                          // 底锥十字收窄
      add(dark, 1, -1, 0);
      add(dark, 0, -1, -1);
      add(dark, 0, -1, 0);
      add(dark, 0, -1, 1);
      add(dark, 0, -2, 0);                           // 底端收尖
      g.rotation.set(-0.32, 0.62, 0.10);
      g.position.set(0.01, 0.05, -0.06);
      return g;
    },

    // 种子：掌心一小撮棕黄籽粒，上面伸出一对嫩绿幼芽（与种子物品图标同构）
    buildSeedModel(grainColor, darkColor, sproutColor) {
      const u = 0.034;
      const g = new THREE.Group();
      const grain = new THREE.MeshLambertMaterial({ color: grainColor || COLORS.seed });
      const dark = new THREE.MeshLambertMaterial({ color: darkColor || COLORS.seedDark });
      const sproutMat = new THREE.MeshLambertMaterial({ color: sproutColor || COLORS.sprout });
      const sproutHiHex = new THREE.Color(sproutColor || COLORS.sprout)
        .lerp(new THREE.Color(0xffffff), 0.45).getHex();
      const sproutHi = new THREE.MeshLambertMaterial({ color: sproutHiHex });
      const add = (mat, x, y, z) => g.add(this.voxel(mat, x, y, z, u));

      // 籽粒：底层一圈 + 中间叠一粒，形成一小撮
      add(grain, 0, 0, 0);
      add(grain, 1, 0, 0);
      add(dark, -1, 0, 0);
      add(dark, 0, 0, 1);
      add(grain, 1, 0, 1);
      add(grain, 0, 1, 0);
      // 幼芽：短茎 + 左右两瓣外撇的子叶
      add(sproutMat, 0, 2, 0);
      add(sproutMat, -1, 2, 0);
      add(sproutHi, -1, 3, 0);
      add(sproutMat, 1, 2, 0);
      add(sproutHi, 1, 3, 0);

      g.rotation.set(-0.32, 0.62, 0.10);
      g.position.set(0.01, 0.05, -0.06);
      return g;
    },

    // 生肉排：厚肉块 + 暗部/受光棱 + 一道浅色脂肪纹（与物品图标同色）
    buildMeatModel(mainColor, darkColor, fatColor) {
      const g = new THREE.Group();
      const main = new THREE.MeshLambertMaterial({ color: mainColor });
      const dark = new THREE.MeshLambertMaterial({ color: darkColor });
      const fat = new THREE.MeshLambertMaterial({ color: fatColor });
      const hiColor = new THREE.Color(mainColor).lerp(new THREE.Color(0xffffff), 0.35).getHex();
      const hi = new THREE.MeshLambertMaterial({ color: hiColor });
      const add = (mat, w, h, d, x, y, z) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
        m.position.set(x, y, z);
        g.add(m);
      };
      add(main, 0.11, 0.075, 0.05, 0, 0, 0);          // 主体
      add(dark, 0.04, 0.035, 0.052, -0.035, -0.02, 0.004);   // 左下暗部
      add(dark, 0.03, 0.03, 0.052, 0.038, 0.022, -0.006);    // 右上暗斑
      add(hi, 0.05, 0.016, 0.012, -0.012, 0.032, 0.022);     // 受光棱
      add(fat, 0.085, 0.012, 0.01, 0.0, -0.005, 0.028);      // 脂肪横纹
      add(fat, 0.03, 0.012, 0.01, 0.03, 0.012, 0.028);       // 脂肪断纹
      g.rotation.set(-0.32, 0.62, 0.10);
      g.position.set(0.01, 0.05, -0.06);
      return g;
    },

    // 兽皮（皮革 / 龙皮）：一张不规则厚皮片 + 深色包边；
    // hiColor 存在时点缀几粒鳞片高光（龙皮），否则只留一条受光亮棱（皮革）
    buildLeatherModel(mainColor, darkColor, hiColor) {
      const g = new THREE.Group();
      const main = new THREE.MeshLambertMaterial({ color: mainColor });
      const dark = new THREE.MeshLambertMaterial({ color: darkColor });
      const add = (mat, w, h, d, x, y, z) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
        m.position.set(x, y, z);
        g.add(m);
      };
      add(main, 0.10, 0.075, 0.022, 0, 0, 0);          // 皮身
      add(dark, 0.10, 0.012, 0.026, 0, 0.038, 0);      // 上包边
      add(dark, 0.012, 0.05, 0.026, -0.05, -0.005, 0); // 左包边
      add(dark, 0.012, 0.05, 0.026, 0.05, -0.005, 0);  // 右包边
      add(dark, 0.03, 0.02, 0.02, -0.03, -0.028, 0.004);   // 下沿缺刻暗角
      if (hiColor) {
        const hi = new THREE.MeshLambertMaterial({ color: hiColor });
        add(hi, 0.018, 0.014, 0.026, -0.018, 0.012, 0.002);
        add(hi, 0.018, 0.014, 0.026, 0.02, -0.01, 0.002);
        add(hi, 0.014, 0.014, 0.026, 0.005, 0.02, 0.002);
      }
      g.rotation.set(-0.32, 0.62, 0.10);
      g.position.set(0.01, 0.05, -0.06);
      return g;
    },

    // 羊毛护甲三件：薄片体素剪影（帽=圆顶护耳 U 形 / 衣=肩带衣身 / 裤=腰带双腿）
    buildWoolArmorModel(kind) {
      const u = 0.036;
      const g = new THREE.Group();
      const white = new THREE.MeshLambertMaterial({ color: COLORS.wool });
      const shade = new THREE.MeshLambertMaterial({ color: COLORS.woolShade });
      const add = (mat, x, y) => g.add(this.voxel(mat, x, y, 0, u));
      if (kind === "helmet") {
        add(white, -1, 2); add(white, 0, 2); add(white, 1, 2);   // 圆顶
        add(white, -1, 1); add(white, 1, 1);
        add(shade, -1, 0); add(shade, 1, 0);                     // 护耳下端
      } else if (kind === "chest") {
        add(white, -1, 3); add(white, 1, 3);                     // 双肩
        for (let y = 0; y < 3; y++) {
          for (let x = -1; x <= 1; x++) add(y === 0 ? shade : white, x, y);  // 衣身（下摆阴影）
        }
      } else {
        add(shade, -1, 3); add(shade, 0, 3); add(shade, 1, 3);   // 腰带
        for (let y = 0; y < 3; y++) { add(white, -1, y); add(white, 1, y); } // 双腿
      }
      g.rotation.set(-0.32, 0.62, 0.10);
      g.position.set(0.01, 0.04, -0.06);
      return g;
    },

    // 麦子：手里握着的一小束带穗麦秆（三根细茎高低错落，顶端金黄麦穗 + 麦芒）
    buildWheatModel() {
      const u = 0.018;
      const g = new THREE.Group();
      const stem = new THREE.MeshLambertMaterial({ color: COLORS.wheatStem });
      const stalk = new THREE.MeshLambertMaterial({ color: COLORS.wheatStalk });
      const grain = new THREE.MeshLambertMaterial({ color: 0xe8c23a });
      const grainDark = new THREE.MeshLambertMaterial({ color: 0xb7901f });
      const grainHi = new THREE.MeshLambertMaterial({ color: 0xf7dd65 });
      const awn = new THREE.MeshLambertMaterial({ color: 0x7a6028 });
      // 三根麦茎：中根 6 节，左右 5 节
      for (let y = 0; y < 6; y++) g.add(this.voxel(stem, 0, y, 0, u));
      for (let y = 0; y < 5; y++) {
        g.add(this.voxel(stem, -1, y, 0, u));
        g.add(this.voxel(stem, 1, y, 0, u));
      }
      g.add(this.voxel(stalk, 0, 3, 0, u));   // 茎节高光
      // 中央麦穗 3 节 + 芒
      g.add(this.voxel(grain, 0, 6, 0, u));
      g.add(this.voxel(grainHi, 0, 7, 0, u));
      g.add(this.voxel(grainDark, 0, 8, 0, u));
      g.add(this.voxel(awn, 0, 9, 0, u));
      // 两侧穗各 2 节，外撇半格 + 短芒
      g.add(this.voxel(grain, -1, 5, 0, u));
      g.add(this.voxel(grainHi, -1, 6, 0, u));
      g.add(this.voxel(awn, -1, 7, 0, u));
      g.add(this.voxel(grain, 1, 5, 0, u));
      g.add(this.voxel(grainDark, 1, 6, 0, u));
      g.add(this.voxel(awn, 1, 7, 0, u));
      g.rotation.set(-0.28, 0.5, 0.06);
      g.position.set(0.02, 0.02, -0.05);
      return g;
    },

    // 皮革背包：小包身 + 深棕翻盖 + 一颗金属扣，配一条肩带棱
    buildBackpackModel() {
      const g = new THREE.Group();
      const body = new THREE.MeshLambertMaterial({ color: COLORS.leather });
      const dark = new THREE.MeshLambertMaterial({ color: COLORS.leatherDark });
      const clasp = new THREE.MeshLambertMaterial({ color: COLORS.ingotDark });
      const add = (mat, w, h, d, x, y, z) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
        m.position.set(x, y, z);
        g.add(m);
      };
      add(body, 0.085, 0.095, 0.05, 0, -0.005, 0);        // 包身
      add(dark, 0.088, 0.034, 0.054, 0, 0.034, 0.002);   // 翻盖
      add(clasp, 0.02, 0.016, 0.012, 0, 0.008, 0.03);    // 金属扣
      add(dark, 0.02, 0.07, 0.008, -0.03, -0.01, 0.026); // 前侧肩带棱
      add(dark, 0.085, 0.012, 0.052, 0, -0.055, 0);      // 包底暗边
      g.rotation.set(-0.32, 0.62, 0.10);
      g.position.set(0.01, 0.05, -0.06);
      return g;
    },

    // 手枪（与物品图标同构的侧影）：局部 +Y 为枪口前方（顺手臂指向视线），
    // X 为枪宽，Z 为枪厚。长套筒 + 套筒座 + 后倾橄榄绿握把 + 扳机护圈。
    // 双层组：tilt 专管绕枪管轴滚转，外层 g 管俯仰补偿，避免欧拉耦合把枪口带偏。
    buildGunModel() {
      const C = COLORS;
      const g = new THREE.Group();
      const tilt = new THREE.Group();
      g.add(tilt);
      const steel = new THREE.MeshLambertMaterial({ color: C.gunSteel });
      const mid = new THREE.MeshLambertMaterial({ color: C.gunMid });
      const dark = new THREE.MeshLambertMaterial({ color: C.gunDark });
      const black = new THREE.MeshLambertMaterial({ color: C.gunBlack });
      const hi = new THREE.MeshLambertMaterial({ color: C.gunHi });
      const grip = new THREE.MeshLambertMaterial({ color: C.gunGrip });
      const gripHi = new THREE.MeshLambertMaterial({ color: C.gunGripHi });
      const gripDark = new THREE.MeshLambertMaterial({ color: C.gunGripDark });
      const add = (mat, w, h, d, x, y, z) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
        m.position.set(x, y, z);
        tilt.add(m);
      };

      /* ---- 套筒 / 枪管：扁而长的钢件（旧版与套筒座同宽厚，叠成大方砖不像枪）---- */
      add(steel, 0.088, 0.15, 0.056, 0, 0.105, 0.056);          // 套筒主体 y.03-.18
      add(mid,   0.005, 0.15, 0.056, -0.0465, 0.105, 0.056);    // 背光阴面
      add(black, 0.066, 0.012, 0.044, 0, 0.186, 0.056);          // 枪口端面
      add(black, 0.042, 0.014, 0.03, 0, 0.195, 0.046);           // 探出的枪管凸台（枪口方向感）
      add(black, 0.016, 0.016, 0.02, 0, 0.162, 0.094);          // 准星
      add(black, 0.03, 0.02, 0.014, 0, 0.045, 0.091);           // 照门
      add(hi,    0.012, 0.07, 0.005, 0.026, 0.11, 0.086);       // 顶面局部反光条
      add(dark,  0.004, 0.006, 0.04, 0.046, 0.05, 0.056);       // 后部防滑槽 1
      add(dark,  0.004, 0.006, 0.04, 0.046, 0.063, 0.056);      // 后部防滑槽 2

      /* ---- 套筒座：比套筒窄一档，前方收成防尘盖 ---- */
      add(dark, 0.08, 0.086, 0.04, 0, 0.005, 0.028);            // 机匣主体
      add(dark, 0.066, 0.045, 0.03, 0, 0.075, 0.024);           // 前端防尘盖
      add(mid,  0.005, 0.07, 0.022, 0.042, 0, 0.026);           // 可见侧微光棱
      add(black, 0.038, 0.014, 0.016, 0, -0.05, 0.058);         // 尾部海狸尾 / 击锤

      /* ---- 扳机护圈：大环前伸到防尘盖下方，侧影一眼可读 ---- */
      add(black, 0.04, 0.016, 0.056, 0, 0.062, -0.022);         // 护圈前柱
      add(black, 0.04, 0.092, 0.014, 0, 0.02, -0.048);          // 护圈底沿
      add(black, 0.04, 0.016, 0.042, 0, -0.022, -0.022);        // 护圈后柱（接握把喉）
      add(dark,  0.018, 0.012, 0.036, 0, 0.024, -0.02);         // 环内扳机

      /* ---- 握把：四节沿后下方阶梯式后倾（约 30°），末端露出弹匣底座 ---- */
      const gys = [-0.058, -0.078, -0.098, -0.118];
      const gzs = [-0.012, -0.046, -0.08, -0.114];
      for (let i = 0; i < 4; i++) {
        add(grip, 0.076, 0.03, 0.038, 0, gys[i], gzs[i]);
        add(gripHi, 0.005, 0.03, 0.024, 0.04, gys[i], gzs[i] + 0.002);  // 可见侧亮棱
      }
      add(gripDark, 0.084, 0.042, 0.018, 0, -0.128, -0.132);    // 弹匣底座

      /* ---- 枪口火光：探出枪口端面的加色辉光方块，开火瞬间可见 ~60ms。
       * depthTest 关闭 + AdditiveBlending：贴在枪口最前、不被套筒 / 世界块遮掉 ---- */
      const flash = new THREE.Group();
      const flashMat = new THREE.MeshBasicMaterial({
        color: 0xffc43d, toneMapped: false,
        depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending
      });
      const flashCoreMat = new THREE.MeshBasicMaterial({
        color: 0xfff4cf, toneMapped: false,
        depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending
      });
      const flashOuter = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.09), flashMat);
      const flashCore = new THREE.Mesh(new THREE.BoxGeometry(0.046, 0.054, 0.046), flashCoreMat);
      flashCore.position.y = 0.008;
      flash.add(flashOuter, flashCore);
      flash.renderOrder = 999;
      flash.position.set(0, 0.238, 0.056);
      flash.visible = false;
      // 注意：本工厂也被第三人称 PlayerModel 复用，不能在这里写 this.gunFlash，
      // 否则 TP 副本会把引用覆盖到世界场景的隐藏枪上，导致第一人称火光点不亮。
      // 只打标签，由第一人称 setHeld 在自己的 mesh 里查找挂接。
      flash.userData.gunFlash = true;
      tilt.add(flash);

      // 内层滚转：绕枪管轴（局部 Y）转 0.18rad，以侧面剪影为主（护圈/握把可读），微露套筒顶
      tilt.rotation.y = 0.18;
      // 外层俯仰：手臂 +Y 本前倾约 48°（armDir），再补 -0.68 让枪管接近水平指准星
      g.scale.setScalar(1.1);
      g.rotation.set(-0.68, 0, 0);
      g.position.set(0.01, 0.10, -0.055);
      return g;
    },

    /* ---------------- 动画 ---------------- */

    // 挖 / 放方块时调用
    swing() { this.swingT = 1; },

    // 枪械开火：短促后坐（0.12s）+ 枪口火光一闪
    kick() {
      this.kickT = 1;
      if (this.gunFlash) this.gunFlash.visible = true;
    },

    // 枪械换弹：枪身侧倾下沉 0.9s（与 GunMod.RELOAD_T 同步）
    reloadGun() { this.reloadT = 1; },

    // 右键使用物品：铁桶舀取 / 倾倒时桶自身额外做一段短促动作
    // （与整条手臂的 swing 叠加）。非桶物品忽略，返回是否接受。
    use(id) {
      const hm = typeof ITEM_INFO !== "undefined" && ITEM_INFO[id] && ITEM_INFO[id].heldModel;
      if (!hm || hm.model !== "bucket") return false;
      // 空桶=舀取（桶口朝下探入），水桶/岩浆桶=倾倒（翻腕）
      const emptyId = (window.BucketMod && window.BucketMod.bucket) || 130;
      this.useKind = (id === emptyId) ? "scoop" : "pour";
      this.useT = 1;
      return true;
    },

    setVisible(v) { this.root.visible = v; },

    update(dt, moving, pitch, sprint) {
      // 行走节奏；静止时保留很轻的呼吸；奔跑时步频更快
      if (sprint) this.bobT += dt * 13.5;
      else if (moving) this.bobT += dt * 9.5;
      else this.bobT += dt * 2.2;

      // 奔跑时手臂摆幅约放大 1.45 倍，与更快的步频一起形成冲刺感
      const mag = sprint ? 1.45 : 1;
      const bobY = Math.sin(this.bobT) * (moving ? 0.016 * mag : 0.005);
      const bobX = Math.cos(this.bobT * 0.5) * (moving ? 0.009 * mag : 0.003);
      const roll = Math.sin(this.bobT) * (moving ? 0.028 * mag : 0.008);

      // 挥手：0 -> 拳头向准星方向抬起前探 -> 回位（半个正弦弧，0.28 秒）
      if (this.swingT > 0) {
        this.swingT = Math.max(0, this.swingT - dt / 0.28);
      }
      const swing = this.swingT > 0
        ? Math.sin((1 - this.swingT) * Math.PI)
        : 0;

      // 枪械后坐力衰减（0.12s）；火光只在前约 55ms 可见
      if (this.kickT > 0) {
        this.kickT = Math.max(0, this.kickT - dt / 0.12);
        if (this.kickT <= 0.45 && this.gunFlash) this.gunFlash.visible = false;
      }
      // 换弹动作衰减（0.9s）
      if (this.reloadT > 0) {
        this.reloadT = Math.max(0, this.reloadT - dt / 0.9);
      }

      // 低头补偿：俯视超过约 30° 后，手臂像真人一样朝视线方向前探、
      // 微微下沉，垂直俯视时达到最大；平视 / 抬头不受影响
      const look = Math.max(0, Math.min(1, (-(pitch || 0) - 0.5) / 1.05));

      this.armRoot.position.set(
        0.30 + bobX,
        -0.56 + bobY + swing * 0.01 - look * 0.03,
        -0.10 - swing * 0.12 + look * 0.04
      );
      // 以肩为轴挥手：静止时手臂已前倾约 48°，小幅正向抬肩 + 内收，
      // 同时手臂前伸 0.12，拳头从右下约 25°/16° 扫到约 20°/4°——工具
      // 在正常距离内抡到准星右侧（抬太多会因离相机过近变成贴脸巨物）。
      // 注意：负向旋转只会让手臂继续向下、整条伸出画面底边。
      // 低头时拳头随视线前探下沉
      this.armRoot.rotation.x = swing * 0.40 - look * 0.22;
      this.armRoot.rotation.z = roll + swing * 0.12;

      // 铁桶右键使用：桶向准星方向下沉前探并翻倾，0.42 秒一个半正弦弧回位
      if (this.useT > 0) {
        this.useT = Math.max(0, this.useT - dt / 0.42);
      }
      if (this.heldMesh && this.heldBase) {
        const b = this.heldBase;
        let uY = 0, uZ = 0, uRX = 0, uRZ = 0;
        if (this.useT > 0) {
          const p = 1 - this.useT;
          const k = Math.sin(p * Math.PI);   // 0 -> 1（中段峰值）-> 0
          if (this.useKind === "pour") {
            // 倾倒：翻腕（桶口朝准星压低）+ 前伸下沉
            uRZ = -0.62 * k;
            uRX = 0.32 * k;
            uZ = -0.055 * k;
            uY = -0.085 * k;
          } else {
            // 舀取：桶口朝下探入液面后提起
            uRX = 0.55 * k;
            uRZ = -0.18 * k;
            uZ = -0.045 * k;
            uY = -0.10 * k;
          }
        }
        // 枪械开火后坐：枪口上跳 + 向相机方向短促回坐（线性快衰）
        if (this.kickT > 0) {
          uRX += 0.22 * this.kickT;
          uZ += 0.05 * this.kickT;
          uY += 0.008 * this.kickT;
        }
        // 枪械换弹：枪身向内翻侧、枪口下沉并略微落低，半正弦弧回位
        if (this.reloadT > 0) {
          const rp = 1 - this.reloadT;
          const rk = Math.sin(rp * Math.PI);
          uRZ += 0.42 * rk;
          uRX -= 0.30 * rk;
          uY -= 0.05 * rk;
          uZ += 0.02 * rk;
        }
        this.heldMesh.position.set(b.x, b.y + uY, b.z + uZ);
        this.heldMesh.rotation.set(b.rx + uRX, b.ry, b.rz + uRZ);
      }
    },

    /* ---------------- 渲染（世界画完后调用） ---------------- */

    render() {
      if (!this.root.visible) return;
      this.vmCamera.quaternion.copy(this.mainCamera.quaternion);
      // 只清深度，不清颜色：双手叠加在世界画面之上，且永远不被墙遮挡
      const prev = this.renderer.autoClear;
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(this.scene, this.vmCamera);
      this.renderer.autoClear = prev;
    }
  };

  global.ViewModel = ViewModel;
})(window);
