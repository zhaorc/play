# -*- coding: utf-8 -*-
"""生成三个用于测试纸带钢琴换挡逻辑的 MIDI 文件。

换挡模型（参考 js/pp-tape.js）：
  每排 16 轨：轨 0=◀◀(降挡) 轨 1..14=白键(C4..B5 基础窗口) 轨 15=▶▶(升挡)
  换挡键每次移动 14 个白键（2 个八度），挡位范围 ±1 → 可奏 C2..B7
    挡位 0  → C4..B5   (MIDI 60..83)
    挡位 +1 → C6..B7   (MIDI 84..107)
    挡位 -1 → C2..B3   (MIDI 36..59)
  超出 ±1 的音被钳制；孔距后移越过换挡点的音被舍弃。

三个文件（全部白键，无黑键映射干扰，BPM=120，TPB=480）：
  1. shift_melody_only.mid  — 单轨主旋律，集中测下排换挡
  2. shift_chord_only.mid   — 单轨和弦，集中测上排换挡
  3. shift_combo.mid        — 双轨，主旋律+和弦同时独立换挡
"""
import struct
import os

TPB = 480
NOTE_DUR = 360          # 音符持续 3/4 拍，留 1/4 拍间隔
CHORD_DUR = 360

# ---------- 底层 MIDI 字节构造 ----------
def vlq(n):
    out = [n & 0x7F]
    n >>= 7
    while n:
        out.insert(0, 0x80 | (n & 0x7F))
        n >>= 7
    return bytes(out)

def chunk(cid, data):
    return cid + struct.pack('>I', len(data)) + data

def note_on(ch, note, vel=100):
    return bytes([0x90 | ch, note, vel])

def note_off(ch, note):
    return bytes([0x80 | ch, note, 0])

def tempo_meta(bpm):
    us = int(round(60_000_000 / bpm))
    return b'\xff\x51\x03' + struct.pack('>I', us)[1:]

def track_name(name):
    b = name.encode('utf-8')
    return b'\xff\x03' + vlq(len(b)) + b

def build_track(events):
    """events: [(tick, bytes), ...] 按 tick 升序"""
    events = sorted(events, key=lambda e: e[0])
    body = bytearray()
    last = 0
    for tick, data in events:
        body += vlq(tick - last) + data
        last = tick
    body += vlq(0) + b'\xff\x2f\x00'
    return chunk(b'MTrk', bytes(body))

def tempo_track(name, bpm):
    ev = [(0, track_name(name)), (0, tempo_meta(bpm))]
    return build_track(ev)

def melody_events(notes, ch=0):
    """notes: [(tick, midi), ...] 按 tick 升序"""
    ev = []
    for tick, m in notes:
        ev.append((tick, note_on(ch, m)))
        ev.append((tick + NOTE_DUR, note_off(ch, m)))
    return ev

def chord_events(chords, ch=0):
    """chords: [(tick, [midi,...]), ...]"""
    ev = []
    for tick, notes in chords:
        for m in notes:
            ev.append((tick, note_on(ch, m)))
            ev.append((tick + CHORD_DUR, note_off(ch, m)))
    return ev

def write_midi(path, tracks):
    header = chunk(b'MThd', struct.pack('>HHH', 1, len(tracks), TPB))
    data = header + b''.join(tracks)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(data)
    print('written:', os.path.abspath(path), len(data), 'bytes')

