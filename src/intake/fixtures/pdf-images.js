// Synthetic-only raster PDF for extraction regression tests.
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
export function syntheticImagePdf() {
  const require = createRequire(import.meta.url);
  const { createCanvas } = require('@napi-rs/canvas');
  const canvas = createCanvas(1200, 600), ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 1200, 600); ctx.fillStyle = 'black'; ctx.font = '42px sans-serif';
  ctx.fillText('Synthetic PDF OCR fixture', 60, 160); ctx.fillText('Revenue $42,000', 60, 260); ctx.fillText('Discount 20 percent', 60, 360);
  const rgb = Buffer.from(ctx.getImageData(0, 0, 1200, 600).data.filter((_, i) => i % 4 !== 3));
  const image = deflateSync(rgb), drawing = Buffer.from('q 1200 0 0 600 0 0 cm /Img Do Q');
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'), Buffer.from('<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>'),
    ...[1, 2].map(() => Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1200 600] /Resources << /XObject << /Img 5 0 R >> >> /Contents 6 0 R >>')),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1200 /Height 600 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`), image, Buffer.from('\nendstream')]),
    Buffer.concat([Buffer.from(`<< /Length ${drawing.length} >>\nstream\n`), drawing, Buffer.from('\nendstream')]),
  ];
  const parts = [Buffer.from('%PDF-1.4\n')], offsets = [0]; let size = parts[0].length;
  objects.forEach((obj, i) => { offsets.push(size); const part = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), obj, Buffer.from('\nendobj\n')]); parts.push(part); size += part.length; });
  parts.push(Buffer.from(`xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${size}\n%%EOF`));
  return Buffer.concat(parts);
}
