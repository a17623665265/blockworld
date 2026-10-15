/* ============================================================
 * player.js — 第一人称玩家：移动、重力、跳跃、游泳、飞行
 * 碰撞：玩家 AABB 与体素逐轴解算
 * ============================================================ */
(function (global) {
  "use strict";

  class Player {
    constructor(world, camera) {
      this.world = world;
      this.camera = camera;

      this.pos = new THREE.Vector3();   // 脚底中心
      this.vel = new THREE.Vector3();
      this.yaw = 0;
      this.pitch = 0;

      this.width = 0.6;
      this.height = 1.8;
      this.eyeHeight = 1.62;

      this.onGround = false;
      this.flying = false;
      this.sprinting = false;   // 当前是否处于奔跑（由输入 / 着地 / 水环境共同裁决）
      this._sprintArmed = false;   // 本次冲刺已真正跑起来（达到冲刺速度）
      this._sprintBlocked = false; // 撞墙断冲后，需松开按键重新触发

      // 视角灵敏度倍率（1 = 默认；鼠标与触摸拖动共用，由设置菜单写入并持久化）
      this.lookSens = 1;

      this.walkSpeed = 4.6;
      this.sprintSpeed = 6.4;   // 奔跑约为步行 1.4 倍（对齐 MC 疾跑手感）
      this.flySpeed = 10;
      this.swimSpeed = 3.0;

      this.gravity = 26;
      this.jumpSpeed = 8.4;
      this.maxFall = 46;

      camera.rotation.order = "YXZ";
    }

    setSpawn(p) {
      this.pos.copy(p);
      this.vel.set(0, 0, 0);
    }

    addLook(dx, dy) {
      const s = 0.0022 * (this.lookSens || 1);
      this.yaw -= dx * s;
      this.pitch -= dy * s;
      const lim = Math.PI / 2 - 0.01;
      this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
    }

    toggleFly() {
      this.flying = !this.flying;
      this.vel.set(0, 0, 0);
    }

    // 眼睛 / 脚是否泡在水里
    checkWater() {
      const w = this.world;
      const ex = Math.floor(this.pos.x), ez = Math.floor(this.pos.z);
      const eyeY = Math.floor(this.pos.y + this.eyeHeight);
      const feetY = Math.floor(this.pos.y + 0.25);
      this.eyeInWater = w.getBlock(ex, eyeY, ez) === BLOCK.WATER;
      this.feetInWater = w.getBlock(ex, feetY, ez) === BLOCK.WATER;
    }

    // 脚下踩着的实心方块（扫描整个脚底范围），没有则返回 AIR
    groundBlock() {
      const hw = this.width / 2;
      const p = this.pos;
      const y = Math.floor(p.y - 0.05);
      for (let x = Math.floor(p.x - hw); x <= Math.floor(p.x + hw); x++) {
        for (let z = Math.floor(p.z - hw); z <= Math.floor(p.z + hw); z++) {
          const b = this.world.getBlock(x, y, z);
          if (b !== BLOCK.AIR && b !== BLOCK.WATER && !isLava(b)) return b;
        }
      }
      return BLOCK.AIR;
    }

    update(dt, input) {
      this.checkWater();
      const inWater = this.eyeInWater || this.feetInWater;
      this._inWater = inWater;   // 供逐轴碰撞里的“游出水面攀上整格岸”判断
      // 是否站在冰面上（决定打滑手感）
      const onIce = this.onGround && this.groundBlock() === BLOCK.ICE;

      // 飞行 / 游泳中冲刺裁决不生效，同时解除“撞墙断冲”锁定
      if (this.flying || inWater) {
        this._sprintArmed = false;
        this._sprintBlocked = false;
      }

      /* ---- 期望水平移动方向(仅由 yaw 决定) ---- */
      let mx = 0, mz = 0;
      if (input.forward) mz += 1;
      if (input.back) mz -= 1;
      if (input.right) mx += 1;
      if (input.left) mx -= 1;

      const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
      // yaw=0 时朝前为 -z，右为 +x
      let wx = (-sin * mz) + (cos * mx);
      let wz = (-cos * mz) + (-sin * mx);
      const len = Math.hypot(wx, wz);
      if (len > 0) { wx /= len; wz /= len; }

      if (this.flying) {
        /* ---------- 创造飞行 ---------- */
        this.sprinting = false;
        const sp = this.flySpeed;
        const k = Math.min(1, dt * 10);
        this.vel.x += (wx * sp - this.vel.x) * k;
        this.vel.z += (wz * sp - this.vel.z) * k;
        let vy = 0;
        if (input.jump) vy += 1;
        if (input.down) vy -= 1;
        this.vel.y += (vy * sp - this.vel.y) * k;
      } else if (inWater) {
        /* ---------- 水中 ---------- */
        this.sprinting = false;
        const sp = this.swimSpeed;
        const k = Math.min(1, dt * 8);
        this.vel.x += (wx * sp - this.vel.x) * k;
        this.vel.z += (wz * sp - this.vel.z) * k;
        this.vel.y -= this.gravity * 0.28 * dt;   // 浮力让下沉变慢
        // 按住跳跃：深水层（脚上方仍是水）普通划水上浮 3.4；
        // 脚已在最表层水（上方为空气）时给一次蹬水冲刺 4.9，
        // 配合横向移动可把玩家送出水面、滑上岸（旧逻辑恒速 3.4，
        // 上浮高度只到约 0.97 格，齐岸水面永远跳不出去）
        let cap = 3.4;
        if (input.jump) {
          const fx = Math.floor(this.pos.x), fz = Math.floor(this.pos.z);
          const feetY = Math.floor(this.pos.y + 0.25);
          const atSurface = this.world.getBlock(fx, feetY + 1, fz) === BLOCK.AIR;
          this.vel.y = atSurface  ? 4.9 : 3.4;   // 水面蹬出 / 水中划水
          cap = atSurface ? 4.9 : 3.4;
        }
        this.vel.y = Math.max(-3, Math.min(cap, this.vel.y));
      } else {
        /* ---------- 普通行走 / 奔跑 ---------- */
        // 奔跑仅在“向前 + 着地 + 非飞行非游泳”时成立（this.onGround 此刻为上一帧结果）
        const wantSprint = !!(input.sprint && input.forward && this.onGround);
        if (!wantSprint) {
          this._sprintArmed = false;
          this._sprintBlocked = false;
        }
        const sprintStarting = wantSprint && !this._sprintBlocked && !this.sprinting;
        this.sprinting = wantSprint && !this._sprintBlocked;
        if (sprintStarting) this._sprintArmed = false;   // 新冲刺周期重新计数
        const sp = this.sprinting ? this.sprintSpeed : this.walkSpeed;
        // 冰面：加速度 / 转向 / 制动都明显变“肉”，松开方向键后靠惯性滑行
        const accel = onIce ? 3.2 : 14;
        const k = this.onGround ? Math.min(1, dt * accel) : Math.min(1, dt * 5);
        this.vel.x += (wx * sp - this.vel.x) * k;
        this.vel.z += (wz * sp - this.vel.z) * k;

        this.vel.y -= this.gravity * dt;
        if (this.vel.y < -this.maxFall) this.vel.y = -this.maxFall;
        if (input.jump && this.onGround) {
          this.vel.y = this.jumpSpeed;
          this.onGround = false;
        }
      }

      /* ---- 逐轴移动 + 碰撞解算 ---- */
      this.wasOnGround = this.onGround;   // 供自动上台阶判断（x/z 轴先于 y 轴执行）
      this.onGround = false;
      this.moveAxis("x", this.vel.x * dt);
      this.moveAxis("z", this.vel.z * dt);
      this.moveAxis("y", this.vel.y * dt);

      /* ---- 世界边界：无限世界无水平边界，垂直碰撞由基岩层兜底 ---- */

      /* ---- 撞墙断冲 ----
       * 已经跑到冲刺速度后，若水平速度被碰撞解算压到步行速度的 65% 以下
       * （正面撞墙 / 卡进方块），结束本次冲刺（同 MC）；需松开前进或冲刺
       * 键重新触发，避免贴着墙空抖。 */
      if (this.sprinting) {
        const hsNow = Math.hypot(this.vel.x, this.vel.z);
        if (hsNow > this.sprintSpeed * 0.85) this._sprintArmed = true;
        else if (this._sprintArmed && hsNow < this.walkSpeed * 0.65) this._sprintBlocked = true;
      }

      /* ---- 更新相机 ---- */
      this.camera.position.set(this.pos.x, this.pos.y + this.eyeHeight, this.pos.z);
      this.camera.rotation.set(this.pitch, this.yaw, 0);
    }

    // 指定位置处玩家 AABB 是否与任何碰撞盒重叠（自动上台阶可行性检测用）
    collidesAt(px, py, pz) {
      const hw = this.width / 2;
      const minX = px - hw, maxX = px + hw;
      const minY = py, maxY = py + this.height;
      const minZ = pz - hw, maxZ = pz + hw;
      const eps = 1e-7;
      // 扫描范围外扩 1 格：围栏 / 栅门等碰撞盒高达 1.5 格、开门门板还会伸入邻格，
      // 只按 AABB 所在格枚举会漏检这些盒子（跳起时会从半高墙上穿过）
      for (let x = Math.floor(minX) - 1; x <= Math.floor(maxX - eps) + 1; x++) {
        for (let y = Math.floor(minY) - 1; y <= Math.floor(maxY - eps) + 1; y++) {
          for (let z = Math.floor(minZ) - 1; z <= Math.floor(maxZ - eps) + 1; z++) {
            const boxes = collisionBoxesOf(this.world.getBlock(x, y, z));
            if (!boxes) continue;
            for (const b of boxes) {
              const bx0 = x + b[0], by0 = y + b[1], bz0 = z + b[2];
              const bx1 = x + b[3], by1 = y + b[4], bz1 = z + b[5];
              if (bx0 < maxX && bx1 > minX && by0 < maxY && by1 > minY && bz0 < maxZ && bz1 > minZ) return true;
            }
          }
        }
      }
      return false;
    }

    // 沿单轴移动并解决与方块碰撞盒的碰撞（楼梯/台阶走碰撞盒，支持自动上台阶）
    moveAxis(axis, amount) {
      if (amount === 0) {
        // 静止时仍需检测垂直方向支撑(站在地上时重力让 amount 不会为 0，
        // 但飞行/游泳悬停时跳过即可)
        if (axis === "y") this.checkGroundSupport();
        return;
      }
      this.pos[axis] += amount;

      const hw = this.width / 2;
      const p = this.pos;
      const eps = 1e-7;

      let minX = p.x - hw, maxX = p.x + hw;
      let minY = p.y, maxY = p.y + this.height;
      let minZ = p.z - hw, maxZ = p.z + hw;

      // 扫描范围外扩 1 格，避免漏检跨越格界的碰撞盒（1.5 格围栏 / 栅门、开门门板）
      const x0 = Math.floor(minX) - 1, x1 = Math.floor(maxX - eps) + 1;
      const y0 = Math.floor(minY) - 1, y1 = Math.floor(maxY - eps) + 1;
      const z0 = Math.floor(minZ) - 1, z1 = Math.floor(maxZ - eps) + 1;

      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          for (let z = z0; z <= z1; z++) {
            const boxes = collisionBoxesOf(this.world.getBlock(x, y, z));
            if (!boxes) continue;

            for (const b of boxes) {
              const bx0 = x + b[0], by0 = y + b[1], bz0 = z + b[2];
              const bx1 = x + b[3], by1 = y + b[4], bz1 = z + b[5];
              // 严格重叠才需解算
              if (bx0 >= maxX || bx1 <= minX || by0 >= maxY || by1 <= minY || bz0 >= maxZ || bz1 <= minZ) continue;

              if (axis === "y") {
                if (amount < 0) {
                  if (by1 > p.y) p.y = by1;          // 落到盒顶
                  this.onGround = true;
                } else {
                  if (by0 - this.height < p.y) p.y = by0 - this.height; // 顶到头
                }
                this.vel.y = 0;
              } else {
                // 自动上台阶：盒顶不高于脚底 0.55 且站上去后不卡墙，直接抬脚（走楼梯/台阶）
                const rise = by1 - p.y;
                const stepUp = this.wasOnGround && rise > 0 && rise <= 0.55;
                // 游出水面：水中按住跳跃上浮（vy>0.8）贴岸横撞时，
                // 允许直接攀上与水面齐平的整格高岸边（1 格），不会被岸壁挡回水里
                const waterMantle = this._inWater && this.vel.y > 0.8 &&
                                    rise > 0 && rise <= 1.0 + 1e-4;
                if (!this.flying && (stepUp || waterMantle) &&
                    !this.collidesAt(p.x, by1 + 0.001, p.z)) {
                  p.y = by1 + 0.001;
                  this.onGround = true;
                } else if (axis === "x") {
                  if (amount > 0) p.x = bx0 - hw - eps;
                  else p.x = bx1 + hw + eps;
                  this.vel.x = 0;
                } else {
                  if (amount > 0) p.z = bz0 - hw - eps;
                  else p.z = bz1 + hw + eps;
                  this.vel.z = 0;
                }
              }
              // 位置变化后重算包围盒，继续解算剩余碰撞盒
              minX = p.x - hw; maxX = p.x + hw;
              minY = p.y;      maxY = p.y + this.height;
              minZ = p.z - hw; maxZ = p.z + hw;
            }
          }
        }
      }
    }

    // 悬停(飞行/游泳)时检测脚下支撑，用于落地瞬间恢复 onGround
    checkGroundSupport() {
      const hw = this.width / 2;
      const p = this.pos;
      const y = Math.floor(p.y - 0.05);
      for (let x = Math.floor(p.x - hw); x <= Math.floor(p.x + hw); x++) {
        for (let z = Math.floor(p.z - hw); z <= Math.floor(p.z + hw); z++) {
          const boxes = collisionBoxesOf(this.world.getBlock(x, y, z));
          if (!boxes) continue;
          for (const b of boxes) {
            if (y + b[4] >= p.y - 0.06) { this.onGround = true; return; }
          }
        }
      }
    }
  }

  global.Player = Player;
})(window);
