import { parentPort, workerData } from "node:worker_threads";
import { loadTracker, runJob, type Job, type World } from "./sim.ts";

const { trackerPath, world } = workerData as { trackerPath: string; world: World };
const tracker = await loadTracker(trackerPath);
const port = parentPort!;

port.on("message", (job: Job) => {
  try {
    port.postMessage({ result: runJob(job, tracker, world) });
  } catch (error) {
    port.postMessage({ error: error instanceof Error ? error.stack ?? error.message : String(error), job });
  }
});
port.postMessage({ ready: true });
