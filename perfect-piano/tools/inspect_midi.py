"""临时排查脚本：解析 MIDI 文件，输出每轨音域与开头音符（排查首音是否超窗 C4~B5）。"""
import struct, sys, pathlib

def parse(path):
    data = pathlib.Path(path).read_bytes()
    if data[:4] != b'MThd': raise ValueError('not SMF')
    fmt, ntrk, division = struct.unpack('>HHH', data[8:14])
    pos = 14
    tracks = []
    while pos < len(data) and len(tracks) < ntrk:
        if data[pos:pos+4] != b'MTrk':
            # 跳过未知块
            blen = struct.unpack('>I', data[pos+4:pos+8])[0]
            pos += 8 + blen
            continue
        blen = struct.unpack('>I', data[pos+4:pos+8])[0]
        chunk = data[pos+8:pos+8+blen]
        pos += 8 + blen
        # 解析事件
        i = 0
        tick = 0
        running = None
        notes = []
        tempo = []  # (tick, us_per_qn)
        names = []
        def rdvar():
            nonlocal i
            v = 0
            while True:
                b = chunk[i]; i += 1
                v = (v << 7) | (b & 0x7F)
                if not (b & 0x80): return v
        while i < len(chunk):
            tick += rdvar()
            st = chunk[i]
            if st & 0x80: i += 1
            else: st = running
            running = st if st < 0xF0 else running
            if st == 0xFF:
                typ = chunk[i]; i += 1
                ln = rdvar()
                payload = chunk[i:i+ln]; i += ln
                if typ == 0x51 and ln == 3:
                    tempo.append((tick, (payload[0]<<16)|(payload[1]<<8)|payload[2]))
                elif typ == 0x03:
                    names.append(payload.decode('latin1', 'replace'))
            elif st in (0xF0, 0xF7):
                ln = rdvar(); i += ln
            else:
                hi, lo = st & 0xF0, st & 0x0F
                if hi == 0x90:
                    note, vel = chunk[i], chunk[i+1]; i += 2
                    if vel > 0: notes.append((tick, note, lo))
                elif hi in (0x80,):
                    i += 2
                elif hi in (0xA0, 0xB0, 0xE0):
                    i += 2
                elif hi in (0xC0, 0xD0):
                    i += 1
        tracks.append(dict(name=names[0] if names else '', notes=notes, tempo=tempo))
    return dict(fmt=fmt, division=division, tracks=tracks)

NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
def nm(m): return NAMES[m%12] + str(m//12 - 1)

for path in sys.argv[1:]:
    m = parse(path)
    print(f'== {path}  fmt={m["fmt"]} TPB={m["division"]} tracks={len(m["tracks"])}')
    # 全局速度表
    tempos = sorted([t for tr in m['tracks'] for t in tr['tempo']])
    def tick2sec(tick):
        sec = 0.0; last = 0; cur = 500000
        for tt, us in tempos:
            if tt >= tick: break
            sec += (tt - last) * cur / m['division'] / 1e6
            last, cur = tt, us
        return sec + (tick - last) * cur / m['division'] / 1e6
    for ti, tr in enumerate(m['tracks']):
        if not tr['notes']: continue
        ns = sorted(tr['notes'])
        pitches = [n[1] for n in ns]
        avg = sum(pitches)/len(pitches)
        print(f'  轨{ti} {tr["name"]!r:24} {len(ns):4}音  音域 {nm(min(pitches))}~{nm(max(pitches))}  均值 {nm(round(avg))}')
        firsts = ns[:8]
        print('    开头: ' + '  '.join(f'{nm(p)}@{tick2sec(t):.2f}s' for t, p, _ in firsts))
        below = [n for n in ns if n[1] < 60]
        above = [n for n in ns if n[1] > 83]
        if below: print(f'    <C4: {len(below)}个 最低{nm(min(pitches))}')
        if above: print(f'    >B5: {len(above)}个 最高{nm(max(pitches))}')
