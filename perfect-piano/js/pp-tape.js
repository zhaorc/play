/* ============================================================
 * 纸带钢琴打孔程序 - 纸带数据模型与 MIDI 转换管线
 *
 * 机械模型（依据 纸带钢琴.txt + 实物图片说明）：
 *  - 双排键盘各 14 白键，初始窗口 C4..B5；换挡键（◀◀/▶▶）每次移动 14 白键（2 个八度），
 *    换挡耗时 400ms（按下换挡键 → 键盘滑动到位）；到位前该排仍按旧挡击发
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
    shiftLeadMs: 600,     // 打孔提前量 = 400ms 换挡 + 200ms 余量（孔位量化 + 机械响应）
    maxShift: 1           // 换挡挡位范围 ±1 → 可奏白键 C2..B7
  };
  var PPB = 4; // 每拍编辑栅格数（col），1 col = 2.25mm

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
  // 某排在 beat 时刻的键盘状态：s=挡位；moving=换挡键已触发但键盘尚在滑动（400ms 内）。
  // 物理模型：换挡键触发后键盘 400ms 才到位——到位前仍按旧挡击发，故与换挡键同拍的
  // 音符照旧挡发音；到位后新挡才生效。
  function shiftInfoAt(tl, row, beat) {
    var arr = tl[row] || [], s = 0;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].arrive <= beat + 1e-9) { s += arr[i].dir; continue; }
      if (arr[i].beat <= beat + 1e-9) return { s: s, moving: true, dir: arr[i].dir };
      break;
    }
    return { s: s, moving: false, dir: 0 };
  }
  function shiftAt(tl, row, beat) { return shiftInfoAt(tl, row, beat).s; }
  // 键位 lane(1..14) 在指定挡位下击发的实际 MIDI 音高
  function soundingMidi(lane, shift) {
    return whiteToMidi(14 * shift + lane - 1);
  }

  // ---- 自动移调：12 个半音平移中挑"白键最多 + 跨度可达"的调 ----
  function autoTranspose(notes) {
    var best = 0, bestScore = -Infinity;
    for (var s = -6; s <= 6; s++) {
      var score = 0, minWi = Infinity, maxWi = -Infinity;
      for (var i = 0; i < notes.length; i++) {
        var m = notes[i].note + s;
        var r = noteToWhite(m);
        score += r.black ? 0.3 : 2;
        if (r.wi < minWi) minWi = r.wi;
        if (r.wi > maxWi) maxWi = r.wi;
      }
      var reach = 14 * (2 * PHYS.maxShift + 1); // 挡位可覆盖的白键跨度
      if (maxWi - minWi > reach) score -= (maxWi - minWi - reach) * 2;
      score -= Math.abs(s) * 0.01; // 平分时偏向不移调
      if (score > bestScore + 1e-9) { bestScore = score; best = s; }
    }
    return best;
  }

  /**
   * 单排换挡调度。
   * @param notes [{col, wi}] 按 col 升序（col 为编辑栅格列）
   * @param row  0=下排(主旋律) 1=上排(和弦)
   * @param opts.tempoMap 变速曲速度表（缺省恒定 opts.bpm，再缺省 120）
   * @returns {holes:[{row,lane,col,midi}], shifts:[{row,dir,col}], clamped, finalW}
   * lane: 0=换挡键 ◀◀ 1..14=白键 15=换挡键 ▶▶；midi 为该孔在换挡完成后的实际音高（换挡键孔为 null）
   *
   * 换挡提前量（物理）：换挡键孔触发 + shiftLeadMs(600ms) ≤ 目标音符触发——
   * 键盘 400ms 滑动到位 + 200ms 余量，按孔位处的走带速度折算成列数。
   * 连续多次按动：上一按触发 + shiftMs(400ms)（换挡完成）后才允许下一按触发。
   */
  function scheduleRow(notes, row, opts) {
    var maxShift = opts.maxShift != null ? opts.maxShift : PHYS.maxShift;
    var tm = opts.tempoMap && opts.tempoMap.beatToTime ? opts.tempoMap : null;
    var bpm0 = opts.bpm || 120;
    var mmb = opts.mmPerBeat || PHYS.mmPerBeat;
    // 换挡键孔允许的最早列（可落在头部留白内，但不越过纸带头 2mm）——按本曲 mmPerBeat 折算
    var minShiftCol = Math.floor((2 - PHYS.leadInMM) / mmb * PPB);
    function tTime(b) { return tm ? tm.beatToTime(b) : b * 60 / bpm0; }
    // 目标音前最晚可打换挡键的列：触发 + shiftLeadMs ≤ 目标音符触发
    function pressColFor(noteCol) {
      var limit = tTime((noteCol + 0.5) / PPB) - PHYS.shiftLeadMs / 1000;
      var c = noteCol - 1;
      while (c >= minShiftCol && tTime((c + 0.5) / PPB) > limit + 1e-9) c--;
      return c;
    }
    // 在 refCol 之前、与 refCol 触发间隔 ≥ shiftMs 的最晚列（多次连续按动用）
    function prevPressCol(refCol) {
      var limit = tTime((refCol + 0.5) / PPB) - PHYS.shiftMs / 1000;
      var c = refCol - 1;
      while (c >= minShiftCol && tTime((c + 0.5) / PPB) > limit + 1e-9) c--;
      return c;
    }
    var holes = [], shifts = [], clamped = 0;
    var w = 0, prevCol = null;
    for (var i = 0; i < notes.length; i++) {
      var col = notes[i].col, wi = notes[i].wi;

      // 1. 找可行挡位（按离当前挡的距离搜索；越界方向优先）
      var target = null;
      for (var d = 0; d <= maxShift && target === null; d++) {
        var cands = d === 0 ? [w]
          : (wi >= 14 * w + 14 ? [w + d, w - d] : [w - d, w + d]);
        for (var c = 0; c < cands.length; c++) {
          var wp = cands[c];
          if (wp < -maxShift || wp > maxShift) continue;
          var ln = wi - 14 * wp + 1;
          if (ln >= 1 && ln <= 14) { target = wp; break; }
        }
      }

      // 2. 挡位范围内仍不可达 → 钳制到当前窗口最近键
      if (target === null) {
        clamped++;
        var lc = Math.max(1, Math.min(14, wi - 14 * w + 1));
        holes.push({ row: row, lane: lc, col: col, midi: whiteToMidi(14 * w + lc - 1), shift: w });
        prevCol = col;
        continue;
      }

      // 3. 换挡（可能逐挡多按）；最后一按须在目标音前 shiftLeadMs 触发，整串须在上一音之后
      if (target !== w) {
        var nPress = Math.abs(target - w);
        var presses = [pressColFor(col)];
        for (var p = 1; p < nPress; p++) presses.unshift(prevPressCol(presses[0]));
        var t0 = presses[0], tLast = presses[nPress - 1];
        var noRoom = (tLast < minShiftCol) ||
          (prevCol !== null && (t0 < prevCol || tLast < prevCol));
        if (noRoom) { // 与上一音间隔不足，放弃换挡改钳制
          clamped++;
          var lc2 = Math.max(1, Math.min(14, wi - 14 * w + 1));
          holes.push({ row: row, lane: lc2, col: col, midi: whiteToMidi(14 * w + lc2 - 1), shift: w });
          prevCol = col;
          continue;
        }
        var dir = target > w ? 1 : -1;
        for (var p2 = 0; p2 < nPress; p2++) {
          var tb = presses[p2];
          shifts.push({ row: row, dir: dir, col: tb });
          holes.push({ row: row, lane: dir > 0 ? 15 : 0, col: tb, midi: null });
          w += dir;
        }
      }

      holes.push({ row: row, lane: wi - 14 * w + 1, col: col, midi: whiteToMidi(wi), shift: w });
      prevCol = col;
    }
    return { holes: holes, shifts: shifts, clamped: clamped, finalW: w };
  }

  /**
   * MIDI → 纸带转换
   * @param midi parseMidi() 结果
   * @param opts { melodyTracks:Set, chordTracks:Set, excludeDrums:bool,
   *               transpose:'auto'|number, shiftRestBeats, maxShift }
   * @returns {holes:[{col,row,lane,midi}], endCol, transpose, report}
   */
  function convertFromMidi(midi, opts) {
    opts = opts || {};
    var tpb = midi.ticksPerBeat;

    // 1. 收集两排音符
    var mel = [], cho = [];
    for (var t = 0; t < midi.tracks.length; t++) {
      var tr = midi.tracks[t];
      for (var n = 0; n < tr.notes.length; n++) {
        var nt = tr.notes[n];
        if (opts.excludeDrums !== false && nt.channel === 9) continue;
        if (opts.melodyTracks && opts.melodyTracks.has(t)) mel.push(nt);
        if (opts.chordTracks && opts.chordTracks.has(t)) cho.push(nt);
      }
    }
    if (!mel.length && !cho.length) {
      return { holes: [], endCol: 0, transpose: 0, report: { noteCount: 0, empty: true } };
    }

    // 2. 全曲统一移调（两排保持一致）
    var all = mel.concat(cho);
    var s = opts.transpose === 'auto' ? autoTranspose(all) : (opts.transpose | 0);

    // 3. 白键化 + 栅格量化（黑键就近映射白键，同距取低）
    function toNotes(list) {
      var arr = [], blackN = 0;
      for (var i = 0; i < list.length; i++) {
        var m = list[i].note + s;
        var r = noteToWhite(m);
        if (r.black) blackN++;
        var col = Math.max(0, Math.round(list[i].tick / tpb * PPB));
        arr.push({ col: col, wi: r.wi });
      }
      arr.sort(function (a, b) { return a.col - b.col; });
      return { notes: arr, black: blackN };
    }
    var melR = toNotes(mel), choR = toNotes(cho);

    // 3.5 按最密集孔位间隔自动拉长纸带（节奏零失真方案）：
    //     探测每排相邻音符孔的最小列间隔（同拍和弦 col 差 0 跳过；换挡键由调度按
    //     时间保证间隔，不参与探测），若换算物理孔距 < minGapMM，则放大本曲每拍毫米数
    //     mmPerBeat，使最密处恰好满足最小孔距——所有音符保持原拍位不后移、不舍弃，
    //     代价只是纸带变长（拉长倍率写入 report.scale）。
    //     探测须在换挡调度前完成：调度参数（换挡键最早列等）都要按拉长后的毫米数折算。
    var minGapCols = Infinity;
    // 按排分组探测（mel→row0 下排主旋律，cho→row1 上排和弦），toNotes 已按 col 升序
    function probeRow(list) {
      for (var i = 1; i < list.length; i++) {
        var gap = list[i].col - list[i - 1].col;
        if (gap > 0 && gap < minGapCols) minGapCols = gap;
      }
    }
    probeRow(melR.notes);
    probeRow(choR.notes);
    if (minGapCols === Infinity) minGapCols = PPB; // 单孔整曲无约束
    var mmPerBeat = PHYS.mmPerBeat;
    var needMM = PHYS.minGapMM * PPB / minGapCols;
    if (needMM > mmPerBeat) mmPerBeat = Math.ceil(needMM * 2) / 2; // 向上取整到 0.5mm
    opts.mmPerBeat = mmPerBeat; // scheduleRow 的换挡键最早列按拉长后的毫米数折算

    // 4. 换挡调度（每排独立；提前量按该处速度折算 400ms 换挡 + 200ms 余量）
    var tempoMap = makeTempoMap(midi.tempos, tpb);
    opts.tempoMap = tempoMap;
    opts.bpm = opts.bpm || 120;
    var rL = scheduleRow(melR.notes, 0, opts);
    var rU = scheduleRow(choR.notes, 1, opts);

    // 5. 合并 + 同拍同轨去重
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

    // 6. 同轨最小孔距修复（按 row+lane 分组独立后移）。
    //    换挡键孔先排，它们的最终列就是键盘挡位边界；音符孔后移时不得越过自己发声挡位的
    //    右边界——键盘移走后旧挡孔才到站必成错音，物理打不下时舍弃该孔（计入报告）。
    //    换挡键触发 +400ms 才到位：触发到到位之间该排键盘在滑动，旧挡音越界孔
    //    （触发晚于换挡键）同样被 hi 规则舍弃，故换挡过渡区天然无音符孔。
    //    拉长后的 mmPerBeat 下，同轨音符原始间隔全部 ≥ gapCols（=探测的最密间隔），
    //    音符孔不再后移；换挡键轨（6a）在慢速下仍可能微调后移（非乐音，不影响节奏）。
    var gapCols = Math.max(1, Math.ceil(PHYS.minGapMM / (mmPerBeat / PPB) - 1e-9));
    function groupByLane(list) {
      var m = {};
      for (var i = 0; i < list.length; i++) {
        var k = list[i].row + ':' + list[i].lane;
        (m[k] || (m[k] = [])).push(list[i]);
      }
      return m;
    }
    // 6a. 换挡键孔先按各自轨排队，得到最终换挡列
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

    // 6b. 音符孔按轨排队 + 挡位区间约束
    var result = placedKeys.slice();
    var pushed = 0, maxPush = 0, dropped = 0;
    var noteGroups = groupByLane(noteHoles);
    for (var ng in noteGroups) {
      var gList = noteGroups[ng], gPrev = -Infinity;
      for (var gi = 0; gi < gList.length; gi++) {
        var nh = gList[gi], out = nh.col;
        if (gPrev > -Infinity && out - gPrev < gapCols) out = gPrev + gapCols;
        // 右边界：第一个最终列 ≥ 原列的同排换挡键（允许同列：同拍仍按移动前键盘击发）
        var hi = Infinity, seq = bounds[nh.row];
        for (var qi = 0; qi < seq.length; qi++) {
          if (seq[qi] >= nh.col) { hi = seq[qi]; break; }
        }
        if (out > hi) { dropped++; continue; } // 越过换挡点：舍弃，不占轨位
        if (out !== nh.col) {
          pushed++;
          if (out - nh.col > maxPush) maxPush = out - nh.col;
        }
        result.push({ col: out, row: nh.row, lane: nh.lane, midi: nh.midi });
        gPrev = out;
      }
    }
    result.sort(function (a, b) { return a.col - b.col || a.row - b.row || a.lane - b.lane; });

    var endCol = 0;
    for (var e = 0; e < result.length; e++) if (result[e].col >= 0 && result[e].col + 1 > endCol) endCol = result[e].col + 1;

    return {
      holes: result,
      endCol: endCol,
      transpose: s,
      mmPerBeat: mmPerBeat,
      report: {
        noteCount: all.length,
        holeCount: result.length,
        empty: false,
        blackMapped: melR.black + choR.black,
        clamped: rL.clamped + rU.clamped,
        shifts: [rL.shifts.length, rU.shifts.length],
        pushedNotes: pushed,
        dropped: dropped,
        maxPushCols: maxPush,
        scale: mmPerBeat / PHYS.mmPerBeat
      }
    };
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
    return { wMM: PHYS.tapeWidthMM, hMM: tapeLenMM(endCol), holes: out, beatYs: beatYs, laneXs: laneXs };
  }

  /**
   * 示例曲《小星星》：下排主旋律 + 上排和弦（C-F-G 进行），全部落在基础窗口
   * @returns {holes, endCol, bpm}
   */
  function demoSong() {
    var mel = [ // [col 拍, 音名]
      [0, 'C4'], [1, 'C4'], [2, 'G4'], [3, 'G4'], [4, 'A4'], [5, 'A4'], [6, 'G4'],
      [8, 'F4'], [9, 'F4'], [10, 'E4'], [11, 'E4'], [12, 'D4'], [13, 'D4'], [14, 'C4']
    ];
    var cho = [ // 每 2 拍一个三和弦（分解为同拍 3 孔）
      [0, 'C4'], [0, 'E4'], [0, 'G4'],
      [2, 'C4'], [2, 'E4'], [2, 'G4'],
      [4, 'F4'], [4, 'A4'], [4, 'C5'],
      [6, 'G4'], [6, 'B4'], [6, 'D5'],
      [8, 'F4'], [8, 'A4'], [8, 'C5'],
      [10, 'C4'], [10, 'E4'], [10, 'G4'],
      [12, 'G4'], [12, 'B4'], [12, 'D5'],
      [14, 'C4'], [14, 'E4'], [14, 'G4']
    ];
    function build(list, row) {
      var notes = [];
      for (var i = 0; i < list.length; i++) {
        notes.push({ col: list[i][0] * PPB, wi: noteNameToWi(list[i][1]) });
      }
      notes.sort(function (a, b) { return a.col - b.col; });
      return scheduleRow(notes, row, {});
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
    WHITE_PC: WHITE_PC,
    isWhite: isWhite,
    whiteIndexOf: whiteIndexOf,
    noteToWhite: noteToWhite,
    whiteToMidi: whiteToMidi,
    whiteName: whiteName,
    noteNameToWi: noteNameToWi,
    laneXMM: laneXMM,
    holeYMM: holeYMM,
    isShiftLane: isShiftLane,
    buildShiftTimeline: buildShiftTimeline,
    shiftAt: shiftAt,
    shiftInfoAt: shiftInfoAt,
    soundingMidi: soundingMidi,
    tapeLenMM: tapeLenMM,
    autoTranspose: autoTranspose,
    scheduleRow: scheduleRow,
    convertFromMidi: convertFromMidi,
    exportGeometry: exportGeometry,
    demoSong: demoSong,
    makeTempoMap: makeTempoMap,
    buildTempoMap: buildTempoMap
  };
})(typeof window !== 'undefined' ? window : globalThis);
