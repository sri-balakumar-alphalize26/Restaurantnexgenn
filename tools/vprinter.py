#!/usr/bin/env python3
"""
Virtual KOT / receipt printer for testing WITHOUT real hardware.

Listens on TCP 9100, saves every print, and (if Pillow is installed) decodes the
ESC/POS raster image into a viewable PNG. Point your KOT Setup printer IP at the
PC running this, on the SAME router/Wi-Fi as your tablet (APK).

Usage:
    python vprinter.py            # listen on port 9100
    python vprinter.py 9200       # custom port

To view receipts as images:  pip install pillow
"""
import socket, sys, os, time

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9100
OUT = os.path.join(os.getcwd(), "vprints")
os.makedirs(OUT, exist_ok=True)


def local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "this-PC-IP"


def decode_to_png(data, path):
    """ESC/POS GS v 0 raster -> PNG (needs Pillow)."""
    try:
        from PIL import Image
    except ImportError:
        return None
    i = data.find(b"\x1d\x76\x30")
    if i < 0 or i + 8 > len(data):
        return None
    xbytes = data[i + 4] | (data[i + 5] << 8)
    height = data[i + 6] | (data[i + 7] << 8)
    start = i + 8
    if xbytes <= 0 or height <= 0 or start + xbytes * height > len(data):
        return None
    width = xbytes * 8
    img = Image.new("1", (width, height), 1)
    px = img.load()
    for y in range(height):
        row = start + y * xbytes
        for x in range(width):
            bit = (data[row + (x >> 3)] >> (7 - (x & 7))) & 1
            px[x, y] = 0 if bit else 1
    img.convert("L").save(path)
    return path


def main():
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("0.0.0.0", PORT))
    s.listen(5)
    print("=" * 50)
    print(f"  VIRTUAL PRINTER listening on 0.0.0.0:{PORT}")
    print(f"  This PC IP : {local_ip()}")
    print(f"  -> In KOT Setup set printer IP = {local_ip()}, port {PORT}")
    print(f"  Saving prints to: {OUT}")
    print("=" * 50)
    n = 0
    while True:
        try:
            c, a = s.accept()
            c.settimeout(5)
            data = b""
            try:
                while True:
                    chunk = c.recv(8192)
                    if not chunk:
                        break
                    data += chunk
            except socket.timeout:
                pass
            c.close()
            if not data:
                continue
            n += 1
            ts = time.strftime("%Y%m%d_%H%M%S")
            binp = os.path.join(OUT, f"print_{ts}_{n}.bin")
            with open(binp, "wb") as f:
                f.write(data)
            msg = f"[VPRINTER] received {len(data)} bytes from {a[0]}  ->  {binp}"
            png = decode_to_png(data, binp[:-4] + ".png")
            if png:
                msg += f"\n   IMAGE -> {png}   (open to view the receipt)"
            else:
                msg += "\n   (run 'pip install pillow' to auto-decode the image)"
            print(msg)
        except KeyboardInterrupt:
            print("\nstopped.")
            break
        except Exception as e:
            print("error:", e)


if __name__ == "__main__":
    main()
