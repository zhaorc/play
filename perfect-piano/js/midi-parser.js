/* ============================================================
 * 30音纸带音乐盒打孔工作室 - MIDI 解析器（零依赖）
 * 支持：Format 0/1、running status、tempo map、轨道名
 * 输出：{ format, ticksPerBeat, tracks, tempos }
 * ============================================================ */
(function (global) {
  'use strict';

  function MidiParseError(message) {
    this.name = 'MidiParseError';
    this.message = message;
  }
  MidiParseError.prototype = Object.create(Error.prototype);

  /** 读变长数量（Variable Length Quantity），返回 [值, 新位置] */
  function readVLQ(view, pos) {
    var value = 0, byte;
    for (var i = 0; i < 4; i++) {
      if (pos >= view.byteLength) throw new MidiParseError('MIDI 文件损坏：变长数字越界');
      byte = view.getUint8(pos++);
      value = (value << 7) | (byte & 0x7f);
      if (!(byte & 0x80)) return [value, pos];
    }
    return [value, pos];
  }

  function decodeText(view, pos, len) {
    var bytes = new Uint8Array(view.buffer, view.byteOffset + pos, len);
    try {
      var s = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/\0+$/g, '');
      // 含替换符说明不是有效 UTF-8：国内软件常用 GBK 编码曲目名，回退 GBK 解码
      if (s.indexOf('\uFFFD') !== -1) {
        try { s = new TextDecoder('gbk').decode(bytes).replace(/\0+$/g, ''); } catch (e2) { /* 保持 UTF-8 结果 */ }
      }
      return s;
    } catch (e) {
      var t = '';
      for (var i = 0; i < len; i++) t += String.fromCharCode(view.getUint8(pos + i));
      return t;
    }
  }

  /**
   * 解析 MIDI 文件（ArrayBuffer）
   * @returns {{format:number, ticksPerBeat:number, tracks:Array, tempos:Array}}
   *   tracks[i] = { index, name, channels:number[], notes:[{tick,note,velocity,channel}] }
   *   tempos = [{tick, usPerQuarter}]（已按出现顺序合并所有轨道）
   */
  function parseMidi(buffer) {
    var view = new DataView(buffer);
    var pos = 0;

    function u32() { var v = view.getUint32(pos); pos += 4; return v; }
    function u16() { var v = view.getUint16(pos); pos += 2; return v; }
    function str4() {
      var s = '';
      for (var i = 0; i < 4; i++) s += String.fromCharCode(view.getUint8(pos + i));
      pos += 4;
      return s;
    }

    if (view.byteLength < 14 || str4() !== 'MThd') {
      throw new MidiParseError('不是有效的 MIDI 文件（缺少 MThd 头）');
    }
    var headerLen = u32();
    var format = u16();
    var nTracks = u16();
    var division = u16();
    if (headerLen > 6) pos += headerLen - 6; // 跳过头部多余字段
    if (division & 0x8000) throw new MidiParseError('不支持 SMPTE 时间格式的 MIDI 文件');
    var ticksPerBeat = division || 480;

    var tempos = [];
    var tracks = [];

    while (pos + 8 <= view.byteLength) {
      var id = str4();
      var chunkLen = u32();
      var chunkEnd = Math.min(pos + chunkLen, view.byteLength);
      if (id !== 'MTrk') { pos = chunkEnd; continue; } // 跳过未知块

      var track = { index: tracks.length, name: '', channelsSet: {}, notes: [] };
      var tick = 0, runningStatus = 0;

      while (pos < chunkEnd) {
        var d;
        d = readVLQ(view, pos); tick += d[0]; pos = d[1];

        var status = view.getUint8(pos);
        if (status & 0x80) {
          pos++;
          if (status < 0xf0) runningStatus = status;
          else runningStatus = 0; // 系统消息清除 running status
        } else {
          status = runningStatus;
          if (!status) throw new MidiParseError('MIDI 文件损坏：缺失状态字节');
        }

        if (status === 0xff) { // 元事件
          var type = view.getUint8(pos++);
          var len;
          d = readVLQ(view, pos); len = d[0]; pos = d[1];
          if (type === 0x03) track.name = decodeText(view, pos, len);
          else if (type === 0x51 && len === 3) {
            tempos.push({
              tick: tick,
              usPerQuarter: (view.getUint8(pos) << 16) | (view.getUint8(pos + 1) << 8) | view.getUint8(pos + 2)
            });
          }
          pos += len;
        } else if (status === 0xf0 || status === 0xf7) { // 系统独占
          var slen;
          d = readVLQ(view, pos); slen = d[0]; pos = d[1];
          pos += slen;
        } else { // 通道消息
          var cmd = status & 0xf0, ch = status & 0x0f;
          switch (cmd) {
            case 0x90: { // Note On/Off（vel=0 视作 Off，打孔只关心 On）
              var note = view.getUint8(pos++);
              var vel = view.getUint8(pos++);
              track.channelsSet[ch] = true;
              if (vel > 0) track.notes.push({ tick: tick, note: note, velocity: vel, channel: ch });
              break;
            }
            case 0x80: pos += 2; break;
            case 0xa0: case 0xb0: case 0xe0: pos += 2; break;
            case 0xc0: case 0xd0: pos += 1; break;
            default: throw new MidiParseError('MIDI 文件损坏：未知事件 0x' + cmd.toString(16));
          }
        }
      }
      track.channels = Object.keys(track.channelsSet).map(Number).sort(function (a, b) { return a - b; });
      delete track.channelsSet;
      tracks.push(track);
      pos = chunkEnd;
    }

    if (!tracks.length) throw new MidiParseError('MIDI 文件中没有轨道数据');
    tempos.sort(function (a, b) { return a.tick - b.tick; });
    return { format: format, ticksPerBeat: ticksPerBeat, tracks: tracks, tempos: tempos };
  }

  global.MidiParser = { parseMidi: parseMidi, MidiParseError: MidiParseError };
})(typeof window !== 'undefined' ? window : globalThis);
