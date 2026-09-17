/* ============================================================
 * 打孔机上位机模块 punch-sender.js
 * 纸带钢琴工坊 → Arduino Nano 打孔机（固件 puncher.ino）
 *
 * 纯函数（可在 test.html 断言）：
 *   Punch.buildTask(holes, mmb)   孔序列 → 打孔任务（机器坐标 mm，
 *                                  x 主序（走带方向）y 次序（带宽方向））
 *   Punch.formatPunch(t)          任务项 → 'P x y' 命令行
 *   Punch.estimate(task, feed)    行程 / 用时估算
 *   Punch.exportTaskText(task)    任务 → .punch 文本
 *   Punch.FW                      固件常量（当量 / 时序）
 *
 * 串口（Web Serial，需 Chrome/Edge；Android Chrome + OTG 亦可）：
 *   Punch.SerialLink              连接 / 行收发 / 日志回调
 *
 * 机器坐标约定（与固件一致）：机器 x = 纸带长度（holeYMM），
 *                            机器 y = 纸带宽度（laneXMM）
 * ============================================================ */
(function (global) {
  'use strict';
  var PP = window.PPKit;

  // ---- 与固件 puncher.ino 保持一致的常量 ----
  var FW = {
    BAUD: 115200,
    X_PMM: 25600 / (Math.PI * 24),        // Φ24 滚轮 → 339.53 脉冲/mm
    Y_PMM: 25600 / (Math.PI * 21),        // 1模21齿节圆 Φ21 → 388.03 脉冲/mm
    DRILL_MS: 2000,                        // 钻孔保持
    SERVO_TRAVEL_MS: 500,                  // 舵机到位等待（下压/抬起各一次）
    FEED_DEFAULT: 10                       // 默认进给 mm/s
  };

  // ---------------- 纯函数 ----------------
  function buildTask(holes, mmb) {
    var task = (holes || []).map(function (h) {
      return {
        x: PP.holeYMM(h.col, h.row, h.lane, mmb), // 走带方向（长度；换挡孔含 +5mm 滚轮错位）
        y: PP.laneXMM(h.row, h.lane),        // 带宽方向
        col: h.col, row: h.row, lane: h.lane
      };
    });
    // 纸带单向进给：x 升序为主；同 x（同列）先打低 y 再打高 y
    task.sort(function (a, b) { return a.x - b.x || a.y - b.y; });
    return task;
  }

  function formatPunch(t) {
    return 'P ' + t.x.toFixed(2) + ' ' + t.y.toFixed(2);
  }

  // 估算：逐孔 |dx|+|dy|（固件 X、Y 顺序移动）+ 每孔钻孔子循环
  function estimate(task, feed) {
    task = task || [];
    if (!task.length) return { holes: 0, travel: 0, seconds: 0, xEnd: 0 };
    var travel = 0, px = 0, py = 0;
    task.forEach(function (t) {
      travel += Math.abs(t.x - px) + Math.abs(t.y - py);
      px = t.x; py = t.y;
    });
    var seconds = travel / feed + task.length * (FW.DRILL_MS + 2 * FW.SERVO_TRAVEL_MS) / 1000;
    return { holes: task.length, travel: travel, seconds: seconds, xEnd: px };
  }

  function exportTaskText(task) {
    var lines = ['# puncher task v1', '# x_mm y_mm（机器坐标，原点=对刀点）'];
    (task || []).forEach(function (t) {
      lines.push('P ' + t.x.toFixed(2) + ' ' + t.y.toFixed(2));
    });
    return lines.join('\n') + '\n';
  }

  // ---------------- 串口链路（Web Serial） ----------------
  function SerialLink() {
    this.port = null;
    this.writer = null;
    this.keepReading = false;
    this.connected = false;
    this._buf = '';
    this._enc = new TextEncoder();
    this._dec = new TextDecoder();
    this.onLog = null;      // function (dir, text)  dir: '→' | '←'
    this.onLine = null;     // function (line) 收到完整行
  }

  SerialLink.prototype.connect = async function () {
    if (!('serial' in navigator)) throw new Error('此浏览器不支持 Web Serial（需 Chrome/Edge）');
    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate: FW.BAUD });
    this.writer = this.port.writable.getWriter();
    this.connected = true;
    this.keepReading = true;
    this._readLoop();
  };

  SerialLink.prototype._readLoop = async function () {
    var self = this;
    while (self.port && self.port.readable && self.keepReading) {
      var reader = self.port.readable.getReader();
      try {
        while (self.keepReading) {
          var r = await reader.read();
          if (r.done) break;
          self._buf += self._dec.decode(r.value);
          var idx;
          while ((idx = self._buf.indexOf('\n')) >= 0) {
            var line = self._buf.slice(0, idx).replace(/\r$/, '');
            self._buf = self._buf.slice(idx + 1);
            if (line) {
              if (self.onLog) self.onLog('←', line);
              if (self.onLine) self.onLine(line);
            }
          }
        }
      } catch (e) { /* 断开 */ }
      finally { try { reader.releaseLock(); } catch (e2) {} }
    }
  };

  SerialLink.prototype.send = async function (text) {
    if (!this.writer) throw new Error('串口未连接');
    if (this.onLog) this.onLog('→', text);
    await this.writer.write(this._enc.encode(text + '\n'));
  };

  SerialLink.prototype.disconnect = async function () {
    this.keepReading = false;
    this.connected = false;
    if (this.writer) { try { this.writer.releaseLock(); } catch (e) {} this.writer = null; }
    if (this.port) { try { await this.port.close(); } catch (e) {} this.port = null; }
  };

  global.Punch = {
    FW: FW,
    buildTask: buildTask,
    formatPunch: formatPunch,
    estimate: estimate,
    exportTaskText: exportTaskText,
    SerialLink: SerialLink
  };

  // ================= UI 集成（仅当页面存在打孔面板时生效）=================
  if (!document.getElementById('btnPunch')) return;

  function $(id) { return document.getElementById(id); }
  var dlg = $('dlgPunch');
  var link = null;
  var task = null;
  var cursor = 0;          // 下一个待发孔下标
  var running = false;
  var paused = false;
  var aborted = false;
  var replyWaiter = null;
  var replyTimer = 0;

  // ---- 应答等待：收到一行即 resolve；超时 resolve('ERR TIMEOUT') ----
  function waitReply(ms) {
    return new Promise(function (resolve) {
      clearTimeout(replyTimer);
      replyWaiter = resolve;
      replyTimer = setTimeout(function () {
        replyWaiter = null;
        resolve('ERR TIMEOUT');
      }, ms || 30000);
    });
  }

  // ---- 串口行分派：优先喂给等待者；无等待者时处理主动上报 ----
  function routeLine(line) {
    if (replyWaiter) {
      var w = replyWaiter;
      replyWaiter = null;
      clearTimeout(replyTimer);
      w(line);
    } else if (line.indexOf('OK ESTOP') === 0) {
      abortByEstop();
    }
  }

  // 查询并回填当前位置（Q → POS x y）
  async function queryPos() {
    await link.send('Q');
    var r = await waitReply(5000);
    if (r.indexOf('POS') === 0) {
      var p = r.split(' ');
      $('pjX').value = p[1]; $('pjY').value = p[2];
      $('punchPos').textContent = '当前 ' + p[1] + ' , ' + p[2] + ' mm';
    } else {
      log('!', '查询应答：' + r);
    }
  }

  function log(dir, text) {
    var el = $('punchLog');
    var d = document.createElement('div');
    d.textContent = dir + ' ' + text;
    el.appendChild(d);
    while (el.childNodes.length > 200) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  }

  // ---- 面板状态刷新 ----
  function setLinkState() {
    var on = !!(link && link.connected);
    $('punchLinkState').textContent = on ? '已连接' : '未连接';
    ['btnPDisconnect', 'btnPJog', 'btnPOrigin', 'btnPQuery', 'btnPZ0', 'btnPZ1',
     'btnPFeed', 'btnPCal', 'btnPFirst', 'btnPStart'].forEach(function (id) {
      $(id).disabled = !on;
    });
    refreshRunButtons();
  }

  function refreshRunButtons() {
    var on = !!(link && link.connected && task && task.length);
    $('btnPStart').disabled = !on || running;
    $('btnPFirst').disabled = !on || running;
    $('btnPPause').disabled = !running;
    $('btnPEstop').disabled = !running && !paused;
  }

  function fmtSec(s) {
    if (s < 90) return Math.round(s) + ' 秒';
    if (s < 5400) return (s / 60).toFixed(1) + ' 分钟';
    return (s / 3600).toFixed(1) + ' 小时';
  }

  function updateTaskInfo() {
    var st = global.__pp || {};
    if (!task || !task.length) {
      $('punchTaskInfo').textContent = st.holes && st.holes.length ?
        '已生成：0 孔（异常）' : '当前纸带为空，请先导入/编辑';
      return;
    }
    var est = Punch.estimate(task, feedVal());
    $('punchTaskInfo').textContent =
      '共 ' + est.holes + ' 孔 · X 0 → ' + est.xEnd.toFixed(0) + ' mm' +
      ' · 总移动 ' + (est.travel / 1000).toFixed(2) + ' m' +
      ' · 预计 ~' + fmtSec(est.seconds);
  }

  function updateProgress(text) {
    $('punchProg').textContent = text ||
      (task ? '进度 ' + cursor + ' / ' + task.length : '—');
  }

  function feedVal() {
    var v = parseFloat($('pFeed').value);
    return isFinite(v) && v >= 1 && v <= 50 ? v : FW.FEED_DEFAULT;
  }

  // ---- 急停 / 暂停 ----
  function abortByEstop() {
    aborted = true;
    running = false;
    paused = false;
    updateProgress('已急停 · 已完成 ' + cursor + ' / ' + (task ? task.length : 0));
    refreshRunButtons();
  }

  // ---- 任务执行 ----
  async function runTask(fromIdx, count) {
    if (!link || !link.connected || !task || !task.length) return;
    running = true; paused = false; aborted = false;
    cursor = fromIdx;
    refreshRunButtons();
    var end = Math.min(fromIdx + count, task.length);
    var feed = feedVal();
    while (cursor < end) {
      if (aborted || paused) break;
      var t = task[cursor];
      updateProgress('第 ' + (cursor + 1) + ' / ' + task.length +
        ' 孔 · x=' + t.x.toFixed(1) + ' y=' + t.y.toFixed(1) + ' mm …');
      // 超时 = 移动时间 + 钻孔子循环 + 余量
      var to = (Math.abs(t.x) + Math.abs(t.y)) / feed * 1000 +
        FW.DRILL_MS + 2 * FW.SERVO_TRAVEL_MS + 15000;
      try { await link.send(Punch.formatPunch(t)); }
      catch (e) { log('!', '发送失败：' + e.message); break; }
      var r = await waitReply(to);
      if (r === 'DONE') { cursor++; continue; }
      if (r.indexOf('OK ESTOP') === 0) { abortByEstop(); return; }
      log('!', '孔 ' + (cursor + 1) + ' 异常应答：' + r);
      if (r === 'ERR TIMEOUT') { abortByEstop(); return; }
      break;
    }
    running = false;
    refreshRunButtons();
    if (aborted) abortByEstop();
    else if (paused) updateProgress('已暂停 · 已完成 ' + cursor + ' / ' + task.length +
      '（继续将从第 ' + (cursor + 1) + ' 孔开始）');
    else updateProgress(cursor >= task.length ?
      '全部完成 ✓ 共 ' + task.length + ' 孔' :
      '已停止 · 完成 ' + cursor + ' / ' + task.length);
  }

  // ---- 事件绑定 ----
  $('btnPunch').addEventListener('click', function () {
    dlg.classList.add('open');
    updateTaskInfo();
    updateProgress();
    setLinkState();
  });
  $('btnPClose').addEventListener('click', function () { dlg.classList.remove('open'); });

  $('btnPConnect').addEventListener('click', async function () {
    try {
      link = new Punch.SerialLink();
      link.onLog = log;
      link.onLine = routeLine;
      await link.connect();
      // 版本握手
      await link.send('V');
      var v = await waitReply(3000);
      log('i', '握手：' + v);
      if (v.indexOf('PUNCHER') === 0) await queryPos();
      setLinkState();
    } catch (e) {
      log('!', '连接失败：' + e.message);
      if (link) { try { await link.disconnect(); } catch (e2) {} }
      link = null;
      setLinkState();
    }
  });

  $('btnPDisconnect').addEventListener('click', async function () {
    if (running) { alert('请先急停或等待任务结束'); return; }
    if (link) { try { await link.disconnect(); } catch (e) {} }
    link = null;
    setLinkState();
  });

  $('btnPJog').addEventListener('click', async function () {
    if (!link || !link.connected || running) return;
    var x = parseFloat($('pjX').value), y = parseFloat($('pjY').value);
    if (!isFinite(x) || !isFinite(y)) { log('!', '坐标无效'); return; }
    try {
      await link.send('J ' + x.toFixed(2) + ' ' + y.toFixed(2));
      var r = await waitReply(120000);
      if (r === 'DONE') await queryPos();
      else log('!', '点动应答：' + r);
    } catch (e) { log('!', e.message); }
  });

  $('btnPOrigin').addEventListener('click', async function () {
    if (!link || !link.connected || running) return;
    await link.send('O');
    var r = await waitReply(5000);
    if (r === 'OK') {
      cursor = 0; // 换原点后从头计
      updateProgress('原点已设定（对刀点）');
      await queryPos();
    } else log('!', '设原点应答：' + r);
  });

  $('btnPQuery').addEventListener('click', function () {
    if (link && link.connected && !running) queryPos();
  });

  $('btnPZ0').addEventListener('click', function () { link && link.send('Z0'); });
  $('btnPZ1').addEventListener('click', function () { link && link.send('Z1'); });

  $('btnPFeed').addEventListener('click', async function () {
    if (!link || !link.connected) return;
    await link.send('F ' + feedVal());
    var r = await waitReply(5000);
    if (r !== 'OK') log('!', '设置进给应答：' + r);
    updateTaskInfo();
  });

  $('btnPCal').addEventListener('click', async function () {
    if (!link || !link.connected) return;
    var x = parseFloat($('pXpmm').value), y = parseFloat($('pYpmm').value);
    if (!isFinite(x) || !isFinite(y) || x < 50 || x > 5000 || y < 50 || y > 5000) {
      log('!', '当量范围 50~5000'); return;
    }
    await link.send('C ' + x.toFixed(2) + ' ' + y.toFixed(2));
    var r = await waitReply(5000);
    if (r !== 'OK') log('!', '校准应答：' + r);
  });

  $('btnPGen').addEventListener('click', function () {
    var st = global.__pp || {};
    task = Punch.buildTask(st.holes, st.mmPerBeat);
    cursor = 0;
    updateTaskInfo();
    updateProgress();
    setLinkState();
  });

  $('btnPFirst').addEventListener('click', function () { runTask(0, 1); });

  $('btnPStart').addEventListener('click', function () {
    if (running) return;
    if (cursor >= task.length) cursor = 0;
    var est = Punch.estimate(task.slice(cursor), feedVal());
    if (!confirm('开始打孔：第 ' + (cursor + 1) + ' ~ ' + task.length + ' 孔，' +
        '预计 ~' + fmtSec(est.seconds) + '。\n' +
        '请确认：已装纸、钻头已装、原点已对刀（O）！')) return;
    runTask(cursor, task.length - cursor);
  });

  $('btnPPause').addEventListener('click', function () {
    if (!running) return;
    paused = true; // 当前孔打完后停
    log('i', '暂停请求已发出（当前孔完成后停止）');
  });

  $('btnPEstop').addEventListener('click', async function () {
    try { if (link && link.connected) await link.send('R'); } catch (e) {}
    abortByEstop();
  });

  $('btnPExport').addEventListener('click', function () {
    var st = global.__pp || {};
    var t = task && task.length ? task : Punch.buildTask(st.holes, st.mmPerBeat);
    if (!t.length) { alert('当前纸带没有孔可导出'); return; }
    var blob = new Blob([Punch.exportTaskText(t)], { type: 'text/plain' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '纸带任务.punch';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  });

  $('pFeed').addEventListener('change', updateTaskInfo);

  // Web Serial 支持性提示
  if (!('serial' in navigator)) {
    $('punchConnHint').innerHTML =
      '此浏览器不支持 Web Serial。请用 Chrome / Edge 打开（file:// 直开或 http://localhost 均可）。';
  }
})(window);
