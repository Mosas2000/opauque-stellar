type ScanNotificationPayload = {
  foundCount: number;
  newGhostCount: number;
};

function canUseNotifications() {
  return typeof window !== "undefined" && "Notification" in window;
}

export async function requestScanNotificationPermission() {
  if (!canUseNotifications()) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  return (await Notification.requestPermission()) === "granted";
}

export async function notifyScanComplete(payload: ScanNotificationPayload) {
  if (!canUseNotifications() || Notification.permission !== "granted") return;

  const discoveries = payload.foundCount + payload.newGhostCount;
  const body =
    discoveries > 0
      ? "A scan finished and found claimable or watched ghost activity."
      : "A scan finished with no new claimable activity.";

  new Notification("Opaque scan complete", {
    body,
    tag: "opaque-scan-complete",
    renotify: discoveries > 0,
  });
}
