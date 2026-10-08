import { useMemo } from 'react'

/** `value`, or the one before while it's equal by value (as JSON): for lists rebuilt with the same contents. */
export function useByValue<T>(value: T): T {
  const key = JSON.stringify(value)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for `value`
  return useMemo(() => value, [key])
}
