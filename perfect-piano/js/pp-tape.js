/* ============================================================
 * 纸带钢琴打孔程序 - 纸带数据模型与 MIDI 转换管线
 *
 * 机械模型（依据 纸带钢琴.txt + 实物图片说明）：
 *  - 双排键盘各 14 白键；换挡键（◀◀/▶▶）每次移动 14 白键（2 个八度），
 *    换挡耗时 400ms（按下换挡键 → 键盘滑动到位）；到位前该排仍按旧挡击发
 *  - 档位表 GEAR_STARTS：键盘为 88 键（A0..C8，白键序 -23..28）。档位 xx = 该排
 *    14 白键窗口的最左键是 xx 键：A0(A0..G2) → A2(A2..G4) → A4(A4..G6) → D6(D6..C8，
 *    顶端机械限位，最后一步仅滑 10 白键)。初始档位 A0（键盘底端机械限位）。
 *    曲首「强制归位」：连按 3 次 ◀ 钉底到 A0（已在底端时为空按，机械限位天然吸收）
 *  - 上排弹和弦、下排弹主旋律；每个按键/换挡键 = 1 滚轮 + 拨片，纸带驱动
 *  - 纸带自下而上走带；两排滚轮上下排列（沿走带方向相距 105mm），
 *    纸带先穿上排（和弦）站，再穿下排（主旋律）站
 *  - 每排 16 轮（◀◀ + 14 白键 + ▶▶），同排轮心距 8mm（轮缘间隙 4mm），
 *    上下两排错开 4mm → 合并为 4mm 步进的交错轨格，合并轨带恰好占满 150mm 带宽
 *  - 同一拍的上下排孔在带长方向相距 105mm：主旋律孔比和弦孔靠带尾 105mm
 * ============================================================ */
