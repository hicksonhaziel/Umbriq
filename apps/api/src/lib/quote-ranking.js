function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function rankQuotes(quotes, rfqSide) {
  const sorted = [...quotes].sort((left, right) => {
    const leftPrice = toNumber(left.allInPrice);
    const rightPrice = toNumber(right.allInPrice);

    if (rfqSide === "buy") {
      if (leftPrice !== rightPrice) {
        return leftPrice - rightPrice;
      }
    } else {
      if (leftPrice !== rightPrice) {
        return rightPrice - leftPrice;
      }
    }

    const leftSize = toNumber(left.guaranteedSize);
    const rightSize = toNumber(right.guaranteedSize);
    if (leftSize !== rightSize) {
      return rightSize - leftSize;
    }

    const leftCreatedAt = Date.parse(left.createdAt);
    const rightCreatedAt = Date.parse(right.createdAt);
    return leftCreatedAt - rightCreatedAt;
  });

  return sorted.map((quote, index) => ({
    ...quote,
    rank: index + 1,
  }));
}

module.exports = {
  rankQuotes,
};
