// Native Linux desktop build: zero remote telemetry or third-party tracking.
export const analyticsReady = new Promise(() => {});
export const analyticsId = () => null;
export function track() {}
export function setActivity() {}
