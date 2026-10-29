// Shared by the app and multiplayer so a cached app need only supply its existing video player.
export function playOutcomeVideo(video, res, then) {
  const kind = res?.status === 'finished' ? (res.place <= 3 ? 'win' : 'lose')
    : res?.status === 'busted' ? 'busted' : res?.status === 'wrecked' ? 'wreck' : null;
  if (!kind || typeof video !== 'function') { then(); return null; }
  return video(`${kind}${1 + Math.floor(Math.random() * (kind === 'lose' ? 10 : 6))}`, then);
}
