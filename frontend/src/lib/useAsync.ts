import { useCallback, useEffect, useRef, useState } from "react";

export interface AsyncState<T> {
  data?: T;
  error?: Error;
  loading: boolean;
  reload: () => void;
}

/** deps가 바뀌면 다시 불러오고, 늦게 도착한 이전 응답은 버린다. */
export function useAsync<T>(
  fn: () => Promise<T>,
  deps: unknown[],
): AsyncState<T> {
  const [state, setState] = useState<{
    data?: T;
    error?: Error;
    loading: boolean;
  }>({
    loading: true,
  });
  const [nonce, setNonce] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const id = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    fn().then(
      (data) => id === seq.current && setState({ data, loading: false }),
      (error: Error) =>
        id === seq.current &&
        setState((s) => ({ ...s, error, loading: false })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}
