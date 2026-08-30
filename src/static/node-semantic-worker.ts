import { parentPort, workerData } from "node:worker_threads";

import {
  analyzeNodeSemanticSources,
  type NodeSemanticEngineInput,
} from "./node-semantic-engine.js";

if (parentPort === null) {
  throw new Error("the Node semantic worker requires a parent port");
}

try {
  parentPort.postMessage({
    status: "completed",
    analysis: analyzeNodeSemanticSources(workerData as NodeSemanticEngineInput),
  });
} catch (error) {
  parentPort.postMessage({
    status: "failed",
    message: (error instanceof Error ? error.message : String(error)).slice(0, 512),
  });
}
