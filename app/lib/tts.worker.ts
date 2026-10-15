// Some development-time browser modules expect a `window` global. A module
// worker has the same event APIs on `self`, so expose a compatible alias before
// loading the inference bundle. Top-level await keeps incoming messages queued
// until the real worker listener is ready.
const workerGlobal = globalThis as unknown as Record<string, unknown>;
const workerEvents = globalThis as unknown as {
  addEventListener: (type: "message", listener: (event: MessageEvent) => void) => void;
  removeEventListener: (type: "message", listener: (event: MessageEvent) => void) => void;
  dispatchEvent: (event: Event) => boolean;
};
const queuedMessages: unknown[] = [];
const queueMessage = (event: MessageEvent) => {
  queuedMessages.push(event.data);
};

workerGlobal.window ??= globalThis;
// Dynamic module evaluation yields to the worker event loop. Queue requests
// that arrive before the inference listener is registered, then replay them.
workerEvents.addEventListener("message", queueMessage);

await import("./tts.worker.impl");

workerEvents.removeEventListener("message", queueMessage);
for (const data of queuedMessages) {
  workerEvents.dispatchEvent(new MessageEvent("message", { data }));
}

export {};
