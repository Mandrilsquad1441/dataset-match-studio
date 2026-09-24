import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import "./match-flow.css";

export interface MatchFlowProps {
  dataset1: { name: string; count: number };
  dataset2: { name: string; count: number };
  records: { rowIndex: number; lane: "strong" | "review" | "low" | "no-match" }[];
  processed: number;
  running: boolean;
  complete: boolean;
  onSettled?: () => void;
}

type FlowRecord = MatchFlowProps["records"][number];
type Flight = FlowRecord & { key: number };
type Point = { x: number; y: number };
type Geometry = { left: Point[]; right: Point[]; slots: Point[]; join: Point; width: number };
type MotionTimer = { handle: number | null; remaining: number; started: number; callback: () => void };

// At most 24 settled squares and two flights of three squares each. A burst only
// contributes its latest real outcomes; it never creates a long visual replay.
const SOURCE_SIZE = 6;
const SAMPLE_SIZE = 12;
const QUEUE_SIZE = 2;
const MAX_FLIGHTS = 2;
const FLIGHT_SPACING = 560;
const FLIGHT_LIFETIME = 1080;
const outcomes = { strong: "Match", review: "Review", low: "Low confidence", "no-match": "No match" };
const formatCount = (value: number) => value.toLocaleString();

function sourceNodes(count: number, processed: number, active: Flight[], isSecond: boolean) {
  const sample = Math.min(SOURCE_SIZE, Math.max(0, count));
  const checked = count > 0 ? Math.floor(Math.min(1, processed / count) * sample) : 0;
  const departing = new Set(active.filter((item) => isSecond || item.lane !== "no-match").map((item) => item.rowIndex % sample));
  return Array.from({ length: sample }, (_, index) => <i key={index} className={"mf-source-square" + (isSecond && index < checked ? " is-checked" : "") + (departing.has(index) ? " is-departing" : "")} />);
}

function flightStyle(flight: Flight, geometry: Geometry): CSSProperties {
  const left = geometry.left[flight.rowIndex % geometry.left.length] ?? geometry.join;
  const right = geometry.right[flight.rowIndex % geometry.right.length] ?? geometry.join;
  const destination = geometry.slots[flight.rowIndex % SAMPLE_SIZE];
  // A rejected pair approaches from Dataset 2 only, slightly beside the merge point.
  const join = { x: geometry.join.x + (flight.lane === "no-match" ? Math.min(12, geometry.width * .025) : 0), y: geometry.join.y };
  const arc = (start: Point, side: number) => `path("M ${start.x} ${start.y} C ${start.x} ${join.y - 26}, ${join.x + side * geometry.width * .115} ${join.y - 30}, ${join.x} ${join.y}")`;
  return {
    "--mf-left-path": arc(left, -1),
    "--mf-right-path": arc(right, 1),
    "--mf-drop-path": `path("M ${join.x} ${join.y} C ${join.x} ${join.y + 23}, ${destination.x} ${destination.y - 17}, ${destination.x} ${destination.y}")`,
    "--mf-join-x": `${join.x}px`, "--mf-join-y": `${join.y}px`,
    "--mf-land-x": `${destination.x}px`, "--mf-land-y": `${destination.y}px`,
  } as CSSProperties;
}

