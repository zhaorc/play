# -*- coding: utf-8 -*-
# 滚轮激光切割文件生成（与 SolidWorks 模型同一几何，PVC 板厚 1.5mm）：
#   外轮廓：圆弧 R20 + 4 个平顶矩形突台（齿宽 4，顶点半径 h = R√2 ≈ 28.2843，
#   满足"相邻两突台顶点连线与 R20 滚轮相切"）；内孔 Ø15。
# 输出：DXF（激光切割）+ SVG（预览）。单位 mm。
import math
import os

OUT_DIR = r"C:\d_pan\wokspace\play\cad"
DXF = os.path.join(OUT_DIR, "roller_laser_pvc1p5.dxf")
SVG = os.path.join(OUT_DIR, "roller_laser_pvc1p5.svg")

R_DISC = 20.0
R_HOLE = 7.5
H_TIP = R_DISC * math.sqrt(2.0)     # 顶点半径 ≈ 28.2843
HALF_W = 2.0                        # 齿半宽（总宽 4mm）
DELTA = math.degrees(math.asin(HALF_W / R_DISC))   # 齿侧延长线与圆交点角偏 ≈5.7392°
TEETH = (0.0, 90.0, 180.0, 270.0)


def dirv(deg):
    a = math.radians(deg)
    return (R_DISC * math.cos(a), R_DISC * math.sin(a))


def tooth_points(deg):
    """(Jm, Em, Ep, Jp)：Jm/Jp 为齿侧与 R20 圆交点，E 为平顶两角（半径 H_TIP）"""
    a = math.radians(deg)
    c = (math.cos(a), math.sin(a))
    t = (-math.sin(a), math.cos(a))
    j_m = dirv(deg - DELTA)
    j_p = dirv(deg + DELTA)
    e_m = (H_TIP * c[0] - HALF_W * t[0], H_TIP * c[1] - HALF_W * t[1])
    e_p = (H_TIP * c[0] + HALF_W * t[0], H_TIP * c[1] + HALF_W * t[1])
    return j_m, e_m, e_p, j_p


def f(v):
    return "%.4f" % v


# ---------- DXF ----------
ents = []
for k, deg in enumerate(TEETH):
    nxt = TEETH[(k + 1) % 4]
    a1 = (deg + DELTA) % 360.0
    a2 = (nxt - DELTA) % 360.0
    if a2 <= a1:
        a2 += 360.0
    ents.append("ARC|%s|%s|%s|%s|%s" % (f(0.0), f(0.0), f(R_DISC), f(a1), f(a2)))
for deg in TEETH:
    j_m, e_m, e_p, j_p = tooth_points(deg)
    ents.append("LINE|%s|%s|%s|%s" % (f(j_m[0]), f(j_m[1]), f(e_m[0]), f(e_m[1])))  # 齿侧
    ents.append("LINE|%s|%s|%s|%s" % (f(e_m[0]), f(e_m[1]), f(e_p[0]), f(e_p[1])))  # 平顶
    ents.append("LINE|%s|%s|%s|%s" % (f(e_p[0]), f(e_p[1]), f(j_p[0]), f(j_p[1])))  # 齿侧
ents.append("CIRCLE|%s|%s|%s" % (f(0.0), f(0.0), f(R_HOLE)))

lines = ["999", "roller_laser_cut_PVC_1.5mm_d40_4bumps_tangent_h8.284_w4_hole_d15_unit_mm",
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

# ---------- SVG（y 翻转，外轮廓 CCW，弧 sweep=0）----------
S = 4.0
d = ["M %s %s" % (f(tooth_points(TEETH[0])[0][0] * S), f(-tooth_points(TEETH[0])[0][1] * S))]
for k, deg in enumerate(TEETH):
    j_m, e_m, e_p, j_p = tooth_points(deg)
    d.append("L %s %s" % (f(e_m[0] * S), f(-e_m[1] * S)))
    d.append("L %s %s" % (f(e_p[0] * S), f(-e_p[1] * S)))
    d.append("L %s %s" % (f(j_p[0] * S), f(-j_p[1] * S)))
    jn_m = tooth_points(TEETH[(k + 1) % 4])[0]
    d.append("A %s %s 0 0 0 %s %s" % (f(R_DISC * S), f(R_DISC * S),
                                      f(jn_m[0] * S), f(-jn_m[1] * S)))
d.append("Z")
svg = ['<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d">' % (240 * S, 240 * S),
       '<g transform="translate(%d,%d)">' % (120 * S, 120 * S),
       '<path d="%s" fill="none" stroke="#c33" stroke-width="1"/>' % " ".join(d),
       '<circle cx="0" cy="0" r="%s" fill="none" stroke="#c33" stroke-width="1"/>' % f(R_HOLE * S),
       '</g></svg>']
with open(SVG, "w") as fp:
    fp.write("\n".join(svg))
print("SVG:", SVG, os.path.getsize(SVG), "bytes")
print("TIP_RADIUS_MM: %.4f  CORNER_RADIUS_MM: %.4f  ENTITIES: %d" %
      (H_TIP, math.sqrt(H_TIP ** 2 + HALF_W ** 2), len(ents)))
print("DONE")
