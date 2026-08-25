import { useGhostAddressStore } from "../store/ghostAddressStore";

export function GhostPersistenceWarning() {
  const persistenceFailed = useGhostAddressStore((s) => s.persistenceFailed);

  if (!persistenceFailed) return null;

  return (
    <div className="rounded-xl border border-amber-700/50 bg-amber-950/40 px-4 py-3 text-sm text-amber-200">
      <p className="font-medium text-amber-300">Storage unavailable</p>
      <p className="mt-1 text-amber-300/80">
        Ghost addresses could not be saved to local storage. They may be lost when
        you close the browser. Please export a backup to keep your data safe.
      </p>
    </div>
  );
}
