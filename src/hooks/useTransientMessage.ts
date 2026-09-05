import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

export function useTransientMessage(
  initialValue = "",
  timeoutMs = 4_000,
): [string, Dispatch<SetStateAction<string>>] {
  const [message, setMessage] = useState(initialValue);

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(""), timeoutMs);
    return () => window.clearTimeout(timer);
  }, [message, timeoutMs]);

  return [message, setMessage];
}
