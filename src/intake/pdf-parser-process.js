// Private, short-lived parser process. No credentials, database or OCR helpers.
let parser;
process.on('message', async message => {
  const { id, method, value } = message || {};
  if (!Number.isSafeInteger(id)) return;
  try {
    let result;
    if (method === 'init' && !parser) {
      const { PDFParse } = await import('pdf-parse');
      parser = new PDFParse({ data: Buffer.from(value) });
      result = true;
    } else if (parser && ['getText', 'getInfo', 'getScreenshot'].includes(method)) {
      result = await parser[method](value);
    } else throw Error('Invalid parser operation');
    if (process.connected) process.send({ id, result });
  } catch {
    // Do not return parser messages containing document contents or file paths.
    if (process.connected) process.send({ id, failed: true });
  }
});
process.on('disconnect', () => process.exit(0));
