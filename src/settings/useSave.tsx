import { useState } from "react";
import { errorMessage } from "../lock/api";

/** Runs a save action and keeps a success or French error message for display. */
export function useSave() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    text: string;
    error: boolean;
  } | null>(null);

  async function save(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      setMessage({ text: success, error: false });
      return true;
    } catch (e) {
      setMessage({ text: errorMessage(e), error: true });
      return false;
    } finally {
      setBusy(false);
    }
  }

  const feedback = message && (
    <p role={message.error ? "alert" : "status"}>{message.text}</p>
  );
  return { busy, save, setMessage, feedback };
}
