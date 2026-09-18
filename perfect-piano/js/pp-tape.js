/* ============================================================
 * 纸带钢琴打孔程序 - 纸带数据模型与 MIDI 转换管线
 *
 * 机械模型（依据 纸带钢琴规格.md，N=8 虚拟黑键槽位 + 混合换挡）：
 *  - 键盘简化为完美均匀槽栅：每两个白键之间必有一个黑键位（E-F、B-C 间
 *    无真实黑键处插虚拟黑键占位），白:黑键宽 = 7:6
 *  - 每档 N=8 白键：窗口 2N-1 = 15 槽 = 13 个真实键 + 2 虚拟位；
 *    虚拟位也配占位滚轮，压在虚拟位上的轨为死轨（按锚槽判定）
 *  - 档位宽度 130mm = N·w + (N-1)·b → w = 910/98 ≈ 9.286，b = 6w/7 ≈ 7.959；
 *    槽栅距 p = (w+b)/2 = 13w/14 ≈ 8.622mm
 *  - 键盘位置 = 连续锚槽 s ∈ [0, 88]（0=A0 底止点，88=C7 顶止点）：
 *    整档键 ◀◀/▶▶ 每按 ±14 槽（= 1 个八度），400ms 到位；半音键 ±1a/±1b
 *    每按 ±1 槽（= 1 半音），10ms 到位（视为瞬时），a/b 双轨交替 →
 *    步进孔距 2.25mm（1 列），同轨 ≥2 列（4.5mm）
 *  - 移动分解 Δ = 14a + b（|b| ≤ 13；允许过冲回调：如 +13 = 1 整档 − 1 半音，
 *    仅当中间位置不出 [0,88]）
 *  - 每排 21 滚轮（全部上统一槽栅，跨排最小孔心距 = D = p/2 ≈ 4.311 ≥ 4.0 ✓）：
 *    lane 0=◀◀（w/2−p）、1..15=槽位（w/2+(l−1)p）、16=▶▶（w/2+15p）、
 *    17=−1a、18=−1b（左侧外伸）、19=+1a、20=+1b（右侧外伸）
 *  - 纸带宽 200mm（21 轨栅格总占宽 20p+D ≈ 176.8mm，两侧边距约 10mm）
 *  - 孔缘间距规格 1.5mm（任意两孔孔心 ≥ 4.0mm）、孔缘距带边 1.5mm；
 *    统一槽栅下纯 x 几何即满足全孔距规格，无需任何微移安全网
 *  - 换挡物理：整档 400ms 到位（到位前仍按旧位击发）、连续按动间隔 ≥400ms；
 *    半音 10ms 到位、可在音符前 1 列按动；曲首强制归位：连按 7 次 ◀ 钉底 A0
 *  - 音高 100% 精确落轨（不移调）；纸带自下而上走带，两排沿走带
 *    方向相距 105mm，先穿上排（和弦）再穿下排（主旋律）
 * ============================================================ */
