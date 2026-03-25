#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Dict, List, Tuple

from PIL import Image

RGBA = Tuple[int, int, int, int]

try:
    NEAREST = Image.Resampling.NEAREST
except AttributeError:
    NEAREST = Image.NEAREST

try:
    MEDIANCUT = Image.Quantize.MEDIANCUT
except AttributeError:
    MEDIANCUT = Image.MEDIANCUT


def parse_hex_color(value: str) -> RGBA:
    value = value.strip().lstrip('#')
    if len(value) == 6:
        r = int(value[0:2], 16)
        g = int(value[2:4], 16)
        b = int(value[4:6], 16)
        return (r, g, b, 255)
    if len(value) == 8:
        r = int(value[0:2], 16)
        g = int(value[2:4], 16)
        b = int(value[4:6], 16)
        a = int(value[6:8], 16)
        return (r, g, b, a)
    raise argparse.ArgumentTypeError(f'Invalid color: {value}')


def color_distance(c1: RGBA, c2: RGBA) -> float:
    return math.sqrt(sum((a - b) ** 2 for a, b in zip(c1[:3], c2[:3])))


def crop_transparent_bounds(img: Image.Image, alpha_threshold: int) -> Image.Image:
    alpha = img.getchannel('A')
    bbox = alpha.point(lambda a: 255 if a > alpha_threshold else 0).getbbox()
    return img.crop(bbox) if bbox else img


def remove_near_white_background(img: Image.Image, threshold: int) -> Image.Image:
    img = img.copy()
    px = img.load()
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = px[x, y]
            if a and r >= threshold and g >= threshold and b >= threshold:
                px[x, y] = (0, 0, 0, 0)
    return img


def quantize_image(img: Image.Image, colors: int) -> Image.Image:
    # Adaptive palette, keep transparency manually afterwards
    alpha = img.getchannel('A')
    rgb = img.convert('RGB')
    quantized = rgb.quantize(colors=colors, method=MEDIANCUT).convert('RGBA')
    quantized.putalpha(alpha)
    return quantized


def build_palette_from_image(img: Image.Image, alpha_threshold: int) -> List[RGBA]:
    seen = []
    for y in range(img.height):
        for x in range(img.width):
            rgba = img.getpixel((x, y))
            if rgba[3] <= alpha_threshold:
                continue
            if rgba not in seen:
                seen.append(rgba)
    return seen


def assign_symbols(colors: List[RGBA]) -> Dict[str, RGBA]:
    symbol_pool = list('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#$%&*+=?')
    if len(colors) > len(symbol_pool):
        raise ValueError('Too many colors for available symbols')
    palette = {'.': (0, 0, 0, 0)}
    for sym, color in zip(symbol_pool, colors):
        palette[sym] = color
    return palette


def nearest_symbol(rgba: RGBA, palette: Dict[str, RGBA], alpha_threshold: int) -> str:
    if rgba[3] <= alpha_threshold:
        return '.'
    best_sym = None
    best_dist = float('inf')
    for sym, color in palette.items():
        if sym == '.':
            continue
        dist = color_distance(rgba, color)
        if dist < best_dist:
            best_dist = dist
            best_sym = sym
    return best_sym or '.'


def rgba_to_hex(rgba: RGBA) -> str:
    r, g, b, a = rgba
    return f'#{r:02x}{g:02x}{b:02x}' if a == 255 else f'#{r:02x}{g:02x}{b:02x}{a:02x}'


def generate_art(img: Image.Image, palette: Dict[str, RGBA], alpha_threshold: int) -> List[str]:
    rows = []
    for y in range(img.height):
        row = ''.join(nearest_symbol(img.getpixel((x, y)), palette, alpha_threshold) for x in range(img.width))
        rows.append(row)
    return rows


def ansi_bg(color: RGBA) -> str:
    r, g, b, _ = color
    return f'\x1b[48;2;{r};{g};{b}m'


def render_ansi(art: List[str], palette: Dict[str, RGBA], cell_width: int = 2) -> str:
    lines = []
    blank = ' ' * cell_width
    reset = '\x1b[0m'
    for row in art:
        parts = []
        active = False
        for sym in row:
            if sym == '.':
                if active:
                    parts.append(reset)
                    active = False
                parts.append(blank)
            else:
                parts.append(ansi_bg(palette[sym]))
                parts.append(blank)
                active = True
        if active:
            parts.append(reset)
        lines.append(''.join(parts))
    return '\n'.join(lines)


