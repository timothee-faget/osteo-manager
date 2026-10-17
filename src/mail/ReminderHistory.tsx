import { useEffect, useState } from "react";
import { formatDate } from "../patients/api";
import { mailApi, type Reminder } from "./api";

/** Reminders sent for an invoice, newest first; nothing when there are none. */
export function ReminderHistory({ invoiceId }: { invoiceId: number }) {
  const [reminders, setReminders] = useState<Reminder[]>([]);

  useEffect(() => {
    void mailApi.reminders(invoiceId).then(setReminders);
  }, [invoiceId]);

  if (reminders.length === 0) return null;
  return (
    <div>
      <h4>Relances</h4>
      <ul aria-label="Relances">
        {reminders.map((r, i) => (
          <li key={i}>
            {`Le ${formatDate(r.sent_at.slice(0, 10))} à ${r.sent_at.slice(11, 16)}, à ${r.recipient}`}
          </li>
        ))}
      </ul>
    </div>
  );
}
