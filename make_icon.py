# -*- coding: utf-8 -*-
"""生成对讲机 App 图标（自适应图标前景 + 传统图标）"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "android", "app", "src", "main", "res")

AMBER = (255, 176, 32, 255)
AMBER_HI = (255, 205, 110, 255)
NAVY = (16, 23, 40, 255)
SS = 8  # 超采样倍率


def draw_glyph_pil(size):
    """在对讲机轮廓上画 glyph，画布为 size x size，glyph 居中占 ~0.80"""
    canvas = Image.new("RGBA", (size * SS, size * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(canvas)
    S = size * SS
    # glyph 在 0..1 归一化空间里设计
    ox, oy = S * 0.10, S * 0.10
    w = S * 0.80
    h = S * 0.80

    def X(v): return ox + v * w
    def Y(v): return oy + v * h

    def rr(x0, y0, x1, y1, radius, fill):
        d.rounded_rectangle([X(x0), Y(y0), X(x1), Y(y1)],
                            radius=radius * w, fill=fill)

    # ---- 天线（与机身相连，插在左上）----
    d.rounded_rectangle([X(0.30), Y(-0.04), X(0.42), Y(0.32)],
                        radius=0.055 * w, fill=AMBER_HI)
    # 天线顶球
    d.ellipse([X(0.27), Y(-0.16), X(0.45), Y(0.02)], fill=AMBER_HI)

    # ---- 机身（修长圆角矩形）----
    rr(0.24, 0.22, 0.88, 1.00, 0.13, AMBER)
    # 右侧 PTT 按键
    rr(0.86, 0.46, 1.02, 0.68, 0.045, AMBER_HI)

    # ---- 扬声器格栅（挖空）----
    hole = (16, 23, 40, 0)
    for i, yy in enumerate((0.34, 0.465, 0.59)):
        rr(0.38, yy, 0.74, yy + 0.055, 0.028, hole)

    # ---- 底部旋钮（挖空圆）----
    d.ellipse([X(0.46), Y(0.74), X(0.66), Y(0.94)], fill=hole)

    return canvas.resize((size, size), Image.LANCZOS)


def make_adaptive_foreground(px):
    """自适应图标前景：108dp 画布，内容限制在安全区（~60%）"""
    canvas = Image.new("RGBA", (px * SS, px * SS), (0, 0, 0, 0))
    inner = int(px * 0.62)
    glyph = draw_glyph_pil(inner)
    off = (px - inner) // 2
    canvas.paste(glyph, (off * SS, off * SS), glyph)
    return canvas.resize((px, px), Image.LANCZOS)


def make_legacy(px, round_icon=False):
    """传统图标：深色圆角/圆形底 + glyph"""
    canvas = Image.new("RGBA", (px * SS, px * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(canvas)
    S = px * SS
    if round_icon:
        d.ellipse([0, 0, S - 1, S - 1], fill=NAVY)
    else:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=NAVY)
    base = canvas.resize((px, px), Image.LANCZOS)

    inner = int(px * 0.72)
    glyph = draw_glyph_pil(inner)
    off = (px - inner) // 2
    out = base.copy()
    out.paste(glyph, (off, off), glyph)
    return out


DENSITIES = {
    "mdpi": 1.0, "hdpi": 1.5, "xhdpi": 2.0, "xxhdpi": 3.0, "xxxhdpi": 4.0,
}

def save(img, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, "PNG")
    print("  ->", os.path.relpath(path, ROOT).replace("\\", "/"), img.size)


print("自适应图标前景:")
for name, scale in DENSITIES.items():
    px = int(108 * scale)
    save(make_adaptive_foreground(px), os.path.join(ROOT, "mipmap-" + name, "ic_launcher_foreground.png"))

print("传统图标:")
for name, scale in DENSITIES.items():
    px = int(48 * scale)
    save(make_legacy(px, False), os.path.join(ROOT, "mipmap-" + name, "ic_launcher.png"))
    save(make_legacy(px, True), os.path.join(ROOT, "mipmap-" + name, "ic_launcher_round.png"))

# 预览大图
prev = make_legacy(512, False)
prev.save(os.path.join(os.path.dirname(os.path.abspath(__file__)), "icon_preview.png"), "PNG")
print("预览: icon_preview.png")
print("完成")
