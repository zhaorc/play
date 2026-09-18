# -*- coding: utf-8 -*-
# 导出滚轮三视图：新建 GB A3 工程图 → 标准三视图（第三角）→ 存 SLDDRW + PDF
# 沿用 design_roller.py 的 makepy 早绑定配方（实例 GetTypeInfo 损坏）
import os
import win32com.client as wc

DRW_TPL = r"C:\ProgramData\SolidWorks\SOLIDWORKS 2026\templates\gb_a3.drwdot"
PART = r"C:\d_pan\wokspace\play\cad\roller_d40x1p5_h15.SLDPRT"
OUT_DIR = r"C:\d_pan\wokspace\play\cad"
DRW = os.path.join(OUT_DIR, "roller_d40x1p5_h15_views.SLDDRW")
PDF = os.path.join(OUT_DIR, "roller_d40x1p5_h15_views.pdf")

assert os.path.exists(DRW_TPL), "NO_DRW_TEMPLATE"
assert os.path.exists(PART), "NO_PART"

mod = wc.gencache.EnsureModule("{83A33D31-27C5-11CE-BFD4-00400513BB57}", 0, 34, 0)
assert mod is not None, "NO_GENPY_CACHE"


def as_intfc(obj, name):
    if obj is None or obj.__class__.__module__.startswith("win32com.gen_py"):
        return obj
    return getattr(mod, name)(obj._oleobj_)


sw = as_intfc(wc.Dispatch("SldWorks.Application"), "ISldWorks")
sw.Visible = True

# Create3rdAngleViews2 直接接受零件路径（自动按需加载），无需预打开零件
# CloseAllDocuments(True)=连有未保存更改的文档一并丢弃关闭；传 False 会跳过脏文档，
# 同名工程图仍驻留内存导致 SaveAs 静默失败（返回 1，磁盘文件不更新）
try:
    sw.CloseAllDocuments(True)
except Exception as e:
    print("CLOSEALL_ERR:", e)

# 预打开零件（Create3rdAngleViews2 在模型未驻留内存时可能返回 False）
try:
    res = sw.OpenDoc6(PART, 1, 0, "", 0, 0)   # 1=swDocPART, 0=swOpenDocOptions_Silent
    print("PART_OPENED:", res is not None)
except Exception as e:
    print("PART_OPEN_ERR:", e)

# 新建工程图（A3）——新建后工程图为活动文档，零件仍驻留内存
drw = as_intfc(sw.NewDocument(DRW_TPL, 0, 0.0, 0.0), "IDrawingDoc")
assert drw is not None, "DRW_NEWDOC_FAIL"
print("DRW_CREATED")

# 标准三视图（第三角，从零件生成）
ok = False
try:
    ok = drw.Create3rdAngleViews2(PART)
    print("CREATE3RD2:", ok)
except Exception as e:
    print("CREATE3RD2_ERR:", e)
if not ok:
    try:
        ok = drw.Create3rdAngleViews(PART)
        print("CREATE3RD1:", ok)
    except Exception as e:
        print("CREATE3RD1_ERR:", e)
assert ok, "VIEWS_FAIL"

ddoc = mod.IModelDoc2(drw._oleobj_)   # 强制转 IModelDoc2（as_intfc 遇 gen_py 不再重包）
ddoc.EditRebuild3()
ddoc.ViewZoomtofit2()

# ---- 从模型导入尺寸标注（零件草图/拉伸特征中已定义智能尺寸）----
# InsertModelAnnotations3 属于 IDrawingDoc（dispid 221），不在 IModelDoc2 上
# (Option, Types, AllViews, DuplicateDims, HiddenFeatureDims, UsePlacementInSketch)
#   Option: 0 = swImportModelItemsFromEntireModel（整个模型）
#   Types: 32768 = swInsertDimensionsMarkedForDrawing（草图智能尺寸默认带此标记；
#       实测 8=swInsertDimensions 在 SW2026 不导入任何尺寸，1 更是装饰螺纹）
# 视图链首个节点是图纸本身；Create3rdAngleViews2 的模型视图顺序为 前视/上视/右视
model_views = []
_v = drw.GetFirstView()
while _v is not None:
    _iv = mod.IView(_v._oleobj_)
    model_views.append(_iv)
    _v = _iv.GetNextView()
