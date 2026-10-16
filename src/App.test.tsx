import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import type { LockStatus } from "./lock/api";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const RECOVERY_KEY = "ABCD-0000-0000-0000-0000-0000-0000-0000";

/** In-memory stand-in for the Rust session commands. */
function fakeBackend(initial: LockStatus) {
  const state = { status: initial, password: "correct horse", autoLock: 10 };
  vi.mocked(invoke).mockImplementation(async (cmd, args) => {
    const a = (args ?? {}) as Record<string, string>;
    switch (cmd) {
      case "lock_status":
        return state.status;
      case "create_password":
        state.password = a.password;
        state.status = "unlocked";
        return RECOVERY_KEY;
      case "unlock":
        if (a.password !== state.password) throw { code: "wrong_password" };
        state.status = "unlocked";
        return;
      case "recover":
        if (a.recoveryKey !== RECOVERY_KEY)
          throw { code: "wrong_recovery_key" };
        state.password = a.newPassword;
        state.status = "unlocked";
        return;
      case "lock":
        state.status = "locked";
        return;
      case "auto_lock_minutes":
        return state.autoLock;
      case "set_auto_lock_minutes":
        state.autoLock = Number(a.minutes);
        return;
      case "print_page":
        return;
    }
    throw new Error(`unexpected command ${cmd}`);
  });
  return state;
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

test("premier lancement : création du mot de passe puis clé de récupération", async () => {
  const user = userEvent.setup();
  const state = fakeBackend("needs_setup");
  render(<App />);

  await user.type(
    await screen.findByLabelText("Nouveau mot de passe"),
    "mon mot de passe",
  );
  await user.type(screen.getByLabelText("Confirmation"), "mon mot de passe");
  await user.click(
    screen.getByRole("button", { name: "Créer le mot de passe" }),
  );

  expect(await screen.findByText(RECOVERY_KEY)).toBeInTheDocument();
  expect(state.password).toBe("mon mot de passe");

  await user.click(screen.getByRole("button", { name: "Imprimer" }));
  expect(invoke).toHaveBeenCalledWith("print_page");

  const next = screen.getByRole("button", { name: "Continuer" });
  expect(next).toBeDisabled();
  await user.click(screen.getByRole("checkbox"));
  await user.click(next);
  expect(
    await screen.findByRole("button", { name: "Verrouiller" }),
  ).toBeInTheDocument();
});

test("refuse une confirmation différente sans appeler le backend", async () => {
  const user = userEvent.setup();
  fakeBackend("needs_setup");
  render(<App />);

  await user.type(
    await screen.findByLabelText("Nouveau mot de passe"),
    "mon mot de passe",
  );
  await user.type(screen.getByLabelText("Confirmation"), "autre chose");
  await user.click(
    screen.getByRole("button", { name: "Créer le mot de passe" }),
  );

  expect(screen.getByRole("alert")).toHaveTextContent("ne correspondent pas");
  expect(invoke).not.toHaveBeenCalledWith("create_password", expect.anything());
});

test("déverrouillage : mauvais puis bon mot de passe", async () => {
  const user = userEvent.setup();
  fakeBackend("locked");
  render(<App />);

  const field = await screen.findByLabelText("Mot de passe");
  await user.type(field, "faux{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Mot de passe incorrect.",
  );

  await user.clear(field);
  await user.type(field, "correct horse{Enter}");
  expect(
    await screen.findByRole("button", { name: "Verrouiller" }),
  ).toBeInTheDocument();
});

test("mot de passe oublié : la clé de récupération permet d'en choisir un nouveau", async () => {
  const user = userEvent.setup();
  const state = fakeBackend("locked");
  render(<App />);

  await user.click(
    await screen.findByRole("button", { name: "Mot de passe oublié ?" }),
  );
  await user.type(screen.getByLabelText("Clé de récupération"), RECOVERY_KEY);
  await user.type(screen.getByLabelText("Nouveau mot de passe"), "nouveau mdp");
  await user.type(screen.getByLabelText("Confirmation"), "nouveau mdp");
  await user.click(
    screen.getByRole("button", { name: "Changer le mot de passe" }),
  );

  expect(
    await screen.findByRole("button", { name: "Verrouiller" }),
  ).toBeInTheDocument();
  expect(state.password).toBe("nouveau mdp");
});

test("le bouton Verrouiller ramène à l'écran de déverrouillage", async () => {
  const user = userEvent.setup();
  const state = fakeBackend("unlocked");
  render(<App />);

  await user.click(await screen.findByRole("button", { name: "Verrouiller" }));
  expect(await screen.findByLabelText("Mot de passe")).toBeInTheDocument();
  expect(state.status).toBe("locked");
});

test("verrouillage automatique après le délai d'inactivité", async () => {
  vi.useFakeTimers();
  try {
    const state = fakeBackend("unlocked");
    state.autoLock = 2;
    render(<App />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("button", { name: "Verrouiller" })).toBeVisible();

    await act(() => vi.advanceTimersByTimeAsync(90_000));
    window.dispatchEvent(new MouseEvent("mousemove"));
    await act(() => vi.advanceTimersByTimeAsync(90_000));
    expect(state.status).toBe("unlocked");

    await act(() => vi.advanceTimersByTimeAsync(31_000));
    expect(state.status).toBe("locked");
    expect(screen.getByLabelText("Mot de passe")).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

test("enregistre le délai de verrouillage", async () => {
  const user = userEvent.setup();
  const state = fakeBackend("unlocked");
  render(<App />);

  const field = await screen.findByLabelText(
    "Verrouillage automatique après (minutes)",
  );
  await user.clear(field);
  await user.type(field, "15");
  await user.click(screen.getByRole("button", { name: "Enregistrer" }));

  expect(await screen.findByRole("status")).toHaveTextContent(
    "Délai enregistré.",
  );
  expect(state.autoLock).toBe(15);
});
