import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import App from "../App";
import { fakeBackend } from "../test/fakeBackend";
import { formatSize } from "./attachmentsApi";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(open).mockReset();
  vi.mocked(check).mockReset().mockResolvedValue(null);
  // jsdom has no object URLs.
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
});

/** Opens the record of a fictitious patient. */
async function setup() {
  const user = userEvent.setup();
  const state = fakeBackend("unlocked");
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "Patients" }));
  await user.click(
    await screen.findByRole("button", { name: "Nouveau patient" }),
  );
  await user.type(screen.getByLabelText("Nom"), "Dupont");
  await user.type(screen.getByLabelText("Prénom"), "Anne");
  await user.click(screen.getByRole("button", { name: "Créer la fiche" }));
  await user.click(await screen.findByRole("tab", { name: "Pièces jointes" }));
  const heading = await screen.findByRole("heading", {
    name: "Pièces jointes",
  });
  return { user, state, s: within(heading.closest("section")!) };
}

test("ajout de plusieurs fichiers puis aperçu d'une image et d'un PDF", async () => {
  const { user, s } = await setup();
  expect(s.getByText("Aucune pièce jointe.")).toBeInTheDocument();

  vi.mocked(open).mockResolvedValue(["/x/radio.jpg", "/x/compte-rendu.pdf"]);
  await user.click(s.getByRole("button", { name: "Ajouter des fichiers…" }));
  expect(invoke).toHaveBeenCalledWith("add_attachments", {
    patientId: 1,
    paths: ["/x/radio.jpg", "/x/compte-rendu.pdf"],
  });

  await user.click(await s.findByRole("button", { name: "radio.jpg" }));
  expect(await s.findByRole("img", { name: "radio.jpg" })).toHaveAttribute(
    "src",
    "blob:preview",
  );
  expect(invoke).toHaveBeenCalledWith("read_attachment", { id: 1 });

  await user.click(s.getByRole("button", { name: "compte-rendu.pdf" }));
  expect(await s.findByTitle("compte-rendu.pdf")).toBeInTheDocument();
  // The previous preview's decrypted content was released.
  expect(URL.revokeObjectURL).toHaveBeenCalled();

  await user.click(s.getByRole("button", { name: "Fermer l'aperçu" }));
  expect(s.queryByTitle("compte-rendu.pdf")).not.toBeInTheDocument();
});

test("un format refusé affiche une erreur", async () => {
  const { user, s } = await setup();
  vi.mocked(open).mockResolvedValue(["/x/notes.docx"]);
  await user.click(s.getByRole("button", { name: "Ajouter des fichiers…" }));
  expect(await s.findByRole("alert")).toHaveTextContent(
    "Format non pris en charge",
  );
});

test("annuler le sélecteur ne fait rien", async () => {
  const { user, s } = await setup();
  vi.mocked(open).mockResolvedValue(null);
  await user.click(s.getByRole("button", { name: "Ajouter des fichiers…" }));
  expect(invoke).not.toHaveBeenCalledWith("add_attachments", expect.anything());
  expect(s.getByText("Aucune pièce jointe.")).toBeInTheDocument();
});

test("suppression avec confirmation", async () => {
  const { user, state, s } = await setup();
  vi.mocked(open).mockResolvedValue(["/x/radio.jpg"]);
  await user.click(s.getByRole("button", { name: "Ajouter des fichiers…" }));
  await s.findByRole("button", { name: "radio.jpg" });

  await user.click(s.getByRole("button", { name: "Supprimer" }));
  await user.click(s.getByRole("button", { name: "Annuler" }));
  expect(state.attachments).toHaveLength(1);

  await user.click(s.getByRole("button", { name: "Supprimer" }));
  await user.click(s.getByRole("button", { name: "Confirmer la suppression" }));
  expect(await s.findByText("Aucune pièce jointe.")).toBeInTheDocument();
  expect(state.attachments).toHaveLength(0);
});

test("tailles lisibles", () => {
  expect(formatSize(512)).toBe("512 o");
  expect(formatSize(1536)).toBe("1,5 Ko");
  expect(formatSize(5 * 1024 * 1024)).toBe("5 Mo");
});
