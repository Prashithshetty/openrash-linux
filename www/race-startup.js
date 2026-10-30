import { track } from './analytics.js?v=7ff6fafad2';

// Own the loading/error screen for the entire race lifetime. A failed download,
// graphics setup or animation frame must never leave an empty, playing page.
export async function withRaceScreen(opts, start) {
  const container = opts.container;
  for (;;) {
    const cleanups = [], t0 = performance.now();
    const panel = document.createElement('div');
    panel.className = 'race-loading';
    panel.innerHTML = '<div><strong>GET READY TO RIDE</strong><p role="status" aria-live="polite">Loading the course…</p><small>The first race takes longer to load.</small></div>';
    container.appendChild(panel);
    const message = panel.querySelector('p');
    const startup = {
      defer: fn => cleanups.push(fn),
      status: text => { message.textContent = text; },
      ready: () => { if (panel.isConnected) track('race_loaded', { track: opts.course, load_s: Math.round((performance.now() - t0) / 100) / 10 }); panel.remove(); },
    };
    let failure;
    try {
      // Paint the loading screen before constructing the course.
      await new Promise(resolve => setTimeout(resolve, 0));
      return await start(opts, startup);
    } catch (error) {
      failure = error;
    } finally {
      for (const fn of cleanups.reverse()) { try { fn(); } catch {} }
      container.replaceChildren();
      container.classList.remove('touch-race', 'race-paused');
    }
    console.error('Race could not continue:', failure);
    const graphics = /WebGL|graphics|context|\bgl\./i.test(failure?.message || '');
    // No WebGL at all: usually Chrome/Edge with hardware acceleration off or the GPU blocked (they no longer fall back
    // to software WebGL), so trying again can't help; say how to turn it on.
    const noWebGL = /creating WebGL context|\bgl\./i.test(failure?.message || '');
    track('race_failed', { track: opts.course, kind: graphics ? 'graphics' : 'download', message: String(failure?.message || failure).slice(0, 200) });
    if (opts.net) return { status: 'unavailable' }; // A failed peer must release the room's start barrier.
    panel.innerHTML = '<div><strong>COULDN’T START THE RACE</strong><p role="alert"></p><button type="button" class="retry">TRY AGAIN</button><button type="button" class="back">BACK TO TRACKS</button></div>';
    panel.querySelector('p').textContent = noWebGL
      ? 'Your browser has 3D graphics switched off. In Chrome or Edge, open Settings → System, turn on “Use graphics acceleration when available”, then restart the browser. Or try another browser.'
      : graphics ? 'The browser couldn’t start the graphics. Close other game tabs, then try again.'
      : 'The course couldn’t load. Check your connection and try again.';
    container.appendChild(panel);
    const retry = await new Promise(resolve => {
      panel.querySelector('.retry').onclick = () => resolve(true);
      panel.querySelector('.back').onclick = () => resolve(false);
    });
    panel.remove();
    if (!retry) return { status: 'unavailable' };
  }
}

// One quiet retry: a phone switching networks or a dropped request ("Failed to fetch") shouldn't end the race.
export async function raceJSON(url, tries = 2) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Course download failed (${response.status}): ${url}`);
    return await response.json();
  } catch (error) {
    if (tries <= 1) throw error;
    await new Promise((ok) => setTimeout(ok, 1500));
    return raceJSON(url, tries - 1);
  }
}
