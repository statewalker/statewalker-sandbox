"""Binary PPM (P6) images, stdlib only: enough to resize test images without Pillow."""


def read_ppm(data):
    """Returns (width, height, pixels) for a P6 image with maxval 255; raises ValueError otherwise."""
    fields, pos = [], 0
    while len(fields) < 4:
        while pos < len(data) and data[pos : pos + 1].isspace():
            pos += 1
        if data[pos : pos + 1] == b"#":  # a comment runs to the end of the line
            while pos < len(data) and data[pos : pos + 1] != b"\n":
                pos += 1
            continue
        start = pos
        while pos < len(data) and not data[pos : pos + 1].isspace():
            pos += 1
        if start == pos:
            raise ValueError("truncated header")
        fields.append(data[start:pos])
    if fields[0] != b"P6" or fields[3] != b"255":
        raise ValueError("not a binary PPM (P6, maxval 255)")
    width, height = int(fields[1]), int(fields[2])
    pixels = data[pos + 1 : pos + 1 + width * height * 3]
    if len(pixels) != width * height * 3:
        raise ValueError("truncated pixel data")
    return width, height, pixels


def resize(width, height, pixels, size):
    """Nearest neighbour to `size` pixels wide, keeping the aspect ratio."""
    new_w, new_h = size, max(1, (2 * height * size + width) // (2 * width))  # half up, as Math.round
    out = bytearray(new_w * new_h * 3)
    for y in range(new_h):
        sy = y * height // new_h
        for x in range(new_w):
            sx = x * width // new_w
            i, o = (sy * width + sx) * 3, (y * new_w + x) * 3
            out[o : o + 3] = pixels[i : i + 3]
    return new_w, new_h, bytes(out)


def write_ppm(width, height, pixels):
    return b"P6\n%d %d\n255\n" % (width, height) + pixels
