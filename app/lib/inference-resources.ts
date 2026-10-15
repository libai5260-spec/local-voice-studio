type DisposableTensor = { location?: string; dispose: () => void };
type Cache = Record<string, DisposableTensor>;

// Transformers.js 4.0.0-next.2 Chatterbox drops the final GPU KV cache from
// its generation dictionary. Speaker features are separate and stay reusable.
export function installFinalCacheCleanup(model: {
  getPastKeyValues: (outputs: Cache, previous: Cache | undefined, final?: boolean) => Cache;
}) {
  const original = model.getPastKeyValues.bind(model);
  let retained: Cache = {};
  model.getPastKeyValues = (outputs, previous, final = false) => {
    const cache = original(outputs, previous, final);
    retained = cache;
    if (final) {
      release();
      return {};
    }
    return cache;
  };
  function release() {
    for (const tensor of new Set(Object.values(retained))) {
      if (tensor.location === "gpu-buffer") tensor.dispose();
    }
    retained = {};
  }
  return release;
}
