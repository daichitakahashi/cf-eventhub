const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
// ULID uses 10 Crockford Base32 chars to encode its 48-bit millisecond timestamp.
const TIME_LENGTH = 10;
// ULID uses 16 Crockford Base32 chars for the 80-bit randomness component.
const RANDOM_LENGTH = 16;
// Reject timestamps outside the ULID 48-bit range so the encoded prefix stays canonical.
const MAX_ULID_TIMESTAMP = 2 ** 48 - 1;

const encodeBase32 = (value: bigint, length: number): string => {
	let current = value;
	const chars = Array<string>(length);

	for (let i = length - 1; i >= 0; i -= 1) {
		chars[i] = ENCODING[Number(current & 31n)] ?? "";
		current >>= 5n;
	}

	return chars.join("");
};

const randomBytes = () => {
	const bytes = new Uint8Array(RANDOM_LENGTH);
	crypto.getRandomValues(bytes);
	for (let i = 0; i < bytes.length; i += 1) {
		bytes[i] &= 31;
	}
	return bytes;
};

const incrementRandom = (value: Uint8Array) => {
	const next = value.slice();

	for (let i = next.length - 1; i >= 0; i -= 1) {
		if (next[i] !== 31) {
			next[i] += 1;
			return next;
		}
		next[i] = 0;
	}

	throw new Error("cf-eventhub-v1: monotonic ULID overflow");
};

const encodeRandom = (value: Uint8Array): string =>
	Array.from(value, (index) => ENCODING[index] ?? "").join("");

export class MonotonicUlidGenerator {
	private lastTime = -1;
	private lastRandom = new Uint8Array(RANDOM_LENGTH);

	generate(now = Date.now()): string {
		if (!Number.isInteger(now) || now < 0 || now > MAX_ULID_TIMESTAMP) {
			throw new Error("cf-eventhub-v1: invalid ULID timestamp");
		}

		const timestamp = now > this.lastTime ? now : this.lastTime;

		if (now > this.lastTime) {
			this.lastTime = now;
			this.lastRandom = randomBytes();
		} else {
			this.lastRandom = incrementRandom(this.lastRandom);
		}

		return `${encodeBase32(BigInt(timestamp), TIME_LENGTH)}${encodeRandom(this.lastRandom)}`;
	}
}

export const ULID_LENGTH = TIME_LENGTH + RANDOM_LENGTH;
