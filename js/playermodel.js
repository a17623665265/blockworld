/* ============================================================
 * playermodel.js — 玩家自己的 3D 身体（Steve 式方块人）
 *
 * 第一人称游玩时整具身体隐藏（躯干会糊视野、双腿垂直低头时会变成
 * 准星两侧两个悬浮的蓝色裤腿方块；第一人称的手由 ViewModel 叠加层负责）；
 * 按 V 切到第三人称后整个人完整可见，四肢随走路摆动、
 * 右手随挖 / 放挥动、头部跟随视角俯仰。
 *
 * 坐标约定：root 原点在脚底中心，头朝 -Z（与玩家 yaw 一致）
 * ============================================================ */
(function (global) {
  "use strict";

  const GEO = new THREE.BoxGeometry(1, 1, 1);
  function mat(color) {
    return new THREE.MeshLambertMaterial({ color: color });
  }

  // Steve 风配色
  const C = {
    skin: 0xc68e5b,
    skinDark: 0xa06f45,
    shirt: 0x00a8af,
    shirtDark: 0x00858c,
    pants: 0x3c408f,
    pantsDark: 0x2e326e,
    shoe: 0x2b2b33,
    hair: 0x3b2817,
    eyeWhite: 0xf2f2ee,
    iris: 0x4a3a8a,
    mouth: 0x7a5238
  };

  // 缩放方块快捷构造：parent / 材质 / 位置 / (sx,sy,sz)
  function box(parent, m, x, y, z, sx, sy, sz) {
    const mesh = new THREE.Mesh(GEO, m);
    mesh.position.set(x, y, z);
    mesh.scale.set(sx, sy, sz);
    parent.add(mesh);
    return mesh;
  }

  // 工厂：每一具玩家身体（本地玩家 + 联机时的远端化身）都是独立实例
  function createAvatar() {
      const root = new THREE.Group();
      root.visible = false;

      const parts = { legs: [], arms: [] };

      /* ---- 双腿：髋部为支点 ---- */
      const hipY = 0.72;
      for (const sx of [-1, 1]) {
        const hip = new THREE.Group();
        hip.position.set(sx * 0.15, hipY, 0);
        // 裤腿 + 膝盖暗纹 + 鞋（鞋头略前伸）
        box(hip, mat(C.pants), 0, -0.30, 0, 0.15, 0.60, 0.15);
        box(hip, mat(C.pantsDark), 0, -0.18, 0, 0.152, 0.05, 0.152);
        box(hip, mat(C.shoe), 0, -0.66, -0.015, 0.16, 0.12, 0.19);
        root.add(hip);
        parts.legs.push({ pivot: hip, phase: sx < 0 ? 0 : 1 });
      }

      /* ---- 上半身父组（弯腰时一起转，避免头/臂与躯干脱节） ---- */
      const spine = new THREE.Group();
      spine.position.set(0, 0.72, 0);   // 弯腰支点：腰部
      root.add(spine);
      parts.spine = spine;

      /* ---- 躯干：组原点与 spine 重合，盒体一律用 spine 局部坐标 ----
       * （世界 y = 局部 y + 0.72，衬衫占 0.72 ~ 1.36，头顶点 1.38，留 0.02 颈缝，
       *   避免衬衫顶面与头底面共面闪烁）。
       * 注意：torso.position.y 是走路起伏量、基准必须恒为 0，
       * 绝不能再放“抵消 spine 偏移”的基准值——update() 每帧会把它衰减/赋值到 0，
       * 基准一旦写进 position.y，进游戏几秒就会被抹掉，躯干整体上移 0.72。 */
      const torso = new THREE.Group();
      spine.add(torso); parts.torso = torso;
      box(torso, mat(C.shirt), 0, 0.32, 0, 0.50, 0.64, 0.26);
      // 腰间腰带一条 + 前襟阴影（脸朝 -Z，阴影放正面），分出层次
      box(torso, mat(C.shirtDark), 0, 0.04, 0, 0.50, 0.08, 0.265);
      box(torso, mat(C.shirtDark), 0, 0.32, -0.132, 0.12, 0.56, 0.02);

      /* ---- 双臂：肩部为支点（袖子 + 肤色小臂 + 手） ---- */
      const shoulderY = 1.34 - 0.72;   // 相对 spine 的局部坐标（spine 在 y=0.72）
      for (const sx of [-1, 1]) {
        const sh = new THREE.Group();
        sh.position.set(sx * 0.325, shoulderY, 0);
        box(sh, mat(C.shirt), 0, -0.14, 0, 0.14, 0.28, 0.14);
        box(sh, mat(C.skin), 0, -0.46, 0, 0.13, 0.36, 0.13);
        box(sh, mat(C.skinDark), sx * 0.035, -0.46, 0, 0.02, 0.34, 0.132);
        box(sh, mat(C.skin), 0, -0.68, 0, 0.14, 0.10, 0.14);
        spine.add(sh);   // 手臂挂在 spine 上，随弯腰一起转
        // 右臂与左腿同相（走路对角摆动）
        parts.arms.push({ pivot: sh, phase: sx > 0 ? 0 : 1 });
        if (sx > 0) {
          parts.rightArm = sh;
          // 右手持物挂点：位于拳头中心（手盒在 y=-0.68），作为肩 pivot 的
          // 子节点，走路摆动 / 挖放挥手 / 骑乘前伸时手持物自然跟随整条手臂。
          const heldAnchor = new THREE.Group();
          heldAnchor.position.set(0, -0.68, 0);
          sh.add(heldAnchor);
          parts.heldAnchor = heldAnchor;
        }
      }

      /* ---- 头：颈部为支点，跟随视角 pitch ---- */
      const head = new THREE.Group();
      head.position.set(0, 1.38 - 0.72, 0);   // 相对 spine 的局部坐标
      spine.add(head); parts.head = head;
      box(head, mat(C.skin), 0, 0.22, 0, 0.44, 0.44, 0.44);
      // 头发：发帽盖顶（盖住头顶，略微出沿）+ 后脑
      box(head, mat(C.hair), 0, 0.36, 0.01, 0.46, 0.16, 0.46);
      box(head, mat(C.hair), 0, 0.10, 0.21, 0.44, 0.34, 0.07);
      box(head, mat(C.hair), -0.21, 0.14, 0.02, 0.06, 0.26, 0.40);
      box(head, mat(C.hair), 0.21, 0.14, 0.02, 0.06, 0.26, 0.40);
      // 脸：眼白 + 紫瞳 + 嘴（脸朝 -Z）
      for (const sx of [-1, 1]) {
        box(head, mat(C.eyeWhite), sx * 0.10, 0.05, -0.225, 0.10, 0.09, 0.02);
        box(head, mat(C.iris), sx * 0.10, 0.05, -0.238, 0.045, 0.05, 0.01);
      }
      box(head, mat(C.mouth), 0, -0.10, -0.228, 0.16, 0.035, 0.02);

      // 第一人称整具身体全部隐藏（同 MC Java 第一人称）：
      // 躯干距相机太近，稍低头衬衫就会像一堵墙糊在视野中央；
      // 双腿髋部仅低约 0.9m，正常俯仰角下在画面底边之外，只有垂直低头超过
      // 约 57° 时才从下沿升入画面并一路靠到准星两侧——躯干又被隐藏，两条裤腿
      // 没有身体连接，看起来就是两个悬浮的蓝色箱子，正是玩家吐槽的画面。
      // 第一人称的“手”由 viewmodel.js 的独立叠加层负责；第三人称整具身体照常。
      const firstPersonHidden = [head, torso, parts.legs[0].pivot, parts.legs[1].pivot,
        parts.arms[0].pivot, parts.arms[1].pivot];

      const inst = {
        root: root,
        parts: parts,
        firstPersonHidden: firstPersonHidden,
        phase: 0,
        swingT: 0,
        bob: 0,             // 走路时躯干起伏量（基准 0，每帧应用到 torso.position.y）
        firstPerson: false,
        heldId: 0,          // 当前右手持物 id（0 空手）
        heldWrap: null,     // 持物外层包装（清换物品时移除）

        // 挖 / 放方块时右手挥动
        swing() { this.swingT = 1; },

        // 切换右手持物：模型工厂复用 ViewModel.buildHeldMesh（与第一人称、
        // 物品栏图标的外观完全同源），再套一层第三人称专用包装——清除第一人称
        // 基座位姿后，按类别缩放到世界尺寸并摆在拳前。挂点是右肩 pivot 的
        // 子节点，手臂任何动画都自动带动物品。
        setHeld(id) {
          if (id === this.heldId) return;
          this.heldId = id;
          const anchor = parts.heldAnchor;
          if (this.heldWrap) {
            anchor.remove(this.heldWrap);
            this.heldWrap = null;
          }
          if (!id || typeof global.ViewModel === "undefined" || !global.ViewModel.buildHeldMesh) return;
          const mesh = global.ViewModel.buildHeldMesh(id);
          if (!mesh) return;
          // 清掉工厂自带的第一人称基座 position/rotation（几何自身 scale 保留）
          mesh.position.set(0, 0, 0);
          mesh.rotation.set(0, 0, 0);

          const wrap = new THREE.Group();
          const kind = mesh.userData.heldKind || "voxel";
          if (kind === "block") {
            // 方块：约 0.27m 见方，握在拳前偏外，手指搭在后上缘的感觉
            wrap.scale.setScalar(1.35);
            wrap.position.set(0.03, -0.02, -0.05);
            wrap.rotation.set(0.30, 0.50, 0.12);
          } else if (kind === "icon") {
            // 工具 / 肉排等像素图标：竖直卡片立在拳前，正面略转向身后相机
            wrap.scale.setScalar(0.80);
            wrap.position.set(0, 0, -0.05);
            wrap.rotation.set(-0.12, 0.45, 0.05);
          } else {
            // 煤 / 锭 / 宝石 / 种子等小体素：放大到与拳头相称
            wrap.scale.setScalar(1.50);
            wrap.position.set(0.02, -0.02, -0.04);
            wrap.rotation.set(-0.20, 0.40, 0.10);
          }
          wrap.add(mesh);
          anchor.add(wrap);
          this.heldWrap = wrap;
        },

        setVisible(v) { this.root.visible = v; },

        // 平滑趋近期望角度
        approach(cur, target, k) {
          return cur + (target - cur) * k;
        },

    /* dt, 状态：
     *   pos 脚底中心 / yaw / pitch / moving 地面移动 /
     *   onGround 着地 / riding 骑猪 / firstPerson 视角
     */
    update(dt, st) {
      const p = this.parts;

      this.root.position.set(st.pos.x, st.pos.y, st.pos.z);
      this.root.rotation.y = st.yaw;

      // 第一人称隐藏头与手臂
      if (st.firstPerson !== this.firstPerson) {
        this.firstPerson = !!st.firstPerson;
        for (const o of this.firstPersonHidden) o.visible = !this.firstPerson;
      }

      /* ---- 动画相位 ---- */
      if (st.moving) this.phase += dt * (st.sprint ? 12.8 : 9.0);
      const k = Math.min(1, dt * 12);

      if (st.riding) {
        // 骑猪：双腿前屈踩着、双臂前伸扶着
        for (const leg of p.legs) leg.pivot.rotation.x = this.approach(leg.pivot.rotation.x, 0.95, k);
        for (const a of p.arms) a.pivot.rotation.x = this.approach(a.pivot.rotation.x, 1.15, k * 0.7);
        this.bob = this.approach(this.bob, 0, k);
      } else if (st.moving) {
        const s = Math.sin(this.phase);
        // 奔跑：步频更快，迈腿 / 摆臂幅度更大，身体起伏更高
        const legAmp = st.sprint ? 0.85 : 0.62;
        const armAmp = st.sprint ? 0.72 : 0.55;
        for (const leg of p.legs) {
          leg.pivot.rotation.x = (leg.phase ? s : -s) * legAmp;
        }
        if (!this.firstPerson) {
          for (const a of p.arms) {
            a.pivot.rotation.x = (a.phase ? s : -s) * armAmp;
          }
        }
        // 行走时身体随步伐轻微起伏
        this.bob = Math.abs(Math.cos(this.phase)) * (st.sprint ? 0.05 : 0.028);
      } else if (!st.onGround) {
        // 腾空：双腿前后微收
        p.legs[0].pivot.rotation.x = this.approach(p.legs[0].pivot.rotation.x, 0.45, k);
        p.legs[1].pivot.rotation.x = this.approach(p.legs[1].pivot.rotation.x, -0.30, k);
        if (!this.firstPerson) {
          for (const a of p.arms) a.pivot.rotation.x = this.approach(a.pivot.rotation.x, -0.35, k);
        }
        this.bob = this.approach(this.bob, 0, k);
      } else {
        // 站立：四肢回正，手臂自然下垂
        for (const leg of p.legs) leg.pivot.rotation.x *= 0.8;
        if (!this.firstPerson) {
          for (const a of p.arms) a.pivot.rotation.x *= 0.8;
        }
        this.bob *= 0.8;
      }

      // 唯一的起伏应用点：torso 基准位置恒为 (0,0,0)，只叠加 bob
      p.torso.position.y = this.bob;

      /* ---- 右手挖 / 放挥动（覆盖右臂走路摆幅的一部分） ---- */
      if (this.swingT > 0) this.swingT = Math.max(0, this.swingT - dt / 0.30);
      if (!this.firstPerson && this.swingT > 0) {
        const sw = Math.sin((1 - this.swingT) * Math.PI);
        p.rightArm.rotation.x = -0.25 + sw * 1.25;
      }

      /* ---- 头跟随视角俯仰 + 躯干协同弯腰 ----
       * 弯腰幅度：pitch 的 30%（最大 18°），头承担剩余部分
       * 转的是 spine 组：躯干、手臂、头一起弯，避免脱节。
       * 第一人称不弯腰：躯干前倾会挡住相机视野（低头看到自己弯过来），
       * 只保留头随 pitch（反正头被隐藏，玩家只看得到直立躯干和腿） */
      const maxBend = 0.32;
      const spineTarget = this.firstPerson ? 0 : Math.max(-maxBend, Math.min(maxBend, st.pitch * 0.30));
      p.spine.rotation.x = this.approach(p.spine.rotation.x, spineTarget, Math.min(1, dt * 8));
      p.head.rotation.x = st.pitch - p.spine.rotation.x;
    }
      };
      return inst;
  }

  // 本地玩家单例：init() 后拥有与 create() 实例完全相同的字段与调用面
  const PlayerModel = {
    init(scene) {
      Object.assign(this, createAvatar());
      scene.add(this.root);
    },
    // 联机远端玩家：独立的第二具第三人称身体（头朝 -Z，update 状态驱动）
    create(scene) {
      const inst = createAvatar();
      scene.add(inst.root);
      return inst;
    }
  };

  global.PlayerModel = PlayerModel;
})(window);
