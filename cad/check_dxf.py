# -*- coding: utf-8 -*-
# DXF 回读校验：实体数、轮廓链闭合（每个端点恰出现 2 次）、最大半径
import math
from collections import Counter

P = r"C:\d_pan\wokspace\play\cad\roller_laser_pvc1p5.dxf"
ln = [l.strip() for l in open(P) if l.strip() is not None]
ln = [l for l in ln if l != ""]

pairs = []
for k in range(0, len(ln) - 1, 2):
    pairs.append((ln[k], ln[k + 1]))

ents = [v for c, v in pairs if c == "0"]
print("ENTITIES:", dict(Counter(ents)))

pts = []
i = 0
while i < len(pairs):
    code, val = pairs[i]
    if code != "0":
        i += 1
        continue
    # 收集该实体的组码
    d = {}
    j = i + 1
    while j < len(pairs) and pairs[j][0] != "0":
        d[pairs[j][0]] = pairs[j][1]
        j += 1
    if val == "LINE":
        pts.append((round(float(d["10"]), 3), round(float(d["20"]), 3)))
        pts.append((round(float(d["11"]), 3), round(float(d["21"]), 3)))
    elif val == "ARC":
        cx, cy, r = float(d["10"]), float(d["20"]), float(d["40"])
        a1, a2 = math.radians(float(d["50"])), math.radians(float(d["51"]))
        if a2 <= a1:
            a2 += 2 * math.pi
        for a in (a1, a2):
            pts.append((round(cx + r * math.cos(a), 3), round(cy + r * math.sin(a), 3)))
        am = (a1 + a2) / 2.0
        pts.append((round(cx + r * math.cos(am), 3), round(cy + r * math.sin(am), 3)))
    elif val == "CIRCLE":
        cx, cy, r = float(d["10"]), float(d["20"]), float(d["40"])
        print("HOLE: center (%s,%s) R=%s" % (cx, cy, r))
    i = j

cnt = Counter(pts)
bad = {k: v for k, v in cnt.items() if v != 2}
print("ENDPOINTS:", len(pts), "BAD_CHAIN:", bad if bad else "none - outline closed OK")
maxr = max(math.hypot(x, y) for x, y in pts)
print("MAX_RADIUS_MM:", maxr, "(expect 23.0)")
