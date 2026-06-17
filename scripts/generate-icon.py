#!/usr/bin/env python3
"""Generate WhatsApp Search app icon (1024x1024 PNG)."""
from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "build" / "icon.png"
SIZE = 1024
GREEN = (0, 168, 132)
GREEN_DARK = (0, 128, 105)
WHITE = (255, 255, 255)
WHITE_SOFT = (255, 255, 255, 210)


def lerp(a: int, b: int, t: float) -> int:
    return int(a + (b - a) * t)


def gradient_bg(draw: ImageDraw.ImageDraw, size: int) -> None:
    for y in range(size):
        t = y / (size - 1)
        color = (
            lerp(GREEN[0], GREEN_DARK[0], t),
            lerp(GREEN[1], GREEN_DARK[1], t),
            lerp(GREEN[2], GREEN_DARK[2], t),
        )
        draw.line([(0, y), (size, y)], fill=color)


def rounded_rect_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)

    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    base = Image.new("RGB", (SIZE, SIZE), GREEN)
    draw = ImageDraw.Draw(base)
    gradient_bg(draw, SIZE)

    mask = rounded_rect_mask(SIZE, 220)
    img.paste(base, (0, 0), mask)

    # Chat bubble (subtle, behind magnifier)
    overlay = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    bubble = (210, 300, 620, 700)
    od.rounded_rectangle(bubble, radius=90, fill=WHITE_SOFT)
    od.polygon(
        [(360, 700), (430, 700), (390, 790)],
        fill=WHITE_SOFT,
    )
    img = Image.alpha_composite(img, overlay)

    fg = ImageDraw.Draw(img)

    # Magnifying glass
    cx, cy, r = 560, 430, 175
    stroke = 56
    fg.ellipse(
        (cx - r, cy - r, cx + r, cy + r),
        outline=WHITE,
        width=stroke,
    )
    handle_len = 170
    angle = math.radians(45)
    hx = cx + int(math.cos(angle) * (r - 8))
    hy = cy + int(math.sin(angle) * (r - 8))
    ex = hx + int(math.cos(angle) * handle_len)
    ey = hy + int(math.sin(angle) * handle_len)
    fg.line([(hx, hy), (ex, ey)], fill=WHITE, width=stroke, joint="curve")

    # Small search highlight dot
    fg.ellipse((cx - 42, cy - 42, cx + 10, cy + 10), fill=(255, 255, 255, 90))

    img.save(OUT, "PNG")
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
