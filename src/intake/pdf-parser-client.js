import { fork } from 'node:child_process';

// Killing this process also releases PDF.js/canvas memory. A promise race in
// the app process cannot stop a wedged decoder or a synchronous render.
export function createIsolatedPdfParser(content, {
  forkImpl = fork, workerUrl = new URL('./pdf-parser-process.js', import.meta.url),
} = {}) {
  const child = forkImpl(workerUrl, [], {
    execArgv: [], serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { LANG: 'en_US.UTF-8',
      ...(process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
  });
  const pending = new Map();
  let sequence = 0, ended = false, closing = false;
  const failure = () => Object.assign(new Error('PDF parser stopped.'), { code: 'PDF_EXTRACTION_FAILED' });
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const finish = () => {
    if (ended) return;
    ended = true;
    for (const { reject } of pending.values()) reject(failure());
    pending.clear(); resolveClosed();
  };
  child.once('error', () => {
    // A transport error is not proof that a spawned process has exited.
    if (child.pid && !ended) child.kill('SIGKILL');
    else finish();
  });
  child.once('exit', finish);
  child.on('message', message => {
    const call = pending.get(message?.id);
    if (!call) return;
    pending.delete(message.id);
    message.failed ? call.reject(failure()) : call.resolve(message.result);
  });
  function request(method, value) {
    if (closing || ended) return Promise.reject(failure());
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      child.send({ id, method, value }, error => {
        if (error && pending.has(id)) { pending.delete(id); reject(failure()); }
      });
    });
  }
  const ready = request('init', content);
  ready.catch(() => {});
  const api = Object.fromEntries(['getText', 'getInfo', 'getScreenshot'].map(method =>
    [method, async value => { await ready; return request(method, value); }]));
  return { ...api, async destroy() {
    closing = true;
    if (!ended) child.kill('SIGKILL');
    await closed; // Do not report cancellation complete while the decoder lives.
  } };
}
