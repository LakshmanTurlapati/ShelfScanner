import { PROFILES, SWEEP } from "./profiles.ts";
import { DRIFT_CHECKPOINTS, type DriftResult, type Result, type SeqResult, type SweepResult, type UnrelatedResult } from "./sim.ts";

type Spread = { p50: number; p95: number; max: number };
export type ProfileSummary = {
  profile: string;
  /** The shelf, for sets that run a profile on several. */
  source?: string;
  group: string;
  runs: number;
  beginFailed: number;
  correct: number;
  wrong: number;
  shown: number;
  /** correct and wrong over every displayed frame rather than at the samples. */
  displayed: { correct: number; wrong: number };
  accepted: number;
  error: Spread | null;
  over10: number;
  recovery?: { median: number | null; max: number | null; never: number };
  relocks: number;
  badRelocks: number;
  lost: number;
  stepMs: { p50: number; p90: number } | null;
  display: { p50: number; p95: number } | null;
  reasons: Record<string, number>;
};
export type SweepSummary = { name: string; bar: boolean; trials: number; accepted: number; within1: number; over2: number; maxError: number | null; ms: number | null };
export type DriftSummary = { runs: number; failedSteps: number; finalNotAccepted: number; finalMax: number | null; finalMean: number | null; checkpoints: Record<number, number | null> };
export type UnrelatedSummary = { name: string; runs: number; accepted: number; steps: number; maxError?: number | null };
export type CpuRate = { rate: number; steps: number; p50: number; p90: number; max: number; beginMs: number; grayMs: number };
export type CpuSummary = {
  sequences: { sequence: string; rates: CpuRate[] }[];
  bundle: { trackerGzip: number; workerGzip: number | null; baselineWorkerGzip: number; deltaGzip: number | null };
};
export type Summary = {
  profiles: ProfileSummary[];
  repeat: ProfileSummary[];
  lookalike: ProfileSummary[];
  sweep: SweepSummary[];
  drift: DriftSummary | null;
  unrelated: UnrelatedSummary[];
};
export type Bar = { name: string; value: string; limit: string; pass: boolean | null };

export function percentile(values: number[], q: number) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  return sorted[low] + (sorted[Math.min(low + 1, sorted.length - 1)] - sorted[low]) * (at - low);
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const pct = (part: number, whole: number) => (whole ? (100 * part) / whole : NaN);

function summariseProfile(runs: SeqResult[]): ProfileSummary {
  const errors = runs.flatMap((run) => run.errors);
  const steps = runs.flatMap((run) => run.stepMs);
  const display = runs.flatMap((run) => run.display);
  const events = runs.filter((run) => run.recoveryMs !== undefined);
  const recovered = events.flatMap((run) => (run.recoveryMs == null ? [] : [run.recoveryMs]));
  const reasons: Record<string, number> = {};
  for (const run of runs) for (const [reason, count] of Object.entries(run.reasons)) reasons[reason] = (reasons[reason] ?? 0) + count;
  const { profile, source, set } = runs[0].job;
  const frames = (key: keyof SeqResult["frames"]) => sum(runs.map((run) => run.frames[key]));
  return {
    profile,
    ...(set === "lookalike" ? { source } : {}),
    group: PROFILES.find((item) => item.name === profile)?.group ?? "",
    runs: runs.length,
    beginFailed: runs.filter((run) => !run.beginOk).length,
    correct: pct(sum(runs.map((run) => run.correct)), sum(runs.map((run) => run.eligible))),
    wrong: pct(sum(runs.map((run) => run.wrong)), sum(runs.map((run) => run.shown))),
    shown: pct(sum(runs.map((run) => run.shown)), sum(runs.map((run) => run.eligible))),
    displayed: { correct: pct(frames("correct"), frames("eligible")), wrong: pct(frames("wrong"), frames("shown")) },
    accepted: errors.length,
    error: errors.length ? { p50: percentile(errors, 0.5), p95: percentile(errors, 0.95), max: Math.max(...errors) } : null,
    over10: sum(runs.map((run) => run.over10)),
    recovery: events.length
      ? { median: recovered.length ? percentile(recovered, 0.5) : null, max: recovered.length ? Math.max(...recovered) : null, never: events.length - recovered.length }
      : undefined,
    relocks: sum(runs.map((run) => run.relocks)),
    badRelocks: sum(runs.map((run) => run.badRelocks)),
    lost: runs.filter((run) => run.lostAtMs !== null).length,
    stepMs: steps.length ? { p50: percentile(steps, 0.5), p90: percentile(steps, 0.9) } : null,
    display: display.length ? { p50: percentile(display, 0.5), p95: percentile(display, 0.95) } : null,
    reasons,
  };
}