# ============================================================
# 1. 主旋律换挡测试（下排 row 0）
#    节拍标记（每拍=480 tick）
# ============================================================
def build_melody_only():
    B = 480  # 1 拍
    # 全白键，覆盖：基础窗口 → 升挡 → 回零 → 降挡 → 回零 → 超界钳制 → 边界密集舍弃
    # 换挡提前量 600ms（120BPM 折 1.2 拍）→ 需要换挡的相邻组之间留 ≥2 拍
    seq = []
    # 第 0-11 拍：基础窗口 C4..B5（不换挡）
    seq += [(0 * B, 60), (1 * B, 62), (2 * B, 64), (3 * B, 65),  # C4 D4 E4 F4
            (4 * B, 67), (5 * B, 69), (6 * B, 71), (7 * B, 72),  # G4 A4 B4 C5
            (8 * B, 74), (9 * B, 76), (10 * B, 79), (11 * B, 83)] # D5 E5 G5 B5
    # 第 13-15 拍：升挡 ▶▶，C6 D6 E6（需 +1，与前一音隔 2 拍给换挡留位）
    seq += [(13 * B, 84), (14 * B, 86), (15 * B, 88)]
    # 第 17-18 拍：回零挡 ◀◀，B5 A5
    seq += [(17 * B, 83), (18 * B, 81)]
    # 第 20-22 拍：降挡 ◀◀，B3 A3 G3（需 -1）
    seq += [(20 * B, 59), (21 * B, 57), (22 * B, 55)]
    # 第 24-25 拍：回零挡 ▶▶，C4 D4
    seq += [(24 * B, 60), (25 * B, 62)]
    # 第 26 拍：超 ±1 范围 C8（钳制）
    seq += [(26 * B, 108)]
    # 第 28-30 拍：密集 B5（每 1/4 拍一个，间隔 < 最小孔距 2 col）接 C6
    #   → 后移后部分 B5 越过升挡键列，被舍弃（验证"物理打不下"逻辑）
    quarter = B // 4
    dense = []
    for k in range(12):
        dense.append((28 * B + k * quarter, 83))  # B5 x12
    dense.append((32 * B, 84))                   # C6 → 升挡键在 31 拍附近
    seq += dense

    t0 = tempo_track('换挡测试-主旋律', 120)
    t1 = build_track(melody_events(seq, ch=0))
    return [t0, t1]

# ============================================================
# 2. 和弦换挡测试（上排 row 1）
# ============================================================
def build_chord_only():
    B = 480
    chords = []
    # 第 0-2 拍：基础窗口 C4 E4 G4 / F4 A4 C5 / G4 B4 D5（不换挡）
    chords += [(0 * B, [60, 64, 67]),
               (2 * B, [65, 69, 72]),
               (4 * B, [67, 71, 74])]
    # 第 6 拍：升挡 ▶▶，C6 E6 G6（+1）
    chords += [(6 * B, [84, 88, 91])]
    # 第 8 拍：回零挡 ◀◀，C4 E4 G4
    chords += [(8 * B, [60, 64, 67])]
    # 第 10 拍：降挡 ◀◀，C3 E3 G3（-1）
    chords += [(10 * B, [48, 52, 55])]
    # 第 12 拍：超 ±1 范围 C1 E1 G1（钳制）
    chords += [(12 * B, [24, 28, 31])]
    # 第 14-17 拍：密集 C4 E4 G4（每拍一次，升挡回零）接 C6 E6 G6 → 边界舍弃场景
    for k in range(4):
        chords.append(((14 + k) * B, [60, 64, 67]))
    chords.append((20 * B, [84, 88, 91]))   # 与前一和弦隔 3 拍，给升挡留位
    t0 = tempo_track('换挡测试-和弦', 120)
    t1 = build_track(chord_events(chords, ch=0))
    return [t0, t1]

# ============================================================
# 3. 组合测试：主旋律 + 和弦双轨，各行独立换挡
# ============================================================
def build_combo():
    B = 480
    # 主旋律（下排）：基础窗口 → 升挡 → 回零
    mel = [(0 * B, 60), (1 * B, 64), (2 * B, 67), (3 * B, 72),
           (4 * B, 76), (5 * B, 79), (6 * B, 83),     # 到 B5
           (8 * B, 84), (9 * B, 88), (10 * B, 91),    # C6 E6 G6 升挡
           (12 * B, 72), (13 * B, 67), (14 * B, 60)]   # 回零挡
    # 和弦（上排）：同时独立降挡 → 回零 → 升挡
    cho = [(0 * B, [48, 52, 55]),    # C3 E3 G3 降挡（与主旋律同时，独立）
           (4 * B, [60, 64, 67]),    # 回零挡
           (8 * B, [84, 88, 91]),    # 升挡（与主旋律升挡同步）
           (12 * B, [60, 64, 67])]   # 回零挡

    t0 = tempo_track('换挡测试-组合', 120)
    t1 = build_track(melody_events(mel, ch=0))
    t2 = build_track(chord_events(cho, ch=0))
    return [t0, t1, t2]

# ============================================================
if __name__ == '__main__':
    out_dir = os.path.join(os.path.dirname(__file__), '..', 'test')
    write_midi(os.path.join(out_dir, 'shift_melody_only.mid'), build_melody_only())
    write_midi(os.path.join(out_dir, 'shift_chord_only.mid'), build_chord_only())
    write_midi(os.path.join(out_dir, 'shift_combo.mid'), build_combo())
