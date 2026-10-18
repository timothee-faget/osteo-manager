import { useState } from "react";
import { FixedAssetsPage } from "../fixedAssets/FixedAssetsPage";
import { ExpensesPage } from "./ExpensesPage";

const TABS = { expenses: "Dépenses", assets: "Immobilisations" };

/** Expenses and fixed assets, two tabs of a single page. */
export function SpendingPage() {
  const [tab, setTab] = useState<keyof typeof TABS>("expenses");
  return (
    <>
      <div className="segmented tabs" role="tablist" aria-label="Dépenses">
        {Object.entries(TABS).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key as keyof typeof TABS)}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={TABS[tab]}>
        {tab === "expenses" ? <ExpensesPage /> : <FixedAssetsPage />}
      </div>
    </>
  );
}
