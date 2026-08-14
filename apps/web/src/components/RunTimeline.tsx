import { useEffect, useRef } from "react";
import type { RunEvent } from "../types";

const timeFormatter = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hour12: false,
  timeZone: "UTC",
});

export function RunTimeline({ events }: { events: readonly RunEvent[] }) {
  const latest = events.at(-1);
  const listRef = useRef<HTMLOListElement>(null);
  const pinnedToBottomRef = useRef(true);

  useEffect(() => {
    const list = listRef.current;
    if (list !== null && pinnedToBottomRef.current) list.scrollTop = list.scrollHeight;
  }, [latest?.seq]);

  const trackScrollPosition = () => {
    const list = listRef.current;
    if (list === null) return;
    pinnedToBottomRef.current = list.scrollHeight - list.scrollTop - list.clientHeight <= 24;
  };

  return (
    <section className="timeline-section" aria-labelledby="timeline-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Append-only run record</p>
          <h2 id="timeline-title">Live timeline</h2>
        </div>
        <p className="event-count">{events.length} events</p>
      </div>

      <p className="sr-only" aria-live="polite">
        {latest === undefined ? "No run events yet." : latest.message}
      </p>

      {events.length === 0 ? (
        <p className="sheet-placeholder">The source-tagged event record starts with the queued run.</p>
      ) : (
        <ol
          className="timeline-list"
          ref={listRef}
          role="log"
          aria-live="off"
          aria-label="Run events ordered by sequence"
          tabIndex={0}
          onScroll={trackScrollPosition}
        >
          {events.map((event) => (
            <li data-event-type={event.type} key={event.seq}>
              <code className="event-seq">{String(event.seq).padStart(3, "0")}</code>
              <span className="source-label">{event.source}</span>
              <time dateTime={event.ts}>{timeFormatter.format(new Date(event.ts))}Z</time>
              <div>
                <code className="event-type">{event.type}</code>
                {event.candidateId === undefined ? null : (
                  <span className="event-candidate">
                    {event.candidateId === "legacy" ? "legacy" : `candidate ${event.candidateId}`}
                  </span>
                )}
                <p>{event.message}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
