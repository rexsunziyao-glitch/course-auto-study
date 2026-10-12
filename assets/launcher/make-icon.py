#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 App 图标（纯标准库，自己画 PNG，不依赖 Pillow）"""
import os
import struct
import sys
import zlib

SIZE = 1024


def write_png(path, size, px):
    raw = b""
    for y in range(size):
        raw += b"\x00" + b"".join(bytes(px[y][x]) for x in range(size))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)


def build(size):
    margin = size * 0.085
    r = size * 0.225
    x0, y0 = margin, margin
    x1, y1 = size - margin, size - margin

    bg = (20, 22, 28, 255)
    fg = (52, 211, 153, 255)
    edge = (38, 42, 52, 255)

    px = [[(0, 0, 0, 0)] * size for _ in range(size)]

    cx0, cy0, cx1, cy1 = x0 + r, y0 + r, x1 - r, y1 - r

    for y in range(size):
        for x in range(size):
            fx, fy = x + 0.5, y + 0.5
            if not (x0 <= fx <= x1 and y0 <= fy <= y1):
                continue
            # 圆角矩形
            kx = min(max(fx, cx0), cx1)
            ky = min(max(fy, cy0), cy1)
            d = ((fx - kx) ** 2 + (fy - ky) ** 2) ** 0.5
            if d > r:
                continue
            # 边缘一圈略亮的描边
            px[y][x] = edge if d > r - size * 0.008 else bg

    # 播放三角
    ax, ay = x0 + (x1 - x0) * 0.34, y0 + (y1 - y0) * 0.245
    bx, by = ax, y0 + (y1 - y0) * 0.755
    cx, cy = x0 + (x1 - x0) * 0.745, y0 + (y1 - y0) * 0.5

    def inside(x, y):
        d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by)
        d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy)
        d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay)
        neg = d1 < 0 or d2 < 0 or d3 < 0
        pos = d1 > 0 or d2 > 0 or d3 > 0
        return not (neg and pos)

    for y in range(size):
        for x in range(size):
            if px[y][x][3] and inside(x + 0.5, y + 0.5):
                px[y][x] = fg

    return px


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "master.png"
    write_png(out, SIZE, build(SIZE))
    print("已生成 " + out)


if __name__ == "__main__":
    main()
