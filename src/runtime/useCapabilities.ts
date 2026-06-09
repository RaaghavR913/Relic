import { useEffect, useState } from 'react';
import { getCapabilities, type Capabilities } from './capabilities';

export function useCapabilities() {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let alive = true;
    getCapabilities()
      .then((c) => alive && setCaps(c))
      .catch((e) => alive && setError(e instanceof Error ? e : new Error(String(e))));
    return () => {
      alive = false;
    };
  }, []);

  const refresh = () => getCapabilities(true).then(setCaps);

  return { caps, error, refresh };
}