(function (global) {
  'use strict';

  var PC_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  function midiName(m) { return PC_NAMES[((m % 12) + 12) % 12] + Math.floor(m / 12 - 1); }
  var NAME_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  function nameToMidi(name) { // 如 'C4' → 60、'A#0' → 22
    var pc = NAME_PC[name.charAt(0)], sharp = name.charAt(1) === '#';
    return (parseInt(name.slice(sharp ? 2 : 1), 10) + 1) * 12 + pc + (sharp ? 1 : 0);
  }

  // ---- 键盘槽位模型（N 白键 + 虚拟黑键占位 → 完美均匀槽栅）----
  var N_WHITE = 8;                        // 每档白键数（规格可调参数）
  var SLOT_COUNT = 2 * N_WHITE - 1;      // 15 槽/档（13 真实键 + 2 虚拟位）
  var LANES_PER_ROW = SLOT_COUNT + 6;     // ◀ + 15 槽 + ▶ + 4 半音位 = 21 滚轮/排
  var A0_MIDI = 21;
  // 槽 → 半音偏移（14 槽 = 一个八度；-1 = 虚拟黑键位，位于 B-C、E-F 之间）
  var SLOT_OFF = [0, 1, 2, -1, 3, 4, 5, 6, 7, -1, 8, 9, 10, 11];
  // 半音（自 A 起 0..11）→ 槽（SLOT_OFF 的逆映射，白/黑键同用）
  var SEMI_SLOT = { 0: 0, 1: 1, 2: 2, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 10, 9: 11, 10: 12, 11: 13 };
  function slotPitch(j) { // 槽位音高；虚拟位返回 null
    var o = SLOT_OFF[((j % 14) + 14) % 14];
    return o < 0 ? null : A0_MIDI + 12 * Math.floor(j / 14) + o;
  }
  function pitchToSlot(m) { // 真实音高 → 槽位（虚拟位无音高不会出现）
    var s = m - A0_MIDI, o = ((s % 12) + 12) % 12;
    return 14 * Math.floor(s / 12) + SEMI_SLOT[o];
  }

  // ---- 物理规格（mm）----
  var PHYS = {
    tapeWidthMM: 200,     // 纸带总宽（21 轨栅格需 20p+D ≈ 176.8mm）
    gearWidthMM: 130,     // 档位宽度 = 窗口全部键宽之和（固定，与 N 无关）
    topStopMidi: 96,      // 顶止点 C7（锚槽 88；窗口 C7..C8 覆盖钢琴全音域）
    holeRadiusMM: 1.25,   // 打孔半径（孔径 2.5mm）
    minHoleC2C: 4.0,      // 孔缘间距 ≥ 1.5mm + 孔径 2.5 → 任意两孔最小孔心距
    edgeMarginMM: 1.5,    // 最外侧孔缘距纸带边
    leadInMM: 15,         // 头部留白
    leadOutMM: 15,        // 尾部留白
    mmPerBeat: 9,         // 每拍走带长度
    minGapMM: 4.0,        // 同轨相邻两孔最小孔心距（拨片约束；孔缘隔 1.5mm 恰达规格）
    stationGapMM: 105,    // 两排滚轮沿走带方向间距
    shiftMs: 400,         // 整档换挡耗时：按下整档键 → 键盘滑动到位
    shiftLeadMs: 600,     // 整档打孔提前量 = 400ms 换挡 + 200ms 余量
    halfShiftMs: 10       // 半音换挡耗时（视为瞬时；链逐列 1 孔）
  };
  var PPB = 4; // 每拍编辑栅格数（col），1 col = 2.25mm

  // ---- 键宽与槽栅（白:黑 = 7:6；档位宽 = N·w + (N-1)·b）----
  PHYS.whiteKeyMM = PHYS.gearWidthMM * 7 / (13 * N_WHITE - 6);  // 910/98 ≈ 9.2857
  PHYS.blackKeyMM = PHYS.whiteKeyMM * 6 / 7;                    // ≈ 7.9592
  PHYS.slotPitchMM = (PHYS.whiteKeyMM + PHYS.blackKeyMM) / 2;   // 13w/14 ≈ 8.6224
  PHYS.rowOffsetMM = PHYS.slotPitchMM / 2;                      // D = 半槽栅 ≈ 4.3112（跨排最小孔心距）
  // 档位带 x0：21 轨栅格（左端 −1b 到右端 +1b 含 D 偏移 = 20p+D）整体居中于纸带宽
  PHYS.bandX0MM = (PHYS.tapeWidthMM - (20 * PHYS.slotPitchMM + PHYS.rowOffsetMM)) / 2
    - (PHYS.whiteKeyMM / 2 - 3 * PHYS.slotPitchMM); // ≈ 32.844（两侧孔缘边距 ≈ 10.4mm）

  // ---- 档位表：锚槽 0 起每档 +14 槽（= 1 个八度，相邻档共享边界槽），末档补 C7 上止点 ----
  var SLOT_STEP = SLOT_COUNT - 1; // 14
  var TOP_SLOT = pitchToSlot(PHYS.topStopMidi);
  var GEAR_SLIDES = (function () {
    var a = [0];
    while (a[a.length - 1] + SLOT_STEP <= TOP_SLOT) a.push(a[a.length - 1] + SLOT_STEP);
    if (a[a.length - 1] !== TOP_SLOT) a.push(TOP_SLOT);
    return a; // [0,14,28,42,56,70,84,88]
  })();
  var GEAR_BASES = GEAR_SLIDES.map(slotPitch); // [A0,A1,A2,A3,A4,A5,A6,C7] = [21,33,45,57,69,81,93,96]
  var W_MAX = GEAR_SLIDES.length - 1;         // 7
  var HOME_PRESSES = Math.ceil(TOP_SLOT / SLOT_STEP); // 7：从任意位置连按 ◀ 钉底 A0

  // ---- 轨位几何（21 轨全上统一槽栅）----
  // lane → 槽栅位置（自档位带左缘的 p 倍数；lane 1..15 = 槽位 0..14）：
  // 0=◀◀（−1p，紧贴档位带左）、16=▶▶（+15p，紧贴右）、17=−1a（−2p）、18=−1b（−3p）、
  // 19=+1a（+16p）、20=+1b（+17p）；下排（row0 主旋律）整排右移 D
  var LANE_GRID_P = (function () {
    var g = {};
    for (var l = 1; l <= SLOT_COUNT; l++) g[l] = l - 1;
    g[0] = -1;
    g[SLOT_COUNT + 1] = 15;  // ▶▶
    g[SLOT_COUNT + 2] = -2;  // −1a
    g[SLOT_COUNT + 3] = -3;  // −1b
    g[SLOT_COUNT + 4] = 16;  // +1a
    g[SLOT_COUNT + 5] = 17;  // +1b
    return g;
  })();
  function laneXMM(row, lane) {
    return PHYS.bandX0MM + PHYS.whiteKeyMM / 2 + LANE_GRID_P[lane] * PHYS.slotPitchMM
      + (row === 0 ? PHYS.rowOffsetMM : 0);
  }
  function isShiftLane(lane) { return lane === 0 || lane >= SLOT_COUNT + 1; } // ◀/▶/4 半音位
  function isHalfLane(lane) { return lane >= SLOT_COUNT + 2; }                // 17..20 = ±1a/±1b
  function halfLaneDir(lane) { return lane >= SLOT_COUNT + 4 ? 1 : -1; }      // +1 升 / −1 降
  // 死轨：锚槽 s 下压在虚拟黑键位上的轨（永不打孔）
  function isDeadLane(lane, s) {
    var t = ((s + lane - 1) % 14 + 14) % 14;
    return t === 3 || t === 9;
  }
  // 锚槽 s 下 lane(1..15) 的实际音高（虚拟位 null）/ 音高在锚槽 s 下的 lane
  function soundingMidi(lane, s) { return slotPitch(s + lane - 1); }
  function laneOfSlot(j, s) { return j - s + 1; }
  // 含 midi 的档位（从 from 向外就近搜索；相邻档共享边界槽）；无解 -1（仅用于显示/历史）
  function gearOfMidi(midi, from) {
    var j = pitchToSlot(midi);
    for (var d = 0; d <= W_MAX; d++) {
      var cands = d === 0 ? [from] : [from + d, from - d];
      for (var i = 0; i < 2; i++) {
        var g = cands[i];
        if (g < 0 || g > W_MAX) continue;
        if (j >= GEAR_SLIDES[g] && j <= GEAR_SLIDES[g] + SLOT_COUNT - 1) return g;
      }
    }
    return -1;
  }
  function gearName(g) { return midiName(GEAR_BASES[g]); }
  // 锚槽显示名：就近档名 + 半音偏移（如 "A2+3"）
  function gearNameFromSlot(s) {
    var g = 0;
    for (var i = 0; i < GEAR_SLIDES.length; i++) if (GEAR_SLIDES[i] <= s) g = i;
    var off = s - GEAR_SLIDES[g];
    return gearName(g) + (off > 0 ? '+' + off : '');
  }

  // ---- 混合换挡：键盘锚槽位置模型 ----
  // 位置 s ∈ [0, TOP_SLOT]：整档键 ±14 槽/按（400ms），半音键 ±1 槽/按（10ms，a/b 双轨交替）。
  // 移动分解 Δ = 14a + b（|b| ≤ 13），按压数 = |a| + |b|；允许过冲回调（如 +13 = 整档+14 − 半音1），
  // 仅当整档落点不出 [0, TOP_SLOT]。
  function decompose(delta, s) {
    var a = Math.trunc(delta / 14), b = delta - 14 * a; // b 与 Δ 同号（或 0）
    if (b > 7) { if (s + 14 * (a + 1) <= TOP_SLOT) { a++; b -= 14; } }
    else if (b < -7) { if (s + 14 * (a - 1) >= 0) { a--; b += 14; } }
    return { whole: a, half: b };
  }
  function pressCount(delta, s) {
    var d = decompose(delta, s);
    return Math.abs(d.whole) + Math.abs(d.half);
  }
  // 覆盖槽区间 [lo, hi] 的最优目标锚槽：合法区间内按压数最少，平手取距当前位最近
  // （纯就近会把音停在窗口边缘，上方伙伴音被迫大量半音按压而钳制；按压数最少
  //   天然偏向整档倍数的锚槽——倍频点无需半音回调；平手取近保半音链时序好安放）
  function bestTarget(lo, hi, s) {
    var a = Math.max(0, hi - (SLOT_COUNT - 1)), b = Math.min(TOP_SLOT, lo);
    if (a > b) return null; // 组跨 > 窗口跨度，无整组解
    var best = null, bestScore = Infinity;
    for (var t = a; t <= b; t++) {
      var score = pressCount(t - s, s) * 1000 + Math.abs(t - s);
      if (score < bestScore) { bestScore = score; best = t; }
    }
    return best;
  }
  // 首音（从底位 s=0 出发）的移动方案：整档 whole 按 + 半音 |half| 按
  function firstMovePlan(midi) {
    var j = pitchToSlot(midi);
    var t = bestTarget(j, j, 0);
    return decompose(t - 0, 0);
  }
  // 孔在带长方向的坐标：下排（主旋律，row0）比同拍上排（和弦，row1）靠带尾 105mm。
  // mmb：本曲每拍毫米数（最密间隔拉长后可能与 PHYS.mmPerBeat 不同），缺省标准值
  function holeYMM(col, row, lane, mmb) {
    return PHYS.leadInMM + (col / PPB) * (mmb || PHYS.mmPerBeat)
      + (row === 0 ? PHYS.stationGapMM : 0);
  }

  // ---- 播放时的键盘位置模型（锚槽 s）----
  // 从孔序列提取每排换挡事件时间线：[[{beat,dir,arrive,half}, ...], [上排...]]（按拍升序）。
  // tempo：变速曲传 makeTempoMap 结果，恒定速度传 BPM 数字（缺省 120）。
  // 整档：dir=±14、arrive=触发拍+400ms；半音：dir=±1、arrive≈触发拍（10ms 视为瞬时）。
  function buildShiftTimeline(holes, tempo) {
    var tm = tempo && tempo.beatToTime ? tempo : null;
    var bpm0 = typeof tempo === 'number' ? tempo : 120;
    function arriveOf(beat, ms) {
      return tm ? tm.timeToBeat(tm.beatToTime(beat) + ms / 1000)
                : beat + (ms / 1000) * bpm0 / 60;
    }
    var tl = [[], []], lastArrive = [0, 0];
    for (var i = 0; i < holes.length; i++) {
      var h = holes[i];
      if (h.row !== 0 && h.row !== 1) continue;
      if (isShiftLane(h.lane)) {
        var beat = (h.col + 0.5) / PPB;
        var half = isHalfLane(h.lane);
        var dir = half ? halfLaneDir(h.lane) : (h.lane === SLOT_COUNT + 1 ? SLOT_STEP : -SLOT_STEP);
        var arrive = half
          ? Math.max(arriveOf(beat, PHYS.halfShiftMs), beat)
          : Math.max(arriveOf(beat, PHYS.shiftMs), beat, lastArrive[h.row]);
        if (!half) lastArrive[h.row] = arrive;
        tl[h.row].push({ beat: beat, dir: dir, arrive: arrive, half: half });
      }
    }
    tl[0].sort(function (a, b) { return a.beat - b.beat; });
    tl[1].sort(function (a, b) { return a.beat - b.beat; });
    return tl;
  }
  // 某排在 beat 时刻的键盘状态：s=锚槽(0..TOP_SLOT)；moving=整档键已触发但键盘尚在滑动（400ms 内）。
  // 物理模型：整档键触发后键盘 400ms 才到位——到位前仍按旧位击发；半音 10ms 瞬时无滑行。
  // 事件按触发拍升序，但到位拍不单调（半音瞬时、整档 400ms 交错）——须扫过全部已触发
  // 事件、按各自到位拍累计，不能在首个未到位事件处早退。
  // s 钳位 [0, TOP_SLOT]：曲首归位连按 ◀ 钉底、越出止点的空按被机械限位吸收。
  function shiftInfoAt(tl, row, beat) {
    var arr = tl[row] || [], s = 0, moving = false, dir = 0;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].beat > beat + 1e-9) break; // 之后才触发的与现在无关
      if (arr[i].arrive <= beat + 1e-9) {
        s += arr[i].dir;
        if (s < 0) s = 0;
        if (s > TOP_SLOT) s = TOP_SLOT;
      } else if (!arr[i].half) {
        moving = true; dir = arr[i].dir;
      }
    }
    return { s: s, moving: moving, dir: dir };
  }
  function shiftAt(tl, row, beat) { return shiftInfoAt(tl, row, beat).s; }

  /**
   * 单排换挡调度（混合换挡）。
   * @param notes [{col, midi}] 按 col 升序（col 为编辑栅格列）
   * @param row  0=下排(主旋律) 1=上排(和弦)
   * @param opts.tempoMap 变速曲速度表（缺省恒定 opts.bpm，再缺省 120）
   * @param opts.home 曲首强制归位：连按 7 次 ◀ 钉底 A0（键盘初始位置不确定）
   * @returns {holes, shifts(整档), halfShifts, clamped, finalS, home, homeOk, rescues}
   * lane: 0=◀◀ 1..15=槽位 16=▶▶ 17=−1a 18=−1b 19=+1a 20=+1b；
   * midi 为该孔在换挡完成后的实际音高（换挡键孔为 null）；
   * serveCol = 该换挡孔所服务的音符列（排产/校验用）
   *
   * 位置模型：锚槽 s ∈ [0, TOP_SLOT]，窗口 [s, s+14]。
   *  - 音符槽 j 在窗口内 → 直接落轨（hysteresis：能不换就不换）
   *  - 越窗 → 目标锚槽就近（升到 j−14 或降到 j），Δ = 14a + b 分解为整档链 + 半音链
   *
   * 整档排产（物理约束）：
   *  1) 到位提前量：触发 + 600ms（硬约束 400ms）≤ 目标音触发
   *  2) 旧位音保护：最后一个旧位音须在到位前触发
   *  3) 连续按动：间隔 ≥ 400ms（lastPressT）
   * 半音排产（10ms 瞬时）：链右对齐到音符列前 1 列、逐列 1 孔，a/b 轨交替
   * （同轨全程 ≥2 列 = 4.5mm）；链须整体落在 [max(minShiftCol, prevCol), col−1]
   * ——半音孔可与上一音同列（同拍触发、+10ms 到位，上一音仍按旧位发音）。
   * 物理放不下 → 钳制（候选跨排救援）。
   */
  function scheduleRow(notes, row, opts) {
    opts = opts || {};
    var tm = opts.tempoMap && opts.tempoMap.beatToTime ? opts.tempoMap : null;
    var bpm0 = opts.bpm || 120;
    var mmb = opts.mmPerBeat || PHYS.mmPerBeat;
    // 换挡键孔允许的最早列（可落在头部留白内，孔缘距纸带头 ≥ edgeMargin）——按本曲 mmPerBeat 折算。
    // 排别：row0（主旋律）孔 y 含 +105mm 站间距，可比 row1（和弦）再前 105mm，快曲升挡不再钳制
    var headMin = PHYS.edgeMarginMM + PHYS.holeRadiusMM; // 孔心距带头的最小值（1.5+1.25 = 2.75）
    var minShiftCol = Math.ceil((headMin - PHYS.leadInMM - (row === 0 ? PHYS.stationGapMM : 0)) / mmb * PPB);
    function tTime(b) { return tm ? tm.beatToTime(b) : b * 60 / bpm0; }
    // 整档键排产（物理约束）：
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
    var holes = [], shifts = [], halfShifts = 0, clamped = 0;
    var rescues = []; // 换挡来不及被钳制的音（候选跨排救援：另一排可能恰在该档）
    var s = 0, prevCol = null, lastPressT = -Infinity;
    var home = 0, homeOk = true, homeBlock = false;
    var nextHalfUp = 19, nextHalfDown = 17; // 半音双轨交替游标（+1a/+1b、−1a/−1b）

    // 曲首强制归位：连按 7 次 ◀ 钉底 A0（间隔 ≥400ms 且同轨孔距 ≥minGapMM）。
    // margin 不只保证"归位完成 ≤ 首音"：首音自身的移动链（整档每按 600ms 提前量、
    // 相邻按动 400ms；半音逐列 1 列/按）必须完整排进 [归位末按, 首音] 区间。
    if (opts.home && notes.length) {
      var secPerCol = (tTime(0.25) - tTime(0)) || 1e-9;
      var vMM = mmb / (secPerCol * PPB); // 头部走带速度 mm/s
      var sCols = Math.max(1, Math.ceil(Math.max(PHYS.shiftMs / 1000, PHYS.minGapMM / vMM) / secPerCol));
      var c0 = minShiftCol + (HOME_PRESSES - 1) * sCols; // 最早布局时末次按动列
      var plan = firstMovePlan(notes[0].midi);
      var margin = PHYS.shiftMs / 1000
        + (plan.whole > 0 ? PHYS.shiftLeadMs / 1000 + (plan.whole - 1) * PHYS.shiftMs / 1000 : 0)
        + Math.abs(plan.half) * secPerCol;
      var tFirst = tTime((notes[0].col + 0.5) / PPB);
      if (tTime((c0 + 0.5) / PPB) + margin <= tFirst + 1e-9) {
        for (var hp = 0; hp < HOME_PRESSES; hp++) {
          holes.push({ row: row, lane: 0, col: minShiftCol + hp * sCols, midi: null, serveCol: notes[0].col });
        }
        home = HOME_PRESSES;
        lastPressT = tTime((c0 + 0.5) / PPB);
      } else {
        homeOk = false; // 调用处顺延整曲重试；重试耗尽仍失败时保留归位孔（键盘绝对位置优先）
      }
    }

    // 同列（同拍）音符组：整组须同窗击发——组内跨度 ≤14 槽时按组选目标锚槽，
    // 否则退化为逐音处理。组按 col 分桶（notes 已按 col 稳定排序，同列连续）。
    var grp = {};
    for (var gi = 0; gi < notes.length; gi++) {
      var gc = notes[gi].col, gj = pitchToSlot(notes[gi].midi);
      if (!grp[gc]) grp[gc] = { jMin: gj, jMax: gj };
      else {
        if (gj < grp[gc].jMin) grp[gc].jMin = gj;
        if (gj > grp[gc].jMax) grp[gc].jMax = gj;
      }
    }

    for (var i = 0; i < notes.length; i++) {
      var col = notes[i].col, midi = notes[i].midi, j = pitchToSlot(midi);
      // 本音须与之同窗的音域范围：组首音且组跨 ≤14 → 整组；否则仅本音
      var g = grp[col];
      var useGroup = prevCol !== col && g.jMax - g.jMin <= SLOT_COUNT - 1;
      var lo = useGroup ? g.jMin : j, hi = useGroup ? g.jMax : j;

      // 1. 全机音域外（低于 A0 / 高于 C8 顶窗）→ 钳制到当前窗口最近真实键
      //    （机械止点 [0, TOP_SLOT]：锚槽出不了界，跨不出去的音就近击发）
      if (j < 0 || j > TOP_SLOT + SLOT_COUNT - 1) {
        clamped++;
        var lc0 = j < 0 ? 1 : SLOT_COUNT;
        var st0 = j < 0 ? 1 : -1;
        while (slotPitch(s + lc0 - 1) === null) lc0 += st0;
        holes.push({ row: row, lane: lc0, col: col, midi: slotPitch(s + lc0 - 1), shift: s });
        prevCol = col;
        continue;
      }

      // 2. 覆盖范围内 → 直接落轨（就近滞回：能不换就不换）
      if (lo >= s && hi <= s + SLOT_COUNT - 1) {
        holes.push({ row: row, lane: j - s + 1, col: col, midi: midi, shift: s });
        prevCol = col;
        continue;
      }

      // 3. 目标锚槽（覆盖 [lo, hi] 的合法区间内取按压数最少者）+ 混合分解 Δ = 14·whole + half
      var target = bestTarget(lo, hi, s);
      var dec = decompose(target - s, s);

      // 整档链（沿用原物理排产；whole=0 则跳过）
      var presses = null;
      if (dec.whole !== 0) {
        var nW = Math.abs(dec.whole);
        var p0 = pressColFor(col, prevCol);
        if (p0 !== null) {
          presses = [p0];
          for (var p = 1; p < nW; p++) {
            var pc = prevPressCol(presses[0]);
            if (pc === null) { presses = null; break; }
            presses.unshift(pc);
          }
          // 链首（最早按动）也须与此前最后一次按动（含归位链）间隔 ≥ 400ms：
          // 不足时整链后移补足；链尾赶不上音符（400ms 硬约束）则放弃换挡改钳制
          if (presses !== null &&
              tTime((presses[0] + 0.5) / PPB) < lastPressT + PHYS.shiftMs / 1000 - 1e-9) {
            var secPerCol2 = (tTime(1) - tTime(0)) / PPB || 1e-9;
            var deficit = Math.ceil((lastPressT + PHYS.shiftMs / 1000 - tTime((presses[0] + 0.5) / PPB)) / secPerCol2);
            for (var dp = 0; dp < presses.length; dp++) presses[dp] += deficit;
            if (tTime((presses[presses.length - 1] + 0.5) / PPB) > tTime((col + 0.5) / PPB) - PHYS.shiftMs / 1000 + 1e-9) {
              presses = null;
              homeBlock = true; // 链被此前按动（多为归位链末按）挤掉：调用处顺延整曲重试
            }
          }
        }
      }

      // 4. 半音链：|half| 个 ±1，右对齐到 col−1 逐列 1 孔；
      //    须 ≥ max(minShiftCol, prevCol)（可与上一音同列：同拍触发 +10ms 到位）
      var rem = Math.abs(dec.half);
      var hDir = dec.half > 0 ? 1 : -1;
      var halfOk = true;
      if (rem > 0) {
        var lo = prevCol === null ? minShiftCol : Math.max(minShiftCol, prevCol);
        if (col - rem < lo) halfOk = false;
      }

      if ((dec.whole !== 0 && presses === null) || !halfOk) {
        // 物理放不下（换挡来不及）→ 钳制到当前窗口最近真实键（跨排救援候选）
        clamped++;
        var lc = j > s + SLOT_COUNT - 1 ? SLOT_COUNT : 1;
        var step = j > s + SLOT_COUNT - 1 ? -1 : 1;
        while (lc >= 1 && lc <= SLOT_COUNT && slotPitch(s + lc - 1) === null) lc += step;
        holes.push({ row: row, lane: lc, col: col, midi: slotPitch(s + lc - 1), shift: s, clamp: true });
        rescues.push({ col: col, midi: midi });
        prevCol = col;
        continue;
      }

      // 5. 落孔：整档链 → 半音链（a/b 交替）→ 音符
      if (presses !== null) {
        var dirW = dec.whole > 0 ? 1 : -1;
        for (var p2 = 0; p2 < presses.length; p2++) {
          var tb = presses[p2];
          shifts.push({ row: row, dir: dirW, col: tb });
          holes.push({ row: row, lane: dirW > 0 ? SLOT_COUNT + 1 : 0, col: tb, midi: null, serveCol: col });
          s += dirW * SLOT_STEP;
        }
        lastPressT = tTime((presses[presses.length - 1] + 0.5) / PPB);
      }
      for (var hq = 0; hq < rem; hq++) {
        var hc = col - rem + hq;
        var hl = hDir > 0 ? nextHalfUp : nextHalfDown;
        if (hDir > 0) nextHalfUp = nextHalfUp === 19 ? 20 : 19;
        else nextHalfDown = nextHalfDown === 17 ? 18 : 17;
        halfShifts++;
        holes.push({ row: row, lane: hl, col: hc, midi: null, serveCol: col });
        s += hDir;
      }
      holes.push({ row: row, lane: j - s + 1, col: col, midi: midi, shift: s });
      prevCol = col;
    }
    return { holes: holes, shifts: shifts, halfShifts: halfShifts, clamped: clamped, finalS: s, home: home, homeOk: homeOk && !homeBlock, rescues: rescues };
  }

  /** 整曲顺延 beats 拍（归位留时间用）：复制并平移 notes / tempos 的 tick。
   *  平移后 [0,Δ] 拍为新增头部：无速度事件时按 opts.bpm 恒速，有速度表时头部按表头默认 120
   *  走带（首事件已随曲平移到 Δ 拍之后），故「平移后首音触发 = Δ·60/V + 原轴时间」精确成立。 */
  function shiftMidiTicks(midi, beats) {
    var d = Math.round(beats * midi.ticksPerBeat);
    var m = { ticksPerBeat: midi.ticksPerBeat, tracks: [], tempos: [] };
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
    return m;
  }

  /**
   * MIDI → 纸带转换（按原音落轨，不做移调）
   * @param midi parseMidi() 结果
   * @param opts { melodyTracks:Set, chordTracks:Set, excludeDrums:bool,
   *               bpm, home:bool（曲首强制归位，默认开） }
   * @returns {holes:[{col,row,lane,midi}], endCol, mmPerBeat, report}
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
      return { holes: [], endCol: 0, mmPerBeat: PHYS.mmPerBeat, report: { noteCount: 0, empty: true } };
    }

    // 2. 速度表 + 最密列间隔探测 → 本曲每拍毫米数（整曲平移不改变列间隔，探测一次）
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

    // 3. 归位顺延（整拍）：每排 need = 头速走带时间(c0) + margin - 原轴首音触发，
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
          if (first === null || col < first.col) first = { col: col, tick: list[i].tick, midi: list[i].note };
        }
        var minShiftCol = Math.ceil((PHYS.edgeMarginMM + PHYS.holeRadiusMM - PHYS.leadInMM - (r === 0 ? PHYS.stationGapMM : 0)) / mmPerBeat * PPB);
        var secPerCol = 60 / V / PPB;
        var vMM = mmPerBeat * V / 60;
        var sCols = Math.max(1, Math.ceil(Math.max(PHYS.shiftMs / 1000, PHYS.minGapMM / vMM) / secPerCol));
        var c0 = minShiftCol + (HOME_PRESSES - 1) * sCols;
        var plan = firstMovePlan(first.midi);
        var margin = PHYS.shiftMs / 1000
          + (plan.whole > 0 ? PHYS.shiftLeadMs / 1000 + (plan.whole - 1) * PHYS.shiftMs / 1000 : 0)
          + Math.abs(plan.half) * secPerCol;
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

    // 4. 整曲顺延 + 核心转换；homeOk 两排不齐则 delay++ 重试（步骤 3 公式已精确，循环仅兜底）
    var out = null;
    for (var attempt = 0; attempt < 4; attempt++) {
      var cur = delay > 0 ? shiftMidiTicks(midi, delay) : midi;
      out = convertCore(cur);
      if (!home || (out.report.homeOk[0] && out.report.homeOk[1])) break;
      delay++;
    }
    out.report.homeDelay = home ? delay : 0;
    return out;

    // ---- 核心转换（原音落轨 → 换挡调度 → 合并去重 → 最小孔距修复 → 孔距守卫）----
    function convertCore(m) {
      var runOpts = {
        tempoMap: makeTempoMap(m.tempos, tpb0), bpm: opts.bpm || 120,
        mmPerBeat: mmPerBeat, home: home
      };

      // 栅格量化（音高原样落轨）
      function toNotes(list) {
        var arr = [];
        for (var i = 0; i < list.length; i++) {
          arr.push({ col: Math.max(0, Math.round(list[i].tick / tpb0 * PPB)), midi: list[i].note });
        }
        arr.sort(function (a, b) { return a.col - b.col; });
        return arr;
      }
      var src = collect(m);
      var melN = toNotes(src.mel), choN = toNotes(src.cho);

      // 换挡调度（每排独立；提前量按该处速度折算 400ms 换挡 + 200ms 余量）
      var rL = scheduleRow(melN, 0, runOpts);
      var rU = scheduleRow(choN, 1, runOpts);

      // 跨排救援：本排换挡来不及被钳制的音，若另一排在同一拍恰好已停在含该音的
      // 档位（无需为其新增换挡），移到另一排击发——两排键盘同构同音色，仅站不同。
      // 救援不改变另一排的换挡轨迹，只借用其当前窗口；移除本排原钳制孔。
      function rescueRow(own, other, ownRow) {
        var n = 0;
        if (!own.rescues || !own.rescues.length) return 0;
        var tl = buildShiftTimeline(other.holes, runOpts.tempoMap || runOpts.bpm || 120);
        for (var i = 0; i < own.rescues.length; i++) {
          var rs = own.rescues[i];
          var s = shiftAt(tl, ownRow === 0 ? 1 : 0, (rs.col + 0.5) / PPB);
          var lane = laneOfSlot(pitchToSlot(rs.midi), s);
          if (lane < 1 || lane > SLOT_COUNT) continue; // 另一排窗内无此音
          var idx = -1;
          for (var h = 0; h < own.holes.length; h++) {
            if (own.holes[h].clamp && own.holes[h].col === rs.col) { idx = h; break; }
          }
          if (idx < 0) continue;
          own.holes.splice(idx, 1);
          own.clamped--;
          other.holes.push({ row: ownRow === 0 ? 1 : 0, lane: lane, col: rs.col, midi: rs.midi, shift: s });
          n++;
        }
        return n;
      }
      var rescued = rescueRow(rL, rU, 0) + rescueRow(rU, rL, 1);

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
      // 音符孔不再后移；换挡键轨在慢速下仍可能微调后移（非乐音，不影响节奏）。
      var gapCols = Math.max(1, Math.ceil(PHYS.minGapMM / (mmPerBeat / PPB) - 1e-9));
      function groupByLane(list) {
        var m3 = {};
        for (var i2 = 0; i2 < list.length; i2++) {
          var k2 = list[i2].row + ':' + list[i2].lane;
          (m3[k2] || (m3[k2] = [])).push(list[i2]);
        }
        return m3;
      }
      // 5a. 换挡键孔（含归位孔）先按各自轨排队，得到最终换挡列
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
          placedKeys.push({ row: kList[ki].row, lane: kList[ki].lane, col: kc, midi: null, serveCol: kList[ki].serveCol });
          kPrev = kc;
        }
      }
      placedKeys.sort(function (a, b) { return a.col - b.col || a.row - b.row || a.lane - b.lane; });
      var bounds = [[], []]; // 每排换挡键最终列（升序）
      for (var bi = 0; bi < placedKeys.length; bi++) bounds[placedKeys[bi].row].push(placedKeys[bi].col);

      // 5b. 音符孔按轨排队 + 档位区间约束
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

      // 5c. 孔缘间距（规格 ≥1.5mm ⟺ 任意两孔孔心 ≥ 4.0mm）由纯几何保证：
      // 跨排同槽位孔对 Δx = D ≈ 4.311、换挡孔 vs 对排端键孔 ≈ 4.732、
      // 同排相邻槽位 Δx = p ≈ 8.622、同轨沿带走带方向 ≥ gapCols·(mmb/PPB) ≥ 4.0
      // —— 无需任何事后微移安全网（N=8 统一槽栅下的结论）。

      var endCol = 0;
      for (var e = 0; e < result.length; e++) if (result[e].col >= 0 && result[e].col + 1 > endCol) endCol = result[e].col + 1;

      return {
        holes: result,
        endCol: endCol,
        mmPerBeat: mmPerBeat,
        report: {
          noteCount: base.mel.length + base.cho.length,
          holeCount: result.length,
          empty: false,
          clamped: rL.clamped + rU.clamped,
          rescued: rescued,
          shifts: [rL.shifts.length, rU.shifts.length],
          halfShifts: [rL.halfShifts, rU.halfShifts],
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
      out.push({ x: laneXMM(h.row, h.lane), y: holeYMM(h.col, h.row, h.lane, mm), row: h.row, lane: h.lane });
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
   * 示例曲《小星星》（D 大调）：下排主旋律 + 上排和弦（D-G-A 进行），混合换挡演示：
   * 曲首两排各整档 4 次到锚槽 56（A4 档）；A5 在窗顶；下排 B5 越窗整档 +1、
   * 回 G5 时整档 −1；上排 B5 和弦越窗 +2 用 2 个半音键（a/b 交替）。
   * 首音空出 3 拍给升挡链留位。
   * @returns {holes, endCol, bpm, shifts}
   */
  function demoSong() {
    var mel = [ // [拍, 音名]
      [3, 'D5'], [4, 'D5'], [5, 'A5'], [6, 'A5'], [7, 'B5'], [8, 'B5'], [9, 'A5'],
      [10, 'G5'], [11, 'G5'], [12, 'F#5'], [13, 'F#5'], [14, 'E5'], [15, 'E5'], [16, 'D5']
    ];
    var cho = [ // 每 2 拍一个三和弦（同拍 3 孔，全部落在 A4 档窗口 56..70 内）
      [3, 'D5'], [3, 'F#5'], [3, 'A5'],
      [5, 'G5'], [5, 'B5'], [5, 'D5'],
      [7, 'D5'], [7, 'F#5'], [7, 'A5'],
      [9, 'G5'], [9, 'B5'], [9, 'D5'],
      [11, 'D5'], [11, 'F#5'], [11, 'A5'],
      [13, 'A5'], [13, 'C#5'], [13, 'E5'],
      [15, 'D5'], [15, 'F#5'], [15, 'A5']
    ];
    function build(list, row) {
      var notes = [];
      for (var i = 0; i < list.length; i++) {
        notes.push({ col: list[i][0] * PPB, midi: nameToMidi(list[i][1]) });
      }
      notes.sort(function (a, b) { return a.col - b.col; });
      return scheduleRow(notes, row, { bpm: 100 }); // 与返回的播放 BPM 一致，提前量按真实速度折算
    }
    var rL = build(mel, 0), rU = build(cho, 1);
    var merged = rL.holes.concat(rU.holes);
    merged.sort(function (a, b) { return a.col - b.col || a.row - b.row || a.lane - b.lane; });
    var endCol = 0;
    for (var j = 0; j < merged.length; j++) if (merged[j].col + 1 > endCol) endCol = merged[j].col + 1;
    return { holes: merged, endCol: endCol, bpm: 100, shifts: [rL.shifts.length, rU.shifts.length], halfShifts: [rL.halfShifts, rU.halfShifts] };
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
    N_WHITE: N_WHITE,
    SLOT_COUNT: SLOT_COUNT,
    LANES_PER_ROW: LANES_PER_ROW,
    SLOT_STEP: SLOT_STEP,
    TOP_SLOT: TOP_SLOT,
    HOME_PRESSES: HOME_PRESSES,
    GEAR_SLIDES: GEAR_SLIDES,
    GEAR_BASES: GEAR_BASES,
    W_MAX: W_MAX,
    midiName: midiName,
    nameToMidi: nameToMidi,
    slotPitch: slotPitch,
    pitchToSlot: pitchToSlot,
    gearName: gearName,
    gearNameFromSlot: gearNameFromSlot,
    laneXMM: laneXMM,
    holeYMM: holeYMM,
    isShiftLane: isShiftLane,
    isHalfLane: isHalfLane,
    halfLaneDir: halfLaneDir,
    isDeadLane: isDeadLane,
    laneOfSlot: laneOfSlot,
    gearOfMidi: gearOfMidi,
    decompose: decompose,
    firstMovePlan: firstMovePlan,
    soundingMidi: soundingMidi,
    buildShiftTimeline: buildShiftTimeline,
    shiftAt: shiftAt,
    shiftInfoAt: shiftInfoAt,
    tapeLenMM: tapeLenMM,
    scheduleRow: scheduleRow,
    convertFromMidi: convertFromMidi,
    exportGeometry: exportGeometry,
    demoSong: demoSong,
    makeTempoMap: makeTempoMap,
    buildTempoMap: buildTempoMap
  };
})(typeof window !== 'undefined' ? window : globalThis);
