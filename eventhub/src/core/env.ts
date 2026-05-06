const POSITIVE_INTEGER_PATTERN = /^\d+$/;

export const parsePositiveInteger = (
	value: string | number | undefined,
	fallback: number,
	name: string,
): number => {
	if (value === undefined) {
		return fallback;
	}

	if (typeof value === "string" && !POSITIVE_INTEGER_PATTERN.test(value)) {
		throw new Error(`eventhub: invalid ${name}`);
	}

	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`eventhub: invalid ${name}`);
	}

	return parsed;
};
