export type QuoteMessageInput = {
  rfqId: string;
  marketMakerWallet: string;
  allInPrice: string;
  guaranteedSize: string;
  validUntil: string;
};

export function buildQuoteMessage(input: QuoteMessageInput): string {
  return [
    "Umbriq Quote Submission",
    `RFQ: ${input.rfqId}`,
    `MarketMaker: ${input.marketMakerWallet}`,
    `AllInPrice: ${input.allInPrice}`,
    `GuaranteedSize: ${input.guaranteedSize}`,
    `ValidUntil: ${input.validUntil}`,
  ].join("\n");
}
