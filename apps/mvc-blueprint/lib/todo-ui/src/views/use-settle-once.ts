import { useCallback, useRef } from "react";

/**
 * A view answers its command ONCE. The bus already ignores a second settle,
 * but a view's contract should not lean on that: Radix, for one, closes an
 * alert dialog after its Action's own `onClick`, so a dialog that also treats
 * "closed" as "cancelled" would answer yes and then no.
 */
export function useSettleOnce<R>(settle: (result: R) => void): (result: R) => void {
  const answered = useRef(false);
  return useCallback(
    (result: R) => {
      if (answered.current) return;
      answered.current = true;
      settle(result);
    },
    [settle],
  );
}
