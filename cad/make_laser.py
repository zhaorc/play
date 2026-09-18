# -*- coding: utf-8 -*-
# 滚轮激光切割文件生成（与 SolidWorks 模型同一几何）：
#   外轮廓：圆弧 R20 + 4 个半圆头凸起（齿宽 4、顶高 R23、顶角 R2）
#   内孔：Ø15
# 输出：DXF（激光切割）+ SVG（预览）。单位 mm，材料 PVC 板厚 1.5mm。
import math
import os

OUT_DIR = r"C:\d_pan\wokspace\play\cad"
DXF = os.path.join(OUT_DIR, "roller_laser_pvc1p5.dxf")
SVG = os.path.join(OUT_DIR, "roller_laser_pvc1p5.svg")

R_DISC = 20.0
R_HOLE = 7.5
TOOTH_IN = 19.0     # 齿底边半径（模型内部，轮廓侧为圆交点）
TIP_C = 21.0        # 齿顶圆弧圆心半径
TIP_R = 2.0
HALF_W = 2.0
DELTA = math.degrees(math.asin(HALF_W / R_DISC))   # 齿侧与圆交点的角偏 ≈5.7392°
TEETH = (0.0, 90.0, 180.0, 270.0)


def dirv(deg):
    a = math.radians(deg)
    return (R_DISC * math.cos(a), R_DISC * math.sin(a))


def tooth_points(deg):
    """返回 (Jm, Em, tipCtr, Ep, Jp)（角度 deg 处的齿：Jm=圆交点下侧，E=顶弧端点）"""
    a = math.radians(deg)
    c = (math.cos(a), math.sin(a))
    t = (-math.sin(a), math.cos(a))          # 切向单位向量（逆时针方向）
    j_m = dirv(deg - DELTA)
    j_p = dirv(deg + DELTA)
    e_m = (TIP_C * c[0] - HALF_W * t[0], TIP_C * c[1] - HALF_W * t[1])
    e_p = (TIP_C * c[0] + HALF_W * t[0], TIP_C * c[1] + HALF_W * t[1])
    ctr = (TIP_C * c[0], TIP_C * c[1])
    return j_m, e_m, ctr, e_p, j_p


def ang_at(ctr, p):
    return math.degrees(math.atan2(p[1] - ctr[1], p[0] - ctr[0]))


def f(v):
    return "%.4f" % v


# ---------- DXF ----------
ents = []
# 外轮廓圆弧段（齿与齿之间）
for k, deg in enumerate(TEETH):
    nxt = TEETH[(k + 1) % 4]
    a1 = (deg + DELTA) % 360.0
    a2 = (nxt - DELTA) % 360.0
    if a2 <= a1:
        a2 += 360.0
    ents.append("ARC|%s|%s|%s|%s|%s" % (f(0.0), f(0.0), f(R_DISC), f(a1), f(a2)))
# 齿：两条侧线 + 半圆头顶弧（CCW 从下侧端点经外侧到上侧端点）
for deg in TEETH:
    j_m, e_m, ctr, e_p, j_p = tooth_points(deg)
    ents.append("LINE|%s|%s|%s|%s" % (f(j_m[0]), f(j_m[1]), f(e_m[0]), f(e_m[1])))
    ents.append("LINE|%s|%s|%s|%s" % (f(e_p[0]), f(e_p[1]), f(j_p[0]), f(j_p[1])))
    a1 = (deg - 90.0) % 360.0
    a2 = (deg + 90.0) % 360.0
    if a2 <= a1:
        a2 += 360.0
    ents.append("ARC|%s|%s|%s|%s|%s" % (f(ctr[0]), f(ctr[1]), f(TIP_R), f(a1), f(a2)))
# 中心孔
ents.append("CIRCLE|%s|%s|%s" % (f(0.0), f(0.0), f(R_HOLE)))

lines = ["999", "roller_laser_cut_PVC_1.5mm_d40_4bumps_h3_w4_R2_hole_d15_unit_mm",
         "0", "SECTION", "2", "ENTITIES"]
for e in ents:
    parts = e.split("|")
    if parts[0] == "LINE":
        lines += ["0", "LINE", "8", "0", "10", parts[1], "20", parts[2], "30", "0.0",
                  "11", parts[3], "21", parts[4], "31", "0.0"]
    elif parts[0] == "ARC":
        lines += ["0", "ARC", "8", "0", "10", parts[1], "20", parts[2], "30", "0.0",
                  "40", parts[3], "50", parts[4], "51", parts[5]]
    elif parts[0] == "CIRCLE":
        lines += ["0", "CIRCLE", "8", "0", "10", parts[1], "20", parts[2], "30", "0.0",
                  "40", parts[3]]
lines += ["0", "ENDSEC", "0", "EOF"]
with open(DXF, "w") as fp:
    fp.write("\n".join(lines))
print("DXF:", DXF, os.path.getsize(DXF), "bytes")

# ---------- SVG（1mm = S px 预览；y 翻转后所有弧 sweep=0：外轮廓/顶弧均经外侧）----------
S = 4.0
d = []
first = tooth_points(TEETH[0])[0]   # 从 0° 齿的 Jm 开始（CCW）
d.append("M %s %s" % (f(first[0] * S), f(-first[1] * S)))
for k, deg in enumerate(TEETH):
    j_m, e_m, ctr, e_p, j_p = tooth_points(deg)
    d.append("L %s %s" % (f(e_m[0] * S), f(-e_m[1] * S)))
    d.append("A %s %s 0 0 0 %s %s" % (f(TIP_R * S), f(TIP_R * S), f(e_p[0] * S), f(-e_p[1] * S)))
    d.append("L %s %s" % (f(j_p[0] * S), f(-j_p[1] * S)))
    nxt = TEETH[(k + 1) % 4]
    jn_m = tooth_points(nxt)[0]
    d.append("A %s %s 0 0 0 %s %s" % (f(R_DISC * S), f(R_DISC * S),
                                      f(jn_m[0] * S), f(-jn_m[1] * S)))
d.append("Z")
path_d = " ".join(d)
svg = ['<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d">' % (200 * S, 200 * S),
       '<g transform="translate(%d,%d)">' % (100 * S, 100 * S),
       '<path d="%s" fill="none" stroke="#c33" stroke-width="1"/>' % path_d,
       '<circle cx="0" cy="0" r="%s" fill="none" stroke="#c33" stroke-width="1"/>' % f(R_HOLE * S),
       '</g></svg>']
with open(SVG, "w") as fp:
    fp.write("\n".join(svg))
print("SVG:", SVG, os.path.getsize(SVG), "bytes")
print("GEOMETRY: analytic, %d entities" % len(ents))
print("DONE")
