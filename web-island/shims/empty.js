// Browser build: Crossmint's signer only reaches for node's crypto when there is no window.crypto.
export default {}; export const webcrypto = globalThis.crypto;
