import bs58 from 'bs58';

export async function sha256Bs58(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  return bs58.encode(hashArray);
}
