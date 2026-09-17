/* ============================================================
 * 纸带钢琴打孔程序 - 纸带数据模型与 MIDI 转换管线
 *
 * 机械模型（依据 纸带钢琴规格.md，N=8 虚拟黑键槽位模型）：
 *  - 键盘简化为完美均匀槽栅：每两个白键之间必有一个黑键位（E-F、B-C 间
 *    无真实黑键处插虚拟黑键占位），白:黑键宽 = 7:6
 *  - 每档 N=8 白键：窗口 2N-1 = 15 槽 = 13 个真实键 + 2 虚拟位；
 *    虚拟位也配占位滚轮（非 A 锚档位压真实键），压在虚拟位上的轨为
 *    死轨（该档永不打孔，isDeadLane 按档判定）
 *  - 档位宽度 130mm = N·w + (N-1)·b → w = 910/98 ≈ 9.286，b = 6w/7 ≈ 7.959；
 *    槽栅距 p = (w+b)/2 = 13w/14 ≈ 8.622mm（同排孔缘隔 6.12mm ≥ 1.5mm ✓）
 *  - 槽栅周期 14 槽 = 一个八度；档位步进 14 槽（相邻档共享边界槽），
 *    档位表锚槽 [0,14,28,42,56,70,84,88] = A0,A1,A2,A3,A4,A5,A6,C7
 *    （每档恰好跨一个八度；末档 C7 为上止点补丁档，窗口 C7..C8，覆盖钢琴全音域）
 *  - 每排 17 滚轮：lane 0 = ◀◀、lane 1..15 = 槽 0..14、lane 16 = ▶▶；
 *    换挡滚轮在档位宽度外 shiftGapMM=4.4 处
 *  - 下排（主旋律 row0）整排右移 D = p/2 ≈ 4.311mm：两排在同一槽栅上，
 *    跨排键孔对最小孔心距 = D ≈ 4.311mm ≥ 4.0mm（孔缘 1.5mm 规格；含列量化
 *    Δy ≥ 0.75mm 的斜距 ≈ 4.376mm ✓；换挡孔 vs 对排端键孔 ≈ 4.732mm ✓）。
 *    统一槽栅下纯 x 几何即满足全孔距规格，无需任何微移安全网
 *  - 孔缘间距规格 1.5mm（任意两孔孔心 ≥ 4.0mm）、孔缘距带边 1.5mm
 *  - 换挡耗时 400ms（触发 → 键盘滑动到位，到位前仍按旧挡击发）、
 *    打孔提前量 600ms；曲首强制归位：连按 3 次 ◀ 钉底 A0
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
  var SLOT_COUNT = 2 * N_WHITE - 1;       // 15 槽/档（13 真实键 + 2 虚拟位）
  var LANES_PER_ROW = SLOT_COUNT + 2;     // ◀ + 15 槽 + ▶ = 17 滚轮/排
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
    tapeWidthMM: 150,     // 纸带总宽
    gearWidthMM: 130,     // 档位宽度 = 窗口全部键宽之和（固定，与 N 无关）
    topStopMidi: 96,      // 最高档 C7（机械上止点；窗口 C7..C8 覆盖钢琴全音域）
    holeRadiusMM: 1.25,   // 打孔半径（孔径 2.5mm）
    minHoleC2C: 4.0,      // 孔缘间距 ≥ 1.5mm + 孔径 2.5 → 任意两孔最小孔心距
    edgeMarginMM: 1.5,    // 最外侧孔缘距纸带边
    leadInMM: 15,         // 头部留白
    leadOutMM: 15,        // 尾部留白
    mmPerBeat: 9,         // 每拍走带长度
    minGapMM: 4.0,        // 同轨相邻两孔最小孔心距（拨片约束；孔缘隔 1.5mm 恰达规格）
    stationGapMM: 105,    // 两排滚轮沿走带方向间距
    shiftMs: 400,         // 换挡耗时：按下换挡键 → 键盘滑动到位
    shiftLeadMs: 600,     // 打孔提前量 = 400ms 换挡 + 200ms 余量
    // 换挡滚轮中心距档位边 c=4.4：换挡孔 vs 对排端键孔孔心距 ≈ 4.732 ≥ 4.0，
    // 两排换挡孔对 Δx = D ≈ 4.311 ✓ —— 纯 x 几何即满足全孔距规格
    shiftGapMM: 4.4
  };
  var PPB = 4; // 每拍编辑栅格数（col），1 col = 2.25mm

  // ---- 键宽与槽栅（白:黑 = 7:6；档位宽 = N·w + (N-1)·b）----
  PHYS.whiteKeyMM = PHYS.gearWidthMM * 7 / (13 * N_WHITE - 6);  // 910/98 ≈ 9.2857
  PHYS.blackKeyMM = PHYS.whiteKeyMM * 6 / 7;                    // ≈ 7.9592
  PHYS.slotPitchMM = (PHYS.whiteKeyMM + PHYS.blackKeyMM) / 2;   // 13w/14 ≈ 8.6224
  PHYS.rowOffsetMM = PHYS.slotPitchMM / 2;                      // D = 半槽栅 ≈ 4.3112（跨排最小孔心距）
  // 档位带在纸带上的 x0：换挡轮（两侧 shiftGap）+ D 偏移整体居中于 150mm
  PHYS.bandX0MM = (PHYS.tapeWidthMM - (2 * PHYS.shiftGapMM + PHYS.gearWidthMM + PHYS.rowOffsetMM)) / 2
    + PHYS.shiftGapMM; // ≈ 7.8444（最外孔缘距带边 ≈ 2.19mm ≥ 1.5mm ✓）

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

  // ---- 轨位几何 ----
  // lane 0 = ◀◀（档位宽左外 shiftGap）、lane 1..15 = 槽 0..14（键心在档位带内）、
  // lane 16 = ▶▶（右外 shiftGap）；下排（row0 主旋律）整排右移 D
  function laneXMM(row, lane) {
    var x = lane === 0 ? -PHYS.shiftGapMM
      : lane === LANES_PER_ROW - 1 ? PHYS.gearWidthMM + PHYS.shiftGapMM
      : PHYS.whiteKeyMM / 2 + (lane - 1) * PHYS.slotPitchMM;
    return PHYS.bandX0MM + x + (row === 0 ? PHYS.rowOffsetMM : 0);
  }
  function isShiftLane(lane) { return lane === 0 || lane === LANES_PER_ROW - 1; }
  // 死轨：该档位下压在虚拟黑键位上的轨（永不打孔）
  function isDeadLane(lane, gear) {
    var s = ((GEAR_SLIDES[gear] + lane - 1) % 14 + 14) % 14;
    return s === 3 || s === 9;
  }
  // 档位 g 下 lane(1..15) 的实际音高（虚拟位 null）/ 音高在档位 g 下的 lane
  function soundingMidi(lane, gear) { return slotPitch(GEAR_SLIDES[gear] + lane - 1); }
  function laneOfMidi(midi, gear) { return pitchToSlot(midi) - GEAR_SLIDES[gear] + 1; }
  // 含 midi 的档位（从 from 向外就近搜索；相邻档共享边界槽）；无解 -1
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
  // 首音从归位底档（0）出发需要连按 ▶ 的次数；不可达（越出全档位音域）返回 0
  function firstPressCount(midi) {
    var g = gearOfMidi(midi, 0);
    return g > 0 ? g : 0;
  }
  // 孔在带长方向的坐标：下排（主旋律，row0）比同拍上排（和弦，row1）靠带尾 105mm。
  // mmb：本曲每拍毫米数（最密间隔拉长后可能与 PHYS.mmPerBeat 不同），缺省标准值
  function holeYMM(col, row, lane, mmb) {
    return PHYS.leadInMM + (col / PPB) * (mmb || PHYS.mmPerBeat)
      + (row === 0 ? PHYS.stationGapMM : 0);
  }

  // ---- 播放时的键盘挡位模型 ----
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

  /**
   * 单排换挡调度。
   * @param notes [{col, midi}] 按 col 升序（col 为编辑栅格列）
   * @param row  0=下排(主旋律) 1=上排(和弦)
   * @param opts.tempoMap 变速曲速度表（缺省恒定 opts.bpm，再缺省 120）
   * @param opts.home 曲首强制归位：连按 3 次 ◀ 钉底到初始档位 A0（键盘初始位置不确定）
   * @returns {holes:[{row,lane,col,midi,serveCol}], shifts:[{row,dir,col}], clamped, finalW, home, homeOk}
   * lane: 0=换挡键 ◀◀ 1..15=槽位 16=换挡键 ▶▶；midi 为该孔在换挡完成后的实际音高
   * （换挡键孔为 null）；serveCol = 该换挡孔所服务的音符列（排产/校验用）
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
    // 换挡键孔允许的最早列（可落在头部留白内，孔缘距纸带头 ≥ edgeMargin）——按本曲 mmPerBeat 折算。
    // 排别：row0（主旋律）孔 y 含 +105mm 站间距，可比 row1（和弦）再前 105mm，快曲升挡不再钳制
    var headMin = PHYS.edgeMarginMM + PHYS.holeRadiusMM; // 孔心距带头的最小值（1.5+1.25 = 2.75）
    var minShiftCol = Math.ceil((headMin - PHYS.leadInMM - (row === 0 ? PHYS.stationGapMM : 0)) / mmb * PPB);
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
    var rescues = []; // 换挡来不及被钳制的音（候选跨排救援：另一排可能恰在该档）
    var w = 0, prevCol = null, lastPressT = -Infinity;
    var home = 0, homeOk = true, homeBlock = false;

    // 曲首强制归位：连按 3 次 ◀ 钉底到 A0（间隔 ≥400ms 且同轨孔距 ≥minGapMM）。
    // margin 不只保证"归位完成 ≤ 首音"：首音自身要升挡时，其换挡链（每按 600ms 提前量、
    // 相邻按动间隔 400ms）必须完整排进 [归位末按, 首音] 区间，否则归位会挤掉首音的升挡键。
    if (opts.home && notes.length) {
      var secPerCol = (tTime(0.25) - tTime(0)) || 1e-9;
      var vMM = mmb / (secPerCol * PPB); // 头部走带速度 mm/s
      var sCols = Math.max(1, Math.ceil(Math.max(PHYS.shiftMs / 1000, PHYS.minGapMM / vMM) / secPerCol));
      var c0 = minShiftCol + 2 * sCols; // 最早布局时末次按动列
      var nPress = firstPressCount(notes[0].midi);
      var margin = PHYS.shiftMs / 1000
        + (nPress > 0 ? PHYS.shiftLeadMs / 1000 + (nPress - 1) * PHYS.shiftMs / 1000 : 0);
      var tFirst = tTime((notes[0].col + 0.5) / PPB);
      if (tTime((c0 + 0.5) / PPB) + margin <= tFirst + 1e-9) {
        for (var hp = 0; hp < 3; hp++) {
          holes.push({ row: row, lane: 0, col: minShiftCol + hp * sCols, midi: null, serveCol: notes[0].col });
        }
        home = 3;
        lastPressT = tTime((c0 + 0.5) / PPB);
      } else {
        homeOk = false; // 调用处顺延整曲重试；重试耗尽仍失败时保留归位孔（键盘绝对位置优先）
      }
    }

    for (var i = 0; i < notes.length; i++) {
      var col = notes[i].col, midi = notes[i].midi;

      // 1. 找可行档位（按离当前挡的距离向外搜索；相邻档共享边界槽，就近命中可免于换挡）
      var target = gearOfMidi(midi, w);

      // 2. 全档位音域外（低于 A0 或高于顶档窗口）→ 钳制到当前窗口最近键
      //    （钳制结果必落 lane 1 或 15——锚槽与末槽恒为真实键，无死轨问题）
      if (target === -1) {
        clamped++;
        var lc = Math.max(1, Math.min(SLOT_COUNT, laneOfMidi(midi, w)));
        holes.push({ row: row, lane: lc, col: col, midi: soundingMidi(lc, w), shift: w });
        prevCol = col;
        continue;
      }

      // 3. 换挡（可能逐档多按）；按物理约束求按动列，无解则钳制
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
          // 链首（最早按动）也须与此前最后一次按动（含归位链）间隔 ≥ 400ms：
          // 不足时整链后移补足；链尾赶不上音符（400ms 硬约束）则放弃换挡改钳制
          if (presses !== null &&
              tTime((presses[0] + 0.5) / PPB) < lastPressT + PHYS.shiftMs / 1000 - 1e-9) {
            var secPerCol = (tTime(1) - tTime(0)) / PPB || 1e-9;
            var deficit = Math.ceil((lastPressT + PHYS.shiftMs / 1000 - tTime((presses[0] + 0.5) / PPB)) / secPerCol);
            for (var dp = 0; dp < presses.length; dp++) presses[dp] += deficit;
            if (tTime((presses[presses.length - 1] + 0.5) / PPB) > tTime((col + 0.5) / PPB) - PHYS.shiftMs / 1000 + 1e-9) {
              presses = null;
              homeBlock = true; // 链被此前按动（多为归位链末按）挤掉：调用处顺延整曲重试
            }
          }
        }
        if (presses === null) { // 物理放不下（换挡来不及），放弃换挡改钳制
          clamped++;
          var lc2 = Math.max(1, Math.min(SLOT_COUNT, laneOfMidi(midi, w)));
          holes.push({ row: row, lane: lc2, col: col, midi: soundingMidi(lc2, w), shift: w, clamp: true });
          rescues.push({ col: col, midi: midi });
          prevCol = col;
          continue;
        }
        var dir = target > w ? 1 : -1;
        for (var p2 = 0; p2 < presses.length; p2++) {
          var tb = presses[p2];
          shifts.push({ row: row, dir: dir, col: tb });
          holes.push({ row: row, lane: dir > 0 ? LANES_PER_ROW - 1 : 0, col: tb, midi: null, serveCol: col });
          w += dir;
        }
        lastPressT = tTime((presses[presses.length - 1] + 0.5) / PPB);
      }

      holes.push({ row: row, lane: laneOfMidi(midi, w), col: col, midi: midi, shift: w });
      prevCol = col;
    }
    return { holes: holes, shifts: shifts, clamped: clamped, finalW: w, home: home, homeOk: homeOk && !homeBlock, rescues: rescues };
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
        var c0 = minShiftCol + 2 * sCols;
        var nPress = firstPressCount(first.midi);
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
          var lane = laneOfMidi(rs.midi, s);
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
   * 示例曲《小星星》（D 大调）：下排主旋律 + 上排和弦（D-G-A 进行），整体在 A4/A5 档
   * （档位窗口跨整八度，D5/F#5/A5/G5 等全部落在 g4 窗 56..70 内，仅 B5 需升 1 档到 g5）：
   * 曲首两排各留 3 拍给升挡链（100bpm 下链 [-1,2,5,8]），下排 B5 处再升 1 次、
   * 回 G5 时降 1 次，演示双向换挡调度
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
    N_WHITE: N_WHITE,
    SLOT_COUNT: SLOT_COUNT,
    LANES_PER_ROW: LANES_PER_ROW,
    GEAR_SLIDES: GEAR_SLIDES,
    GEAR_BASES: GEAR_BASES,
    W_MAX: W_MAX,
    midiName: midiName,
    nameToMidi: nameToMidi,
    slotPitch: slotPitch,
    pitchToSlot: pitchToSlot,
    gearName: gearName,
    laneXMM: laneXMM,
    holeYMM: holeYMM,
    isShiftLane: isShiftLane,
    isDeadLane: isDeadLane,
    laneOfMidi: laneOfMidi,
    gearOfMidi: gearOfMidi,
    firstPressCount: firstPressCount,
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
