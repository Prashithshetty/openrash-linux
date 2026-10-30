// Initial data failures must leave a usable screen, including when the browser is offline.
export async function fetchStartupJSON(url, {fetcher = fetch, attempts = 3, timeoutMs = 15000, delay = ms => new Promise(resolve => setTimeout(resolve, ms))} = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(url, {signal: controller.signal});
      if (!response.ok) throw new Error(`Startup download failed (${response.status})`);
      return await response.json();
    } catch (error) {
      if (attempt === attempts - 1) throw error;
    } finally { clearTimeout(timer); }
    await delay(500 * (attempt + 1));
  }
}
export async function loadStartupData(container, urls) {
  for (;;) {
    container.innerHTML = '<main class="front-menu"><div class="menu-wrap"><div class="menu-body"><h1>Road Rash</h1><p role="status">Loading the game…</p></div></div></main>';
    const results = await Promise.allSettled(urls.map(url => fetchStartupJSON(url)));
    if (results.every(r => r.status === 'fulfilled')) return results.map(r => r.value);
    container.innerHTML = '<main class="front-menu"><div class="menu-wrap"><div class="menu-body"><h1>Couldn’t load the game</h1><p role="alert">Check your connection, then try again. Your saved progress has not been changed.</p><button type="button" class="primary" data-startup-retry>Try Again</button></div></div></main>';
    const button = container.querySelector('[data-startup-retry]'); button.focus();
    await new Promise(resolve => button.addEventListener('click', resolve, {once:true}));
  }
}