model_views = model_views[1:]   # 首节点是图纸本身，去掉
print("MODEL_VIEWS:", [iv.GetName2() for iv in model_views])

drw.ActivateView(model_views[0].GetName2())
ddoc.ClearSelection2(True)

try:
    annots = drw.InsertModelAnnotations3(0, 32768, True, True, False, True)
    n_ret = len(annots) if annots is not None and hasattr(annots, "__len__") else 0
    print("MODEL_DIMS_RETURNED:", n_ret)
except Exception as e:
    print("MODEL_DIMS_ERR:", e)
ddoc.ForceRebuild3(False)


# ---- 修剪：前视留 4 个草图尺寸，上视（边视图）留 1 个厚度尺寸，右视清空 ----
# DuplicateDims=True 去重后：4 个草图尺寸落前视，2 个拉伸深度尺寸落上视；
# 两个拉伸厚度都是 1.5，只保留 凸台-拉伸1 的一个
def dim_full_name(dd):
    try:
        return dd.GetNameForSelection()
    except Exception:
        return ""


def delete_dims(iv, keep_pred):
    dims = list(iv.GetDisplayDimensions() or [])
    kept_name = None
    for d in dims:
        dd = mod.IDisplayDimension(d._oleobj_)
        nm = dim_full_name(dd)
        if keep_pred(nm, kept_name):
            kept_name = nm
            continue
        ann = dd.GetAnnotation()
        ia = mod.IAnnotation(ann._oleobj_)
        if ia.Select(False):
            ddoc.EditDelete()
    return kept_name


front_iv, top_iv, right_iv = model_views[0], model_views[1], model_views[2]

# 前视：仅保留草图 1/草图 2 的 4 个尺寸（Ø40 Ø15 齿顶圆 齿宽）
delete_dims(front_iv, lambda nm, kept: ("@草图1" in nm) or ("@草图2" in nm))
# 上视：只保留第一个拉伸厚度尺寸 1.5（凸台-拉伸1），删其余
delete_dims(top_iv, lambda nm, kept: (kept is None) and ("凸台-拉伸1" in nm))
# 右视：全部删除
delete_dims(right_iv, lambda nm, kept: False)

ddoc.ClearSelection2(True)
ddoc.ForceRebuild3(False)

for iv in (front_iv, top_iv, right_iv):
    print("VIEW_DIMS:", iv.GetName2(), iv.GetDisplayDimensionCount())
ddoc.ViewZoomtofit2()

# 保存 SLDDRW + 导出 PDF/PNG
os.makedirs(OUT_DIR, exist_ok=True)
r1 = ddoc.SaveAs3(DRW, 0, 1)
print("DRW_SAVED:", r1, os.path.exists(DRW))
assert r1 == 0 and os.path.exists(DRW), "DRW_SAVE_FAIL"
try:
    r2 = ddoc.SaveAs3(PDF, 0, 1)
    print("PDF_SAVED:", r2, os.path.exists(PDF))
    assert r2 == 0 and os.path.exists(PDF), "PDF_SAVE_FAIL"
except Exception as e:
    print("PDF_ERR:", e)
    raise
try:
    png = os.path.join(OUT_DIR, "roller_d40x1p5_h15_views.png")
    if os.path.exists(png):
        os.remove(png)
    r3 = ddoc.SaveAs3(png, 0, 1)
    print("PNG_SAVED:", r3, os.path.exists(png))
except Exception as e:
    print("PNG_ERR:", e)

print("DONE")