def ansi_fg(color: RGBA) -> str:
    r, g, b, _ = color
    return f'\x1b[38;2;{r};{g};{b}m'


def render_ansi_half(art: List[str], palette: Dict[str, RGBA]) -> str:
    lines = []
    reset = '\x1b[0m'
    height = len(art)
    width = len(art[0]) if art else 0
    for y in range(0, height, 2):
        parts = []
        for x in range(width):
            top = art[y][x]
            bottom = art[y + 1][x] if y + 1 < height else '.'
            if top == '.' and bottom == '.':
                parts.append(reset + ' ')
            elif top != '.' and bottom == '.':
                parts.append(f'{reset}{ansi_fg(palette[top])}▀')
            elif top == '.' and bottom != '.':
                parts.append(f'{reset}{ansi_fg(palette[bottom])}▄')
            else:
                parts.append(f'{reset}{ansi_fg(palette[top])}{ansi_bg(palette[bottom])}▀')
        parts.append(reset)
        lines.append(''.join(parts))
    return '\n'.join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description='Convert an image into pixel-art code data.')
    parser.add_argument('input', help='Input image path')
    parser.add_argument('--size', type=int, default=16, help='Output width/height, default 16')
    parser.add_argument('--colors', type=int, default=6, help='Quantized color count, default 6')
    parser.add_argument('--alpha-threshold', type=int, default=20, help='Alpha <= this is treated as transparent')
    parser.add_argument('--remove-white-bg', action='store_true', help='Make near-white pixels transparent first')
    parser.add_argument('--white-threshold', type=int, default=245, help='Threshold for --remove-white-bg')
    parser.add_argument('--crop', action='store_true', help='Crop transparent bounds after background removal')
    parser.add_argument('--palette-color', action='append', type=parse_hex_color, default=[], help='Provide fixed palette colors like --palette-color 1ba4e3')
    parser.add_argument('--format', choices=['json', 'js', 'py', 'txt', 'ansi', 'ansi-half'], default='js', help='Output format')
    parser.add_argument('--ansi-cell-width', type=int, default=2, help='Cell width for --format ansi, default 2')
    parser.add_argument('--out', help='Write output to file instead of stdout')
    parser.add_argument('--preview', help='Optional path to write enlarged preview PNG')
    args = parser.parse_args()

    img = Image.open(args.input).convert('RGBA')

    if args.remove_white_bg:
        img = remove_near_white_background(img, args.white_threshold)

    if args.crop:
        img = crop_transparent_bounds(img, args.alpha_threshold)

    img = img.resize((args.size, args.size), NEAREST)
    img = quantize_image(img, args.colors)

    if args.palette_color:
        palette_colors = args.palette_color
    else:
        palette_colors = build_palette_from_image(img, args.alpha_threshold)

    palette = assign_symbols(palette_colors)
    art = generate_art(img, palette, args.alpha_threshold)

    payload = {
        'width': args.size,
        'height': args.size,
        'palette': {k: rgba_to_hex(v) if k != '.' else None for k, v in palette.items()},
        'art': art,
    }

    if args.format == 'json':
        output = json.dumps(payload, indent=2, ensure_ascii=False)
    elif args.format == 'py':
        output = (
            f'palette = {repr(payload["palette"])}\n\n'
            f'art = {json.dumps(art, indent=2, ensure_ascii=False)}\n'
        )
    elif args.format == 'txt':
        palette_lines = ['palette:'] + [f'  {k}: {v}' for k, v in payload['palette'].items()]
        art_lines = ['art:'] + [f'  {row}' for row in art]
        output = '\n'.join(palette_lines + [''] + art_lines)
    elif args.format == 'ansi':
        output = render_ansi(art, palette, args.ansi_cell_width)
    elif args.format == 'ansi-half':
        output = render_ansi_half(art, palette)
    else:  # js
        output = (
            f'const palette = {json.dumps(payload["palette"], indent=2, ensure_ascii=False)};\n\n'
            f'const art = {json.dumps(art, indent=2, ensure_ascii=False)};\n'
        )

    if args.out:
        Path(args.out).write_text(output, encoding='utf-8')
    else:
        print(output)

    if args.preview:
        preview = img.resize((args.size * 16, args.size * 16), NEAREST)
        preview.save(args.preview)


if __name__ == '__main__':
    main()
