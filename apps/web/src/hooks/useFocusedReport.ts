import { useEffect, useEffectEvent, useRef } from "react";

/**
 * Sends the newest report once per change of `keyOf` while the window has focus. A change made
 * while unfocused is sent when focus returns; refocusing on an unchanged key sends nothing. A
 * failed send is forgotten, so the next change or focus tries again.
 */
export function useFocusedReport<T>(
  report: T | null,
  keyOf: (report: T) => unknown,
  send: (report: T) => Promise<boolean>,
) {
  const reportKey = report === null ? null : JSON.stringify(keyOf(report));
  const lastSentKey = useRef<string | null>(null);

  const reportFocus = useEffectEvent(() => {
    if (report === null || reportKey === null || !document.hasFocus()) return;
    if (lastSentKey.current === reportKey) return;
    lastSentKey.current = reportKey;
    void send(report).then((sent) => {
      if (!sent && lastSentKey.current === reportKey) lastSentKey.current = null;
    });
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports thread focus to external hook listeners when the focused thread changes
  useEffect(() => {
    // Leaving the thread, even for a draft, makes returning to it a new focus.
    if (reportKey === null) lastSentKey.current = null;
    else reportFocus();
  }, [reportKey]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens for window focus to report the focused thread to external hook listeners
  useEffect(() => {
    const onFocus = () => reportFocus();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
}
