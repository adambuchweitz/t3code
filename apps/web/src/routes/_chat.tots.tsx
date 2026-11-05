import { createFileRoute } from "@tanstack/react-router";

import { TotsPage } from "../components/tots/TotsPage";

export const Route = createFileRoute("/_chat/tots")({
  component: TotsPage,
});
