import { BigInt, ethereum, log } from "@graphprotocol/graph-ts";

import {
  MarketClosedOut,
  MarketCreated,
  MarketGraduated,
  MarketParameterSnapshot,
  MarketResolutionObserved,
  MarketTokenBinding,
} from "../generated/Registry/IncubatorRegistry";
import { TradeExecuted as LmsrTradeExecuted } from "../generated/LMSR/IncubatorLMSR";
import {
  OrderFilled as MiniOrderFilled,
  OrderPlaced as MiniOrderPlaced,
} from "../generated/MiniCLOB/MiniCLOB";
import { OrderFilled as ExchangeOrderFilled } from "../generated/CTFExchange/CTFExchange";
import {
  Market,
  MarketLookup,
  MiniOrderRef,
  Trade,
} from "../generated/schema";

const ZERO = BigInt.fromI32(0);

function eventId(event: ethereum.Event): string {
  return event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
}

function conditionLookupId(conditionId: string): string {
  return "condition:" + conditionId.toLowerCase();
}

function tokenLookupId(tokenId: BigInt): string {
  return "token:" + tokenId.toString();
}

function getOrCreateMarket(marketId: BigInt): Market {
  const id = marketId.toString();
  let market = Market.load(id);
  if (market == null) {
    market = new Market(id);
    market.phase = "UNKNOWN";
    market.tradeEventCount = ZERO;
  }
  return market;
}

function saveLookup(
  id: string,
  kind: string,
  marketId: string,
  outcome: string | null = null,
): void {
  const lookup = new MarketLookup(id);
  lookup.kind = kind;
  lookup.market = marketId;
  if (outcome != null) lookup.outcome = outcome;
  lookup.save();
}

function marketIdForLookup(id: string, context: string): string | null {
  const lookup = MarketLookup.load(id);
  if (lookup == null) {
    log.warning("Skipping {} because lookup {} is unavailable", [context, id]);
    return null;
  }
  return lookup.market;
}

function outcomeForToken(tokenId: BigInt): string | null {
  const lookup = MarketLookup.load(tokenLookupId(tokenId));
  return lookup == null ? null : lookup.outcome;
}

function touchTrade(
  market: Market,
  venue: string,
  event: ethereum.Event,
): void {
  market.tradeEventCount = market.tradeEventCount.plus(BigInt.fromI32(1));
  market.lastTradeAt = event.block.timestamp;
  market.lastTradeBlock = event.block.number;
  market.lastTradeTransaction = event.transaction.hash;
  market.lastTradeVenue = venue;
  market.save();
}

function initializeTrade(
  marketId: string,
  venue: string,
  event: ethereum.Event,
): Trade {
  const trade = new Trade(eventId(event));
  trade.market = marketId;
  trade.venue = venue;
  trade.transactionHash = event.transaction.hash;
  trade.blockNumber = event.block.number;
  trade.logIndex = event.logIndex;
  trade.timestamp = event.block.timestamp;
  return trade;
}

export function handleMarketCreated(event: MarketCreated): void {
  const market = getOrCreateMarket(event.params.marketId);
  market.creator = event.params.creator;
  market.conditionId = event.params.conditionId;
  market.questionId = event.params.questionId;
  market.ancillaryDataHash = event.params.ancillaryDataHash;
  market.metadataHash = event.params.metadataHash;
  market.marketTypeVersion = event.params.marketTypeVersion;
  market.phase = "OPENED";
  market.openedAt = event.params.openedAt;
  market.save();

  saveLookup(
    conditionLookupId(event.params.conditionId.toHexString()),
    "CONDITION",
    market.id,
  );
}

export function handleMarketParameterSnapshot(
  event: MarketParameterSnapshot,
): void {
  const market = getOrCreateMarket(event.params.marketId);
  market.tradingEndsAt = event.params.tradingEndsAt;
  market.save();
}

export function handleMarketTokenBinding(event: MarketTokenBinding): void {
  const market = getOrCreateMarket(event.params.marketId);
  market.save();
  saveLookup(tokenLookupId(event.params.yesTokenId), "YES_TOKEN", market.id, "YES");
  saveLookup(tokenLookupId(event.params.noTokenId), "NO_TOKEN", market.id, "NO");
}

export function handleMarketGraduated(event: MarketGraduated): void {
  const market = getOrCreateMarket(event.params.marketId);
  market.phase = "GRADUATED";
  market.graduatedAt = event.params.graduatedAt;
  market.save();
}

