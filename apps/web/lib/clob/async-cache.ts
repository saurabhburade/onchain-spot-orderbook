export type AsyncCache<Key, Value> = {
  get: (key: Key, load: () => Promise<Value>) => Promise<Value>;
  delete: (key: Key) => boolean;
  clear: () => void;
};

export type RequestCoalescer<Key, Value> = {
  run: (key: Key, load: () => Promise<Value>) => Promise<Value>;
};

export function createAsyncCache<Key, Value>(): AsyncCache<Key, Value> {
  const entries = new Map<Key, Promise<Value>>();

  return {
    get(key, load) {
      const existing = entries.get(key);
      if (existing) return existing;

      const request = load().catch((error) => {
        entries.delete(key);
        throw error;
      });
      entries.set(key, request);
      return request;
    },
    delete(key) {
      return entries.delete(key);
    },
    clear() {
      entries.clear();
    },
  };
}

/** Shares an in-flight mutable read without caching its settled value. */
export function createRequestCoalescer<Key, Value>(): RequestCoalescer<Key, Value> {
  const requests = new Map<Key, Promise<Value>>();

  return {
    run(key, load) {
      const existing = requests.get(key);
      if (existing) return existing;

      const request = Promise.resolve().then(load);
      requests.set(key, request);
      const cleanup = () => {
        if (requests.get(key) === request) requests.delete(key);
      };
      void request.then(cleanup, cleanup);
      return request;
    },
  };
}
