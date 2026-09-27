// Wraps a fake `messenger` API in a Proxy that records every API member that
// is read (as a dotted path, e.g. "messages.saveMessage") and every call.
// Lets tests assert "this code only ever touches these APIs".

export interface Recording {
  api: any;
  touched: Set<string>;
  called: string[];
}

export function recordApi(target: any): Recording {
  const touched = new Set<string>();
  const called: string[] = [];
  const cache = new WeakMap<object, any>();

  function wrap(obj: any, path: string): any {
    if (obj === null || (typeof obj !== "object" && typeof obj !== "function")) return obj;
    if (cache.has(obj)) return cache.get(obj);
    const proxy = new Proxy(obj, {
      get(t, prop, receiver) {
        const value = Reflect.get(t, prop, receiver);
        if (typeof prop === "symbol" || prop === "then") return value;
        const full = path ? `${path}.${String(prop)}` : String(prop);
        // Leaf lookups only: functions, and members that do not exist
        // (feature detection). Namespace objects are not recorded.
        if (typeof value === "function" || value === undefined) touched.add(full);
        if (typeof value === "function") {
          // Keep vi.fn() spies intact; record the call, call with the right `this`.
          return new Proxy(value, {
            apply(fn, _this, args) {
              called.push(full);
              return Reflect.apply(fn, t, args);
            },
            get(fn, p2) {
              return Reflect.get(fn, p2);
            },
          });
        }
        if (value && typeof value === "object" && !(value instanceof Date) && !Array.isArray(value)) {
          return wrap(value, full);
        }
        return value;
      },
    });
    cache.set(obj, proxy);
    return proxy;
  }

  return { api: wrap(target, ""), touched, called };
}
