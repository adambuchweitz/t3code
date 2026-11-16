import { act, render } from "../../test/render";
import { expect, it, vi } from "vite-plus/test";

import { useFocusedReport } from "./useFocusedReport";

interface Report {
  readonly threadId: string;
  readonly title: string;
  readonly worktreePath: string | null;
}

const report = (overrides: Partial<Report> = {}): Report => ({
  threadId: "a",
  title: "Untitled",
  worktreePath: null,
  ...overrides,
});

function Probe(props: {
  readonly report: Report | null;
  readonly send: (report: Report) => Promise<boolean>;
}) {
  useFocusedReport(
    props.report,
    ({ threadId, worktreePath }) => [threadId, worktreePath],
    props.send,
  );
  return null;
}

const returnFocus = () => act(() => window.dispatchEvent(new Event("focus")));

it("does not resend an unchanged report when the window regains focus", async () => {
  using _hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const send = vi.fn(async (_report: Report) => true);
  // The hook under test reads no route.
  await using _screen = await render(<Probe report={report()} send={send} />, { router: false });
  expect(send).toHaveBeenCalledTimes(1);

  await returnFocus();
  expect(send).toHaveBeenCalledTimes(1);
});

it("ignores a title-only change and sends the newest title with a later path change", async () => {
  using _hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const send = vi.fn(async (_report: Report) => true);
  // The hook under test reads no route.
  await using screen = await render(<Probe report={report()} send={send} />, { router: false });

  await screen.rerender(<Probe report={report({ title: "Fix login" })} send={send} />);
  expect(send).toHaveBeenCalledTimes(1);

  await screen.rerender(
    <Probe report={report({ title: "Fix login", worktreePath: "/tmp/wt" })} send={send} />,
  );
  expect(send).toHaveBeenCalledTimes(2);
  expect(send).toHaveBeenLastCalledWith(report({ title: "Fix login", worktreePath: "/tmp/wt" }));
});

it("sends a report that changed while unfocused once focus returns", async () => {
  using hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const send = vi.fn(async (_report: Report) => true);
  // The hook under test reads no route.
  await using screen = await render(<Probe report={report()} send={send} />, { router: false });

  hasFocus.mockReturnValue(false);
  await screen.rerender(<Probe report={report({ threadId: "b" })} send={send} />);
  expect(send).toHaveBeenCalledTimes(1);

  hasFocus.mockReturnValue(true);
  await returnFocus();
  expect(send).toHaveBeenCalledTimes(2);
  expect(send).toHaveBeenLastCalledWith(report({ threadId: "b" }));
});

it("retries a failed send on the next focus", async () => {
  using _hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const send = vi.fn(async (_report: Report) => false);
  // The hook under test reads no route.
  await using _screen = await render(<Probe report={report()} send={send} />, { router: false });
  expect(send).toHaveBeenCalledTimes(1);

  send.mockImplementation(async () => true);
  await returnFocus();
  expect(send).toHaveBeenCalledTimes(2);

  await returnFocus();
  expect(send).toHaveBeenCalledTimes(2);
});
