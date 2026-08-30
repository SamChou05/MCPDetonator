/** Freeze a schema-validated JSON artifact so callers cannot mutate it by alias. */
export function deepFreezeJson<T>(value: T): Readonly<T> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) deepFreezeJson(item);
  } else {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreezeJson(child);
    }
  }
  return Object.freeze(value);
}