(function (global) {
  'use strict';

  // ---- 键盘布局 ----
  // 每排 16 轨：轨 0 = 换挡键 ◀◀（降 14 白键），轨 1..14 = 白键（基础窗口 C4..B5），轨 15 = 换挡键 ▶▶（升 14 白键）
  var LANES_PER_ROW = 16;
  var WHITE_PC = [0, 2, 4, 5, 7, 9, 11];
  var WHITE_LETTER = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
  // 八度内音级 → 白键序（黑键为 null）
  var WPC = [];
  for (var wi = 0; wi < 12; wi++) WPC.push(null);
  WPC[0] = 0; WPC[2] = 1; WPC[4] = 2; WPC[5] = 3; WPC[7] = 4; WPC[9] = 5; WPC[11] = 6;

  // ---- 物理规格（mm，可调常量）----
  var PHYS = {
    tapeWidthMM: 150,     // 纸带总宽
    marginMM: 13,         // 两侧留边 = (150 - 124) / 2
    lanePitchMM: 8,       // 同排轨心距（轮径约 4 + 轮缘间隙 4）
    rowStaggerMM: 4,      // 上下排轨心错位（合并栅格 4mm）
    lowerX0MM: 13,        // 下排轨 0 轨心 x = 13 + 8k → 13..133
    upperX0MM: 17,        // 上排轨 0 轨心 x = 17 + 8k → 17..137
    holeRadiusMM: 1.2,    // 孔半径
    leadInMM: 15,         // 头部留白
    leadOutMM: 15,        // 尾部留白
    mmPerBeat: 9,         // 每拍走带长度
    minGapMM: 4.5,        // 同轨相邻两孔最小孔距
    stationGapMM: 105,    // 两排滚轮沿走带方向间距
    shiftMs: 400,         // 换挡耗时：按下换挡键 → 键盘滑动到位
    shiftLeadMs: 600      // 打孔提前量 = 400ms 换挡 + 200ms 余量（孔位量化 + 机械响应）
  };
  var PPB = 4; // 每拍编辑栅格数（col），1 col = 2.25mm

  // ---- 档位表（白键序，C4=0 体系）：档位 xx = 该排 14 白键窗口的最左键是 xx 键 ----
  // A0=-23、A2=-9、A4=5（相邻档差 14 白键=2 八度）；D6=15（顶端机械限位，仅滑 10 白键到 C8=28）
  var GEAR_STARTS = [-23, -9, 5, 15];
  var W_MAX = GEAR_STARTS.length - 1; // 最高档位 D6

  // ---- 白键序号（C4 = 0，向两侧延伸；B5 = 13，C6 = 14，C3 = -7）----
  function isWhite(m) { return WPC[((m % 12) + 12) % 12] !== null; }
  function whiteIndexOf(m) { // 仅白键有效
    return (Math.floor(m / 12) - 5) * 7 + WPC[((m % 12) + 12) % 12];
  }
  // 黑键 → 就近白键（同距取低 = 降半音）；返回 {wi, black}
  function noteToWhite(m) {
    var w = isWhite(m);
    return { wi: whiteIndexOf(w ? m : m - 1), black: !w };
  }
  // 白键序号 → MIDI 音高
  function whiteToMidi(wi) {
    return (4 + Math.floor(wi / 7) + 1) * 12 + WHITE_PC[((wi % 7) + 7) % 7];
  }
  // 白键序号 → 音名（如 'C4'、'B7'）
  function whiteName(wi) {
    return WHITE_LETTER[((wi % 7) + 7) % 7] + (4 + Math.floor(wi / 7));
  }
  var NAME_TO_WI = (function () {
    var m = {};
    for (var w = -14; w <= 28; w++) m[whiteName(w)] = w;
    return m;
  })();
  function noteNameToWi(name) { return NAME_TO_WI[name]; }

  // 档位名（如 'A0'、'D6'）
  function gearName(w) { return whiteName(GEAR_STARTS[w]); }
  // 首音从归位底挡（0）出发需要连按 ▶ 的次数；与 scheduleRow 档位搜索的"越界方向优先"一致
  // （低于底挡 / 超出顶挡 → 钳制，无需按键，返回 0）
  function firstPressCount(wi) {
    if (wi >= GEAR_STARTS[0] && wi <= GEAR_STARTS[0] + 13) return 0;
    if (wi >= GEAR_STARTS[0] + 14) {
      for (var g = 1; g <= W_MAX; g++) {
        if (wi >= GEAR_STARTS[g] && wi <= GEAR_STARTS[g] + 13) return g;
      }
    }
    return 0;
  }

  // ---- 轨位几何 ----
  function laneXMM(row, lane) {
    return (row === 0 ? PHYS.lowerX0MM : PHYS.upperX0MM) + lane * PHYS.lanePitchMM;
  }
  // 孔在带长方向的坐标：下排（主旋律，row0）比同拍上排（和弦，row1）靠带尾 105mm
  // （界面上和弦站在上、主旋律站在下，纸带先经和弦站再经主旋律站）
  // mmb：本曲每拍毫米数（最密间隔拉长后可能与 PHYS.mmPerBeat 不同），缺省标准值
  function holeYMM(col, row, mmb) {
    return PHYS.leadInMM + (col / PPB) * (mmb || PHYS.mmPerBeat) + (row === 0 ? PHYS.stationGapMM : 0);
  }

  // ---- 播放时的键盘挡位模型 ----
  // 纸带机上键位本身不固定音高：实际音高 = 白键窗口随换挡移动后的结果。
  // lane 0/15 是换挡键，其余 1..14 是白键。
  function isShiftLane(lane) { return lane === 0 || lane === LANES_PER_ROW - 1; }
  // 从孔序列提取每排换挡事件时间线：[[{beat,dir,arrive}, ...], [上排...]]（按拍升序）
  // tempo：变速曲传 makeTempoMap 结果，恒定速度传 BPM 数字（缺省 120）。
  // arrive = 触发拍 + 换挡耗时 400ms（按该处速度折算回拍），即键盘到位时刻。
  function buildShiftTimeline(holes, tempo) {
    var tm = tempo && tempo.beatToTime ? tempo : null;
    var bpm0 = typeof tempo === 'number' ? tempo : 120;
    function arriveOf(beat) {
      return tm ? tm.timeToBeat(tm.beatToTime(beat) + PHYS.shiftMs / 1000)
                : beat + (PHYS.shiftMs / 1000) * bpm0 / 60;
    }
    var tl = [[], []], lastArrive = [0, 0];
    for (var i = 0; i < holes.length; i++) {
      var h = holes[i];
      if (h.row !== 0 && h.row !== 1) continue;
      if (isShiftLane(h.lane)) {
        var beat = (h.col + 0.5) / PPB;
        var arrive = Math.max(arriveOf(beat), beat, lastArrive[h.row]);
        lastArrive[h.row] = arrive;
        tl[h.row].push({ beat: beat, dir: h.lane === LANES_PER_ROW - 1 ? 1 : -1, arrive: arrive });
      }
    }
    tl[0].sort(function (a, b) { return a.beat - b.beat; });
    tl[1].sort(function (a, b) { return a.beat - b.beat; });
    return tl;
  }
  // 某排在 beat 时刻的键盘状态：s=档位(0..W_MAX)；moving=换挡键已触发但键盘尚在滑动（400ms 内）。
  // 物理模型：换挡键触发后键盘 400ms 才到位——到位前仍按旧挡击发，故与换挡键同拍的
  // 音符照旧挡发音；到位后新挡才生效。s 钳位 ≥0：曲首归位连按 ◀ 钉底，已在底端时空按
  // 被机械限位吸收（挡位不出现负值）。
  function shiftInfoAt(tl, row, beat) {
    var arr = tl[row] || [], s = 0;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].arrive <= beat + 1e-9) { s += arr[i].dir; if (s < 0) s = 0; continue; }
      if (arr[i].beat <= beat + 1e-9) return { s: s, moving: true, dir: arr[i].dir };
      break;
    }
    return { s: s, moving: false, dir: 0 };
  }
  function shiftAt(tl, row, beat) { return shiftInfoAt(tl, row, beat).s; }
  // 键位 lane(1..14) 在指定档位下击发的实际 MIDI 音高
  function soundingMidi(lane, shift) {
    return whiteToMidi(GEAR_STARTS[shift] + lane - 1);
  }

  // ---- 自动移调：模拟 13 个候选移调的双排完整调度，选加权半音误差最小的 ----
  // 评分 = 主旋律误差 ×3 + 和弦误差 ×1（主旋律是听感主体）：
  //  - 黑键映射：调内音 ×3（系统性错半音——移调选错调时整个音阶都落在黑键上，正是
  //    "音高不对"的主因）、调外装饰音 ×1（任何移调都无法消除的固有误差）
  //  - 钳制：按实际偏离半音数计（窗缘就近钳制多为 1~2 半音，真实代价小）
  // 物理时序按真实速度表 + 拉长后的每拍毫米数模拟，与正式转换同一套 scheduleRow。
  // 返回 [err, |tr|]，lexLess 字典序比较（误差同则取 |移调| 小者）。
  function lexLess(a, b) {
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
    return false;
  }
  // 调号 sf（-7..+7）对应的调内音级集合（大调；小调用关系大小调同一音级集）
  function diatonicPcs(sf) {
    var tonic = ((sf * 7) % 12 + 12) % 12, pcs = [];
    var steps = [0, 2, 4, 5, 7, 9, 11];
    for (var i = 0; i < 7; i++) pcs.push((tonic + steps[i]) % 12);
    return pcs;
  }
  // 候选移调 tr 下音符组（[mel, cho] 两排）的评分键 [加权半音误差, |tr|]
  function scoreTranspose(rows, tr, tpb, opts) {
    var keyPcs = opts && opts.keyPcs;
    var err = 0;
    for (var r = 0; r < 2; r++) {
      var list = rows[r] || [];
      var q = [], rowErr = 0;
      for (var i = 0; i < list.length; i++) {
        var m = list[i].note + tr;
        var wr = noteToWhite(m);
        if (wr.black) {
          var pc = ((list[i].note % 12) + 12) % 12; // 调性角色看原始音级
          rowErr += keyPcs && keyPcs.indexOf(pc) >= 0 ? 3 : 1;
        }
        q.push({ col: Math.max(0, Math.round((list[i].tick || 0) / tpb * PPB)), wi: wr.wi });
      }
      q.sort(function (a, b) { return a.col - b.col; });
      var sr = scheduleRow(q, r, opts);
      // 钳制半音误差：scheduleRow 每个音符产生一个非换挡孔，按序与输入一一对应
      var ni = 0;
      for (var h = 0; h < sr.holes.length && ni < q.length; h++) {
        var hh = sr.holes[h];
        if (isShiftLane(hh.lane)) continue;
        var placed = GEAR_STARTS[hh.shift] + hh.lane - 1;
        if (placed !== q[ni].wi) rowErr += Math.abs(whiteToMidi(placed) - whiteToMidi(q[ni].wi));
        ni++;
      }
      err += (r === 0 ? 3 : 1) * rowErr;
    }
    return [err, Math.abs(tr)];
  }
  function autoTranspose(mel, cho, opts) {
    if (cho && !cho.length) cho = null;
    if (cho && typeof cho[0] !== 'object') { opts = cho; cho = null; }
    opts = opts || {};
    var tpb = opts.tpb || 480;
    var best = 0, bestKey = null;
    for (var tr = -6; tr <= 6; tr++) {
      var key = scoreTranspose([mel, cho], tr, tpb, opts);
      if (bestKey === null || lexLess(key, bestKey)) { bestKey = key; best = tr; }
    }
    return best;
  }

  // ---- 按调号分段自动移调：调号变化处切分段落，每段独立选最优移调 ----
  // 根因：同名大小调交替曲（如土耳其进行曲 A 小调↔A 大调）任何单一移调都无法
  // 两段同时白键化——A 小调段全白的调对 A 大调段是 4 个降号（21% 主旋律音错半音）。
  // 分段后各段按调号音级就近白键化（A 小调段 +0、A 大调段 +3 → C 大调），错音仅剩装饰音。
  // 段界取自 MIDI 调号事件（FF 59），相邻同调号合并；仅 1 段时返回 null（走全曲统一 autoTranspose）。
  // 段内评分同 autoTranspose；返回 [{tick0, tick1, sf, minor, s}]，音符按 tick 落段取 s。
  function autoTransposeSegments(mel, cho, keysigs, tpb, opts) {
    if (!keysigs || !keysigs.length) return null;
    var marks = [];
    for (var i = 0; i < keysigs.length; i++) {
      var last = marks[marks.length - 1];
      if (!last || last.sf !== keysigs[i].sf || last.minor !== keysigs[i].minor) {
        marks.push({ tick: keysigs[i].tick, sf: keysigs[i].sf, minor: keysigs[i].minor });
      }
    }
    if (marks.length <= 1) return null;
    var segs = [];
    for (var g = 0; g < marks.length; g++) {
      var tick0 = marks[g].tick;
      var tick1 = g + 1 < marks.length ? marks[g + 1].tick : Infinity;
      // 收集段内音符（两排各自按 tick ∈ [tick0, tick1) 归段）
      var rows = [];
      var src = [mel, cho];
      for (var r = 0; r < 2; r++) {
        var seg = [];
        var list = src[r] || [];
        for (var j = 0; j < list.length; j++) {
          if (list[j].tick >= tick0 && list[j].tick < tick1) seg.push(list[j]);
        }
        rows.push(seg);
      }
      var best = 0, bestKey = null;
      for (var tr = -6; tr <= 6; tr++) {
        var segOpts = {};
        for (var ko in opts) segOpts[ko] = opts[ko];
        segOpts.keyPcs = diatonicPcs(marks[g].sf); // 大小调共用音级集（关系大小调）
        var key = scoreTranspose(rows, tr, tpb, segOpts);
        if (bestKey === null || lexLess(key, bestKey)) { bestKey = key; best = tr; }
      }
      segs.push({ tick0: tick0, tick1: tick1, sf: marks[g].sf, minor: marks[g].minor, s: best });
    }
    return segs;
  }

  /**
   * 单排换挡调度。
   * @param notes [{col, wi}] 按 col 升序（col 为编辑栅格列）
   * @param row  0=下排(主旋律) 1=上排(和弦)
   * @param opts.tempoMap 变速曲速度表（缺省恒定 opts.bpm，再缺省 120）
   * @param opts.home 曲首强制归位：连按 3 次 ◀ 钉底到初始档位 A0（键盘初始位置不确定）
   * @returns {holes:[{row,lane,col,midi}], shifts:[{row,dir,col}], clamped, finalW, home, homeOk}
   * lane: 0=换挡键 ◀◀ 1..14=白键 15=换挡键 ▶▶；midi 为该孔在换挡完成后的实际音高（换挡键孔为 null）
   * home：归位孔数（0 或 3，shifts 不计入归位）；homeOk：归位末次按动 + 升挡链能否赶在首音前
   *
   * 换挡提前量（物理）：换挡键孔触发 + shiftLeadMs(600ms) ≤ 目标音符触发——
   * 键盘 400ms 滑动到位 + 200ms 余量，按孔位处的走带速度折算成列数。
   * 连续多次按动：上一按触发 + shiftMs(400ms)（换挡完成）后才允许下一按触发。
   */
  function scheduleRow(notes, row, opts) {
    opts = opts || {};
    var tm = opts.tempoMap && opts.tempoMap.beatToTime ? opts.tempoMap : null;
    var bpm0 = opts.bpm || 120;
    var mmb = opts.mmPerBeat || PHYS.mmPerBeat;
    // 换挡键孔允许的最早列（可落在头部留白内，但不越过纸带头 2mm）——按本曲 mmPerBeat 折算。
    // 排别：row0（主旋律）孔 y 含 +105mm 站间距，可比 row1（和弦）再前 105mm，快曲升挡不再钳制
    // （ceil：col 为 -5.78 这类小数时须向上取整到 -5，floor 取 -6 会打到带头 1.5mm 处、孔缘距边仅 0.3mm）
    var minShiftCol = Math.ceil((2 - PHYS.leadInMM - (row === 0 ? PHYS.stationGapMM : 0)) / mmb * PPB);
    function tTime(b) { return tm ? tm.beatToTime(b) : b * 60 / bpm0; }
    // 换挡键排产（物理约束）：
    //  1) 键盘须在目标音触发前到位：触发 + shiftMs(400ms) ≤ 目标触发；优先留 shiftLeadMs(600ms) 余量
    //  2) 旧挡音保护：换挡键允许早于上一音(prevCol)——到位前该排仍按旧挡击发（滑行中照常发旧挡音），
    //     但最后一个旧挡音必须在到位前触发：触发 ≥ tPrev - 400ms
    //  3) 连续按动：与上一次按动间隔 ≥ shiftMs（lastPressT + 400ms 后才可再按）
    // 满足 1) 时取最晚列（最大限度保住旧挡音）；600ms 余量放不下退 400ms 硬约束；
    // 仍无解返回 null（调用处钳制）——密集跑动段由此得以在音流中换挡而非整段错音
    function searchPress(noteCol, limitMs) {
      var limit = tTime((noteCol + 0.5) / PPB) - limitMs / 1000;
      var c = noteCol - 1;
      while (c >= minShiftCol && tTime((c + 0.5) / PPB) > limit + 1e-9) c--;
      if (c < minShiftCol) {
        return tTime((minShiftCol + 0.5) / PPB) <= limit + 1e-9 ? minShiftCol : null;
      }
      return c;
    }
    function pressColFor(noteCol, prevCol) {
      var tFloor = lastPressT + PHYS.shiftMs / 1000; // 约束 3
      if (prevCol !== null) {                        // 约束 2
        var tP = tTime((prevCol + 0.5) / PPB) - PHYS.shiftMs / 1000;
        if (tP > tFloor) tFloor = tP;
      }
      var p = searchPress(noteCol, PHYS.shiftLeadMs);
      if (p === null || tTime((p + 0.5) / PPB) < tFloor - 1e-9) p = searchPress(noteCol, PHYS.shiftMs);
      if (p === null || tTime((p + 0.5) / PPB) < tFloor - 1e-9) return null;
      return p;
    }
    // 在 refCol 之前、与 refCol 触发间隔 ≥ shiftMs 的最晚列（多次连续按动用）
    function prevPressCol(refCol) {
      var limit = tTime((refCol + 0.5) / PPB) - PHYS.shiftMs / 1000;
      var c = refCol - 1;
      while (c >= minShiftCol && tTime((c + 0.5) / PPB) > limit + 1e-9) c--;
      return c < minShiftCol ? null : c;
    }
    var holes = [], shifts = [], clamped = 0;
    var w = 0, prevCol = null, lastPressT = -Infinity;
    var home = 0, homeOk = true;

    // 曲首强制归位：连按 3 次 ◀ 钉底到 A0（间隔 ≥400ms 且同轨孔距 ≥4.5mm）。
    // margin 不只保证"归位完成 ≤ 首音"：首音自身要升挡时，其换挡链（每按 600ms 提前量、
    // 相邻按动间隔 400ms）必须完整排进 [归位末按, 首音] 区间，否则归位会挤掉首音的升挡键。
    if (opts.home && notes.length) {
      var secPerCol = (tTime(0.25) - tTime(0)) || 1e-9;
      var vMM = mmb / (secPerCol * PPB); // 头部走带速度 mm/s
      var sCols = Math.max(1, Math.ceil(Math.max(PHYS.shiftMs / 1000, PHYS.minGapMM / vMM) / secPerCol));
      var c0 = minShiftCol + 2 * sCols; // 最早布局时末次按动列
      var nPress = firstPressCount(notes[0].wi);
      var margin = PHYS.shiftMs / 1000
        + (nPress > 0 ? PHYS.shiftLeadMs / 1000 + (nPress - 1) * PHYS.shiftMs / 1000 : 0);
      var tFirst = tTime((notes[0].col + 0.5) / PPB);
      if (tTime((c0 + 0.5) / PPB) + margin <= tFirst + 1e-9) {
        for (var hp = 0; hp < 3; hp++) {
          holes.push({ row: row, lane: 0, col: minShiftCol + hp * sCols, midi: null });
        }
        home = 3;
        lastPressT = tTime((c0 + 0.5) / PPB);
      } else {
        homeOk = false; // 调用处顺延整曲重试；重试耗尽仍失败时保留归位孔（键盘绝对位置优先）
      }
    }

    for (var i = 0; i < notes.length; i++) {
      var col = notes[i].col, wi = notes[i].wi;

      // 1. 找可行档位（按离当前挡的距离搜索；越界方向优先）
      var target = null;
      for (var d = 0; d <= W_MAX && target === null; d++) {
        var cands = d === 0 ? [w]
          : (wi >= GEAR_STARTS[w] + 14 ? [w + d, w - d] : [w - d, w + d]);
        for (var c = 0; c < cands.length; c++) {
          var wp = cands[c];
          if (wp < 0 || wp > W_MAX) continue;
          var ln = wi - GEAR_STARTS[wp] + 1;
          if (ln >= 1 && ln <= 14) { target = wp; break; }
        }
      }

      // 2. 档位范围内仍不可达 → 钳制到当前窗口最近键
      if (target === null) {
        clamped++;
        var lc = Math.max(1, Math.min(14, wi - GEAR_STARTS[w] + 1));
        holes.push({ row: row, lane: lc, col: col, midi: whiteToMidi(GEAR_STARTS[w] + lc - 1), shift: w });
        prevCol = col;
        continue;
      }

      // 3. 换挡（可能逐挡多按）；按物理约束求按动列，无解则钳制
      if (target !== w) {
        var nPress2 = Math.abs(target - w);
        var p0 = pressColFor(col, prevCol);
        var presses = null;
        if (p0 !== null) {
          presses = [p0];
          for (var p = 1; p < nPress2; p++) {
            var pc = prevPressCol(presses[0]);
            if (pc === null) { presses = null; break; }
            presses.unshift(pc);
          }
        }
        if (presses === null) { // 物理放不下（换挡来不及），放弃换挡改钳制
          clamped++;
          var lc2 = Math.max(1, Math.min(14, wi - GEAR_STARTS[w] + 1));
          holes.push({ row: row, lane: lc2, col: col, midi: whiteToMidi(GEAR_STARTS[w] + lc2 - 1), shift: w });
          prevCol = col;
          continue;
        }
        var dir = target > w ? 1 : -1;
        for (var p2 = 0; p2 < presses.length; p2++) {
          var tb = presses[p2];
          shifts.push({ row: row, dir: dir, col: tb });
          holes.push({ row: row, lane: dir > 0 ? 15 : 0, col: tb, midi: null });
          w += dir;
        }
        lastPressT = tTime((presses[presses.length - 1] + 0.5) / PPB);
      }

      holes.push({ row: row, lane: wi - GEAR_STARTS[w] + 1, col: col, midi: whiteToMidi(wi), shift: w });
      prevCol = col;
    }
    return { holes: holes, shifts: shifts, clamped: clamped, finalW: w, home: home, homeOk: homeOk };
  }

  /** 整曲顺延 beats 拍（归位留时间用）：复制并平移 notes / keysigs / tempos 的 tick。
   *  平移后 [0,Δ] 拍为新增头部：无速度事件时按 opts.bpm 恒速，有速度表时头部按表头默认 120
   *  走带（首事件已随曲平移到 Δ 拍之后），故「平移后首音触发 = Δ·60/V + 原轴时间」精确成立。 */
  function shiftMidiTicks(midi, beats) {
    var d = Math.round(beats * midi.ticksPerBeat);
    var m = { ticksPerBeat: midi.ticksPerBeat, tracks: [], tempos: [], keysigs: [] };
    for (var t = 0; t < midi.tracks.length; t++) {
      var tr = midi.tracks[t], notes = [];
      for (var n = 0; n < tr.notes.length; n++) {
        var o = tr.notes[n], c = {};
        for (var f in o) c[f] = o[f];
        c.tick = o.tick + d;
        notes.push(c);
      }
      m.tracks.push({ index: tr.index, name: tr.name, channels: tr.channels, notes: notes });
    }
    for (var i = 0; i < (midi.tempos || []).length; i++) {
      m.tempos.push({ tick: midi.tempos[i].tick + d, usPerQuarter: midi.tempos[i].usPerQuarter });
    }
    for (var k = 0; k < (midi.keysigs || []).length; k++) {
      var ks = midi.keysigs[k];
      m.keysigs.push({ tick: ks.tick + d, sf: ks.sf, minor: ks.minor });
    }
    return m;
  }

  /**
   * MIDI → 纸带转换
   * @param midi parseMidi() 结果
   * @param opts { melodyTracks:Set, chordTracks:Set, excludeDrums:bool,
   *               transpose:'auto'|number, bpm, home:bool（曲首强制归位，默认开） }
   * @returns {holes:[{col,row,lane,midi}], endCol, transpose, report}
   */
  function convertFromMidi(midi, opts) {
    opts = opts || {};
    var home = opts.home !== false; // 曲首强制归位（默认开）
    var tpb0 = midi.ticksPerBeat;

    // 1. 收集两排音符（整曲顺延后需对平移副本重跑）
    function collect(m) {
      var mel = [], cho = [];
      for (var t = 0; t < m.tracks.length; t++) {
        var tr = m.tracks[t];
        for (var n = 0; n < tr.notes.length; n++) {
          var nt = tr.notes[n];
          if (opts.excludeDrums !== false && nt.channel === 9) continue;
          if (opts.melodyTracks && opts.melodyTracks.has(t)) mel.push(nt);
          if (opts.chordTracks && opts.chordTracks.has(t)) cho.push(nt);
        }
      }
      return { mel: mel, cho: cho };
    }
    var base = collect(midi);
    if (!base.mel.length && !base.cho.length) {
      return { holes: [], endCol: 0, transpose: 0, report: { noteCount: 0, empty: true } };
    }

    // 2. 速度表 + 最密列间隔探测 → 本曲每拍毫米数（整曲平移不改变列间隔，探测一次；
    //    列位与移调无关，先算好供移调模拟与调度共用）
    var tm0 = makeTempoMap(midi.tempos, tpb0);
    var minGapCols = Infinity;
    function probeCols(list) {
      var cols = [];
      for (var i = 0; i < list.length; i++) cols.push(Math.max(0, Math.round(list[i].tick / tpb0 * PPB)));
      cols.sort(function (a, b) { return a - b; });
      for (var j = 1; j < cols.length; j++) {
        var gap = cols[j] - cols[j - 1];
        if (gap > 0 && gap < minGapCols) minGapCols = gap;
      }
    }
    probeCols(base.mel);
    probeCols(base.cho);
    if (minGapCols === Infinity) minGapCols = PPB; // 单孔整曲无约束
    var mmPerBeat = PHYS.mmPerBeat;
    var needMM = PHYS.minGapMM * PPB / minGapCols;
    if (needMM > mmPerBeat) mmPerBeat = Math.ceil(needMM * 2) / 2; // 向上取整到 0.5mm
    var schedOpts = { tempoMap: tm0, bpm: opts.bpm || 120, mmPerBeat: mmPerBeat, tpb: tpb0 };

    // 3. 移调：auto 优先按调号分段（同名大小调交替曲的解法），无多段调号则全曲统一。
    //    在原始时间轴只算一次——整曲平移不改变音符间时序，移调评分（不含归位）平移不变
    var segs = opts.transpose === 'auto'
      ? autoTransposeSegments(base.mel, base.cho, midi.keysigs, tpb0, schedOpts)
      : null;
    var s = opts.transpose === 'auto'
      ? (segs ? null : autoTranspose(base.mel, base.cho, schedOpts))
      : (opts.transpose | 0);
    // 音符按 tick 落段取该段移调值；全曲统一时恒为 s
    function sAt(tick) {
      if (!segs) return s;
      for (var i = 0; i < segs.length; i++) {
        if (tick < segs[i].tick1) return segs[i].s;
      }
      return segs[segs.length - 1].s;
    }

    // 4. 归位顺延（整拍）：每排 need = 头速走带时间(c0) + margin - 原轴首音触发，
    //    按头部速度 V（速度表头默认 120 / 无表 opts.bpm）换算拍数取两排最大值
    function homeDelayBeats() {
      var V = tm0 ? 120 : (opts.bpm || 120);
      var beats = 0;
      var rows = [base.mel, base.cho];
      for (var r = 0; r < 2; r++) {
        var list = rows[r];
        if (!list || !list.length) continue;
        var first = null; // 该排量化列最早的音（与 toNotes 同一量化）
        for (var i = 0; i < list.length; i++) {
          var col = Math.max(0, Math.round(list[i].tick / tpb0 * PPB));
          if (first === null || col < first.col) first = { col: col, tick: list[i].tick, note: list[i].note };
        }
        var wi = noteToWhite(first.note + sAt(first.tick)).wi;
        var minShiftCol = Math.ceil((2 - PHYS.leadInMM - (r === 0 ? PHYS.stationGapMM : 0)) / mmPerBeat * PPB);
        var secPerCol = 60 / V / PPB;
        var vMM = mmPerBeat * V / 60;
        var sCols = Math.max(1, Math.ceil(Math.max(PHYS.shiftMs / 1000, PHYS.minGapMM / vMM) / secPerCol));
        var c0 = minShiftCol + 2 * sCols;
        var nPress = firstPressCount(wi);
        var margin = PHYS.shiftMs / 1000
          + (nPress > 0 ? PHYS.shiftLeadMs / 1000 + (nPress - 1) * PHYS.shiftMs / 1000 : 0);
        var tF = tm0 ? tm0.beatToTime((first.col + 0.5) / PPB) : (first.col + 0.5) / PPB * 60 / V;
        var need = (c0 + 0.5) / PPB * 60 / V + margin - tF;
        if (need > 1e-9) {
          var db = Math.ceil(need * V / 60 - 1e-9);
          if (db > beats) beats = db;
        }
      }
      return beats;
    }
    var delay = home ? homeDelayBeats() : 0;

    // 5. 整曲顺延 + 核心转换；homeOk 两排不齐则 delay++ 重试（步骤 4 公式已精确，循环仅兜底）
    var out = null;
    for (var attempt = 0; attempt < 4; attempt++) {
      var dTicks = delay * tpb0;
      var cur = delay > 0 ? shiftMidiTicks(midi, delay) : midi;
      out = convertCore(cur, dTicks);
      if (!home || (out.report.homeOk[0] && out.report.homeOk[1])) break;
      delay++;
    }
    out.report.homeDelay = home ? delay : 0;
    return out;

    // ---- 核心转换（原步骤 4-6：白键化 → 换挡调度 → 合并去重 → 最小孔距修复）----
    function convertCore(m, dTicks) {
      var tempoMap = dTicks > 0 ? makeTempoMap(m.tempos, tpb0) : tm0;
      var runOpts = { tempoMap: tempoMap, bpm: opts.bpm || 120, mmPerBeat: mmPerBeat, home: home };

      // 白键化 + 栅格量化（黑键就近映射白键，同距取低）；调号段界按原轴 tick 对比
      function toNotes(list) {
        var arr = [], blackN = 0;
        for (var i = 0; i < list.length; i++) {
          var m2 = list[i].note + sAt(list[i].tick - dTicks);
          var r = noteToWhite(m2);
          if (r.black) blackN++;
          var col = Math.max(0, Math.round(list[i].tick / tpb0 * PPB));
          arr.push({ col: col, wi: r.wi });
        }
        arr.sort(function (a, b) { return a.col - b.col; });
        return { notes: arr, black: blackN };
      }
      var src = collect(m);
      var melR = toNotes(src.mel), choR = toNotes(src.cho);

      // 换挡调度（每排独立；提前量按该处速度折算 400ms 换挡 + 200ms 余量）
      var rL = scheduleRow(melR.notes, 0, runOpts);
      var rU = scheduleRow(choR.notes, 1, runOpts);

      // 合并 + 同拍同轨去重
      var seen = {}, holes = [];
      var merged = rL.holes.concat(rU.holes);
      for (var k = 0; k < merged.length; k++) {
        var h = merged[k];
        var key = h.col + ':' + h.row + ':' + h.lane;
        if (seen[key]) continue;
        seen[key] = true;
        holes.push(h);
      }
      holes.sort(function (a, b) { return a.col - b.col || a.row - b.row || a.lane - b.lane; });

      // 同轨最小孔距修复（按 row+lane 分组独立后移）。
      // 换挡键孔（含归位孔）先排，它们的最终列就是键盘档位边界；音符孔后移时不得越过自己
      // 发声档位的右边界——键盘移走后旧挡孔才到站必成错音，物理打不下时舍弃该孔（计入报告）。
      // 换挡键触发 +400ms 才到位：触发到到位之间该排键盘在滑动，旧挡音越界孔
      // （触发晚于换挡键）同样被 hi 规则舍弃，故换挡过渡区天然无音符孔。
      // 拉长后的 mmPerBeat 下，同轨音符原始间隔全部 ≥ gapCols（=探测的最密间隔），
      // 音符孔不再后移；换挡键轨（6a）在慢速下仍可能微调后移（非乐音，不影响节奏）。
      var gapCols = Math.max(1, Math.ceil(PHYS.minGapMM / (mmPerBeat / PPB) - 1e-9));
      function groupByLane(list) {
        var m3 = {};
        for (var i2 = 0; i2 < list.length; i2++) {
          var k2 = list[i2].row + ':' + list[i2].lane;
          (m3[k2] || (m3[k2] = [])).push(list[i2]);
        }
        return m3;
      }
      // 6a. 换挡键孔（含归位孔）先按各自轨排队，得到最终换挡列
      var keyHoles = [], noteHoles = [];
      for (var kh = 0; kh < holes.length; kh++) {
        (isShiftLane(holes[kh].lane) ? keyHoles : noteHoles).push(holes[kh]);
      }
      var keyGroups = groupByLane(keyHoles);
      var placedKeys = [];
      for (var kg in keyGroups) {
        var kList = keyGroups[kg], kPrev = -Infinity;
        for (var ki = 0; ki < kList.length; ki++) {
          var kc = kList[ki].col;
          if (kPrev > -Infinity && kc - kPrev < gapCols) kc = kPrev + gapCols;
          placedKeys.push({ row: kList[ki].row, lane: kList[ki].lane, col: kc, midi: null });
          kPrev = kc;
        }
      }
      placedKeys.sort(function (a, b) { return a.col - b.col || a.row - b.row || a.lane - b.lane; });
      var bounds = [[], []]; // 每排换挡键最终列（升序）
      for (var bi = 0; bi < placedKeys.length; bi++) bounds[placedKeys[bi].row].push(placedKeys[bi].col);

      // 6b. 音符孔按轨排队 + 档位区间约束
      var result = placedKeys.slice();
      var pushed = 0, maxPush = 0, dropped = 0;
      var noteGroups = groupByLane(noteHoles);
      for (var ng in noteGroups) {
        var gList = noteGroups[ng], gPrev = -Infinity;
        for (var gi = 0; gi < gList.length; gi++) {
          var nh = gList[gi], outCol = nh.col;
          if (gPrev > -Infinity && outCol - gPrev < gapCols) outCol = gPrev + gapCols;
          // 右边界：第一个最终列 ≥ 原列的同排换挡键（允许同列：同拍仍按移动前键盘击发）
          var hi = Infinity, seq = bounds[nh.row];
          for (var qi = 0; qi < seq.length; qi++) {
            if (seq[qi] >= nh.col) { hi = seq[qi]; break; }
          }
          if (outCol > hi) { dropped++; continue; } // 越过换挡点：舍弃，不占轨位
          if (outCol !== nh.col) {
            pushed++;
            if (outCol - nh.col > maxPush) maxPush = outCol - nh.col;
          }
          result.push({ col: outCol, row: nh.row, lane: nh.lane, midi: nh.midi });
          gPrev = outCol;
        }
      }
      result.sort(function (a, b) { return a.col - b.col || a.row - b.row || a.lane - b.lane; });

      var endCol = 0;
      for (var e = 0; e < result.length; e++) if (result[e].col >= 0 && result[e].col + 1 > endCol) endCol = result[e].col + 1;

      return {
        holes: result,
        endCol: endCol,
        transpose: segs ? 0 : s,
        segTranspose: segs ? segs.map(function (g) { return { tick0: g.tick0, sf: g.sf, minor: g.minor, s: g.s }; }) : null,
        mmPerBeat: mmPerBeat,
        report: {
          noteCount: base.mel.length + base.cho.length,
          holeCount: result.length,
          empty: false,
          blackMapped: melR.black + choR.black,
          clamped: rL.clamped + rU.clamped,
          shifts: [rL.shifts.length, rU.shifts.length],
          homing: [rL.home, rU.home],
          homeOk: [rL.homeOk, rU.homeOk],
          pushedNotes: pushed,
          dropped: dropped,
          maxPushCols: maxPush,
          scale: mmPerBeat / PHYS.mmPerBeat
        }
      };
    }
  }

  /** 带长（mm）：头留白 + 音乐区长 + 站间错位（主旋律带尾部多 105mm）+ 尾留白
   *  mmb：本曲每拍毫米数（拉长曲与标准值不同），缺省 PHYS.mmPerBeat */
  function tapeLenMM(endCol, mmb) {
    return PHYS.leadInMM + (endCol / PPB) * (mmb || PHYS.mmPerBeat) + PHYS.stationGapMM + PHYS.leadOutMM;
  }

  /** 1:1 导出几何（SVG / PNG 共用）；mmb 同 tapeLenMM */
  function exportGeometry(holes, endCol, mmb) {
    var mm = mmb || PHYS.mmPerBeat;
    var out = [];
    for (var i = 0; i < holes.length; i++) {
      var h = holes[i];
      out.push({ x: laneXMM(h.row, h.lane), y: holeYMM(h.col, h.row, mm), row: h.row, lane: h.lane });
    }
    var beatYs = [];
    var beats = Math.ceil(endCol / PPB);
    for (var b = 0; b <= beats; b++) beatYs.push(PHYS.leadInMM + b * mm);
    var laneXs = [];
    for (var l = 0; l < LANES_PER_ROW; l++) {
      laneXs.push(laneXMM(0, l));
      laneXs.push(laneXMM(1, l));
    }
    laneXs.sort(function (a, b) { return a - b; });
    return { wMM: PHYS.tapeWidthMM, hMM: tapeLenMM(endCol, mm), holes: out, beatYs: beatYs, laneXs: laneXs };
  }

  /**
   * 示例曲《小星星》：下排主旋律 + 上排和弦（C-F-G 进行）。
   * 全部音落在 w2 档（A4..G6 窗口）：曲首两排各按 2 次 ▶ 升挡演示换挡调度；
   * 首音空出 1 拍给升挡链留位（100bpm 下头部留白刚好放下两次按动）
   * @returns {holes, endCol, bpm}
   */
  function demoSong() {
    var mel = [ // [beat 拍, 音名]
      [1, 'C5'], [2, 'C5'], [3, 'G5'], [4, 'G5'], [5, 'A5'], [6, 'A5'], [7, 'G5'],
      [9, 'F5'], [10, 'F5'], [11, 'E5'], [12, 'E5'], [13, 'D5'], [14, 'D5'], [15, 'C5']
    ];
    var cho = [ // 每 2 拍一个三和弦（分解为同拍 3 孔）
      [1, 'C5'], [1, 'E5'], [1, 'G5'],
      [3, 'C5'], [3, 'E5'], [3, 'G5'],
      [5, 'F5'], [5, 'A5'], [5, 'C6'],
      [7, 'G5'], [7, 'B5'], [7, 'D6'],
      [9, 'F5'], [9, 'A5'], [9, 'C6'],
      [11, 'C5'], [11, 'E5'], [11, 'G5'],
      [13, 'G5'], [13, 'B5'], [13, 'D6'],
      [15, 'C5'], [15, 'E5'], [15, 'G5']
    ];
    function build(list, row) {
      var notes = [];
      for (var i = 0; i < list.length; i++) {
        notes.push({ col: list[i][0] * PPB, wi: noteNameToWi(list[i][1]) });
      }
      notes.sort(function (a, b) { return a.col - b.col; });
      return scheduleRow(notes, row, { bpm: 100 }); // 与返回的播放 BPM 一致，提前量按真实速度折算
    }
    var rL = build(mel, 0), rU = build(cho, 1);
    var merged = rL.holes.concat(rU.holes);
    merged.sort(function (a, b) { return a.col - b.col || a.row - b.row || a.lane - b.lane; });
    var endCol = 0;
    for (var j = 0; j < merged.length; j++) if (merged[j].col + 1 > endCol) endCol = merged[j].col + 1;
    return { holes: merged, endCol: endCol, bpm: 100, shifts: [rL.shifts.length, rU.shifts.length] };
  }

  // ---- 变速播放支持：与 music-box 相同的分段常速积分 tempo map ----
  function buildTempoMap(points) {
    var byBeat = { 0: 120 };
    for (var i = 0; i < points.length; i++) {
      var b = Number(points[i].beat), v = Number(points[i].bpm);
      if (isFinite(b) && b >= 0 && isFinite(v) && v > 0) byBeat[b] = v;
    }
    var beats = Object.keys(byBeat).map(Number).sort(function (a, c) { return a - c; });
    var segs = [], sec = 0, prevBeat = beats[0], prevBpm = byBeat[beats[0]];
    segs.push({ beat: prevBeat, sec: sec, bpm: prevBpm });
    for (var k = 1; k < beats.length; k++) {
      sec += (beats[k] - prevBeat) * 60 / prevBpm;
      prevBeat = beats[k];
      prevBpm = byBeat[beats[k]];
      segs.push({ beat: prevBeat, sec: sec, bpm: prevBpm });
    }
    function beatToTime(b) {
      if (b <= segs[0].beat) return b * 60 / segs[0].bpm;
      for (var s = 0; s < segs.length - 1; s++) {
        if (b < segs[s + 1].beat) return segs[s].sec + (b - segs[s].beat) * 60 / segs[s].bpm;
      }
      var last = segs[segs.length - 1];
      return last.sec + (b - last.beat) * 60 / last.bpm;
    }
    function timeToBeat(t) {
      if (t <= segs[0].sec) return t * segs[0].bpm / 60;
      for (var s2 = 0; s2 < segs.length - 1; s2++) {
        if (t < segs[s2 + 1].sec) return segs[s2].beat + (t - segs[s2].sec) * segs[s2].bpm / 60;
      }
      var last2 = segs[segs.length - 1];
      return last2.beat + (t - last2.sec) * last2.bpm / 60;
    }
    var bpms = segs.map(function (x) { return x.bpm; });
    return {
      beatToTime: beatToTime, timeToBeat: timeToBeat,
      segments: segs.map(function (x) { return { beat: x.beat, sec: x.sec, bpm: x.bpm }; }),
      count: segs.length, firstBpm: segs[0].bpm,
      minBpm: Math.min.apply(null, bpms), maxBpm: Math.max.apply(null, bpms)
    };
  }

  function makeTempoMap(tempos, ticksPerBeat) {
    if (!tempos || !tempos.length || !(ticksPerBeat > 0)) return null;
    var points = [];
    for (var i = 0; i < tempos.length; i++) {
      var us = tempos[i].usPerQuarter;
      if (!(us > 0)) continue;
      points.push({ beat: tempos[i].tick / ticksPerBeat, bpm: 60e6 / us });
    }
    return points.length ? buildTempoMap(points) : null;
  }

  global.PPKit = {
    PHYS: PHYS,
    PPB: PPB,
    LANES_PER_ROW: LANES_PER_ROW,
    GEAR_STARTS: GEAR_STARTS,
    W_MAX: W_MAX,
    WHITE_PC: WHITE_PC,
    isWhite: isWhite,
    whiteIndexOf: whiteIndexOf,
    noteToWhite: noteToWhite,
    whiteToMidi: whiteToMidi,
    whiteName: whiteName,
    noteNameToWi: noteNameToWi,
    gearName: gearName,
    laneXMM: laneXMM,
    holeYMM: holeYMM,
    isShiftLane: isShiftLane,
    buildShiftTimeline: buildShiftTimeline,
    shiftAt: shiftAt,
    shiftInfoAt: shiftInfoAt,
    soundingMidi: soundingMidi,
    tapeLenMM: tapeLenMM,
    autoTranspose: autoTranspose,
    scoreTranspose: scoreTranspose,
    lexLess: lexLess,
    autoTransposeSegments: autoTransposeSegments,
    scheduleRow: scheduleRow,
    convertFromMidi: convertFromMidi,
    exportGeometry: exportGeometry,
    demoSong: demoSong,
    makeTempoMap: makeTempoMap,
    buildTempoMap: buildTempoMap
  };
})(typeof window !== 'undefined' ? window : globalThis);
