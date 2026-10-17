import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import App from "./App";
import {
  fakeBackend,
  openSettingsSection,
  RECOVERY_KEY,
} from "./test/fakeBackend";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(open).mockReset();
  vi.mocked(check).mockReset().mockResolvedValue(null);
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
  await openSettingsSection(user, "Verrouillage");

  const field = await screen.findByLabelText(
    "Verrouillage automatique après (minutes)",
  );
  await user.clear(field);
  await user.type(field, "15");
  await user.click(
    within(field.closest("form")!).getByRole("button", { name: "Enregistrer" }),
  );

  expect(await screen.findByRole("status")).toHaveTextContent(
    "Délai enregistré.",
  );
  expect(state.autoLock).toBe(15);
});

test("choix du dossier de sauvegarde puis sauvegarde immédiate", async () => {
  const user = userEvent.setup();
  const state = fakeBackend("unlocked");
  vi.mocked(open).mockResolvedValue("/Volumes/Disque/Osteo");
  render(<App />);
  await openSettingsSection(user, "Sauvegarde");

  expect(
    await screen.findByText(/les données ne sont pas sauvegardées/),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Choisir le dossier…" }));

  expect(await screen.findByText("/Volumes/Disque/Osteo")).toBeInTheDocument();
  expect(
    screen.getByText(/Dernière sauvegarde : 16 octobre 2026/),
  ).toBeInTheDocument();
  expect(state.backupFolder).toBe("/Volumes/Disque/Osteo");

  await user.click(
    screen.getByRole("button", { name: "Sauvegarder maintenant" }),
  );
  expect(await screen.findByText(/à 19:00/)).toBeInTheDocument();
});

test("premier lancement : restauration d'une sauvegarde", async () => {
  const user = userEvent.setup();
  fakeBackend("needs_setup");
  vi.mocked(open).mockResolvedValue(
    "/Volumes/Disque/osteo-2026-10-16.osteobackup",
  );
  render(<App />);

  await user.click(
    await screen.findByRole("button", { name: "Restaurer une sauvegarde…" }),
  );
  expect(await screen.findByLabelText("Mot de passe")).toBeInTheDocument();
  expect(invoke).toHaveBeenCalledWith("restore_backup", {
    path: "/Volumes/Disque/osteo-2026-10-16.osteobackup",
  });
});

test("restaurer depuis l'accueil demande confirmation", async () => {
  const user = userEvent.setup();
  fakeBackend("unlocked");
  vi.mocked(open).mockResolvedValue("/tmp/a.osteobackup");
  render(<App />);
  await openSettingsSection(user, "Sauvegarde");

  const restore = await screen.findByRole("button", {
    name: "Restaurer une sauvegarde…",
  });
  await user.click(restore);
  await user.click(await screen.findByRole("button", { name: "Annuler" }));
  expect(invoke).not.toHaveBeenCalledWith("restore_backup", expect.anything());

  await user.click(
    screen.getByRole("button", { name: "Restaurer une sauvegarde…" }),
  );
  await user.click(await screen.findByRole("button", { name: "Restaurer" }));
  expect(await screen.findByLabelText("Mot de passe")).toBeInTheDocument();
});

test("un fichier invalide affiche une erreur", async () => {
  const user = userEvent.setup();
  fakeBackend("needs_setup");
  vi.mocked(open).mockResolvedValue("/tmp/photo.jpg");
  render(<App />);

  await user.click(
    await screen.findByRole("button", { name: "Restaurer une sauvegarde…" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Ce fichier n'est pas une sauvegarde valide.",
  );
});

test("propose la mise à jour disponible puis redémarre", async () => {
  const user = userEvent.setup();
  fakeBackend("locked");
  const downloadAndInstall = vi.fn().mockResolvedValue(undefined);
  vi.mocked(check).mockResolvedValue({
    version: "0.2.0",
    downloadAndInstall,
  } as unknown as Awaited<ReturnType<typeof check>>);
  render(<App />);

  expect(
    await screen.findByText("La version 0.2.0 d'Osteo Manager est disponible."),
  ).toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "Installer et redémarrer" }),
  );
  expect(downloadAndInstall).toHaveBeenCalled();
  expect(invoke).toHaveBeenCalledWith("restart");
});

test("une vérification de mise à jour en échec ne gêne pas", async () => {
  fakeBackend("locked");
  vi.mocked(check).mockRejectedValue(new Error("offline"));
  render(<App />);
  expect(await screen.findByLabelText("Mot de passe")).toBeInTheDocument();
  expect(screen.queryByText(/est disponible/)).not.toBeInTheDocument();
});