/** A small illustration of actual saved decisions. Elapsed time never creates outcomes. */
export default function MatchFlow({ dataset1, dataset2, records, processed, running, complete, onSettled }: MatchFlowProps) {
  const [active, setActive] = useState<Flight[]>([]);
  const [pending, setPending] = useState<number[]>([]);
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const [paused, setPaused] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(() => typeof window !== "undefined" && (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !CSS.supports("offset-path", 'path("M 0 0 L 1 1")')));
  const stageRef = useRef<HTMLDivElement>(null);
  const leftGridRef = useRef<HTMLDivElement>(null);
  const rightGridRef = useRef<HTMLDivElement>(null);
  const resultGridRef = useRef<HTMLDivElement>(null);
  const resultBucketRef = useRef<HTMLDivElement>(null);
  const geometryRef = useRef<Geometry | null>(null);
  const seen = useRef(new Set<number>());
  const queue = useRef<Flight[]>([]);
  const activeFlights = useRef(new Map<number, Flight>());
  const timers = useRef(new Set<MotionTimer>());
  const launchTimer = useRef<MotionTimer | null>(null);
  const pausedRef = useRef(true);
  const viewportVisible = useRef(true);
  const layoutVisible = useRef(false);
  const reducedMotionRef = useRef(reducedMotion);
  const completeRef = useRef(complete);
  const serial = useRef(0);
  const previousProcessed = useRef(processed);
  const previousRecordCount = useRef(0);
  const signature = useRef("");
  const wasRunning = useRef(running);
  const settledReported = useRef(false);
  const settledCallback = useRef(onSettled);
  settledCallback.current = onSettled;
  reducedMotionRef.current = reducedMotion;
  completeRef.current = complete;

  function publishMotion() {
    setActive([...activeFlights.current.values()]);
    setPending(queue.current.map((item) => item.rowIndex));
  }

  function armTimer(timer: MotionTimer) {
    timer.started = performance.now();
    timer.handle = window.setTimeout(() => {
      timer.handle = null;
      timers.current.delete(timer);
      timer.callback();
    }, timer.remaining);
  }

  function schedule(delay: number, callback: () => void) {
    const timer: MotionTimer = { handle: null, remaining: delay, started: 0, callback };
    timers.current.add(timer);
    if (!pausedRef.current) armTimer(timer);
    return timer;
  }

  function cancelMotion() {
    for (const timer of timers.current) if (timer.handle !== null) window.clearTimeout(timer.handle);
    timers.current.clear();
    launchTimer.current = null;
    activeFlights.current.clear();
    queue.current = [];
  }

  function launchNext() {
    if (pausedRef.current || reducedMotionRef.current || !geometryRef.current || activeFlights.current.size >= MAX_FLIGHTS) return;
    // Never land two outcomes on the same sample slot at the same time.
    const occupied = new Set([...activeFlights.current.values()].map((item) => item.rowIndex % SAMPLE_SIZE));
    const index = queue.current.findIndex((item) => !occupied.has(item.rowIndex % SAMPLE_SIZE));
    if (index < 0) return;
    const [next] = queue.current.splice(index, 1);
    activeFlights.current.set(next.key, next);
    publishMotion();
    schedule(FLIGHT_LIFETIME, () => {
      activeFlights.current.delete(next.key);
      publishMotion();
      if (launchTimer.current === null) launchNext();
    });
    launchTimer.current = schedule(FLIGHT_SPACING, () => {
      launchTimer.current = null;
      launchNext();
    });
  }

  function refreshVisibility() {
    const nextPaused = document.hidden || !viewportVisible.current || !layoutVisible.current;
    if (nextPaused === pausedRef.current) return;
    pausedRef.current = nextPaused;
    setPaused(nextPaused);
    if (nextPaused && completeRef.current) {
      // Finishing offscreen settles directly to saved outcomes, never leaving
      // the parent waiting for a visual queue that the user cannot see.
      cancelMotion(); publishMotion(); return;
    }
    for (const timer of timers.current) {
      if (nextPaused && timer.handle !== null) {
        window.clearTimeout(timer.handle);
        timer.remaining = Math.max(0, timer.remaining - (performance.now() - timer.started));
        timer.handle = null;
      } else if (!nextPaused && timer.handle === null) armTimer(timer);
    }
    if (!nextPaused && launchTimer.current === null) launchNext();
  }

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => {
      const bounds = stage.getBoundingClientRect();
      layoutVisible.current = bounds.width > 0 && bounds.height > 0;
      if (layoutVisible.current) {
        const centers = (grid: HTMLDivElement | null) => Array.from(grid?.children ?? []).map((node) => {
          const rect = node.getBoundingClientRect();
          return { x: rect.left - bounds.left + rect.width / 2, y: rect.top - bounds.top + rect.height / 2 };
        });
        const bucket = resultBucketRef.current!.getBoundingClientRect();
        const next: Geometry = { left: centers(leftGridRef.current), right: centers(rightGridRef.current), slots: centers(resultGridRef.current), join: { x: bounds.width / 2, y: bucket.top - bounds.top - 12 }, width: bounds.width };
        geometryRef.current = next;
        setGeometry(next);
      }
      refreshVisibility();
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(stage);
    if (leftGridRef.current) resize.observe(leftGridRef.current);
    if (rightGridRef.current) resize.observe(rightGridRef.current);
    if (resultGridRef.current) resize.observe(resultGridRef.current);
    const intersection = new IntersectionObserver(([entry]) => {
      viewportVisible.current = entry.isIntersecting;
      refreshVisibility();
    });
    intersection.observe(stage);
    document.addEventListener("visibilitychange", refreshVisibility);
    return () => {
      resize.disconnect();
      intersection.disconnect();
      document.removeEventListener("visibilitychange", refreshVisibility);
      cancelMotion();
      seen.current.clear();
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches || !CSS.supports("offset-path", 'path("M 0 0 L 1 1")'));
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useLayoutEffect(() => {
    const nextSignature = `${dataset1.name}\u0000${dataset1.count}\u0000${dataset2.name}\u0000${dataset2.count}`;
    const becameEmpty = records.length === 0 && previousRecordCount.current > 0;
    const restarted = nextSignature !== signature.current || processed < previousProcessed.current || becameEmpty;
    signature.current = nextSignature;
    previousProcessed.current = processed;
    previousRecordCount.current = records.length;
    if (!complete || restarted) settledReported.current = false;
    if (restarted) {
      cancelMotion(); seen.current.clear(); publishMotion();
      wasRunning.current = running;
    }
    const incoming = records.filter((record) => Number.isInteger(record.rowIndex) && record.rowIndex >= 0 && !seen.current.has(record.rowIndex));
    for (const record of incoming) seen.current.add(record.rowIndex);
    if (reducedMotion || (complete && pausedRef.current)) {
      cancelMotion(); publishMotion();
    } else if (incoming.length && (running || wasRunning.current)) {
      const latest = new Map<number, Flight>();
      for (const item of [...queue.current, ...incoming.slice(-QUEUE_SIZE).map((record) => ({ ...record, key: ++serial.current }))]) latest.set(item.rowIndex % SAMPLE_SIZE, item);
      queue.current = [...latest.values()].slice(-QUEUE_SIZE);
      publishMotion();
      if (launchTimer.current === null) launchNext();
    }
    if (running) wasRunning.current = true;
  }, [records, processed, running, complete, reducedMotion, dataset1.name, dataset1.count, dataset2.name, dataset2.count]);

  useLayoutEffect(() => {
    // Read live refs as well as committed state: the preceding effect may have just
    // enqueued the final real rows, while this render still appears idle.
    const idle = !active.length && !pending.length && !queue.current.length && !activeFlights.current.size && !timers.current.size;
    if (complete && idle && !settledReported.current && settledCallback.current) {
      settledReported.current = true;
      settledCallback.current();
    }
  }, [complete, active, pending, records, processed, reducedMotion]);

  const slots = useMemo(() => {
    const result: (FlowRecord | null)[] = Array.from({ length: SAMPLE_SIZE }, () => null);
    for (const record of records) {
      if (!Number.isInteger(record.rowIndex) || record.rowIndex < 0) continue;
      const slot = record.rowIndex % SAMPLE_SIZE;
      if (!result[slot] || result[slot]!.rowIndex <= record.rowIndex) result[slot] = record;
    }
    return result;
  }, [records]);
  const movingRows = new Set([...pending, ...active.map((flight) => flight.rowIndex)]);
  const sourceName = (name: string) => name || "Your dataset";

  return <div className={"match-flow" + (running ? " is-running" : "") + (complete ? " is-complete" : "") + (paused ? " is-paused" : "") + (reducedMotion ? " is-static" : "")} role="img" aria-label={`Dataset 1: ${formatCount(dataset1.count)} records. Dataset 2: ${formatCount(dataset2.count)} records. ${formatCount(processed)} records compared. Squares show a small sample of saved outcomes; outlined squares are non-matches.`}>
    <div className="mf-labels" aria-hidden="true"><span>Dataset 1</span><span>Results</span><span>Dataset 2</span></div>
    <div className="mf-stage" ref={stageRef} aria-hidden="true">
      <div className="mf-bucket mf-bucket-left"><span className="mf-bucket-lip lip-left" /><span className="mf-bucket-lip lip-right" /><div className="mf-source-grid" ref={leftGridRef}>{sourceNodes(dataset1.count, 0, active, false)}</div></div>
      <div className="mf-bucket mf-bucket-result" ref={resultBucketRef}>
        <span className="mf-bucket-lip lip-left" /><span className="mf-bucket-lip lip-right" />
        <div className="mf-result-grid" ref={resultGridRef}>
          {slots.map((record, slot) => <span className="mf-result-slot" key={slot} style={{ gridColumn: slot % 4 + 1, gridRow: 3 - Math.floor(slot / 4) }}>
            <i className={"mf-result-square " + (record?.lane ?? "") + (!record || movingRows.has(record.rowIndex) ? " is-pending" : "")} title={record ? `Record ${record.rowIndex + 1}: ${outcomes[record.lane]}` : undefined} />
          </span>)}
        </div>
      </div>
      <div className="mf-bucket mf-bucket-right"><span className="mf-bucket-lip lip-left" /><span className="mf-bucket-lip lip-right" /><div className="mf-source-grid" ref={rightGridRef}>{sourceNodes(dataset2.count, processed, active, true)}</div></div>
      <div className="mf-flights">{geometry && active.map((flight) => <span key={flight.key} className={"mf-flight " + flight.lane} style={flightStyle(flight, geometry)}>
        {flight.lane !== "no-match" && <i className="mf-particle mf-particle-left" />}
        <i className="mf-particle mf-particle-right" />
        <i className={"mf-record-drop " + flight.lane} />
      </span>)}</div>
    </div>
    <div className="mf-captions" aria-hidden="true">
      <div><strong title={sourceName(dataset1.name)}>{sourceName(dataset1.name)}</strong><span>{formatCount(dataset1.count)} records</span></div>
      <div />
      <div><strong title={sourceName(dataset2.name)}>{sourceName(dataset2.name)}</strong><span>{formatCount(dataset2.count)} records</span></div>
    </div>
  </div>;
}
