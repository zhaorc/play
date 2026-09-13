/* ============================================================
 * 完美钢琴纸带打孔工作室 - 主程序
 * 物理纸带渲染（Canvas 虚拟滚动，与 1:1 导出同几何）
 * 手动打孔编辑 / MIDI 导入（双排轨道分配 + 音高拆分）
 * 换挡键调度展示 / Web Audio 演奏模拟 / 工程 JSON / SVG、PNG 导出
 * ============================================================ */
(function () {
  'use strict';

  var PP = window.PPKit;
  var PHYS = PP.PHYS, PPB = PP.PPB, LANES = PP.LANES_PER_ROW;
  var Synth = new window.MusicBoxSynth();

  function $(id) { return document.getElementById(id); }

  var viewport = $('viewport'), spacer = $('spacer'), canvas = $('canvas'), wrap = $('wrap');
  var ctx2d = canvas.getContext('2d');

  // ---------------- 状态 ----------------
  var state = {
    holes: [],            // {col,row,lane,midi}，按 col/row/lane 升序；lane 0/15 为换挡键孔
    endCol: 0,
    midi: null,
    bpm: 100,
    tempoMap: null,       // PP.makeTempoMap 结果；null = 按 state.bpm 恒定速度
    transpose: 0,
    mmPerBeat: PHYS.mmPerBeat, // 本曲每拍毫米数（最密间隔拉长后可能 > 标准值）
    report: null,         // 最近一次转换报告
    shiftTL: null,        // 每排换挡事件时间线（play 时构建），驱动键盘换位与音名栏
    pxPerMM: 12 / (PHYS.mmPerBeat / PPB), // 屏幕统一比例尺（px/mm），全方向 1:1；12px/col 基准 = 5.333
    gutterH: 46,          // 顶部音名栏高（两排标签）
    rulerW: 46,           // 左侧标尺宽
    lastViewTop: 0,
    undoStack: [],
    redoStack: [],
    playing: false,
    curBeat: 0,
    playStartCtx: 0,
    playStartSec: 0,
    noteIdx: 0,
    highlights: new Map() // "col:row:lane" -> 触发时刻（AudioContext 秒）
  };

  function pxPerMM() { return state.pxPerMM; } // 屏幕统一比例尺（px/mm），全方向 1:1
  function leadInPx() { return PHYS.leadInMM * pxPerMM(); }
  function stationPx() { return PHYS.stationGapMM * pxPerMM(); }
  function leadOutPx() { return PHYS.leadOutMM * pxPerMM(); }
  function tapeWpx() { return PHYS.tapeWidthMM * pxPerMM(); }
  function pxPerBeat() { return state.mmPerBeat * pxPerMM(); } // 拉长曲每拍占更多像素：纸带"变长"而非"变窄"
  function totalBeats() { return state.endCol / PPB; }
  function holeKey(h) { return h.col + ':' + h.row + ':' + h.lane; }
  function triggerBeat(h) { return (h.col + 0.5) / PPB; }
  function nowSec() { return performance.now() / 1000; } // 传输时钟独立于音频上下文（ctx 挂起时 currentTime 冻结）
  // 拍↔秒：有 MIDI tempo map（变速曲）走分段积分，否则按 state.bpm 恒定换算
  function beatToSec(b) { return state.tempoMap ? state.tempoMap.beatToTime(b) : b * 60 / state.bpm; }
  function secToBeat(t) { return state.tempoMap ? state.tempoMap.timeToBeat(t) : t * state.bpm / 60; }

  var PC_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  function midiName(m) { return PC_NAMES[((m % 12) + 12) % 12] + Math.floor(m / 12 - 1); }

  // ---------------- 孔位查找 / 编辑 ----------------
  function holeCmp(a, b) { return a.col - b.col || a.row - b.row || a.lane - b.lane; }
  function lowerBound(col, row, lane) {
    var lo = 0, hi = state.holes.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1, h = state.holes[mid];
      if (h.col < col || (h.col === col && (h.row < row || (h.row === row && h.lane < lane)))) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  function findHole(col, row, lane) {
    var i = lowerBound(col, row, lane), h = state.holes[i];
    return h && h.col === col && h.row === row && h.lane === lane ? i : -1;
  }
  function insertHole(col, row, lane) {
    if (findHole(col, row, lane) >= 0) return;
    var midi = (lane >= 1 && lane <= 14) ? PP.whiteToMidi(lane - 1) : null; // 烘焙值按基础窗口（挡位 0）；播放时实际音高随键盘挡位
    state.holes.splice(lowerBound(col, row, lane), 0, { col: col, row: row, lane: lane, midi: midi });
    if (col + 1 > state.endCol) { state.endCol = col + 1; updateSpacer(); }
  }
  function removeHole(col, row, lane) {
    var i = findHole(col, row, lane);
    if (i >= 0) state.holes.splice(i, 1);
  }
  function recomputeEndCol() {
    var m = 0;
    for (var i = 0; i < state.holes.length; i++) if (state.holes[i].col + 1 > m) m = state.holes[i].col + 1;
    state.endCol = m;
  }

  // ---------------- 撤销 / 重做 ----------------
  function snapshot() { return JSON.stringify(state.holes); }
  function pushUndo() {
    state.undoStack.push(snapshot());
    if (state.undoStack.length > 200) state.undoStack.shift();
    state.redoStack.length = 0;
  }
  function restore(s) {
    state.holes = JSON.parse(s);
    recomputeEndCol();
    updateSpacer(); draw(); updateStatus();
  }
  function undo() {
    if (!state.undoStack.length) return;
    state.redoStack.push(snapshot());
    restore(state.undoStack.pop());
  }
  function redo() {
    if (!state.redoStack.length) return;
    state.undoStack.push(snapshot());
    restore(state.redoStack.pop());
  }

  // ---------------- 布局与渲染 ----------------
  function tapeLeftX() {
    var vw = viewport.clientWidth;
    return Math.max(state.rulerW, Math.round((vw - tapeWpx()) / 2));
  }
  function tapeLenPx() {
    return PP.tapeLenMM(Math.max(state.endCol, 8 * PPB), state.mmPerBeat) * pxPerMM();
  }
  function updateSpacer() {
    spacer.style.height = Math.ceil(state.gutterH + tapeLenPx() + 240) + 'px';
    spacer.style.width = Math.ceil(state.rulerW + tapeWpx() + 20) + 'px';
  }
  function resizeCanvas() {
    var dpr = window.devicePixelRatio || 1;
    var w = viewport.clientWidth, h = viewport.clientHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    draw();
  }

  function draw() {
    var dpr = window.devicePixelRatio || 1;
    var vw = viewport.clientWidth, vh = viewport.clientHeight;
    if (vw <= 0 || vh <= 0) return;
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);

    var ppm = pxPerMM(), px = 12, gh = state.gutterH; // ppm 屏幕统一比例尺；px = 固定感知余量基准
    var left = tapeLeftX(), rulerLeft = left - state.rulerW;
    var lip = leadInPx(), lop = leadOutPx(), stp = stationPx();
    var choY = gh + lip;                        // 上排·和弦站起点（拍 0，靠纸带头部）
    var melY = choY + stp;                      // 下排·主旋律站起点（拍 0，靠带尾 105mm）
    var tapeEndY = gh + tapeLenPx();

    // 可视窗口：播放/暂停时锚定播放头（纸带自下而上滚动），静止时跟随滚动条
    // 让绿色和弦头（上方）落在顶部音名栏下方，红色主旋律头随之在下方；两站间距超过视口时退化为只保红线
    var active = state.playing || state.curBeat > 0;
    var greenTarget = Math.max(gh + 10, vh * 0.12);
    var headY = Math.round(Math.max(vh * 0.3, Math.min(vh * 0.92, stp + greenTarget)));
    var phy = melY + state.curBeat * pxPerBeat();
    var viewTop = active ? Math.max(0, phy - headY) : viewport.scrollTop;
    state.lastViewTop = viewTop;
    var sy = viewTop;
    var sx = viewport.scrollLeft;

    // 换挡事件时间线（触发 → +400ms 到位）：过渡带与音名栏共用；孔可被编辑，每次重绘重建
    var tlV = PP.buildShiftTimeline(state.holes, state.tempoMap || state.bpm);

    // 背景
    ctx2d.fillStyle = '#1e2229';
    ctx2d.fillRect(0, 0, vw, vh);
    // 左侧标尺底色
    ctx2d.fillStyle = '#2a3038';
    ctx2d.fillRect(rulerLeft - sx, 0, state.rulerW, vh);
    ctx2d.strokeStyle = '#3d454f';
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    ctx2d.moveTo(rulerLeft + state.rulerW + 0.5 - sx, 0); ctx2d.lineTo(rulerLeft + state.rulerW + 0.5 - sx, vh);
    ctx2d.stroke();

    ctx2d.save();
    ctx2d.translate(-sx, -viewTop);

    // 纸带底色
    ctx2d.fillStyle = '#f5f1e4';
    ctx2d.fillRect(left, gh, tapeWpx(), tapeEndY - gh);

    // 两排轨道底色（同排轮心距 8mm；上下排错位 4mm）
    var cellW = PHYS.lanePitchMM * ppm;
    for (var k = 0; k < LANES; k++) {
      var x0 = left + (PHYS.lowerX0MM + k * PHYS.lanePitchMM) * ppm - cellW / 2;
      ctx2d.fillStyle = 'rgba(190,120,50,0.10)';
      ctx2d.fillRect(x0, gh, cellW, tapeEndY - gh);
      var x1 = left + (PHYS.upperX0MM + k * PHYS.lanePitchMM) * ppm - cellW / 2;
      ctx2d.fillStyle = 'rgba(70,120,200,0.10)';
      ctx2d.fillRect(x1, gh, cellW, tapeEndY - gh);
    }

    // 头部/尾部留白
    ctx2d.fillStyle = 'rgba(100,90,60,0.14)';
    ctx2d.fillRect(left, gh, tapeWpx(), lip);
    ctx2d.fillRect(left, tapeEndY - lop, tapeWpx(), lop);

    // 4mm 交错轨格竖线（9mm..141mm）
    ctx2d.strokeStyle = 'rgba(120,110,85,0.30)';
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    for (var gx = 9; gx <= 141.01; gx += 4) {
      var xx = left + gx * ppm + 0.5;
      ctx2d.moveTo(xx, gh); ctx2d.lineTo(xx, tapeEndY);
    }
    ctx2d.stroke();
    // 轨区边界（最外轨缘）
    ctx2d.strokeStyle = 'rgba(120,100,60,0.55)';
    ctx2d.beginPath();
    ctx2d.moveTo(left + 9 * ppm + 0.5, gh); ctx2d.lineTo(left + 9 * ppm + 0.5, tapeEndY);
    ctx2d.moveTo(left + 141 * ppm + 0.5, gh); ctx2d.lineTo(left + 141 * ppm + 0.5, tapeEndY);
    ctx2d.stroke();

    // 节拍网格：主旋律站（实线）+ 和弦站（虚线，偏上 105mm）
    var bFrom = Math.max(0, Math.floor((sy - melY) / pxPerBeat()) - 1);
    var bTo = Math.ceil((sy - gh + vh) / pxPerBeat()) + 1;
    ctx2d.beginPath();
    for (var b = bFrom; b <= bTo; b++) {
      var y = melY + b * pxPerBeat();
      if (y < sy - px || y > sy + vh + px) continue;
      ctx2d.moveTo(left, y + 0.5); ctx2d.lineTo(left + tapeWpx(), y + 0.5);
    }
    ctx2d.strokeStyle = 'rgba(160,145,105,0.5)';
    ctx2d.stroke();
    ctx2d.save();
    ctx2d.setLineDash([3, 4]);
    ctx2d.beginPath();
    for (var b2 = bFrom; b2 <= bTo; b2++) {
      var y2 = choY + b2 * pxPerBeat();
      if (y2 < sy - px || y2 > sy + vh + px) continue;
      ctx2d.moveTo(left, y2 + 0.5); ctx2d.lineTo(left + tapeWpx(), y2 + 0.5);
    }
    ctx2d.strokeStyle = 'rgba(110,130,180,0.4)';
    ctx2d.stroke();
    ctx2d.restore();
    // 小节线（每 4 拍，主旋律站）
    ctx2d.beginPath();
    for (var m0 = Math.floor(bFrom / 4) * 4; m0 <= bTo; m0 += 4) {
      var ym = melY + m0 * pxPerBeat();
      if (ym < sy - px || ym > sy + vh + px) continue;
      ctx2d.moveTo(left, ym + 0.5); ctx2d.lineTo(left + tapeWpx(), ym + 0.5);
    }
    ctx2d.strokeStyle = 'rgba(140,120,70,0.75)';
    ctx2d.stroke();

    // 两站起点虚线
    ctx2d.save();
    ctx2d.setLineDash([5, 4]);
    ctx2d.lineWidth = 1;
    ctx2d.strokeStyle = 'rgba(60,110,200,0.75)';
    ctx2d.beginPath(); ctx2d.moveTo(left, choY + 0.5); ctx2d.lineTo(left + tapeWpx(), choY + 0.5); ctx2d.stroke();
    ctx2d.strokeStyle = 'rgba(200,70,50,0.75)';
    ctx2d.beginPath(); ctx2d.moveTo(left, melY + 0.5); ctx2d.lineTo(left + tapeWpx(), melY + 0.5); ctx2d.stroke();
    ctx2d.restore();

    // 换挡过渡带（琥珀色）：换挡键触发 → 键盘到位（400ms 按该处速度折算）。
    // 期间该排键盘在滑动、无法清晰击发——转换会保证带内无音符孔；手动打孔请避开。
    for (var row = 0; row < 2; row++) {
      var stY = row === 1 ? choY : melY;
      var evs = tlV[row];
      for (var bi2 = 0; bi2 < evs.length; bi2++) {
        var yT = stY + evs[bi2].beat * pxPerBeat();
        var yA = stY + evs[bi2].arrive * pxPerBeat();
        if (yA < sy || yT > sy + vh) continue;
        ctx2d.fillStyle = 'rgba(232,196,97,0.13)';
        ctx2d.fillRect(left, yT, tapeWpx(), yA - yT);
        ctx2d.strokeStyle = 'rgba(214,178,74,0.55)';
        ctx2d.save();
        ctx2d.setLineDash([4, 3]);
        ctx2d.beginPath();
        ctx2d.moveTo(left, yA + 0.5); ctx2d.lineTo(left + tapeWpx(), yA + 0.5);
        ctx2d.stroke();
        ctx2d.restore();
      }
    }

    // 纸带左右边缘
    ctx2d.strokeStyle = '#7d755d';
    ctx2d.lineWidth = 1.5;
    ctx2d.beginPath();
    ctx2d.moveTo(left + 0.75, gh); ctx2d.lineTo(left + 0.75, tapeEndY);
    ctx2d.moveTo(left + tapeWpx() - 0.75, gh); ctx2d.lineTo(left + tapeWpx() - 0.75, tapeEndY);
    ctx2d.stroke();

    // 孔（按 col 升序；同列中主旋律孔(row0)比和弦孔(row1)低 105mm，y 非单调：
    // 只能从"可见最低列"起步，且仅在主旋律孔(row0)越出视口底部时才能 break）
    var now = nowSec();
    var rHole = Math.min(px * 0.42, 2.4 * ppm);
    var colMin = Math.max(0, Math.floor(((sy - gh) / ppm - PHYS.leadInMM - PHYS.stationGapMM) * PPB / state.mmPerBeat) - 2);
    for (var i = lowerBound(colMin, 0, 0); i < state.holes.length; i++) {
      var h = state.holes[i];
      var hy = gh + PP.holeYMM(h.col, h.row, state.mmPerBeat) * ppm;
      if (hy < sy - px * 2) continue;
      // break 必须让出 105mm 站间距：同 col 及之后 row1（和弦）孔 y 比 row0 小 105mm，
      // 仍可能在视口内；否则这些孔会被漏画、随 break 点推进而在视口中上部"突然出现"（幽灵孔）
      if (hy > sy + vh + px * 2 + stp && h.row === 0) break;
      var hx = left + PP.laneXMM(h.row, h.lane) * ppm;
      var lit = state.highlights.get(holeKey(h));
      var glow = lit != null && now >= lit && now < lit + 0.9 ? 1 - (now - lit) / 0.9 : 0;
      var shiftHole = PP.isShiftLane(h.lane);
      if (glow > 0) {
        var gc = shiftHole ? '190,190,190' : (h.row === 0 ? '224,110,60' : '70,190,180');
        ctx2d.beginPath(); ctx2d.arc(hx, hy, rHole + 2.5, 0, 6.2832);
        ctx2d.fillStyle = 'rgba(' + gc + ',' + (0.55 * glow).toFixed(3) + ')'; ctx2d.fill();
        ctx2d.beginPath(); ctx2d.arc(hx, hy, rHole, 0, 6.2832);
        ctx2d.fillStyle = shiftHole ? '#e8e8e8' : (h.row === 0 ? '#d95f2e' : '#2fa89c'); ctx2d.fill();
      } else if (shiftHole) {
        // 换挡键孔：描边圆（◀◀ 红 / ▶▶ 绿）
        ctx2d.beginPath(); ctx2d.arc(hx, hy, rHole, 0, 6.2832);
        ctx2d.fillStyle = '#2b2620'; ctx2d.fill();
        ctx2d.strokeStyle = h.lane === 0 ? '#c9563a' : '#4d9a6c';
        ctx2d.lineWidth = 1.4; ctx2d.stroke();
      } else {
        // 音符孔按排分色：主旋律（row0）红橙、和弦（row1）绿——与两排扫描线同色系
        ctx2d.beginPath(); ctx2d.arc(hx, hy, rHole, 0, 6.2832);
        ctx2d.fillStyle = h.row === 0 ? '#a8431f' : '#1e7a4f'; ctx2d.fill();
        ctx2d.beginPath(); ctx2d.arc(hx, hy, rHole - 1, 0, 6.2832);
        ctx2d.fillStyle = h.row === 0 ? '#7c2f13' : '#125436'; ctx2d.fill();
      }
    }

    // 播放头（水平线；下排主旋律红色，上排和弦绿色，随时间下移）
    function drawPlayHead(y, color) {
      ctx2d.strokeStyle = color;
      ctx2d.lineWidth = 1.6;
      ctx2d.beginPath();
      ctx2d.moveTo(left - 2, y); ctx2d.lineTo(left + tapeWpx() + 2, y);
      ctx2d.stroke();
      ctx2d.fillStyle = color;
      ctx2d.beginPath();
      ctx2d.moveTo(rulerLeft + state.rulerW - 8, y - 5);
      ctx2d.lineTo(rulerLeft + state.rulerW - 8, y + 5);
      ctx2d.lineTo(rulerLeft + state.rulerW - 1, y);
      ctx2d.closePath(); ctx2d.fill();
    }
    if (state.curBeat > 0 || state.playing) {
      var phyCho = choY + state.curBeat * pxPerBeat();   // 和弦站（上排）播放头，领先主旋律站 105mm
      drawPlayHead(phyCho, '#27b35a');
      drawPlayHead(phy, '#e04327');
    }

    // ---- 左侧标尺：mm 刻度 + 站标注 + 拍号（底色已绘制）----
    var mmMinor = ppm * 10 >= 9 ? 10 : 50;
    var mmMajor = ppm * 50 >= 34 ? 50 : 100;
    var mmFrom = Math.max(0, Math.floor((sy - gh) / ppm / mmMinor) * mmMinor);
    var mmTo = Math.ceil((sy - gh + vh) / ppm);
    ctx2d.strokeStyle = '#8d97a5';
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    for (var mm = mmFrom; mm <= mmTo; mm += mmMinor) {
      var yt = gh + mm * ppm;
      var major = (mm % mmMajor === 0);
      ctx2d.moveTo(major ? rulerLeft + 6 : rulerLeft + 11, yt + 0.5);
      ctx2d.lineTo(rulerLeft + state.rulerW - 4, yt + 0.5);
    }
    ctx2d.stroke();
    ctx2d.fillStyle = '#8d97a5';
    ctx2d.font = '10px sans-serif';
    ctx2d.textAlign = 'center';
    ctx2d.textBaseline = 'middle';
    for (var mm3 = mmFrom; mm3 <= mmTo; mm3 += mmMajor) {
      var yc = gh + mm3 * ppm;
      if (yc < gh + 20 || yc > sy + vh - 10) continue;
      ctx2d.save();
      ctx2d.translate(rulerLeft + state.rulerW - 26, yc);
      ctx2d.rotate(-Math.PI / 2);
      ctx2d.fillText(mm3 + 'mm', 0, 0);
      ctx2d.restore();
    }
    // 站起点标注
    ctx2d.fillStyle = '#4a7fc9';
    ctx2d.save();
    ctx2d.translate(rulerLeft + 10, choY);
    ctx2d.rotate(-Math.PI / 2);
    ctx2d.fillText('和弦站', 0, 0);
    ctx2d.restore();
    ctx2d.fillStyle = '#c9563a';
    ctx2d.save();
    ctx2d.translate(rulerLeft + 10, melY);
    ctx2d.rotate(-Math.PI / 2);
    ctx2d.fillText('主旋律站', 0, 0);
    ctx2d.restore();
    // 拍号（主旋律站对齐）
    ctx2d.fillStyle = '#aeb8c6';
    var labelEvery = pxPerBeat() >= 46 ? 1 : pxPerBeat() >= 24 ? 2 : pxPerBeat() >= 12 ? 4 : 8;
    for (var lb = Math.max(0, Math.floor(bFrom / labelEvery) * labelEvery); lb <= bTo; lb += labelEvery) {
      var yl = melY + lb * pxPerBeat();
      if (yl < sy - 30 || yl > sy + vh + 30) continue;
      ctx2d.save();
      ctx2d.translate(rulerLeft + state.rulerW - 8, yl);
      ctx2d.rotate(-Math.PI / 2);
      ctx2d.fillText(String(lb + 1), 0, 0);
      ctx2d.restore();
    }
    ctx2d.textBaseline = 'alphabetic';

    ctx2d.restore();

    // ---- 顶部轨名栏（视口固定；标签随该排当前挡位显示实际音名）----
    ctx2d.fillStyle = '#2a3038';
    ctx2d.fillRect(0, 0, vw, gh);
    ctx2d.strokeStyle = '#3d454f';
    ctx2d.beginPath(); ctx2d.moveTo(0, gh + 0.5); ctx2d.lineTo(vw, gh + 0.5); ctx2d.stroke();
    ctx2d.textAlign = 'center';
    ctx2d.font = '10px sans-serif';
    var shiftedNow = state.playing || state.curBeat > 0;
    var rowInfo = [null, null];
    for (var r = 0; r < 2; r++) {
      var ly = r === 1 ? gh - 24 : gh - 7;          // 上排和弦(r1)标签在上行，下排主旋律(r0)在下行
      // 到位语义：换挡键触发后键盘滑动 400ms 才到位，期间仍按旧挡、音名灰显
      var info = shiftedNow ? PP.shiftInfoAt(tlV, r, state.curBeat) : { s: 0, moving: false, dir: 0 };
      rowInfo[r] = info;
      var sh = info.s;
      for (var k2 = 0; k2 < LANES; k2++) {
        var cx = left + PP.laneXMM(r, k2) * ppm - sx;
        if (cx < -10 || cx > vw + 10) continue;
        var txt = k2 === 0 ? '◀◀' : k2 === 15 ? '▶▶' : PP.whiteName(14 * sh + k2 - 1);
        // 到界方向的换挡键当前不可再按 → 变暗；换挡滑动中白键名灰显；已换挡白键标签金色
        var atBoundDown = k2 === 0 && sh <= -PHYS.maxShift, atBoundUp = k2 === 15 && sh >= PHYS.maxShift;
        if (atBoundDown || atBoundUp) ctx2d.fillStyle = '#555f6b';
        else if (PP.isShiftLane(k2)) ctx2d.fillStyle = r === 0 ? '#c98a5f' : '#7fa6d8';
        else if (info.moving) ctx2d.fillStyle = '#6b7684';
        else ctx2d.fillStyle = sh !== 0 ? '#e8c461' : (r === 0 ? '#9fd0ab' : '#9dbdea');
        ctx2d.fillText(txt, cx, ly);
      }
    }
    ctx2d.fillStyle = '#77828f';
    ctx2d.font = '9px sans-serif';
    ctx2d.textAlign = 'left';
    if (left - sx > state.rulerW + 70) {
      ctx2d.fillText(rowInfo[1].moving ? '和弦·换挡中' + (rowInfo[1].dir > 0 ? ' ▶▶' : ' ◀◀') : '上排·和弦', rulerLeft - sx + 2, gh - 24);
      ctx2d.fillText(rowInfo[0].moving ? '主旋律·换挡中' + (rowInfo[0].dir > 0 ? ' ▶▶' : ' ◀◀') : '下排·主旋律', rulerLeft - sx + 2, gh - 7);
    }
    ctx2d.textAlign = 'center';

    // 空状态提示
    if (!state.holes.length) {
      ctx2d.fillStyle = 'rgba(150,160,175,0.5)';
      ctx2d.font = '15px sans-serif';
      ctx2d.fillText('导入 MIDI、加载示例曲，或直接点击纸带打孔', left + tapeWpx() / 2 - sx, choY + (vh - choY) / 2);
    }
  }

  // ---------------- 状态栏 ----------------
  function fmtDur(sec) {
    sec = Math.max(0, Math.round(sec));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }
  function updateStatus() {
    $('stHoles').textContent = String(state.holes.length);
    var lenMM = PP.tapeLenMM(state.endCol, state.mmPerBeat);
    $('stLen').textContent = lenMM >= 1000 ? (lenMM / 1000).toFixed(2) + ' m' : Math.round(lenMM) + ' mm';
    $('stDur').textContent = fmtDur(beatToSec(totalBeats()));
    $('stBpm').textContent = state.tempoMap && state.tempoMap.count > 1
      ? Math.round(state.tempoMap.minBpm) + '~' + Math.round(state.tempoMap.maxBpm)
      : String(state.bpm);
    $('stTr').textContent = state.transpose ? (state.transpose > 0 ? '+' : '') + state.transpose : '0';
    var sh = state.report && state.report.shifts ? state.report.shifts : [0, 0];
    $('stShift').textContent = sh[0] + ' / ' + sh[1];
  }
  function setMsg(text) { $('stMsg').textContent = text || ''; }

  // ---------------- 编辑（打孔 / 擦除）----------------
  var painting = null;
  function hitTest(e) {
    var rect = canvas.getBoundingClientRect();
    var x = e.clientX - rect.left + viewport.scrollLeft;
    var y = e.clientY - rect.top + (state.playing || state.curBeat > 0 ? state.lastViewTop : viewport.scrollTop);
    var ppm = pxPerMM(), left = tapeLeftX();
    var mmX = (x - left) / ppm;
    if (mmX < 0 || mmX > PHYS.tapeWidthMM) return null;
    // 最近轨位（上下排 32 轨中就近，容差 4mm）
    var best = null, bestD = 4;
    for (var r = 0; r < 2; r++) {
      for (var k = 0; k < LANES; k++) {
        var d = Math.abs(mmX - PP.laneXMM(r, k));
        if (d < bestD) { bestD = d; best = { row: r, lane: k }; }
      }
    }
    if (!best) return null;
    var mmY = (y - state.gutterH) / ppm;
    var base = mmY - PHYS.leadInMM - (best.row === 0 ? PHYS.stationGapMM : 0);
    var col = Math.floor(base * PPB / state.mmPerBeat);
    if (col < 0) return null;
    return { col: col, row: best.row, lane: best.lane };
  }
  canvas.addEventListener('pointerdown', function (e) {
    if (e.button !== 0 || state.playing) return;
    var h = hitTest(e);
    if (!h) return;
    painting = findHole(h.col, h.row, h.lane) >= 0 ? 'del' : 'add';
    pushUndo();
    applyPaint(h);
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 合成指针事件无活动指针 */ }
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!painting) return;
    var h = hitTest(e);
    if (h) applyPaint(h);
  });
  function endPaint() { painting = null; }
  canvas.addEventListener('pointerup', endPaint);
  canvas.addEventListener('pointercancel', endPaint);

  function applyPaint(h) {
    if (painting === 'add') {
      if (findHole(h.col, h.row, h.lane) < 0) { insertHole(h.col, h.row, h.lane); draw(); updateStatus(); }
    } else {
      if (findHole(h.col, h.row, h.lane) >= 0) { removeHole(h.col, h.row, h.lane); draw(); updateStatus(); }
    }
  }

  // ---------------- 演奏模拟 ----------------
  // 调度与绘制解耦：调度固定走 setInterval（后台标签被浏览器节流至 ≥1s 时加大提前量，音频时间点仍精确），
  // 绘制由 rAF 驱动（不可见/离屏时自然停摆，不影响播放走带）。
  var rafId = 0, schedTimer = null;
  function play() {
    if (state.playing) return;
    Synth.ensure();
    if (state.curBeat >= totalBeats() - 1e-6) state.curBeat = 0;
    state.playing = true;
    state.playStartCtx = nowSec() + 0.06;
    state.playStartSec = beatToSec(state.curBeat);
    var target = state.curBeat;
    var lo = 0, hi = state.holes.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (triggerBeat(state.holes[mid]) < target - 1e-9) lo = mid + 1; else hi = mid;
    }
    state.noteIdx = lo;
    state.shiftTL = PP.buildShiftTimeline(state.holes, state.tempoMap || state.bpm); // 到位语义：触发 +400ms 才切换挡位
    $('btnPlay').textContent = '暂停';
    startLoops();
  }
  function pause() {
    state.playing = false;
    $('btnPlay').textContent = '播放';
    draw();
  }
  function stopPlayback() {
    state.playing = false;
    state.curBeat = 0;
    state.shiftTL = null;
    state.highlights.clear();
    $('btnPlay').textContent = '播放';
    $('stPos').textContent = '0:00';
    viewport.scrollTop = state.lastViewTop;
    draw();
  }
  function schedule() {
    if (!state.playing) return;
    var now = nowSec();
    var songSec = state.playStartSec + (now - state.playStartCtx);
    var beat = secToBeat(songSec);
    if (beat < 0) beat = 0;
    state.curBeat = beat;
    $('stPos').textContent = fmtDur(Math.max(0, songSec));

    var horizon = document.hidden ? 1.6 : 0.35; // 提前量须大于调度周期（后台定时器被节流至 ≥1s）
    while (state.noteIdx < state.holes.length) {
      var h = state.holes[state.noteIdx];
      var tb = triggerBeat(h);
      var hs = beatToSec(tb);
      if (hs > songSec + horizon) break;
      var when = state.playStartCtx + (hs - state.playStartSec); // perf 时钟
      if (Synth.available) {
        // 换算到音频上下文时间轴：audio now + 与 perf 时钟的差
        var at = Synth.now() + Math.max(0.001, when - now);
        if (PP.isShiftLane(h.lane)) {
          Synth.play(45, at, 0.3); // 换挡键：机械换位声（键盘移动在 shiftAt 中体现）
        } else {
          // 实际音高由"键位 × 该孔击发瞬间的键盘挡位"决定，与转换烘焙的 h.midi 等价但物理路径真实
          var shHere = PP.shiftAt(state.shiftTL, h.row, tb);
          Synth.play(PP.soundingMidi(h.lane, shHere), at, h.row === 1 ? 0.8 : 1);
        }
      }
      state.highlights.set(holeKey(h), when);
      state.noteIdx++;
    }
    state.highlights.forEach(function (v, k) {
      if (now - v > 1.5) state.highlights.delete(k);
    });

    if (beat > totalBeats() + 1.5) stopPlayback();
  }
  function frame() {
    if (!state.playing) return;
    draw();
    rafId = requestAnimationFrame(frame);
  }
  function startLoops() {
    if (schedTimer) clearInterval(schedTimer);
    schedTimer = setInterval(schedule, 250);
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(frame);
  }
  document.addEventListener('visibilitychange', function () {
    if (state.playing) startLoops(); // 重见时确保 rAF 恢复；隐藏时 rAF 自行停摆，interval 兜底
  });

  // ---------------- MIDI 导入 ----------------
  function trackAvgPitch(tr) {
    var s = 0;
    for (var i = 0; i < tr.notes.length; i++) s += tr.notes[i].note;
    return s / tr.notes.length;
  }
  function openImportDialog() {
    var list = $('trackList');
    list.innerHTML = '';
    var any = false;
    // 默认分配：音域均值最高的轨 → 主旋律（下排），其余有音符的轨 → 和弦（上排）；单轨曲配合"按音高拆分"自动分出左手
    var melIdx = -1, best = -1;
    state.midi.tracks.forEach(function (tr, idx) {
      if (!tr.notes.length) return;
      var avg = trackAvgPitch(tr);
      if (avg > best) { best = avg; melIdx = idx; }
    });
    state.midi.tracks.forEach(function (tr, idx) {
      if (!tr.notes.length) return;
      any = true;
      var role = idx === melIdx ? 'mel' : 'cho';
      var avg = trackAvgPitch(tr);
      var min = tr.notes[0].note, max = tr.notes[0].note;
      tr.notes.forEach(function (n) { if (n.note < min) min = n.note; if (n.note > max) max = n.note; });
      var div = document.createElement('div');
      div.className = 'trk';
      div.innerHTML = '<select data-t="' + idx + '">' +
        '<option value="none">不导入</option>' +
        '<option value="mel"' + (role === 'mel' ? ' selected' : '') + '>主旋律(下排)</option>' +
        '<option value="cho"' + (role === 'cho' ? ' selected' : '') + '>和弦(上排)</option>' +
        '</select> 轨道 ' + (idx + 1) + '：' + escapeHtml(tr.name || '(未命名)') +
        ' <span class="meta">— ' + tr.notes.length + ' 音 · 音域 ' + midiName(min) + '~' + midiName(max) +
        ' · 均值 ' + midiName(Math.round(avg)) + '</span>';
      list.appendChild(div);
    });
    if (!any) list.innerHTML = '<div class="hint" style="padding:8px">该 MIDI 文件中没有音符。</div>';
    var tm = PP.makeTempoMap(state.midi.tempos, state.midi.ticksPerBeat);
    var speedInfo = !state.midi.tempos.length ? '速度按 BPM 框 ' + state.bpm
      : (tm && tm.count > 1
        ? '速度取自 MIDI：' + Math.round(tm.minBpm) + '~' + Math.round(tm.maxBpm) + ' BPM（变速，播放将跟随）'
        : '速度取自 MIDI: ' + Math.round(60e6 / state.midi.tempos[0].usPerQuarter) + ' BPM');
    $('dlgInfo').textContent = (state.midi.format === 2 ? '注意：Format 2 文件按多轨道同时处理。' : '') + speedInfo;
    $('dlg').classList.add('open');
  }
  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }
  function closeImportDialog() { $('dlg').classList.remove('open'); }

  /** 单轨拆分：主旋律轨中低于 splitAt 的音移入和弦排（生成合成 MIDI） */
  function buildEffectiveMidi(melodyTracks, chordTracks) {
    if (!$('chkSplit').checked) return { midi: state.midi, mel: melodyTracks, cho: chordTracks };
    var tracks = [], mel = new Set(), cho = new Set();
    state.midi.tracks.forEach(function (tr, idx) {
      var isM = melodyTracks.has(idx), isC = chordTracks.has(idx);
      if (!isM && !isC) { tracks.push(tr); return; }
      if (isM && !isC) {
        var hi = { name: (tr.name || '') + '·主', channels: tr.channels, notes: [] };
        var lo = { name: (tr.name || '') + '·和', channels: tr.channels, notes: [] };
        tr.notes.forEach(function (n) { (n.note >= 60 ? hi : lo).notes.push(n); });
        if (hi.notes.length) { mel.add(tracks.length); tracks.push(hi); }
        if (lo.notes.length) { cho.add(tracks.length); tracks.push(lo); }
      } else {
        if (isM) mel.add(tracks.length);
        if (isC) cho.add(tracks.length);
        tracks.push(tr);
      }
    });
    return {
      midi: { ticksPerBeat: state.midi.ticksPerBeat, format: state.midi.format, tempos: state.midi.tempos, tracks: tracks },
      mel: mel, cho: cho
    };
  }

  function doConvert(eff) {
    var res = PP.convertFromMidi(eff.midi, {
      melodyTracks: eff.mel, chordTracks: eff.cho,
      excludeDrums: $('chkDrums').checked,
      transpose: $('selTranspose').value === 'auto' ? 'auto' : parseInt($('selTranspose').value, 10),
      bpm: parseInt($('bpm').value, 10) || 120 // MIDI 无速度事件时换挡提前量按此速度折算
    });
    if (res.report.empty) { setMsg('所选轨道没有可转换的音符'); return; }
    pushUndo();
    state.holes = res.holes;
    state.endCol = res.endCol;
    state.midi = eff.midi;
    state.transpose = res.transpose;
    state.mmPerBeat = res.mmPerBeat;
    state.report = res.report;
    state.tempoMap = PP.makeTempoMap(eff.midi.tempos, eff.midi.ticksPerBeat);
    if (eff.midi.tempos.length) {
      state.bpm = Math.min(240, Math.max(40, Math.round(60e6 / eff.midi.tempos[0].usPerQuarter)));
      $('bpm').value = state.bpm;
    }
    var r = res.report, parts = [];
    if (res.transpose) parts.push('移调 ' + (res.transpose > 0 ? '+' : '') + res.transpose + ' 半音');
    if (r.scale > 1) parts.push('按最密间隔拉长纸带 ×' + r.scale + '（节奏零失真）');
    if (r.blackMapped) parts.push(r.blackMapped + ' 黑键就近映射白键');
    if (r.shifts[0] || r.shifts[1]) parts.push('换挡键 主 ' + r.shifts[0] + ' / 和 ' + r.shifts[1]);
    if (r.clamped) parts.push(r.clamped + ' 音超出换挡范围按就近键击发');
    if (r.pushedNotes) parts.push(r.pushedNotes + ' 音因最小孔距后移');
    if (r.dropped) parts.push(r.dropped + ' 音过密且紧邻换挡、物理打不下已舍弃');
    setMsg('转换完成：' + r.holeCount + ' 孔' + (parts.length ? '，' + parts.join('，') : ''));
    updateSpacer(); draw(); updateStatus();
  }

  function importMidiFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        state.midi = window.MidiParser.parseMidi(reader.result);
        $('selTranspose').value = 'auto';
        openImportDialog();
      } catch (err) {
        setMsg('MIDI 解析失败：' + (err.message || err));
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function confirmImport() {
    var melodyTracks = new Set(), chordTracks = new Set();
    document.querySelectorAll('#trackList select').forEach(function (sel) {
      var t = Number(sel.dataset.t);
      if (sel.value === 'mel') melodyTracks.add(t);
      else if (sel.value === 'cho') chordTracks.add(t);
    });
    if (!melodyTracks.size && !chordTracks.size) { setMsg('请至少为一个轨道选择用途'); return; }
    doConvert(buildEffectiveMidi(melodyTracks, chordTracks));
    closeImportDialog();
  }

  // ---------------- 从网址导入 MIDI ----------------
  var urlAbort = null;
  var pendingUrlName = null;

  function openUrlDialog() {
    $('urlInput').value = '';
    $('urlStatus').textContent = '';
    $('urlStatus').className = '';
    $('btnUrlOpen').hidden = true;
    $('dlgUrl').classList.add('open');
    $('urlInput').focus();
  }
  function closeUrlDialog() {
    if (urlAbort) { urlAbort.abort(); urlAbort = null; }
    $('dlgUrl').classList.remove('open');
  }
  function setUrlStatus(text, cls) {
    $('urlStatus').textContent = text;
    $('urlStatus').className = cls || '';
  }
  function guessMidiName(url) {
    try {
      var u = new URL(url);
      var name = decodeURIComponent(u.pathname.split('/').pop() || 'song.mid');
      return /\.mid$/i.test(name) ? name : (name || 'song') + '.mid';
    } catch (e) { return 'song.mid'; }
  }
  function showMidishowGuide(pageUrl) {
    $('btnUrlOpen').href = pageUrl;
    $('btnUrlOpen').hidden = false;
    setUrlStatus('检测到 MidiShow 页面链接：该站下载 MIDI 需要登录并消耗积分，且不允许网页直接抓取。请点击左下方「打开下载页」，登录后手动下载，再把 .mid 文件拖入本程序（或用「导入 MIDI」选择）。', 'err');
  }
  function fetchMidiFromUrl() {
    var raw = $('urlInput').value.trim();
    if (!raw) { setUrlStatus('请输入网址', 'err'); return; }
    var ms = raw.match(/(?:https?:\/\/)?(?:www\.)?midishow\.com\/midi\/(\d+)\.html/i);
    if (ms) { showMidishowGuide('https://www.midishow.com/midi/' + ms[1] + '.html'); return; }
    var mf = raw.match(/(?:https?:\/\/)?(?:www\.)?midify\.cn\/player\/(\d+)/i);
    if (mf) {
      setUrlStatus('检测到 Midify 页面链接，正在解析 MIDI 直链…');
      fetch('https://midify.cn/api/music/' + mf[1], { credentials: 'omit' })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function (info) {
          if (!info || !info.file_path) throw new Error('NO_PATH');
          pendingUrlName = ((info.title || ('midify_' + mf[1])) + '.mid').replace(/[\\/:*?"<>|]/g, '_');
          $('urlInput').value = /^https?:\/\//i.test(info.file_path) ? info.file_path : 'https://midify.cn' + info.file_path;
          fetchMidiFromUrl();
        })
        .catch(function (err) {
          pendingUrlName = null;
          var msg = err.message || String(err);
          if (msg === 'NO_PATH') msg = '该曲目没有可用的 MIDI 文件路径';
          else if (msg.indexOf('Failed to fetch') !== -1) msg = '网络不可达或跨域受限';
          setUrlStatus('Midify 解析失败：' + msg, 'err');
        });
      return;
    }
    var url = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
    var name = pendingUrlName || guessMidiName(url);
    pendingUrlName = null;
    setUrlStatus('正在获取…');
    $('btnUrlFetch').disabled = true;
    urlAbort = new AbortController();
    var timer = setTimeout(function () { if (urlAbort) urlAbort.abort(); }, 15000);
    fetch(url, { signal: urlAbort.signal, credentials: 'omit' })
      .then(function (res) {
        clearTimeout(timer);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.arrayBuffer();
      })
      .then(function (buf) {
        var head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
        if (String.fromCharCode.apply(null, head) !== 'MThd') throw new Error('NOT_MIDI');
        var file = new File([buf], name, { type: 'audio/midi' });
        closeUrlDialog();
        setMsg('已从网址下载 MIDI：' + name);
        importMidiFile(file);
      })
      .catch(function (err) {
        clearTimeout(timer);
        var msg = err.message || String(err);
        if (err.name === 'AbortError') msg = '请求超时（15 秒）';
        else if (msg === 'NOT_MIDI') {
          if (/midishow\.com/i.test(url)) showMidishowGuide(url);
          else msg = '该网址返回的不是 MIDI 文件（可能是网页），请找到 .mid 直链后重试';
        }
        else if (msg.indexOf('Failed to fetch') !== -1) msg = '获取失败：跨域受限或站点有反爬，请手动下载后拖入本程序';
        setUrlStatus(msg, 'err');
      })
      .then(function () { $('btnUrlFetch').disabled = false; urlAbort = null; });
  }

  // ---------------- 缩放 ----------------
  var PPM_BASE = 12 / (PHYS.mmPerBeat / PPB); // 100% 基准比例尺
  function setZoom(pmm, anchorClientY) {
    pmm = Math.min(12.5, Math.max(1.0, pmm));
    if (Math.abs(pmm - state.pxPerMM) < 1e-9) return;
    var oldPpm = pxPerMM();
    var anchor = anchorClientY != null ? anchorClientY : viewport.clientHeight / 2;
    var viewTop = state.playing || state.curBeat > 0 ? state.lastViewTop : viewport.scrollTop;
    var mmAt = (viewTop + anchor - state.gutterH) / oldPpm; // 锚点处纸带纵向 mm 位置
    state.pxPerMM = pmm;
    updateSpacer(); resizeCanvas();
    if (!state.playing && state.curBeat <= 0) {
      viewport.scrollTop = Math.max(0, state.gutterH + mmAt * pxPerMM() - anchor);
    }
    $('zoomLabel').textContent = Math.round(pmm / PPM_BASE * 100) + '%';
  }
  // 适宽：纸带 150mm 以视口可用宽度的 2/3 × 0.6 显示（用户指定：横向与纵向同为紧凑比例，两侧大留白）
  function fitWidth() {
    var avail = (viewport.clientWidth - state.rulerW - 12) * 2 / 3 * 0.6;
    if (avail < 120) avail = 120;
    setZoom(avail / PHYS.tapeWidthMM, viewport.clientHeight / 2);
  }

  // ---------------- 工程 / 导出 ----------------
  function download(name, blob) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
  }

  function saveProject() {
    if (!state.holes.length) { setMsg('纸带为空'); return; }
    var data = { v: 1, app: 'perfect-piano', bpm: state.bpm, transpose: state.transpose, mmPerBeat: state.mmPerBeat, holes: state.holes, endCol: state.endCol };
    download('完美钢琴纸带工程.json', new Blob([JSON.stringify(data)], { type: 'application/json' }));
  }
  function openProjectFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var d = JSON.parse(reader.result);
        if (!Array.isArray(d.holes)) throw new Error('格式不正确');
        pushUndo();
        state.bpm = d.bpm || 120;
        state.transpose = d.transpose | 0;
        state.mmPerBeat = d.mmPerBeat || PHYS.mmPerBeat;
        state.tempoMap = null;
        state.report = null;
        state.holes = d.holes.filter(function (h) {
          return Number.isInteger(h.col) && h.col >= 0 &&
            (h.row === 0 || h.row === 1) && Number.isInteger(h.lane) && h.lane >= 0 && h.lane < LANES &&
            (h.midi == null || (Number.isInteger(h.midi) && h.midi >= 0 && h.midi <= 127));
        }).map(function (h) { return { col: h.col, row: h.row, lane: h.lane, midi: h.midi == null ? null : h.midi }; });
        state.holes.sort(holeCmp);
        recomputeEndCol();
        $('bpm').value = state.bpm;
        setMsg('工程已载入');
        updateSpacer(); draw(); updateStatus();
      } catch (err) {
        setMsg('工程文件读取失败：' + (err.message || err));
      }
    };
    reader.readAsText(file);
  }

  function exportSVG() {
    if (!state.holes.length) { setMsg('纸带为空，先打孔或导入 MIDI'); return; }
    var geo = PP.exportGeometry(state.holes, state.endCol, state.mmPerBeat);
    var s = [];
    s.push('<?xml version="1.0" encoding="UTF-8"?>');
    s.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + geo.wMM.toFixed(2) + 'mm" height="' + geo.hMM.toFixed(2) + 'mm" viewBox="0 0 ' + geo.wMM.toFixed(2) + ' ' + geo.hMM.toFixed(2) + '">');
    s.push('<rect x="0" y="0" width="' + geo.wMM.toFixed(2) + '" height="' + geo.hMM.toFixed(2) + '" fill="white"/>');
    s.push('<rect x="0.2" y="0.2" width="' + (geo.wMM - 0.4).toFixed(2) + '" height="' + (geo.hMM - 0.4).toFixed(2) + '" fill="none" stroke="#999" stroke-width="0.2"/>');
    // 4mm 交错轨格（9..141mm）
    for (var gx = 9; gx <= 141.01; gx += 4) {
      s.push('<line x1="' + gx + '" y1="0" x2="' + gx + '" y2="' + geo.hMM.toFixed(2) + '" stroke="#e4e4e4" stroke-width="0.12"/>');
    }
    // 轨区边界
    s.push('<line x1="9" y1="0" x2="9" y2="' + geo.hMM.toFixed(2) + '" stroke="#bbb" stroke-width="0.25"/>');
    s.push('<line x1="141" y1="0" x2="141" y2="' + geo.hMM.toFixed(2) + '" stroke="#bbb" stroke-width="0.25"/>');
    // 节拍线：和弦站（虚线，靠头部）+ 主旋律站（实线，靠带尾 105mm）
    for (var i = 0; i < geo.beatYs.length; i++) {
      var y1 = geo.beatYs[i], y2 = y1 + PHYS.stationGapMM;
      s.push('<line x1="0" y1="' + y1.toFixed(2) + '" x2="' + geo.wMM + '" y2="' + y1.toFixed(2) + '" stroke="#dcdce8" stroke-width="0.12" stroke-dasharray="1.5,1.5"/>');
      if (y2 < geo.hMM) s.push('<line x1="0" y1="' + y2.toFixed(2) + '" x2="' + geo.wMM + '" y2="' + y2.toFixed(2) + '" stroke="#e0e0e0" stroke-width="0.15"/>');
    }
    // 两站起点虚线
    s.push('<line x1="0" y1="' + PHYS.leadInMM + '" x2="' + geo.wMM + '" y2="' + PHYS.leadInMM + '" stroke="#66c" stroke-width="0.25" stroke-dasharray="1,1"/>');
    var melStart = PHYS.leadInMM + PHYS.stationGapMM;
    s.push('<line x1="0" y1="' + melStart + '" x2="' + geo.wMM + '" y2="' + melStart + '" stroke="#c66" stroke-width="0.25" stroke-dasharray="1,1"/>');
    // 孔（按排分色：主旋律红橙 / 和弦绿；换挡键孔灰描边）
    for (var j = 0; j < geo.holes.length; j++) {
      var hh = geo.holes[j];
      if (PP.isShiftLane(hh.lane)) {
        s.push('<circle cx="' + hh.x.toFixed(2) + '" cy="' + hh.y.toFixed(2) + '" r="' + PHYS.holeRadiusMM + '" fill="none" stroke="#888" stroke-width="0.2"/>');
      } else {
        s.push('<circle cx="' + hh.x.toFixed(2) + '" cy="' + hh.y.toFixed(2) + '" r="' + PHYS.holeRadiusMM + '" fill="' + (hh.row === 0 ? '#a8431f' : '#1e7a4f') + '"/>');
      }
    }
    s.push('</svg>');
    download('完美钢琴纸带打孔图.svg', new Blob([s.join('\n')], { type: 'image/svg+xml' }));
    setMsg('SVG 已导出（1:1 毫米单位，主旋律孔比和弦孔靠带尾 105mm；打印请关闭缩放）');
  }

  function exportPNG() {
    if (!state.holes.length) { setMsg('纸带为空，先打孔或导入 MIDI'); return; }
    var scale = 8;
    var geo = PP.exportGeometry(state.holes, state.endCol, state.mmPerBeat);
    while ((geo.wMM * scale > 16000 || geo.hMM * scale > 16000) && scale > 2) scale -= 2;
    var cv = document.createElement('canvas');
    cv.width = Math.ceil(geo.wMM * scale);
    cv.height = Math.ceil(geo.hMM * scale);
    var c = cv.getContext('2d');
    c.fillStyle = '#fff';
    c.fillRect(0, 0, cv.width, cv.height);
    c.strokeStyle = '#e0e0e0';
    c.lineWidth = Math.max(1, scale * 0.12);
    for (var gx = 9; gx <= 141.01; gx += 4) {
      c.beginPath(); c.moveTo(gx * scale, 0); c.lineTo(gx * scale, cv.height); c.stroke();
    }
    c.strokeStyle = '#e6e6e6';
    for (var i = 0; i < geo.beatYs.length; i++) {
      var y2 = geo.beatYs[i] + PHYS.stationGapMM;
      if (y2 < geo.hMM) { c.beginPath(); c.moveTo(0, y2 * scale); c.lineTo(cv.width, y2 * scale); c.stroke(); }
      c.save(); c.setLineDash([scale * 1.5, scale * 1.5]); c.beginPath(); c.moveTo(0, geo.beatYs[i] * scale); c.lineTo(cv.width, geo.beatYs[i] * scale); c.stroke(); c.restore();
    }
    for (var j = 0; j < geo.holes.length; j++) {
      var hh = geo.holes[j];
      c.beginPath();
      c.arc(hh.x * scale, hh.y * scale, PHYS.holeRadiusMM * scale, 0, 6.2832);
      if (PP.isShiftLane(hh.lane)) { c.strokeStyle = '#888'; c.lineWidth = Math.max(1, scale * 0.2); c.stroke(); }
      else { c.fillStyle = hh.row === 0 ? '#a8431f' : '#1e7a4f'; c.fill(); }
    }
    cv.toBlob(function (blob) {
      if (blob) { download('完美钢琴纸带打孔图.png', blob); setMsg('PNG 已导出（' + scale + ' px/mm）'); }
    }, 'image/png');
  }

  // ---------------- 示例曲 ----------------
  function loadDemo() {
    pushUndo();
    var res = PP.demoSong();
    state.holes = res.holes;
    state.endCol = res.endCol;
    state.bpm = res.bpm; $('bpm').value = res.bpm;
    state.tempoMap = null;
    state.transpose = 0;
    state.mmPerBeat = PHYS.mmPerBeat;
    state.report = { shifts: res.shifts, blackMapped: 0, clamped: 0, pushedNotes: 0, holeCount: res.holes.length };
    setMsg('示例曲《小星星》已载入（下排主旋律 + 上排和弦），可播放试听');
    updateSpacer(); draw(); updateStatus();
  }

  // ---------------- 事件绑定 ----------------
  $('btnImport').addEventListener('click', function () { $('fileMidi').value = ''; $('fileMidi').click(); });
  $('fileMidi').addEventListener('change', function () {
    if (this.files && this.files[0]) importMidiFile(this.files[0]);
  });
  $('btnDlgOk').addEventListener('click', confirmImport);
  $('btnDlgCancel').addEventListener('click', closeImportDialog);
  $('btnDemo').addEventListener('click', loadDemo);

  $('btnUrl').addEventListener('click', openUrlDialog);
  $('btnUrlCancel').addEventListener('click', closeUrlDialog);
  $('btnUrlFetch').addEventListener('click', fetchMidiFromUrl);
  $('urlInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') fetchMidiFromUrl(); });

  $('btnPlay').addEventListener('click', function () { state.playing ? pause() : play(); });
  $('btnStop').addEventListener('click', stopPlayback);

  $('bpm').addEventListener('change', function () {
    var v = Math.min(240, Math.max(40, parseInt(this.value, 10) || 100));
    this.value = v;
    var droppedMap = !!state.tempoMap;
    state.bpm = v;
    state.tempoMap = null;
    if (state.playing) {
      state.playStartCtx = nowSec();
      state.playStartSec = beatToSec(state.curBeat);
    }
    if (droppedMap) setMsg('已切换为恒定速度 ' + v + ' BPM（重新转换可恢复 MIDI 变速）');
    updateStatus();
  });

  $('btnZoomIn').addEventListener('click', function () { setZoom(state.pxPerMM * 1.25); });
  $('btnZoomOut').addEventListener('click', function () { setZoom(state.pxPerMM / 1.25); });
  $('btnFit').addEventListener('click', fitWidth);
  viewport.addEventListener('wheel', function (e) {
    if (e.ctrlKey) {
      e.preventDefault();
      setZoom(state.pxPerMM * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientY - canvas.getBoundingClientRect().top);
    }
  }, { passive: false });

  $('btnUndo').addEventListener('click', undo);
  $('btnRedo').addEventListener('click', redo);
  $('btnClear').addEventListener('click', function () {
    if (!state.holes.length) return;
    pushUndo();
    state.holes = [];
    state.endCol = 0;
    state.tempoMap = null;
    state.mmPerBeat = PHYS.mmPerBeat;
    state.report = null;
    setMsg('已清空纸带');
    updateSpacer(); draw(); updateStatus();
  });

  $('btnSave').addEventListener('click', saveProject);
  $('btnOpen').addEventListener('click', function () { $('fileJson').value = ''; $('fileJson').click(); });
  $('fileJson').addEventListener('change', function () {
    if (this.files && this.files[0]) openProjectFile(this.files[0]);
  });
  $('btnSVG').addEventListener('click', exportSVG);
  $('btnPNG').addEventListener('click', exportPNG);

  viewport.addEventListener('scroll', function () { draw(); });
  window.addEventListener('resize', resizeCanvas);

  window.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.code === 'Space') { e.preventDefault(); state.playing ? pause() : play(); }
    else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); redo(); }
  });

  // ---------------- 启动 ----------------
  (function initTransposeOptions() {
    var sel = $('selTranspose'), opts = ['<option value="auto" selected>自动</option>'];
    for (var t = -6; t <= 6; t++) opts.push('<option value="' + t + '">' + (t > 0 ? '+' : '') + t + '</option>');
    sel.innerHTML = opts.join('');
  })();
  fitWidth(); // 启动即纸带全宽贴合视口
  resizeCanvas();
  updateStatus();
  window.__pp = state; // 调试 / 自动化测试用
})();
