const { PublicKey } = require("@solana/web3.js");
const bs58 = require("bs58");
const nacl = require("tweetnacl");

const bs58Codec = bs58.default || bs58;

function buildQuoteMessage({
  rfqId,
  marketMakerWallet,
  allInPrice,
  guaranteedSize,
  validUntil,
}) {
  return [
    "Umbriq Quote Submission",
    `RFQ: ${rfqId}`,
    `MarketMaker: ${marketMakerWallet}`,
    `AllInPrice: ${allInPrice}`,
    `GuaranteedSize: ${guaranteedSize}`,
    `ValidUntil: ${validUntil}`,
  ].join("\n");
}

function verifyQuoteSignature({
  rfqId,
  marketMakerWallet,
  allInPrice,
  guaranteedSize,
  validUntil,
  signature,
}) {
  try {
    const message = buildQuoteMessage({
      rfqId,
      marketMakerWallet,
      allInPrice,
      guaranteedSize,
      validUntil,
    });
    const publicKey = new PublicKey(marketMakerWallet);
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = bs58Codec.decode(signature);
    return nacl.sign.detached.verify(messageBytes, signatureBytes, publicKey.toBytes());
  } catch {
    return false;
  }
}

module.exports = {
  buildQuoteMessage,
  verifyQuoteSignature,
};
