# -*- coding: utf-8 -*-
# 导出滚轮三视图：新建 GB A3 工程图 → 标准三视图（第三角）→ 存 SLDDRW + PDF
# 沿用 design_roller.py 的 makepy 早绑定配方（实例 GetTypeInfo 损坏）
import os
import win32com.client as wc

DRW_TPL = r"C:\ProgramData\SolidWorks\SOLIDWORKS 2026\templates\gb_a3.drwdot"
PART = r"C:\d_pan\wokspace\play\cad\roller_d40x2_4bumps.SLDPRT"
OUT_DIR = r"C:\d_pan\wokspace\play\cad"
DRW = os.path.join(OUT_DIR, "roller_d40x2_4bumps_views.SLDDRW")
PDF = os.path.join(OUT_DIR, "roller_d40x2_4bumps_views.pdf")

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

# 新建工程图（A3）
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
ddoc.ViewZoomtofit2()

# 保存 SLDDRW + 导出 PDF
os.makedirs(OUT_DIR, exist_ok=True)
r1 = ddoc.SaveAs3(DRW, 0, 1)
print("DRW_SAVED:", r1, os.path.exists(DRW))
try:
    r2 = ddoc.SaveAs3(PDF, 0, 1)
    print("PDF_SAVED:", r2, os.path.exists(PDF))
except Exception as e:
    print("PDF_ERR:", e)

print("DONE")
