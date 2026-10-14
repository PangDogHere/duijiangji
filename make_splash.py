# -*- coding: utf-8 -*-
"""生成对讲机深色启动图（替换 Capacitor 默认 splash）"""
import os, glob
from PIL import Image, ImageDraw

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "android", "app", "src", "main", "res")
NAVY_TOP = (15, 20, 36)
NAVY_BOT = (10, 14, 26)
AMBER = (255, 176, 32, 255)
AMBER_HI = (255, 205, 110, 255)
SS = 4


def draw_glyph(size):
    canvas = Image.new("RGBA", (size * SS, size * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(canvas)
    S = size * SS
    ox, oy = S * 0.10, S * 0.10
    w = S * 0.80

    def X(v): return ox + v * w
    def Y(v): return oy + v * h if False else oy + v * w

    def rr(x0, y0, x1, y1, radius, fill):
        d.rounded_rectangle([X(x0), Y(y0), X(x1), Y(y1)], radius=radius * w, fill=fill)

    d.rounded_rectangle([X(0.30), Y(-0.04), X(0.42), Y(0.32)], radius=0.055 * w, fill=AMBER_HI)
    d.ellipse([X(0.27), Y(-0.16), X(0.45), Y(0.02)], fill=AMBER_HI)
    rr(0.24, 0.22, 0.88, 1.00, 0.13, AMBER)
    rr(0.86, 0.46, 1.02, 0.68, 0.045, AMBER_HI)
    hole = (15, 20, 36, 0)
    for yy in (0.34, 0.465, 0.59):
        rr(0.38, yy, 0.74, yy + 0.055, 0.028, hole)
    d.ellipse([X(0.46), Y(0.74), X(0.66), Y(0.94)], fill=hole)
    return canvas.resize((size, size), Image.LANCZOS)


def make_splash(w, h):
    img = Image.new("RGB", (w * SS, h * SS))
    d = ImageDraw.Draw(img)
    # 垂直渐变深色背景
    for y in range(h * SS):
        t = y / (h * SS)
        c = tuple(int(NAVY_TOP[i] + (NAVY_BOT[i] - NAVY_TOP[i]) * t) for i in range(3))
        d.line([(0, y), (w * SS, y)], fill=c)
    img = img.resize((w, h), Image.LANCZOS).convert("RGBA")

    # 中央图标 + 柔和外发光
    gs = int(min(w, h) * 0.24)
    glyph = draw_glyph(gs)
    halo = Image.new("RGBA", img.size, (0, 0, 0, 0))
    glow = Image.new("RGBA", (gs * 3, gs * 3), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([gs, gs, gs * 2, gs * 2], fill=(255, 176, 32, 46))
    glow = glow.filter(__import__("PIL.ImageFilter", fromlist=["GaussianBlur"]).GaussianBlur(gs * 0.45))
    halo.paste(glow, (w // 2 - gs * 3 // 2, h // 2 - gs * 3 // 2), glow)
    img = Image.alpha_composite(img, halo)

    out = img.convert("RGBA")
    out.paste(glyph, (w // 2 - gs // 2, h // 2 - gs // 2), glyph)
    return out.convert("RGB")


# 与 Capacitor 模板原始分辨率一一对应
SIZES = {
    "drawable":             (480, 320),
    "drawable-land-mdpi":   (480, 320),
    "drawable-land-hdpi":   (800, 480),
    "drawable-land-xhdpi":  (1280, 720),
    "drawable-land-xxhdpi": (1600, 960),
    "drawable-land-xxxhdpi":(1920, 1280),
    "drawable-port-mdpi":   (320, 480),
    "drawable-port-hdpi":   (480, 800),
    "drawable-port-xhdpi":  (720, 1280),
    "drawable-port-xxhdpi": (960, 1600),
    "drawable-port-xxxhdpi":(1280, 1920),
}

count = 0
for f in sorted(glob.glob(os.path.join(ROOT, "drawable*", "splash.png"))):
    rel = os.path.relpath(f, ROOT)
    name = os.path.dirname(rel)
    if name not in SIZES:
        print("!! 未知目录，跳过:", name)
        continue
    w, h = SIZES[name]
    im = make_splash(w, h)
    im.save(f, "PNG")
    count += 1
    print("  ->", rel.replace("\\", "/"), im.size)
print("完成，共", count, "张")

# 预览
make_splash(480, 800).save(os.path.join(os.path.dirname(os.path.abspath(__file__)), "splash_preview.png"), "PNG")
print("预览: splash_preview.png")
