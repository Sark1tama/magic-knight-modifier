// ==UserScript==
// @name         魔法骑士修改器
// @namespace    http://tampermonkey.net/
// @version      3.9.13
// @description  斗鱼"魔法骑士"小游戏修改器 - 属性/掉落/技能倍率实时修改 + 配置持久化自动重放 + 全托管挂机(自动开战/收结算/选技能) + 防后台暂停
// @author       Sark1tama
// @license      MIT
// @match        *://*.douyu.com/0*
// @match        *://*.douyu.com/1*
// @match        *://*.douyu.com/2*
// @match        *://*.douyu.com/3*
// @match        *://*.douyu.com/4*
// @match        *://*.douyu.com/5*
// @match        *://*.douyu.com/6*
// @match        *://*.douyu.com/7*
// @match        *://*.douyu.com/8*
// @match        *://*.douyu.com/9*
// @match        *://*.douyu.com/beta/*
// @match        *://*.douyu.com/topic/*
// @match        *://*.douyu.com/pages/vibe-lab-act202608-game/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* ══════════ 0. 公共常量与工具(游戏 iframe 内的反暂停补丁也要用) ══════════ */
  const FRAME_KEYWORD = 'vibe-lab-act202608-game';
  const LS_KEY   = 'mkm:state:v1';
  const safeParse = v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };
  const finite = v => typeof v === 'number' && Number.isFinite(v);

  /* ══════════ 0.5 防失焦暂停 ══════════ */
  // 游戏 iframe 与主页面同源,共享 localStorage;开关状态每次事件实时读取,面板勾选立即生效
  function antiPauseSetup() {
    const enabled = () => safeParse(localStorage.getItem(LS_KEY))?.focusKeep !== false; // 默认开
    // 1. Page Visibility API 欺骗:document.hidden 恒为 false
    for (const [prop, val] of [['hidden', false], ['visibilityState', 'visible'], ['webkitHidden', false], ['webkitVisibilityState', 'visible']]) {
      const orig = Object.getOwnPropertyDescriptor(document, prop)
        || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(document), prop);
      try {
        Object.defineProperty(document, prop, {
          configurable: true,
          get: () => (enabled() ? val : (orig?.get ? orig.get.call(document) : val)),
        });
      } catch { /* 个别浏览器属性不可重定义,忽略 */ }
    }
    // 2. 事件拦截(捕获阶段阻断,游戏注册的监听器收不到):
    //    visibilitychange 覆盖切 tab/最小化;window 级 blur 覆盖窗口失焦(放行元素级 blur,不影响输入框)
    const blockVis = e => { if (enabled()) e.stopImmediatePropagation(); };
    const blockBlur = e => { if (enabled() && (e.target === window || e.target === document)) e.stopImmediatePropagation(); };
    ['visibilitychange', 'webkitvisibilitychange'].forEach(t => {
      document.addEventListener(t, blockVis, true);
      window.addEventListener(t, blockVis, true);
    });
    window.addEventListener('blur', blockBlur, true);
  }

  // 游戏 iframe 实例:只做反暂停补丁,不注入面板
  if (window.top !== window.self) {
    if (location.href.includes(FRAME_KEYWORD)) antiPauseSetup();
    return;
  }

  /* ══════════ 1. 常量(主页面) ══════════ */
  const SKILL_PREFIX  = 'skill:';
  const TICK_MS  = 100;
  const MAX_WAIT = 15000;

  /* ══════════ 2. 样式 ══════════ */
  document.head.appendChild(Object.assign(document.createElement('style'), { textContent: `
    #magic-knight-modifier{position:fixed;top:60px;right:10px;z-index:999999;width:300px;max-height:80vh;
      background:#1a1a2e;color:#e0e0e0;font:13px/1.5 "Microsoft YaHei",sans-serif;border:1px solid #333;
      border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,.5);overflow:hidden;display:flex;
      flex-direction:column;user-select:none;}
    #magic-knight-modifier.mk-collapsed #mk-tabs,
    #magic-knight-modifier.mk-collapsed #mk-body{display:none;}
    #mk-header{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;
      background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;font-weight:bold;font-size:14px;cursor:move;flex-shrink:0;}
    #mk-collapse{cursor:pointer;font-size:14px;padding:0 4px;}
    #mk-tabs{display:flex;background:#252540;border-bottom:1px solid #333;flex-shrink:0;}
    .mk-tab{flex:1;padding:8px;border:none;cursor:pointer;font-size:12px;background:#252540;color:#aaa;}
    .mk-tab.active{background:#3d3d5c;color:#fff;}
    #mk-body{padding:12px;overflow-y:auto;flex:1;}
    .mk-status{margin-bottom:8px;padding:6px 10px;border-radius:6px;font-size:12px;font-weight:bold;text-align:center;}
    .mk-status--home{background:#424242;color:#bbb;}
    .mk-status--battle{background:#2e7d32;color:#fff;}
    .mk-status--adv{background:#4a148c;color:#fff;}
    .mk-toggle{display:flex;align-items:center;gap:6px;font-size:11px;color:#aaa;margin-bottom:8px;cursor:pointer;}
    .mk-section{color:#4caf50;font-size:11px;font-weight:bold;margin:8px 0 4px;}
    .mk-info{margin-bottom:8px;padding:8px;background:#1a237e;border-radius:6px;font-size:11px;}
    .mk-info-row{display:flex;justify-content:space-between;margin-bottom:4px;}
    .mk-info-row--sep{border-top:1px solid #3949ab;padding-top:4px;}
    .mk-k{color:#aaa;}
    .mk-v{color:#ffd700;} .mk-v--cyan{color:#00e5ff;font-size:10px;} .mk-v--green{color:#4caf50;}
    .mk-v--orange{color:#ff9800;} .mk-v--purple{color:#e1bee7;}
    .mk-row{margin-bottom:8px;}
    .mk-row-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;font-size:11px;color:#aaa;}
    .mk-val{color:#ffd700;}
    .mk-range{width:100%;cursor:pointer;}
    .mk-input{width:100%;padding:6px;background:#2d2d44;border:1px solid #444;border-radius:4px;color:#e0e0e0;font-size:12px;box-sizing:border-box;}
    .mk-quick{display:flex;gap:4px;margin-top:4px;}
    .mk-quick button{flex:1;font-size:10px;padding:4px;border-radius:3px;border:1px solid #444;background:#2d2d44;color:#aaa;cursor:pointer;}
    .mk-lock{font-size:10px;padding:2px 6px;border-radius:3px;border:1px solid #666;background:#2d2d44;color:#aaa;cursor:pointer;}
    .mk-lock.on{border-color:#ffd700;background:#ffd700;color:#000;}
    .mk-chip{display:inline-block;background:#2d2d44;padding:6px 10px;border-radius:4px;}
    .mk-note{font-size:10px;color:#888;margin-top:4px;background:#2d2d44;padding:6px 10px;border-radius:4px;}
    .mk-note--warn{color:#ff9800;}
    .mk-empty{color:#888;font-size:11px;text-align:center;padding:12px;background:#252540;border-radius:6px;margin:8px 0;}
    .mk-defaults{background:#252540;padding:8px;border-radius:6px;font-size:10px;color:#aaa;}
    .mk-defaults-row{display:flex;justify-content:space-between;margin-bottom:2px;}
    .mk-error{color:#ff6b6b;text-align:center;padding:20px;}
  `}));

  /* ══════════ 3. 工具 ══════════ */
  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = s => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (f, v) =>
    (+v).toFixed(f.dec ?? 1).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') + (f.unit || '');

  /* ══════════ 3.5 状态持久化 ══════════ */
  // 持久化:面板位置/折叠/当前 tab/重放开关/上次战斗/用户改过的数值(重进战斗或刷新页面后自动重放)
  const persisted = (() => {
    const s = safeParse(localStorage.getItem(LS_KEY));
    return s && typeof s === 'object' ? s : {};
  })();
  const userValues = new Map(
    Object.entries(persisted.values && typeof persisted.values === 'object' ? persisted.values : {})
      .filter(([, v]) => finite(v))
  );
  let replayEnabled = persisted.replay !== false; // 默认开启
  let autoNext = persisted.autoNext === true;     // 自动开始下一场战斗,默认关闭
  let autoPick = persisted.autoPick === true;     // 升级弹窗自动选技能,默认关闭
  let preferUpgrade = persisted.preferUpgrade === true; // 自动选技能时优先升级已有技能,默认关闭
  let preferHigh = persisted.preferHigh === true;   // 自动选技能时高级(等级高)优先,默认关闭
  let focusKeep = persisted.focusKeep !== false;  // 窗口失焦不暂停(反暂停补丁),默认开启
  // 上次战斗快照(主页数据是游客态不可靠,用它做参照)
  let lastBattle = persisted.lastBattle && finite(persisted.lastBattle.stage) ? persisted.lastBattle : null;
  // 引用后面才声明的 tab/panel,但只在事件回调里被调用,无 TDZ 问题
  function persist() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        tab,
        collapsed: panel.classList.contains('mk-collapsed'),
        pos: panel.style.left ? { left: panel.style.left, top: panel.style.top } : null,
        replay: replayEnabled,
        autoNext,
        autoPick,
        preferUpgrade,
        preferHigh,
        focusKeep,
        lastBattle,
        values: Object.fromEntries(userValues),
      }));
    } catch { /* localStorage 不可用时静默降级 */ }
  }

  /* ══════════ 4. 游戏桥接 ══════════ */
  let frameCache = null;
  function getFrame() {
    if (frameCache?.isConnected && (frameCache.src || '').includes(FRAME_KEYWORD)) return frameCache;
    frameCache = $$('iframe').find(f => (f.src || '').includes(FRAME_KEYWORD)) || null;
    return frameCache;
  }
  function getWin() {
    const f = getFrame();
    if (!f) return null;
    try {
      const w = f.contentWindow;
      return w && w.cc ? w : null;
    } catch { return null; } // 跨域时访问 contentWindow 属性会抛 SecurityError
  }
  function walk(w, fn, maxDepth) {
    const scene = w.cc.director.getScene();
    if (!scene) return null;
    return (function dive(node, depth) {
      if (depth > maxDepth) return null;
      const hit = fn(node);
      if (hit) return hit;
      for (const child of node.children || []) {
        const r = dive(child, depth + 1);
        if (r) return r;
      }
      return null;
    })(scene, 0);
  }
  function getDataModel() {
    const w = getWin();
    if (!w) return null;
    return walk(w, node => {
      for (const c of node.components || []) {
        if (c.require?.dataModel) return c.require.dataModel;
        if (c.fight && c.roles && c.prop && c.chip) return c;
        if (c.dataModel?.fight) return c.dataModel;
      }
      return null;
    }, 15);
  }
  function findFightComp(w) {
    return walk(w, node => {
      if (node.name !== 'fight') return null;
      for (const c of node.components || []) if (c.launchData) return c;
      return null;
    }, 10);
  }
  function ctx() {
    const w = getWin();
    if (!w) return null;
    const fc = findFightComp(w);
    if (!fc) return null;
    return { w, cc: w.cc, fc, ld: fc.launchData || {}, cfg: fc.launchData?.localPropDropConfig };
  }
  const ensureCfg = c => c.cfg || (c.cfg = c.ld.localPropDropConfig = {});

  // 主控组件(持有 gameApi / startHostGame,位于 Canvas 上,浅层即可命中)
  // 只用于读状态(session 活跃判断);开局不走它——走主页"出战"按钮的完整链路(见 tryAutoNext)
  function getAppComp() {
    const w = getWin();
    if (!w) return null;
    return walk(w, node =>
      (node.components || []).find(c => typeof c.startHostGame === 'function' && c.gameApi) || null, 3);
  }

  // 升级技能选择弹窗(fightUpLevel)的主组件:selectCard 与真实点击走同一条链路
  function getSkillChoiceComp() {
    const w = getWin();
    if (!w) return null;
    return walk(w, node => {
      if (node.name !== 'fightUpLevel' || !node.activeInHierarchy) return null;
      return (node.components || []).find(c =>
        typeof c.selectCard === 'function' && Array.isArray(c.cardItems)) || null;
    }, 6);
  }

  function readSkillMultipliers(c) {
    const raw = c?.fc.player?.data?.skillDamageMultipliers;
    if (!raw) return null;
    const m = typeof raw === 'string' ? safeParse(raw) : raw;
    return m && typeof m === 'object' ? m : null;
  }
  function applySkillMultiplier(c, name, value) {
    const data = c?.fc.player?.data;
    if (!data?.skillDamageMultipliers) return false;
    const wasString = typeof data.skillDamageMultipliers === 'string';
    const m = readSkillMultipliers(c);
    if (!m) return false;
    m[name] = value;
    data.skillDamageMultipliers = wasString ? JSON.stringify(m) : m;
    return true;
  }

  /* ══════════ 5. 字段注册表 ══════════ */
  const drop = (label, prop) => ({
    type: 'slider', label, min: 0, max: 100, step: 0.1, unit: '%', dec: 1,
    read: c => Math.round((c.cfg?.[prop] ?? 0) * 1000) / 10,
    apply: (v, c) => { ensureCfg(c)[prop] = v / 100; },
  });
  const enemy = (label, prop, max, step = 1) => ({
    type: 'slider', label, min: 0, max, step, unit: '', dec: 0,
    read: c => c.fc[prop] ?? 0,
    apply: (v, c) => { c.fc[prop] = v; },
  });

  const FIELDS = {
    gameSpeed: {
      type: 'slider', label: '⏱️ 速度倍率', min: 0.5, max: 10, step: 0.5, unit: 'x', dec: 1,
      read: c => c.cc.director.getScheduler().getTimeScale(),
      apply: (v, c) => c.cc.director.getScheduler().setTimeScale(v),
    },
    heroHP: {
      type: 'input', label: '❤️ 生命值 (HP)', unit: '', dec: 0, lockable: true, autoLock: true, quick: [666666],
      read: c => c.ld.hero?.hp ?? 0,
      apply: (v, c) => { if (c.ld.hero) c.ld.hero.hp = v; if (c.fc.player?.data) c.fc.player.data.HP = v; },
    },
    // ATK 不需要锁定:无 lockable / autoLock,只有输入框和快捷按钮
    heroATK: {
      type: 'input', label: '⚔️ 攻击力 (ATK)', unit: '', dec: 0, quick: [999],
      read: c => c.ld.hero?.attack ?? 0,
      apply: (v, c) => { if (c.ld.hero) c.ld.hero.attack = v; if (c.fc.player?.data) c.fc.player.data.ATK = v; },
    },
    critRate: {
      type: 'slider', label: '💥 暴击率', min: 0, max: 100, step: 1, unit: '%', dec: 0,
      read: c => Math.round((c.ld.hero?.criticalRatio ?? 0) * 100),
      apply: (v, c) => { if (c.ld.hero) c.ld.hero.criticalRatio = v / 100; if (c.fc.player?.data) c.fc.player.data.criticalRatio = v / 100; },
    },
    doubleDmg: {
      type: 'slider', label: '⚡ 双倍伤害率', min: 0, max: 100, step: 1, unit: '%', dec: 0,
      read: c => Math.round((c.ld.hero?.doubleDamageRatio ?? 0) * 100),
      apply: (v, c) => { if (c.ld.hero) c.ld.hero.doubleDamageRatio = v / 100; if (c.fc.player?.data) c.fc.player.data.doubleDamageRatio = v / 100; },
    },
    skillDmg: {
      type: 'slider', label: '✨ 技能伤害倍率', min: 1, max: 100, step: 1, unit: 'x', dec: 1,
      read: c => (c.ld.hero?.skillDamageBuff ?? 0) + 1,
      apply: (v, c) => { if (c.ld.hero) c.ld.hero.skillDamageBuff = v - 1; if (c.fc.player?.data) c.fc.player.data.skillDamageBuff = v - 1; },
    },
    fireDrop:   drop('🔥 火焰掉落率', 'fireDropProbability'),
    magnetDrop: drop('🧲 磁铁掉落率', 'magnetDropProbability'),
    healthDrop: drop('💊 血瓶掉落率', 'healthPotionDropProbability'),
    fireDmg: {
      type: 'slider', label: '🔥 火焰伤害倍率', min: 1, max: 100, step: 1, unit: 'x', dec: 1,
      read: c => c.cfg?.fireDamageMultiplier ?? 1,
      apply: (v, c) => { ensureCfg(c).fireDamageMultiplier = v; },
    },
    healPct: {
      // healthPotionMaxHpRecoveryRatio 是"按最大血量恢复的比例"(0.2 = 回 20%),按百分比展示
      type: 'slider', label: '💊 血瓶回血比例', min: 0, max: 100, step: 1, unit: '%', dec: 0,
      read: c => Math.round((c.cfg?.healthPotionMaxHpRecoveryRatio ?? 0) * 100),
      apply: (v, c) => { ensureCfg(c).healthPotionMaxHpRecoveryRatio = v / 100; },
    },
    maxEnemyBossNum:  enemy('👹 Boss上限', 'maxEnemyBossNum', 100),
    maxEnemyRangeNum: enemy('🏹 远程怪上限', 'maxEnemyRangeNum', 200),
    maxEnemyNearNum:  enemy('⚔️ 近战怪上限', 'maxEnemyNearNum', 200),
    maxPropNum:       enemy('🎁 掉落物上限', 'maxPropNum', 2000, 10),
  };

  const SECTIONS = [
    { title: '⏱️ 游戏速度', keys: ['gameSpeed'] },
    { title: '👤 角色属性', keys: ['heroHP', 'heroATK', 'critRate', 'doubleDmg', 'skillDmg'] },
    { title: '🎁 掉落物',   keys: ['fireDrop', 'magnetDrop', 'healthDrop', 'fireDmg', 'healPct'] },
  ];
  const ENEMY_KEYS = ['maxEnemyBossNum', 'maxEnemyRangeNum', 'maxEnemyNearNum', 'maxPropNum'];
  // 不在游戏 default 快照里、只能靠"清记忆+下场由服务器重发原值"恢复的字段
  const FORGET_KEYS = ['fireDrop', 'magnetDrop', 'healthDrop', 'fireDmg', 'healPct', ...ENEMY_KEYS];
  // 敌人配置字段不在这里显示(高级页可查看/设置),只保留只读的运行时信息
  const INFO_ROWS = [
    ['stage', '关卡', 'mk-v'],
    ['battleId', '战斗ID', 'mk-v--cyan'],
    ['timer', '战斗计时', 'mk-v--green'],
    ['killCount', '击杀数', 'mk-v--green'],
    ['goldCount', '本局金币', 'mk-v'],
    ['level', '局内等级', 'mk-v--purple'],
    ['progressionLevel', '角色进度等级', 'mk-v--purple'],
    ['skillType', '固有技能', 'mk-v--purple'],
    ['build', '当前构筑', 'mk-v'],
    ['revive', '🔄 复活次数(付费)', 'mk-v--orange', 1],
    ['clearSkill', '💫 清屏次数(付费)', 'mk-v--orange', 0],
  ];

  const resolveField = key => key.startsWith(SKILL_PREFIX)
    ? { type: 'slider', label: esc(key.slice(SKILL_PREFIX.length)), min: 0, max: 20, step: 0.5, unit: 'x', dec: 1 }
    : FIELDS[key];

  // skillType 是固有主动技能的类型 ID(如 4);经 serverSkillPresentationIndex 翻译成技能名,索引未就绪时回退为裸数字
  function skillTypeText(c) {
    const t = c.ld.hero?.skillType ?? 0;
    const idx = c.fc.serverSkillPresentationIndex;
    if (idx && typeof idx.entries === 'function') {
      for (const [, v] of idx.entries()) {
        if (v?.skillType === t && !v.isPassive && v.name) return `${v.name} (${t})`;
      }
    }
    return t;
  }

  // cocos Label 的文本(.string);节点未建好时回退空串
  const labelText = l => (l && typeof l.string === 'string' ? l.string : '');

  // 当前技能构筑:实时数据在 fc.serverActiveSkills/serverPassiveSkills(自带 skillName 中文名);
  // ld.activeSkills/passiveSkills 只是开局快照,不会随选卡更新,仅作兜底(经索引翻译)
  function buildText(c) {
    const idx = c.fc.serverSkillPresentationIndex;
    const nameOf = (t, l, p) => {
      if (idx && typeof idx.entries === 'function') {
        for (const [, v] of idx.entries()) {
          if (v?.skillType === t && v.level === l && !!v.isPassive === !!p && v.name) return v.name;
        }
      }
      return `技能${t}`;
    };
    const join = (list, p) => (list || []).map(s => `${s.skillName || nameOf(s.skillType, s.level, p)} Lv.${s.level}`).join('、');
    const live = c.fc.serverActiveSkills || c.fc.serverPassiveSkills;
    const actList = live ? c.fc.serverActiveSkills : c.ld.activeSkills;
    const pasList = live ? c.fc.serverPassiveSkills : c.ld.passiveSkills;
    const act = join(actList, false), pas = join(pasList, true);
    if (!act && !pas) return '无';
    return [act && `主动:${act}`, pas && `被动:${pas}`].filter(Boolean).join(' | ');
  }

  function readBattle(c) {
    return {
      stage: c.ld.stage ?? 0,
      battleId: c.ld.battleId ?? '',
      // 战斗计时优先取游戏内 Label("02:51");Label 未就绪时按 battleStartTime 折算分钟
      timer: labelText(c.fc.secondLabel)
        || (c.ld.battleStartTime ? `${Math.floor((Date.now() - c.ld.battleStartTime) / 60000)} 分钟` : ''),
      killCount: labelText(c.fc.killCountLabel),
      goldCount: labelText(c.fc.goldCountLabel),
      level: labelText(c.fc.levelLabel),
      revive: c.fc.leftReviveNum ?? 0,
      clearSkill: c.fc.leftClearSkillNum ?? 0,
      progressionLevel: c.ld.hero?.progressionLevel ?? 0,
      // skillType 是固有主动技能的类型 ID;经 serverSkillPresentationIndex(键 "type:level:isPassive")翻译成技能名
      skillType: skillTypeText(c),
      build: buildText(c),
      ui: Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, f.read(c)])),
    };
  }

  /* ══════════ 6. 视图构建 ══════════ */
  const infoText = (k, bd) => bd[k] ?? '';
  const infoBox = bd => `<div class="mk-info">${INFO_ROWS.map(([k, label, cls, sep]) =>
    `<div class="mk-info-row${sep ? ' mk-info-row--sep' : ''}">
      <span class="mk-k">${label}:</span><b class="${cls}" data-info="${k}">${esc(infoText(k, bd))}</b>
    </div>`).join('')}</div>`;

  // 🤖 自动化开关组:战斗模式显示在"自动"tab,主页模式(tab 栏隐藏)直接铺在主页上
  const autoTogglesHtml = () => `
    <div class="mk-section">⚔️ 战斗内</div>
    <label class="mk-toggle"><input type="checkbox" data-replay ${replayEnabled ? 'checked' : ''}> 进战斗自动重放已保存配置</label>
    <label class="mk-toggle"><input type="checkbox" data-autopick ${autoPick ? 'checked' : ''}> 🎯 升级弹窗自动选技能</label>
    <label class="mk-toggle" style="padding-left:18px;"><input type="checkbox" data-preferupgrade ${preferUpgrade ? 'checked' : ''}> ↳ 已有优先(已持有且未满级)</label>
    <label class="mk-toggle" style="padding-left:18px;"><input type="checkbox" data-preferhigh ${preferHigh ? 'checked' : ''}> ↳ 高级优先(等级高的先选)</label>
    <div class="mk-section">🏠 主页</div>
    <label class="mk-toggle"><input type="checkbox" data-autonext ${autoNext ? 'checked' : ''}> ⚔️ 自动开始下一场战斗</label>
    <div class="mk-section">🖥️ 环境</div>
    <label class="mk-toggle"><input type="checkbox" data-focuskeep ${focusKeep ? 'checked' : ''}> 🔆 防后台暂停(切tab/遮挡;失焦拦截为预防)</label>`;

  const AUTO_NOTE = '<div class="mk-note">挂机链路:自动开战 → 重放配置 → 自动选技能 → 打完自动点"收下"收结算回主页循环。折叠面板后自动化照常生效。<br>说明:实测游戏目前<b>没有失焦暂停机制</b>,失焦(blur)拦截是预防游戏将来加上的;实际生效的是切 tab/遮挡时的 visibility 欺骗。<br>注意:窗口被<b>最小化或被最大化窗口完全遮挡</b>时浏览器会强制停帧,反暂停救不了。可在 edge://flags 关闭 "Calculate window occlusion"(需重启浏览器)彻底解除遮挡停帧。</div>';

  const autoHtml = () => `<div class="mk-status mk-status--adv">🤖 自动化</div>
    ${autoTogglesHtml()}
    ${AUTO_NOTE}`;

  // 技能倍率的键是英文运行时名(fireBall 等)。实测倍率表、activeSkillRuntimeTokens、serverActiveSkills
  // 三者同序(都按获得顺序追加)——按键序对齐翻译中文名,不硬编码映射表;
  // 用 tokens 过滤掉重放残留的"本场未持有"幽灵键;长度对不齐时回退英文键,绝不猜
  function skillKeyLabel(c, key) {
    const multi = readSkillMultipliers(c);
    const keys = multi ? Object.keys(multi) : [];
    const server = c?.fc.serverActiveSkills || [];
    const tok = c?.fc.activeSkillRuntimeTokens;
    const owned = tok && typeof tok.has === 'function' ? keys.filter(k => tok.has(k)) : keys;
    if (owned.length && owned.length === server.length) {
      const i = owned.indexOf(key);
      if (i >= 0 && server[i]?.skillName) return server[i].skillName;
    }
    return key;
  }

  function fieldRow(key, uiVal, label) {
    const f = resolveField(key);
    const text = label || f.label;
    if (f.type === 'slider') {
      return `<div class="mk-row">
        <div class="mk-row-head"><span>${text}</span><span class="mk-val" data-val="${key}">${fmt(f, uiVal)}</span></div>
        <input class="mk-range" type="range" data-key="${key}" min="${f.min}" max="${f.max}" step="${f.step}" value="${uiVal}">
      </div>`;
    }
    const locked = locks.has(key);
    return `<div class="mk-row">
      <div class="mk-row-head">
        <span>${text}</span>
        ${f.lockable ? `<button class="mk-lock${locked ? ' on' : ''}" data-lock="${key}">${locked ? '🔒 已锁定' : '🔓 未锁定'}</button>` : ''}
      </div>
      <input class="mk-input" type="number" data-key="${key}" value="${uiVal}" placeholder="${text}">
      ${f.quick?.length ? `<div class="mk-quick">${f.quick.map(q => `<button data-quick="${key}" data-val="${q}">${q}</button>`).join('')}</div>` : ''}
    </div>`;
  }

  const SPEED_WARN = '<div class="mk-note mk-note--warn">⚠️ 高危:加速会让客户端时间跑赢服务器——捡特殊宝箱、通关结算这类校验点会被踢回主页(碎片和金币仍保留)。刷碎片可用,正常冲关请勿开启!(加速不参与自动重放,每场需手动开)</div>';

  // 信息 tab:战斗模式的默认首页,集中展示只读运行时信息
  const infoHtml = bd => `<div class="mk-status mk-status--battle">📋 战斗信息(实时)</div>
    ${infoBox(bd)}`;

  const battleHtml = bd => `<div class="mk-status mk-status--battle">⚔️ 战斗模式（修改立即生效）</div>
    ${SECTIONS.map(s => `<div class="mk-section">${s.title}</div>${s.keys.map(k => fieldRow(k, bd.ui[k])).join('')}${s.keys.includes('gameSpeed') ? SPEED_WARN : ''}`).join('')}`;

  function readDefaults(c) {
    const d = safeParse(c.fc.player?.data?.default);
    return d && typeof d === 'object' ? d : null;
  }
  function defaultsHtml(c) {
    const d = readDefaults(c);
    if (!d) return '<span style="color:#666">无数据</span>';
    const rows = Object.entries(d)
      .filter(([, v]) => typeof v === 'number')
      .map(([k, v]) => `<div class="mk-defaults-row"><span>${esc(k)}:</span><b class="mk-v">${v}</b></div>`);
    return rows.join('') || '<span style="color:#666">无数据</span>';
  }

  function advancedHtml(c, bd) {
    const multi = readSkillMultipliers(c);
    const names = multi ? Object.keys(multi) : [];
    const hasDefaults = !!readDefaults(c);
    const forgettable = FORGET_KEYS.some(k => userValues.has(k));
    return `<div class="mk-status mk-status--adv">⚙️ 高级配置</div>
      ${names.length
        ? `<div class="mk-section">🎯 技能倍率 (${names.length}个)</div>${names.map(n => fieldRow(SKILL_PREFIX + n, multi[n], skillKeyLabel(c, n))).join('')}`
        : `<div class="mk-empty">⚠️ 未检测到技能<br><small>战斗中获取技能后会显示</small></div>`}
      <div class="mk-section">👹 敌人配置</div>
      ${ENEMY_KEYS.map(k => fieldRow(k, bd.ui[k])).join('')}
      <div class="mk-section">📊 基础属性原始值</div>
      <div class="mk-defaults" id="mk-defaults">${defaultsHtml(c)}</div>
      ${hasDefaults || forgettable ? `<div class="mk-quick">
        ${hasDefaults ? '<button data-restore>↩️ 恢复默认属性(含技能倍率)</button>' : ''}
        ${forgettable ? '<button data-forget title="清除掉落率/火焰伤害/血瓶回血/敌人上限的已保存记忆,下一场战斗起恢复游戏原值(本场已改的不会复原)">🧹 清除掉落/敌人记忆</button>' : ''}
      </div>` : ''}`;
  }

  function readHome() {
    const dm = getDataModel();
    if (!dm) return null;
    const roleVals = Object.values(dm.chip?.role || {});
    const skills = Object.entries(dm.chip?.skill || {}).filter(([, v]) => v > 0);
    return {
      fightLevel: dm.fight?.level,
      gold: dm.prop?.gold,
      isGuest: !!dm.player?.isGuest,
      roles: (dm.roles || []).map(r => ({ asset: r.asset, HP: r.HPLevel, ATK: r.ATKLevel, selected: r.selected })),
      chipRoles: `${roleVals.filter(v => v > 0).length}/${roleVals.length}`,
      chipSkills: skills.map(([k, v]) => `${k}:${v}`).join(',') || '无',
    };
  }

  function homeHtml(data) {
    const roles = (data.roles || []).map((r, i) =>
      `<div class="mk-note">角色${i + 1}(资产${r.asset}): HP Lv.<b style="color:#4caf50">${r.HP}</b> ATK Lv.<b style="color:#f44336">${r.ATK}</b>${r.selected ? ' <span style="color:#ffd700">★</span>' : ''}</div>`).join('');
    return `<div class="mk-status mk-status--home">🏠 主页模式（数据显示，修改会被服务器覆盖）</div>
      ${data.isGuest ? '<div class="mk-note mk-note--warn">⚠️ 游客模式:主页数据未绑定账号,关卡/金币等可能与你的真实进度不符</div>' : ''}
      ${lastBattle ? `<div class="mk-note">🕘 上次战斗: 第 <b class="mk-v">${lastBattle.stage}</b> 关 · ${new Date(lastBattle.ts).toLocaleTimeString()}</div>` : ''}
      <div class="mk-section">📊 当前数据</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px;">
        <span class="mk-chip">关卡: <b class="mk-v">${data.fightLevel}</b></span>
        <span class="mk-chip">金币: <b class="mk-v">${data.gold}</b></span>
      </div>
      <div style="margin-bottom:6px;"><span class="mk-chip">芯片: <b style="color:#00e5ff">${data.chipRoles}</b></span></div>
      ${roles}
      ${data.chipSkills !== '无' ? `<div class="mk-note">技能: ${esc(data.chipSkills)}</div>` : ''}
      <div class="mk-section">🤖 自动化</div>
      ${autoTogglesHtml()}
      <div style="margin-top:10px;padding:8px;background:#1b5e20;border-radius:6px;font-size:11px;color:#fff;text-align:center;">⚔️ 进入战斗后可修改参数</div>`;
  }

  /* ══════════ 7. 面板骨架、状态与渲染 ══════════ */
  const panel = document.createElement('div');
  panel.id = 'magic-knight-modifier';
  panel.innerHTML = `
    <div id="mk-header"><span>⚔️ 魔法骑士 v3.9.13</span><span id="mk-collapse" title="折叠/展开">▾</span></div>
    <div id="mk-tabs" style="display:none">
      <button class="mk-tab active" data-tab="info">📋 信息</button>
      <button class="mk-tab" data-tab="basic">📊 基础</button>
      <button class="mk-tab" data-tab="advanced">⚙️ 高级</button>
      <button class="mk-tab" data-tab="auto">🤖 自动</button>
    </div>
    <div id="mk-body"></div>`;
  document.body.appendChild(panel);

  const body = $('#mk-body', panel);
  const tabsEl = $('#mk-tabs', panel);
  const collapseBtn = $('#mk-collapse', panel);
  let tab = ['info', 'basic', 'advanced', 'auto'].includes(persisted.tab) ? persisted.tab : 'info';
  const locks = new Map();      // key → 锁定值(现在只会出现 heroHP)
  let els = null;
  let lastInBattle = null;
  let lastHomeSig = null;       // 主页数据签名,变化才重渲染
  let battleSnap = null;        // 战斗中的最新快照,退出时存入 lastBattle

  // 恢复上次的面板状态(位置带视口钳制,防止窗口变小后面板跑到屏幕外)
  if (persisted.pos) {
    const left = parseInt(persisted.pos.left), top = parseInt(persisted.pos.top);
    if (finite(left) && finite(top) && left >= 0 && left < innerWidth - 40 && top >= 0 && top < innerHeight - 40) {
      panel.style.left = left + 'px';
      panel.style.top = top + 'px';
      panel.style.right = 'auto';
    }
  }
  if (persisted.collapsed) {
    panel.classList.add('mk-collapsed');
    collapseBtn.textContent = '▸';
  }
  $$('.mk-tab', panel).forEach(b => b.classList.toggle('active', b.dataset.tab === tab));

  function cacheEls() {
    els = {
      vals:   new Map($$('.mk-val[data-val]', body).map(e => [e.dataset.val, e])),
      fields: new Map($$('[data-key]', body).map(e => [e.dataset.key, e])),
      infos:  new Map($$('[data-info]', body).map(e => [e.dataset.info, e])),
      // 技能签名:名称列表变化(数量不变但换了技能)也能触发重渲染
      skillSig: $$(`[data-key^="${SKILL_PREFIX}"]`, body).map(e => e.dataset.key).join(','),
    };
  }

  function render() {
    els = null;
    const data = readHome();
    if (!data) { body.innerHTML = '<div class="mk-error">等待游戏数据加载...</div>'; return; }

    const c = ctx();
    // tab 栏只在战斗模式有意义(主页 tab 渲染内容相同),主页时隐藏
    tabsEl.style.display = c ? '' : 'none';
    if (c) {
      const bd = readBattle(c);
      body.innerHTML = tab === 'auto' ? autoHtml() : tab === 'advanced' ? advancedHtml(c, bd) : tab === 'basic' ? battleHtml(bd) : infoHtml(bd);
      cacheEls();
      return;
    }
    body.innerHTML = homeHtml(data);
  }

  /* ══════════ 8. 修改、锁定与恢复默认 ══════════ */
  function applyField(key, v, c) {
    if (!finite(v)) return false;
    c = c || ctx();
    if (!c) return false;
    if (key.startsWith(SKILL_PREFIX)) return applySkillMultiplier(c, key.slice(SKILL_PREFIX.length), v);
    const f = FIELDS[key];
    if (!f) return false;
    f.apply(v, c);
    if (f.autoLock) {           // 只有 heroHP 配置了 autoLock
      locks.set(key, v);
      refreshLockUI(key);
    }
    return true;
  }

  // 用户主动修改:应用 + 记忆(重进战斗/刷新页面后自动重放)
  function applyUserValue(key, v) {
    if (applyField(key, v)) { userValues.set(key, v); persist(); }
  }

  function refreshLockUI(key) {
    const btn = body.querySelector(`[data-lock="${key}"]`);
    if (!btn) return;
    const on = locks.has(key);
    btn.classList.toggle('on', on);
    btn.textContent = on ? '🔒 已锁定' : '🔓 未锁定';
  }

  // default 键 → ld.hero 键 的映射(调查报告已确认键名一一对应)
  const DEFAULT_TO_HERO = { HP: 'hp', ATK: 'attack', criticalRatio: 'criticalRatio', doubleDamageRatio: 'doubleDamageRatio', skillDamageBuff: 'skillDamageBuff' };

  function restoreDefaults() {
    const c = ctx();
    if (!c) return;
    const d = readDefaults(c);
    const pd = c.fc.player?.data;
    if (!d || !pd) return;
    for (const [dk, hk] of Object.entries(DEFAULT_TO_HERO)) {
      if (!finite(d[dk])) continue;
      pd[dk] = d[dk];
      if (c.ld.hero) c.ld.hero[hk] = d[dk];
    }
    const snapMulti0 = d.skillDamageMultipliers;
    const snapMulti = typeof snapMulti0 === 'string' ? safeParse(snapMulti0) : snapMulti0;
    if (snapMulti && typeof snapMulti === 'object') {
      const restored = { ...snapMulti };
      // 开局后新获得的技能不在 default 快照里,直接用快照覆盖会把它们的倍率条目抹掉
      // (伤害计算读不到条目就回退基础伤害,可能低于设计值)。
      // 按 v3.9.11 的同序对齐找到 skillType+当前等级,用游戏自己的公式 resolveActiveSkillDamageMultiplier 补算原始倍率
      const cur = readSkillMultipliers(c) || {};
      const keys = Object.keys(cur);
      const server = c.fc.serverActiveSkills || [];
      const tok = c.fc.activeSkillRuntimeTokens;
      const owned = tok && typeof tok.has === 'function' ? keys.filter(k => tok.has(k)) : keys;
      const aligned = owned.length > 0 && owned.length === server.length;
      for (const k of keys) {
        if (k in restored) continue;
        const s = aligned ? server[owned.indexOf(k)] : null;
        const orig = s && typeof c.fc.resolveActiveSkillDamageMultiplier === 'function'
          ? c.fc.resolveActiveSkillDamageMultiplier(s.skillType, s.level || 1) : null;
        if (finite(orig) && orig > 0) restored[k] = orig;
        // 无法对齐/补算的键直接丢弃,与旧行为一致(回到游戏缺省)
      }
      pd.skillDamageMultipliers = typeof pd.skillDamageMultipliers === 'string'
        ? JSON.stringify(restored) : restored;
    }
    // 清掉相关记忆与锁定,否则自动重放/锁定会立刻把恢复的值再改回去
    for (const k of [...userValues.keys()]) if (k.startsWith(SKILL_PREFIX)) userValues.delete(k);
    for (const k of ['heroHP', 'heroATK', 'critRate', 'doubleDmg', 'skillDmg']) userValues.delete(k);
    locks.clear();
    persist();
    render();
  }

  // 掉落率/火焰伤害/血瓶回血/敌人上限不在 default 快照里,无法就地"恢复原值";
  // 但它们每场开局由服务器随 launchData 重新下发——清掉记忆、不再重放,下一场即回到游戏原值。
  // 本场已改动的值无法复原,在下一场生效(按钮 title 已注明)
  function forgetExtras() {
    for (const k of FORGET_KEYS) userValues.delete(k);
    persist();
    render();
  }

  /* ══════════ 9. 事件委托 ══════════ */
  // 修正:tab 按钮在 #mk-body 外面,委托必须挂在 panel 上才能收到冒泡
  panel.addEventListener('click', e => {
    const tabBtn = e.target.closest('[data-tab]');
    if (!tabBtn) return;
    tab = tabBtn.dataset.tab;
    $$('.mk-tab', panel).forEach(b => b.classList.toggle('active', b === tabBtn));
    persist();
    render();
  });

  // body 内控件(lock/quick/retry/restore)的委托
  body.addEventListener('click', e => {
    const lock = e.target.closest('[data-lock]');
    if (lock) {
      const key = lock.dataset.lock;
      if (locks.has(key)) locks.delete(key);
      else {
        const v = parseFloat(els?.fields.get(key)?.value);
        if (finite(v)) locks.set(key, v);
      }
      return refreshLockUI(key);
    }
    const quick = e.target.closest('[data-quick]');
    if (quick) {
      const key = quick.dataset.quick, v = parseFloat(quick.dataset.val);
      const input = els?.fields.get(key);
      if (input) input.value = v;
      applyUserValue(key, v);
      return refreshLockUI(key); // ATK 无锁按钮,内部有 null 检查,安全
    }
    if (e.target.closest('[data-restore]')) return restoreDefaults();
    if (e.target.closest('[data-forget]')) return forgetExtras();
    if (e.target.closest('[data-retry]')) return boot();
  });

  body.addEventListener('input', e => {
    const t = e.target;
    if (t.type !== 'range' || !t.dataset.key) return;
    const key = t.dataset.key, f = resolveField(key), v = parseFloat(t.value);
    const span = els?.vals.get(key);
    if (span && finite(v)) span.textContent = fmt(f, v);
    applyUserValue(key, v);
  });
  body.addEventListener('change', e => {
    const t = e.target;
    if (t.matches('[data-replay]')) { replayEnabled = t.checked; return persist(); }
    if (t.matches('[data-autonext]')) { autoNext = t.checked; return persist(); }
    if (t.matches('[data-autopick]')) { autoPick = t.checked; return persist(); }
    if (t.matches('[data-preferupgrade]')) { preferUpgrade = t.checked; return persist(); }
    if (t.matches('[data-preferhigh]')) { preferHigh = t.checked; return persist(); }
    if (t.matches('[data-focuskeep]')) { focusKeep = t.checked; return persist(); }
    if (t.type === 'number' && t.dataset.key) applyUserValue(t.dataset.key, parseFloat(t.value));
  });

  /* ══════════ 10. 拖动与折叠 ══════════ */
  collapseBtn.addEventListener('click', () => {
    const collapsed = panel.classList.toggle('mk-collapsed');
    collapseBtn.textContent = collapsed ? '▸' : '▾';
    persist();
  });
  let drag = null;
  $('#mk-header', panel).addEventListener('mousedown', e => {
    if (e.target.id === 'mk-collapse') return;
    drag = { x: e.clientX - panel.offsetLeft, y: e.clientY - panel.offsetTop };
  });
  document.addEventListener('mousemove', e => {
    if (!drag) return;
    panel.style.left = (e.clientX - drag.x) + 'px';
    panel.style.top = (e.clientY - drag.y) + 'px';
    panel.style.right = 'auto';
  });
  document.addEventListener('mouseup', () => {
    if (!drag) return;
    drag = null;
    persist(); // 拖动结束才写 localStorage,避免 mousemove 期间高频写入
  });

  /* ══════════ 11. 启动与主循环 ══════════ */
  let bootTimer = null, tickTimer = null;

  function boot() {
    clearInterval(bootTimer);
    body.innerHTML = '<div class="mk-error">等待游戏加载...<br><small>请确保已打开直播间小游戏面板</small></div>';
    const t0 = Date.now();
    bootTimer = setInterval(() => {
      if (getFrame()) {
        clearInterval(bootTimer);
        setTimeout(() => { render(); startTick(); }, 2500);
      } else if (Date.now() - t0 > MAX_WAIT) {
        clearInterval(bootTimer);
        body.innerHTML = '<div class="mk-error">❌ 未检测到游戏<br><a href="javascript:void(0)" data-retry style="color:#ffd700;">点我重新检测</a></div>';
      }
    }, 500);
  }

  function startTick() {
    clearInterval(tickTimer);
    tickTimer = setInterval(tick, TICK_MS);
  }

  // 主页数据可能异步更新,用签名检测变化,避免每 tick 重渲染
  function homeSignature() {
    const dm = getDataModel();
    if (!dm) return '';
    return JSON.stringify([dm.fight?.level, dm.prop?.gold, dm.player?.isGuest, dm.chip?.role, dm.chip?.skill,
      (dm.roles || []).map(r => [r.asset, r.HPLevel, r.ATKLevel, r.selected])]);
  }

  // 自动开战节流:进入主页后有个宽限期,之后每 8s 最多尝试一次
  const AUTO_NEXT_GRACE_MS = 6000;
  const AUTO_NEXT_RETRY_MS = 8000;
  let lastAutoStartTry = 0;

  // 对局 session 仍活跃 = 结算/上报未完成,此时 startHostGame 会把上一局打断成"通关失败"
  function hasActiveBattleSession(app) {
    try { return !!app.gameApi?.session?.getActive(); } catch { return false; } // 无活跃对局时会 throw
  }
  // 有活跃弹窗(复活/结算/错误框等) = 不是真正的空闲主页
  function hasBlockingPopup() {
    const w = getWin();
    if (!w) return false;
    return !!walk(w, node =>
      node.name === 'popupParent' && (node.children || []).some(ch => ch.activeInHierarchy) ? true : null, 4);
  }

  // 通关/失败结算页(fightStop)不会自己关:不调"收下"的 collectBtnEvent,session 一直活跃、
  // fight 组件也在(面板仍是战斗模式),闸门1/2 永远挡着,自动下一关就死在结算页。
  // 这里代点"收下"——只碰 fightStop 的 collectBtnEvent(自带 isActionLocked 去重,奖励服务器已发,纯关闭动作);
  // 复活等付费弹窗结构不同、不会命中,绝不误触。
  function tryAutoCollect() {
    if (!autoNext) return;
    const w = getWin();
    if (!w) return;
    const fs = walk(w, node => node.name === 'fightStop' && node.activeInHierarchy ? node : null, 5);
    if (!fs) return;
    const comp = (fs.components || []).find(c => typeof c.collectBtnEvent === 'function');
    if (!comp || comp.isActionLocked) return; // 已点过/退场动画中,等它自己关
    const collectBtn = (function dive(n) {
      if (n.name === 'collectButton' && n.activeInHierarchy) return n;
      for (const ch of n.children || []) { const r = dive(ch); if (r) return r; }
      return null;
    })(fs);
    if (!collectBtn) return; // 没有领取按钮的形态留给用户手动
    try { comp.collectBtnEvent(); } catch (err) { console.warn('[魔法骑士] 自动收结算失败', err); }
  }

  // 自动开战的正确入口是主页(React 层)的"出战"按钮 <button data-type="game">(文案"免费"或银币价格):
  // 它走 handleStart → useGame.onStart → gameModule.onStart(bootstrap, 生命周期回调) 的完整链路,
  // 既带新鲜宿主配置,又会驱动 React 层把主页遮盖切到 playing 态隐藏。
  // 直接调 Cocos 层 startHostGame 的教训(v3.9.4):能开局但 React 主页不知道,主页一直盖住战斗画面。
  function clickHomeStartButton() {
    const f = getFrame();
    if (!f) return false;
    let doc;
    try { doc = f.contentDocument; } catch { return false; }
    const btn = doc?.querySelector('button[data-type="game"]');
    if (!btn) return false;              // 主页 React 未挂载(停在任务/天梯等 tab)时等下周期
    if (btn.disabled) return true;       // 正在进入游戏(isLaunching),当作已触发
    btn.click();
    return true;
  }

  function tryAutoNext() {
    if (!autoNext) return;
    const now = Date.now();
    if (now - lastAutoStartTry < AUTO_NEXT_RETRY_MS) return;
    const app = getAppComp();
    if (!app || app.hostStartPromise) return; // 开局进行中,交给游戏自身去重
    if (hasActiveBattleSession(app)) return;  // 闸门1:上一局未结算完,等下个周期
    if (hasBlockingPopup()) return;           // 闸门2:弹窗未关,等下个周期
    if (clickHomeStartButton()) lastAutoStartTry = now; // 没找到按钮不消耗节流,下拍继续找
  }

  // 自动选技能:弹窗打开后稳定 800ms 再选,选择中(isSelectionLocked)不重复触发;
  // 选了但弹窗没关则轮换下一张卡兜底;玩家 3 秒内有点屏则不出手(避免手动/脚本抢点把弹窗状态机卡死)。
  // 弹窗有两种:exp=升级三选一,box=宝箱技能三选一(捡技能宝箱后服务器发 csList 弹出,selectCard 同链路)
  const AUTO_PICK_DELAY_MS = 800;
  const AUTO_PICK_MIN_INTERVAL = 1500;
  const MANUAL_INPUT_GRACE_MS = 3000;
  let popupFirstSeenAt = 0, lastAutoPickAt = 0, lastTriedCardIdx = -1;
  let lastManualInputAt = 0;

  // 监听游戏 iframe 内的手动点屏(同源,一次性挂接)
  function hookManualInput() {
    const f = getFrame();
    if (!f) return;
    try {
      const d = f.contentDocument;
      if (!d || d.__mkInputHooked) return;
      d.__mkInputHooked = true;
      ['pointerdown', 'touchstart'].forEach(t =>
        d.addEventListener(t, () => { lastManualInputAt = Date.now(); }, true));
    } catch { /* 跨域或文档未就绪时下个 tick 再试 */ }
  }

  // "优先升级"的排序依据:已持有(level>0)且未满级(max 为 0 表示无上限)
  const isOwnedUpgradable = d => d?.level > 0 && (!d.max || d.level < d.max);

  function tryAutoPickSkill() {
    if (!autoPick) { popupFirstSeenAt = 0; lastTriedCardIdx = -1; return; }
    const comp = getSkillChoiceComp();
    if (!comp) { popupFirstSeenAt = 0; lastTriedCardIdx = -1; return; }
    const now = Date.now();
    if (now - lastManualInputAt < MANUAL_INPUT_GRACE_MS) return; // 玩家在操作,让位
    if (!popupFirstSeenAt) { popupFirstSeenAt = now; lastTriedCardIdx = -1; return; }
    if (now - popupFirstSeenAt < AUTO_PICK_DELAY_MS) return;
    if (now - lastAutoPickAt < AUTO_PICK_MIN_INTERVAL) return;
    if (comp.isSelectionLocked || !['exp', 'box'].includes(comp.type) || !comp.cardItems.length) return;
    // 偏好可组合:已有优先 = 已持有且未满级排前;高级优先 = 同组内等级高的排前;都不开则保持游戏原顺序
    let order = comp.cardItems;
    if (preferUpgrade || preferHigh) {
      const rank = d => [
        preferUpgrade && isOwnedUpgradable(d) ? 1 : 0,
        preferHigh ? (d?.level ?? 0) : 0,
      ];
      order = [...comp.cardItems].sort((a, b) => {
        const ra = rank(a.data), rb = rank(b.data);
        return rb[0] - ra[0] || rb[1] - ra[1];
      });
    }
    lastTriedCardIdx = (lastTriedCardIdx + 1) % order.length;
    const item = order[lastTriedCardIdx];
    if (!item?.data) return;
    lastAutoPickAt = now;
    console.info('[魔法骑士] 自动选择技能:', item.data?.name ?? `卡${item.index}`, item.data);
    try {
      comp.selectCard(item); // 与真实点击同一入口,内部走动画/锁定/skillChoose 请求
    } catch (err) {
      console.warn('[魔法骑士] 自动选技能失败', err);
    }
  }

  function tick() {
    const c = ctx();
    const inBattle = !!c;

    if (inBattle !== lastInBattle) {
      const wasInBattle = lastInBattle;
      lastInBattle = inBattle;
      if (!inBattle) {
        locks.clear();
        const w = getWin();
        if (w) w.cc.director.getScheduler().setTimeScale(1);
        if (wasInBattle && battleSnap) {  // 战斗→主页:留存上次战斗快照
          lastBattle = battleSnap;
          battleSnap = null;
          persist();
        }
        lastHomeSig = null;               // 强制主页重渲染
        lastAutoStartTry = Date.now() - AUTO_NEXT_RETRY_MS + AUTO_NEXT_GRACE_MS; // 宽限期后再首次尝试
      } else if (replayEnabled) {
        // 进入战斗:重放用户记住的配置(HP 会因 autoLock 重新上锁);开关关闭则本场保持游戏原值
        // gameSpeed 是高危功能(服务器时间校验),不参与自动重放,每场需手动开启
        for (const [k, v] of userValues) {
          if (k === 'gameSpeed') continue;
          applyField(k, v, c);
        }
      }
      return render();
    }
    if (!inBattle) {
      // 主页模式:数据签名变化才重渲染(旧版此处直接 return,数据更新后面板永远不变)
      if (!panel.classList.contains('mk-collapsed')) {
        const sig = homeSignature();
        if (sig !== lastHomeSig) { lastHomeSig = sig; render(); }
      }
      tryAutoCollect(); // 结算页在主页分支也可能出现(场景交替瞬间),先收再判
      tryAutoNext(); // 折叠时也生效:自动开战不依赖界面
      return;
    }
    // els 为空说明上次 render 时数据未就绪(场景重建等),每拍重试直到渲染成功
    if (!els) { render(); return; }

    hookManualInput(); // 挂接一次游戏 iframe 的点屏监听,供自动选卡让位判断
    for (const [k, v] of locks) FIELDS[k]?.apply(v, c);

    battleSnap = { stage: c.ld.stage ?? 0, ts: Date.now() };

    // 自动收结算要在选卡之前:结算页仍是战斗模式(fight/session 未拆),不收就永远卡在这
    tryAutoCollect();

    // 自动选技能放在折叠检查之前:折叠时也照常生效
    tryAutoPickSkill();

    // 折叠时只维持锁定/倍速生效,跳过所有 DOM 刷新
    if (panel.classList.contains('mk-collapsed')) return;

    const bd = readBattle(c);

    for (const [k] of INFO_ROWS) {
      const el = els.infos.get(k);
      if (el) el.textContent = infoText(k, bd);
    }

    if (tab === 'advanced') {
      const multi = readSkillMultipliers(c);
      const names = multi ? Object.keys(multi) : [];
      if (names.map(n => SKILL_PREFIX + n).join(',') !== els.skillSig) return render();
      for (const n of names) {
        if (!finite(multi[n])) continue;
        const slider = els.fields.get(SKILL_PREFIX + n);
        // 中文名晚于首次渲染就绪时(presentation 异步挂上),label 还是英文键 → 触发一次重渲染
        const labelEl = slider?.closest('.mk-row')?.querySelector('.mk-row-head span');
        if (labelEl && labelEl.textContent !== skillKeyLabel(c, n)) return render();
        if (slider && document.activeElement !== slider) {
          slider.value = multi[n];
          const span = els.vals.get(SKILL_PREFIX + n);
          if (span) span.textContent = fmt(resolveField(SKILL_PREFIX + n), multi[n]);
        }
      }
      const box = $('#mk-defaults', body);
      if (box) box.innerHTML = defaultsHtml(c);
    }

    for (const [key, input] of els.fields) {
      if (key.startsWith(SKILL_PREFIX)) continue;
      const ui = bd.ui[key];
      if (ui === undefined || document.activeElement === input) continue;
      input.value = ui;
      const span = els.vals.get(key);
      if (span) span.textContent = fmt(resolveField(key), ui);
    }
  }

  boot();
})();
