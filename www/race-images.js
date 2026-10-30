// Keep a stalled attempt from winning after its fallback has already started.
export function loadRaceImage({ urls, load, onImage, onAttempt = () => {}, defer, timeout = 75000, timers = globalThis }) {
  let cancelled = false, generation = 0, timer, resolveDone;
  const started = Date.now();
  const done = new Promise(resolve => { resolveDone = resolve; });
  const stop = () => { cancelled = true; generation++; timers.clearTimeout(timer); resolveDone(null); };
  defer(stop);
  const attempt = index => {
    if (cancelled) return;
    const token = ++generation, url = urls[index];
    let settled = false;
    const finish = (error, image) => {
      if (cancelled || settled || token !== generation) return;
      settled = true; timers.clearTimeout(timer);
      if (!error) { onImage(image); resolveDone(null); return; }
      try { onAttempt({ format: url.endsWith('.webp') ? 'webp' : 'png', attempt: index + 1, reason: error, elapsed_s: Math.round((Date.now() - started) / 1000), url }); } catch {}
      if (index + 1 < urls.length) attempt(index + 1);
      else resolveDone(new Error(`Course image ${error}: ${url}`));
    };
    timer = timers.setTimeout(() => finish('timed out'), timeout);
    try { load(url, image => finish(null, image), () => finish('failed')); } catch { finish('failed'); }
  };
  attempt(0);
  return done;
}
