export {
  loadManualFixtureInputs,
  type ManualFixtureInputs,
} from "../../src/audit/v2/manual-fixture.js";

export function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
