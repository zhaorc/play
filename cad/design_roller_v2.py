# -*- coding: utf-8 -*-
# 滚轮 v3（激光切割用）：PVC 板
#   圆盘 Ø40 × 厚 1.5mm，中心孔 Ø15
#   4 个矩形突台（0/90/180/270°）：周向宽 4mm，平顶（无圆角）
#   突台高度按"相邻两顶点连线与滚轮相切"定：h = R√2 = 28.284mm，
#   突出高度 h−R = 8.284mm；底边伸入盘内 1mm 保证实体合并
import math
import os
import time
import threading
import pythoncom
import win32com.client as wc


# Add...Dimension2 在 SW2026 放置尺寸后等待第二次点击确认：主线程阻塞在 COM 调用期间，
# 由独立线程延时注入 ESC 结束工具状态（尺寸已按给定坐标放置，ESC 不撤销）
def esc_after(delay=0.9):
    def pulse():
        pythoncom.CoInitialize()
        try:
            time.sleep(delay)
            sh = wc.Dispatch("WScript.Shell")
            sh.AppActivate("SOLIDWORKS")
            time.sleep(0.1)
            sh.SendKeys("{ESC}")
            time.sleep(0.1)
            sh.SendKeys("{ESC}")
        finally:
            pythoncom.CoUninitialize()
    t = threading.Thread(target=pulse, daemon=True)
    t.start()
    return t


def add_dim(add_callable):
    """调用 Add...Dimension2：ESC 脉冲线程与阻塞调用并行，返回尺寸对象"""
    t = esc_after()
    dim = add_callable()
    t.join(timeout=5)
    time.sleep(0.3)
    return dim


TPL = r"C:\ProgramData\SolidWorks\SOLIDWORKS 2026\templates\gb_part.prtdot"
OUT_DIR = r"C:\d_pan\wokspace\play\cad"
OUT = os.path.join(OUT_DIR, "roller_d40x1p5_h15.SLDPRT")
PNG = os.path.join(OUT_DIR, "roller_d40x1p5_h15.png")

# 尺寸（米）
TH = 0.0015          # 厚 1.5mm
R_DISC = 0.020       # 盘 R20
R_HOLE = 0.0075      # 中心孔 R7.5
TOOTH_IN = 0.019     # 齿底边（伸入盘内 1mm）
H_TIP = R_DISC * math.sqrt(2.0)   # 顶点半径 h = R√2 ≈ 28.284mm（相邻顶点连线切于 R20）
HALF_W = 0.002       # 齿半宽 2mm（总宽 4mm）
TOOTH_H_MM = (H_TIP - R_DISC) * 1000.0
print("BUMP_HEIGHT_MM: %.4f  TIP_RADIUS_MM: %.4f  TIP_DIAMETER_MM: %.4f" %
      (TOOTH_H_MM, H_TIP * 1000.0, H_TIP * 2000.0))

# 期望面积（mm²）：盘环 + 4×(齿侧区间内轮廓矩形高出圆盘的面积)
def expected_volume_mm3():
    disc = math.pi * (20.0 ** 2 - 7.5 ** 2)
    h = 20.0 * math.sqrt(2.0)
    n = 4000
    ys = [(-2.0 + 4.0 * i / n) for i in range(n + 1)]
    tooth_out = sum(h - math.sqrt(400.0 - y * y) for y in ys) * (4.0 / n)
    area = disc + 4 * tooth_out
    return area * 1.5, area


assert os.path.exists(TPL), "NO_TEMPLATE"

mod = wc.gencache.EnsureModule("{83A33D31-27C5-11CE-BFD4-00400513BB57}", 0, 34, 0)
assert mod is not None, "NO_GENPY_CACHE"


def as_intfc(obj, name):
    if obj is None or obj.__class__.__module__.startswith("win32com.gen_py"):
        return obj
    return getattr(mod, name)(obj._oleobj_)


def rot(p, deg):
    a = math.radians(deg)
    return (p[0] * math.cos(a) - p[1] * math.sin(a), p[0] * math.sin(a) + p[1] * math.cos(a))


sw = as_intfc(wc.Dispatch("SldWorks.Application"), "ISldWorks")
sw.Visible = True
# 关掉历史调试遗留文档（不保存），否则同名零件处于打开状态会导致 SaveAs 覆盖失败
try:
    sw.CloseAllDocuments(False)
except Exception as e:
    print("CLOSEALL_ERR:", e)

doc = as_intfc(sw.NewDocument(TPL, 0, 0.0, 0.0), "IModelDoc2")
assert doc is not None, "NEWDOC_FAIL"
print("DOC_CREATED")

sm = as_intfc(doc.SketchManager, "ISketchManager")
fm = as_intfc(doc.FeatureManager, "IFeatureManager")


def select_last_feature():
    f = doc.FirstFeature()
    last = None
    while f is not None:
        last = f
        f = f.GetNextFeature
    return last.Select2(False, 0)


def extrude(t):
    return fm.FeatureExtrusion2(True, False, False, 0, 0, t, t,
                                 False, False, False, False, 0.0, 0.0,
                                 False, False, False, False, True, True, True, 0, 0.0, False)


# 找前视基准面
feat = doc.FirstFeature()
front = None
while feat is not None:
    if feat.GetTypeName2 == "RefPlane":
        front = feat
        break
    feat = feat.GetNextFeature
assert front is not None, "NO_PLANE"

