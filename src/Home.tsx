import { useEffect, useState } from "react";
import { Icon, type IconName } from "./icons";
import { AccountingPage } from "./accounting/AccountingPage";
import { DashboardPage } from "./dashboard/DashboardPage";
import { CollectionsPage } from "./collections/CollectionsPage";
import { SpendingPage } from "./expenses/SpendingPage";
import { QuickSearch } from "./search/QuickSearch";
import { lockApi } from "./lock/api";
import { useIdle } from "./lock/useIdle";
import { InvoicesPage } from "./invoices/InvoicesPage";
import { PatientsPage } from "./patients/PatientsPage";
import { SessionHistoryPage } from "./patients/SessionHistoryPage";
import { SettingsPage } from "./settings/SettingsPage";

type Page =
  | "home"
  | "patients"
  | "sessions"
  | "invoices"
  | "collections"
  | "expenses"
  | "accounting"
  | "settings";

const PAGES: Record<Page, string> = {
  home: "Accueil",
  patients: "Patients",
  sessions: "Séances",
  invoices: "Factures",
  collections: "Encaissements",
  expenses: "Dépenses",
  accounting: "Comptabilité",
  settings: "Paramètres",
};

const ICONS: Record<Page, IconName> = {
  home: "home",
  patients: "users",
  sessions: "activity",
  invoices: "file",
  collections: "wallet",
  expenses: "receipt",
  accounting: "book",
  settings: "settings",
};

/** Daily pages first; bookkeeping below; settings sit with the other actions. */
const NAV: [string, Page[]][] = [
  ["Cabinet", ["home", "patients", "sessions", "invoices", "collections"]],
  ["Gestion", ["expenses", "accounting"]],
];

/** Where to land on arrival; `seq` remounts the page even for the same page. */
type Target = {
  seq: number;
  /** Record to open. */
  id?: number;
  /** Patients: open the form of a new session, or of `sessionId`. */
  newSession?: boolean;
  sessionId?: number;
  /** Patients: a new record pre-filled with this name. */
  newPatientName?: string;
};

function Home({
  onLock,
  onRestored,
}: {
  onLock: () => void;
  onRestored: () => void;
}) {
  const [page, setPage] = useState<Page>("home");
  const [target, setTarget] = useState<Target | null>(null);
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

  function go(p: Page, intent?: Omit<Target, "seq">) {
    setPage(p);
    setTarget(intent ? { ...intent, seq: (target?.seq ?? 0) + 1 } : null);
    setSearching(false);
  }
  const [autoLock, setAutoLock] = useState<number | null>(null);

  useEffect(() => {
    void lockApi.autoLockMinutes().then(setAutoLock);
  }, []);

  useIdle(autoLock, onLock);

  return (
    <div className="app">
      <aside className="sidebar">
        <h1 className="brand">
          <span className="brand-mark">
            <Icon name="spine" />
          </span>
          Osteo Manager
        </h1>
        <nav aria-label="Navigation">
          {NAV.map(([group, pages]) => (
            <div key={group} role="group" aria-label={group}>
              {group !== NAV[0][0] && <p className="nav-group">{group}</p>}
              {pages.map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-current={page === p ? "page" : undefined}
                  onClick={() => go(p)}
                >
                  <Icon name={ICONS[p]} />
                  {PAGES[p]}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-actions">
          <button
            type="button"
            aria-current={page === "settings" ? "page" : undefined}
            onClick={() => go("settings")}
          >
            <Icon name={ICONS.settings} />
            {PAGES.settings}
          </button>
          <button type="button" onClick={() => setSearching(true)}>
            <Icon name="search" />
            Rechercher <kbd>⌘K</kbd>
          </button>
          <button type="button" onClick={onLock}>
            <Icon name="lock" />
            Verrouiller
          </button>
        </div>
      </aside>
      <main className="container">
        {page === "home" && (
          <DashboardPage
            onOpenCollections={() => go("collections")}
            onOpenAccounting={() => go("accounting")}
            onOpenSessions={() => go("sessions")}
            onOpenExpenses={() => go("expenses")}
            onOpenPatient={(id, opts) => go("patients", { id, ...opts })}
            onNewPatient={(name) => go("patients", { newPatientName: name })}
          />
        )}
        {page === "patients" && (
          <PatientsPage
            key={target?.seq}
            openPatientId={target?.id}
            newSession={target?.newSession}
            openSessionId={target?.sessionId}
            newPatientName={target?.newPatientName}
          />
        )}
        {page === "sessions" && (
          <SessionHistoryPage
            onOpenSession={(id, sessionId) => go("patients", { id, sessionId })}
          />
        )}
        {page === "invoices" && (
          <InvoicesPage key={target?.seq} openInvoiceId={target?.id} />
        )}
        {page === "collections" && (
          <CollectionsPage onOpenInvoice={(id) => go("invoices", { id })} />
        )}
        {page === "expenses" && <SpendingPage />}
        {page === "accounting" && <AccountingPage />}
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
          onOpenPatient={(id) => go("patients", { id })}
          onNewSession={(id) => go("patients", { id, newSession: true })}
          onCreatePatient={(name) => go("patients", { newPatientName: name })}
          onOpenInvoice={(id) => go("invoices", { id })}
        />
      )}
    </div>
  );
}

export default Home;
