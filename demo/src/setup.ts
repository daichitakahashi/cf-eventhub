export const DEFAULT_SETUP_COUNT = 3;
export const MAX_SETUP_COUNT = 1_000;

export const parseSetupCount = (
  searchParams: URLSearchParams,
): number | null => {
  const raw = searchParams.get("count");
  if (raw === null) return DEFAULT_SETUP_COUNT;
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const count = Number(raw);
  return Number.isSafeInteger(count) && count <= MAX_SETUP_COUNT ? count : null;
};

export const createSetupNames = (count: number): string[] => {
  const names = ["default"];
  const seen = new Set(names);
  while (names.length < count) {
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    const suffix = Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const name = `tenant:${suffix}`;
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
};
