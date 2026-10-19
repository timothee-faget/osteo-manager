import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PAGE, usePaging } from "./paging";

function List({ count }: { count: number }) {
  const page = usePaging();
  const [items, more] = page(Array.from({ length: count }, (_, i) => i));
  return (
    <>
      <ul>
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
      {more}
    </>
  );
}

test("une longue liste s'affiche par pages", async () => {
  const user = userEvent.setup();
  render(<List count={2 * PAGE + 50} />);
  expect(screen.getAllByRole("listitem")).toHaveLength(PAGE);

  await user.click(
    screen.getByRole("button", { name: `Afficher les ${PAGE} suivantes` }),
  );
  expect(screen.getAllByRole("listitem")).toHaveLength(2 * PAGE);

  await user.click(
    screen.getByRole("button", { name: "Afficher les 50 suivantes" }),
  );
  expect(screen.getAllByRole("listitem")).toHaveLength(2 * PAGE + 50);
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

test("une liste courte n'a pas de bouton", () => {
  render(<List count={3} />);
  expect(screen.getAllByRole("listitem")).toHaveLength(3);
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});