# ---- 特征 1：盘环（圆 R20 + 中心孔 R7.5 套挖）× 1.5mm ----
front.Select2(False, 0)
sm.InsertSketch(True)
sm.AddToDB = True
arc_outer = sm.CreateCircleByRadius(0.0, 0.0, 0.0, R_DISC)
arc_hole = sm.CreateCircleByRadius(0.0, 0.0, 0.0, R_HOLE)
sm.AddToDB = False
# 草图智能尺寸（供工程图 InsertModelAnnotations3 导入）：Ø40 盘径、Ø15 孔
seg_outer = mod.ISketchSegment(arc_outer._oleobj_)
seg_hole = mod.ISketchSegment(arc_hole._oleobj_)
assert seg_outer.Select2(False, 0), "SEL_OUTER_FAIL"
d_outer = add_dim(lambda: doc.AddDiameterDimension2(0.030, 0.028, 0.0))
assert d_outer is not None, "DIM_OUTER_FAIL"
assert seg_hole.Select2(False, 0), "SEL_HOLE_FAIL"
d_hole = add_dim(lambda: doc.AddDiameterDimension2(0.013, 0.010, 0.0))
assert d_hole is not None, "DIM_HOLE_FAIL"
print("SKETCH1_DIMS: D40 + D15")
sm.InsertSketch(True)
assert select_last_feature(), "SKETCH1_SELECT_FAIL"
bf1 = extrude(TH)
assert bf1 is not None, "EXTRUDE1_FAIL"
print("FEATURE1:", bf1.Name)

# ---- 特征 2：4 个矩形平顶突台 × 1.5mm（Merge）----
front.Select2(False, 0)
sm.InsertSketch(True)
sm.AddToDB = True
rects = []
for deg in (0, 90, 180, 270):
    A = rot((TOOTH_IN, -HALF_W), deg)
    B = rot((H_TIP, HALF_W), deg)
    rects.append(sm.CreateCornerRectangle(A[0], A[1], 0.0, B[0], B[1], 0.0))
sm.AddToDB = False
# 草图 2 智能尺寸：CreateCornerRectangle 返回线段顺序不可靠，
# 按几何识别齿顶边——4 条边中"中点到原点距离最大"的即齿顶竖边（中点半径=H_TIP）
def seg_mid_radius(seg):
    s = mod.ISketchSegment(seg._oleobj_)
    ln = mod.ISketchLine(seg._oleobj_)
    sp = mod.ISketchPoint(ln.GetStartPoint2()._oleobj_)
    ep = mod.ISketchPoint(ln.GetEndPoint2()._oleobj_)
    mx = (sp.X + ep.X) * 0.5
    my = (sp.Y + ep.Y) * 0.5
    return math.hypot(mx, my), s


def tip_edge(rect):
    cands = [seg_mid_radius(seg) for seg in list(rect)]
    cands.sort(key=lambda t: -t[0])
    return cands[0][1]


#   齿顶圆 Ø56.57：0°齿与 180°齿两条对置齿顶竖边的水平间距 = 2h
#   齿宽 4：单条齿顶竖边 + 垂直尺寸（= 竖边长度 4mm）
e_tip = tip_edge(rects[0])       # x=+h 竖边
e_tip_op = tip_edge(rects[2])    # x=−h 竖边
# 齿顶圆：两条对置齿顶竖边 → 水平间距 = 2h = 56.57
assert e_tip.Select2(False, 0), "SEL_TIP_FAIL"
assert e_tip_op.Select2(True, 0), "SEL_TIP_OP_FAIL"
d_tip = add_dim(lambda: doc.AddHorizontalDimension2(0.004, -0.006, 0.0))
assert d_tip is not None, "DIM_TIPCIRCLE_FAIL"
# 齿宽：齿顶竖边长度 = 4mm（垂直尺寸）
assert e_tip.Select2(False, 0), "SEL_TIP2_FAIL"
d_w = add_dim(lambda: doc.AddVerticalDimension2(0.031, 0.004, 0.0))
assert d_w is not None, "DIM_WIDTH_FAIL"
print("SKETCH2_DIMS: tip circle Ø%.4f + width 4" % (H_TIP * 2000.0))
sm.InsertSketch(True)
assert select_last_feature(), "SKETCH2_SELECT_FAIL"
bf2 = extrude(TH)
assert bf2 is not None, "EXTRUDE2_FAIL"
print("FEATURE2:", bf2.Name)

# ---- 材质 PVC（非致命）----
try:
    pdoc = mod.IPartDoc(doc._oleobj_)
    pdoc.SetMaterialPropertyName2("", "", "PVC")
    print("MATERIAL: PVC")
except Exception as e:
    print("MATERIAL_ERR:", e)

doc.ViewZoomtofit2()

# ---- 保存 + 体积验证 ----
os.makedirs(OUT_DIR, exist_ok=True)
try:
    r = doc.Extension.SaveAs(OUT, 0, 1, None, 0, 0)   # Options=1 静默覆盖，返回 (ok, err, warn)
    print("EXTSAVE:", r)
except Exception as e:
    print("EXTSAVE_ERR:", e)
print("SLDPRT:", os.path.exists(OUT))

exp_vol, exp_area = expected_volume_mm3()
print("EXPECT_AREA_MM2: %.4f" % exp_area)
try:
    props = doc.GetMassProperties()
    vol_mm3 = float(props[3]) * 1e9
    print("VOLUME_MM3: %.3f  EXPECT: %.3f  DIFF: %.2f%%" %
          (vol_mm3, exp_vol, abs(vol_mm3 - exp_vol) / exp_vol * 100))
except Exception as e:
    print("MASS_ERR:", e)

try:
    if os.path.exists(PNG):
        os.remove(PNG)
    doc.ViewDisplayShaded()
    doc.ViewZoomtofit2()
    doc.SaveAs3(PNG, 0, 1)   # Options=1 静默覆盖
    print("PNG:", os.path.exists(PNG))
except Exception as e:
    print("PNG_ERR:", e)

print("DONE")
