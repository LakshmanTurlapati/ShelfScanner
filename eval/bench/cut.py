import glob, json, os
from PIL import Image, ImageOps
OUT, OVERLAP = ".context/bench", 0.18
VARIANTS = {"p1600q80": (1600, 80), "p2000q85": (2000, 85)}
def plan(w, h):
    count = max(2, int(w / h * 2 + 0.5)); sw = w / (count - (count - 1) * OVERLAP)
    return count, sw, sw * (1 - OVERLAP)
def portrait(img, truth):
    w, h = img.size; cw = min(w, round(h * 9 / 16)); x0 = (w - cw) // 2; keep = []
    for t in truth:
        b = t["box"]; cx = b["x"] + b["w"] / 2
        if x0 / w <= cx <= (x0 + cw) / w:
            x = max(0, (b["x"] * w - x0) / cw); r = min(1, ((b["x"] + b["w"]) * w - x0) / cw)
            keep.append({"title": t["title"], "box": {"x": x, "y": b["y"], "w": r - x, "h": b["h"]}})
    return img.crop((x0, 0, x0 + cw, h)), keep
images = []
for path in sorted(glob.glob("eval/golden/*.json")):
    spec = json.load(open(path)); name = os.path.basename(path)[:-5]
    img = ImageOps.exif_transpose(Image.open(os.path.join("eval/golden", spec["image"]))).convert("RGB")
    todo = [(name, img, spec["truth"])]
    if img.width > img.height: todo.append((name + "-9x16", *portrait(img, spec["truth"])))
    for label, im, truth in todo:
        w, h = im.size; count, sw, step = plan(w, h)
        entry = {"name": label, "truth": truth, "width": w, "height": h, "variants": {}}
        for v, (edge, q) in VARIANTS.items():
            os.makedirs(f"{OUT}/{label}/{v}", exist_ok=True); strips = []
            for i in range(count):
                sx = min(i * step, max(0, w - sw)); s = min(1, edge / max(sw, h))
                crop = im.crop((round(sx), 0, round(sx + sw), h)).resize((max(1, round(sw * s)), max(1, round(h * s))), Image.LANCZOS)
                f = f"{label}/{v}/s{i}.jpg"; crop.save(f"{OUT}/{f}", quality=q)
                strips.append({"file": f, "sx": sx, "stripW": sw, "imageWidth": w, "imageHeight": h})
            entry["variants"][v] = strips
        images.append(entry)
json.dump({"images": images}, open(f"{OUT}/manifest.json", "w")); print(len(images), "images")
