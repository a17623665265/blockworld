/* ============================================================
 * blocks.js — 方块 ID、物品 ID、纹理图集索引、外观与掉落定义
 * ============================================================ */
(function (global) {
  "use strict";

  // 方块 ID（可放置于世界，1..99）
  const BLOCK = {
    AIR: 0,
    GRASS: 1,
    DIRT: 2,
    STONE: 3,
    LOG: 4,
    LEAVES: 5,
    SAND: 6,
    WATER: 7,
    PLANKS: 8,
    COBBLE: 9,
    BEDROCK: 10,
    CRAFTING_TABLE: 11,
    STONE_BRICKS: 12,
    SNOW: 13,        // 雪（冰川地表）
    ICE: 14,         // 冰（冰川海面封冻）
    CACTUS: 15,      // 仙人掌（沙漠）
    BASALT: 16,      // 玄武岩（火山岩体）
    LAVA: 17,        // 岩浆源头（非实心，接触受伤，不可挖取）
    SANDSTONE: 18,   // 沙岩（沙漠地下）
    FLOW_LAVA: 19,   // 流动岩浆·近（距源头 1 格）
    FLOW_LAVA_2: 20, // 流动岩浆·中（距源头 2 格）
    FLOW_LAVA_3: 21, // 流动岩浆·远（距源头 3 格）
    COAL_ORE: 22,    // 煤矿石（地下，镐挖直接掉煤，也可入炉烧煤）
    IRON_ORE: 23,    // 铁矿石（深层地下，需石镐，挖下掉粗铁，粗铁入炉炼铁锭）
    FURNACE: 24,     // 熔炉（8 圆石合成，右键打开烧炼）
    TORCH: 25,       // 火把（煤+木棍合成，非实心，插地照明）
    BIRCH_LOG: 26    // 白桦原木（白皮灰黑斑侧面 + 黄褐年轮顶面，斧极速砍伐）
  };

  // 物品 ID（不可放置，100+）
  const ITEM = {
    STICK: 100,
    WOOD_PICKAXE: 101,
    STONE_PICKAXE: 102,
    PORKCHOP: 103,   // 生猪排（猪掉落，可喂狗/动物）
    BEEF: 104,       // 生牛肉（牛掉落）
    MUTTON: 105,     // 生羊肉（羊掉落）
    LEATHER: 106,    // 皮革（牛掉落）
    WOOL: 107,       // 羊毛（羊掉落）
    WOOL_HELMET: 108,  // 羊毛帽（头）
    WOOL_CHEST: 109,   // 羊毛衣（胸）
    WOOL_LEGS: 110,    // 羊毛裤（腿）
    DRAGON_MEAT: 111,  // 龙肉（火山紫黑龙掉落）
    DRAGON_HIDE: 112,  // 龙皮（火山紫黑龙掉落）
    COAL: 113,         // 煤（煤矿石用镐挖直接掉落 / 高效燃料）
    IRON_INGOT: 114,   // 铁锭（粗铁入炉烧炼产物）
    RAW_IRON: 140,     // 粗铁（铁矿石用镐挖直接掉落，入炉烧成铁锭）
    // 115/116 红宝石 mod、117/118/119 农耕 mod 动态占用；
    // 背包固定 120、木斧 121、蜘蛛丝 122、石斧 123（均已在
    // GameRegistry.reservedItemIds 预留，mod 动态分配会跳过）；
    // 红宝石斧由 ruby_mod 显式认领固定 124（见 GameRegistry.item）
    BACKPACK: 120,     // 皮革背包（背部装备，提供 9 格储物空间）
    WOOD_AXE: 121,     // 木斧（砍原木 / 木板 / 工作台极快，也可当武器）
    SPIDER_SILK: 122,  // 蜘蛛丝（夜晚击败蜘蛛掉落）
    STONE_AXE: 123,    // 石斧（2 级斧，砍木比木斧更快、伤害 6）
    // 124 红宝石斧由 ruby_mod 显式注册
    IRON_AXE: 125,     // 铁斧（3 级斧，强于石斧弱于红宝石斧，伤害 7）
    IRON_PICKAXE: 126  // 铁镐（3 级镐，挖石比石镐快、伤害 6）
  };

  // 纹理图集(4 列 x 4 行)中的 tile 索引
  const TILE = {
    GRASS_TOP: 0,
    GRASS_SIDE: 1,
    DIRT: 2,
    STONE: 3,
    LOG_SIDE: 4,
    LOG_TOP: 5,
    LEAVES: 6,
    SAND: 7,
    WATER: 8,
    PLANKS: 9,
    COBBLE: 10,
    BEDROCK: 11,
    TABLE_TOP: 12,
    TABLE_SIDE: 13,
    STONE_BRICKS: 14,
    SNOW: 15,
    ICE: 16,
    CACTUS_SIDE: 17,
    CACTUS_TOP: 18,
    BASALT: 19,
    LAVA: 20,
    SANDSTONE: 21,
    COAL_ORE: 22,
    IRON_ORE: 23,
    FURNACE_SIDE: 24,
    FURNACE_TOP: 25,
    TORCH: 26,
    GRASS_BLADES: 27,  // 草方块顶面的小草（交叉面片，透明裁切）
    BIRCH_LOG_SIDE: 28,// 白桦原木侧面（白皮 + 灰黑横向斑纹）
    BIRCH_LOG_TOP: 29, // 白桦原木顶面（黄褐同心年轮）
    FURNACE_FRONT: 30  // 熔炉正面（双炉口 + 中部亮带，仅朝向玩家的一面）
  };

  // 每个方块三个方向的纹理: [顶面, 侧面, 底面]
  const BLOCK_TILES = {};
  BLOCK_TILES[BLOCK.GRASS]          = [TILE.GRASS_TOP, TILE.GRASS_SIDE, TILE.DIRT];
  BLOCK_TILES[BLOCK.DIRT]           = [TILE.DIRT, TILE.DIRT, TILE.DIRT];
  BLOCK_TILES[BLOCK.STONE]          = [TILE.STONE, TILE.STONE, TILE.STONE];
  BLOCK_TILES[BLOCK.LOG]            = [TILE.LOG_TOP, TILE.LOG_SIDE, TILE.LOG_TOP];
  BLOCK_TILES[BLOCK.BIRCH_LOG]      = [TILE.BIRCH_LOG_TOP, TILE.BIRCH_LOG_SIDE, TILE.BIRCH_LOG_TOP];
  BLOCK_TILES[BLOCK.LEAVES]         = [TILE.LEAVES, TILE.LEAVES, TILE.LEAVES];
  BLOCK_TILES[BLOCK.SAND]           = [TILE.SAND, TILE.SAND, TILE.SAND];
  BLOCK_TILES[BLOCK.WATER]          = [TILE.WATER, TILE.WATER, TILE.WATER];
  BLOCK_TILES[BLOCK.PLANKS]         = [TILE.PLANKS, TILE.PLANKS, TILE.PLANKS];
  BLOCK_TILES[BLOCK.COBBLE]         = [TILE.COBBLE, TILE.COBBLE, TILE.COBBLE];
  BLOCK_TILES[BLOCK.BEDROCK]        = [TILE.BEDROCK, TILE.BEDROCK, TILE.BEDROCK];
  BLOCK_TILES[BLOCK.CRAFTING_TABLE] = [TILE.TABLE_TOP, TILE.TABLE_SIDE, TILE.PLANKS];
  BLOCK_TILES[BLOCK.STONE_BRICKS]   = [TILE.STONE_BRICKS, TILE.STONE_BRICKS, TILE.STONE_BRICKS];
  BLOCK_TILES[BLOCK.SNOW]           = [TILE.SNOW, TILE.SNOW, TILE.SNOW];
  BLOCK_TILES[BLOCK.ICE]            = [TILE.ICE, TILE.ICE, TILE.ICE];
  BLOCK_TILES[BLOCK.CACTUS]         = [TILE.CACTUS_TOP, TILE.CACTUS_SIDE, TILE.CACTUS_TOP];
  BLOCK_TILES[BLOCK.BASALT]         = [TILE.BASALT, TILE.BASALT, TILE.BASALT];
  BLOCK_TILES[BLOCK.LAVA]           = [TILE.LAVA, TILE.LAVA, TILE.LAVA];
  BLOCK_TILES[BLOCK.SANDSTONE]      = [TILE.SANDSTONE, TILE.SANDSTONE, TILE.SANDSTONE];
  BLOCK_TILES[BLOCK.COAL_ORE]       = [TILE.COAL_ORE, TILE.COAL_ORE, TILE.COAL_ORE];
  BLOCK_TILES[BLOCK.IRON_ORE]       = [TILE.IRON_ORE, TILE.IRON_ORE, TILE.IRON_ORE];
  BLOCK_TILES[BLOCK.FURNACE]        = [TILE.FURNACE_TOP, TILE.FURNACE_SIDE, TILE.FURNACE_TOP];
  // 火把世界渲染为特殊细柱模型，此 tile 仅用于物品栏 / 手持图标
  BLOCK_TILES[BLOCK.TORCH]          = [TILE.TORCH, TILE.TORCH, TILE.TORCH];

  // 方块中文名称
  const BLOCK_NAMES = {};
  BLOCK_NAMES[BLOCK.GRASS] = "草方块";
  BLOCK_NAMES[BLOCK.DIRT] = "泥土";
  BLOCK_NAMES[BLOCK.STONE] = "石头";
  BLOCK_NAMES[BLOCK.LOG] = "原木";
  BLOCK_NAMES[BLOCK.BIRCH_LOG] = "白桦原木";
  BLOCK_NAMES[BLOCK.LEAVES] = "树叶";
  BLOCK_NAMES[BLOCK.SAND] = "沙子";
  BLOCK_NAMES[BLOCK.WATER] = "水";
  BLOCK_NAMES[BLOCK.PLANKS] = "木板";
  BLOCK_NAMES[BLOCK.COBBLE] = "圆石";
  BLOCK_NAMES[BLOCK.BEDROCK] = "基岩";
  BLOCK_NAMES[BLOCK.CRAFTING_TABLE] = "工作台";
  BLOCK_NAMES[BLOCK.STONE_BRICKS] = "石砖";
  BLOCK_NAMES[BLOCK.SNOW] = "雪";
  BLOCK_NAMES[BLOCK.ICE] = "冰";
  BLOCK_NAMES[BLOCK.CACTUS] = "仙人掌";
  BLOCK_NAMES[BLOCK.BASALT] = "玄武岩";
  BLOCK_NAMES[BLOCK.LAVA] = "岩浆";
  BLOCK_NAMES[BLOCK.SANDSTONE] = "沙岩";
  BLOCK_NAMES[BLOCK.FLOW_LAVA] = "岩浆流";
  BLOCK_NAMES[BLOCK.FLOW_LAVA_2] = "岩浆流";
  BLOCK_NAMES[BLOCK.FLOW_LAVA_3] = "岩浆流";
  BLOCK_NAMES[BLOCK.COAL_ORE] = "煤矿石";
  BLOCK_NAMES[BLOCK.IRON_ORE] = "铁矿石";
  BLOCK_NAMES[BLOCK.FURNACE] = "熔炉";
  BLOCK_NAMES[BLOCK.TORCH] = "火把";

  // 非方块物品信息：name 名称；maxStack 最大堆叠；tool 工具类型(可空)；level 工具等级
  const ITEM_INFO = {};
  ITEM_INFO[ITEM.STICK]         = { name: "木棍", maxStack: 64 };
  // dur = 可挖方块的次数（耐久）
  ITEM_INFO[ITEM.WOOD_PICKAXE]  = { name: "木镐", maxStack: 1, tool: "pickaxe", level: 1, dur: 60 };
  ITEM_INFO[ITEM.STONE_PICKAXE] = { name: "石镐", maxStack: 1, tool: "pickaxe", level: 2, dur: 130 };
  ITEM_INFO[ITEM.IRON_PICKAXE]  = { name: "铁镐", maxStack: 1, tool: "pickaxe", level: 3, dur: 200 };
  // 斧：对木质方块（原木 / 木板 / 工作台）有极速砍伐加成，见 AXE_DIG；
  // 高级斧（石斧 / 铁斧 / 红宝石斧）在基础耗时上再按等级提速，见 digTimeOf
  ITEM_INFO[ITEM.WOOD_AXE]      = { name: "木斧", maxStack: 1, tool: "axe", level: 1, dur: 60 };
  ITEM_INFO[ITEM.STONE_AXE]     = { name: "石斧", maxStack: 1, tool: "axe", level: 2, dur: 130 };
  ITEM_INFO[ITEM.IRON_AXE]      = { name: "铁斧", maxStack: 1, tool: "axe", level: 3, dur: 200 };
  ITEM_INFO[ITEM.PORKCHOP]      = { name: "生猪排", maxStack: 64, food: true };
  ITEM_INFO[ITEM.BEEF]          = { name: "生牛肉", maxStack: 64, food: true };
  ITEM_INFO[ITEM.MUTTON]        = { name: "生羊肉", maxStack: 64, food: true };
  ITEM_INFO[ITEM.LEATHER]       = { name: "皮革", maxStack: 64 };
  ITEM_INFO[ITEM.WOOL]          = { name: "羊毛", maxStack: 64 };
  // 羊毛护甲：armor 为穿戴部位，defense 为可抵消的半心伤害
  ITEM_INFO[ITEM.WOOL_HELMET]   = { name: "羊毛帽", maxStack: 1, armor: "head", defense: 1 };
  ITEM_INFO[ITEM.WOOL_CHEST]    = { name: "羊毛衣", maxStack: 1, armor: "chest", defense: 2 };
  ITEM_INFO[ITEM.WOOL_LEGS]     = { name: "羊毛裤", maxStack: 1, armor: "legs", defense: 1 };
  ITEM_INFO[ITEM.DRAGON_MEAT]   = { name: "龙肉", maxStack: 64, food: true };
  ITEM_INFO[ITEM.DRAGON_HIDE]   = { name: "龙皮", maxStack: 64 };
  ITEM_INFO[ITEM.COAL]          = { name: "煤", maxStack: 64, fuel: 8 };
  ITEM_INFO[ITEM.RAW_IRON]      = { name: "粗铁", maxStack: 64 };
  ITEM_INFO[ITEM.IRON_INGOT]    = { name: "铁锭", maxStack: 64 };
  // 皮革背包：装备在背部（armor:"back"），装备后物品栏面板多出 9 格储物空间
  ITEM_INFO[ITEM.BACKPACK]      = { name: "皮革背包", maxStack: 1, armor: "back" };
  ITEM_INFO[ITEM.SPIDER_SILK]   = { name: "蜘蛛丝", maxStack: 64 };

  // 挖掘耗时表（秒）：[徒手, 木镐, 石镐]，未列镐速的方块镐不加速。
  // 泥土松软、石头坚硬；矿石更硬且需要对应等级镐才能采集掉落。
  // 铁镐（3 级）在石镐列 ×0.8、红宝石镐（4 级）×0.65，见 digTimeOf。
  const BLOCK_DIG = {
    [BLOCK.GRASS]: [0.75],
    [BLOCK.DIRT]: [0.75],
    [BLOCK.SAND]: [0.6],
    [BLOCK.SNOW]: [0.4],
    [BLOCK.LEAVES]: [0.35],
    [BLOCK.CACTUS]: [0.6],
    [BLOCK.ICE]: [0.7],
    [BLOCK.LOG]: [2.0],
    [BLOCK.BIRCH_LOG]: [2.0],
    [BLOCK.PLANKS]: [1.8],
    [BLOCK.CRAFTING_TABLE]: [2.2],
    [BLOCK.SANDSTONE]: [2.4, 1.0, 0.55],
    [BLOCK.STONE]: [3.6, 1.15, 0.6],
    [BLOCK.COBBLE]: [3.6, 1.1, 0.6],
    [BLOCK.STONE_BRICKS]: [3.8, 1.15, 0.6],
    [BLOCK.BASALT]: [4.5, 1.4, 0.7],
    [BLOCK.COAL_ORE]: [4.5, 1.3, 0.7],
    [BLOCK.IRON_ORE]: [5.0, 1.9, 0.95],
    [BLOCK.FURNACE]: [4.0, 1.5, 0.8],
    [BLOCK.TORCH]: [0.05]
  };

  // 斧头砍伐耗时表（秒）：只列斧头能极速砍伐的木质方块。
  // 原木徒手要 2.0s，木斧 0.25s（8 倍速），真正“砍树非常快”
  const AXE_DIG = {
    [BLOCK.LOG]: 0.25,
    [BLOCK.BIRCH_LOG]: 0.25,
    [BLOCK.PLANKS]: 0.3,
    [BLOCK.CRAFTING_TABLE]: 0.4,
    [BLOCK.LEAVES]: 0.2
  };

  /* ============================================================
   * Mod 注册口：方块 / 物品 / 纹理 tile / 掉落规则的动态登记表
   * （js/mods/ 下的模组在游戏启动早期调用，见 modloader.js）
   * ============================================================ */
  const GameRegistry = {
    nextBlock: 27,    // BIRCH_LOG=26 之后开始分配
    nextItem: 115,    // IRON_INGOT=114 之后
    nextTile: 31,     // FURNACE_FRONT=30（内置）之后开始分配
    // 内置物品预留 id（动态分配物品时跳过，避免再出现背包 120 被 mod 物品顶号）。
    // 注意：走 def.id 显式占号的 mod 物品（124 红宝石斧、127/128/129 石/铁/红宝石锄头）
    // 不能写进这里——R.item 会把预留位也当冲突抛错；它们注册时自动加入本表。
    reservedItemIds: { 120: true, 121: true, 122: true, 123: true, 125: true, 126: true, 140: true },
    tilePainters: {}, // tile 索引 -> painter(ctx, ox, oy, PX)
    itemIcons: {},    // 物品 id -> 图标 dataURL
    customDrops: {},  // 方块 id -> {item, needPick}
    creativeAllow: {},// 方块 id -> true（不掉落的自然方块，如樱花树叶，创造物品栏仍给）
    extraNonSolid: {},// 方块 id -> true（可穿过）
    extraNonOpaque: {},// 方块 id -> true（不遮挡邻面）
    recipes: [],      // 有序合成配方 {pattern, output:{id,count}}
    smelts: {},       // 烧炼配方 输入 id -> {id,count}
    fuels: {},        // 燃料 id -> 可烧件数
    ores: [],         // 矿脉生成 {block,count,minY,maxY,sizeMin,sizeMax}
    tickHooks: [],    // 每帧逻辑 fn({world,elapsed,dt,player})（作物生长等）
    customMeshes: {}, // 方块 id -> fn(api) 自定义网格（api.box/unlitBox/cutoutBox/glowBox）
    collisionBoxes: {}, // 方块 id -> [[x0,y0,z0,x1,y1,z1]...] 格内相对碰撞盒（玩家/动物共用）
    lightBlocks: {},  // 方块 id -> {color,intensity,dist,oy,flicker} 点光源
    interactions: {}, // 方块 id -> fn(ctx) 右键交互，返回 true 表示已处理（门开关/床睡觉）
    placeHooks: {},   // 方块 id -> fn(ctx) 自定义放置逻辑（双格门/定向楼梯），返回 true 表示已处理
    breakHooks: {},   // 方块 id -> fn(ctx{x,y,z,id,world}) 破坏时连带处理，可返回额外掉落物 id
    mobDrops: {},     // 生物类型 -> 额外掉落行 [[item,min,max],...]（mod 给现有怪物加掉落，如僵尸→火药）
    axeDig: {},       // 方块 id -> 斧砍秒数（mod 木质方块扩展 AXE_DIG）
    blockIconSrc: {}, // 方块 id -> 物品栏等距图标 URL（合并进 BLOCK_ICON_SRC 加载）
    // 方块 id -> 立体图标的盒形描述（异形方块用，game.js 运行时等距渲染）。
    // {boxes:[[x0,y0,z0,x1,y1,z1,tile,{cutout,unlit,fit}]...]}；
    // 不注册的整格方块按 BLOCK_TILES [顶,侧,底] 自动渲染成整格立方体。
    iconShapes: {},
    particleColors: {}, // 方块 id -> 破坏粒子色（0xRRGGBB）

    // 登记一个图集 tile，返回 tile 索引。painter 在图集 canvas 上原位绘制
    allocTile(painter) {
      const t = this.nextTile++;
      this.tilePainters[t] = painter;
      return t;
    },

    // 注册方块。def：
    //  name 中文名；tiles 单个 tile 索引或 [顶,侧,底]；
    //  dig [徒手,木镐,石镐,更高级...] 秒数数组（可选）；
    //  pick 采集所需最低镐等级（0 任意/1 木镐/2 石镐）；
    //  drop 掉落物："self" 掉自身（默认）/ 物品 id / null 不掉
    block(def) {
      const id = this.nextBlock++;
      BLOCK_NAMES[id] = def.name;
      const tiles = typeof def.tiles === "number"
        ? [def.tiles, def.tiles, def.tiles]
        : def.tiles;
      BLOCK_TILES[id] = tiles;
      if (def.dig) BLOCK_DIG[id] = def.dig;
      if (def.solid === false) this.extraNonSolid[id] = true;
      if (def.opaque === false) this.extraNonOpaque[id] = true;
      const needPick = def.pick || 0;
      if (def.creative) this.creativeAllow[id] = true;
      if (def.drop === null) {
        this.customDrops[id] = { item: null, needPick: needPick };
      } else if (def.drop != null && def.drop !== "self") {
        this.customDrops[id] = { item: def.drop, needPick: needPick };
      } else if (needPick > 0) {
        this.customDrops[id] = { item: id, needPick: needPick };
      }
      return id;
    },

    // 注册物品。def：
    //  name / stack 最大堆叠 / dur 耐久 / tool {type:"pickaxe",level} /
    //  food 可食用 / held {model:"pick",head,dark} | {model:"gem",color,dark} 手持模型 /
    //  icon () => dataURL 物品栏图标
    item(def) {
      let id;
      if (def.id != null) {
        // 显式固定 id（供需要跨版本稳定的 mod 工具使用）：冲突即报错，
        // 并加入预留集合让后续自动分配跳过
        id = def.id;
        if (ITEM_INFO[id] || this.reservedItemIds[id]) {
          throw new Error("GameRegistry.item: 物品 id " + id + " 已被占用");
        }
        this.reservedItemIds[id] = true;
      } else {
        // 跳过内置物品预留 id（如背包 120），防止动态注册把内置物品顶号
        id = this.nextItem++;
        while (this.reservedItemIds[id]) id = this.nextItem++;
      }
      const info = { name: def.name, maxStack: def.stack != null ? def.stack : 64 };
      if (def.tool) {
        info.tool = def.tool.type || "pickaxe";
        info.level = def.tool.level || 1;
      }
      if (def.dur) info.dur = def.dur;
      if (def.food) info.food = true;
      if (def.held) info.heldModel = def.held;
      if (def.armor) info.armor = def.armor;
      if (def.defense) info.defense = def.defense;
      ITEM_INFO[id] = info;
      if (def.icon) this.itemIcons[id] = def.icon();
      return id;
    },

    // 有序合成。pattern 为二维数组（每行等长），元素为物品 id 或 0(空)，
    // 形状在合成格内自动裁剪对齐（与内置配方一致）
    registerRecipe(pattern, outId, count) {
      this.recipes.push({
        pattern: pattern,
        output: { id: outId, count: count || 1 }
      });
    },

    // 熔炉烧炼：输入方块/物品 -> 输出物品
    registerSmelt(inId, outId, count) {
      this.smelts[inId] = { id: outId, count: count || 1 };
    },

    // 燃料：id -> 一件燃料可烧炼的物品件数（如煤=8，木板=1）
    registerFuel(id, value) {
      this.fuels[id] = value;
    },

    // 地下矿脉。count 条矿脉，只替换石头
    registerOre(def) {
      this.ores.push({
        block: def.block,
        count: def.count,
        minY: def.minY,
        maxY: def.maxY,
        sizeMin: def.sizeMin || 3,
        sizeMax: def.sizeMax || 6
      });
    },

    // 每帧逻辑钩子（作物生长等）。fn({world, elapsed, dt, player})，异常隔离
    registerTick(fn) {
      this.tickHooks.push(fn);
    },

    // 16x16 点阵物品图标工具：rows 为等长字符串数组，map 把字符映射为颜色，
    // 空格/'.' 透明。返回 dataURL，供 item(def.icon) 使用
    pixelIcon(rows, map) {
      const PX = 16;
      const c = document.createElement("canvas");
      c.width = PX; c.height = PX;
      const g = c.getContext("2d");
      for (let y = 0; y < rows.length && y < PX; y++) {
        const row = rows[y];
        for (let x = 0; x < row.length && x < PX; x++) {
          const ch = row[x];
          const color = map[ch];
          if (color) {
            g.fillStyle = color;
            g.fillRect(x, y, 1, 1);
          }
        }
      }
      return c.toDataURL();
    }
  };

  // 可以喂食驯服动物的肉类（龙肉也算肉，可喂狗）
  const MEAT_IDS = [ITEM.PORKCHOP, ITEM.BEEF, ITEM.MUTTON, ITEM.DRAGON_MEAT];
  function isMeat(id) { return MEAT_IDS.indexOf(id) >= 0; }

  // 新游戏出生时自带的物品（帮玩家立刻体验合成链）
  const STARTER_ITEMS = [
    { id: BLOCK.GRASS, count: 10 },
    { id: BLOCK.LOG, count: 8 }
  ];

  // 无敌模式创造物品栏：全部可正常获取的方块 + 全部物品。
  // 用 isPlaceable 过滤水/岩浆/基岩；再排除技术变体（customDrops 指向另一个方块，
  // 如楼梯/门/栅门/活板门的朝向态、门顶、耕地）。
  // 两种「挖了不掉自身」的正常方块仍保留：
  //   ① 掉落的是物品材料（item>=100，如铜矿石掉粗铜）——创造栏直接给矿石方块；
  //   ② def.creative 显式白名单（如樱花树叶，挖碎什么都不掉）。
  function creativeItems() {
    const out = [];
    for (const k in BLOCK_TILES) {
      const id = +k;
      if (!isPlaceable(id)) continue;
      const cd = GameRegistry.customDrops[id];
      if (cd && cd.item !== id && cd.item < 100 && !GameRegistry.creativeAllow[id]) continue;
      out.push(id);
    }
    for (const k in ITEM_INFO) out.push(+k);
    return out;
  }

  // 是否为岩浆（源头或任意一档流动岩浆）
  function isLava(id) {
    return id === BLOCK.LAVA || id === BLOCK.FLOW_LAVA ||
           id === BLOCK.FLOW_LAVA_2 || id === BLOCK.FLOW_LAVA_3;
  }
  function isSolid(id) {
    // 岩浆像水一样不挡实体（会陷进去）；火把是细柱可穿过；其余方块实心
    if (GameRegistry.extraNonSolid[id]) return false;
    return id !== BLOCK.AIR && id !== BLOCK.WATER && id !== BLOCK.TORCH && !isLava(id);
  }
  function isOpaque(id) {
    // 对面剔除而言：水不遮挡邻面；岩浆按不透明处理（藏住地下邻面，顶面正常发光感绘制）；
    // 火把不遮挡邻面（背后的石头面仍需画出）
    if (GameRegistry.extraNonOpaque[id]) return false;
    return id !== BLOCK.AIR && id !== BLOCK.WATER && id !== BLOCK.TORCH;
  }

  // 火把是内置点光源；mod 光源（灯等）通过 GameRegistry.lightBlocks 注册
  GameRegistry.lightBlocks[BLOCK.TORCH] = { color: 0xffa84d, intensity: 2.5, dist: 14, oy: 0.9, flicker: true };

  // 某方块的碰撞盒列表（格内相对坐标）。未注册的实心方块为整格，非实心为无碰撞
  const FULL_COLLISION = [[0, 0, 0, 1, 1, 1]];
  function collisionBoxesOf(id) {
    const cb = GameRegistry.collisionBoxes[id];
    if (cb) return cb;
    return isSolid(id) ? FULL_COLLISION : null;
  }

  function getItemName(id) {
    return BLOCK_NAMES[id] || (ITEM_INFO[id] ? ITEM_INFO[id].name : "?");
  }
  function maxStackOf(id) {
    return ITEM_INFO[id] ? ITEM_INFO[id].maxStack : 64;
  }
  // 只有方块 ID 可以放置到世界
  function isPlaceable(id) {
    return id > 0 && id < 100 && !!BLOCK_TILES[id] &&
           id !== BLOCK.WATER && id !== BLOCK.BEDROCK && id !== BLOCK.LAVA;
  }
  // 是否为镐
  function isPickaxe(id) {
    return ITEM_INFO[id] && ITEM_INFO[id].tool === "pickaxe";
  }
  // 是否为斧
  function isAxe(id) {
    return ITEM_INFO[id] && ITEM_INFO[id].tool === "axe";
  }
  // 手持物的斧等级（0 = 非斧）
  function axeLevelOf(id) {
    return ITEM_INFO[id] && ITEM_INFO[id].tool === "axe" ? (ITEM_INFO[id].level || 1) : 0;
  }
  // 手持物的镐等级（0 = 非镐）
  function pickLevelOf(id) {
    return ITEM_INFO[id] && ITEM_INFO[id].tool === "pickaxe" ? (ITEM_INFO[id].level || 1) : 0;
  }
  // 工具满耐久（可挖次数），非工具返回 0
  function toolDurability(id) {
    return ITEM_INFO[id] && ITEM_INFO[id].dur ? ITEM_INFO[id].dur : 0;
  }
  // 挖某方块所需秒数（heldId 为当前手持物）
  function digTimeOf(id, heldId) {
    const t = BLOCK_DIG[id] || [1.0];
    // 斧优先：砍木质方块走极速砍伐表；高等级斧再提速
    // （木斧 ×1 / 石斧 ×0.72 / 铁斧 ×0.6 / 红宝石斧 ×0.5）
    if (isAxe(heldId)) {
      const at = AXE_DIG[id] != null ? AXE_DIG[id] : GameRegistry.axeDig[id];
      if (at != null) {
        const lv = ITEM_INFO[heldId].level || 1;
        const f = lv >= 4 ? 0.5 : lv === 3 ? 0.6 : lv === 2 ? 0.72 : 1;
        return Math.round(at * f * 1000) / 1000;
      }
    }
    if (isPickaxe(heldId)) {
      const lv = ITEM_INFO[heldId].level;
      // t 列：[徒手, 木镐(1), 石镐(2)]；铁镐(3)/红宝石镐(4)在石镐列上再按等级提速
      let base = null;
      for (let c = Math.min(lv, t.length - 1); c >= 1; c--) {
        if (t[c] != null) { base = t[c]; break; }
      }
      if (base != null) {
        const f = lv >= 4 ? 0.65 : lv === 3 ? 0.8 : 1;
        return Math.round(base * f * 1000) / 1000;
      }
    }
    return t[0];
  }
  // 是否为护甲；返回穿戴部位（head/chest/legs）或 null
  function armorSlotOf(id) {
    return ITEM_INFO[id] && ITEM_INFO[id].armor ? ITEM_INFO[id].armor : null;
  }
  function armorDefenseOf(id) {
    return ITEM_INFO[id] && ITEM_INFO[id].defense ? ITEM_INFO[id].defense : 0;
  }

  // 破坏方块后的掉落物：返回物品 id，或 null(不掉落)
  // heldId = 玩家当前手持物品
  function getBlockDrop(id, heldId) {
    // Mod 注册的自定义掉落规则优先
    const cd = GameRegistry.customDrops[id];
    if (cd) return pickLevelOf(heldId) >= cd.needPick ? cd.item : null;
    switch (id) {
      case BLOCK.GRASS: return BLOCK.DIRT;        // 草方块被挖后变成泥土
      case BLOCK.LEAVES: return null;              // 树叶徒手挖碎，不掉落
      case BLOCK.BEDROCK: return null;             // 基岩不可获取
      case BLOCK.STONE:
        // 石头必须用镐采集，且挖下后变成圆石（石镐等高级工具的材料来源）
        return isPickaxe(heldId) ? BLOCK.COBBLE : null;
      case BLOCK.COBBLE:
      case BLOCK.STONE_BRICKS:
      case BLOCK.BASALT:
      case BLOCK.FURNACE:
        return isPickaxe(heldId) ? id : null;      // 圆石/石砖/玄武岩/熔炉用镐采下掉自身
      case BLOCK.COAL_ORE:
        // 煤矿石用镐挖直接掉落「煤」（无需入炉烧炼）
        return isPickaxe(heldId) ? ITEM.COAL : null;
      case BLOCK.IRON_ORE:
        // 铁矿石必须用石镐（等级 2）或更好，挖下直接掉「粗铁」（入炉炼铁锭），木镐只会把它敲碎
        return pickLevelOf(heldId) >= 2 ? ITEM.RAW_IRON : null;
      case BLOCK.ICE:
      case BLOCK.LAVA:
      case BLOCK.FLOW_LAVA:
      case BLOCK.FLOW_LAVA_2:
      case BLOCK.FLOW_LAVA_3:
        return null;                               // 冰易碎不掉落；岩浆不可获取
      default:
        return BLOCK_TILES[id] ? id : null;        // 其余方块掉自身（雪/仙人掌/沙岩）
    }
  }

  // 橡树树叶：非不透明（透光、不遮挡邻面），用 cutout 镂空网格渲染纹理中的真孔洞
  GameRegistry.extraNonOpaque[BLOCK.LEAVES] = true;
  GameRegistry.customMeshes[BLOCK.LEAVES] = function (api) {
    api.cutoutBox(0, 0, 0, 1, 1, 1, TILE.LEAVES);
  };

  global.BLOCK = BLOCK;
  global.ITEM = ITEM;
  global.TILE = TILE;
  global.BLOCK_TILES = BLOCK_TILES;
  global.BLOCK_NAMES = BLOCK_NAMES;
  global.ITEM_INFO = ITEM_INFO;
  global.STARTER_ITEMS = STARTER_ITEMS;
  global.creativeItems = creativeItems;
  global.isSolid = isSolid;
  global.isOpaque = isOpaque;
  global.collisionBoxesOf = collisionBoxesOf;
  global.isLava = isLava;
  global.getItemName = getItemName;
  global.maxStackOf = maxStackOf;
  global.isPlaceable = isPlaceable;
  global.isPickaxe = isPickaxe;
  global.isAxe = isAxe;
  global.axeLevelOf = axeLevelOf;
  global.pickLevelOf = pickLevelOf;
  global.toolDurability = toolDurability;
  global.digTimeOf = digTimeOf;
  global.armorSlotOf = armorSlotOf;
  global.armorDefenseOf = armorDefenseOf;
  global.isMeat = isMeat;
  global.getBlockDrop = getBlockDrop;
  global.GameRegistry = GameRegistry;
})(window);
