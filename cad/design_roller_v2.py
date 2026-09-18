# -*- coding: utf-8 -*-
# 滚轮 v3（激光切割用）：PVC 板
#   圆盘 Ø40 × 厚 1.5mm，中心孔 Ø15
#   4 个矩形突台（0/90/180/270°）：周向宽 4mm，平顶（无圆角）
#   突台高度按"相邻两顶点连线与滚轮相切"定：h = R√2 = 28.284mm，
#   突出高度 h−R = 8.284mm；底边伸入盘内 1mm 保证实体合并
import math
import os
import win32com.client as wc

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
sm.CreateCircleByRadius(0.0, 0.0, 0.0, R_DISC)
sm.CreateCircleByRadius(0.0, 0.0, 0.0, R_HOLE)
sm.AddToDB = False
sm.InsertSketch(True)
assert select_last_feature(), "SKETCH1_SELECT_FAIL"
bf1 = extrude(TH)
assert bf1 is not None, "EXTRUDE1_FAIL"
print("FEATURE1:", bf1.Name)

# ---- 特征 2：4 个矩形平顶突台 × 1.5mm（Merge）----
front.Select2(False, 0)
sm.InsertSketch(True)
sm.AddToDB = True
for deg in (0, 90, 180, 270):
    A = rot((TOOTH_IN, -HALF_W), deg)
    B = rot((H_TIP, HALF_W), deg)
    sm.CreateCornerRectangle(A[0], A[1], 0.0, B[0], B[1], 0.0)
sm.AddToDB = False
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
