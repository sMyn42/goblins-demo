"""Deterministically draw a math answer into Goblins' browser-canvas PNG format."""
from __future__ import annotations

import struct
import zlib


def render_canvas_png() -> bytes:
    """Render 1000×500 RGBA student work, matching AnswerCanvas's dimensions."""
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    width, height = 1000, 500
    pixels = bytearray(bytes((255, 255, 255, 255)) * width * height)
    glyphs = {
        "x": [[(1, 1), (9, 13)], [(9, 1), (1, 13)]],
        "+": [[(5, 2), (5, 12)], [(1, 7), (9, 7)]],
        "-": [[(1, 7), (9, 7)]],
        "=": [[(1, 5), (9, 5)], [(1, 10), (9, 10)]],
        "3": [[(1, 1), (9, 1), (9, 7), (4, 7)], [(9, 7), (9, 13), (1, 13)]],
        "7": [[(1, 1), (9, 1), (3, 13)]],
        "4": [[(1, 1), (1, 7), (9, 7)], [(9, 1), (9, 13)]],
        " ": [],
    }

    def draw_line(x0: int, y0: int, x1: int, y1: int, thickness: int = 5) -> None:
        dx, dy = abs(x1 - x0), abs(y1 - y0)
        sx, sy = (1 if x0 < x1 else -1), (1 if y0 < y1 else -1)
        error = dx - dy
        while True:
            for oy in range(-thickness // 2, thickness // 2 + 1):
                for ox in range(-thickness // 2, thickness // 2 + 1):
                    x, y = x0 + ox, y0 + oy
                    if 0 <= x < width and 0 <= y < height:
                        offset = (y * width + x) * 4
                        pixels[offset:offset + 4] = bytes((24, 25, 24, 255))
            if x0 == x1 and y0 == y1:
                break
            twice = 2 * error
            if twice > -dy:
                error -= dy
                x0 += sx
            if twice < dx:
                error += dx
                y0 += sy

    for line_index, text in enumerate(("x + 3 = 7", "x = 7 - 3", "x = 4")):
        origin_x, origin_y = 100, 70 + line_index * 145
        for character_index, character in enumerate(text):
            left = origin_x + character_index * 58
            for path in glyphs[character]:
                points = [(left + x * 4, origin_y + y * 4) for x, y in path]
                for start, end in zip(points, points[1:]):
                    draw_line(*start, *end)

    raw = b"".join(b"\x00" + pixels[y * width * 4:(y + 1) * width * 4] for y in range(height))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, level=6))
        + chunk(b"IEND", b"")
    )
