"""Generates the PWA icons as PNGs. No image libraries available, so the pixels
are composed by hand and written through zlib."""
import struct, zlib

BRAND = (37, 99, 235)
DARK = (11, 17, 32)
WHITE = (255, 255, 255)


def rounded_rect(x, y, w, h, r):
    def inside(px, py):
        if not (x <= px < x + w and y <= py < y + h):
            return False
        # Only the nearest corner matters; clamp to its centre and test once.
        cx = min(max(px, x + r), x + w - r)
        cy = min(max(py, y + r), y + h - r)
        return (px - cx) ** 2 + (py - cy) ** 2 <= r * r
    return inside


def draw(size, maskable):
    # Maskable icons must keep their content inside the safe zone, since
    # launchers crop the outer ~10% to whatever shape they prefer.
    pad = size * 0.18 if maskable else size * 0.10
    px = [[BRAND if maskable else DARK for _ in range(size)] for _ in range(size)]

    if not maskable:
        bg = rounded_rect(0, 0, size, size, int(size * 0.22))
        for y in range(size):
            for x in range(size):
                if bg(x, y):
                    px[y][x] = BRAND

    s = size - 2 * pad
    bx, by, bw, bh = pad + s * 0.14, pad + s * 0.08, s * 0.72, s * 0.68
    body = rounded_rect(bx, by, bw, bh, int(s * 0.16))
    window = rounded_rect(bx + bw * 0.12, by + bh * 0.14, bw * 0.76, bh * 0.34, int(s * 0.05))

    for y in range(size):
        for x in range(size):
            if body(x, y):
                px[y][x] = WHITE
            if window(x, y):
                px[y][x] = BRAND

    # Wheels and the split in the windscreen.
    wr = s * 0.09
    for cx in (bx + bw * 0.26, bx + bw * 0.74):
        cy = by + bh * 0.96
        for y in range(size):
            for x in range(size):
                if (x - cx) ** 2 + (y - cy) ** 2 <= wr * wr:
                    px[y][x] = WHITE
    mid = int(bx + bw / 2)
    for y in range(int(by + bh * 0.14), int(by + bh * 0.48)):
        for x in range(mid - max(1, size // 128), mid + max(1, size // 128)):
            px[y][x] = WHITE
    return px


def write_png(path, px):
    size = len(px)
    raw = b''.join(b'\x00' + bytes(v for pixel in row for v in pixel) for row in px)

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = (
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
        + chunk(b'IDAT', zlib.compress(raw, 9))
        + chunk(b'IEND', b'')
    )
    with open(path, 'wb') as f:
        f.write(png)
    print(f'{path}  {size}x{size}  {len(png)} bytes')


write_png('public/favicon-32.png', draw(32, False))
# iOS ignores the manifest and looks for this by convention; without it the
# home-screen icon falls back to a screenshot of the page.
write_png('public/apple-touch-icon.png', draw(180, False))
write_png('public/icon-192.png', draw(192, False))
write_png('public/icon-512.png', draw(512, False))
write_png('public/icon-maskable-512.png', draw(512, True))
