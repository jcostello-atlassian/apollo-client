import { Trie } from "@wry/trie";

import type {
  ApolloClient,
  ObservableQuery,
  OperationVariables,
} from "@apollo/client";

import type { CacheKey } from "./types.js";

const AUTO_DISPOSE_TIMEOUT_MS = 30_000;

export type SharedObservableQueryKey = object;

export class SharedObservableQueryRef {
  public readonly key: SharedObservableQueryKey = {};
  public readonly observable: ObservableQuery<unknown, OperationVariables>;

  private references = 0;
  private disposed = false;
  private onDispose: () => void;
  private autoDisposeTimer: ReturnType<typeof setTimeout> | null;

  constructor(
    observable: ObservableQuery<unknown, OperationVariables>,
    options: { onDispose: () => void }
  ) {
    this.observable = observable;
    this.onDispose = options.onDispose;

    // Start a timer that will automatically dispose of the query if the
    // suspended resource does not use this queryRef in the given time. This
    // helps prevent memory leaks when a component has unmounted before the
    // query has finished loading.
    this.autoDisposeTimer = setTimeout(() => {
      this.autoDisposeTimer = null;
      if (!this.references && !this.disposed) {
        this.dispose();
      }
    }, AUTO_DISPOSE_TIMEOUT_MS);
  }

  retain(): () => void {
    this.references++;
    let released = false;

    // Cancel the auto-dispose safety timer once a real consumer takes hold.
    if (this.autoDisposeTimer !== null) {
      clearTimeout(this.autoDisposeTimer);
      this.autoDisposeTimer = null;
    }

    return () => {
      if (released) return;
      released = true;
      this.references--;

      setTimeout(() => {
        if (!this.references && !this.disposed) {
          this.dispose();
        }
      });
    };
  }

  private dispose() {
    this.disposed = true;
    if (this.autoDisposeTimer !== null) {
      clearTimeout(this.autoDisposeTimer);
      this.autoDisposeTimer = null;
    }
    this.onDispose();
    this.observable.stop();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}

export class SharedObservableQueryCache {
  private refs = new Trie<{ current?: SharedObservableQueryRef }>();

  getRef<
    TData = unknown,
    TVariables extends OperationVariables = OperationVariables,
  >(
    cacheKey: CacheKey,
    createObservable: () => ObservableQuery<TData, TVariables>
  ): SharedObservableQueryRef & {
    observable: ObservableQuery<TData, TVariables>;
  } {
    const ref = this.refs.lookupArray(cacheKey);

    if (!ref.current) {
      ref.current = new SharedObservableQueryRef(
        createObservable() as ObservableQuery<unknown, OperationVariables>,
        {
          onDispose: () => {
            this.refs.removeArray(cacheKey);
            delete ref.current;
          },
        }
      );
    }

    return ref.current as SharedObservableQueryRef & {
      observable: ObservableQuery<TData, TVariables>;
    };
  }
}

const sharedObservableQueryCacheSymbol = Symbol.for(
  "apollo.sharedObservableQueryCache"
);

export function getSharedObservableQueryCache(
  client: ApolloClient & {
    [sharedObservableQueryCacheSymbol]?: SharedObservableQueryCache;
  }
): SharedObservableQueryCache {
  if (!client[sharedObservableQueryCacheSymbol]) {
    client[sharedObservableQueryCacheSymbol] = new SharedObservableQueryCache();
  }
  return client[sharedObservableQueryCacheSymbol];
}
