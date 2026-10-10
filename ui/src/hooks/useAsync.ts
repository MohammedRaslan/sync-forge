import { DependencyList, useCallback, useEffect, useRef, useState } from 'react';

interface AsyncState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
}

/** Loads data when dependencies change. Responses to stale requests are ignored. */
export function useAsync<T>(load: () => Promise<T>, deps: DependencyList) {
  const [state, setState] = useState<AsyncState<T>>({ data: undefined, error: undefined, loading: true });
  const requestId = useRef(0);

  const reload = useCallback(async () => {
    const id = ++requestId.current;
    setState((previous) => ({ ...previous, loading: true, error: undefined }));
    try {
      const data = await load();
      if (id === requestId.current) setState({ data, error: undefined, loading: false });
    } catch (error) {
      if (id === requestId.current) setState((previous) => ({ ...previous, error: error as Error, loading: false }));
    }
  }, deps);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setData = useCallback((data: T) => setState({ data, error: undefined, loading: false }), []);
  return { ...state, reload, setData };
}
