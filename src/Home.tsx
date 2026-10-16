import { useEffect, useState } from "react";
import { lockApi } from "./lock/api";
import { useIdle } from "./lock/useIdle";
import { SettingsPage } from "./settings/SettingsPage";

type Page = "home" | "settings";

const PAGES: Record<Page, string> = { home: "Accueil", settings: "Paramètres" };

function Home({
  onLock,
  onRestored,
}: {
  onLock: () => void;
  onRestored: () => void;
}) {
  const [page, setPage] = useState<Page>("home");
  const [autoLock, setAutoLock] = useState<number | null>(null);

  useEffect(() => {
    void lockApi.autoLockMinutes().then(setAutoLock);
  }, []);

  useIdle(autoLock, onLock);

  return (
    <>
      <header className="topbar">
        <h1>Osteo Manager</h1>
        <nav>
          {(Object.keys(PAGES) as Page[]).map((p) => (
            <button
              key={p}
              type="button"
              aria-current={page === p ? "page" : undefined}
              onClick={() => setPage(p)}
            >
              {PAGES[p]}
            </button>
          ))}
        </nav>
        <button type="button" onClick={onLock}>
          Verrouiller
        </button>
      </header>
      <main className="container">
        {page === "home" ? (
          <p>Le tableau de bord arrivera avec la comptabilité.</p>
        ) : (
          autoLock !== null && (
            <SettingsPage
              autoLock={autoLock}
              onAutoLockChange={setAutoLock}
              onRestored={onRestored}
            />
          )
        )}
      </main>
    </>
  );
}

export default Home;
