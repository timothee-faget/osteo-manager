import { ChequeDeposits } from "./ChequeDeposits";
import { UnpaidInvoices } from "./UnpaidInvoices";

/** Money received or still due: cheque deposits and unpaid invoices. */
export function CollectionsPage({
  onOpenInvoice,
}: {
  onOpenInvoice: (id: number) => void;
}) {
  return (
    <section>
      <h2>Encaissements</h2>
      <ChequeDeposits />
      <UnpaidInvoices onOpenInvoice={onOpenInvoice} />
    </section>
  );
}
