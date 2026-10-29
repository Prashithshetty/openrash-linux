// Music format for this browser: every track ships as AAC (.m4a) and Ogg Vorbis. iPhone Safari can't decode the Ogg
// files, while Firefox without system codecs only plays Ogg. Sound effects are plain WAV (the original 8-bit 11 kHz
// clips as 16-bit PCM): AAC pads every clip with silence, which turned the 26 ms engine loops into a buzz.
export const AUDIO = typeof Audio !== "undefined" && new Audio().canPlayType('audio/mp4; codecs="mp4a.40.2"') ? "m4a" : "ogg";

// Mute, shared by menus and races and kept in this browser: the menu's speaker button, M anywhere, or the pause menu.
let muted = false; try { muted = localStorage.getItem("rr-muted") === "1"; } catch {}
const listeners = new Set();
export const isMuted = () => muted;
export function setMuted(m) { muted = !!m; try { localStorage.setItem("rr-muted", muted ? "1" : "0"); } catch {} for (const f of listeners) f(muted); }
export const onMute = (f) => { listeners.add(f); return () => listeners.delete(f); };
