import { useEffect, useState } from "react";
import { CollectionsPage } from "./collections/CollectionsPage";
import { ExpensesPage } from "./expenses/ExpensesPage";
import { FixedAssetsPage } from "./fixedAssets/FixedAssetsPage";
import { QuickSearch } from "./search/QuickSearch";
import { lockApi } from "./lock/api";
import { useIdle } from "./lock/useIdle";
import { InvoicesPage } from "./invoices/InvoicesPage";
import { PatientsPage } from "./patients/PatientsPage";
import { SettingsPage } from "./settings/SettingsPage";

type Page =
  | "home"
  | "patients"
  | "invoices"
  | "collections"
  | "expenses"
  | "assets"
  | "settings";

const PAGES: Record<Page, string> = {
  home: "Accueil",
  patients: "Patients",
  invoices: "Factures",
  collections: "Encaissements",
  expenses: "Dépenses",
  assets: "Immobilisations",
  settings: "Paramètres",
};

function Home({
  onLock,
  onRestored,
}: {
  onLock: () => void;
  onRestored: () => void;
}) {
  const [page, setPage] = useState<Page>("home");
  // Record to open on arrival; `seq` remounts the page even for the same page.
  const [target, setTarget] = useState<{ id: number; seq: number } | null>(
    null,
  );
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearching(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function go(p: Page, id?: number) {
    setPage(p);
    setTarget(id === undefined ? null : { id, seq: (target?.seq ?? 0) + 1 });
    setSearching(false);
  }
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
              onClick={() => go(p)}
            >
              {PAGES[p]}
            </button>
          ))}
        </nav>
        <button type="button" onClick={() => setSearching(true)}>
          Rechercher <kbd>⌘K</kbd>
        </button>
        <button type="button" onClick={onLock}>
          Verrouiller
        </button>
      </header>
      <main className="container">
        {page === "home" && (
          <p>Le tableau de bord arrivera avec la comptabilité.</p>
        )}
        {page === "patients" && (
          <PatientsPage key={target?.seq} openPatientId={target?.id} />
        )}
        {page === "invoices" && (
          <InvoicesPage key={target?.seq} openInvoiceId={target?.id} />
        )}
        {page === "collections" && <CollectionsPage />}
        {page === "expenses" && <ExpensesPage />}
        {page === "assets" && <FixedAssetsPage />}
        {page === "settings" && autoLock !== null && (
          <SettingsPage
            autoLock={autoLock}
            onAutoLockChange={setAutoLock}
            onRestored={onRestored}
          />
        )}
      </main>
      {searching && (
        <QuickSearch
          onClose={() => setSearching(false)}
          onOpenPatient={(id) => go("patients", id)}
          onOpenInvoice={(id) => go("invoices", id)}
        />
      )}
    </>
  );
}

export default Home;