export function handleMarketResolutionObserved(
  event: MarketResolutionObserved,
): void {
  const market = getOrCreateMarket(event.params.marketId);
  market.phase = "RESOLVED";
  market.resolvedAt = event.params.observedAt;
  market.save();
}

export function handleMarketClosedOut(event: MarketClosedOut): void {
  const market = getOrCreateMarket(event.params.marketId);
  market.phase = "CLOSED";
  market.closedOutAt = event.params.closedOutAt;
  market.save();
}

export function handleLmsrTradeExecuted(event: LmsrTradeExecuted): void {
  const market = getOrCreateMarket(event.params.marketId);
  const trade = initializeTrade(market.id, "LMSR", event);
  trade.outcome = event.params.outcome == 0 ? "YES" : "NO";
  trade.actor = event.params.trader;
  trade.recipient = event.params.recipient;
  trade.side = event.params.side == 0 ? "BID" : "ASK";
  trade.amountRaw = event.params.amountRaw;
  trade.baseAmountRaw = event.params.baseAmountRaw;
  trade.protocolFeeRaw = event.params.protocolFeeRaw;
  trade.depthContributionRaw = event.params.depthContributionRaw;
  trade.totalCostRaw = event.params.totalCostRaw;
  trade.netProceedsRaw = event.params.netProceedsRaw;
  trade.save();
  touchTrade(market, "LMSR", event);
}

export function handleMiniOrderPlaced(event: MiniOrderPlaced): void {
  const marketId = marketIdForLookup(
    conditionLookupId(event.params.conditionId.toHexString()),
    "MiniCLOB order " + event.params.orderId.toString(),
  );
  if (marketId == null) return;

  const order = new MiniOrderRef(event.params.orderId.toString());
  order.market = marketId!;
  order.tokenId = event.params.tokenId;
  const outcome = outcomeForToken(event.params.tokenId);
  if (outcome != null) order.outcome = outcome;
  order.maker = event.params.maker;
  order.makerSide = event.params.side == 0 ? "BID" : "ASK";
  order.limitPriceRaw = event.params.priceRawPerToken;
  order.originalSizeRaw = event.params.sizeRaw;
  order.transactionHash = event.transaction.hash;
  order.blockNumber = event.block.number;
  order.logIndex = event.logIndex;
  order.timestamp = event.block.timestamp;
  order.save();
}

export function handleMiniOrderFilled(event: MiniOrderFilled): void {
  const order = MiniOrderRef.load(event.params.orderId.toString());
  if (order == null) {
    log.warning("Skipping MiniCLOB fill for unknown order {}", [
      event.params.orderId.toString(),
    ]);
    return;
  }
  const market = Market.load(order.market);
  if (market == null) {
    log.warning("Skipping MiniCLOB fill for missing market {}", [order.market]);
    return;
  }

  const trade = initializeTrade(market.id, "MINI_CLOB", event);
  if (order.outcome != null) trade.outcome = order.outcome;
  trade.actor = event.params.taker;
  trade.maker = event.params.maker;
  trade.taker = event.params.taker;
  trade.side = order.makerSide == "BID" ? "ASK" : "BID";
  trade.miniOrder = order.id;
  trade.tokenId = order.tokenId;
  trade.amountRaw = event.params.fillSizeRaw;
  trade.paymentRaw = event.params.paymentRaw;
  trade.save();
  touchTrade(market, "MINI_CLOB", event);
}

export function handleExchangeOrderFilled(event: ExchangeOrderFilled): void {
  const lookup = MarketLookup.load(tokenLookupId(event.params.tokenId));
  if (lookup == null) {
    log.warning("Skipping CTFExchange fill for unknown token {}", [
      event.params.tokenId.toString(),
    ]);
    return;
  }
  const market = Market.load(lookup.market);
  if (market == null) {
    log.warning("Skipping CTFExchange fill for missing market {}", [lookup.market]);
    return;
  }

  const trade = initializeTrade(market.id, "CTF_EXCHANGE", event);
  if (lookup.outcome != null) trade.outcome = lookup.outcome;
  trade.maker = event.params.maker;
  trade.taker = event.params.taker;
  trade.exchangeOrderHash = event.params.orderHash;
  trade.tokenId = event.params.tokenId;
  // OrderFilled does not emit the signed side. Preserve both raw amounts rather
  // than guessing which one is position size or collateral notional.
  trade.makerAmountFilledRaw = event.params.makerAmountFilled;
  trade.takerAmountFilledRaw = event.params.takerAmountFilled;
  trade.save();
  touchTrade(market, "CTF_EXCHANGE", event);
}
