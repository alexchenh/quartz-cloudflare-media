export function validObjectKey(key: string): boolean {
  return (
    /^v[\w.-]+\/[a-f0-9]{64}\/[a-z0-9][a-z0-9._-]*$/i.test(key) &&
    !key.includes("..")
  );
}
