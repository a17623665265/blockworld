/* ============================================================
 * game.js — 游戏入口：渲染器、场景、输入、指针锁定、
 *           体素射线(挖/放方块)、物品栏、粒子、HUD
 * ============================================================ */
(function () {
  "use strict";

  /* ---------------- DOM ---------------- */
  const container = document.getElementById("game-container");
  const overlay = document.getElementById("overlay");
  const loadingEl = document.getElementById("loading");
  const playBtn = document.getElementById("play-btn");
  const saveBtn = document.getElementById("save-btn");
  const exportBtn = document.getElementById("export-btn");
  const newWorldBtn = document.getElementById("new-world-btn");
  const creativeBtn = document.getElementById("creative-btn");
  const cloudBtn = document.getElementById("cloud-btn");
  const saveInfoEl = document.getElementById("save-info");
  // 主菜单「继续游戏」：?load=1 时启动阶段直接应用存档
  const startParams = new URLSearchParams(location.search);
  // 联机启动模式：?host=new 随机新世界开房；?host=save 用当前存档开房；?join=CODE 客人加入
  const netHostMode = startParams.get("host");           // 'new' | 'save' | null
  const netJoinCode = startParams.get("join");           // 6 位房间码 | null
  const cloudBootCode = startParams.get("cloud");        // 云端读档进入后自动绑定该码
  const creativeBoot = startParams.has("creative");      // ?creative=1 新建无敌模式世界
  const isGuestBoot = !!netJoinCode;
  // 可能因世界尺寸变化导致旧档失效，启动时校验方块长度后会置 null（开新世界）
  // 存档在 IndexedDB 中（异步读取）：页面加载即发起，世界生成前 await 完成
  let pendingSave = null;
  let bootSeed = 0;
  // 无敌模式（创造）：不掉血、瞬挖方块不掉落、放置不消耗、工具不耗耐久、E 键创造物品栏无限取用
  let creativeMode = false;
  const needLoadSave = startParams.has("load") || netHostMode === "save";
  const saveReady = (needLoadSave ? SaveSystem.load() : Promise.resolve(null))
    .then(function (s) {
      pendingSave = s || null;
      // 从云端读档跳转进入（?cloud=CODE）：自动恢复绑定，后续保存继续同步到该码
      if (cloudBootCode && CloudSave.isValidCode(cloudBootCode)) CloudSave.bind(cloudBootCode);
      // 世界种子：有旧档用旧档种子（继续游戏世界不变）；
      // 无旧档一律随机新种子——单机首进、主菜单「新世界」、?host=new 开房，
      // 每次生成的大陆 / 山脉 / 群系 / 洞穴布局都不同（客人只是占位，welcome 后被房主种子覆盖）
      bootSeed = (pendingSave && (pendingSave.seed >>> 0))
        ? (pendingSave.seed >>> 0)
        : (((Math.random() * 4294967296) >>> 0) || 1);
    })
    .catch(function (e) {
      console.warn("[Save] 启动读档失败：", e);
      pendingSave = null;
    });
  const crosshair = document.getElementById("crosshair");
  const hintEl = document.getElementById("hint");
  const debugEl = document.getElementById("debug");
  const hotbarEl = document.getElementById("hotbar");
  const craftOverlay = document.getElementById("crafting-overlay");
  const craftGrid = document.getElementById("craft-grid");
  const craftOutput = document.getElementById("craft-output");
  const panelInventory = document.getElementById("panel-inventory");
  const dragItem = document.getElementById("drag-item");
  const recipeList = document.getElementById("recipe-list");
  const recipeToggle = document.getElementById("recipe-toggle");
  const heartsEl = document.getElementById("hearts");
  const hurtFlashEl = document.getElementById("hurt-flash");
  const deathOverlay = document.getElementById("death-overlay");
  const respawnBtn = document.getElementById("respawn-btn");
  const toastEl = document.getElementById("toast");

  /* ---------------- 渲染器 / 场景 ---------------- */
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;  // 电影级色调映射，高光更柔和
  renderer.toneMappingExposure = 1.06;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const SKY_COLOR = 0xcde6ff;      // 地平线颜色（与天空穹顶、雾保持一致）
  const UNDERWATER_COLOR = 0x1e3f8a;
  const LAVA_FOG_COLOR = 0xff5a10;
  scene.background = new THREE.Color(SKY_COLOR);
  scene.fog = new THREE.Fog(SKY_COLOR, 46, 118);

  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 400);
  // FPS 相机约定：先 yaw（绕世界 Y）后 pitch（绕本地 X），与 dirFromPose/房主裁决射线严格一致，
  // 否则斜视角（yaw、pitch 同时非零）下 pickBlock 与 guest act 裁决射线会发散
  camera.rotation.order = "YXZ";

  /* ---------------- 光照 ---------------- */
  const hemi = new THREE.HemisphereLight(0xcfe6ff, 0x5d6b46, 0.62);
  scene.add(hemi);
  const sunLight = new THREE.DirectionalLight(0xffe2b0, 0.68);
  sunLight.position.set(60, 100, 40);
  scene.add(sunLight);
  const ambient = new THREE.AmbientLight(0xffffff, 0.1);
  scene.add(ambient);

  /* ---------------- 渐变天空穹顶（跟随相机） ---------------- */
  const skyDome = createSkyDome();
  scene.add(skyDome);

  function createSkyDome() {
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        zenith: { value: new THREE.Color(0x4f97e8) },
        horizon: { value: new THREE.Color(0xd7ecff) }
      },
      vertexShader:
        "varying vec3 vDir;\n" +
        "void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader:
        "uniform vec3 zenith; uniform vec3 horizon; varying vec3 vDir;\n" +
        "void main(){\n" +
        "  float h = clamp(normalize(vDir).y, 0.0, 1.0);\n" +
        "  vec3 c = mix(horizon, zenith, pow(h, 0.62));\n" +
        "  gl_FragColor = vec4(c, 1.0);\n" +
        "}"
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(320, 24, 12), mat);
    mesh.renderOrder = -1;
    mesh.frustumCulled = false;
    return mesh;
  }

  // 天空中的太阳（纯装饰）
  const sunMesh = new THREE.Mesh(
    new THREE.SphereGeometry(4.5, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xfff2a8, fog: false })
  );
  sunMesh.position.set(-70, 95, -60);
  scene.add(sunMesh);

  /* ---------------- 云（实例化） ---------------- */
  const clouds = createClouds();
  scene.add(clouds);

  function createClouds() {
    const count = 260;
    const geo = new THREE.BoxGeometry(1, 0.7, 1);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.82, fog: false });
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    const rng = mulberry32(7777);
    const m = new THREE.Matrix4();
    let i = 0;
    while (i < count) {
      const cx = -18 + rng() * 132;
      const cz = -18 + rng() * 132;
      const cy = 47 + rng() * 6;
      const pieces = 3 + Math.floor(rng() * 3);
      for (let k = 0; k < pieces && i < count; k++) {
        m.makeTranslation(cx + (rng() - 0.5) * 3, cy + (rng() - 0.5) * 0.8, cz + (rng() - 0.5) * 3);
        mesh.setMatrixAt(i, m);
        i++;
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }

  /* ---------------- 世界 ---------------- */
  const atlas = createAtlasTexture();
  const world = new World(scene, atlas.texture, bootSeed, atlas.emissiveTexture,
                         atlas.lavaTexture, atlas.lavaEmissiveTexture, atlas.waterTexture);
  let player = null;
  let spawnPoint = null;
  let freshWorldSeed = 0;   // 本次启动是全新随机世界时为其种子号，进游戏时提示一次

  /* ---------------- 物品栏方块专属图标 ----------------
   * 部分方块在物品栏里用等距立体图而不是图集里的平面 tile（世界 3D 纹理不受影响）。
   * 图片源是透明底 PNG，这里按槽位 2× DPR 的尺寸高质量缩小成 dataURL，
   * 避免各浏览器对超大背景图最近邻缩小的差异；任何加载失败都静默跳过。
   */
  const BLOCK_ICON_SRC = {};
  BLOCK_ICON_SRC[BLOCK.GRASS] = "assets/grass-block-icon.png?v=20261011b";
  BLOCK_ICON_SRC[BLOCK.DIRT] = "assets/dirt-block-icon.png?v=20261018a";
  BLOCK_ICON_SRC[BLOCK.PLANKS] = "assets/oak-planks-icon.png?v=20261019a";
  BLOCK_ICON_SRC[BLOCK.LOG] = "assets/oak-log-icon.png?v=20261013a";
  BLOCK_ICON_SRC[BLOCK.LEAVES] = "assets/oak-leaves-icon.png?v=20261013a";
  BLOCK_ICON_SRC[BLOCK.BIRCH_LOG] = "assets/birch-log-icon.png?v=20261012a";
  BLOCK_ICON_SRC[BLOCK.CRAFTING_TABLE] = "assets/crafting-table-icon.png?v=20261012a";
  BLOCK_ICON_SRC[BLOCK.FURNACE] = "assets/furnace-block-icon.png?v=20261013a";
  BLOCK_ICON_SRC[BLOCK.COBBLE] = "assets/cobblestone-block-icon.png?v=20261019a";
  // mod 方块注册的等距图标（白桦木板 / 压力板等）合并进同一张表
  const ALL_BLOCK_ICON_SRC = Object.assign({}, BLOCK_ICON_SRC, GameRegistry.blockIconSrc);
  function loadBlockIcons() {
    const icons = {};
    const tasks = Object.keys(ALL_BLOCK_ICON_SRC).map(function (id) {
      return new Promise(function (resolve) {
        const img = new Image();
        img.onload = function () {
          try {
            const H = 128;
            const w = Math.max(1, Math.round(img.naturalWidth * (H / img.naturalHeight)));
            const c = document.createElement("canvas");
            c.width = w; c.height = H;
            const x = c.getContext("2d");
            x.imageSmoothingEnabled = true;
            x.drawImage(img, 0, 0, w, H);
            icons[id] = c.toDataURL("image/png");
          } catch (e) { /* 画布不可用时回退图集 */ }
          resolve();
        };
        img.onerror = resolve;
        img.src = ALL_BLOCK_ICON_SRC[id];
      });
    });
    return Promise.all(tasks).then(function () { return icons; });
  }

  /* ---------------- 本地设置（独立于世界存档，存 localStorage） ---------------- */
  const SETTINGS_KEY = "blockworld_settings_v1";
  const SENS_MIN = 0.3, SENS_MAX = 2.0, SENS_DEFAULT = 1.0;
  function clampSens(v) {
    v = +v;
    if (!isFinite(v)) v = SENS_DEFAULT;
    return Math.max(SENS_MIN, Math.min(SENS_MAX, v));
  }
  const Settings = {
    lookSens: SENS_DEFAULT,
    load() {
      try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (raw) {
          const v = JSON.parse(raw);
          if (v && typeof v.lookSens === "number") this.lookSens = clampSens(v.lookSens);
        }
      } catch (e) { /* 损坏的设置忽略，用默认 */ }
    },
    save() {
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ lookSens: this.lookSens })); }
      catch (e) { /* 隐私模式等写入失败不影响游戏 */ }
    },
    applyLook() { if (player) player.lookSens = this.lookSens; }
  };
  Settings.load();

  // 菜单灵敏度滑杆（主菜单 / 暂停菜单共用；鼠标与右侧触摸拖动都走 player.addLook）
  const sensSlider = document.getElementById("sens-slider");
  const sensValueEl = document.getElementById("sens-value");
  const sensResetBtn = document.getElementById("sens-reset");
  function syncSensUI() {
    const pct = Math.round(Settings.lookSens * 100);
    sensSlider.value = String(pct);
    sensValueEl.textContent = pct + "%";
  }
  sensSlider.addEventListener("input", function () {
    Settings.lookSens = clampSens((+sensSlider.value) / 100);
    sensValueEl.textContent = sensSlider.value + "%";
    Settings.applyLook();    // 游戏中暂停调也立即生效
    Settings.save();
  }, { passive: true });
  sensResetBtn.addEventListener("click", function () {
    Settings.lookSens = SENS_DEFAULT;
    syncSensUI();
    Settings.applyLook();
    Settings.save();
  });
  syncSensUI();

  /* ---------------- 状态 ---------------- */
  // loading -> menu -> playing <-> paused
  let state = "loading";
  const input = { forward: false, back: false, left: false, right: false, jump: false, down: false, sprint: false };
  let lastSpaceTime = 0;
  let thirdPerson = false;   // V 键切换：第一人称 <-> 第三人称

  /* ---------------- 奔跑输入（键盘 + 触屏共用） ----------------
   * 电脑：双击 W（MC 经典）或按住 R 键。刻意不用 Ctrl —— 浏览器里
   * Ctrl+W 是关闭标签页，而奔跑必然与 W 同按。
   * 手机：摇杆向前推满到外圈（无独立跑按钮）。 */
  let sprintDoubleTap = false;  // 双击 W 触发，松开 W 结束
  let sprintKeyHeld = false;    // 按住 R
  let joySprint = false;        // 手机摇杆推满
  let lastWPressTime = 0;
  function syncSprintInput() {
    input.sprint = sprintDoubleTap || sprintKeyHeld || joySprint;
    if (joyZone) joyZone.classList.toggle("sprint", joySprint && state === "playing" && joyId !== null);
  }
  function clearSprintSources() {
    sprintDoubleTap = false; sprintKeyHeld = false; joySprint = false;
    input.sprint = false;
    if (joyZone) joyZone.classList.remove("sprint");
  }

  /* ---------------- 第三人称相机（身后俯视，遇墙回缩） ---------------- */
  const _camFwd = new THREE.Vector3();
  const CAM_BACK = 3.6;      // 相机离眼睛的标准距离
  function applyThirdPersonCamera() {
    camera.getWorldDirection(_camFwd);
    const ex = camera.position.x, ey = camera.position.y, ez = camera.position.z;
    // 目标机位：眼睛正后方，略微抬高
    const dx = -_camFwd.x * CAM_BACK;
    const dy = -_camFwd.y * CAM_BACK + 0.28;
    const dz = -_camFwd.z * CAM_BACK;
    // 从眼睛向目标机位分段探测，相机不穿进实心方块
    const STEPS = 20;
    let f = 1;
    for (let i = 2; i <= STEPS; i++) {
      const t = i / STEPS;
      const px = ex + dx * t, py = ey + dy * t, pz = ez + dz * t;
      if (isSolid(world.getBlock(Math.floor(px), Math.floor(py), Math.floor(pz)))) {
        f = (i - 1) / STEPS;
        break;
      }
    }
    if (f < 1) f = Math.max(0.55 / CAM_BACK, f - 0.22 / CAM_BACK);
    camera.position.set(ex + dx * f, ey + dy * f, ez + dz * f);
  }

  /* ---------------- 选中方块高亮框 ---------------- */
  const highlight = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004)),
    new THREE.LineBasicMaterial({ color: 0x101010, transparent: true, opacity: 0.7 })
  );
  highlight.visible = false;
  scene.add(highlight);

  // 挖掘进度罩：10 档裂纹贴图横排图集，按进度切换档位
  const CRACK_STAGES = 10;
  function makeCrackTexture() {
    const PX = 16;
    const cv = document.createElement("canvas");
    cv.width = PX * CRACK_STAGES;
    cv.height = PX;
    const ctx = cv.getContext("2d");
    // 固定种子的伪随机，保证裂纹形状稳定
    let seed = 1337;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    // 从中心向边缘画一条歪歪扭扭的裂线，中途随机分叉
    const drawVein = (g, angle) => {
      let x = 8 + Math.cos(angle) * 1.5, y = 8 + Math.sin(angle) * 1.5;
      let a = angle;
      ctx.strokeStyle = "rgba(15,15,18,0.92)";
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      const segs = 4 + Math.floor(rnd() * 3);
      for (let k = 0; k < segs; k++) {
        a += (rnd() - 0.5) * 1.1;
        x += Math.cos(a) * (1.4 + rnd() * 1.6);
        y += Math.sin(a) * (1.4 + rnd() * 1.6);
        ctx.lineTo(x, y);
        // 中后段随机分出一条短叉
        if (k >= 1 && rnd() < 0.5) {
          ctx.moveTo(x, y);
          const ba = a + (rnd() < 0.5 ? 1 : -1) * (0.7 + rnd() * 0.7);
          ctx.lineTo(x + Math.cos(ba) * (1.5 + rnd() * 2), y + Math.sin(ba) * (1.5 + rnd() * 2));
          ctx.moveTo(x, y);
        }
      }
      ctx.stroke();
      // 裂纹两侧的碎点
      if (rnd() < 0.8) {
        ctx.fillStyle = "rgba(15,15,18,0.8)";
        ctx.fillRect(Math.floor(x), Math.floor(y), 1, 1);
      }
    };
    for (let s = 0; s < CRACK_STAGES; s++) {
      // 每一档都在自己格子上重画前 s 档积累的全部裂纹
      seed = 9102 + s * 7;
      ctx.save();
      ctx.translate(s * PX, 0);
      const veins = 1 + s;
      for (let i = 0; i < veins; i++) drawVein(s, (i / veins) * Math.PI * 2 + s * 0.35);
      ctx.restore();
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.repeat.set(1 / CRACK_STAGES, 1);
    return tex;
  }
  const crackMesh = new THREE.Mesh(
    new THREE.BoxGeometry(1.004, 1.004, 1.004),
    new THREE.MeshBasicMaterial({
      map: makeCrackTexture(),
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2
    })
  );
  crackMesh.visible = false;
  crackMesh.renderOrder = 3;
  scene.add(crackMesh);

  /* ---------------- 破坏粒子 ---------------- */
  class ParticleSystem {
    constructor(scene, cap) {
      this.cap = cap;
      this.cursor = 0;
      this.life = new Float32Array(cap);
      this.vel = Array.from({ length: cap }, () => new THREE.Vector3());
      this.geo = new THREE.BoxGeometry(0.14, 0.14, 0.14);
      // 破坏碎屑/火星是自发光小颗粒，跳过 ACES，保持原色（否则橙黄火星被压成奶白）
      this.mat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
      this.mesh = new THREE.InstancedMesh(this.geo, this.mat, cap);
      this.dummy = new THREE.Object3D();
      // 先把所有槽位缩放到不可见，避免未使用实例以单位方块显示在原点
      this.dummy.scale.setScalar(0.0001);
      this.dummy.updateMatrix();
      const white = new THREE.Color(0xffffff);
      for (let i = 0; i < cap; i++) {
        this.mesh.setMatrixAt(i, this.dummy.matrix);
        // 必须在首帧渲染前建好 instanceColor，否则着色器按“无实例色”编译后，
        // 后续 burst 写入的颜色不生效，碎屑/火星会一直渲染成白色
        this.mesh.setColorAt(i, white);
      }
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceColor.needsUpdate = true;
      scene.add(this.mesh);
    }
    burst(x, y, z, colorHex) {
      for (let n = 0; n < 9; n++) {
        const i = this.cursor;
        this.cursor = (this.cursor + 1) % this.cap;
        this.life[i] = 0.55 + Math.random() * 0.25;
        this.vel[i].set((Math.random() - 0.5) * 4.5, 2 + Math.random() * 3.5, (Math.random() - 0.5) * 4.5);
        this.dummy.position.set(x + 0.5 + (Math.random() - 0.5) * 0.6,
                                y + 0.5 + (Math.random() - 0.5) * 0.6,
                                z + 0.5 + (Math.random() - 0.5) * 0.6);
        this.dummy.scale.setScalar(1);
        this.dummy.updateMatrix();
        this.mesh.setMatrixAt(i, this.dummy.matrix);
        this.mesh.setColorAt(i, new THREE.Color(colorHex));
      }
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
      this.mesh.instanceMatrix.needsUpdate = true;
    }
    update(dt) {
      let any = false;
      for (let i = 0; i < this.cap; i++) {
        if (this.life[i] <= 0) continue;
        any = true;
        this.life[i] -= dt;
        const v = this.vel[i];
        v.y -= 16 * dt;
        this.dummy.matrix.decompose(this.dummy.position, this.dummy.quaternion, this.dummy.scale);
        this.dummy.position.addScaledVector(v, dt);
        // 简单落地
        const bx = Math.floor(this.dummy.position.x);
        const by = Math.floor(this.dummy.position.y - 0.07);
        const bz = Math.floor(this.dummy.position.z);
        if (this.life[i] > 0 && isSolid(world.getBlock(bx, by, bz))) {
          v.y = Math.abs(v.y) * 0.35;
          v.x *= 0.6; v.z *= 0.6;
          this.dummy.position.y = by + 1.07;
          if (Math.abs(v.y) < 0.6) this.life[i] = Math.min(this.life[i], 0.15);
        }
        if (this.life[i] <= 0) this.dummy.scale.setScalar(0.0001);
        this.dummy.updateMatrix();
        this.mesh.setMatrixAt(i, this.dummy.matrix);
      }
      if (any) this.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  const PARTICLE_COLORS = {};
  PARTICLE_COLORS[BLOCK.GRASS] = 0x536833;
  PARTICLE_COLORS[BLOCK.DIRT] = 0x79553a;
  PARTICLE_COLORS[BLOCK.STONE] = 0x8c8c8c;
  PARTICLE_COLORS[BLOCK.LOG] = 0x6b4c2a;
  PARTICLE_COLORS[BLOCK.BIRCH_LOG] = 0xd9dbd2;
  PARTICLE_COLORS[BLOCK.LEAVES] = 0x2f7d23;
  PARTICLE_COLORS[BLOCK.SAND] = 0xe3d7a0;
  PARTICLE_COLORS[BLOCK.PLANKS] = 0xb8945f;
  PARTICLE_COLORS[BLOCK.COBBLE] = 0x7d7d7d;
  PARTICLE_COLORS[BLOCK.BEDROCK] = 0x4a4a4a;
  PARTICLE_COLORS[BLOCK.CRAFTING_TABLE] = 0x9c7440;
  PARTICLE_COLORS[BLOCK.STONE_BRICKS] = 0x838383;
  PARTICLE_COLORS[BLOCK.SNOW] = 0xf3f7fc;
  PARTICLE_COLORS[BLOCK.ICE] = 0xa7d8ef;
  PARTICLE_COLORS[BLOCK.CACTUS] = 0x3c7a32;
  PARTICLE_COLORS[BLOCK.BASALT] = 0x3c3a42;
  PARTICLE_COLORS[BLOCK.LAVA] = 0xff6b1c;
  PARTICLE_COLORS[BLOCK.FLOW_LAVA] = 0xff6b1c;
  PARTICLE_COLORS[BLOCK.FLOW_LAVA_2] = 0xff5a14;
  PARTICLE_COLORS[BLOCK.FLOW_LAVA_3] = 0xee4a0e;
  PARTICLE_COLORS[BLOCK.SANDSTONE] = 0xd9c98e;
  PARTICLE_COLORS[BLOCK.COAL_ORE] = 0x2c2c33;
  PARTICLE_COLORS[BLOCK.IRON_ORE] = 0xb98a5a;
  PARTICLE_COLORS[BLOCK.FURNACE] = 0x6f6f6f;
  PARTICLE_COLORS[BLOCK.TORCH] = 0xffa03a;
  // 合并 mod 方块的粒子色（白桦木板 / 压力板等）
  Object.assign(PARTICLE_COLORS, GameRegistry.particleColors);

  const particles = new ParticleSystem(scene, 192);

  /* ---------------- 合成面板状态机 ---------------- */
  // playing -> crafting(打开背包/工作台) -> playing
  let panelMode = null; // null | "inventory" | "table"

  function openPanel(mode) {
    if (state !== "playing") return;
    panelMode = mode;
    state = "crafting";
    crosshair.style.display = "none";
    hintEl.style.display = "none";
    if (document.pointerLockElement === renderer.domElement) {
      document.exitPointerLock();   // 解锁后由 pointerlockchange 收尾(不弹暂停)
    }
    Crafting.show(mode);
    input.forward = input.back = input.left = input.right = input.jump = input.down = false;
    clearSprintSources();
    syncTouchClass();
  }

  function closePanel() {
    if (state !== "crafting") return;
    Crafting.hide();
    panelMode = null;
    if (inNoLock) {
      state = "playing";
      crosshair.style.display = "block";
      hintEl.style.display = "block";
    } else {
      requestLock();   // 锁定成功后 pointerlockchange 会把 state 置回 playing
    }
    syncTouchClass();
  }

  Crafting.onCloseRequest = closePanel;
  Crafting.onToast = showToast;

  /* ---------------- 熔炉面板状态机 ---------------- */
  // playing -> furnace（右键熔炉）-> playing，与合成面板平行

  function openFurnace() {
    if (state !== "playing") return;
    state = "furnace";
    crosshair.style.display = "none";
    hintEl.style.display = "none";
    if (document.pointerLockElement === renderer.domElement) {
      document.exitPointerLock();   // 解锁后由 pointerlockchange 收尾（不弹暂停）
    }
    Furnace.show();
    input.forward = input.back = input.left = input.right = input.jump = input.down = false;
    clearSprintSources();
    syncTouchClass();
  }

  function closeFurnace() {
    if (state !== "furnace") return;
    Furnace.hide();
    if (inNoLock) {
      state = "playing";
      crosshair.style.display = "block";
      hintEl.style.display = "block";
    } else {
      requestLock();   // 锁定成功后 pointerlockchange 置回 playing
    }
    syncTouchClass();
  }

  Furnace.onCloseRequest = closeFurnace;

  /* ---------------- 储物箱面板状态机 ---------------- */
  // playing -> chest（右键储物箱，mod 交互钩子调 Chest.openAt）-> playing

  function openChest() {
    if (state !== "playing") return;
    state = "chest";
    crosshair.style.display = "none";
    hintEl.style.display = "none";
    if (document.pointerLockElement === renderer.domElement) {
      document.exitPointerLock();
    }
    Chest.show();
    input.forward = input.back = input.left = input.right = input.jump = input.down = false;
    clearSprintSources();
    syncTouchClass();
  }

  function closeChest() {
    if (state !== "chest") return;
    Chest.hide();
    if (inNoLock) {
      state = "playing";
      crosshair.style.display = "block";
      hintEl.style.display = "block";
    } else {
      requestLock();
    }
    syncTouchClass();
  }

  Chest.onOpenRequest = openChest;
  Chest.onCloseRequest = closeChest;
  Chest.onToast = showToast;

  /* ---------------- 枪械工作台面板状态机 ---------------- */
  // playing -> gunbench（右键枪械工作台）-> playing，与熔炉面板平行

  function openGunbench() {
    if (state !== "playing") return;
    state = "gunbench";
    crosshair.style.display = "none";
    hintEl.style.display = "none";
    if (document.pointerLockElement === renderer.domElement) {
      document.exitPointerLock();   // 解锁后由 pointerlockchange 收尾（不弹暂停）
    }
    GunBench.show();
    input.forward = input.back = input.left = input.right = input.jump = input.down = false;
    clearSprintSources();
    syncTouchClass();
  }

  function closeGunbench() {
    if (state !== "gunbench") return;
    GunBench.hide();
    if (inNoLock) {
      state = "playing";
      crosshair.style.display = "block";
      hintEl.style.display = "block";
    } else {
      requestLock();   // 锁定成功后 pointerlockchange 置回 playing
    }
    syncTouchClass();
  }

  GunBench.onOpenRequest = openGunbench;
  GunBench.onCloseRequest = closeGunbench;
  GunBench.onToast = showToast;

  // 挖 / 放 / 攻击时：第一人称的双手与第三人称的 3D 身体一起挥手
  function armSwing() {
    ViewModel.swing();
    PlayerModel.swing();
    localSwingPulse = true;   // 联机：下一拍 pp 带给对方化身
  }

  /* ---------------- 体素 DDA 射线 ---------------- */
  // 方块交互（挖掘 / 放置 / 准星高亮）的最远距离：5 格。
  // 近战攻击 3.6 格、手枪 20 格各有独立判定，不在此列。
  const REACH_DIST = 5;
  const _dir = new THREE.Vector3();
  // 准星射线永远从玩家眼睛出发（第三人称相机虽在身后，方向一致）
  const eyePos = new THREE.Vector3();
  // 联机：房主为客人裁决动作时，从客人上报的眼位/朝向重跑同一条 DDA
  // hitBedrock：无敌模式下准星可以选中基岩（创造可清除世界底层）；
  // 房主为客人裁决时永不为 true（客人不启用无敌模式）
  function raycastVoxel(ox, oy, oz, dx, dy, dz, maxDist, hitBedrock) {
    let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    const tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity;
    let tx = dx > 0 ? (x + 1 - ox) * tdx : dx < 0 ? (ox - x) * tdx : Infinity;
    let ty = dy > 0 ? (y + 1 - oy) * tdy : dy < 0 ? (oy - y) * tdy : Infinity;
    let tz = dz > 0 ? (z + 1 - oz) * tdz : dz < 0 ? (oz - z) * tdz : Infinity;

    let nx = 0, ny = 0, nz = 0;
    let t = 0;
    let liq = null;   // 射线沿途遇到的第一个液体（水/岩浆），供铁桶等物品使用
    while (t <= maxDist) {
      const b = world.getBlock(x, y, z);
      if (b !== BLOCK.AIR && b !== BLOCK.WATER && !isLava(b) && (hitBedrock || b !== BLOCK.BEDROCK)) {
        return { x: x, y: y, z: z, nx: nx, ny: ny, nz: nz, id: b, t: t, liq: liq };
      }
      // 液体不阻挡选取（后面的固体照常命中），但记录准星方向上的第一格液体
      if (!liq && (b === BLOCK.WATER || isLava(b))) {
        liq = { x: x, y: y, z: z, id: b };
      }
      if (tx < ty && tx < tz) {
        t = tx; tx += tdx; x += stepX; nx = -stepX; ny = 0; nz = 0;
      } else if (ty < tz) {
        t = ty; ty += tdy; y += stepY; nx = 0; ny = -stepY; nz = 0;
      } else {
        t = tz; tz += tdz; z += stepZ; nx = 0; ny = 0; nz = -stepZ;
      }
    }
    return null;
  }

  function pickBlock(maxDist) {
    camera.getWorldDirection(_dir);
    // 无敌模式：基岩也可被准星选中（瞬挖清除）
    return raycastVoxel(eyePos.x, eyePos.y, eyePos.z, _dir.x, _dir.y, _dir.z, maxDist, creativeMode);
  }

  // 由 yaw/pitch 求视线单位方向（与相机 YXZ 约定一致：yaw=0 朝 -z）
  function dirFromPose(yaw, pitch, out) {
    const cp = Math.cos(pitch);
    return out.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
  }

  function updateHighlight() {
    if (state !== "playing") { highlight.visible = false; return; }
    const hit = pickBlock(REACH_DIST);
    if (hit) {
      highlight.visible = true;
      highlight.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
    } else {
      highlight.visible = false;
    }
  }

  /* ================================================================
   * Task 5：玩法动作权威化（Actor 模型 + doDig/doUse + act RPC）
   * - localActor：真实 player + 真实 Crafting，单机与房主共用；
   * - guestActor（仅房主端）：fakePlayer 数据 + GuestInventory 影子背包，
   *   客人只发 act，房主以客人上报眼位/朝向重跑 DDA（≤5 格）裁决执行，
   *   背包每次动作后发 inv 全量纠正，方块变更经 Task 4 的 blk 自动广播。
   * ================================================================ */

  /* ---- 房主端：客人的影子背包（纯数据；方法与 Crafting 对齐，无 DOM） ---- */
  function GuestInventory() {
    this.inventory = new Array(Crafting.SLOTS).fill(null);
    this.selected = 0;
    this.armor = { head: null, chest: null, legs: null, back: null };
    this.bagSlots = new Array(Crafting.bagSlots.length).fill(null);
    this.lastBroken = null;
    STARTER_ITEMS.forEach(it => this.addItem(it.id, it.count));
  }
  GuestInventory.prototype.makeStack = function (id, count, dur) {
    return Crafting.makeStack(id, count, dur);
  };
  GuestInventory.prototype.hasBag = function () { return !!this.armor.back; };
  GuestInventory.prototype.storagePools = function () {
    const pools = [this.inventory];
    if (this.hasBag()) pools.push(this.bagSlots);
    return pools;
  };
  GuestInventory.prototype.addItem = function (id, count, dur) {
    let left = count;
    const pools = this.storagePools();
    for (const arr of pools) {
      for (let i = 0; i < arr.length && left > 0; i++) {
        const s = arr[i];
        if (s && s.id === id) {
          const move = Math.min(maxStackOf(id) - s.count, left);
          if (move > 0) { s.count += move; left -= move; }
        }
      }
    }
    for (const arr of pools) {
      for (let i = 0; i < arr.length && left > 0; i++) {
        if (!arr[i]) {
          const move = Math.min(maxStackOf(id), left);
          arr[i] = this.makeStack(id, move, dur);
          left -= move;
        }
      }
    }
    return count - left;
  };
  GuestInventory.prototype.roomFor = function (id, count) {
    let left = count;
    for (const arr of this.storagePools()) {
      for (let i = 0; i < arr.length && left > 0; i++) {
        const s = arr[i];
        if (s && s.id === id) left -= Math.max(0, maxStackOf(id) - s.count);
        else if (!s) left -= maxStackOf(id);
      }
    }
    return left <= 0;
  };
  GuestInventory.prototype.getHeld = function () { return this.inventory[this.selected]; };
  GuestInventory.prototype.getHeldId = function () {
    const h = this.inventory[this.selected];
    return h ? h.id : 0;
  };
  GuestInventory.prototype.consumeHeld = function (n) {
    const s = this.inventory[this.selected];
    if (!s) return;
    s.count -= (n || 1);
    if (s.count <= 0) this.inventory[this.selected] = null;
  };
  GuestInventory.prototype.damageHeld = function (n) {
    const s = this.inventory[this.selected];
    if (!s || s.dur == null) return false;
    s.dur -= (n || 1);
    if (s.dur <= 0) {
      this.lastBroken = getItemName(s.id);
      this.inventory[this.selected] = null;
      return true;
    }
    return false;
  };
  GuestInventory.prototype.replaceHeld = function (id) {
    this.inventory[this.selected] = this.makeStack(id, 1);
  };
  GuestInventory.prototype.select = function (i) {
    const n = Crafting.SLOTS;
    this.selected = ((i % n) + n) % n;
  };
  GuestInventory.prototype.totalDefense = function () {
    let d = 0;
    ["head", "chest", "legs", "back"].forEach(k => {
      if (this.armor[k]) d += armorDefenseOf(this.armor[k].id);
    });
    return d;
  };
  GuestInventory.prototype.serialize = function () {
    const plain = arr => arr.map(s => {
      if (!s) return null;
      const o = { id: s.id, count: s.count };
      if (s.dur != null) o.dur = s.dur;
      return o;
    });
    const armor = {};
    ["head", "chest", "legs", "back"].forEach(k => {
      armor[k] = this.armor[k] ? { id: this.armor[k].id, count: 1 } : null;
    });
    return { sel: this.selected, inv: plain(this.inventory), armor: armor, bag: plain(this.bagSlots) };
  };

  /* ---- 房主端：客人执行者（pos/yaw/pitch 在 Task 6 起由 pp 包持续驱动） ---- */
  let guestActor = null;
  let hostGuestOnline = false;
  // 客人死亡态：true 期间忽略其一切 act/pp，掉落物不收进影子背包；
  // guestRespawning：等客人应用房主下发的重生位后，首个重生点附近 pp 才恢复化身
  let guestDead = false;
  let guestRespawning = false;
  const guestRespawnPoint = new THREE.Vector3();
  let guestHurtInvuln = 0;      // 房主侧：客人受击 0.6s 无敌帧
  let guestHurtSentAt = -10;    // 房主侧：最近一次下发 gh 的时间（抑制迟到 pp 回写旧血量）

  // 死亡散落：把一套库存（房主本人 Crafting 或客人影子 GuestInventory）的
  // 快捷栏 / 皮革背包扩展格 / 护甲全部在死亡位置弹成世界掉落物。房主端生成，
  // 经 ea/es 自动同步给客人；随后由调用方清空槽位
  function scatterGearAt(store, pos) {
    const bx = Math.floor(pos.x), by = Math.floor(pos.y), bz = Math.floor(pos.z);
    const pop = function (s) {
      if (!s) return;
      Mobs.spawnBlockDrop(s.id, bx, by, bz, {
        count: s.count || 1,
        dur: s.dur == null ? null : s.dur
      });
    };
    for (let i = 0; i < store.inventory.length; i++) {
      pop(store.inventory[i]);
      store.inventory[i] = null;
    }
    for (let i = 0; i < store.bagSlots.length; i++) {
      pop(store.bagSlots[i]);
      store.bagSlots[i] = null;
    }
    // 背包本体（back）最后掉：先倒空扩展格再掉背包，顺序上与手动卸下一致
    ["head", "chest", "legs", "back"].forEach(k => {
      const s = store.armor[k];
      if (s) { pop(s); store.armor[k] = null; }
    });
  }

  function sendGuestInv() {
    if (guestActor && Net.isHost()) Net.send(Object.assign({ t: "inv" }, guestActor.inv.serialize()));
  }
  function sendGuestToast(msg) {
    if (Net.isHost()) Net.send({ t: "toast", msg: String(msg) });
  }

  // 客人掉落物入包后同一帧只补发一次 inv 纠正（一摊掉落物可能同帧捡好几件）
  let guestInvDirty = false;
  function flushGuestInv() {
    if (!guestInvDirty) return;
    guestInvDirty = false;
    sendGuestInv();
  }
  // 掉落物收集者列表（交给 Mobs.update）：房主本人 + 已就绪的客人影子。
  // 客人在房主端只是影子，磁吸/拾取全部房主权威裁决，结果靠 es/ea + inv 回流
  function makeDropCollectors(localPos) {
    const list = [{
      pos: localPos,
      roomFor: function (id, n) { return Crafting.roomFor(id, n); },
      take: function (id, n, dur) { Crafting.addItem(id, n, dur); }
    }];
    if (Net.isHost() && hostGuestOnline && guestReady && guestActor && !guestDead) {
      list.push({
        pos: guestActor.pos,
        roomFor: function (id, n) { return guestActor.roomFor(id, n); },
        take: function (id, n, dur) {
          guestActor.addItem(id, n, dur);
          guestInvDirty = true;
        }
      });
    }
    return list;
  }

  // Boss / 敌对生物目标列表：房主本人 + 在线客人影子。
  // 本地目标受击走 hurtPlayer（本地结算护甲）；客人目标走 hostHurtGuest（房主权威）
  function makeMobTargets(localPos) {
    const list = [{
      id: 0,
      pos: localPos || player.pos,
      hurt: function (n, attacker) { return hurtPlayer(n, attacker); }
    }];
    if (Net.isHost() && hostGuestOnline && guestReady && guestActor && !guestDead) {
      list.push({
        id: 1,
        pos: guestActor.pos,
        hurt: function (n, attacker) { return hostHurtGuest(n, attacker); }
      });
    }
    return list;
  }

  function makeGuestActor() {
    const inv = new GuestInventory();
    return {
      isGuest: true,
      inv: inv,
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      hp: HP_MAX,    // 房主侧影子血量：怪物/Boss 伤害房主权威结算，脱战回血由 pp.hp 回流
      yaw: 0, pitch: 0,
      width: 0.6, height: 1.8, eyeHeight: 1.62,
      flying: false, eyeInWater: false,
      getHeld: () => inv.getHeld(),
      getHeldId: () => inv.getHeldId(),
      addItem: (id, n, dur) => inv.addItem(id, n, dur),
      roomFor: (id, n) => inv.roomFor(id, n),
      consumeHeld: n => inv.consumeHeld(n),
      damageHeld: n => {
        const broken = inv.damageHeld(n);
        if (broken && inv.lastBroken) sendGuestToast("你的" + inv.lastBroken + "已损坏！");
        return broken;
      },
      replaceHeld: id => inv.replaceHeld(id),
      totalDefense: () => inv.totalDefense(),
      select: i => inv.select(i),
      swing: function () { if (remoteAvatar && remoteAvatar.live) remoteAvatar.model.swing(); },
      toast: function (msg) { sendGuestToast(msg); },
      openUI: function (kind, data) {
        data = data || {};
        Net.send({ t: "open", kind: kind, x: data.x | 0, y: data.y | 0, z: data.z | 0 });
      },
      trySleep: function () { return actorTrySleep(this); }
    };
  }

  /* ---- 本地玩家执行者 ---- */
  const localActor = {
    isGuest: false,
    get pos() { return player.pos; },
    get vel() { return player.vel; },
    get yaw() { return player.yaw; },
    get pitch() { return player.pitch; },
    get width() { return player.width; },
    get height() { return player.height; },
    get eyeHeight() { return player.eyeHeight; },
    get eyeInWater() { return player.eyeInWater; },
    get flying() { return !!player.flying; },
    getHeld: () => Crafting.getHeld(),
    getHeldId: () => Crafting.getHeldId(),
    addItem: (id, n, dur) => Crafting.addItem(id, n, dur),
    roomFor: (id, n) => Crafting.roomFor(id, n),
    consumeHeld: n => Crafting.consumeHeld(n),
    damageHeld: n => {
      const broken = Crafting.damageHeld(n);
      if (broken && Crafting.lastBroken) showToast("你的" + Crafting.lastBroken + "已损坏！");
      return broken;
    },
    replaceHeld: id => {
      Crafting.inventory[Crafting.selected] = Crafting.makeStack(id, 1);
      Crafting.renderAll();
    },
    totalDefense: () => Crafting.totalDefense(),
    select: i => Crafting.select(i),
    swing: armSwing,
    toast: function (msg) { showToast(msg); },
    openUI: function (kind, data) { openUILocal(kind, data || {}); },
    trySleep: function () { return actorTrySleep(this); }
  };

  function actorEye(actor, out) {
    return out.set(actor.pos.x, actor.pos.y + actor.eyeHeight, actor.pos.z);
  }

  function actorOverlaps(actor, bx, by, bz) {
    const hw = actor.width / 2, p = actor.pos;
    return (p.x + hw > bx && p.x - hw < bx + 1 &&
            p.z + hw > bz && p.z - hw < bz + 1 &&
            p.y + actor.height > by && p.y < by + 1);
  }
  function blockOverlapsPlayer(bx, by, bz) { return actorOverlaps(localActor, bx, by, bz); }

  // 床：夜晚睡觉直接跳到清晨（Task 11 起房主把 wx 变化广播给客人）
  function actorTrySleep(actor) {
    if (!Weather.isNight) { actor.toast("现在不是夜晚，睡不着"); return false; }
    Weather.phase = 0;
    actor.toast("你睡了一觉，天亮了");
    return true;
  }
  function trySleep() { return localActor.trySleep(); }

  function openUILocal(kind, data) {
    if (kind === "table") openPanel("table");
    else if (kind === "furnace") openFurnace();
    else if (kind === "gunbench") openGunbench();
    else if (kind === "chest") Chest.openAt(data.x, data.y, data.z);
  }

  /* ---------------- 挖 ---------------- */
  function doDig(actor, hit) {
    if (!hit) return false;
    const held = actor.getHeldId();
    // 若被挖方块正上方插着火把，火把失去支撑一起挖落
    const hadTorch = world.getBlock(hit.x, hit.y + 1, hit.z) === BLOCK.TORCH;
    world.setBlock(hit.x, hit.y, hit.z, BLOCK.AIR);
    if (hadTorch) world.setBlock(hit.x, hit.y + 1, hit.z, BLOCK.AIR);
    // mod 破坏钩子（门上下半联动、小麦收割、储物箱掉落等，可返回额外掉落物 id）
    // spawnDrop：在被破坏方块位置生成世界掉落物（整堆数量/工具耐久透传），
    // 由 updateDrops 统一裁决磁吸拾取，背包满时留在地上，不直接入包、不丢失
    let hookDrop = null;
    const bh = GameRegistry.breakHooks[hit.id];
    if (bh) {
      hookDrop = bh({
        x: hit.x, y: hit.y, z: hit.z, id: hit.id, world: world,
        // 无敌模式：钩子的结构联动照常（门上下半等），但任何掉落通道都不给物品
        addItem: (id, n, dur) => { if (!creativeMode) actor.addItem(id, n, dur); },
        spawnDrop: (id, n, dur) => { if (!creativeMode) Mobs.spawnBlockDrop(id, hit.x, hit.y, hit.z, { count: n || 1, dur: dur }); },
        toast: msg => actor.toast(msg)
      });
    }
    world.remeshAround(hit.x, hit.z);
    // 挖开方块：若上方/旁边是岩浆，立刻触发流动判定
    world.notifyLava(hit.x, hit.y, hit.z);
    // 掉落物在被挖方块处弹出世界实体（石头类需要手持镐，铁矿必须石镐）：
    // 走近自动磁吸入包；背包已满时掉落物留在地上（保留 5 分钟），不会凭空消失。
    // 无敌模式：方块直接消失不掉落（材料无限，从创造物品栏取）
    const drop = creativeMode ? null : (hookDrop || getBlockDrop(hit.id, held));
    if (drop) {
      if (!actor.roomFor(drop, 1)) actor.toast("背包已满，物品掉落在地");
      Mobs.spawnBlockDrop(drop, hit.x, hit.y, hit.z);
    }
    if (hadTorch && !creativeMode) Mobs.spawnBlockDrop(BLOCK.TORCH, hit.x, hit.y + 1, hit.z);
    particles.burst(hit.x, hit.y, hit.z, PARTICLE_COLORS[hit.id] || 0x888888);
    if (hadTorch) particles.burst(hit.x, hit.y + 1, hit.z, 0xffa03a);
    // 用镐 / 斧挖掘消耗 1 点耐久，归零工具损坏（无敌模式工具永不磨损）
    if (!creativeMode && (pickLevelOf(held) > 0 || isAxe(held))) actor.damageHeld(1);
    markTorchLightsDirty();
    actor.swing();
    if (actor.isGuest) sendGuestInv();
    return true;
  }

  /* ---------------- 右键：交互 / 使用 / 放置 ---------------- */
  function doUse(actor, hit) {
    if (!hit) return false;
    // 房主为客人执行时：失败要给 toast 纠正；单机路径保持原来的静默
    const deny = actor.isGuest ? (msg => { actor.toast(msg); return false; }) : (() => false);
    // 右键工作台 -> 打开 3x3 合成，而不是放置方块
    if (hit.id === BLOCK.CRAFTING_TABLE) { actor.openUI("table", hit); actor.swing(); return true; }
    // 右键熔炉 -> 打开烧炼面板
    if (hit.id === BLOCK.FURNACE) { actor.openUI("furnace", hit); actor.swing(); return true; }
    // mod 方块交互（门/栅门/窗、床睡觉、储物箱等），handled 则不再放置
    const inter = GameRegistry.interactions[hit.id];
    if (inter) {
      const handled = inter({
        x: hit.x, y: hit.y, z: hit.z, id: hit.id, world: world,
        held: actor.getHeld(), yaw: actor.yaw,
        sleep: function () { return actor.trySleep(); },
        remesh: function () { world.remeshAround(hit.x, hit.z); },
        addItem: (id, n, dur) => actor.addItem(id, n, dur),
        toast: msg => actor.toast(msg),
        openUI: function (kind, data) {
          actor.openUI(kind, Object.assign({ x: hit.x, y: hit.y, z: hit.z }, data || {}));
        }
      });
      if (handled) {
        actor.swing();
        if (actor.isGuest) sendGuestInv();
        return true;
      }
    }
    const held = actor.getHeld();
    if (!held) {
      // 客人空手右键：明确拒绝并回背包快照；房主/单机保持原来的静默
      if (actor.isGuest) { actor.toast("手中没有可使用的物品"); sendGuestInv(); }
      return false;
    }
    const tx = hit.x + hit.nx, ty = hit.y + hit.ny, tz = hit.z + hit.nz;
    if (!world.inBounds(tx, ty, tz)) return deny("目标超出世界范围");
    const cur = world.getBlock(tx, ty, tz);
    // mod 放置/使用钩子（门放置、锄头耕地、种子播种、铁桶装倒等）优先判定，
    // 必须在 isPlaceable 之前：种子/锄头是物品 id，默认不可放置
    const ph = GameRegistry.placeHooks[held.id];
    if (ph) {
      const placed = ph({
        hit: hit, tx: tx, ty: ty, tz: tz, cur: cur, world: world, held: held,
        liquid: hit.liq || null,   // 准星沿途第一格液体（铁桶装取），无则 null
        yaw: actor.yaw,
        // 无敌模式：种子 / 门等放置不消耗，锄头不耗耐久，铁桶装倒后手中桶不变（无限水源）
        consume: function (n) { if (!creativeMode) actor.consumeHeld(n || 1); },
        damageTool: function (n) { if (!creativeMode) return actor.damageHeld(n || 1); return false; },
        remesh: function () { world.remeshAround(tx, tz); },
        markLights: markTorchLightsDirty,
        overlapsPlayer: (bx, by, bz) => actorOverlaps(actor, bx, by, bz),
        replaceHeld: id => { if (!creativeMode) actor.replaceHeld(id); },
        addItem: (id, n, dur) => actor.addItem(id, n, dur),
        toast: msg => actor.toast(msg)
      });
      if (placed) {
        actor.swing();
        if (!actor.isGuest) ViewModel.use(held.id);
        if (actor.isGuest) sendGuestInv();
      } else if (actor.isGuest) {
        sendGuestInv();   // 钩子判定失败（如桶里没有液体）：回快照纠正
      }
      return placed;
    }
    if (!isPlaceable(held.id)) { if (actor.isGuest) sendGuestInv(); return false; }
    // 火把：只能插在空气里、下方必须有实心方块托着
    if (held.id === BLOCK.TORCH) {
      if (cur !== BLOCK.AIR) return deny("此处无法放置火把");
      if (!isSolid(world.getBlock(tx, ty - 1, tz))) return deny("火把下方需要有方块托着");
      world.setBlock(tx, ty, tz, BLOCK.TORCH);
      world.remeshAround(tx, tz);
      if (!creativeMode) actor.consumeHeld(1);
      markTorchLightsDirty();
      actor.swing();
      if (actor.isGuest) sendGuestInv();
      return true;
    }
    if (cur !== BLOCK.AIR && cur !== BLOCK.WATER) return deny("此处已有方块");
    // 不能把方块放在自己（或另一名玩家）身上
    if (actorOverlaps(actor, tx, ty, tz)) return deny("此处没有放置空间");
    // 熔炉正面朝向放置者（meta 存正面 FACES 索引）
    let placeMeta;
    if (held.id === BLOCK.FURNACE) {
      const fdx = actor.pos.x - (tx + 0.5), fdz = actor.pos.z - (tz + 0.5);
      placeMeta = Math.abs(fdx) >= Math.abs(fdz)
        ? (fdx >= 0 ? 1 : 0)   // +x / -x
        : (fdz >= 0 ? 5 : 4);  // +z / -z
    }
    world.setBlock(tx, ty, tz, held.id, placeMeta);
    world.remeshAround(tx, tz);
    // 填回方块：通知附近岩浆重新判定流向（可能断流回收）
    world.notifyLava(tx, ty, tz);
    if (!creativeMode) actor.consumeHeld(1);   // 无敌模式无限放置
    if (GameRegistry.lightBlocks[held.id]) markTorchLightsDirty();
    actor.swing();
    if (actor.isGuest) sendGuestInv();
    return true;
  }

  /* ---- 本地入口：客人页面改发 act，由房主裁决；单机/房主直接执行 ---- */
  let guestActSeq = 0;
  function guestPosePacket() {
    return {
      p: [eyePos.x, eyePos.y, eyePos.z],
      yaw: player.yaw, pitch: player.pitch,
      sel: Crafting.selected
    };
  }
  function finishDig(hit) {
    if (Net.isGuest()) {
      if (!guestLoaded) return;
      armSwing();   // 客人本地即时挥动反馈（世界变化等房主 blk 回执）
      Net.send({ t: "act", seq: ++guestActSeq, kind: "dig",
                 x: hit.x, y: hit.y, z: hit.z, pose: guestPosePacket() });
      return;
    }
    doDig(localActor, hit);
  }
  function requestUse(hit) {
    if (Net.isGuest()) {
      if (!guestLoaded) return;
      armSwing();
      const held = Crafting.getHeld();
      if (held) ViewModel.use(held.id);
      Net.send({ t: "act", seq: ++guestActSeq, kind: "use",
                 x: hit.x, y: hit.y, z: hit.z,
                 nx: hit.nx, ny: hit.ny, nz: hit.nz, pose: guestPosePacket() });
      return;
    }
    doUse(localActor, hit);
  }
  // 客人切换手持栏位：轻量 sel 意图（act 包的 pose.sel 也会持续兜底）
  function notifyGuestSelect() {
    if (Net.isGuest() && guestLoaded) {
      Net.send({ t: "act", seq: ++guestActSeq, kind: "sel", sel: Crafting.selected });
    }
  }

  /* ---- 物品丢弃（电脑 Q 键 / 手机「丢」按钮；客人发 act 由房主裁决） ---- */

  let lastDropAt = 0;
  const DROP_COOLDOWN = 220;   // 长按 Q / 连点按钮的节流（毫秒）

  // 在执行者眼位按视角方向把物品抛进世界（整堆只生成一个掉落物实体）
  function spawnWorldDrop(actor, id, count, dur) {
    actorEye(actor, _gvEye);
    dirFromPose(actor.yaw, actor.pitch, _gvDir);
    Mobs.spawnPlayerDrop(id, count, dur, _gvEye, _gvDir);
    actor.swing();
  }

  // 丢出当前手持格 1 个；返回是否真的有东西可丢
  function doDropHeld(actor) {
    const held = actor.getHeld();
    if (!held) return false;
    const id = held.id;
    const dur = held.dur == null ? null : held.dur;
    // 本地玩家丢弃手枪：枪内已装子弹先退回背包（客人库存由房主裁决，二期射击再处理）
    if (!actor.isGuest && window.GunMod && id === window.GunMod.pistol
        && !creativeMode && (held.ammo | 0) > 0) {
      Crafting.addItem(window.GunMod.bullet, held.ammo);
      held.ammo = 0;
    }
    actor.consumeHeld(1);
    // 无敌模式：物品随时可再从创造物品栏领取，丢弃即消失，不在世界留下掉落物
    if (!creativeMode) spawnWorldDrop(actor, id, 1, dur);
    if (actor.isGuest) sendGuestInv();
    return true;
  }

  function dropHeld() {
    if (state !== "playing") return;
    const now = performance.now();
    if (now - lastDropAt < DROP_COOLDOWN) return;
    lastDropAt = now;
    if (Net.isGuest()) {
      if (!guestLoaded) return;
      armSwing();   // 客人本地挥手反馈，世界变化等房主 ea/es + inv 回流
      Net.send({ t: "act", seq: ++guestActSeq, kind: "drop", pose: guestPosePacket() });
      return;
    }
    doDropHeld(localActor);
  }

  // 面板里光标抓着整堆物品时点遮罩空白处 / 按 Q：整堆丢到地上
  function requestCursorDrop() {
    const c = Crafting.cursor;
    if (!c) return;
    const id = c.id, n = c.count, dur = c.dur == null ? null : c.dur;
    if (Net.isGuest()) {
      if (!guestLoaded) return;
      Net.send({ t: "act", seq: ++guestActSeq, kind: "dropcur",
                 id: id, n: n, dur: dur, pose: guestPosePacket() });
    } else if (!creativeMode) {
      spawnWorldDrop(localActor, id, n, dur);
    }
    Crafting.cursor = null;
    Crafting.renderAll();
  }

  // 房主侧：从客人影子库存中移除 count 个 id（先核验总数，防伪造）。
  // 返回 {ok, dur}，工具类取被移除堆的实际耐久
  function hostGuestRemove(inv, id, count) {
    const pools = inv.storagePools();
    let have = 0;
    for (const arr of pools)
      for (const s of arr) if (s && s.id === id) have += s.count;
    if (have < count) return { ok: false, dur: null };
    let left = count, dur = null;
    for (const arr of pools) {
      for (let i = arr.length - 1; i >= 0 && left > 0; i--) {
        const s = arr[i];
        if (!s || s.id !== id) continue;
        if (dur === null && s.dur != null) dur = s.dur;
        const take = Math.min(s.count, left);
        s.count -= take;
        left -= take;
        if (s.count <= 0) arr[i] = null;
      }
    }
    return { ok: true, dur: dur };
  }

  // 调试 / 兼容入口：直接挖掉准星方块
  function breakBlock() {
    const hit = pickBlock(REACH_DIST);
    if (hit) finishDig(hit);
  }
  function placeBlock() {
    const hit = pickBlock(REACH_DIST);
    if (hit) requestUse(hit);
  }

  /* ---- 长按挖掘状态机（泥土快、石头慢，按工具硬度表计时） ---- */
  let mining = false;
  let mineKey = null;
  let mineProg = 0;
  // 房主端广播挖掘裂纹的去重状态（仅档位变化时发，每块至多 10 包）
  let hostMineKey = null;
  let hostMineStage = -1;
  function hostBroadcastMine(hit, stage) {
    if (!(Net.isHost() && hostGuestOnline)) return;
    if (hit) Net.send({ t: "mine", x: hit.x, y: hit.y, z: hit.z, s: stage });
    else Net.send({ t: "mine", s: stage });
  }
  function hostClearMine() {
    if (hostMineKey !== null) {
      hostMineKey = null;
      hostMineStage = -1;
      hostBroadcastMine(null, 10);
    }
  }

  function stopMining() {
    mining = false;
    mineKey = null;
    mineProg = 0;
    crackMesh.visible = false;
    hostClearMine();
  }

  function startAttack() {
    if (state !== "playing") return;
    // 手持手枪：左键 = 扣扳机（半自动，每按一发），不进入挖掘状态机
    if (window.GunMod && Crafting.getHeldId() === window.GunMod.pistol) {
      tryFire();
      return;
    }
    mining = true;
    mineKey = null;
    mineProg = 0;
  }

  function updateMining(dt) {
    if (!mining || state !== "playing") return;
    // 准星对玩家 / 动物时发动近战攻击，不挖方块。
    // 玩家射线与生物射线并存、取更近者（FR-15 PvP）；两端各自只做意图判定，
    // 最终命中由房主复核（客人统一转发 act attack）。
    if (attackCd <= 0) {
      const mh = aimAtMob();
      const ph = aimAtPlayer();
      if (ph && (!mh || ph.t <= mh.t)) {
        swingAttackPlayer();
        mineKey = null;
        mineProg = 0;
        crackMesh.visible = false;
        hostClearMine();
        return;
      }
      if (mh) {
        swingAttack(mh);
        mineKey = null;
        mineProg = 0;
        crackMesh.visible = false;
        hostClearMine();
        return;
      }
    } else if (aimAtPlayer()) {
      // 攻击冷却中准星仍贴着对方：不挖对方身后的方块，等冷却结束再出下一刀
      mineKey = null;
      mineProg = 0;
      crackMesh.visible = false;
      hostClearMine();
      return;
    }
    const hit = pickBlock(REACH_DIST);
    if (!hit) {
      mineKey = null;
      crackMesh.visible = false;
      hostClearMine();
      return;
    }
    const key = hit.x + "," + hit.y + "," + hit.z;
    if (key !== mineKey) { mineKey = key; mineProg = 0; }
    // 无敌模式：任意方块一敲即碎（基岩也能清除），无裂纹过程
    if (creativeMode) {
      finishDig(hit);
      mineKey = null;
      mineProg = 0;
      crackMesh.visible = false;
      hostClearMine();
      return;
    }
    const t = digTimeOf(hit.id, Crafting.getHeldId());
    mineProg += dt / t;
    crackMesh.visible = true;
    crackMesh.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
    // 按进度选裂纹档位（0..9），同一目标持续挖时裂纹越来越密
    const stage = Math.min(CRACK_STAGES - 1, Math.floor(mineProg * CRACK_STAGES));
    crackMesh.material.map.offset.x = stage / CRACK_STAGES;
    // 房主：把裂纹档位同步给客人（目标切换时重置，档位变化才发包）
    if (Net.isHost() && hostGuestOnline) {
      if (hostMineKey !== key) { hostMineKey = key; hostMineStage = -1; }
      if (hostMineStage !== stage && mineProg < 1) {
        hostMineStage = stage;
        hostBroadcastMine(hit, stage);
      }
    }
    if (mineProg >= 1) {
      finishDig(hit);
      mineKey = null;
      mineProg = 0;
      crackMesh.visible = false;
      hostClearMine();
    }
  }

  /* ---------------- 房主端：裁决客人的 act ---------------- */
  const _gvEye = new THREE.Vector3();
  const _gvDir = new THREE.Vector3();
  function guestRayHit(a) {
    actorEye(a, _gvEye);
    dirFromPose(a.yaw, a.pitch, _gvDir);
    return raycastVoxel(_gvEye.x, _gvEye.y, _gvEye.z, _gvDir.x, _gvDir.y, _gvDir.z, REACH_DIST);
  }
  function guestReject(a, msg) {
    a.toast(msg || "操作无效，请重试");
    sendGuestInv();
  }
  function onHostGuestAct(m) {
    if (!guestActor || !m) return;
    if (guestDead) return;   // 死亡中：忽略一切动作（攻击/挖掘/丢弃/选择）
    const a = guestActor;
    // act 自带眼位/朝向兜底（持续位姿在 Task 6 由 pp 包驱动）
    if (m.pose && m.pose.p && m.pose.p.length === 3) {
      a.pos.set(m.pose.p[0], m.pose.p[1] - a.eyeHeight, m.pose.p[2]);
      a.yaw = +m.pose.yaw || 0;
      a.pitch = +m.pose.pitch || 0;
      if (typeof m.pose.sel === "number") a.inv.select(m.pose.sel);
    }
    if (m.kind === "sel") { a.inv.select(m.sel | 0); sendGuestInv(); return; }
    if (m.kind === "attack") {
      // 以客人影子眼位/朝向独立复核（不依赖客人声称的坐标）：
      // 目标可能是生物，也可能是房主本人；方块遮挡统一按距离判定
      actorEye(a, _gvEye);
      dirFromPose(a.yaw, a.pitch, _gvDir);
      const mh = Mobs.raycast(_gvEye, _gvDir, 3.6);
      const bh = raycastVoxel(_gvEye.x, _gvEye.y, _gvEye.z, _gvDir.x, _gvDir.y, _gvDir.z, 6);
      const mobBlocked = !mh || (bh && bh.t < mh.t);
      // 房主本人受击体（死亡/非游玩状态不可再被打）
      const pt = (state === "playing" && playerHp > 0)
        ? raycastPlayerBox(_gvEye, _gvDir, player.pos, 3.6) : null;
      const playerBlocked = pt == null || (bh && bh.t < pt);
      const dmg = meleeDamage(a.getHeldId());
      if (pt != null && !playerBlocked && (mobBlocked || (mh && pt <= mh.t))) {
        // 客人打中房主：房主本地扣血/击退（attacker 传客人影子，按玩家攻击者处理）
        hurtPlayer(dmg, a, { byPlayer: true });
        particles.burst(Math.floor(player.pos.x), Math.floor(player.pos.y + 1.3),
                        Math.floor(player.pos.z), 0xff5545);
        return;
      }
      if (!mobBlocked) Mobs.damageMob(mh.mob, dmg, { player: true, from: a.pos });
      // 全部未命中：静默忽略（延迟下很常见，不做 toast 打扰）
      return;
    }
    // 丢弃手持 1 个：不依赖方块射线，直接按影子库存裁决
    if (m.kind === "drop") {
      doDropHeld(a);
      return;
    }
    // 丢弃面板光标整堆：核验客人影子库存确有其物后移除并抛出
    if (m.kind === "dropcur") {
      const id = m.id | 0;
      const n = Math.max(1, Math.min(64, m.n | 0));
      const r = hostGuestRemove(a.inv, id, n);
      if (r.ok) {
        spawnWorldDrop(a, id, n, r.dur);
      } else {
        sendGuestToast("丢弃失败：物品数量对不上");
      }
      sendGuestInv();
      return;
    }
    const hit = guestRayHit(a);
    if (!hit) { guestReject(a, "目标太远或已变化，请重试"); return; }
    if (hit.x !== (m.x | 0) || hit.y !== (m.y | 0) || hit.z !== (m.z | 0)) {
      guestReject(a, "目标方块已变化，请重试");
      return;
    }
    if (m.kind === "dig") {
      doDig(a, hit);
    } else if (m.kind === "use") {
      // 法线也要一致：防止客户端借旧面在裁决侧放置到意外格
      if (hit.nx !== (m.nx | 0) || hit.ny !== (m.ny | 0) || hit.nz !== (m.nz | 0)) {
        guestReject(a, "目标方块已变化，请重试");
        return;
      }
      doUse(a, hit);
    }
  }

  // 客人上报死亡：房主把影子库存的全部装备散落在其最后位姿处，
  // 空 inv 快照回流清空客人自己的背包/护甲/扩展格，化身立即隐藏
  function onHostGuestDied() {
    if (!guestActor || guestDead) return;   // gh 致死后客人再回 pd 时幂等
    guestDead = true;
    guestRespawning = false;
    guestActor.hp = 0;
    hideRemoteAvatar();
    scatterGearAt(guestActor.inv, guestActor.pos);
    guestActor.inv.select(0);
    sendGuestInv();
    showToast("对方被击倒了，装备散落一地");
  }

  // 房主权威：怪物 / Boss 对客人造成伤害。
  // 护甲按客人影子库存抵消（最少 1 点），0.6s 无敌帧节流；
  // gh{n=最终扣血,fr=攻击者坐标,k=1 Boss} 下发后客人只做表现/击退/死亡，不再重算护甲
  function hostHurtGuest(amount, attacker) {
    if (!guestActor || !Net.isHost() || !hostGuestOnline || !guestReady || guestDead) return false;
    if (guestHurtInvuln > 0) return false;
    const def = guestActor.totalDefense ? guestActor.totalDefense() : 0;
    const dmg = Math.max(1, amount - def);
    guestActor.hp = Math.max(0, (typeof guestActor.hp === "number" ? guestActor.hp : HP_MAX) - dmg);
    guestHurtInvuln = 0.6;
    guestHurtSentAt = elapsed;
    const fr = (attacker && attacker.pos)
      ? [r3(attacker.pos.x), r3(attacker.pos.y), r3(attacker.pos.z)] : null;
    Net.send({ t: "gh", n: dmg, fr: fr, k: (attacker && attacker.cfg && attacker.cfg.boss) ? 1 : 0 });
    // 房主端的客人化身处也喷受击红粒子
    try {
      particles.burst(Math.floor(guestActor.pos.x), Math.floor(guestActor.pos.y + 1.3),
                      Math.floor(guestActor.pos.z), 0xff5545);
    } catch (e) {}
    if (guestActor.hp <= 0) onHostGuestDied();
    return true;
  }

  // 客人点重生：房主选安全出生点下发 grs；客人应用新位置后的首个近处
  // pp 才恢复化身（在途的死亡点 pp 全部丢弃，避免尸体原地闪现）
  function onHostGuestRespawn() {
    if (!guestActor || !guestDead) return;
    const sp = findGuestSpawn(spawnPoint);
    guestActor.pos.set(sp.x, sp.y, sp.z);
    guestActor.vel.set(0, 0, 0);
    guestRespawnPoint.set(sp.x, sp.y, sp.z);
    guestRespawning = true;
    guestDead = false;
    guestActor.hp = HP_MAX;
    guestHurtInvuln = 0;
    Net.send({ t: "grs", x: r3(sp.x), y: r3(sp.y), z: r3(sp.z) });
  }

  /* ---------------- 客人端：应用房主裁决结果 ---------------- */
  function onGuestInv(m) {
    Crafting.applyNetSnapshot(m);
  }
  function onGuestToast(m) {
    if (m && typeof m.msg === "string") showToast(m.msg);
  }
  // PvP：房主命中客人后发来的伤害事件。客人权威自己的 HP，
  // 护甲抵消 / 0.6s 无敌帧 / 击退 / 死亡全部走本地 hurtPlayer 结算
  function onGuestPlayerHurt(m) {
    if (!guestLoaded || state !== "playing" || playerHp <= 0) return;
    const n = m && (m.n | 0);
    if (!(n > 0) || !m.fr || m.fr.length !== 3) return;
    const fx = +m.fr[0], fy = +m.fr[1], fz = +m.fr[2];
    if (!isFinite(fx) || !isFinite(fy) || !isFinite(fz)) return;
    const hit = hurtPlayer(n, { pos: new THREE.Vector3(fx, fy, fz) }, { byPlayer: true });
    if (hit) {
      particles.burst(Math.floor(player.pos.x), Math.floor(player.pos.y + 1.3),
                      Math.floor(player.pos.z), 0xff5545);
    }
  }
  // 怪物 / Boss / 龙炎伤害（gh）：房主已结算护甲与无敌帧，n 是最终扣血。
  // 客人端不再重算防御，只应用扣血、击退、红屏与死亡（die 会回 pd）
  function onGuestMobHurt(m) {
    if (!guestLoaded || state !== "playing" || playerHp <= 0) return;
    const n = m && (m.n | 0);
    if (!(n > 0)) return;
    playerHp = Math.max(0, playerHp - n);
    hurtInvuln = 0.6;
    lastHurtAt = elapsed;
    if (m.fr && m.fr.length === 3) {
      const fx = +m.fr[0], fy = +m.fr[1], fz = +m.fr[2];
      if (isFinite(fx) && isFinite(fy) && isFinite(fz)) {
        const dx = player.pos.x - fx, dz = player.pos.z - fz;
        const l = Math.hypot(dx, dz) || 1;
        player.vel.x += dx / l * 6;
        player.vel.z += dz / l * 6;
        player.vel.y = Math.max(player.vel.y, 4.2);
      }
    }
    if (m.k === 1) {
      lastDeathCause = "被紫黑龙的烈焰与龙爪击倒了，带好护甲和食物再战火山";
      showToast("紫黑龙对你发动了攻击！");
    }
    particles.burst(Math.floor(player.pos.x), Math.floor(player.pos.y + 1.3),
                    Math.floor(player.pos.z), 0xff5545);
    updateHearts();
    flashHurt();
    if (playerHp <= 0) die();
  }
  // 房主死亡：藏起其化身（房主身上的装备由房主端散落后经 ea/es 以掉落物出现）
  function onGuestPeerDied() {
    hostDead = true;
    hideRemoteAvatar();
    showToast("对方被击倒了，装备散落一地");
  }
  // 房主点了重生：记录其出生点，放行出生点附近的 pp，化身在那里重现
  function onGuestPeerRespawn(m) {
    hostDead = false;
    if (m && isFinite(+m.x) && isFinite(+m.y) && isFinite(+m.z)) {
      hostRespawnPoint.set(+m.x, +m.y, +m.z);
      hostRespawning = true;
    }
  }
  // 房主裁决的重生点：死亡遮罩已在本地关闭，收到后立即与房主位置对齐
  function onGuestRespawnSet(m) {
    if (!guestLoaded || !m) return;
    const x = +m.x, y = +m.y, z = +m.z;
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return;
    player.pos.set(x, y, z);
    player.vel.set(0, 0, 0);
    if (spawnPoint) spawnPoint.set(x, y, z);
    else spawnPoint = new THREE.Vector3(x, y, z);
  }
  function onGuestOpen(m) {
    if (!m) return;
    if (m.kind === "table") {
      openPanel("table");
    } else if (m.kind === "chest" || m.kind === "furnace" || m.kind === "gunbench") {
      // 容器内容双向同步在 Task 11 实现；此处先告知客人意图已受理
      showToast(m.kind === "chest" ? "储物箱联机将在下个版本开放"
        : m.kind === "gunbench" ? "枪械工作台联机将在下个版本开放"
        : "熔炉联机将在下个版本开放");
    }
  }
  let guestMineKey = null;
  function onGuestMine(m) {
    if (!m) return;
    if (m.s >= 10) { guestMineKey = null; crackMesh.visible = false; return; }
    const key = m.x + "," + m.y + "," + m.z;
    guestMineKey = key;
    crackMesh.visible = true;
    crackMesh.position.set(m.x + 0.5, m.y + 0.5, m.z + 0.5);
    crackMesh.material.map.offset.x = Math.max(0, Math.min(CRACK_STAGES - 1, m.s | 0)) / CRACK_STAGES;
  }

  /* ---------------- 战斗：近战攻击动物 / 与动物交互 ---------------- */

  let attackCd = 0;

  /* ---------------- 夜晚刷怪节奏 ---------------- */
  const MONSTER_MAX = 6;       // 同屏敌对怪（僵尸 + 蜘蛛）上限
  let monsterSpawnT = 4;       // 入夜后首只怪的宽限秒数
  let lavaT = 0;               // 泡在岩浆里的累计时间（周期性烫血）
  let cactusT = 0;             // 贴着仙人掌的累计时间（周期性扎血）
  let lavaLights = [];         // 火山熔岩点光源（带闪烁参数）
  let lavaLightsOn = false;    // 灯光是否已开启（靠近火山时单向开启，避免反复重编译着色器）

  // 扫描“露天岩浆”格（上方是空气），在火山口与熔岩流上稀疏布点
  // 少量点光源负责真正照亮周围地形，岩浆面本身靠 emissiveMap 自发光
  // probe：火山搜索中心（出生点 / 存档玩家位置）；缺省用 spawnPoint
  function setupLavaLights(probe) {
    lavaLights.forEach(o => scene.remove(o.l));
    lavaLights = [];
    lavaLightsOn = false;

    // 无限世界：找探测点附近宏观气候牌内的火山中心，只扫描火山周围 ~42 格
    probe = probe || spawnPoint || { x: 0, z: 0 };
    const probeX = probe.x, probeZ = probe.z;
    const vc = world.findVolcano(probeX, probeZ, 4);
    volcanoCenter = vc ? { x: vc.x, z: vc.z } : null;
    if (!vc) return 0;
    world.ensureDataRing(vc.x, vc.z, 3);
    const tops = [];
    const R = 42;
    for (let x = Math.floor(vc.x) - R; x <= Math.floor(vc.x) + R; x++) {
      for (let z = Math.floor(vc.z) - R; z <= Math.floor(vc.z) + R; z++) {
        for (let y = world.H - 2; y >= world.SEA - 2; y--) {
          const b = world.getBlock(x, y, z);
          if (isLava(b) && world.getBlock(x, y + 1, z) === BLOCK.AIR) {
            tops.push({ x: x, y: y, z: z });
            break;
          }
          if (b !== BLOCK.AIR && !isLava(b)) break;  // 碰到普通地表即止
        }
      }
    }
    if (!tops.length) return 0;

    // 离火山口中心最近的作为主光源；其余按“至少相隔 6 格”贪心采点
    if (vc) {
      tops.sort((a, b) => {
        const da = (a.x - vc.x) * (a.x - vc.x) + (a.z - vc.z) * (a.z - vc.z);
        const db = (b.x - vc.x) * (b.x - vc.x) + (b.z - vc.z) * (b.z - vc.z);
        return da - db;
      });
    }
    const picked = [];
    for (const p of tops) {
      let farEnough = true;
      for (const q of picked) {
        const dx = p.x - q.x, dz = p.z - q.z;
        if (dx * dx + dz * dz < 36) { farEnough = false; break; }
      }
      if (farEnough) {
        picked.push(p);
        if (picked.length >= 9) break;
      }
    }

    picked.forEach((p, i) => {
      const crater = i === 0 && vc &&
        (p.x - vc.x) * (p.x - vc.x) + (p.z - vc.z) * (p.z - vc.z) < 16;
      // 强度/作用距离刻意收紧：岩浆靠自发光+紧邻沟壁的暖光即可，点光不可漫到 7 格外，
      // 否则趴在火口外肩的紫黑龙会被多盏橙光加成烤成奶白色（暗材质对橙光极敏感）
      const light = new THREE.PointLight(crater ? 0xff8a30 : 0xff6418, crater ? 5.6 : 3.2, crater ? 7 : 5, 2);
      light.visible = false;   // 靠近火山时才一次性开启（性能）
      light.position.set(p.x + 0.5, p.y + 1.4, p.z + 0.5);
      scene.add(light);
      lavaLights.push({
        l: light,
        base: crater ? 5.6 : 3.2,
        ph: Math.random() * Math.PI * 2,
        sp: 5 + Math.random() * 4
      });
    });
    return picked.length;
  }
  let volcanoCenter = null;    // 火山中心（用于灯光距离门控）

  // 准星是否指向动物（返回射线结果，或 null）
  function aimAtMob() {
    camera.getWorldDirection(_dir);
    const mh = Mobs.raycast(eyePos, _dir, 3.6);
    if (!mh) return null;
    // 动物与方块同时命中时，只打更近的那个
    const bh = pickBlock(6);
    if (bh && bh.t < mh.t) return null;
    return mh;
  }

  // 近战伤害：斧 = 4 + 斧等级（木5/石6/铁7/红宝石8，重劈）；
  // 镐 = 3 + 镐等级（木4/石5/铁6/红宝石7）；空手 3 点
  function meleeDamage(held) {
    const lv = pickLevelOf(held);
    const axeLv = axeLevelOf(held);
    return axeLv > 0 ? 4 + axeLv : (lv > 0 ? 3 + lv : 3);
  }

  // 玩家受击体 slab 射线：o 眼位、d 单位方向、c 脚底中心；0.6 宽 1.8 高 + 0.08 容差
  function raycastPlayerBox(o, d, c, maxDist) {
    const hw = 0.38;
    const mn = [c.x - hw, c.y, c.z - hw];
    const mx = [c.x + hw, c.y + 1.8, c.z + hw];
    let tmin = 0, tmax = Infinity;
    for (let a = 0; a < 3; a++) {
      const oa = a === 0 ? o.x : a === 1 ? o.y : o.z;
      const da = a === 0 ? d.x : a === 1 ? d.y : d.z;
      if (Math.abs(da) < 1e-8) {
        if (oa < mn[a] || oa > mx[a]) return null;
      } else {
        let t1 = (mn[a] - oa) / da, t2 = (mx[a] - oa) / da;
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
        tmin = Math.max(tmin, t1);
        tmax = Math.min(tmax, t2);
        if (tmin > tmax) return null;
      }
    }
    return tmin <= tmax && tmin < maxDist ? Math.max(0, tmin) : null;
  }

  // 准星是否指向对方玩家（仅联机）：方块比人近则视为被墙挡住
  function aimAtPlayer() {
    if (!Net.active() || !remoteAvatar || !remoteAvatar.live) return null;
    // 正常用插值身体；首包插值帧之前 / 后台标签 rAF 被节流时退用最新位姿目标
    const body = remoteAvatar.cur || remoteAvatar.target;
    if (!body) return null;
    camera.getWorldDirection(_dir);
    const t = raycastPlayerBox(eyePos, _dir, body, 3.6);
    if (t == null) return null;
    const bh = pickBlock(6);
    if (bh && bh.t < t) return null;
    return { t: t };
  }

  function swingAttack(mh) {
    // 客人不本地伤害：转发 attack 意图，房主按影子位姿重新射线复核后裁决，
    // 结果随 ea/es 快照回流。这里只做本地手感（冷却 / 挥手）
    if (Net.isGuest()) {
      if (!guestLoaded) return;
      attackCd = 0.32;
      armSwing();
      Net.send({ t: "act", seq: ++guestActSeq, kind: "attack", pose: guestPosePacket() });
      return;
    }
    const dmg = meleeDamage(Crafting.getHeldId());
    const ok = Mobs.damageMob(mh.mob, dmg, { player: true, from: player.pos });
    if (ok !== false) {
      attackCd = 0.32;
      armSwing();
    }
  }

  // 近战命中对方玩家。客人同样只转发 act attack（房主复核时会检测房主本人受击体）；
  // 房主命中客人 -> 发 ph 伤害事件，由客人本地结算护甲/无敌帧/击退（各端权威自己 HP）
  function swingAttackPlayer() {
    if (Net.isGuest()) {
      if (!guestLoaded) return;
      attackCd = 0.32;
      armSwing();
      Net.send({ t: "act", seq: ++guestActSeq, kind: "attack", pose: guestPosePacket() });
      return;
    }
    if (!Net.isHost() || !hostGuestOnline || !guestActor || guestDead) return;
    const dmg = meleeDamage(Crafting.getHeldId());
    Net.send({ t: "ph", n: dmg, fr: [r3(player.pos.x), r3(player.pos.y), r3(player.pos.z)] });
    attackCd = 0.32;
    armSwing();
    // 命中粒子打在客人影子胸口（客人真正掉血时其本地也会爆一丛）
    particles.burst(Math.floor(guestActor.pos.x), Math.floor(guestActor.pos.y + 1.3),
                    Math.floor(guestActor.pos.z), 0xff5545);
  }

  function attackTarget() {
    if (attackCd > 0) return;
    const mh = aimAtMob();
    const ph = aimAtPlayer();
    // 玩家与动物同时命中时打更近者（两者内部都已做方块遮挡判定）
    if (ph && (!mh || ph.t <= mh.t)) { swingAttackPlayer(); return; }
    if (mh) { swingAttack(mh); return; }
    breakBlock();
  }

  /* ---------------- 手枪：装弹 / 半自动射击 ----------------
   * 弹匣存在手枪物品堆的 ammo 字段（0..MAG），备弹为背包内的手枪子弹。
   * 客人端射击（房主权威 shoot 消息）二期再做，本期仅房主 / 单人可开枪。 */
  let gunFireCd = 0;      // 开火冷却（秒）
  let gunReloadT = 0;     // 换弹剩余时间（秒），>0 表示正在换弹
  let gunReloadSlot = -1; // 换弹发起时的热键栏槽位（完成时校验枪没被挪走）
  let gunHudKey = "";     // HUD 状态缓存，避免每帧刷 DOM
  const gunHudEl = document.getElementById("gun-hud");
  const gunAmmoEl = document.getElementById("gun-ammo-num");
  const gunSlashEl = document.getElementById("gun-ammo-slash");
  const gunReserveEl = document.getElementById("gun-ammo-reserve");
  const gunReloadBtn = document.getElementById("gun-reload-btn");

  function heldGunStack() {
    const h = Crafting.getHeld();
    return (h && window.GunMod && h.id === window.GunMod.pistol) ? h : null;
  }

  // 自定义射程的对方玩家受击判定（近战 3.6 格，手枪取 RANGE=20）
  function aimAtPlayerRange(range) {
    if (!Net.active() || !remoteAvatar || !remoteAvatar.live) return null;
    const body = remoteAvatar.cur || remoteAvatar.target;
    if (!body) return null;
    camera.getWorldDirection(_dir);
    const t = raycastPlayerBox(eyePos, _dir, body, range);
    if (t == null) return null;
    const bh = raycastVoxel(eyePos.x, eyePos.y, eyePos.z,
                           _dir.x, _dir.y, _dir.z, range, false);
    if (bh && bh.t < t) return null;
    return { t: t };
  }

  // 开始换弹：校验后备子弹后播放 0.9s 动作，完成时由 updateGun 结算上弹
  function startReload() {
    if (state !== "playing" || gunReloadT > 0) return;
    const G = window.GunMod;
    if (!G) return;
    const g = Crafting.inventory[Crafting.selected];
    if (!g || g.id !== G.pistol) return;
    if (Net.isGuest()) { showToast("联机射击将在下个版本开放"); return; }
    if (creativeMode) return;   // 无敌模式弹匣永满
    const cur = g.ammo || 0;
    if (cur >= G.MAG) { showToast("弹匣已满"); return; }
    if (Crafting.countItem(G.bullet) <= 0) {
      GunMod.sfx("empty");
      showToast("没有手枪子弹 · 先用铜块+火药在枪械工作台制作");
      return;
    }
    gunReloadT = G.RELOAD_T;
    gunReloadSlot = Crafting.selected;
    ViewModel.reloadGun();
    GunMod.sfx("reload");
  }

  function finishReload() {
    const G = window.GunMod;
    const slot = gunReloadSlot;
    gunReloadSlot = -1;
    const g = Crafting.inventory[slot];
    // 换弹过程中枪被移走（面板整理 / 丢弃）：取消，不扣子弹
    if (!g || g.id !== G.pistol) return;
    const cur = g.ammo || 0;
    const need = G.MAG - cur;
    if (need <= 0) return;
    const took = Crafting.consumeItem(G.bullet, need);
    if (took > 0) {
      g.ammo = Math.min(G.MAG, cur + took);
      Crafting.renderAll();
      showToast("装弹完成 " + g.ammo + " / " + G.MAG);
    }
  }

  // 扣一次扳机（半自动：mousedown 触发一次，长按不连射）
  function tryFire() {
    if (state !== "playing" || gunFireCd > 0 || gunReloadT > 0) return;
    const G = window.GunMod;
    if (!G) return;
    if (Net.isGuest()) { showToast("联机射击将在下个版本开放"); return; }
    const g = heldGunStack();
    if (!g) return;
    if (!creativeMode && (g.ammo || 0) <= 0) {
      GunMod.sfx("empty");
      gunFireCd = 0.35;
      showToast("弹匣是空的 · 按 R 或点「装弹」上弹");
      return;
    }

    // 同一条视线：生物 / 对方玩家 / 方块，取最近命中；射程 20 格
    const range = G.RANGE;
    camera.getWorldDirection(_dir);
    const mh = Mobs.raycast(eyePos, _dir, range);
    const bh = raycastVoxel(eyePos.x, eyePos.y, eyePos.z,
                           _dir.x, _dir.y, _dir.z, range, creativeMode);
    const ph = aimAtPlayerRange(range);

    if (ph && (!mh || ph.t <= mh.t) && (!bh || ph.t <= bh.t)) {
      // 房主命中客人：发 ph 由客人本地结算（与近战同通道），距离用枪伤
      if (Net.isHost() && hostGuestOnline && guestActor && !guestDead) {
        Net.send({ t: "ph", n: G.DAMAGE,
                   fr: [r3(player.pos.x), r3(player.pos.y), r3(player.pos.z)] });
        particles.burst(Math.floor(guestActor.pos.x),
                        Math.floor(guestActor.pos.y + 1.3),
                        Math.floor(guestActor.pos.z), 0xff5545);
      }
    } else if (mh && (!bh || mh.t <= bh.t)) {
      Mobs.damageMob(mh.mob, G.DAMAGE, { player: true, from: player.pos });
      particles.burst(Math.floor(mh.mob.pos.x),
                      Math.floor(mh.mob.pos.y + 1.3),
                      Math.floor(mh.mob.pos.z), 0xff5545);
    } else if (bh) {
      // 打中方块：着弹点一小蓬尘土火星（子弹不破坏方块）
      const px = eyePos.x + _dir.x * bh.t, py = eyePos.y + _dir.y * bh.t,
            pz = eyePos.z + _dir.z * bh.t;
      particles.burst(Math.floor(px), Math.floor(py), Math.floor(pz), 0xcfc6b8);
    }

    // 耗弹（无敌模式无限）+ 后坐 / 火光 / 枪声 / 第三人称挥手
    if (!creativeMode) g.ammo = Math.max(0, (g.ammo || 0) - 1);
    gunFireCd = G.FIRE_CD;
    ViewModel.kick();
    PlayerModel.swing();
    GunMod.sfx("fire");
  }

  // 主循环每帧调用：冷却 / 换弹结算 / HUD 同步
  function updateGun(dt) {
    if (gunFireCd > 0) gunFireCd = Math.max(0, gunFireCd - dt);
    if (gunReloadT > 0) {
      gunReloadT -= dt;
      if (gunReloadT <= 0) { gunReloadT = 0; finishReload(); }
    }
    const g = heldGunStack();
    if (state !== "playing" || !g || !gunHudEl) {
      if (gunHudKey !== "hidden") { gunHudEl.classList.add("hidden"); gunHudKey = "hidden"; }
      return;
    }
    const G = window.GunMod;
    const mag = creativeMode ? "∞" : String(g.ammo || 0);
    const reserve = creativeMode ? "" : String(Crafting.countItem(G.bullet));
    const reloading = gunReloadT > 0;
    const key = mag + "|" + reserve + "|" + (reloading ? 1 : 0) + (creativeMode ? "|c" : "");
    if (key !== gunHudKey) {
      gunHudEl.classList.remove("hidden");
      gunAmmoEl.textContent = mag;
      gunSlashEl.textContent = "/" + G.MAG;
      // 创造无限弹药只显示 ∞，容量后缀 "/7" 无意义需隐藏
      gunSlashEl.style.display = creativeMode ? "none" : "";
      gunReserveEl.textContent = creativeMode ? "无限弹药" : "备弹 " + reserve;
      gunAmmoEl.classList.toggle("zero", !creativeMode && (g.ammo || 0) === 0 && !reloading);
      gunReloadBtn.classList.toggle("hidden", creativeMode || reloading);
      gunReloadBtn.disabled = reloading;
      gunReloadBtn.textContent = reloading ? "装弹中…" : "装弹 (R)";
      gunHudKey = key;
    }
  }

  /* ---- 火把点光源：定期扫描玩家附近的火把，限量动态点灯并轻微闪烁 ---- */
  const TORCH_LIGHT_MAX = 10;
  const torchLights = [];
  for (let i = 0; i < TORCH_LIGHT_MAX; i++) {
    const l = new THREE.PointLight(0xffa84d, 0, 14, 2);
    l.visible = false;
    scene.add(l);
    torchLights.push({ l: l, ph: Math.random() * Math.PI * 2 });
  }
  let torchLightT = 999;
  function markTorchLightsDirty() { torchLightT = 999; }

  function scanTorchLights() {
    const cx = Math.floor(eyePos.x);
    const cy = Math.floor(eyePos.y);
    const cz = Math.floor(eyePos.z);
    const R = 20;
    const found = [];
    for (let x = cx - R; x <= cx + R; x++) {
      for (let z = cz - R; z <= cz + R; z++) {
        if (!world.inBounds(x, 0, z)) continue;
        for (let y = Math.max(1, cy - 8); y <= cy + 8 && y < world.H; y++) {
          const lb = GameRegistry.lightBlocks[world.getBlock(x, y, z)];
          if (lb) found.push({ x: x, y: y, z: z, lb: lb });
        }
      }
    }
    found.sort((a, b) => {
      const da = (a.x - cx) * (a.x - cx) + (a.y - cy) * (a.y - cy) + (a.z - cz) * (a.z - cz);
      const db = (b.x - cx) * (b.x - cx) + (b.y - cy) * (b.y - cy) + (b.z - cz) * (b.z - cz);
      return da - db;
    });
    let i = 0;
    for (; i < Math.min(TORCH_LIGHT_MAX, found.length); i++) {
      const t = torchLights[i], p = found[i];
      t.lb = p.lb;
      t.l.visible = true;
      t.l.color.setHex(p.lb.color);
      t.l.distance = p.lb.dist;
      t.l.position.set(p.x + 0.5, p.y + (p.lb.oy != null ? p.lb.oy : 0.9), p.z + 0.5);
    }
    for (; i < TORCH_LIGHT_MAX; i++) { torchLights[i].l.visible = false; torchLights[i].lb = null; }
  }

  function updateTorchLights(dt, t) {
    torchLightT += dt;
    if (torchLightT >= 1.0) { torchLightT = 0; scanTorchLights(); }
    for (const o of torchLights) {
      if (!o.l.visible || !o.lb) continue;
      const base = o.lb.intensity;
      if (o.lb.flicker === false) { o.l.intensity = base; continue; }
      const k = base / 2.5;
      o.l.intensity = base + (Math.sin(t * 11 + o.ph) * 0.28 + Math.sin(t * 23 + o.ph * 2) * 0.12) * k;
    }
  }

  function interactTarget() {
    // 客人端喂食 / 驯服等动物互动待 Task 8 转发；右键一律走放方块 act 裁决，
    // 绝不在本地直接改镜像（否则镜相会被本地写花）
    if (Net.isGuest()) { placeBlock(); return; }
    const mh = aimAtMob();
    if (mh) {
      const handled = Mobs.interact(mh.mob, Crafting.getHeld());
      if (handled) { armSwing(); return; }
    }
    placeBlock();
  }

  /* ---------------- 玩家生命 / 受伤 / 死亡 ---------------- */

  const HP_MAX = 20;
  let playerHp = HP_MAX;
  let hurtInvuln = 0;
  let lastHurtAt = -99;
  let regenT = 0;
  let toastTimer = null;
  const heartEls = [];

  function buildHearts() {
    heartsEl.innerHTML = "";
    heartEls.length = 0;
    for (let i = 0; i < 10; i++) {
      const s = document.createElement("span");
      s.className = "heart empty";
      s.textContent = "♥";
      heartsEl.appendChild(s);
      heartEls.push(s);
    }
    updateHearts();
  }

  function updateHearts() {
    for (let i = 0; i < 10; i++) {
      const v = playerHp - i * 2;
      heartEls[i].className = "heart " + (v >= 2 ? "full" : v === 1 ? "half" : "empty");
    }
  }

  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("show"); }, 2200);
  }

  function flashHurt() {
    hurtFlashEl.classList.remove("show");
    void hurtFlashEl.offsetWidth;   // 强制重排以重启动画
    hurtFlashEl.classList.add("show");
  }

  // amount 为半心数（20 点 = 10 颗心）；
  // attacker 是发起攻击的动物 mob 或对方玩家执行者（opts.byPlayer=true）
  let lastDeathCause = "";
  function hurtPlayer(amount, attacker, opts) {
    if (window.__god) return false;            // 调试：无敌（审查模型用）
    if (creativeMode) return false;            // 无敌模式：一切伤害（攻击/岩浆/仙人掌）免疫
    if (state !== "playing" || hurtInvuln > 0 || playerHp <= 0) return false;
    // 羊毛护甲按总防御值抵消伤害，最少受到 1 点
    const def = Crafting.totalDefense();
    if (def > 0) amount = Math.max(1, amount - def);
    playerHp = Math.max(0, playerHp - amount);
    hurtInvuln = 0.6;
    lastHurtAt = elapsed;
    if (attacker) {
      const dx = player.pos.x - attacker.pos.x, dz = player.pos.z - attacker.pos.z;
      const l = Math.hypot(dx, dz) || 1;
      player.vel.x += dx / l * 6;
      player.vel.z += dz / l * 6;
      player.vel.y = Math.max(player.vel.y, 4.2);
      if (opts && opts.byPlayer) {
        lastDeathCause = "被对方玩家击倒了，重生后找回场子";
        showToast("你被对方玩家击中了！");
      } else {
        Mobs.notifyPlayerAttacked(attacker);
        if (attacker.cfg && attacker.cfg.boss) {
          lastDeathCause = "被紫黑龙的烈焰与龙爪击倒了，带好护甲和食物再战火山";
          showToast("紫黑龙对你发动了攻击！");
        } else {
          lastDeathCause = "被愤怒的动物击倒了，重生后小心牛和野狗";
          showToast("你被" + attacker.cfg.name + "攻击了！狗会保护你");
        }
      }
    }
    updateHearts();
    flashHurt();
    if (playerHp <= 0) die();
    return true;
  }

  function die() {
    state = "dead";
    Mobs.dismount();
    const sub = deathOverlay.querySelector(".sub");
    if (sub) sub.textContent = lastDeathCause || "你死了，重生后继续冒险吧";
    deathOverlay.classList.remove("hidden");
    crosshair.style.display = "none";
    hintEl.style.display = "none";
    if (document.pointerLockElement === renderer.domElement) document.exitPointerLock();
    syncTouchClass();
    // 联机死亡：通知另一端并按权威散落全身装备
    if (Net.active()) {
      if (Net.isGuest()) {
        // 客人权威自己的 HP：上报 pd，房主藏化身 + 把影子库存散成世界掉落物，
        // 空 inv 快照回流清空本端背包
        Net.send({ t: "pd" });
      } else if (Net.isHost()) {
        // 房主权威：本地散落自己的装备（掉落物经 ea/es 同步），通知客人藏化身
        scatterGearAt(Crafting, player.pos);
        Crafting.renderAll();
        Net.send({ t: "pd" });
      }
    }
  }

  function respawn() {
    playerHp = HP_MAX;
    hurtInvuln = 0;
    lastDeathCause = "";
    updateHearts();
    player.setSpawn(spawnPoint);
    deathOverlay.classList.add("hidden");
    if (inNoLock) {
      state = "playing";
      crosshair.style.display = "block";
      hintEl.style.display = "block";
    } else {
      requestLock();
    }
    syncTouchClass();
    // 死亡/重生都通知对端：客人重生需房主裁决重生点（grs 回调里对齐位置）；
    // 房主重生把自己的出生点随 pr 带给客人，客人按位置放行首个 pp 让化身在出生点重现
    if (Net.active()) {
      if (Net.isHost() && spawnPoint) {
        Net.send({ t: "pr", x: r3(spawnPoint.x), y: r3(spawnPoint.y), z: r3(spawnPoint.z) });
      } else {
        Net.send({ t: "pr" });
      }
    }
  }

  /* ---------------- 存档 ---------------- */

  let autoSaveT = 0;
  let suppressSave = false;    // 开新世界跳转时抑制退出自动保存
  const AUTOSAVE_EVERY = 20;   // 秒

  function buildSnapshot() {
    return {
      seed: world.seed,
      creative: creativeMode,
      chunks: world.serializeDirtyChunks(),
      player: {
        x: player.pos.x, y: player.pos.y, z: player.pos.z,
        yaw: player.yaw, pitch: player.pitch,
        hp: playerHp
      },
      inventory: Crafting.inventory.map(s => s ? { id: s.id, count: s.count, dur: s.dur, ammo: s.ammo } : null),
      selected: Crafting.selected,
      armor: Crafting.serializeArmor(),
      bag: Crafting.serializeBag(),
      chests: Chest.serialize(),
      tamed: Mobs.serializeTamed(),
      boss: Mobs.serializeBoss()
    };
  }

  // silent=true 时不弹提示（自动保存 / 关闭页面前）；返回 Promise<boolean>
  function saveGame(silent) {
    if (suppressSave) return Promise.resolve(false);   // 正在清档开新世界
    if (Net && Net.isGuest && Net.isGuest()) return Promise.resolve(false);   // 联机客人不持有存档（房主权威）
    if (!player || (state !== "playing" && state !== "paused")) return Promise.resolve(false);
    if (playerHp <= 0) return Promise.resolve(false);   // 死亡状态不落盘
    return SaveSystem.save(buildSnapshot()).then(function (ok) {
      if (!ok) {
        if (!silent) showToast("保存失败：浏览器存储空间不足");
        return false;
      }
      // 已绑定云存档：本地落盘后再同步服务器。静默保存（每 20 秒自动）
      // 云端失败不打扰玩家，仅记录状态；手动保存给出明确结果
      const code = CloudSave.bound();
      if (!code) {
        if (!silent) showToast("进度已保存 ✓");
        return true;
      }
      return CloudSave.uploadCurrent().then(function () {
        if (!silent) showToast("进度已保存到本机和云端 ✓（码 " + code + "）");
        return true;
      }).catch(function (e) {
        console.warn("[Cloud] 本次云同步失败：", e);
        if (!silent) showToast("已保存本机，云端同步失败：" + CloudSave.errText(e));
        return true;   // 本地已成功，不因云端失败判定整次保存失败
      });
    }).catch(function (e) {
      console.warn("[Save] 保存异常：", e);
      if (!silent) showToast("保存失败：浏览器存储空间不足");
      return false;
    });
  }

  function formatSaveTime(ts) {
    const d = new Date(ts);
    const p = n => (n < 10 ? "0" + n : "" + n);
    return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  // 导出存档为 .json 文件（游戏中先落盘一次，保证导出的是最新进度）
  function exportSave() {
    const ready = (state === "playing" || state === "paused") ? saveGame(true) : Promise.resolve(true);
    ready.then(function () { return SaveSystem.raw(); }).then(function (raw) {
      if (!raw) { showToast("还没有可导出的存档"); return; }
      const d = new Date();
      const p = n => (n < 10 ? "0" + n : "" + n);
      const fname = "blockworld-save-" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
        "-" + p(d.getHours()) + p(d.getMinutes()) + ".json";
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([raw], { type: "application/json" }));
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        URL.revokeObjectURL(a.href);
        document.body.removeChild(a);
      }, 1000);
      showToast("存档已导出：" + fname);
    });
  }

  // 主菜单：根据是否有存档切换按钮
  function showMainMenu() {
    overlay.querySelector("h1").textContent = "方块世界";
    overlay.querySelector(".sub").textContent = "一个网页版的「我的世界」体素沙盒";
    saveBtn.classList.add("hidden");
    creativeBtn.classList.remove("hidden");
    cloudBtn.classList.remove("hidden");
    cloudBtn.textContent = "云端读档…";
    const loaded = !!pendingSave;   // 本次启动已通过 ?load=1 载入
    SaveSystem.info().then(function (info) {
      if (info) {
        playBtn.textContent = "继续游戏";
        newWorldBtn.classList.remove("hidden");
        creativeBtn.textContent = "开新的无敌世界…";
        exportBtn.classList.remove("hidden");
        saveInfoEl.textContent = "上次保存：" + formatSaveTime(info.ts) +
          (info.tamedCount ? " · 已驯服动物 " + info.tamedCount + " 只" : "") +
          (info.backups ? " · 备份 " + info.backups + " 份" : "");
        saveInfoEl.classList.remove("hidden");
        if (loaded && !info.recovering) showToast("存档已恢复，欢迎回来");
      } else {
        playBtn.textContent = "进入世界";
        newWorldBtn.classList.add("hidden");
        creativeBtn.textContent = "无敌模式（新的世界）";
        exportBtn.classList.add("hidden");
        saveInfoEl.classList.add("hidden");
        // 旧档与新版地图尺寸不符被清除后，解释一句并引导进入新世界
        try {
          if (sessionStorage.getItem("mc_save_reset") === "1") {
            sessionStorage.removeItem("mc_save_reset");
            showToast("地图已扩大升级，旧世界存档无法兼容，已为你生成新世界");
          }
        } catch (e) {}
      }
    });
  }

  // 带参数重新加载页面（继续游戏 / 开新世界）
  function reloadWith(params) {
    const u = new URL(location.href);
    Object.keys(params).forEach(k => {
      if (params[k] == null) u.searchParams.delete(k);
      else u.searchParams.set(k, params[k]);
    });
    u.searchParams.set("v", Date.now());
    location.href = u.toString();
  }

  /* ---------------- 指针锁定 ---------------- */
  // 少数环境(或自动化浏览器)不支持指针锁定：用 ?nolock=1 进入免锁定模式，
  // 或在 requestPointerLock 失败时自动回退
  const forceNoLock = new URLSearchParams(location.search).has("nolock");
  let inNoLock = false;
  // 触屏设备判定：必须主指针就是触摸（pointer: coarse）。
  // 不能只看 maxTouchPoints>0 —— 带触摸屏的 Windows 笔记本/一体机会误报，
  // 但玩家实际用鼠标键盘玩，误判会导致指针被隐藏却没有真正锁定。
  // 再叠加运行时兜底：真实发生过触摸交互才最终认定。
  let isTouch = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
  const pointerLockSupported = typeof renderer.domElement.requestPointerLock === "function";
  const shouldAutoNoLock = function () { return isTouch && !pointerLockSupported; };
  window.addEventListener("touchstart", function () {
    if (isTouch) return;
    isTouch = true;
    document.body.classList.add("is-touch-device");
    if (state === "playing") document.body.classList.add("touch-on");
  }, { passive: true, capture: true });
  if (isTouch) document.body.classList.add("is-touch-device");

  // 指针锁定请求带自动重试：Esc 退出后浏览器有 1.25~2s 冷却期，
  // 立刻重锁会失败。重试均在点击产生的瞬态激活窗口（约 5s）内。
  let lockSeq = 0;
  function requestLock() {
    if (!pointerLockSupported || forceNoLock || shouldAutoNoLock()) { enterNoLock(); return; }
    if (document.pointerLockElement === renderer.domElement) return;
    const seq = ++lockSeq;
    const delays = [0, 350, 800, 1300, 1800, 2400];
    delays.forEach(function (delay, i) {
      setTimeout(function () {
        if (seq !== lockSeq) return;                       // 已被更新的请求 / Esc 取消
        if (document.pointerLockElement === renderer.domElement) return;
        // playing 也允许补锁（看门狗 / 点击画面恢复）
        if (state !== "menu" && state !== "paused" && state !== "playing"
            && state !== "crafting" && state !== "furnace" && state !== "chest"
            && state !== "gunbench") return;
        try {
          const r = renderer.domElement.requestPointerLock();
          if (r && typeof r.catch === "function") r.catch(function () {});
        } catch (e) { /* 冷却期内会抛错，等下一次重试 */ }
        if (i === delays.length - 1) {
          setTimeout(function () {
            if (seq !== lockSeq) return;
            if (document.pointerLockElement === renderer.domElement) return;
            // playing 中补锁失败：保持可见指针等玩家再次点击，不悄悄降级
            if (state === "playing") return;
            if (state === "menu" || state === "paused" || state === "crafting" || state === "furnace" || state === "chest" || state === "gunbench") {
              if (isTouch) {
                // 触屏设备：回退触摸自由模式（虚拟摇杆 + 隐藏指针）
                enterNoLock();
              } else {
                // 桌面：绝不带着自由鼠标进游戏（指针可见且转视角碰屏幕边缘会断）。
                // 保留菜单等玩家再点一次（新用户激活，锁定基本必成）；
                // 若刚关掉合成/熔炉/箱子面板，则落回暂停菜单，避免卡在无面板的夹缝状态
                if (state === "crafting" || state === "furnace" || state === "chest" || state === "gunbench") {
                  state = "paused";
                  showPauseMenu();
                }
                showToast("鼠标锁定未成功，请再点一次「继续游戏」");
              }
            }
          }, 300);
        }
      }, delay);
    });
  }
  function enterNoLock() {
    inNoLock = true;
    state = "playing";
    overlay.classList.add("hidden");
    crosshair.style.display = "block";
    hintEl.style.display = "block";
    syncTouchClass();
    maybeShowFreshSeed();
  }
  // 全新随机世界第一次进入时提示种子号（仅一次）
  let creativeHinted = false;
  function maybeShowFreshSeed() {
    if (freshWorldSeed) {
      showToast("新世界种子：" + freshWorldSeed);
      freshWorldSeed = 0;
    }
    if (creativeMode && !creativeHinted) {
      creativeHinted = true;
      showToast("无敌模式：不会受伤，按 E 打开创造物品栏无限取用方块与工具");
    }
  }
  // 锁定失败事件仅作日志用途，真正的重试/降级由 requestLock 轮询处理
  document.addEventListener("pointerlockerror", function () {});
  document.addEventListener("pointerlockchange", function () {
    // 死亡时解锁是死亡流程主动触发的，不进入暂停菜单
    if (state === "dead") return;
    const locked = document.pointerLockElement === renderer.domElement;
    if (locked) {
      inNoLock = false;   // 重新锁定成功：退出免锁定降级
      state = "playing";
      overlay.classList.add("hidden");
      crosshair.style.display = "block";
      hintEl.style.display = "block";
      syncTouchClass();
      maybeShowFreshSeed();
    } else {
      lockSeq++;   // 使任何在途中的重连锁失效
      if (state === "playing") state = "paused";
      if (state === "paused") showPauseMenu();
      crosshair.style.display = "none";
      hintEl.style.display = "none";
      // 释放按键，避免“卡键”
      input.forward = input.back = input.left = input.right = input.jump = input.down = false;
      clearSprintSources();
    }
  });

  respawnBtn.addEventListener("click", function () {
    respawnBtn.blur();
    respawn();
  });

  function showPauseMenu() {
    overlay.querySelector("h1").textContent = "游戏暂停";
    overlay.querySelector(".sub").textContent = creativeMode
      ? "无敌模式进行中 · 不会受伤，按 E 打开创造物品栏"
      : "休息一下，准备好后继续";
    playBtn.textContent = "继续游戏";
    saveBtn.classList.remove("hidden");
    exportBtn.classList.remove("hidden");
    newWorldBtn.classList.add("hidden");
    creativeBtn.classList.add("hidden");
    cloudBtn.classList.remove("hidden");
    cloudBtn.textContent = CloudSave.bound() ? "云存档（已绑定）…" : "云存档（绑定存档码）…";
    // 联机客人不持有存档，云绑定/同步只属于房主（或单机）
    if (Net && Net.isGuest && Net.isGuest()) cloudBtn.classList.add("hidden");
    SaveSystem.info().then(function (info) {
      if (info) {
        saveInfoEl.textContent = "上次保存：" + formatSaveTime(info.ts) +
          (info.backups ? " · 备份 " + info.backups + " 份" : "");
        saveInfoEl.classList.remove("hidden");
      } else saveInfoEl.classList.add("hidden");
    });
    overlay.classList.remove("hidden");
    // 进暂停菜单时静默自动保存，完成后刷新一次时间/备份数，
    // 避免菜单文本取到保存提交前的旧 info
    saveGame(true).then(function () {
      if (state !== "paused") return;
      SaveSystem.info().then(function (info) {
        if (info && state === "paused") {
          saveInfoEl.textContent = "上次保存：" + formatSaveTime(info.ts) +
            (info.backups ? " · 备份 " + info.backups + " 份" : "");
          saveInfoEl.classList.remove("hidden");
        }
      });
    }).catch(function () {});
    syncTouchClass();
  }

  // 进入“玩”的状态：桌面请求指针锁定（失败自动重试/看门狗兜底），触屏/不支持则免锁定
  function enterPlay() {
    if (forceNoLock || shouldAutoNoLock() || !pointerLockSupported) enterNoLock();
    else requestLock();
  }

  playBtn.addEventListener("click", function () {
    playBtn.blur();
    if (state !== "menu" && state !== "paused") return;
    if (state === "menu") {
      // 主菜单点「继续游戏」但本次启动未载入存档 -> 带 ?load=1 重开进游戏
      if (!pendingSave) {
        SaveSystem.has().then(function (exists) {
          if (exists) reloadWith({ load: 1 });
          else enterPlay();
        }).catch(function () { enterPlay(); });
        return;
      }
    }
    // 支持指针锁定就总是尝试（失败会在冷却期后自动重试，最终才降级）；
    // 触屏 / 不支持 / 显式 ?nolock 直接进入免锁定模式
    enterPlay();
  });

  saveBtn.addEventListener("click", function () {
    saveBtn.blur();
    saveGame(false);
  });

  exportBtn.addEventListener("click", function () {
    exportBtn.blur();
    exportSave();
  });

  newWorldBtn.addEventListener("click", function () {
    newWorldBtn.blur();
    if (!confirm("将清除当前存档并生成一个全新的世界，确定吗？")) return;
    suppressSave = true;            // 必须先置位，防止卸载时自动保存把档写回
    // 同时解除云绑定：否则新世界的自动保存会覆盖服务器上的旧世界档
    if (CloudSave.bound()) CloudSave.unbind();
    SaveSystem.clear().catch(function () {}).then(function () {
      reloadWith({ load: null, creative: null, cloud: null });
    });
  });

  // 无敌模式：清档开一个创造新世界（不会受伤 + E 键创造物品栏无限取用）
  creativeBtn.addEventListener("click", function () {
    creativeBtn.blur();
    SaveSystem.has().then(function (exists) {
      if (exists && !confirm("将清除当前存档并生成一个无敌模式的新世界，确定吗？")) return;
      suppressSave = true;
      if (CloudSave.bound()) CloudSave.unbind();
      SaveSystem.clear().catch(function () {}).then(function () {
        reloadWith({ creative: 1, load: null, cloud: null });
      });
    });
  });

  /* ---------------- 云端存档面板 ---------------- */

  const cloudOverlay = document.getElementById("cloud-overlay");
  const cloudLoadCode = document.getElementById("cloud-load-code");
  const cloudLoadPw = document.getElementById("cloud-load-pw");
  const cloudLoadErr = document.getElementById("cloud-load-err");
  const cloudBindCode = document.getElementById("cloud-bind-code");
  const cloudBindPw = document.getElementById("cloud-bind-pw");
  const cloudBindErr = document.getElementById("cloud-bind-err");
  const cloudBindRandom = document.getElementById("cloud-bind-random");
  const cloudManageCode = document.getElementById("cloud-manage-code");
  const cloudManageStatus = document.getElementById("cloud-manage-status");
  let cloudBusy = false;

  function cloudShowError(el, msg) {
    if (!msg) { el.classList.add("hidden"); el.textContent = ""; }
    else { el.textContent = msg; el.classList.remove("hidden"); }
  }

  function openCloudPage(name) {
    cloudOverlay.classList.remove("hidden");
    cloudOverlay.querySelectorAll("[data-cpage]").forEach(function (el) {
      el.classList.toggle("hidden", el.getAttribute("data-cpage") !== name);
    });
    cloudShowError(cloudLoadErr, null);
    cloudShowError(cloudBindErr, null);
    if (name === "bind" && !cloudBindCode.value) cloudBindCode.value = CloudSave.randomCode();
    if (name === "manage") {
      cloudManageCode.textContent = CloudSave.bound() || "------";
      renderCloudSyncStatus(null);
    }
    setTimeout(function () {
      if (name === "load") cloudLoadCode.focus();
      else if (name === "bind") cloudBindCode.focus();
    }, 30);
  }

  function closeCloud() {
    if (cloudBusy) return;
    cloudOverlay.classList.add("hidden");
  }

  function renderCloudSyncStatus(waitText) {
    const st = CloudSave.status();
    cloudManageStatus.classList.remove("cloud-ok", "cloud-bad", "cloud-wait");
    if (waitText || st.syncing) {
      cloudManageStatus.classList.add("cloud-wait");
      cloudManageStatus.textContent = waitText || "正在同步…";
    } else if (st.lastError) {
      cloudManageStatus.classList.add("cloud-bad");
      cloudManageStatus.textContent = "同步失败：" + CloudSave.errText(st.lastError);
    } else if (st.lastSyncTs) {
      cloudManageStatus.classList.add("cloud-ok");
      cloudManageStatus.textContent = "已同步到云端 · " + formatSaveTime(st.lastSyncTs);
    } else {
      cloudManageStatus.textContent = "本次游戏尚未同步";
    }
  }

  cloudBtn.addEventListener("click", function () {
    cloudBtn.blur();
    if (state === "menu") openCloudPage("load");
    else openCloudPage(CloudSave.bound() ? "manage" : "bind");
  });

  cloudOverlay.addEventListener("click", function (e) {
    if (e.target === cloudOverlay) closeCloud();   // 点黑色遮罩关闭
  });
  cloudOverlay.querySelectorAll("[data-cact='close']").forEach(function (b) {
    b.addEventListener("click", function () { b.blur(); closeCloud(); });
  });

  // 码输入框只留数字；Enter 直接提交
  [cloudLoadCode, cloudBindCode].forEach(function (inp) {
    inp.addEventListener("input", function () {
      inp.value = CloudSave.normalizeCode(inp.value);
    });
  });
  cloudLoadCode.addEventListener("keydown", function (e) {
    if (e.key === "Enter") cloudLoadPw.focus();
  });
  cloudLoadPw.addEventListener("keydown", function (e) {
    if (e.key === "Enter") cloudOverlay.querySelector("[data-cact='load-go']").click();
  });
  cloudBindCode.addEventListener("keydown", function (e) {
    if (e.key === "Enter") cloudBindPw.focus();
  });
  cloudBindPw.addEventListener("keydown", function (e) {
    if (e.key === "Enter") cloudOverlay.querySelector("[data-cact='bind-go']").click();
  });
  document.addEventListener("keydown", function (e) {
    if (e.code === "Escape" && !cloudOverlay.classList.contains("hidden")) {
      e.stopPropagation();
      closeCloud();
    }
  }, true);

  // 主菜单：读码 → 拉云端档 → 写本地 → 带档进入并自动绑定
  cloudOverlay.querySelector("[data-cact='load-go']").addEventListener("click", function () {
    const btn = this;
    if (cloudBusy) return;
    const code = CloudSave.normalizeCode(cloudLoadCode.value);
    const pw = cloudLoadPw.value;
    cloudShowError(cloudLoadErr, null);
    if (!CloudSave.isValidCode(code)) {
      cloudShowError(cloudLoadErr, "存档码必须是 3~8 位数字");
      return;
    }
    cloudBusy = true;
    btn.disabled = true;
    cloudShowError(cloudLoadErr, null);
    btn.textContent = "正在读取存档…";
    CloudSave.get(code, pw).then(function (j) {
      return SaveSystem.importRaw(j.data);
    }).then(function () {
      CloudSave.rememberPassword(code, pw);
      CloudSave.bind(code);
      // 清掉可能存在的联机参数，以单机云档身份进入；cloud 参数让新页面恢复绑定
      reloadWith({ load: 1, cloud: code, host: null, join: null });
    }).catch(function (err) {
      cloudBusy = false;
      btn.disabled = false;
      btn.textContent = "读取并进入世界";
      cloudShowError(cloudLoadErr, CloudSave.errText(err));
    });
  });

  // 暂停菜单：绑定码 → 本地先存一次 → 上传 → 记住绑定
  cloudOverlay.querySelector("[data-cact='bind-go']").addEventListener("click", function () {
    const btn = this;
    if (cloudBusy) return;
    const code = CloudSave.normalizeCode(cloudBindCode.value);
    const pw = cloudBindPw.value;
    cloudShowError(cloudBindErr, null);
    if (!CloudSave.isValidCode(code)) {
      cloudShowError(cloudBindErr, "存档码必须是 3~8 位数字，3 位也行");
      return;
    }
    cloudBusy = true;
    btn.disabled = true;
    btn.textContent = "正在保存到云端…";
    saveGame(true).then(function (ok) {
      if (!ok) throw new Error("local_save_failed");
      return SaveSystem.raw();
    }).then(function (raw) {
      return CloudSave.put(code, pw, raw);
    }).then(function (j) {
      CloudSave.bind(code);
      CloudSave.rememberPassword(code, pw);
      CloudSave.markSynced(j && j.ts);
      cloudBtn.textContent = "云存档（已绑定）…";
      cloudBusy = false;
      btn.disabled = false;
      btn.textContent = "绑定并立即上传";
      showToast("已绑定云存档码 " + code + "，以后自动同步 ✓");
      openCloudPage("manage");
    }).catch(function (err) {
      cloudBusy = false;
      btn.disabled = false;
      btn.textContent = "绑定并立即上传";
      cloudShowError(cloudBindErr, err.message === "local_save_failed"
        ? "本地保存失败，无法绑定" : CloudSave.errText(err));
    });
  });

  cloudBindRandom.addEventListener("click", function () {
    cloudBindRandom.blur();
    cloudBindCode.value = CloudSave.randomCode();
    cloudShowError(cloudBindErr, null);
    cloudBindPw.focus();
  });

  // 管理页：立即上传（saveGame 内部已含云同步）
  cloudOverlay.querySelector("[data-cact='sync-now']").addEventListener("click", function () {
    const btn = this;
    if (cloudBusy) return;
    cloudBusy = true;
    btn.disabled = true;
    renderCloudSyncStatus("正在保存并同步…");
    saveGame(true).then(function () {
      cloudBusy = false;
      btn.disabled = false;
      renderCloudSyncStatus(null);
      const st = CloudSave.status();
      if (st.lastError) showToast("云端同步失败：" + CloudSave.errText(st.lastError));
      else showToast("云端存档已更新 ✓（码 " + st.code + "）");
    });
  });

  // 解除绑定：只断本机自动同步，服务器上的存档文件保留
  cloudOverlay.querySelector("[data-cact='unbind']").addEventListener("click", function () {
    const btn = this;
    btn.blur();
    if (!confirm("解除后本机不再自动同步（服务器上的存档仍保留，随时可重新输码绑定），确定吗？")) return;
    CloudSave.unbind();
    cloudBtn.textContent = "云存档（绑定存档码）…";
    showToast("已解除云绑定，服务器存档仍保留");
    cloudBindCode.value = "";
    cloudBindPw.value = "";
    openCloudPage("bind");
  });

  // 切到后台 / 关闭页面前静默保存
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") saveGame(true);
  });
  window.addEventListener("beforeunload", function () { saveGame(true); });

  /* ---------------- 鼠标 ---------------- */
  // 捕获阶段：游戏进行中若鼠标未锁定（自由鼠标降级 / 异常丢锁），
  // 在画面上按下鼠标优先恢复指针锁定，并拦掉这次按下（避免误挖误放）。
  // 监听挂 document：canvas 自身 pointer-events 可能为 none，事件仍会到 document
  document.addEventListener("mousedown", function (e) {
    if (state === "playing" && !isTouch
        && document.pointerLockElement !== renderer.domElement
        // 自由鼠标模式下点装弹 HUD 正常响应按钮，不触发补锁吞点击
        && !(e.target.closest && e.target.closest("#gun-hud"))) {
      requestLock();
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  }, true);
  document.addEventListener("mousemove", function (e) {
    if (state !== "playing") return;
    // 未锁定且不是自由鼠标降级模式时不转视角（补锁中的一瞬间、异常丢锁兜底）
    if (document.pointerLockElement !== renderer.domElement && !inNoLock) return;
    player.addLook(e.movementX || 0, e.movementY || 0);
  });
  document.addEventListener("mousedown", function (e) {
    if (state !== "playing") return;
    if (e.button === 0) startAttack();
    else if (e.button === 2) interactTarget();
  });
  document.addEventListener("mouseup", function (e) {
    if (e.button === 0) stopMining();
  });
  // 持枪装弹按钮（触屏 / 自由鼠标模式可点；桌面指针锁定时用 R 键）
  if (gunReloadBtn) {
    gunReloadBtn.addEventListener("mousedown", function (e) { e.preventDefault(); e.stopPropagation(); });
    gunReloadBtn.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      startReload();
    });
  }
  // 窗口失焦时松开的按键收不到，主动终止挖掘
  window.addEventListener("blur", stopMining);
  document.addEventListener("contextmenu", function (e) { e.preventDefault(); });
  document.addEventListener("wheel", function (e) {
    if (state !== "playing") return;
    Crafting.selectDelta(e.deltaY > 0 ? 1 : -1);
    notifyGuestSelect();
  }, { passive: true });

  /* ---------------- 键盘 ---------------- */
  document.addEventListener("keydown", function (e) {
    // 合成 / 熔炉 / 储物箱 / 枪械工作台面板打开时：E / Esc 关闭面板；Q 把光标上抓着的整堆丢到地上
    if (state === "crafting" || state === "furnace" || state === "chest" || state === "gunbench") {
      if (e.code === "KeyE" || e.code === "Escape") {
        e.preventDefault();
        if (state === "furnace") closeFurnace();
        else if (state === "chest") closeChest();
        else if (state === "gunbench") closeGunbench();
        else closePanel();
      } else if (e.code === "KeyQ" && !e.repeat) {
        e.preventDefault();
        requestCursorDrop();
      }
      return;
    }
    if (state !== "playing") return;
    if (e.code === "Escape" && inNoLock) {
      state = "paused";
      showPauseMenu();
      input.forward = input.back = input.left = input.right = input.jump = input.down = false;
      clearSprintSources();
      return;
    }
    switch (e.code) {
      case "KeyW":
        input.forward = true;
        // 双击 W 进入奔跑（松开 W 结束）；e.repeat 时按住中不重复计次
        if (!e.repeat) {
          const nowW = performance.now();
          if (nowW - lastWPressTime < 280) sprintDoubleTap = true;
          lastWPressTime = nowW;
          syncSprintInput();
        }
        break;
      case "KeyS": input.back = true; break;
      case "KeyA": input.left = true; break;
      case "KeyD": input.right = true; break;
      case "KeyR":
        if (!e.repeat) {
          // 手持手枪时 R 是换弹；其它情况 R 仍是奔跑辅助键（双击 W 奔跑不受影响）
          if (window.GunMod && Crafting.getHeldId() === window.GunMod.pistol) {
            e.preventDefault();
            startReload();
          } else {
            sprintKeyHeld = true; syncSprintInput();
          }
        }
        break;
      case "ShiftLeft": case "ShiftRight":
        input.down = true;
        // 骑猪时按 Shift 下猪（放到猪的侧面，避免卡进方块）
        if (Mobs.isRiding()) {
          const mnt = Mobs.dismount();
          player.pos.set(mnt.pos.x + 0.9, mnt.pos.y + 0.2, mnt.pos.z);
          player.vel.set(0, 0, 0);
          showToast("已从猪背上下来");
        }
        break;
      case "KeyE":
      case "KeyC":
        e.preventDefault();
        openPanel("inventory");
        break;
      case "KeyQ":
        e.preventDefault();
        dropHeld();   // 长按连续丢弃，内部有 220ms 节流
        break;
      case "KeyV":
        thirdPerson = !thirdPerson;
        showToast(thirdPerson ? "已切换第三人称视角（再按 V 切回）" : "已切换第一人称视角");
        break;
      case "Space":
        input.jump = true;
        e.preventDefault();
        // 骑乘时空格是猪跳跃，不切换飞行；触屏设备（手机端）已移除飞行入口
        if (!e.repeat && !Mobs.isRiding() && !isTouch) {
          const now = performance.now();
          if (now - lastSpaceTime < 280) player.toggleFly();
          lastSpaceTime = now;
        }
        break;
      case "Digit1": case "Digit2": case "Digit3":
      case "Digit4": case "Digit5": case "Digit6":
      case "Digit7": case "Digit8": case "Digit9":
        Crafting.select(parseInt(e.code.slice(5), 10) - 1);
        notifyGuestSelect();
        break;
    }
  });
  document.addEventListener("keyup", function (e) {
    switch (e.code) {
      case "KeyW":
        input.forward = false;
        sprintDoubleTap = false;   // 松开前进即结束双击冲刺
        syncSprintInput();
        break;
      case "KeyS": input.back = false; break;
      case "KeyA": input.left = false; break;
      case "KeyD": input.right = false; break;
      case "KeyR":
        sprintKeyHeld = false;
        syncSprintInput();
        break;
      case "ShiftLeft": case "ShiftRight": input.down = false; break;
      case "Space": input.jump = false; break;
    }
  });

  /* ---------------- 面板开启时：光标抓物点遮罩空白 = 丢弃到地上 ---------------- */
  // 背包 / 工作台、熔炉、储物箱三套面板共用 Crafting.cursor，
  // 电脑鼠标与手机触摸都走这里（手机在背包里整理物品后可直接点黑边扔掉）
  ["crafting-overlay", "furnace-overlay", "chest-overlay", "gunbench-overlay"].forEach(function (oid) {
    const ov = document.getElementById(oid);
    if (!ov) return;
    const onPanelBackdrop = function (e) {
      if (ov.classList.contains("hidden")) return;
      // 只响应面板外的黑色遮罩区域；面板内部（含关闭按钮 / 空格子）一律忽略
      if (e.target.closest && e.target.closest(".craft-panel")) return;
      if (Crafting.cursor) {
        e.preventDefault();
        requestCursorDrop();
      }
    };
    ov.addEventListener("mousedown", onPanelBackdrop);
    ov.addEventListener("touchstart", onPanelBackdrop, { passive: false });
  });

  /* ---------------- 手机触屏操作 ---------------- */

  const joyZone = document.getElementById("joy-zone");
  const joyBase = document.getElementById("joy-base");
  const joyKnob = document.getElementById("joy-knob");

  let joyId = null, joyCx = 0, joyCy = 0;
  let lookId = null, lookX = 0, lookY = 0;
  const JOY_R = 46, JOY_DEAD = 0.32, JOY_SPRINT = 0.9;   // 向前推过 90% 外圈 = 奔跑

  function findTouch(list, id) {
    for (let i = 0; i < list.length; i++) if (list[i].identifier === id) return list[i];
    return null;
  }
  function releaseMoveInput() {
    input.forward = input.back = input.left = input.right = false;
  }
  function resetJoy() {
    joyId = null;
    releaseMoveInput();
    joySprint = false;
    syncSprintInput();
    joyZone.classList.remove("active");
    joyKnob.style.transform = "";
  }

  // 左半屏虚拟摇杆：手指按下的位置为摇杆中心，拖动方向 = WASD
  joyZone.addEventListener("touchstart", function (e) {
    if (state !== "playing" || joyId !== null) return;
    const t = e.changedTouches[0];
    joyId = t.identifier;
    joyCx = t.clientX; joyCy = t.clientY;
    const r = joyZone.getBoundingClientRect();
    joyBase.style.left = (joyCx - r.left) + "px";
    joyBase.style.top = (joyCy - r.top) + "px";
    joyZone.classList.add("active");
    e.preventDefault();
  }, { passive: false });

  joyZone.addEventListener("touchmove", function (e) {
    if (joyId === null) return;
    const t = findTouch(e.changedTouches, joyId);
    if (!t) return;
    let dx = t.clientX - joyCx, dy = t.clientY - joyCy;
    const d = Math.hypot(dx, dy) || 1;
    const clamped = Math.min(d, JOY_R);
    dx = dx / d * clamped; dy = dy / d * clamped;
    joyKnob.style.transform = "translate(" + dx + "px," + dy + "px)";
    const nx = dx / JOY_R, ny = dy / JOY_R;
    input.forward = ny < -JOY_DEAD;
    input.back = ny > JOY_DEAD;
    input.right = nx > JOY_DEAD;
    input.left = nx < -JOY_DEAD;
    // 笔直向前推满外圈即奔跑（与 MC 手机版一致）；斜向 / 后退不触发
    const wasJoySprint = joySprint;
    joySprint = ny < -JOY_SPRINT && Math.abs(nx) < 0.42;
    if (wasJoySprint !== joySprint) syncSprintInput();
    e.preventDefault();
  }, { passive: false });

  function joyEnd(e) {
    if (joyId === null) return;
    // changedTouches 里包含本摇杆手指 -> 本次抬手是它，复位；否则是别的手指，忽略
    if (!findTouch(e.changedTouches, joyId)) return;
    resetJoy();
  }
  joyZone.addEventListener("touchend", joyEnd);
  joyZone.addEventListener("touchcancel", joyEnd);

  // 右侧（非摇杆 / 非按钮区）拖动 = 转视角；事件直接挂在 canvas 上，
  // 按钮与摇杆是独立 DOM，它们的触摸不会冒泡到这里
  renderer.domElement.addEventListener("touchstart", function (e) {
    if (state !== "playing" || lookId !== null) return;
    const t = e.changedTouches[0];
    lookId = t.identifier; lookX = t.clientX; lookY = t.clientY;
    e.preventDefault();
  }, { passive: false });
  renderer.domElement.addEventListener("touchmove", function (e) {
    if (lookId === null) return;
    const t = findTouch(e.changedTouches, lookId);
    if (!t) return;
    player.addLook(t.clientX - lookX, t.clientY - lookY);
    lookX = t.clientX; lookY = t.clientY;
    e.preventDefault();
  }, { passive: false });
  function lookEnd(e) {
    if (lookId === null) return;
    if (!findTouch(e.changedTouches, lookId)) return;
    lookId = null;
  }
  renderer.domElement.addEventListener("touchend", lookEnd);
  renderer.domElement.addEventListener("touchcancel", lookEnd);

  // 按住型按钮（跳 / 下蹲下降）
  function bindHold(id, onDown, onUp) {
    const el = document.getElementById(id);
    el.addEventListener("touchstart", function (e) {
      e.preventDefault();
      el.classList.add("active");
      onDown();
    }, { passive: false });
    const up = function (e) {
      e.preventDefault();
      el.classList.remove("active");
      onUp();
    };
    el.addEventListener("touchend", up);
    el.addEventListener("touchcancel", up);
  }
  // 点按型按钮
  function bindTap(id, fn) {
    const el = document.getElementById(id);
    el.addEventListener("touchstart", function (e) {
      e.preventDefault();
      el.classList.add("active");
      fn();
    }, { passive: false });
    el.addEventListener("touchend", function (e) {
      e.preventDefault();
      el.classList.remove("active");
    });
    el.addEventListener("touchcancel", function () { el.classList.remove("active"); });
  }

  // 跳：纯跳跃（手机端不提供飞行入口；飞行仅电脑双击空格）
  bindHold("t-jump",
    function () { if (state === "playing") input.jump = true; },
    function () { input.jump = false; }
  );
  bindHold("t-down",
    function () {
      if (state !== "playing") return;
      // 骑猪时点此键下猪（等同电脑 Shift）
      if (Mobs.isRiding()) {
        const mnt = Mobs.dismount();
        player.pos.set(mnt.pos.x + 0.9, mnt.pos.y + 0.2, mnt.pos.z);
        player.vel.set(0, 0, 0);
        showToast("已从猪背上下来");
      } else {
        input.down = true;
      }
    },
    function () { input.down = false; }
  );
  bindHold("t-attack",
    function () { if (state === "playing") startAttack(); },
    function () { stopMining(); }
  );
  bindTap("t-use", function () { if (state === "playing") interactTarget(); });
  bindTap("t-inv", function () {
    if (state === "playing") openPanel("inventory");
    else if (state === "crafting") closePanel();
    else if (state === "furnace") closeFurnace();
    else if (state === "chest") closeChest();
    else if (state === "gunbench") closeGunbench();
  });
  bindTap("t-drop", function () {
    if (state !== "playing") return;
    // 手机上没有悬停提示，空手点丢弃时给一句轻提示
    if (!Crafting.getHeld()) { showToast("当前选中的格子是空的"); return; }
    dropHeld();
  });
  bindTap("t-pause", function () {
    if (state !== "playing") return;
    state = "paused";
    showPauseMenu();
    releaseMoveInput();
    input.jump = input.down = false;
    resetJoy();
    lookId = null;
  });

  // 点按快捷栏选格（电脑用数字键 / 滚轮，手机没有这些，直接点格子）
  hotbarEl.addEventListener("touchstart", function (e) {
    if (state !== "playing") return;
    const slotEl = e.target.closest ? e.target.closest("[data-loc]") : null;
    if (!slotEl || !hotbarEl.contains(slotEl)) return;
    const idx = parseInt(String(slotEl.dataset.loc).split(":")[1], 10);
    if (!isNaN(idx)) {
      Crafting.select(idx);
      notifyGuestSelect();
      e.preventDefault();
    }
  }, { passive: false });

  // 非游戏状态（面板 / 暂停 / 死亡）下，松开所有触屏输入，防止“卡键”
  function touchStateGuard() {
    if (state !== "playing") {
      if (joyId !== null) resetJoy();
      if (lookId !== null) lookId = null;
      input.jump = input.down = false;
      joySprint = false;
      syncSprintInput();
      stopMining();
    }
    syncTouchClass();
  }
  // 触屏 UI 只在游戏进行中显示（is-touch-device 由初始化时加给 body）
  function syncTouchClass() {
    document.body.classList.toggle("touch-on", state === "playing");
  }

  /* ---------------- 自适应窗口 ---------------- */
  window.addEventListener("resize", function () {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    if (window.ViewModel && ViewModel.vmCamera) {
      ViewModel.vmCamera.aspect = camera.aspect;
      ViewModel.vmCamera.updateProjectionMatrix();
    }
  });

  /* ---------------- 调试信息 ---------------- */
  let fpsAccum = 0, fpsFrames = 0, fps = 0, debugTimer = 0;
  function updateDebug(dt) {
    fpsAccum += dt; fpsFrames++;
    debugTimer += dt;
    if (fpsAccum >= 0.5) {
      fps = Math.round(fpsFrames / fpsAccum);
      fpsAccum = 0; fpsFrames = 0;
    }
    if (debugTimer < 0.2) return;
    debugTimer = 0;
    if (state !== "playing" && state !== "paused" && state !== "crafting") { debugEl.textContent = ""; return; }
    const p = player.pos;
    const moveMode = player.flying ? "飞行" : (player.eyeInWater ? "潜水" : player.feetInWater ? "水中" : (player.onGround ? "地面" : "空中"));
    const mode = state === "crafting" ? (panelMode === "table" ? "工作台" : "合成中") : moveMode;
    const held = Crafting.getHeld();
    debugEl.textContent =
      "FPS " + fps + "\n" +
      "XYZ  " + p.x.toFixed(1) + " / " + p.y.toFixed(1) + " / " + p.z.toFixed(1) + "\n" +
      "朝向  yaw " + Math.round(THREE.MathUtils.radToDeg(player.yaw) % 360) +
      "°  pitch " + Math.round(THREE.MathUtils.radToDeg(player.pitch)) + "°\n" +
      "状态  " + mode +
      "   手持 [" + (Crafting.selected + 1) + "] " + (held ? getItemName(held.id) + " ×" + held.count : "空") + "\n" +
      "区块 " + world.chunks.size;
  }

  /* ---------------- 主菜单环绕镜头 ---------------- */
  function orbitCamera(t) {
    if (!spawnPoint) return;
    const a = t * 0.18;
    const r = 26;
    camera.position.set(
      spawnPoint.x + Math.cos(a) * r,
      spawnPoint.y + 17,
      spawnPoint.z + Math.sin(a) * r
    );
    camera.lookAt(spawnPoint.x, spawnPoint.y + 1, spawnPoint.z);
  }

  /* ---------------- 主循环 ---------------- */
  const clock = new THREE.Clock();
  let elapsed = 0;
  // 奔跑镜头反馈：FOV 在 75 <-> 85 间平滑；头部摆动相位 / 当前幅度
  const BASE_FOV = 75, SPRINT_FOV = 85;
  let bobPhase = 0, bobAmp = 0;
  // 雨声室内判定：相机头顶向上扫到实心块 = 有遮蔽（雨声闷响），0.3s 缓存
  let shelterT = 0, sheltered = false;
  function checkShelter(dt) {
    shelterT -= dt;
    if (shelterT > 0) return sheltered;
    shelterT = 0.3;
    const x = Math.floor(camera.position.x);
    const z = Math.floor(camera.position.z);
    const y0 = Math.floor(camera.position.y) + 1;
    sheltered = false;
    for (let i = 0; i < 24; i++) {
      if (isSolid(world.getBlock(x, y0 + i, z))) { sheltered = true; break; }
    }
    return sheltered;
  }
  function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);
    elapsed += dt;

    // 渐变天空始终罩在相机周围
    skyDome.position.copy(camera.position);

    // 调试：锁定昼夜相位（仅房主/单机；客人权威在房主，忽略本地锁定）
    if (window.__lockPhase != null && !Net.isGuest()) Weather.phase = window.__lockPhase;
    // 昼夜 / 天气：房主/单机推进并返回权威状态；
    // 客人只做远端状态的纯渲染（雨粒子本地下降、天空光照、HUD），绝不推进 phase
    let wx;
    if (Net.isGuest()) { Weather.renderRemote(dt, camera.position); wx = Weather.snapshot(); }
    else wx = Weather.update(dt, camera.position);

    // 环境音效床层：增益跟降水量 / 暴雨风，室内闷化，非游戏中压低总线
    SFX.update(dt, {
      precip: wx.precip,
      storm: Weather.weather === "storm",
      indoors: checkShelter(dt),
      playing: state === "playing"
    });

    // 岩浆自发光：夜里烧亮，白天压回微光；伴随轻微“沸腾”闪烁
    {
      const nightF = 1 - wx.dayF;
      const flick = 0.03 * Math.sin(elapsed * 7.7) + 0.02 * Math.sin(elapsed * 13.1 + 1.3);
      const glow = Math.max(0, 0.16 + nightF * 0.95 + flick);
      world.opaqueMaterial.emissiveIntensity = glow;
      world.lavaMaterial.emissiveIntensity = Math.max(0.35, glow);
      // 岩浆贴图持续向下流动（纵向快、横向慢，形成翻涌感）
      world.lavaMaterial.map.offset.set(elapsed * 0.025, elapsed * 0.11);
      world.lavaMaterial.emissiveMap.offset.copy(world.lavaMaterial.map.offset);
      // 水面：贴图缓慢下滚（纵向主流 + 轻微斜漂）+ 顶点微波相位推进
      world.waterMaterial.map.offset.set(elapsed * 0.012, -elapsed * 0.05);
      world.waterUniforms.uTime.value = elapsed;
      // 点光源有 9 盏，离火山远时不参与渲染（单向开启，避免反复编译卡顿）
      if (!lavaLightsOn && volcanoCenter && lavaLights.length) {
        const dx = camera.position.x - volcanoCenter.x, dz = camera.position.z - volcanoCenter.z;
        if (dx * dx + dz * dz < 80 * 80) {
          lavaLights.forEach(o => { o.l.visible = true; });
          lavaLightsOn = true;
        }
      }
      if (lavaLightsOn) {
        for (const o of lavaLights) {
          o.l.intensity = o.base *
            (0.86 + 0.1 * Math.sin(elapsed * o.sp + o.ph) + 0.04 * Math.sin(elapsed * o.sp * 2.3 + o.ph * 1.7));
        }
      }
    }

    if (state === "playing") {
      // 战斗计时器：攻击冷却 / 受伤无敌帧
      attackCd = Math.max(0, attackCd - dt);
      hurtInvuln = Math.max(0, hurtInvuln - dt);
      guestHurtInvuln = Math.max(0, guestHurtInvuln - dt);
      // 按住左键持续挖掘（按硬度表计时）
      updateMining(dt);
      // 手枪：开火冷却 / 换弹结算 / 装弹 HUD
      updateGun(dt);
      // 火把动态点光
      updateTorchLights(dt, elapsed);
      // Mod 每帧逻辑（作物生长等），异常隔离不炸主循环
      // 客人端不跑模拟（作物/流体变化权威在房主，Task 4/11 只接收结果）
      if (!Net.isGuest()) {
        for (let mi = 0; mi < GameRegistry.tickHooks.length; mi++) {
          try { GameRegistry.tickHooks[mi]({ world: world, elapsed: elapsed, dt: dt, player: player }); }
          catch (e) { console.error("[mod tick]", e); }
        }
      }
      // 小草随风摆动
      world.updateWind(elapsed);
      // 岩浆流动模拟（挖开岩浆下方/旁边的方块后，岩浆会逐格倾泻、扩散）
      // 异常隔离：流体模拟绝不能饿死房主权威同步（方块 blk 在其后 flush），
      // 单帧异常记录到 lastLavaError 供探针读取，下一帧继续重试
      if (!Net.isGuest()) {
        try { world.updateLava(dt); }
        catch (e) { lastLavaError = String((e && e.stack) || e); console.error("[lava tick]", e); }
      }
      // 房主权威：本帧所有方块变更（挖掘/放置/岩浆/作物）收口为一条 blk 推送，
      // world 层已按坐标去重保留最终值；另有 200ms 安全网定时器兜底
      if (Net.isHost()) flushHostBlocks();
      // 定时自动存档
      autoSaveT += dt;
      if (autoSaveT >= AUTOSAVE_EVERY) { autoSaveT = 0; saveGame(true); }
      // 脱战 8 秒后缓慢回血（每 1.2 秒 1 点）
      if (playerHp < HP_MAX && playerHp > 0) {
        if (elapsed - lastHurtAt > 8) {
          regenT += dt;
          if (regenT >= 1.2) {
            regenT = 0;
            playerHp = Math.min(HP_MAX, playerHp + 1);
            updateHearts();
          }
        } else regenT = 0;
      }

      // 骑猪时：WASD/空格转为猪的操控指令，玩家自身不走动物理
      const riding = Mobs.isRiding();
      let steer = null;
      if (riding) {
        let mx = 0, mz = 0;
        if (input.forward) mz += 1;
        if (input.back) mz -= 1;
        if (input.right) mx += 1;
        if (input.left) mx -= 1;
        const sin = Math.sin(player.yaw), cos = Math.cos(player.yaw);
        const wx = -sin * mz + cos * mx;
        const wz = -cos * mz - sin * mx;
        const l = Math.hypot(wx, wz);
        steer = { x: l > 0 ? wx / l : 0, z: l > 0 ? wz / l : 0, jump: input.jump };
      } else {
        player.update(dt, input);
      }

      // 天气系统每帧已设置天空 / 雾色；水下时覆盖为蓝色
      if (player.eyeInWater) {
        scene.fog.color.setHex(UNDERWATER_COLOR);
        scene.background.setHex(UNDERWATER_COLOR);
      }
      // 岩浆：脚或眼睛没入岩浆时持续烫伤，并罩上橙红雾色
      {
        const lx = Math.floor(player.pos.x), lz = Math.floor(player.pos.z);
        const inLava = isLava(world.getBlock(lx, Math.floor(player.pos.y), lz)) ||
                       isLava(world.getBlock(lx, Math.floor(player.pos.y + player.eyeHeight), lz));
        if (inLava) {
          lavaT += dt;
          if (lavaT >= 0.5) { lavaT = 0; lastDeathCause = "掉进岩浆里被烧倒了……"; hurtPlayer(2, null); }
          scene.fog.color.setHex(LAVA_FOG_COLOR);
          scene.background.setHex(LAVA_FOG_COLOR);
        } else {
          lavaT = 0;
        }
      }
      // 仙人掌：身体 AABB 外扩一点碰到就持续扎血
      {
        const chw = player.width / 2 + 0.05;
        const pp = player.pos;
        let touchCactus = false;
        for (let x = Math.floor(pp.x - chw); x <= Math.floor(pp.x + chw) && !touchCactus; x++) {
          for (let y = Math.floor(pp.y + 0.05); y <= Math.floor(pp.y + player.height - 0.05); y++) {
            for (let z = Math.floor(pp.z - chw); z <= Math.floor(pp.z + chw); z++) {
              if (world.getBlock(x, y, z) === BLOCK.CACTUS) { touchCactus = true; break; }
            }
            if (touchCactus) break;
          }
        }
        if (touchCactus) {
          cactusT += dt;
          if (cactusT >= 0.5) { cactusT = 0; hurtPlayer(1, null); }
        } else {
          cactusT = 0;
        }
      }
      // 云缓慢漂移
      clouds.position.x = (elapsed * 0.9) % 18 - 9;
      // 掉出世界 -> 重生
      if (player.pos.y < -14) {
        player.setSpawn(spawnPoint);
      }
      particles.update(dt);

      // 夜晚在玩家周围刷怪（僵尸 / 蜘蛛合计上限 6 只）；
      // 白天烈日下僵尸会在 Mobs 内自燃，蜘蛛不燃烧、转为中立游荡
      // 客人端不刷怪、不跑生物 AI（Task 8 起由房主快照驱动网络实体）
      if (!Net.isGuest()) {
        if (wx.isNight) {
          monsterSpawnT -= dt;
          if (monsterSpawnT <= 0) {
            if (Mobs.countMonsters() < MONSTER_MAX) {
              // 联机时怪物在房主与在线客人之间随机选一人身边刷出，
              // 避免客人独自走远后整片区域整夜无怪
              const centers = [player.pos];
              if (Net.isHost() && hostGuestOnline && guestReady && guestActor && !guestDead) {
                centers.push(guestActor.pos);
              }
              const center = centers[(Math.random() * centers.length) | 0];
              // 约 45% 刷蜘蛛，其余刷僵尸
              if (Math.random() < 0.45) Mobs.spawnSpider(world, center);
              else Mobs.spawnZombie(world, center);
            }
            monsterSpawnT = 2.5 + Math.random() * 3.5;
          }
        } else {
          monsterSpawnT = Math.min(monsterSpawnT, 2);
        }

        // 动物：游荡 / 战斗 AI / 掉落物（远处自动冻结 AI）
        // 房主联机时收集者含客人影子：客人打死后的掉落物由房主裁决入客人背包
        // holders：手持竹子 / 竹笋的玩家（含客人影子）会吸引熊猫靠近
        const mobHolders = [{ pos: player.pos, id: Crafting.getHeldId() }];
        if (Net.isHost() && hostGuestOnline && guestReady && guestActor && guestActor.pos && !guestDead) {
          mobHolders.push({ pos: guestActor.pos, id: guestActor.getHeldId() });
        }
        Mobs.update(dt, player.pos, {
          steer: riding ? steer : null,
          sunBurn: wx.sunBurn,
          collectors: makeDropCollectors(player.pos),
          holders: mobHolders,
          actors: makeMobTargets(player.pos)
        });
        flushGuestInv();
      } else {
        // 客人端：只推进网络镜像（插值 / 步态 / 血条 / 掉落物旋转），不跑 AI 与物理
        Mobs.netUpdate(dt);
      }

      // 骑乘：相机绑定到猪背上
      if (riding) {
        const mnt = Mobs.getMount();
        player.pos.set(mnt.pos.x, mnt.pos.y + 0.62, mnt.pos.z);
        player.vel.set(0, 0, 0);
        player.checkWater();
        camera.position.set(player.pos.x, player.pos.y + player.eyeHeight, player.pos.z);
        camera.rotation.set(player.pitch, player.yaw, 0);
      }

      // 联机体积碰撞：骑乘时位置绑定在坐骑上，跳过玩家间推挤
      if (!riding) resolvePlayerPush();

      /* ---- 奔跑镜头反馈：第一人称头部摆动 ----
       * 按真实水平速度驱动，起步 / 停止自然淡入淡出，奔跑时频率更快、
       * 起伏更大（只动相机位置、不滚转地平线，避免眩晕）。
       * FOV 扩张在 if/else 之外统一处理（菜单态也要平滑收回）。 */
      if (!thirdPerson && !riding) {
        const hSpeed = Math.hypot(player.vel.x, player.vel.z);
        const moveT = Math.max(0, Math.min(1, (hSpeed - 0.6) / (player.walkSpeed - 0.6)));
        const sprintT = player.sprinting
          ? Math.max(0, Math.min(1, (hSpeed - player.walkSpeed * 0.98) /
                                    (player.sprintSpeed - player.walkSpeed * 0.98)))
          : 0;
        bobAmp += (moveT - bobAmp) * Math.min(1, dt * 10);
        if (bobAmp > 0.001) bobPhase += dt * (9.2 + sprintT * 4.6);
        const ampY = (0.030 + 0.028 * sprintT) * bobAmp;   // 走路 ±3cm，奔跑 ±5.8cm
        const ampX = (0.014 + 0.016 * sprintT) * bobAmp;
        camera.position.y += Math.sin(bobPhase) * ampY;
        camera.position.x += Math.cos(player.yaw) * Math.cos(bobPhase * 0.5) * ampX;
        camera.position.z += -Math.sin(player.yaw) * Math.cos(bobPhase * 0.5) * ampX;
      } else {
        bobAmp += (0 - bobAmp) * Math.min(1, dt * 10);
      }

      // 此刻 camera 位于玩家眼睛处：记录眼睛位置（第三人称准星射线仍从眼睛出发）
      eyePos.copy(camera.position);

      // 第一人称右手：手持物随物品栏切换，移动时手臂摆动（第三人称时隐藏）
      ViewModel.setHeld(Crafting.getHeldId());
      // 第三人称身体的右手同步拿同一件物品（setHeld 内部按 id 去重）
      PlayerModel.setHeld(Crafting.getHeldId());
      const moving = (input.forward || input.back || input.left || input.right) && player.onGround;
      const sprintingNow = !!player.sprinting && !riding;
      ViewModel.update(dt, !!moving && !riding, player.pitch, sprintingNow);
      ViewModel.setVisible(!thirdPerson);

      // 玩家 3D 身体：跟随位置 / 朝向，走路四肢摆动、挖放挥手
      PlayerModel.update(dt, {
        pos: player.pos, yaw: player.yaw, pitch: player.pitch,
        moving: !!moving && !riding, sprint: sprintingNow, onGround: player.onGround,
        riding: riding, firstPerson: !thirdPerson
      });
      PlayerModel.setVisible(true);

      // 联机：20Hz 上报本端位姿，并插值渲染对方玩家的第三人称身体
      dbgFrameN++; dbgDt = dt;
      poseSendAcc += dt;
      if (poseSendAcc >= POSE_SEND_EVERY) { poseSendAcc = 0; sendLocalPose(); }
      updateRemoteAvatar(dt);

      // 第三人称：相机移到玩家身后（必须在 player.update / 骑乘绑定之后执行）
      if (thirdPerson) applyThirdPersonCamera();
    } else {
      ViewModel.setVisible(false);
      PlayerModel.setVisible(false);
      if (remoteAvatar) remoteAvatar.model.setVisible(false);
      if (state === "menu") {
        orbitCamera(elapsed);
        clouds.position.x = (elapsed * 0.9) % 18 - 9;
        particles.update(dt);
        // 菜单环绕时动物照常活动；房主等客人加载期间客人已可游玩，掉落物照常裁决
        if (spawnPoint && !Net.isGuest()) {
          Mobs.update(dt, spawnPoint, {
            sunBurn: wx.sunBurn,
            collectors: makeDropCollectors(spawnPoint),
            // 房主在开始面板等待时客人已能游玩：龙仍要以客人为目标（房主本人在菜单不受伤）
            actors: makeMobTargets(spawnPoint)
          });
          flushGuestInv();
        }
        else if (Net.isGuest()) Mobs.netUpdate(dt);   // 客人菜单态也保持网络镜像动画
        // 菜单停留时间不计入“脱战回血”计时
        if (pendingSave) { lastHurtAt = elapsed; regenT = 0; }
      }
    }

    updateHighlight();
    // 熔炉烧炼计时（仅面板打开时内部推进）
    Furnace.tick(dt);
    updateDebug(dt);
    // 游戏进行中：指针已锁定时系统本来就隐藏指针；真触屏降级模式主动隐藏；
    // 桌面自由鼠标模式必须保留可见指针（玩家靠它点击画面重新锁定）
    const lockedNow = document.pointerLockElement === renderer.domElement;
    document.body.classList.toggle("hide-cursor",
      state === "playing" && (lockedNow || (isTouch && inNoLock)));
    // 看门狗：playing 但既没锁定也没降级（正常时序下不可达，pointerlockchange 会转暂停）
    // —— 锁定意外丢失时兜底暂停，绝不让玩家在自由鼠标下挨打
    if (state === "playing" && !isTouch && !inNoLock && !lockedNow) {
      state = "paused";
      showPauseMenu();
    }
    touchStateGuard();
    // 奔跑 FOV 平滑扩张（75° -> 85°）；非游戏中 / 未奔跑时平滑收回。
    // 手持手臂用独立叠加相机，FOV 必须同步，否则冲刺时手与世界透视脱节
    const fovWant = (player && state === "playing" && player.sprinting) ? SPRINT_FOV : BASE_FOV;
    if (Math.abs(camera.fov - fovWant) > 0.01) {
      camera.fov += (fovWant - camera.fov) * Math.min(1, dt * 9);
      camera.updateProjectionMatrix();
      ViewModel.vmCamera.fov = camera.fov;
      ViewModel.vmCamera.updateProjectionMatrix();
    }
    // 无限世界流送：以玩家为中心补数据/建网格/卸载远方（客人 welcome 前不流送）
    if (player && (!isGuestBoot || guestLoaded)) {
      world.updateStreaming(player.pos.x, player.pos.z, 6);
    }
    renderer.render(scene, camera);
    ViewModel.render();
  }

  /* ---------------- 联机：世界握手与客人加载（Task 3：种子 + 世界差异） ---------------- */
  // 协议说明：
  //   guest -> host  hello{v}
  //   host  -> guest welcome{v,seed,spawn,dirty:[[x,y,z,id]...],wx:{phase,weather}}
  //                  end{reason}（版本不符等拒绝情况）
  // 世界同步策略：同种子确定性生成保证地形一致；host 用 headless 临时世界跑一遍
  // generate()，逐字节对比出运行时被改动的方块（稀疏 dirty 列表），客人叠加后
  // 再分帧重建网格。后续任务会把“首次全量 diff”升级为“增量 blk 推送”。
  const NET_V = 5;   // v5：方块 blk/welcome 增加 meta（熔炉朝向）；v4：死亡 pd/重生 pr 互通知 + 装备散落
  let netSide = null;        // 本页面曾承担的联机角色（close 后仍保留，用于分流）
  let guestLoaded = false;   // 客人是否已完成 welcome 世界加载
  let guestReady = false;    // 房主侧：客人已完成加载并发来 ready
  // 客人侧：房主死亡态。收到 pd 置 true 期间丢弃一切在途 pp，尸体不会原地重现；
  // 收到房主重生 pr 后等其出生点附近的首个 pp 再恢复化身（pp 走不可靠通道，
  // 与可靠通道的 pr 之间无严格先后，死亡点迟到包必须按位置丢弃）
  let hostDead = false;
  let hostRespawning = false;
  const hostRespawnPoint = new THREE.Vector3();
  let hostSyncTimer = 0;     // 房主侧：es 10Hz + ea/wx 2Hz 同步定时器
  let hostSyncTick = 0;
  // 客人在 welcome 地形分帧构建期间到达的 blk 先缓存，建完后按序补应用
  let netBlocksLive = false;
  const pendingNetBlocks = [];
  // Task 4 测试探针：blk flush 次数（每帧至多 1）、累计格数、最近一帧格数
  let netBlkFlushes = 0, netBlkCells = 0, netBlkLast = 0;
  let lastLavaError = null, lastBlkError = null;
  let hostBlkSafetyTimer = 0;

  // 收口并广播房主本批方块变更；tick 每帧调用，另有 200ms 安全网定时器兜底，
  // 使任意单帧异常/卡顿都无法永久饿死房主权威方块同步（takeDirtyBlocks 取出即清空，不会重复发送）
  function flushHostBlocks() {
    if (!Net.isHost()) return;
    try {
      const changed = world.takeDirtyBlocks();
      if (changed && changed.length) {
        Net.send({ t: "blk", c: changed });
        netBlkFlushes++;
        netBlkCells += changed.length;
        netBlkLast = changed.length;
      }
    } catch (e) { lastBlkError = String((e && e.stack) || e); console.error("[blk flush]", e); }
  }

  /* ============================================================
   * Task 6（部分）：远端玩家化身
   *   协议 pp（ch-u 不可靠，双向 20Hz）：
   *     {t:"pp", p:[x,y,z]脚底坐标, yaw, pitch,
   *      f: 位域 bit0=onGround, sel: 热栏选中, sw: 本拍挥臂脉冲}
   *   客人移动是本地物理预测，房主只做世界边界钳制后直接采用；
   *   两端各维护一具对方的第三人称身体，位置/朝向指数插值，
   *   步态由渲染位移反推（与生物镜像一致），>4 格跳变（重生/传送）直接吸附。
   * ============================================================ */
  let remoteAvatar = null;
  let dbgFrameN = 0, dbgDt = 0;   // 调试：playing 分支帧计数 / 最新 dt
  let poseSendAcc = 0;
  let localSwingPulse = false;
  const POSE_SEND_EVERY = 0.05;

  function r3(v) { return Math.round(v * 1000) / 1000; }

  function ensureRemoteAvatar() {
    if (remoteAvatar) return remoteAvatar;
    remoteAvatar = {
      live: false,
      model: PlayerModel.create(scene),
      target: new THREE.Vector3(),
      cur: null,                    // 首包前不渲染，避免从原点滑入
      yaw: 0, pitch: 0, targetYaw: 0, targetPitch: 0,
      onGround: true, lastX: 0, lastZ: 0, heldId: 0
    };
    return remoteAvatar;
  }
  function showRemoteAvatar() {
    const av = ensureRemoteAvatar();
    av.live = true;
    return av;
  }
  function hideRemoteAvatar() {
    if (!remoteAvatar) return;
    remoteAvatar.live = false;
    remoteAvatar.model.setVisible(false);
    remoteAvatar.cur = null;        // 重连后在新位置重新吸附
    remoteAvatar.heldId = 0;        // 重连后空手，等首个 pp 再给物品
    remoteAvatar.model.setHeld(0);
  }

  // 仅在本端 playing 时调用；暂停/菜单时化身隐藏（暂停不影响对方端对本端的判断）
  function updateRemoteAvatar(dt) {
    const av = remoteAvatar;
    if (!av || !av.live) return;
    av.model.setVisible(true);
    if (!av.cur) {
      av.cur = av.target.clone();
      av.yaw = av.targetYaw; av.pitch = av.targetPitch;
      av.lastX = av.cur.x; av.lastZ = av.cur.z;
    }
    const k = 1 - Math.exp(-14 * dt);
    if (av.cur.distanceTo(av.target) > 4) av.cur.copy(av.target);
    else av.cur.lerp(av.target, k);
    let dy = av.targetYaw - av.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    av.yaw += dy * Math.min(1, dt * 10);
    av.pitch += (av.targetPitch - av.pitch) * Math.min(1, dt * 10);
    const spd = Math.hypot(av.cur.x - av.lastX, av.cur.z - av.lastZ) / Math.max(dt, 1e-4);
    av.lastX = av.cur.x; av.lastZ = av.cur.z;
    av.model.update(dt, {
      pos: av.cur, yaw: av.yaw, pitch: av.pitch,
      moving: spd > 0.6,
      sprint: spd > player.walkSpeed * 1.12,   // 插值速度明显快于步行 = 对方在奔跑
      onGround: av.onGround, riding: false, firstPerson: false
    });
    av.model.setHeld(av.heldId || 0);
  }

  /* ============================================================
   * 联机玩家体积碰撞（推挤）——单一解算函数、单一调用点
   *   每端只把【本地自己】沿最小穿透轴（MTV）从【对方插值身体】里推出，
   *   绝不修改对方位置（对方位置由其本地物理 + pp 位姿包权威驱动），
   *   因此两端各自解算也不会权威互打；双方都朝彼此走时会自然互相挤开。
   *   重叠过大（出生点重合 / 传送穿越）时不爆推，仅在正常触碰范围分离。
   * ============================================================ */
  const PUSH_PER_AXIS = 0.5;    // 单帧最大推出距离，避免卡顿后一帧弹飞
  function resolvePlayerPush() {
    if (!Net.active()) return;
    const av = remoteAvatar;
    if (!av || !av.live) return;
    // 正常用插值身体；首包插值帧之前 / 后台标签 rAF 节流时退用最新位姿目标
    const r = av.cur || av.target;
    if (!r) return;
    const p = player.pos;
    const hw = player.width / 2;
    const ox = hw * 2 - Math.abs(p.x - r.x);
    const oz = hw * 2 - Math.abs(p.z - r.z);
    const oy = player.height - Math.abs(p.y - r.y);
    if (ox <= 0 || oz <= 0 || oy <= 0) return;
    // 注意：不能用「穿透深度接近满宽/满高」判定传送深重叠——两人站同一地面时
    // 垂直穿透本来就恒等于身高 1.8，贴身横移时水平轴也会接近 0.6（AABB 穿透深度
    // 天然以尺寸和为上限）。MTV 只取最小轴 + PUSH_PER_AXIS 限速，出生点重合时
    // 最多 2 帧即分离，无需额外门槛。
    // 纵向分离只在「纵向穿透很小」时启用——即真正踩头/钻脚（oy<0.5）。
    // 并肩贴身时 oy 恒为满高 1.8，贴墙/卡坑被地形抬高时 oy 也较大；
    // 这种情况若走纵向分支并每帧置 onGround，会抵消重力把人无限顶飞天，
    // 故改由水平轴推出（撞墙时玩家自身碰撞会把人挡回，只表现为挤不动）。
    if (oy <= ox && oy <= oz && oy < 0.5) {
      const push = Math.min(oy, PUSH_PER_AXIS);
      if (p.y >= r.y) {
        p.y += push;
        // 只有脚确实到了对方头顶附近才算「站在头上」，否则交给重力自然回落
        if (p.y >= r.y + player.height - 0.4) {
          player.vel.y = Math.max(player.vel.y, 0);
          player.onGround = true;
        } else if (player.vel.y < 0) {
          player.vel.y = 0;
        }
      } else {
        p.y -= push;
        if (player.vel.y > 0) player.vel.y = 0;
      }
    } else if (ox <= oz) {
      let s = Math.sign(p.x - r.x);
      if (!s) s = Math.random() < 0.5 ? -1 : 1;   // 完全同轴重合时给个稳定方向
      p.x += s * Math.min(ox, PUSH_PER_AXIS);
      if (ox <= PUSH_PER_AXIS) player.vel.x = 0;
    } else {
      let s = Math.sign(p.z - r.z);
      if (!s) s = Math.random() < 0.5 ? -1 : 1;
      p.z += s * Math.min(oz, PUSH_PER_AXIS);
      if (oz <= PUSH_PER_AXIS) player.vel.z = 0;
    }
    // 相机与眼位当帧跟随（eyePos 在调用点之后才拷贝，避免推出时画面滞后一帧）
    player.camera.position.set(p.x, p.y + player.eyeHeight, p.z);
  }

  function sendLocalPose() {
    if (!Net.active()) return;
    if (state === "dead") return;   // 死亡中停发位姿：迟到 pp 不会让对端尸体重现
    if (Net.isGuest()) { if (!guestLoaded) return; }
    else if (Net.isHost()) { if (!hostGuestOnline || !guestReady) return; }
    else return;
    Net.sendU({
      t: "pp",
      p: [r3(player.pos.x), r3(player.pos.y), r3(player.pos.z)],
      yaw: r3(player.yaw), pitch: r3(player.pitch),
      f: player.onGround ? 1 : 0,
      sel: Crafting.selected,
      hid: Crafting.getHeldId() | 0,   // 右手持物 id：对方端第三人称化身手里拿同款
      hp: r3(playerHp),                // 客人脱战自回血回流，房主影子血量与客人对齐
      sw: localSwingPulse ? 1 : 0
    });
    localSwingPulse = false;
  }

  // 房主收客人 pp：边界钳制后采用（重生点在世界内，合法大跳变不拦）
  function onHostGuestPose(m) {
    if (!hostGuestOnline || !guestActor) return;
    if (guestDead) return;        // 死亡中：在途 pp 一律丢弃，尸体不会原地重现
    if (!m || !Array.isArray(m.p) || m.p.length !== 3) return;
    let x = +m.p[0], y = +m.p[1], z = +m.p[2];
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return;
    // 等待客人应用 grs 重生位：只接受重生点附近的包，死亡点的迟到 pp 丢弃
    if (guestRespawning) {
      const dx = x - guestRespawnPoint.x, dz = z - guestRespawnPoint.z;
      if (dx * dx + dz * dz > 36) return;
      guestRespawning = false;
    }
    // 无限世界无水平边界，只钳制垂直范围
    y = Math.max(-16, Math.min(world.H + 8, y));
    guestActor.pos.set(x, y, z);
    guestActor.vel.set(0, 0, 0);
    guestActor.yaw = +m.yaw || 0;
    guestActor.pitch = +m.pitch || 0;
    // 客人本地脱战回血回流；刚下发 gh 的 1s 内不采信，避免迟到包把影子血量顶回去
    if (typeof m.hp === "number" && elapsed - guestHurtSentAt > 1) {
      guestActor.hp = Math.max(0, Math.min(HP_MAX, +m.hp));
    }
    if (typeof m.sel === "number") guestActor.inv.select(m.sel | 0);
    const av = showRemoteAvatar();
    av.target.set(x, y, z);
    av.targetYaw = guestActor.yaw;
    av.targetPitch = guestActor.pitch;
    av.onGround = (m.f & 1) === 1;
    if (typeof m.hid === "number") av.heldId = m.hid | 0;
    if (m.sw) av.model.swing();
  }

  // 客人收房主 pp
  function onGuestHostPose(m) {
    if (!guestLoaded || !m || !Array.isArray(m.p) || m.p.length !== 3) return;
    if (hostDead) return;          // 房主死亡中：在途 pp 丢弃，尸体不重现
    const x = +m.p[0], y = +m.p[1], z = +m.p[2];
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return;
    // 等房主重生后首个近出生点 pp：死亡点的迟到包按位置丢弃
    if (hostRespawning) {
      const dx = x - hostRespawnPoint.x, dz = z - hostRespawnPoint.z;
      if (dx * dx + dz * dz > 36) return;
      hostRespawning = false;
    }
    const av = showRemoteAvatar();
    av.target.set(x, y, z);
    av.targetYaw = +m.yaw || 0;
    av.targetPitch = +m.pitch || 0;
    av.onGround = (m.f & 1) === 1;
    if (typeof m.hid === "number") av.heldId = m.hid | 0;
    if (m.sw) av.model.swing();
  }

  function setupNetIntegration() {
    Net.on("open", function (info) {
      netSide = info.role;
      if (info.role === "guest") {
        Net.progress("正在请求世界数据…", 5);
        Net.send({ t: "hello", v: NET_V });
      } else {
        // 房主建连后开始收口方块变更（建连前的启动写入不广播）
        world.setNetMode("host");
        Net.progress("等待对方加入…", 5);
        // 安全网：rAF 卡顿/异常时仍保证 blk 同步（200ms 一次，后台标签被限流也最多 1s）
        if (!hostBlkSafetyTimer) {
          hostBlkSafetyTimer = setInterval(flushHostBlocks, 200);
        }
      }
    });
    Net.on("message", function (m) {
      if (!m) return;
      if (Net.isHost() && m.t === "hello") onGuestHello(m);
      else if (Net.isHost() && m.t === "ready") onGuestReady();
      else if (Net.isGuest() && m.t === "welcome") onGuestWelcome(m);
      else if (Net.isGuest() && m.t === "end") onGuestRejected(m);
      else if (Net.isGuest() && m.t === "blk") onGuestBlocks(m);
      // 天气 / 实体权威同步
      else if (Net.isGuest() && m.t === "wx") Weather.setRemote(m);
      else if (Net.isGuest() && m.t === "ea") Mobs.netApplySnapshot(m);
      // Task 5：玩法动作权威化
      else if (Net.isHost() && m.t === "act") onHostGuestAct(m);
      else if (Net.isGuest() && m.t === "inv") onGuestInv(m);
      else if (Net.isGuest() && m.t === "open") onGuestOpen(m);
      else if (Net.isGuest() && m.t === "toast") onGuestToast(m);
      else if (Net.isGuest() && m.t === "mine") onGuestMine(m);
      // PvP：房主判定其攻击命中客人 -> 客人本地结算扣血/击退/死亡
      else if (Net.isGuest() && m.t === "ph") onGuestPlayerHurt(m);
      // 怪物 / Boss 伤害：房主权威结算护甲后下发，客人只做表现 / 击退 / 死亡
      else if (Net.isGuest() && m.t === "gh") onGuestMobHurt(m);
      // Boss 火球发射事件：客人端生成纯表现镜像（命中与伤害只在房主端裁决）
      else if (Net.isGuest() && m.t === "bfx") Mobs.netSpawnBalls(m.b);
      // 死亡 / 重生：两端互发 pd 隐藏对方化身并散件；客人重生由房主 grs 裁决位置
      else if (Net.isHost() && m.t === "pd") onHostGuestDied();
      else if (Net.isHost() && m.t === "pr") onHostGuestRespawn();
      else if (Net.isGuest() && m.t === "pd") onGuestPeerDied();
      else if (Net.isGuest() && m.t === "pr") onGuestPeerRespawn(m);
      else if (Net.isGuest() && m.t === "grs") onGuestRespawnSet(m);
      // Task 6+ 在此分流 pp / fx / hp / die ...
    });
    // 不可靠通道：10Hz 实体位置快照 + 双向 20Hz 远端玩家位姿 pp
    Net.on("unreliable", function (m) {
      if (!m) return;
      if (m.t === "pp") {
        if (Net.isHost()) onHostGuestPose(m);
        else if (Net.isGuest()) onGuestHostPose(m);
      } else if (Net.isGuest() && m.t === "es") {
        Mobs.netApplyTransforms(m.l);
      }
    });
    // 房主在「对方已准备好」面板上点了开始游戏（点击是用户手势，指针锁定才能成功）
    Net.on("hoststart", function () {
      Net.hideOverlay();
      if (state === "menu" || state === "paused") enterPlay();
    });
    Net.on("close", function (e) {
      if (hostBlkSafetyTimer) { clearInterval(hostBlkSafetyTimer); hostBlkSafetyTimer = 0; }
      stopHostSyncTimer();
      guestReady = false;
      if (netSide === "guest") onGuestClosed(e);
      else if (netSide === "host") onHostGuestLeft(e);
    });
  }

  // 客人应用房主增量方块变更：只改数据+重建网格，绝不模拟岩浆/生长
  function applyGuestBlocks(list) {
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      if (!d || d.length < 4) continue;
      world.applyNetBlock(d[0] | 0, d[1] | 0, d[2] | 0, d[3] & 0xff,
                         d.length > 4 ? (d[4] | 0) : 0);
    }
    markTorchLightsDirty();   // 火把被挖/放置后尽快重布点光
  }

  function onGuestBlocks(m) {
    if (!Array.isArray(m.c) || !m.c.length) return;
    if (netBlocksLive) applyGuestBlocks(m.c);
    else for (let i = 0; i < m.c.length; i++) pendingNetBlocks.push(m.c[i]);
  }

  // 客人出生点：房主出生点附近 2~6 格的安全列（脚下固体、头顶两格空气、
  // 不在水下）。不能与房主同点——两个相机/身体完全重叠时，第一人称视角
  // 会被对方身体内部填满，双方反而都看不到对方人物。
  function findGuestSpawn(center) {
    const cx = Math.floor(center.x), cz = Math.floor(center.z);
    for (let r = 2; r <= 6; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const x = cx + dx, z = cz + dz;
          const h = world.heightAt(x, z);
          if (h <= world.SEA) continue;
          if (world.getBlock(x, h + 1, z) === BLOCK.AIR &&
              world.getBlock(x, h + 2, z) === BLOCK.AIR) {
            return new THREE.Vector3(x + 0.5, h + 1, z + 0.5);
          }
        }
      }
    }
    return new THREE.Vector3(center.x, center.y, center.z + 2);
  }

  function onGuestHello(m) {
    if (!m || m.v !== NET_V) {
      Net.send({ t: "end", reason: "版本不一致，请双方都刷新到最新版本再联机" });
      return;
    }
    // Task 5：为客人建立执行者（影子背包 + 位姿容器），严格 2 人
    if (!guestActor) guestActor = makeGuestActor();
    const guestSpawn = findGuestSpawn(spawnPoint);
    guestActor.pos.set(guestSpawn.x, guestSpawn.y, guestSpawn.z);
    guestActor.vel.set(0, 0, 0);
    guestActor.yaw = 0; guestActor.pitch = 0;
    hostGuestOnline = true;
    guestReady = false;   // 等客人重建完世界发回 ready（重连同样重新握手）
    guestDead = false;
    guestRespawning = false;
    guestActor.hp = HP_MAX;
    guestHurtInvuln = 0;
    guestHurtSentAt = -10;
    // 两级 setTimeout：先让进度文字渲染，再跑重活，避免面板看起来“卡死”
    Net.progress("正在计算世界差异…", 12);
    setTimeout(function () {
      const dirty = computeWorldDiff();
      Net.progress("正在发送世界数据…", 70);
      setTimeout(function () {
        Net.send({
          t: "welcome",
          v: NET_V,
          seed: world.seed >>> 0,
          spawn: { x: guestSpawn.x, y: guestSpawn.y, z: guestSpawn.z },
          dirty: dirty,
          wx: { phase: Weather.phase, weather: Weather.weather, dayF: Weather.dayF,
                 precip: Weather.precip,
                 th: { id: Weather.thunderId, d: Weather.thunderDist, age: Weather.thunderAge } }
        });
        // 客人初始库存以房主影子背包为准（先发快照，客人加载完即可渲染热栏）
        sendGuestInv();
        Net.progress("等待对方加载完成…", 92);
        // 注意：此处不能自动 enterPlay()——指针锁定必须由用户手势触发，
        // 无手势请求锁定会被浏览器拒绝。等客人 ready 后弹「开始游戏」面板，
        // 房主点击（手势内）再进世界。等待期间主菜单世界仍在正常模拟。
      }, 30);
    }, 30);
  }

  // 一次同步：es 不可靠位置快照每拍发；ea/wx 全量每 5 拍发一次
  function hostSyncOnce(forceSlow) {
    if (!Net.isHost() || !hostGuestOnline || !guestReady) return false;
    hostSyncTick++;
    Net.sendU({ t: "es", l: Mobs.netTransforms() });
    if (forceSlow || hostSyncTick % 5 === 0) {
      Net.send(Object.assign({ t: "ea" }, Mobs.netSnapshot()));
      const w = Weather.snapshot();
      Net.send({ t: "wx", phase: w.phase, weather: w.weather,
                 precip: w.precip, elev: w.elev, dayF: w.dayF,
                 isNight: w.isNight, sunBurn: w.sunBurn, flash: w.flash,
                 th: { id: Weather.thunderId, d: Weather.thunderDist, age: Weather.thunderAge } });
    }
    return true;
  }

  // 房主侧周期同步：es 10Hz 不可靠位置快照；ea/wx 每 0.5s 可靠全量
  function startHostSyncTimer() {
    if (hostSyncTimer) return;
    hostSyncTick = 0;
    hostSyncTimer = setInterval(function () { hostSyncOnce(false); }, 100);
  }
  function stopHostSyncTimer() {
    if (hostSyncTimer) { clearInterval(hostSyncTimer); hostSyncTimer = 0; }
  }

  // 客人加载完成：开始实体 / 天气同步，并请房主手势点击进入世界
  function onGuestReady() {
    guestReady = true;
    Net.send(Object.assign({ t: "ea" }, Mobs.netSnapshot()));
    startHostSyncTimer();
    if (state === "menu") {
      Net.showPage("host-go");
    } else {
      // 房主已在游戏中（客人掉线重连）：直接收起可能残留的面板
      Net.hideOverlay();
      showToast("对方已加入游戏");
    }
  }

  // 无限世界：只对比内存中全部 dirty 区块与同种子纯净地形，返回稀疏脏块列表
  // （玩家改动过的区块永不卸载，所以这就是全量差异）
  function computeWorldDiff() {
    const t0 = performance.now();
    const dirty = world.diffDirtyChunks();
    console.log("[Net] 世界差异块 " + dirty.length + " 格，耗时 " +
                Math.round(performance.now() - t0) + "ms");
    return dirty;
  }

  function onGuestWelcome(m) {
    Net.progress("正在生成地形…", 15);
    setTimeout(function () {
      try {
        // 0) 进入客人角色：本地一切写世界的模拟路径自此短路
        world.setNetMode("guest");
        netBlocksLive = false;
        pendingNetBlocks.length = 0;
        // 0.5) 从菜单内输房间码加入时，本页是以“假单机”启动的（已投放动物与
        //      Boss）。这些本地实体与房主世界无关且永远不动，先全部清掉，
        //      之后实体一律由房主 ea/es 镜像驱动
        Mobs.netClearLocal();
        Mobs.netClear();
        // 1) 用房主种子清空并重置无限世界（稀疏区块全部丢弃，岩浆调度一并重置）
        world.resetWorld(m.seed >>> 0);
        // 2) 叠加房主世界里相对纯净地形的全部改动（挖掘/放置/岩浆流/作物…）；
        //    setBlock 会按需确定性生成目标区块，客人端这些区块标记为 dirty 永不卸载
        let applied = 0;
        if (Array.isArray(m.dirty) && m.dirty.length) {
          world.applyNetBlocks(m.dirty);
          applied = m.dirty.length;
        }
        // 3) 出生点与玩家对齐房主
        spawnPoint = new THREE.Vector3(m.spawn.x, m.spawn.y, m.spawn.z);
        player.setSpawn(spawnPoint);
        player.pos.set(m.spawn.x, m.spawn.y, m.spawn.z);
        player.vel.set(0, 0, 0);
        // 4) 火山岩浆灯按新种子重新布点（guest 启动时跳过了 setupLavaLights）
        setupLavaLights();
        // 5) 昼夜 / 天气初始对齐到房主（之后只收 wx 广播，本地绝不推进）
        if (m.wx) Weather.setRemote(m.wx);
        guestLoaded = true;
        hostDead = false;
        hostRespawning = false;
        console.log("[Net] 已对齐房主世界：seed=" + (m.seed >>> 0) + "，差异块 " + applied + " 格");
        // 6) 出生点周围网格分批构建（initialBuild 会先补齐数据环），进度实时上屏
        Net.progress("正在构建地形…", 30);
        world.initialBuild(m.spawn.x, m.spawn.z, world.MESH_R, 4, function (done, total) {
          Net.progress("正在构建地形…", 30 + Math.round(65 * done / total));
        }, function () {
          // welcome 快照之后、加载期间到达的增量 blk 按序补齐，再开放实时应用
          if (pendingNetBlocks.length) applyGuestBlocks(pendingNetBlocks.splice(0));
          netBlocksLive = true;
          // 通知房主“我加载完了”，房主收到后切到「开始游戏」面板
          Net.send({ t: "ready" });
          Net.progress("加载完成", 100);
          Net.hideProgress();
          enterPlay();
        });
      } catch (err) {
        console.error("[Net] welcome 应用失败", err);
        Net.showError("世界加载失败：" + err.message);
      }
    }, 30);
  }

  function onGuestRejected(m) {
    Net.showError((m && m.reason) || "房主拒绝了加入");
  }

  // Task 12 会补完整的清世界/回主菜单流程；Task 3 先安全退回主菜单
  function onGuestClosed(e) {
    if (guestLoaded && (state === "playing" || state === "paused")) {
      showToast(e.intentional ? "已退出联机" : "与房主的连接已断开");
      state = "menu";
      showMainMenu();
      overlay.classList.remove("hidden");
      crosshair.style.display = "none";
      hintEl.style.display = "none";
    }
    guestLoaded = false;
    netBlocksLive = false;
    pendingNetBlocks.length = 0;
    hostDead = false;
    hostRespawning = false;
    Mobs.netClear();
    hideRemoteAvatar();
  }

  function onHostGuestLeft(e) {
    hostGuestOnline = false;
    guestReady = false;
    guestDead = false;
    guestRespawning = false;
    stopHostSyncTimer();
    hostClearMine();
    hideRemoteAvatar();
    // Task 12 处理重连/会话结束；Task 5 仅提示
    if (!e.intentional) showToast("对方已断开连接");
  }

  /* ---------------- 启动：先显示加载，再生成世界 ---------------- */
  setTimeout(function () {
    // 先等 IndexedDB 异步读档完成（含备份回滚 / 老档迁移），再生成世界
    saveReady.then(async function () {
    try {
      const t0 = performance.now();
      // 模式随存档走：读档看存档字段，新档看 ?creative=1（客人端本端不启用创造）
      creativeMode = !isGuestBoot && !!(pendingSave ? pendingSave.creative : creativeBoot);
      world.seed = bootSeed >>> 0;   // 构造 World 时用的是占位种子，读档后换成真实种子
      const tGen = performance.now();
      if (isGuestBoot) {
        // 客人端用占位种子启动：不生成任何地形，welcome 到达后 resetWorld 对齐房主
        spawnPoint = new THREE.Vector3(0.5, 30, 0.5);
      } else {
        // 无限世界不在启动时全量生成；先恢复存档脏区块，其余地形按需确定性生成
        if (pendingSave && Array.isArray(pendingSave.chunks) && pendingSave.chunks.length) {
          const restored = world.applySavedChunks(pendingSave.chunks);
          console.log("[Save] 恢复脏区块 " + restored + " 个");
        }
        // 出生点搜索会按需生成原点附近区块
        spawnPoint = world.prepareSpawn();
        // 读档玩家可能离原点很远，火山灯按存档位置探测
        setupLavaLights(pendingSave
          ? { x: pendingSave.player.x, z: pendingSave.player.z }
          : spawnPoint);
      }
      // 本次启动是不是“全新随机世界”：进游戏瞬间提示一次种子号，方便分享 / 复现
      freshWorldSeed = (!pendingSave && !isGuestBoot) ? (world.seed >>> 0) : 0;
      player = new Player(world, camera);
      Settings.applyLook();
      player.setSpawn(spawnPoint);
      if (pendingSave) {
        const pp = pendingSave.player;
        player.pos.set(pp.x, pp.y + 0.05, pp.z);
        player.vel.set(0, 0, 0);
        player.yaw = pp.yaw;
        player.pitch = pp.pitch;
      }

      // 物品栏 / 合成系统
      const itemIcons = createItemIcons();
      // 方块在物品栏里的专属图标（等距立体图，仅用于物品栏类 UI；
      // 世界中的 3D 方块、手持模型仍走图集纹理）。图片缺失时静默回退到图集 tile。
      const blockIcons = await loadBlockIcons();
      Crafting.init({
        hotbarEl: hotbarEl,
        overlayEl: craftOverlay,
        gridEl: craftGrid,
        outputEl: craftOutput,
        invEl: panelInventory,
        dragEl: dragItem,
        guideEl: recipeList,
        toggleEl: recipeToggle,
        atlasCanvas: atlas.canvas,
        itemIcons: itemIcons,
        blockIcons: blockIcons,
        creative: creativeMode
      });
      Furnace.init({
        overlayEl: document.getElementById("furnace-overlay"),
        inEl: document.getElementById("fu-in"),
        fuelEl: document.getElementById("fu-fuel"),
        outEl: document.getElementById("fu-out"),
        fireEl: document.getElementById("fu-fire"),
        arrowEl: document.getElementById("fu-arrow"),
        invEl: document.getElementById("fu-inventory"),
        atlasCanvas: atlas.canvas,
        itemIcons: itemIcons,
        blockIcons: blockIcons
      });
      Chest.init({
        overlayEl: document.getElementById("chest-overlay"),
        gridEl: document.getElementById("chest-grid"),
        invEl: document.getElementById("chest-inv"),
        atlasCanvas: atlas.canvas,
        itemIcons: itemIcons,
        blockIcons: blockIcons
      });
      GunBench.init({
        overlayEl: document.getElementById("gunbench-overlay"),
        gridEl: document.getElementById("gb-grid"),
        outEl: document.getElementById("gb-output"),
        invEl: document.getElementById("gb-inventory"),
        atlasCanvas: atlas.canvas,
        itemIcons: itemIcons,
        blockIcons: blockIcons
      });
      if (pendingSave) {
        Crafting.restoreInventory(pendingSave.inventory, pendingSave.selected);
        Crafting.restoreArmor(pendingSave.armor);
        Crafting.restoreBag(pendingSave.bag);   // 必须在 restoreArmor 之后（依赖背包是否装备）
        Chest.restore(pendingSave.chests);
      }

      // 第一人称双手 + 手持物（itemIcons 用于把物品栏 16×16 图标原样贴到手
      // 里——肉排 / 工具等手持外观与物品栏像素完全一致）
      ViewModel.init({
        renderer: renderer,
        camera: camera,
        atlasTexture: atlas.texture,
        itemIcons: itemIcons
      });

      // 玩家 3D 身体（第三人称完整可见，第一人称只露出躯干与腿）
      PlayerModel.init(scene);

      // 心形生命 HUD（无敌模式没有血量概念，整条隐藏）
      buildHearts();
      if (creativeMode) heartsEl.style.display = "none";
      if (pendingSave) {
        playerHp = Math.max(1, Math.min(HP_MAX, Math.round(pendingSave.player.hp) || HP_MAX));
        updateHearts();
        // 残血读档：把“上次受伤时间”拉回此刻，避免主菜单耗时被算作脱战而瞬间回血
        lastHurtAt = elapsed;
      }

      // 友好动物：在草地上随机生成猪 / 狗 / 牛 / 羊
      // 传入 itemIcons：生猪排等掉落物在世界里直接显示像素图标而非单色块
      // 传入 atlas.texture：方块掉落物渲染为带世界贴图的迷你 3D 方块（草顶/泥侧）
      Mobs.init(scene, itemIcons, atlas.texture);
      Mobs.bindHooks({
        // 动物死亡 / 驯服爱心等粒子
        burst: function (x, y, z, color) {
          particles.burst(Math.floor(x), Math.floor(y), Math.floor(z), color);
        },
        // 愤怒动物咬玩家
        hurtPlayer: hurtPlayer,
        // Mobs 的 toast 只在房主端产生（客人不跑 AI）：房主本地播一份，同时转发给客人
        toast: function (msg) {
          showToast(msg);
          if (Net.isHost()) Net.send({ t: "toast", msg: String(msg) });
        },
        // Boss 吐火球：即时可靠包下发，客人端生成纯表现镜像
        bossBalls: function (balls) {
          if (Net.isHost() && hostGuestOnline && guestReady) Net.send({ t: "bfx", b: balls });
        }
      });
      // 客人端不本地生成任何生物：友好动物 / Boss / 驯服恢复全部跳过，
      // 实体状态由房主权威同步（Task 8 起接入网络实体）
      if (!isGuestBoot) {
        // 读档玩家可能在远方探索：动物围绕玩家位置投放；新档围绕出生点
        const mobCenter = pendingSave ? player.pos : spawnPoint;
        const spawnReport = Mobs.populate(world, { avoidCenter: mobCenter });
        console.log("[Mobs] 动物生成：", spawnReport.placed, "尝试", spawnReport.attempts, "次");

        // 火山 Boss：紫黑龙盘踞火山口上空，靠近火山顶即苏醒攻击
        const dragon = Mobs.spawnDragon(world, volcanoCenter);
        if (dragon) {
          console.log("[Boss] 紫黑龙已生成于火山顶：",
                      Math.round(dragon.home.x), Math.round(dragon.home.z));
        }
        if (pendingSave) {
          const n = Mobs.restoreTamed(pendingSave.tamed);
          if (n > 0) console.log("[Save] 恢复驯服动物", n, "只");
          if (pendingSave.boss) Mobs.restoreBoss(pendingSave.boss);
        }
      }

      // 昼夜循环 + 天气：驱动天空 / 光照 / 日月星空 / 雨，并回调夜晚刷怪提示
      Weather.init({
        scene: scene,
        center: new THREE.Vector3(player.pos.x, 0, player.pos.z),
        skyUniforms: skyDome.material.uniforms,
        hemi: hemi,
        sunLight: sunLight,
        ambient: ambient,
        sunMesh: sunMesh,
        clouds: clouds,
        clockEl: document.getElementById("clock"),
        hooks: {
          onNight: function () {
            if (state === "playing") showToast("夜幕降临，僵尸和蜘蛛开始出没，小心！");
          },
          onDay: function () {
            if (state === "playing") showToast("天亮了，露天的僵尸在阳光下燃烧殆尽，蜘蛛则退回了游荡");
          },
          onWeather: function (w) {
            if (state !== "playing") return;
            if (w === "rain") showToast("下起了雨……");
            else if (w === "storm") showToast("暴风雨来了，天色昏暗，注意安全！");
            else showToast("雨过天晴");
          },
          // 闪电 → 雷声（本地按距离延迟播放）；房主即时下发权威事件，
          // 客人收到后按事件 age 折减延迟（周期 wx 包同样携带，作兜底）
          onLightning: function (dist, id, age) {
            SFX.thunder(dist, age);
            if (Net.isHost()) {
              Net.send({ t: "wx",
                         th: { id: id, d: dist, age: Weather.thunderAge } });
            }
          }
        }
      });

      // 只读调试钩子（控制台可用）：__mc.pick() 查看准星方块，__mc.getBlock() 读方块
      window.__mc = {
        state: function () { return state; },
        inNoLock: function () { return inNoLock; },
        // 调试用：直接访问世界实例（检查区块 mesh / 风力 uniform 等）
        world: function () { return world; },
        scene: function () { return scene; },
        pick: function () {
          const h = pickBlock(6);
          return h ? { x: h.x, y: h.y, z: h.z, nx: h.nx, ny: h.ny, nz: h.nz, id: h.id,
                      liq: h.liq ? { x: h.liq.x, y: h.liq.y, z: h.liq.z, id: h.liq.id } : null } : null;
        },
        getBlock: function (x, y, z) { return world.getBlock(x, y, z); },
        player: function () {
          return {
            x: player.pos.x, y: player.pos.y, z: player.pos.z,
            yaw: player.yaw, pitch: player.pitch, flying: player.flying,
            vx: player.vel.x, vz: player.vel.z,
            onIce: player.onGround && player.groundBlock() === BLOCK.ICE
          };
        },
        held: function () { const h = Crafting.getHeld(); return h ? { id: h.id, count: h.count } : null; },
        inventory: function () { return Crafting.inventory.map(s => s ? { id: s.id, count: s.count } : null); },
        armor: function () { return Crafting.serializeArmor(); },
        defense: function () { return Crafting.totalDefense(); },
        equip: function (id) {
          const slot = armorSlotOf(id);
          if (!slot) return false;
          Crafting.armor[slot] = { id: id, count: 1 };
          Crafting.renderAll();
          return true;
        },
        unequip: function (slot) {
          const a = Crafting.armor[slot];
          if (!a) return null;
          Crafting.armor[slot] = null;
          Crafting.addItem(a.id, 1);
          Crafting.renderAll();
          return a.id;
        },
        openPanel: openPanel,
        closePanel: closePanel,
        setBlock: function (x, y, z, id, meta) {
          world.setBlock(x, y, z, id, meta);
          world.remeshAround(x, z);
          world.notifyLava(x, y, z);
        },
        getBlock: function (x, y, z) { return world.getBlock(x, y, z); },
        getBlockMeta: function (x, y, z) { return world.getBlockMeta(x, y, z); },
        // 调试用：把已加载的 dirty 区块与同种子纯净世界逐格对比
        // 返回 {count, sample:[[x,y,z,pristineId,nowId]...]}（联机一致性测试用）
        diffPristine: function (full) {
          const list = world.diffDirtyChunks();
          const sample = full ? list.slice(0, 4096).map(function (d) {
            return [d[0], d[1], d[2], null, d[3]];
          }) : list.slice(0, 12).map(function (d) {
            return [d[0], d[1], d[2], null, d[3]];
          });
          return { count: list.length, sample: sample };
        },
        heightAt: function (x, z) { return world.heightAt(x, z); },
        biomeAt: function (x, z) { return world.biomeAt(x, z); },
        // 调试用：传送（自动开飞行悬停，避免落进未生成区块）
        tp: function (x, y, z) {
          if (!player) return false;
          player.flying = true;
          player.vel.set(0, 0, 0);
          player.pos.set(x, y, z);
          return true;
        },
        // 调试用：流送状态（已加载区块/网格数、玩家所在区块）
        stream: function () {
          return {
            dataChunks: world.cdata.size, meshChunks: world.chunks.size,
            dirtyChunks: world.serializeDirtyChunks().length,
            chunk: [Math.floor(player.pos.x / 16), Math.floor(player.pos.z / 16)],
            meshR: world.MESH_R, dataR: world.DATA_R
          };
        },
        mine: breakBlock,
        use: placeBlock,
        // 调试用：直接获得物品（工具自动满耐久），如 __mc.give(114,8)
        give: function (id, count, dur) {
          const n = Crafting.addItem(id, count || 1, dur);
          return { id: id, added: n };
        },
        openFurnace: openFurnace,
        closeFurnace: closeFurnace,
        Furnace: Furnace,
        // 调试用：枪械工作台面板
        openGunbench: openGunbench,
        closeGunbench: closeGunbench,
        GunBench: GunBench,
        // 调试用：驱动长按挖掘状态机（自动化测试长按）
        startMine: startAttack,
        mineTick: function (dt) { updateMining(dt || 0.1); },
        stopMine: stopMining,
        // 手枪调试：R 装弹 / 扣扳机 / 读状态（自动化实测用）
        gunReload: startReload,
        gunFire: tryFire,
        gunState: function () {
          const g = Crafting.getHeld();
          const G = window.GunMod;
          return {
            heldId: g ? g.id : 0,
            isPistol: !!(g && G && g.id === G.pistol),
            ammo: g ? (g.ammo || 0) : 0,
            reserve: G ? Crafting.countItem(G.bullet) : 0,
            fireCd: gunFireCd, reloadT: gunReloadT,
            creative: creativeMode
          };
        },
        setPos: function (x, y, z) { player.pos.set(x, y, z); player.vel.set(0, 0, 0); },
        // 调试用：设置视角（yaw 弧度，0 = 朝 -z；pitch 0 = 水平）
        setLook: function (yaw, pitch) { player.yaw = yaw; player.pitch = pitch; },
        // 调试用：返回玩家坐标 Vector3 活动引用（外部手动驱动 Mobs.update 时使用）
        livePos: function () { return player.pos; },
        // 调试用：手动推进一帧生物 / 掉落物 / Boss 特效（绕过渲染主循环）
        stepMobs: function (dt) { Mobs.update(dt || 0.05, player.pos, { sunBurn: false }); },
        mobs: function () { return Mobs.list(); },
        input: function () {
          return { f: input.forward, b: input.back, l: input.left, r: input.right, j: input.jump, d: input.down };
        },
        // 调试用：群系统计（只统计当前已加载区块的 16×16 列）
        biomeStats: function () {
          const SEA = world.SEA;
          const regions = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
          const surf = { lava: 0, ice: 0, snow: 0, cactus: 0, sand: 0, grass: 0, basalt: 0, stone: 0 };
          let islands = 0, water = 0, columns = 0;
          world.forEachLoadedChunk(function (rec, cx, cz) {
            const x0 = cx * 16, z0 = cz * 16;
            for (let lz = 0; lz < 16; lz++) {
              for (let lx = 0; lx < 16; lx++) {
                const x = x0 + lx, z = z0 + lz;
                const bi = rec.bm[lz * 16 + lx];
                regions[bi]++;
                columns++;
                const h = rec.hm[lz * 16 + lx];
                const top = rec.d[(h * 16 + lz) * 16 + lx];
                if (isLava(top)) surf.lava++;
                else if (top === BLOCK.SNOW) surf.snow++;
                else if (top === BLOCK.ICE) surf.ice++;
                else if (top === BLOCK.BASALT) surf.basalt++;
                else if (top === BLOCK.SAND) surf.sand++;
                else if (top === BLOCK.GRASS) surf.grass++;
                else if (top === BLOCK.STONE) surf.stone++;
                if (h + 1 < world.H && isLava(rec.d[((h + 1) * 16 + lz) * 16 + lx])) surf.lava++;
                if (h + 1 < world.H && rec.d[((h + 1) * 16 + lz) * 16 + lx] === BLOCK.CACTUS) surf.cactus++;
                if (rec.d[(SEA * 16 + lz) * 16 + lx] === BLOCK.ICE) surf.ice++;
                if (h > SEA) {
                  if (bi === 2 || bi === 8) islands++;
                } else water++;
              }
            }
          });
          return {
            loadedColumns: columns, loadedChunks: world.cdata.size,
            height: world.H, seed: world.seed >>> 0,
            regions: {
              plains: regions[0], desert: regions[1], ocean: regions[2], glacier: regions[3],
              volcano: regions[4], birchForest: regions[5], forest: regions[6],
              mountains: regions[7], deepOcean: regions[8], peaks: regions[9],
              bamboo: regions[10]
            },
            surface: surf, islands: islands, waterColumns: water,
            spawn: { x: player.pos.x, y: player.pos.y, z: player.pos.z }
          };
        },
        zombies: function () { return Mobs.countMonsters(); },
        dragon: function () {
          if (Net.isGuest && Net.isGuest()) {
            const dbg = Mobs.netDebug();
            const b = dbg.list.filter(function (x) { return x.type === "dragon"; })[0];
            if (!b) return { alive: false };
            return {
              alive: true, hp: Math.round(b.hp), maxHp: 120, state: b.bs,
              x: b.x, y: b.y, z: b.z, bossBar: dbg.bossBar,
              balls: dbg.balls, fires: dbg.fires,
              dPlayer: Math.round(Math.hypot(player.pos.x - b.x, player.pos.z - b.z) * 10) / 10
            };
          }
          const d = Mobs.getDragon();
          if (!d) return { alive: false, slain: !Mobs.serializeBoss() ? false : true };
          return {
            alive: true, hp: Math.round(d.hp), maxHp: d.maxHp,
            state: d.bossState, cast: d.cast,
            x: Math.round(d.pos.x * 10) / 10, y: Math.round(d.pos.y * 10) / 10,
            z: Math.round(d.pos.z * 10) / 10,
            vx: Math.round(d.vel.x * 10) / 10, vy: Math.round(d.vel.y * 10) / 10,
            vz: Math.round(d.vel.z * 10) / 10,
            skillCd: Math.round((d.skillCd || 0) * 10) / 10,
            swoopT: Math.round((d.swoopT || 0) * 10) / 10,
            castT: Math.round((d.castT || 0) * 10) / 10,
            roostY: Math.round(d.roostY * 10) / 10,
            dPlayer: Math.round(Math.hypot(player.pos.x - d.pos.x, player.pos.z - d.pos.z) * 10) / 10,
            home: { x: Math.round(d.home.x), z: Math.round(d.home.z) }
          };
        },
        clearMonsters: function () {
          let n = 0;
          Mobs.list().forEach(function (m) {
            if (m.cfg && m.cfg.hostile && !m.cfg.boss && !m.dead) { Mobs.damageMob(m, 999, null); n++; }
          });
          return n;
        },
        spawnZombie: function () { return !!Mobs.spawnZombie(world, player.pos); },
        spawnSpider: function () { return !!Mobs.spawnSpider(world, player.pos); },
        lavaLights: function () {
          return lavaLights.map(o => ({ x: o.l.position.x, y: o.l.position.y, z: o.l.position.z, i: Math.round(o.l.intensity * 100) / 100 }));
        },
        // ---- Task 4 联机方块同步探针 ----
        netMode: function () { return world.netMode; },
        netBlk: function () {
          return { flushes: netBlkFlushes, cells: netBlkCells, last: netBlkLast, pending: pendingNetBlocks.length,
                   silent: world.silent, dirtySize: world.dirtyBlocks ? world.dirtyBlocks.size : -1,
                   netIsHost: Net.isHost(), mode: world.netMode,
                   lavaErr: lastLavaError, blkErr: lastBlkError,
                   lavaQueue: world.lavaQueue ? world.lavaQueue.size : -1 };
        },
        // ---- Task 5 玩法动作权威化探针 ----
        // 通用：读取本地库存（两端均可）
        inv: function () {
          const plain = Crafting.inventory.map(s => s ? { id: s.id, count: s.count, dur: s.dur == null ? null : s.dur, ammo: s.ammo == null ? null : s.ammo } : null);
          return { sel: Crafting.selected, inv: plain };
        },
        // 客人：把视线对准方块中心并立即同步选取原点与相机朝向（自动化测试用，
        // 后台标签 rAF 被节流时也能让 pickBlock 立即用新朝向）
        aimBlock: function (x, y, z) {
          const ex = player.pos.x, ey = player.pos.y + player.eyeHeight, ez = player.pos.z;
          const dx = x + 0.5 - ex, dy = y + 0.5 - ey, dz = z + 0.5 - ez;
          const dist = Math.hypot(dx, dy, dz);
          player.yaw = Math.atan2(-dx, -dz);
          player.pitch = Math.atan2(dy, Math.hypot(dx, dz));
          eyePos.set(ex, ey, ez);
          camera.position.set(ex, ey, ez);
          camera.rotation.set(player.pitch, player.yaw, 0);
          camera.updateMatrixWorld();
          return { yaw: player.yaw, pitch: player.pitch, dist: Math.round(dist * 1000) / 1000 };
        },
        // 客人：以当前视线真实 pick 后发 act（end-to-end 走网络裁决）
        netAct: function (kind) {
          const hit = pickBlock(REACH_DIST);
          if (!hit) return { ok: false };
          if (kind === "use") requestUse(hit);
          else finishDig(hit);
          return { ok: true, hit: { x: hit.x, y: hit.y, z: hit.z, nx: hit.nx, ny: hit.ny, nz: hit.nz, id: hit.id, liq: hit.liq } };
        },
        // 客人：直接发一条裸 act（TR-5.2 越权/过期坐标拒绝测试）
        netSend: function (obj) { Net.send(obj); return true; },
        // 房主：客人影子库存 + 位姿
        guestInfo: function () {
          if (!guestActor) return null;
          return {
            online: hostGuestOnline,
            pos: [Math.round(guestActor.pos.x * 1000) / 1000, Math.round(guestActor.pos.y * 1000) / 1000, Math.round(guestActor.pos.z * 1000) / 1000],
            yaw: Math.round(guestActor.yaw * 1000) / 1000,
            pitch: Math.round(guestActor.pitch * 1000) / 1000,
            held: guestActor.getHeldId(),
            inv: guestActor.inv.serialize()
          };
        },
        // 房主：直接给客人影子背包加物品并同步（测试发放道具用）
        guestGive: function (id, count, dur) {
          if (!guestActor) return false;
          guestActor.inv.addItem(id, count || 1, dur);
          sendGuestInv();
          return guestActor.inv.serialize();
        },
        // 房主：切换客人选中栏位并同步
        guestSelect: function (i) {
          if (!guestActor) return false;
          guestActor.inv.select(i | 0);
          sendGuestInv();
          return guestActor.inv.selected;
        },
        // 房主：绕过网络直接注入一条 act（裁决逻辑单测）
        hostAct: function (m) { onHostGuestAct(m); return true; },
        // 调试用：立即走死亡流程（联机死亡散件/pd 通知联调用）
        dieNow: function () { die(); return true; },
        // 调试用：立即重生（pr/grs 流程联调用）
        respawnNow: function () { respawn(); return true; },
        // ---- Task 6 远端玩家化身探针 ----
        // 化身状态（两端通用）：live/可见性/渲染位姿/目标位姿/着地
        remote: function () {
          if (!remoteAvatar) return null;
          const av = remoteAvatar;
          const q = v => v ? [Math.round(v.x * 1000) / 1000, Math.round(v.y * 1000) / 1000,
                            Math.round(v.z * 1000) / 1000] : null;
          return {
            live: av.live, visible: av.model.root.visible,
            cur: q(av.cur), target: q(av.target),
            yaw: Math.round(av.yaw * 1000) / 1000,
            pitch: Math.round(av.pitch * 1000) / 1000,
            onGround: av.onGround,
            swingT: Math.round(av.model.swingT * 1000) / 1000
          };
        },
        // 后台标签 rAF 节流时手动发一拍本端 pp
        poseOnce: function () { sendLocalPose(); return true; },
        // 绕过网络直接注入一条对方 pp（化身管线单测）
        recvPose: function (m) {
          if (Net.isHost()) onHostGuestPose(m);
          else if (Net.isGuest()) onGuestHostPose(m);
          else return false;
          return true;
        },
        // 手动推一帧化身插值（后台标签测试用）
        remoteStep: function (dt) { updateRemoteAvatar(dt || 0.05); return true; },

        // 无限世界：对全部 dirty 区块（key 排序后）做 FNV-1a 哈希
        // （两端世界改动一致性的断言用；纯净地形由种子保证一致，不参与哈希）
        dataHash: function () {
          let h = 0x811c9dc5;
          const list = world.serializeDirtyChunks()
            .sort(function (a, b) { return (a.cx - b.cx) || (a.cz - b.cz); });
          const mix = function (n) {
            for (let s = 0; s < 4; s++) { h ^= (n >>> (s * 8)) & 0xff; h = Math.imul(h, 0x01000193) >>> 0; }
          };
          for (const c of list) {
            mix(c.cx); mix(c.cz);
            const d = c.d;
            for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 0x01000193) >>> 0; }
          }
          return h >>> 0;
        },
        // 绕过 animate 守卫直接触发岩浆/mod 模拟（TR-4.2：客人端必须无效）
        lavaTick: function (dt) { world.updateLava(dt || 0.2); return true; },
        tickHooksOnce: function () {
          for (let mi = 0; mi < GameRegistry.tickHooks.length; mi++) {
            try { GameRegistry.tickHooks[mi]({ world: world, elapsed: 0, dt: 0.1, player: player }); }
            catch (e) { console.error("[mod tick]", e); }
          }
          return GameRegistry.tickHooks.length;
        },
        setFlying: function (f) { player.flying = !!f; if (f) player.vel.set(0, 0, 0); return player.flying; },
        weather: function () { return Weather.snapshot(); },
        setPhase: function (p) { if (Net.isGuest()) return { error: "guest: weather is host-authoritative" }; Weather.phase = p; return Weather.snapshot(); },
        setWeather: function (w) {
          if (Net.isGuest()) return { error: "guest: weather is host-authoritative" };
          if (w === "clear" || w === "rain" || w === "storm") { Weather.weather = w; Weather.weatherT = 60; }
          return Weather.weather;
        },
        // 调试用：把视线对准任意世界坐标并同步相机（自动化攻击测试）
        aimAt: function (x, y, z) {
          const ex = player.pos.x, ey = player.pos.y + player.eyeHeight, ez = player.pos.z;
          const dx = x - ex, dy = y - ey, dz = z - ez;
          const dist = Math.hypot(dx, dy, dz);
          player.yaw = Math.atan2(-dx, -dz);
          player.pitch = Math.atan2(dy, Math.hypot(dx, dz));
          eyePos.set(ex, ey, ez);
          camera.position.set(ex, ey, ez);
          camera.rotation.set(player.pitch, player.yaw, 0);
          camera.updateMatrixWorld();
          return { yaw: player.yaw, pitch: player.pitch, dist: Math.round(dist * 1000) / 1000 };
        },
        // ---- Task 8 网络实体探针 ----
        netEnt: function () { return Mobs.netDebug(); },
        // 房主：手动推一拍 es/ea/wx（后台标签自动化测试，绕过被节流的 setInterval）
        netSyncOnce: function (forceSlow) { return hostSyncOnce(!!forceSlow); },
        // 会话状态（两端通用）
        netInfo: function () {
          return { side: Net.role(), code: Net.code(), state: state,
                   hostOnline: hostGuestOnline, guestReady: guestReady,
                   guestLoaded: guestLoaded, latency: Net.latency() };
        },
        // 客人：以当前视线对实体发起一次攻击（走 act attack 转发）
        netAttack: function () { attackTarget(); return true; },
        // 调试（自动化）：房主侧绕最近的非 Boss 生物转一圈尝试近战复核
        testAttackHost: function () {
          const list = Mobs.debugEntities().filter(m => !m.dead && !m.cfg.boss);
          const m = list.find(x => x.type === "pig" || x.type === "cow" || x.type === "sheep" || x.type === "dog") || list[0];
          if (!m) return { err: "no mob" };
          const tries = [];
          const cand = [[1, 0], [-1, 0], [0, 1], [0, -1]];
          for (const hh of [0.5, 0.95]) {
            for (const c of cand) {
              const hw = m.width / 2;
              const ex = m.pos.x + c[0] * (hw + 1.5), ez = m.pos.z + c[1] * (hw + 1.5);
              const ey = m.pos.y + hh;
              const dx = m.pos.x - ex, dy = (m.pos.y + m.height * 0.55) - ey, dz = m.pos.z - ez;
              const yaw = Math.atan2(-dx, -dz);
              const pitch = Math.atan2(dy, Math.hypot(dx, dz));
              const before = m.hp;
              onHostGuestAct({ kind: "attack", pose: { p: [ex, ey, ez], yaw: yaw, pitch: pitch, sel: 0 } });
              tries.push({ side: c, hh: hh, before: before, after: m.hp, dmg: Math.round((before - m.hp) * 100) / 100 });
              if (m.hp < before) {
                return { id: m.netId, type: m.type, hp: m.hp, hit: tries[tries.length - 1], tries: tries };
              }
            }
          }
          return { id: m.netId, type: m.type, noDamage: true, tries: tries };
        },
        // 调试（自动化）：客人侧走到镜像旁瞄准并真发 act attack
        testAttackGuest: function (id, rounds) {
          const d = Mobs.netDebug();
          const m = d.list.find(x => x.id === id) || d.list[0];
          if (!m) return { err: "no mirror", mirrors: d.mirrors };
          const cand = [[1, 0], [-1, 0], [0, 1], [0, -1]];
          let n = 0;
          for (const hh of [0.5, 0.95]) {
            for (const c of cand) {
              if (rounds && n >= rounds) return { id: m.id, sent: n };
              const ex = m.x + c[0] * 1.6, ez = m.z + c[1] * 1.6, ey = m.y + hh;
              player.pos.set(ex, ey - player.eyeHeight, ez);
              player.vel.set(0, 0, 0);
              __mc.aimAt(m.x, m.y + 0.5, m.z);
              attackTarget();
              n++;
              if (attackCd > 0) return { id: m.id, type: m.type, sent: n, lastSide: c };
            }
          }
          return { id: m.id, type: m.type, sent: n };
        },
        // 调试（自动化）：房主读实体当前血量
        mobHp: function (id) {
          const m = Mobs.debugEntities().find(x => x.netId === id);
          return m ? { id: id, type: m.type, hp: Math.round(m.hp * 100) / 100, dead: !!m.dead,
                       x: m.pos.x, y: m.pos.y, z: m.pos.z } : { id: id, gone: true };
        },
        // 客人：手推一帧镜像（后台标签 rAF 节流的自动化测试用）
        stepMirrors: function (dt) { Mobs.netUpdate(dt || 0.1); return Mobs.netDebug(); },
        setLook: function (yaw, pitch) { player.yaw = yaw; player.pitch = pitch || 0; },
        sens: function (v) {
          if (v == null) return Settings.lookSens;
          Settings.lookSens = clampSens(v);
          Settings.applyLook();
          Settings.save();
          syncSensUI();
          return Settings.lookSens;
        },
        hp: function () { return playerHp; },
        // 调试（自动化联机测试）：清零/设置本地受伤无敌帧（后台标签 rAF 节流时
        // hurtInvuln 按 dt 上限衰减极慢，连续 PvP 命中事件需要它来消除测试时序依赖）
        setInvuln: function (v) { hurtInvuln = Math.max(0, +v || 0); return hurtInvuln; },
        // 调试（自动化）：本地注入一条房主 PvP 命中事件，走与网络收到 ph 完全相同的处理
        testPh: function (n, fr) { onGuestPlayerHurt({ n: n | 0, fr: fr }); return playerHp; },
        // 调试（自动化）：推挤解算前置条件快照
        pushInfo: function () {
          const av = remoteAvatar;
          const r = av && (av.cur || av.target);
          const hw = player.width / 2;
          const out = { state: state, active: Net.active(), riding: Mobs.isRiding(), frames: dbgFrameN, dt: dbgDt, av: av ? { live: av.live, hasCur: !!av.cur, cur: av.cur ? [av.cur.x, av.cur.y, av.cur.z] : null, target: av.target ? [av.target.x, av.target.y, av.target.z] : null } : null, me: [player.pos.x, player.pos.y, player.pos.z], w: player.width, h: player.height };
          if (r) { out.ox = hw * 2 - Math.abs(player.pos.x - r.x); out.oz = hw * 2 - Math.abs(player.pos.z - r.z); out.oy = player.height - Math.abs(player.pos.y - r.y); }
          return out;
        },
        // 调试（自动化）：手动跑一次推挤解算
        pushOnce: function () { resolvePlayerPush(); return true; },
        hurt: function (n) { return hurtPlayer(n || 3, null); },
        riding: function () { return Mobs.isRiding(); },
        save: function () { return saveGame(false); },
        hasSave: function () { return SaveSystem.has(); },
        clearSave: function () { SaveSystem.clear(); },
        // 调试用：手动渲染一帧并同步读回 JPEG（不依赖 rAF）
        shot: function (scale) {
          skyDome.position.copy(camera.position);
          camera.position.set(player.pos.x, player.pos.y + player.eyeHeight, player.pos.z);
          camera.rotation.set(player.pitch, player.yaw, 0);
          eyePos.copy(camera.position);   // 同步选取射线原点，使 pick/use 在无 rAF 时也可用
          renderer.render(scene, camera);
          const cv = renderer.domElement;
          const k = scale || 0.5;
          const oc = document.createElement("canvas");
          oc.width = Math.max(2, Math.floor(cv.width * k));
          oc.height = Math.max(2, Math.floor(cv.height * k));
          oc.getContext("2d").drawImage(cv, 0, 0, oc.width, oc.height);
          return oc.toDataURL("image/jpeg", 0.75);
        }
      };

      // 无限世界：出生点周围 MESH_R 环网格分批后台构建（initialBuild 会先
      // 同步补齐数据环），菜单与点击立即可响应；进游戏后由 updateStreaming 维持
      // 客人端此时是占位种子，一块都不建——welcome 到达后按房主种子重建
      if (!isGuestBoot) {
        const tBeforeChunk = performance.now();
        // 读档玩家可能在远方：网格围绕实际入场位置（玩家位置）构建
        const bootCenter = pendingSave ? player.pos : spawnPoint;
        world.initialBuild(bootCenter.x, bootCenter.z, world.MESH_R, 4, null, function () {
          console.log("[Boot] 出生区网格后台构建完成，用时 " +
                      Math.round(performance.now() - tBeforeChunk) + "ms");
        });
        console.log("[Boot] 出生点数据 " + Math.round(tGen - t0) +
          "ms，读档/生物/UI 初始化 " + Math.round(tBeforeChunk - tGen) +
          "ms，菜单就绪共 " + Math.round(tBeforeChunk - t0) +
          "ms；出生区网格后台分帧构建中…");
      }

      state = "menu";
      loadingEl.classList.add("hidden");
      showMainMenu();
      animate();

      // 联机引导：URL 参数决定本页身份
      setupNetIntegration();
      if (netHostMode) {
        Net.host();
      } else if (netJoinCode) {
        Net.join(netJoinCode);
      }
    } catch (err) {
      loadingEl.textContent = "世界生成失败：" + err.message;
      console.error(err);
    }
    }).catch(function (err) {
      loadingEl.textContent = "启动失败：" + ((err && err.message) || err);
      console.error(err);
    });
  }, 60);
})();
