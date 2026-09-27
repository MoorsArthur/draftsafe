// SPDX-License-Identifier: MIT
// Tiny keyed-record store on top of storage.local. Each STORAGE_KEYS entry
// holds one object map: { [recordKey]: record }.

export function createStore(storageArea) {
  // Serialize read-modify-write cycles so concurrent updates cannot clobber
  // each other (alarm tick vs. popup vs. bridge request).
  let chain = Promise.resolve();

  async function readMap(key) {
    const got = await storageArea.get(key);
    const map = got && got[key];
    return map && typeof map === "object" ? map : {};
  }

  function update(key, mutator) {
    const run = chain.then(async () => {
      const map = await readMap(key);
      const result = await mutator(map);
      await storageArea.set({ [key]: map });
      return result;
    });
    chain = run.catch(() => {});
    return run;
  }

  return {
    readMap,
    update,
    async list(key) {
      return Object.values(await readMap(key));
    },
    async get(key, id) {
      return (await readMap(key))[id] || null;
    },
    put(key, id, record) {
      return update(key, map => {
        map[id] = record;
        return record;
      });
    },
    remove(key, id) {
      return update(key, map => {
        const existed = id in map;
        delete map[id];
        return existed;
      });
    },
  };
}

/** Stable identity for a message across moves and restarts. */
export function recordKey(accountId, headerMessageId) {
  return `${accountId}|${headerMessageId}`;
}
