import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import App from "../App";
import { fakeBackend } from "../test/fakeBackend";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(open).mockReset();
  vi.mocked(check).mockReset().mockResolvedValue(null);
});

type State = ReturnType<typeof fakeBackend>;

/** A fictitious practitioner and two locations, unless `configure` says otherwise. */
function withPractice(state: State) {
  state.practitioner.last_name = "Martin";
  state.billing.home_visit_fee_cents = 7500;
  state.locations.push(
    {
      id: 1,
      name: "Cabinet",
      kind: "practice",
      address: "2 place du Marché",
      retrocession_rate_bp: 0,
      archived: false,
    },
    {
      id: 2,
      name: "Domicile",
      kind: "home_visit",
      address: "",
      retrocession_rate_bp: 0,
      archived: false,
    },
  );
}

async function setup(configure: (s: State) => void = withPractice) {
  const user = userEvent.setup();
  const state = fakeBackend("unlocked");
  configure(state);
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "Patients" }));
  await user.click(
    await screen.findByRole("button", { name: "Nouveau patient" }),
  );
  await user.type(screen.getByLabelText("Nom"), "Dupont");
  await user.type(screen.getByLabelText("Prénom"), "Anne");
  await user.click(screen.getByRole("button", { name: "Créer la fiche" }));
  const heading = await screen.findByRole("heading", { name: "Séances" });
  const s = within(heading.closest("section")!);
  return { user, state, s };
}

async function newSession(
  user: ReturnType<typeof userEvent.setup>,
  s: ReturnType<typeof within>,
  reason: string,
) {
  await user.click(s.getByRole("button", { name: "Nouvelle séance" }));
  const field = await s.findByLabelText("Motif");
  await user.type(field, reason);
}

test("sans lieu d'exercice, invite à en créer un", async () => {
  const { user, s } = await setup(() => {});
  await user.click(s.getByRole("button", { name: "Nouvelle séance" }));
  expect(await s.findByRole("alert")).toHaveTextContent(
    "Ajoutez d'abord un lieu d'exercice dans Paramètres.",
  );
});

test("tarif pré-rempli selon le lieu, séance enregistrée en brouillon", async () => {
  const { user, state, s } = await setup();
  await newSession(user, s, "Lombalgie");
  expect(s.getByLabelText("Tarif")).toHaveValue("60,00");

  await user.selectOptions(s.getByLabelText("Lieu"), "Domicile");
  expect(await s.findByDisplayValue("75,00")).toBeInTheDocument();
  await user.selectOptions(s.getByLabelText("Lieu"), "Cabinet");
  expect(await s.findByDisplayValue("60,00")).toBeInTheDocument();

  await user.type(s.getByLabelText("Traitement effectué"), "Ttt iliaque D");
  await user.clear(s.getByLabelText("Date et heure"));
  await user.type(s.getByLabelText("Date et heure"), "2026-10-16T09:30");
  await user.click(s.getByRole("button", { name: "Enregistrer" }));

  expect(await s.findByRole("status")).toHaveTextContent("Séance enregistrée.");
  const row = s
    .getByRole("button", { name: "16/10/2026 à 09:30" })
    .closest("tr")!;
  expect(within(row).getByText("Lombalgie")).toBeInTheDocument();
  expect(within(row).getByText("60,00 €")).toBeInTheDocument();
  expect(within(row).getByText("Non facturée")).toBeInTheDocument();
  expect(state.sessions[0]).toMatchObject({
    location_id: 1,
    fee_cents: 6000,
    treatment: "Ttt iliaque D",
  });
});

test("valider émet la facture après confirmation et verrouille la facturation", async () => {
  const { user, state, s } = await setup();
  await newSession(user, s, "Lombalgie");
  await user.click(s.getByRole("button", { name: "Valider et facturer" }));
  expect(
    s.getByText(/ne pourra plus être modifiée ni supprimée/),
  ).toBeInTheDocument();
  await user.click(s.getByRole("button", { name: "Annuler" }));
  expect(invoke).not.toHaveBeenCalledWith(
    "validate_session",
    expect.anything(),
  );

  await user.click(s.getByRole("button", { name: "Valider et facturer" }));
  await user.click(
    s.getByRole("button", { name: "Confirmer et émettre la facture" }),
  );
  expect(await s.findByRole("status")).toHaveTextContent(
    "Facture 2026-10-001 émise.",
  );
  expect(s.getByText("2026-10-001")).toBeInTheDocument();
  expect(state.sessions[0].validated_at).not.toBeNull();

  // Reopened: billing fields are locked, notes are not.
  await user.click(
    s.getAllByRole("button", { name: /^\d{2}\/\d{2}\/\d{4} à/ })[0],
  );
  expect(await s.findByLabelText("Date et heure")).toBeDisabled();
  expect(s.getByLabelText("Lieu")).toBeDisabled();
  expect(s.queryByLabelText("Tarif")).not.toBeInTheDocument();
  expect(s.getByText("Tarif : 60,00 €")).toBeInTheDocument();
  expect(
    s.queryByRole("button", { name: "Valider et facturer" }),
  ).not.toBeInTheDocument();
  expect(
    s.queryByRole("button", { name: "Supprimer" }),
  ).not.toBeInTheDocument();

  await user.type(s.getByLabelText("Examen / constatations"), "Restriction L5");
  await user.click(s.getByRole("button", { name: "Enregistrer" }));
  expect(await s.findByRole("status")).toHaveTextContent("Séance enregistrée.");
  expect(state.sessions[0].examination).toBe("Restriction L5");
});

test("validation refusée si l'identité de la praticienne est incomplète", async () => {
  const { user, state, s } = await setup((st) => {
    withPractice(st);
    st.practitioner.last_name = "";
  });
  await newSession(user, s, "Lombalgie");
  await user.click(s.getByRole("button", { name: "Valider et facturer" }));
  await user.click(
    s.getByRole("button", { name: "Confirmer et émettre la facture" }),
  );
  expect(await s.findByRole("alert")).toHaveTextContent(
    "Complétez d'abord l'identité de la praticienne",
  );
  // The session itself was saved as a draft.
  expect(state.sessions).toHaveLength(1);
  expect(state.sessions[0].validated_at).toBeNull();
});

test("tarif invalide", async () => {
  const { user, state, s } = await setup();
  await newSession(user, s, "Lombalgie");
  await user.clear(s.getByLabelText("Tarif"));
  await user.type(s.getByLabelText("Tarif"), "soixante");
  await user.click(s.getByRole("button", { name: "Enregistrer" }));
  expect(await s.findByRole("alert")).toHaveTextContent(
    "Tarif invalide : saisissez un montant",
  );
  expect(state.sessions).toHaveLength(0);
});

test("suppression d'un brouillon avec confirmation", async () => {
  const { user, state, s } = await setup();
  await newSession(user, s, "Lombalgie");
  await user.click(s.getByRole("button", { name: "Enregistrer" }));
  await s.findByRole("status");

  await user.click(
    s.getAllByRole("button", { name: /^\d{2}\/\d{2}\/\d{4} à/ })[0],
  );
  await user.click(await s.findByRole("button", { name: "Supprimer" }));
  await user.click(s.getByRole("button", { name: "Confirmer la suppression" }));
  expect(await s.findByText("Aucune séance.")).toBeInTheDocument();
  expect(state.sessions).toHaveLength(0);
});
