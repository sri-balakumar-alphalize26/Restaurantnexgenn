// Fake thermal printer for testing KOT without hardware.
// Listens on TCP 9100, saves whatever it receives, and (when the data is an
// ESC/POS raster image — GS v 0) decodes it to a viewable .bmp so you can SEE
// the printout. Point a KOT Setup printer IP at this PC (192.168.1.7:9100).
//
//   node tools/fake_printer.js
//
// Saves to ./fake_prints/

const net = require('net');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2]) || 9100;
const OUT = path.join(process.cwd(), 'fake_prints');
fs.mkdirSync(OUT, { recursive: true });

function tsName(ext) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `print_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_${Date.now() % 1000}.${ext}`;
}

// ESC/POS GS v 0 raster → 24-bit BMP (so it opens in any image viewer)
function decodeRasterToBMP(buf) {
  for (let i = 0; i + 8 < buf.length; i++) {
    if (buf[i] === 0x1d && buf[i + 1] === 0x76 && buf[i + 2] === 0x30) {
      const xBytes = buf[i + 4] | (buf[i + 5] << 8);
      const height = buf[i + 6] | (buf[i + 7] << 8);
      const dataStart = i + 8;
      const needed = xBytes * height;
      if (xBytes > 0 && height > 0 && dataStart + needed <= buf.length) {
        const width = xBytes * 8;
        const rowSize = Math.floor((24 * width + 31) / 32) * 4;
        const pixelArraySize = rowSize * height;
        const fileSize = 54 + pixelArraySize;
        const bmp = Buffer.alloc(fileSize);
        bmp.write('BM', 0);
        bmp.writeUInt32LE(fileSize, 2);
        bmp.writeUInt32LE(54, 10);
        bmp.writeUInt32LE(40, 14);
        bmp.writeInt32LE(width, 18);
        bmp.writeInt32LE(height, 22);
        bmp.writeUInt16LE(1, 26);
        bmp.writeUInt16LE(24, 28);
        bmp.writeUInt32LE(pixelArraySize, 34);
        for (let y = 0; y < height; y++) {
          const srcRow = dataStart + y * xBytes;
          const dstRow = 54 + (height - 1 - y) * rowSize; // BMP is bottom-up
          for (let x = 0; x < width; x++) {
            const bit = (buf[srcRow + (x >> 3)] >> (7 - (x & 7))) & 1;
            const v = bit ? 0 : 255; // 1 = black dot
            const off = dstRow + x * 3;
            bmp[off] = v; bmp[off + 1] = v; bmp[off + 2] = v;
          }
        }
        return bmp;
      }
    }
  }
  return null;
}

const server = net.createServer((sock) => {
  const chunks = [];
  const from = (sock.remoteAddress || '').replace('::ffff:', '');
  sock.on('data', (d) => chunks.push(d));
  const save = () => {
    if (!chunks.length) return;
    const buf = Buffer.concat(chunks);
    chunks.length = 0;
    const binPath = path.join(OUT, tsName('bin'));
    fs.writeFileSync(binPath, buf);
    let msg = `[FAKE-PRINTER] ${new Date().toLocaleTimeString()}  received ${buf.length} bytes from ${from}\n   raw  -> ${binPath}`;
    try {
      const bmp = decodeRasterToBMP(buf);
      if (bmp) {
        const bmpPath = binPath.replace(/\.bin$/, '.bmp');
        fs.writeFileSync(bmpPath, bmp);
        msg += `\n   IMAGE-> ${bmpPath}  (open this to see the printout)`;
      } else {
        msg += `\n   (text ESC/POS — no raster image to decode)`;
      }
    } catch (e) {
      msg += `\n   (decode failed: ${e.message})`;
    }
    console.log(msg);
  };
  sock.on('end', save);
  sock.on('close', save);
  sock.on('error', () => {});
});

server.listen(PORT, '0.0.0.0', () =>
  console.log(`[FAKE-PRINTER] listening on 0.0.0.0:${PORT}  (this PC = 192.168.1.7)\n   saving prints to ${OUT}\n   set a KOT Setup printer IP to 192.168.1.7 port ${PORT}`),
);
