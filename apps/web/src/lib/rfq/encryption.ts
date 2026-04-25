const STORAGE_KEY = "umbriq.rfq.encryption_key.v1";

export type EncryptedRfqPayload = {
  version: "1";
  algorithm: "AES-GCM";
  keyId: "local-v1";
  iv: string;
  ciphertext: string;
};

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function getOrCreateLocalKeyBytes(): Uint8Array {
  if (typeof window === "undefined") {
    throw new Error("RFQ encryption is only available in browser context");
  }

  const existing = window.localStorage.getItem(STORAGE_KEY);
  if (existing) {
    return base64ToBytes(existing);
  }

  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  window.localStorage.setItem(STORAGE_KEY, bytesToBase64(keyBytes));
  return keyBytes;
}

export async function encryptRfqPayload(
  payload: Record<string, unknown>
): Promise<EncryptedRfqPayload> {
  const keyBytes = getOrCreateLocalKeyBytes();
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(keyBytes),
    {
      name: "AES-GCM",
    },
    false,
    ["encrypt"]
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
    },
    key,
    toArrayBuffer(encoded)
  );

  return {
    version: "1",
    algorithm: "AES-GCM",
    keyId: "local-v1",
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}
