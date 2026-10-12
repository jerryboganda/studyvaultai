import { useEffect, useState } from 'react';

/** The device clock, read again every `ms`: for text that says "until" or "next" and must not go stale. */
export function useNow(ms = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
