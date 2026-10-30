import { describe, expect, test } from "bun:test";

import { fenceHostWrites, HostLifetime, sharedStore } from "../src/host/gone";

const TICK = Symbol("tick");

/** A store with the shapes the helper has to carry: methods, private state behind an accessor, a counter, a symbol. */
class Store {
  #secret = 7;
  reads = 0;
  readonly written: string[] = [];

  read(): string {
    return "read";
  }

  write(value: string): string {
    this.written.push(value);
    return value;
  }

  whoAmI(): Store {
    return this;
  }

  get secret(): number {
    return this.#secret;
  }

  set secret(value: number) {
    this.#secret = value;
  }

  get counted(): number {
    this.reads += 1;
    return this.reads;
  }

  [TICK](): string {
    return `tick ${this.#secret}`;
  }
}

class Derived extends Store {
  override write(value: string): string {
    return super.write(`derived ${value}`);
  }

  extra(): string {
    return "extra";
  }
}

describe("a host's fenced view of a shared store", () => {
  test("a guarded method works while the registration lives and refuses with host_gone once it is retired", () => {
    const store = new Store();
    const lifetime = new HostLifetime("edge");
    const view = fenceHostWrites(store, lifetime, ["write"]);

    expect(lifetime.retired).toBe(false);
    expect(view.write("one")).toBe("one");
    lifetime.retire();
    expect(lifetime.retired).toBe(true);
    expect(() => view.write("two")).toThrow(expect.objectContaining({ key: "host_gone" }));
    expect(store.written).toEqual(["one"]);
  });

  test("a method that is not named stays available after retirement, and runs on the store", () => {
    const store = new Store();
    const lifetime = new HostLifetime("edge");
    const view = fenceHostWrites(store, lifetime, ["write"]);
    lifetime.retire();

    expect(view.read()).toBe("read");
    expect(view.whoAmI()).toBe(store);
  });

  test("a registration's fence does not touch another registration's view of the same store", () => {
    const store = new Store();
    const gone = new HostLifetime("edge");
    const live = new HostLifetime("edge");
    const stale = fenceHostWrites(store, gone, ["write"]);
    const fresh = fenceHostWrites(store, live, ["write"]);
    gone.retire();

    expect(() => stale.write("late")).toThrow();
    expect(fresh.write("now")).toBe("now");
    expect(store.written).toEqual(["now"]);
  });

  test("a stub put on the shared store after the view was made is the one that runs", () => {
    const store = new Store();
    const view = fenceHostWrites(store, new HostLifetime("edge"), ["write"]);
    const calls: string[] = [];
    store.write = (value: string) => {
      calls.push(value);
      return "stubbed";
    };
    store.read = () => "stubbed read";

    expect(view.write("a")).toBe("stubbed");
    expect(view.read()).toBe("stubbed read");
    expect(calls).toEqual(["a"]);
  });

  test("a stub put on the view stays on the view", () => {
    const store = new Store();
    const lifetime = new HostLifetime("edge");
    const mine = fenceHostWrites(store, lifetime, ["write"]);
    const other = fenceHostWrites(store, lifetime, ["write"]);
    mine.read = () => "mine";

    expect(mine.read()).toBe("mine");
    expect(other.read()).toBe("read");
    expect(store.read()).toBe("read");
  });

  test("an accessor, a private field behind it and a symbol-keyed method run on the store", () => {
    const store = new Store();
    const view = fenceHostWrites(store, new HostLifetime("edge"), ["write"]);

    expect(view.secret).toBe(7);
    view.secret = 9;
    expect(store.secret).toBe(9);
    expect(view.counted).toBe(1);
    expect(view.counted).toBe(2);
    expect(store.reads).toBe(2);
    expect(view[TICK]()).toBe("tick 9");
  });

  test("methods from the whole prototype chain are carried, and an override is the one called", () => {
    const store = new Derived();
    const lifetime = new HostLifetime("edge");
    const view = fenceHostWrites(store, lifetime, ["write"]);

    expect(view.extra()).toBe("extra");
    expect(view.write("x")).toBe("derived x");
    lifetime.retire();
    expect(() => view.write("y")).toThrow();
    expect(store.written).toEqual(["derived x"]);
  });

  test("sharedStore gives the store behind any view of it, and a store that is no view gives itself", () => {
    const store = new Store();
    const one = fenceHostWrites(store, new HostLifetime("edge"), ["write"]);
    const two = fenceHostWrites(store, new HostLifetime("edge"), ["write"]);

    expect(one).not.toBe(two);
    expect(sharedStore(one)).toBe(store);
    expect(sharedStore(two)).toBe(store);
    expect(sharedStore(store)).toBe(store);
  });
});
