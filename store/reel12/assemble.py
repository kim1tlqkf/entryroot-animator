# 찍은 1280×720 프레임 → 640×360, 공통 색표(핵심 색 고정 + 나머지는 median cut, 디더 없음) → APNG. 크기 보고.
import glob, sys, os
from PIL import Image
src, out, ms, colors = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
KEY = ['f4efe6', 'fffdf8', 'ebe4d6', '1f2233', '7a7466', '9aa0b5', 'ff5a36', 'ffa424', '3b6cff', 'ffffff', '1b2140',
       '009ff8', '0088c5', '231815', 'ffbeb8', '683100', 'e3ecff', 'ffd98a', 'd5e8cc', 'ece5d6', 'e3dbc9', '000000']
key = [tuple(int(h[i:i + 2], 16) for i in (0, 2, 4)) for h in KEY]
fs = sorted(glob.glob(os.path.join(src, 'f*.png')))
frames = [Image.open(f).convert('RGB').resize((640, 360), Image.LANCZOS) for f in fs]
pick = frames[::3]
strip = Image.new('RGB', (640, 360 * len(pick)))
for i, f in enumerate(pick): strip.paste(f, (0, 360 * i))
rest = strip.quantize(colors=colors - len(key), method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).getpalette()[:3 * (colors - len(key))]
flat = [c for rgb in key for c in rgb] + rest
pal = Image.new('P', (1, 1)); pal.putpalette(flat + [0] * (768 - len(flat)))
q = [f.quantize(palette=pal, dither=Image.Dither.NONE) for f in frames]
q[0].save(out, save_all=True, append_images=q[1:], duration=ms, loop=0, optimize=True)
print(len(frames), 'frames', os.path.getsize(out), 'bytes', 'limit 1048576')
