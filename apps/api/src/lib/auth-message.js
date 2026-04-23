function buildAuthMessage(walletAddress, nonce) {
  return `Umbriq Authentication\nWallet: ${walletAddress}\nNonce: ${nonce}`;
}

module.exports = {
  buildAuthMessage,
};
