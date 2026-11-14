"""Generate the Discord panel GIF with a fixed, clean swap icon and gentle star shimmer.
The existing logo, arrows, and two coins NEVER move, preventing choppy artifacts.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter
import math

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'src/assets/panel/swap-banner.jpg'
OUTPUT = ROOT / 'src/assets/panel/swap-banner.gif'

def build():
    raw = Image.open(SOURCE).convert('RGB')
    w0, h0 = raw.size
    # Crop the lower benefits strip from the original JPG rather than obscuring it.
    raw = raw.crop((0, 0, w0, round(h0 * 0.803)))
    width = 1050
    height = round(width * raw.height / raw.width)
    base = raw.resize((width, height), Image.Resampling.LANCZOS)
    palette = base.quantize(colors=255, method=Image.Quantize.MEDIANCUT,
                            dither=Image.Dither.NONE)

    # Stars only, away from the central two-way exchange symbol.
    stars = [(.170, .263, .00, .85), (.857, .345, .28, .70),
             (.950, .448, .48, .60), (.127, .616, .61, .65),
             (.725, .184, .80, .42), (.042, .430, .21, .32)]
    frames = []
    count = 42
    for frame_number in range(count):
        phase = frame_number / count
        halo = Image.new('RGBA', (width, height), (0, 0, 0, 0))
        draw = ImageDraw.Draw(halo)
        for xf, yf, offset, strength in stars:
            light = ((.5 + .5 * math.sin(2 * math.pi * (phase + offset))) ** 2) * strength
            x, y = xf * width, yf * height
            radius = 2.7 + 5 * light
            draw.ellipse((x - radius, y - radius, x + radius, y + radius),
                         fill=(200, 190, 255, round(40 * light)))
        halo = halo.filter(ImageFilter.GaussianBlur(7))
        points = Image.new('RGBA', (width, height), (0, 0, 0, 0))
        glow = ImageDraw.Draw(points)
        for xf, yf, offset, strength in stars:
            light = ((.5 + .5 * math.sin(2 * math.pi * (phase + offset))) ** 2) * strength
            x, y = round(xf * width), round(yf * height)
            radius = 1.5 + 2 * light
            alpha = round(20 + 72 * light)
            glow.line((x - radius * 2, y, x + radius * 2, y),
                      fill=(211, 212, 255, alpha), width=1)
            glow.line((x, y - radius * 2, x, y + radius * 2),
                      fill=(211, 212, 255, alpha), width=1)
        composed = Image.alpha_composite(base.convert('RGBA'), halo)
        composed = Image.alpha_composite(composed, points)
        frames.append(composed.convert('RGB').quantize(palette=palette,
                                                       dither=Image.Dither.NONE))
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(OUTPUT, save_all=True, append_images=frames[1:],
                   duration=65, loop=0, optimize=True, disposal=1)
    assert OUTPUT.stat().st_size < 8_000_000
    print(f'Generated {OUTPUT.name}: {width}x{height}, {count} frames, {OUTPUT.stat().st_size} bytes')

if __name__ == '__main__':
    build()
