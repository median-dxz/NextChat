let sequence = 0;

export function nanoid(size = 21) {
  const value = `test-${(sequence++).toString(36)}`;
  return value.padEnd(size, "0").slice(0, size);
}