function summariseSweep(runs: SweepResult[]): SweepSummary[] {
  return SWEEP.map((item) => {
    const cases = runs.flatMap((run) => run.cases.filter((entry) => entry.name === item.name));
    const accepted = cases.filter((entry) => entry.accepted);
    const errors = accepted.flatMap((entry) => (entry.error === null ? [] : [entry.error]));
    return {
      name: item.name,
      bar: item.bar,
      trials: cases.length,
      accepted: accepted.length,
      within1: errors.filter((error) => error <= 1).length,
      over2: errors.filter((error) => error > 2).length,
      maxError: errors.length ? Math.max(...errors) : null,
      ms: cases.length ? percentile(cases.map((entry) => entry.ms), 0.5) : null,
    };
  });
}

function summariseDrift(runs: DriftResult[]): DriftSummary | null {
  if (!runs.length) return null;
  const finals = runs.map((run) => run.checkpoints[DRIFT_CHECKPOINTS.at(-1)!]).filter((value): value is number => value != null);
  const checkpoints: Record<number, number | null> = {};
  for (const step of DRIFT_CHECKPOINTS) {
    const values = runs.map((run) => run.checkpoints[step]).filter((value): value is number => value != null);
    checkpoints[step] = values.length ? sum(values) / values.length : null;
  }
  return {
    runs: runs.length,
    failedSteps: sum(runs.map((run) => run.failed)),
    finalNotAccepted: runs.filter((run) => !run.finalAccepted).length,
    finalMax: finals.length === runs.length ? Math.max(...finals) : null,
    finalMean: finals.length ? sum(finals) / finals.length : null,
    checkpoints,
  };
}

function summariseUnrelated(runs: UnrelatedResult[]): UnrelatedSummary[] {
  const names = [...new Set(runs.flatMap((run) => run.cases.map((entry) => entry.name)))];
  return names.map((name) => {
    const cases = runs.flatMap((run) => run.cases.filter((entry) => entry.name === name));
    const errors = cases.flatMap((entry) => (entry.error == null ? [] : [entry.error]));
    const summary: UnrelatedSummary = { name, runs: cases.length, accepted: sum(cases.map((entry) => entry.accepted)), steps: sum(cases.map((entry) => entry.steps)) };
    if (cases.some((entry) => "error" in entry)) summary.maxError = errors.length ? Math.max(...errors) : null;
    return summary;
  });
}

