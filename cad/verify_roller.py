# -*- coding: utf-8 -*-
# 验证滚轮模型：体积 + 导出 PNG 预览（文档在 SW 中保持打开）
import os
import win32com.client as wc

OUT_DIR = r"C:\d_pan\wokspace\play\cad"
OUT = os.path.join(OUT_DIR, "roller_d40x2_4bumps.SLDPRT")
PNG = os.path.join(OUT_DIR, "roller_d40x2_4bumps.png")
EXPECT_MM3 = 3.141592653589793 * 400 * 2 + 4 * 3 * 4 * 2   # 盘 + 4 齿（齿伸入盘内部分已含在盘里）

mod = wc.gencache.EnsureModule("{83A33D31-27C5-11CE-BFD4-00400513BB57}", 0, 34, 0)
assert mod is not None, "NO_GENPY_CACHE"


def as_intfc(obj, name):
    if obj is None or obj.__class__.__module__.startswith("win32com.gen_py"):
        return obj
    return getattr(mod, name)(obj._oleobj_)


sw = as_intfc(wc.Dispatch("SldWorks.Application"), "ISldWorks")
doc = as_intfc(sw.ActiveDoc, "IModelDoc2")
assert doc is not None, "NO_ACTIVE_DOC"
print("DOC:", doc.GetTitle)

ext = as_intfc(doc.Extension, "IModelDocExtension")
try:
    props = doc.GetMassProperties()   # IModelDoc2::GetMassProperties → 数组，[0] = 体积 m³
    print("MASSPROPS_RAW:", props)
    vol_mm3 = float(props[0]) * 1e9
    print("VOLUME_MM3: %.3f  EXPECT: %.3f  DIFF: %.4f" % (vol_mm3, EXPECT_MM3, abs(vol_mm3 - EXPECT_MM3)))
except Exception as e:
    print("MASS_ERR:", e)

# PNG 预览（SaveAs3 类型化签名最多 3 参）
try:
    doc.ViewDisplayShaded()
    doc.ViewZoomtofit2()
    doc.SaveAs3(PNG, 0, 1)
    print("PNG:", os.path.exists(PNG))
except Exception as e:
    print("PNG_ERR:", e)
