// Service Worker und Push-Benachrichtigungen.
import { config } from "./backend.js";

export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
export const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && !!config.vapid;

export async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  try { return await navigator.serviceWorker.register("./sw.js", { scope: "./" }); } catch { return null; }
}

/** Was die Einstellungen anzeigen sollen. */
export async function pushStatus(backend) {
  if (backend.demo) return "demo";
  if (isIOS() && !isStandalone()) return "ios-homescreen";
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub && Notification.permission === "granted" && await backend.hasPush(sub.endpoint)) return "on";
  return "off";
}

function keyToBytes(base64) {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

/** Muss aus einem Klick heraus aufgerufen werden (iOS verlangt das). */
export async function enablePush(backend) {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Benachrichtigungen wurden nicht erlaubt. Du kannst das in den Einstellungen des Handys ändern.");
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(config.vapid) });
  const j = sub.toJSON();
  await backend.savePush({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth });
}
