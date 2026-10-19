// Synthetic test process only, selected by a trusted test's parser factory.
import { writeFileSync } from 'node:fs';
let options;
process.on('SIGTERM', () => {}); // Tests require actual SIGKILL, not cooperation.
process.on('message', async ({ id, method, value }) => {
  if (method === 'init') {
    options = JSON.parse(Buffer.from(value).toString());
    process.send({ id, result: true }); return;
  }
  if (method === options.stage) {
    writeFileSync(options.marker, String(process.pid));
    if (options.busy) { for (;;) Math.imul(17, 23); }
    await new Promise(() => {}); return;
  }
  const result = method === 'getText' ? { total: 1, pages: [{ num: 1, text: '' }] }
    : method === 'getInfo' ? { pages: [{ pageNumber: 1, width: 960, height: 540 }] }
    : { pages: [{ pageNumber: 1, data: Buffer.from('synthetic image') }] };
  process.send({ id, result });
});
