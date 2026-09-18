# -*- coding: utf-8 -*-
# SolidWorks 自动建模：纸带驱动滚轮
#   圆盘：直径 40mm，厚 2mm
#   边缘均布 4 个矩形凸起（0/90/180/270 度）：径向高 3mm（尖端至 R23），周向宽 4mm
#   两段特征：圆盘拉伸 + 凸起矩形拉伸（Merge 合并；矩形伸入盘内避免草图轮廓自交）
#
# 绑定方式：实例 IDispatch::GetTypeInfo 损坏（PowerShell / pywin32 动态绑定全失败，
# VBScript 纯后期绑定可用但传不了 Callout 对象参数）——从 sldworks.tlb / swconst.tlb
# makepy 生成缓存后，用生成类手动包装实例：dispid 烘焙，绕开 GetTypeInfo/GetIDsOfNames。
import os
import win32com.client as wc

TPL = r"C:\ProgramData\SolidWorks\SOLIDWORKS 2026\templates\gb_part.prtdot"
OUT_DIR = r"C:\d_pan\wokspace\play\cad"
OUT = os.path.join(OUT_DIR, "roller_d40x2_4bumps.SLDPRT")
PNG = os.path.join(OUT_DIR, "roller_d40x2_4bumps.png")

assert os.path.exists(TPL), "NO_TEMPLATE"

mod = wc.gencache.EnsureModule("{83A33D31-27C5-11CE-BFD4-00400513BB57}", 0, 34, 0)
assert mod is not None, "NO_GENPY_CACHE"


def as_intfc(obj, name):
    """动态 CDispatch → makepy 类型类（烘焙 dispid）"""
    if obj is None or obj.__class__.__module__.startswith("win32com.gen_py"):
        return obj
    return getattr(mod, name)(obj._oleobj_)


sw = as_intfc(wc.Dispatch("SldWorks.Application"), "ISldWorks")
sw.Visible = True
print("BOUND:", type(sw).__module__, type(sw).__name__)

doc = as_intfc(sw.NewDocument(TPL, 0, 0.0, 0.0), "IModelDoc2")
assert doc is not None, "NEWDOC_FAIL"
print("DOC_CREATED")

sm = as_intfc(doc.SketchManager, "ISketchManager")
fm = as_intfc(doc.FeatureManager, "IFeatureManager")
ext = as_intfc(doc.Extension, "IModelDocExtension")


def select_last_feature():
    """选中特征树最后一项（刚退出草图后即新草图，绕开 SelectByID2 的 Callout 参数）"""
    f = doc.FirstFeature()
    last = None
    while f is not None:
        last = f
        f = f.GetNextFeature
    return last.Select2(False, 0)


def extrude_2mm():
    """单向盲拉伸 2mm，与已有实体合并"""
    return fm.FeatureExtrusion2(True, False, False, 0, 0, 0.002, 0.002,
                                 False, False, False, False, 0.0, 0.0,
                                 False, False, False, False, True, True, True, 0, 0.0, False)


# 找前视基准面（第一个 RefPlane 特征，规避中英文界面命名差异）
feat = doc.FirstFeature()
front = None
while feat is not None:
    if feat.GetTypeName2 == "RefPlane":   # 类型化接口中为属性
        front = feat
        break
    feat = feat.GetNextFeature           # 同上
assert front is not None, "NO_PLANE"
print("PLANE_SELECTED")

# ---- 特征 1：圆盘（R20 × 2mm）----
front.Select2(False, 0)
sm.InsertSketch(True)
sm.AddToDB = True
sm.CreateCircleByRadius(0.0, 0.0, 0.0, 0.020)
sm.AddToDB = False
sm.InsertSketch(True)
ok = select_last_feature()
print("SKETCH1_SELECTED", ok)
bf1 = extrude_2mm()
assert bf1 is not None, "EXTRUDE1_FAIL"
print("FEATURE1:", bf1.Name)

# ---- 特征 2：4 个凸起矩形（伸入盘内 1mm 保证实体合并；轮廓无自交）----
front.Select2(False, 0)
sm.InsertSketch(True)
sm.AddToDB = True
sm.CreateCornerRectangle( 0.019, -0.002, 0.0,  0.023,  0.002, 0.0)  # 0 deg
sm.CreateCornerRectangle(-0.002,  0.019, 0.0,  0.002,  0.023, 0.0)  # 90 deg
sm.CreateCornerRectangle(-0.023, -0.002, 0.0, -0.019,  0.002, 0.0)   # 180 deg
sm.CreateCornerRectangle(-0.002, -0.023, 0.0,  0.002, -0.019, 0.0)   # 270 deg
sm.AddToDB = False
sm.InsertSketch(True)
ok = select_last_feature()
print("SKETCH2_SELECTED", ok)
bf2 = extrude_2mm()
assert bf2 is not None, "EXTRUDE2_FAIL"
print("FEATURE2:", bf2.Name)

doc.ViewZoomtofit2()

# 保存 SLDPRT
os.makedirs(OUT_DIR, exist_ok=True)
saved = False
try:
    r = doc.SaveAs3(OUT, 0, 0, 0)
    saved = os.path.exists(OUT)
    print("SAVEAS3:", r, saved)
except Exception as e:
    print("SAVEAS3_ERR:", e)
if not saved:
    try:
        r = ext.SaveAs(OUT, 0, 1, None, 0, 0)
        saved = os.path.exists(OUT)
        print("EXTSAVE:", r, saved)
    except Exception as e:
        print("EXTSAVE_ERR:", e)
print("SLDPRT:", os.path.exists(OUT))

# 导出 PNG 预览（非致命）
try:
    doc.ViewDisplayShaded()
    doc.ViewZoomtofit2()
    doc.SaveAs3(PNG, 0, 1, 0)
    print("PNG:", os.path.exists(PNG))
except Exception as e:
    print("PNG_ERR:", e)

print("DONE")