function byProfile(runs: SeqResult[]) {
  const order = PROFILES.map((item) => item.name);
  const groups = new Map<string, SeqResult[]>();
  for (const run of runs) {
    const key = `${run.job.set === "lookalike" ? run.job.source : ""} ${run.job.profile}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  const rank = (job: SeqResult["job"]) => [job.set === "lookalike" ? job.source : "", order.indexOf(job.profile)] as const;
  return [...groups.values()].sort((a, b) => {
    const [sa, pa] = rank(a[0].job);
    const [sb, pb] = rank(b[0].job);
    return sa.localeCompare(sb) || pa - pb;
  }).map(summariseProfile);
}

export function summarise(results: Result[]): Summary {
  const seq = results.filter((result): result is SeqResult => result.kind === "seq");
  return {
    profiles: byProfile(seq.filter((run) => !run.job.set)),
    repeat: byProfile(seq.filter((run) => run.job.set === "repeat")),
    lookalike: byProfile(seq.filter((run) => run.job.set === "lookalike")),
    sweep: summariseSweep(results.filter((result): result is SweepResult => result.kind === "sweep")),
    drift: summariseDrift(results.filter((result): result is DriftResult => result.kind === "drift")),
    unrelated: summariseUnrelated(results.filter((result): result is UnrelatedResult => result.kind === "unrelated")),
  };
}

const num = (value: number | null | undefined, digits = 1) => (value == null || Number.isNaN(value) ? "-" : value.toFixed(digits));
const percent = (value: number) => (Number.isNaN(value) ? "-" : `${value.toFixed(1)}%`);

function recoveryText(summary: ProfileSummary) {
  if (!summary.recovery) return "";
  const { median, max, never } = summary.recovery;
  return `${num(median, 0)}/${num(max, 0)}${never ? ` never ${never}/${summary.runs}` : ""}`;
}

function profileRow(summary: ProfileSummary) {
  return [
    summary.source ? `${summary.source} ${summary.profile}` : summary.profile,
    String(summary.runs),
    percent(summary.correct),
    percent(summary.wrong),
    percent(summary.shown),
    percent(summary.displayed.correct),
    percent(summary.displayed.wrong),
    summary.error ? `${num(summary.error.p50, 2)}/${num(summary.error.p95, 2)}/${num(summary.error.max)}` : "-",
    String(summary.over10),
    recoveryText(summary),
    `${summary.relocks}/${summary.badRelocks}`,
    `${summary.lost}/${summary.runs}`,
    summary.display ? `${num(summary.display.p50)}/${num(summary.display.p95)}` : "-",
    summary.stepMs ? `${num(summary.stepMs.p50)}/${num(summary.stepMs.p90)}` : "-",
  ];
}

const PROFILE_HEAD = ["profile", "runs", "correct", "wrong", "shown", "disp correct", "disp wrong", "err p50/p95/max px", ">10px", "recovery med/max ms", "relock/bad", "lost", "display p50/p95", "step p50/p90 ms"];

// Printed above the sequence tables so the two kinds of correct/wrong are not mixed up.
export const LEGEND = [
  "correct / wrong / shown: judged once per 100 ms sample with the tracker's own answer for that frame (the Stage 1 bars use these).",
  "disp correct / disp wrong: judged on every displayed 30 fps frame, with the worker's delay and the labels held between samples (what the user sees; the label-motion stage targets these).",
].join("\n");

type Table = { head: string[]; rows: string[][] };

function tables(summary: Summary, bars: Bar[] | null, cpu: CpuSummary | null) {
  const out: [string, Table][] = [];
  if (summary.profiles.length) out.push(["Sequences", { head: PROFILE_HEAD, rows: summary.profiles.map(profileRow) }]);
  if (summary.repeat.length) out.push(["Repetitive shelf (one spine tiled 6 times)", { head: PROFILE_HEAD, rows: summary.repeat.map(profileRow) }]);
  if (summary.lookalike.length) {
    out.push(["Look-alike shelves (one spine repeated every 34 or 58 px, or across the upper half; hiding labels is allowed)", { head: PROFILE_HEAD, rows: summary.lookalike.map(profileRow) }]);
  }
  if (summary.sweep.length && summary.sweep[0].trials) {
    out.push(["Single step from zero motion", {
      head: ["case", "accepted", "within 1px", "over 2px", "max err px", "step ms"],
      rows: summary.sweep.map((item) => [`${item.name}${item.bar ? " *" : ""}`, `${item.accepted}/${item.trials}`, `${item.within1}/${item.trials}`, String(item.over2), num(item.maxError, 2), num(item.ms)]),
    }]);
  }
  if (summary.drift) {
    const { drift } = summary;
    out.push(["300-step drift (mean grid error px at step)", {
      head: [...Object.keys(drift.checkpoints).map((step) => `@${step}`), "final max", "failed steps", "final not accepted"],
      rows: [[...Object.values(drift.checkpoints).map((value) => num(value, 2)), num(drift.finalMax, 2), String(drift.failedSteps), `${drift.finalNotAccepted}/${drift.runs}`]],
    }]);
  }
  if (summary.unrelated.length) {
    out.push(["Unrelated content (accepted steps; shifted-noise should track)", {
      head: ["case", "accepted/steps", "max err px"],
      rows: summary.unrelated.map((item) => [item.name, `${item.accepted}/${item.steps}`, item.maxError === undefined ? "" : num(item.maxError, 2)]),
    }]);
  }
  if (cpu) {
    out.push(["Chromium main thread, CDP CPU throttling (old-books at crop 0.3, frames 100 ms apart)", {
      head: ["sequence", "rate", "steps", "step p50 ms", "step p90 ms", "step max ms", "begin ms", "gray ms"],
      rows: cpu.sequences.flatMap(({ sequence, rates }) =>
        rates.map((rate) => [sequence, `${rate.rate}x`, String(rate.steps), num(rate.p50), num(rate.p90), num(rate.max), num(rate.beginMs), num(rate.grayMs)])),
    }]);
    const { bundle } = cpu;
    out.push(["Bundle (minified, gzip -9, bytes)", {
      head: ["tracker", "worker", "baseline worker", "delta"],
      rows: [[String(bundle.trackerGzip), String(bundle.workerGzip ?? "-"), String(bundle.baselineWorkerGzip), String(bundle.deltaGzip ?? "-")]],
    }]);
  }
  if (bars) {
    out.push(["Stage 1 pass bars", {
      head: ["bar", "value", "limit", "result"],
      rows: bars.map((bar) => [bar.name, bar.value, bar.limit, bar.pass === null ? "skipped" : bar.pass ? "pass" : "FAIL"]),
    }]);
  }
  return out;
}

function textTable({ head, rows }: Table) {
  const widths = head.map((cell, index) => Math.max(cell.length, ...rows.map((row) => row[index].length)));
  const line = (row: string[]) => row.map((cell, index) => (index ? cell.padStart(widths[index]) : cell.padEnd(widths[index]))).join("  ");
  return [line(head), ...rows.map(line)].join("\n");
}

function markdownTable({ head, rows }: Table) {
  return [`| ${head.join(" | ")} |`, `|${head.map((_, index) => (index ? "---:" : "---")).join("|")}|`, ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n");
}

export function formatText(summary: Summary, bars: Bar[] | null, cpu: CpuSummary | null) {
  const body = tables(summary, bars, cpu).map(([title, table]) => `${title}\n${textTable(table)}`).join("\n\n");
  return summary.profiles.length || summary.lookalike.length ? `${LEGEND}\n\n${body}` : body;
}

export function formatMarkdown(summary: Summary, bars: Bar[] | null, cpu: CpuSummary | null) {
  const body = tables(summary, bars, cpu).map(([title, table]) => `### ${title}\n\n${markdownTable(table)}`).join("\n\n");
  const legend = LEGEND.split("\n").map((line) => `- ${line}`).join("\n");
  return summary.profiles.length || summary.lookalike.length ? `${legend}\n\n${body}` : body;
}

export const STAGE_ONE_SETS = [...PROFILES.filter((item) => item.group === "everyday").map((item) => item.name), "shake", "sweep", "drift", "unrelated", "lookalike"];

export function stageOneBars(summary: Summary, cpu: CpuSummary | null): Bar[] {
  const bars: Bar[] = summary.profiles.filter((item) => item.group === "everyday").map((item) => ({
    name: `${item.profile}: correct/wrong/err p95/>10px`,
    value: `${percent(item.correct)} / ${percent(item.wrong)} / ${num(item.error?.p95, 2)} / ${item.over10}`,
    limit: ">=97% / <=1% / <=2px / 0",
    pass: item.correct >= 97 && !(item.wrong > 1) && (item.error?.p95 ?? Infinity) <= 2 && item.over10 === 0,
  }));
  const shake = summary.profiles.find((item) => item.profile === "shake");
  bars.push({ name: "shake: correct", value: shake ? percent(shake.correct) : "-", limit: ">=85%", pass: shake ? shake.correct >= 85 : false });
  for (const item of summary.sweep.filter((entry) => entry.bar)) {
    bars.push({ name: `single step ${item.name}`, value: `${item.within1}/${item.trials} within 1px`, limit: "all", pass: item.trials > 0 && item.within1 === item.trials });
  }
  const refusals = summary.unrelated.filter((item) => item.name !== "shifted-noise");
  bars.push({
    name: "unrelated content refused",
    value: `${sum(refusals.map((item) => item.accepted))}/${sum(refusals.map((item) => item.steps))} accepted`,
    limit: "0",
    pass: refusals.length > 0 && refusals.every((item) => item.accepted === 0),
  });
  const drift = summary.drift;
  bars.push({ name: "300-step drift back to start", value: drift ? `${num(drift.finalMax, 2)} px` : "-", limit: "<=0.5px", pass: drift ? drift.finalMax !== null && drift.finalMax <= 0.5 : false });
  // No label is better than a wrong one: a look-alike shelf may hide its labels but must not misplace them.
  for (const item of summary.lookalike) {
    bars.push({
      name: `look-alike ${item.source} ${item.profile}: >10px / wrong`,
      value: `${item.over10} / ${percent(item.wrong)}`,
      limit: "0 / <=1%",
      pass: item.over10 === 0 && !(item.wrong > 1),
    });
  }
  for (const [rate, limit] of [[4, 25], [6, 35]]) {
    const measured = cpu?.sequences.flatMap(({ sequence, rates }) => rates.filter((item) => item.rate === rate).map((item) => ({ sequence, p90: item.p90 })));
    const worst = measured?.length ? measured.reduce((a, b) => (b.p90 > a.p90 ? b : a)) : null;
    bars.push({ name: `step p90 at ${rate}x (worst sequence)`, value: worst ? `${num(worst.p90)} ms (${worst.sequence})` : "-", limit: `<=${limit}ms`, pass: worst ? worst.p90 <= limit : null });
  }
  const delta = cpu?.bundle.deltaGzip;
  bars.push({ name: "worker bundle growth (gzip)", value: delta == null ? "-" : `${delta} B`, limit: "<=4096 B", pass: cpu ? delta != null && delta <= 4096 : null });
  return bars;
}
