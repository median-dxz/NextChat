import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  HashRouter,
  Link,
  Route,
  Routes,
  useParams,
} from "react-router";

function ArtifactRoute() {
  const { id } = useParams();
  return <div>artifact:{id}</div>;
}

function TestRoutes() {
  return (
    <HashRouter>
      <nav>
        <Link to="/settings">settings</Link>
      </nav>
      <Routes>
        <Route path="/" element={<div>home</div>} />
        <Route path="/settings" element={<div>settings page</div>} />
        <Route path="/artifacts/:id" element={<ArtifactRoute />} />
      </Routes>
    </HashRouter>
  );
}

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("React Router 7 hash routing", () => {
  test("resolves a deep link and preserves dynamic params", () => {
    window.history.replaceState(null, "", "/#/artifacts/report-42");

    render(<TestRoutes />);

    expect(screen.getByText("artifact:report-42")).toBeInTheDocument();
  });

  test("navigates without leaving hash routing", async () => {
    window.history.replaceState(null, "", "/#/");
    render(<TestRoutes />);

    fireEvent.click(screen.getByRole("link", { name: "settings" }));

    await waitFor(() => {
      expect(window.location.hash).toBe("#/settings");
      expect(screen.getByText("settings page")).toBeInTheDocument();
    });
  });
});
