import { useCallback, useEffect, useState } from "react";
import "./App.css";
import Home from "./Home";
import { lockApi } from "./lock/api";
import {
  RecoverScreen,
  RecoveryKeyScreen,
  SetupScreen,
  UnlockScreen,
} from "./lock/screens";

type Screen =
  | { kind: "loading" }
  | { kind: "setup" }
  | { kind: "recovery_key"; recoveryKey: string }
  | { kind: "locked" }
  | { kind: "recover" }
  | { kind: "unlocked" };

function App() {
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });

  useEffect(() => {
    void lockApi.status().then((status) =>
      setScreen({
        kind: status === "needs_setup" ? "setup" : status,
      }),
    );
  }, []);

  const lock = useCallback(() => {
    void lockApi.lock().then(() => setScreen({ kind: "locked" }));
  }, []);

  const unlocked = () => setScreen({ kind: "unlocked" });
  const locked = () => setScreen({ kind: "locked" });

  switch (screen.kind) {
    case "loading":
      return null;
    case "setup":
      return (
        <SetupScreen
          onCreated={(recoveryKey) =>
            setScreen({ kind: "recovery_key", recoveryKey })
          }
          onRestored={locked}
        />
      );
    case "recovery_key":
      return (
        <RecoveryKeyScreen recoveryKey={screen.recoveryKey} onDone={unlocked} />
      );
    case "locked":
      return (
        <UnlockScreen
          onUnlocked={unlocked}
          onForgot={() => setScreen({ kind: "recover" })}
        />
      );
    case "recover":
      return (
        <RecoverScreen
          onRecovered={unlocked}
          onCancel={() => setScreen({ kind: "locked" })}
        />
      );
    case "unlocked":
      return <Home onLock={lock} onRestored={locked} />;
  }
}

export default App;
