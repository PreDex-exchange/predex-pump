import {
  assert,
  beforeEach,
  clearStore,
  describe,
  newMockEvent,
  test,
} from "matchstick-as/assembly/index";
import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";

import {
  MarketClosedOut,
  MarketCreated,
  MarketGraduated,
  MarketParameterSnapshot,
  MarketResolutionObserved,
  MarketTokenBinding,
} from "../generated/Registry/IncubatorRegistry";
import { TradeExecuted } from "../generated/LMSR/IncubatorLMSR";
import { OrderFilled as ExchangeOrderFilled } from "../generated/CTFExchange/CTFExchange";
import {
  OrderFilled as MiniOrderFilled,
  OrderPlaced as MiniOrderPlaced,
} from "../generated/MiniCLOB/MiniCLOB";
import {
  handleExchangeOrderFilled,
  handleLmsrTradeExecuted,
  handleMarketClosedOut,
  handleMarketCreated,
  handleMarketGraduated,
  handleMarketParameterSnapshot,
  handleMarketResolutionObserved,
  handleMarketTokenBinding,
  handleMiniOrderFilled,
  handleMiniOrderPlaced,
} from "../src/mapping";

const MARKET_ID = BigInt.fromI32(7);
const YES_TOKEN_ID = BigInt.fromI32(701);
const NO_TOKEN_ID = BigInt.fromI32(702);
const CONDITION = Bytes.fromHexString(
  "0x1111111111111111111111111111111111111111111111111111111111111111",
);

function address(value: string): Address {
  return Address.fromString(value);
}

function bytes32(value: string): Bytes {
  return Bytes.fromHexString(value);
}

function pushUnsigned(
  parameters: Array<ethereum.EventParam>,
  name: string,
  value: BigInt,
): void {
  parameters.push(
    new ethereum.EventParam(name, ethereum.Value.fromUnsignedBigInt(value)),
  );
}

function marketCreated(): MarketCreated {
  const event = changetype<MarketCreated>(newMockEvent());
  event.parameters = new Array<ethereum.EventParam>();
  event.parameters.push(
    new ethereum.EventParam("marketId", ethereum.Value.fromUnsignedBigInt(MARKET_ID)),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "creator",
      ethereum.Value.fromAddress(address("0x1000000000000000000000000000000000000001")),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam("conditionId", ethereum.Value.fromFixedBytes(CONDITION)),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "questionId",
      ethereum.Value.fromFixedBytes(
        bytes32("0x2222222222222222222222222222222222222222222222222222222222222222"),
      ),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "marketTypeVersion",
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(2)),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "ancillaryDataHash",
      ethereum.Value.fromFixedBytes(
        bytes32("0x3333333333333333333333333333333333333333333333333333333333333333"),
      ),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "ancillaryData",
      ethereum.Value.fromBytes(Bytes.fromUTF8("Will this test pass?")),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "metadataHash",
      ethereum.Value.fromFixedBytes(
        bytes32("0x4444444444444444444444444444444444444444444444444444444444444444"),
      ),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "openedAt",
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1_000)),
    ),
  );
  return event;
}

function parameterSnapshot(): MarketParameterSnapshot {
  const event = changetype<MarketParameterSnapshot>(newMockEvent());
  event.parameters = new Array<ethereum.EventParam>();
  const names = [
    "marketId",
    "openingFeeRaw",
    "seedRaw",
    "seedCapRaw",
    "fCapRaw",
    "protocolFeeBps",
    "depthFeeBps",
    "graduationMoneyInActivityThresholdRaw",
    "graduationTollRaw",
    "minimumTimeOpen",
    "tradingWindowSeconds",
    "tradingEndsAt",
  ];
  for (let index = 0; index < names.length; index++) {
    const value = index == 0
      ? MARKET_ID
      : index == names.length - 1
        ? BigInt.fromI32(9_999)
        : BigInt.fromI32(index);
    event.parameters.push(
      new ethereum.EventParam(names[index], ethereum.Value.fromUnsignedBigInt(value)),
    );
  }
  return event;
}

function tokenBinding(): MarketTokenBinding {
  const event = changetype<MarketTokenBinding>(newMockEvent());
  event.parameters = new Array<ethereum.EventParam>();
  event.parameters.push(
    new ethereum.EventParam("marketId", ethereum.Value.fromUnsignedBigInt(MARKET_ID)),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "collateral",
      ethereum.Value.fromAddress(address("0x3600000000000000000000000000000000000000")),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "collateralDecimals",
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(6)),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "ctf",
      ethereum.Value.fromAddress(address("0x2000000000000000000000000000000000000002")),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "committeeOracleV2",
      ethereum.Value.fromAddress(address("0x3000000000000000000000000000000000000003")),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam("yesTokenId", ethereum.Value.fromUnsignedBigInt(YES_TOKEN_ID)),
  );
  event.parameters.push(
    new ethereum.EventParam("noTokenId", ethereum.Value.fromUnsignedBigInt(NO_TOKEN_ID)),
  );
  return event;
}

function graduated(): MarketGraduated {
  const event = changetype<MarketGraduated>(newMockEvent());
  event.parameters = new Array<ethereum.EventParam>();
  pushUnsigned(event.parameters, "marketId", MARKET_ID);
  event.parameters.push(
    new ethereum.EventParam("conditionId", ethereum.Value.fromFixedBytes(CONDITION)),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "creator",
      ethereum.Value.fromAddress(address("0x1000000000000000000000000000000000000001")),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "questionId",
      ethereum.Value.fromFixedBytes(
        bytes32("0x2222222222222222222222222222222222222222222222222222222222222222"),
      ),
    ),
  );
  pushUnsigned(event.parameters, "activityMoneyInRaw", BigInt.fromI32(100));
  pushUnsigned(event.parameters, "activityThresholdRaw", BigInt.fromI32(100));
  pushUnsigned(event.parameters, "graduationTollRaw", BigInt.fromI32(1));
  pushUnsigned(event.parameters, "openedAt", BigInt.fromI32(1_000));
  pushUnsigned(event.parameters, "graduatedAt", BigInt.fromI32(2_000));
  pushUnsigned(event.parameters, "minimumTimeOpen", BigInt.fromI32(10));
  pushUnsigned(event.parameters, "marketTypeVersion", BigInt.fromI32(2));
  return event;
}

function lmsrTrade(): TradeExecuted {
  const event = changetype<TradeExecuted>(newMockEvent());
  event.parameters = new Array<ethereum.EventParam>();
  pushUnsigned(event.parameters, "marketId", MARKET_ID);
  event.parameters.push(
    new ethereum.EventParam(
      "trader",
      ethereum.Value.fromAddress(address("0x4000000000000000000000000000000000000004")),
    ),
  );
  pushUnsigned(event.parameters, "outcome", BigInt.fromI32(0));
  pushUnsigned(event.parameters, "side", BigInt.fromI32(0));
  event.parameters.push(
    new ethereum.EventParam(
      "recipient",
      ethereum.Value.fromAddress(address("0x4000000000000000000000000000000000000004")),
    ),
  );
  pushUnsigned(event.parameters, "amountRaw", BigInt.fromI32(100_000));
  pushUnsigned(event.parameters, "baseAmountRaw", BigInt.fromI32(55_000));
  pushUnsigned(event.parameters, "protocolFeeRaw", BigInt.fromI32(100));
  pushUnsigned(event.parameters, "depthContributionRaw", BigInt.fromI32(50));
  pushUnsigned(event.parameters, "totalCostRaw", BigInt.fromI32(55_150));
  pushUnsigned(event.parameters, "netProceedsRaw", BigInt.fromI32(0));
  return event;
}

function exchangeFill(): ExchangeOrderFilled {
  const event = changetype<ExchangeOrderFilled>(newMockEvent());
  event.parameters = new Array<ethereum.EventParam>();
  event.parameters.push(
    new ethereum.EventParam(
      "orderHash",
      ethereum.Value.fromFixedBytes(
        bytes32("0x5555555555555555555555555555555555555555555555555555555555555555"),
      ),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "maker",
      ethereum.Value.fromAddress(address("0x5000000000000000000000000000000000000005")),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "taker",
      ethereum.Value.fromAddress(address("0x6000000000000000000000000000000000000006")),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam("tokenId", ethereum.Value.fromUnsignedBigInt(YES_TOKEN_ID)),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "makerAmountFilled",
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(40_000)),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "takerAmountFilled",
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(100_000)),
    ),
  );
  return event;
}

function miniOrderPlaced(): MiniOrderPlaced {
  const event = changetype<MiniOrderPlaced>(newMockEvent());
  event.parameters = new Array<ethereum.EventParam>();
  pushUnsigned(event.parameters, "orderId", BigInt.fromI32(91));
  event.parameters.push(
    new ethereum.EventParam(
      "maker",
      ethereum.Value.fromAddress(address("0x7000000000000000000000000000000000000007")),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam("conditionId", ethereum.Value.fromFixedBytes(CONDITION)),
  );
  pushUnsigned(event.parameters, "tokenId", YES_TOKEN_ID);
  pushUnsigned(event.parameters, "side", BigInt.fromI32(0));
  pushUnsigned(event.parameters, "priceRawPerToken", BigInt.fromI32(600_000));
  pushUnsigned(event.parameters, "sizeRaw", BigInt.fromI32(100_000));
  pushUnsigned(event.parameters, "escrowRaw", BigInt.fromI32(60_000));
  return event;
}

function miniOrderFilled(): MiniOrderFilled {
  const event = changetype<MiniOrderFilled>(newMockEvent());
  event.parameters = new Array<ethereum.EventParam>();
  pushUnsigned(event.parameters, "orderId", BigInt.fromI32(91));
  event.parameters.push(
    new ethereum.EventParam(
      "maker",
      ethereum.Value.fromAddress(address("0x7000000000000000000000000000000000000007")),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "taker",
      ethereum.Value.fromAddress(address("0x8000000000000000000000000000000000000008")),
    ),
  );
  pushUnsigned(event.parameters, "fillSizeRaw", BigInt.fromI32(50_000));
  pushUnsigned(event.parameters, "paymentRaw", BigInt.fromI32(30_000));
  pushUnsigned(event.parameters, "filledRawAfter", BigInt.fromI32(50_000));
  event.parameters.push(
    new ethereum.EventParam("openAfter", ethereum.Value.fromBoolean(true)),
  );
  return event;
}

function resolutionObserved(): MarketResolutionObserved {
  const event = changetype<MarketResolutionObserved>(newMockEvent());
  event.parameters = new Array<ethereum.EventParam>();
  pushUnsigned(event.parameters, "marketId", MARKET_ID);
  pushUnsigned(event.parameters, "observedAt", BigInt.fromI32(3_000));
  return event;
}

function marketClosedOut(): MarketClosedOut {
  const event = changetype<MarketClosedOut>(newMockEvent());
  event.parameters = new Array<ethereum.EventParam>();
  pushUnsigned(event.parameters, "marketId", MARKET_ID);
  pushUnsigned(event.parameters, "closedOutAt", BigInt.fromI32(4_000));
  return event;
}

describe("Predex discovery mappings", () => {
  beforeEach(() => {
    clearStore();
  });

  test("indexes lifecycle, deadline, and an LMSR trade", () => {
    handleMarketCreated(marketCreated());
    handleMarketParameterSnapshot(parameterSnapshot());
    handleMarketGraduated(graduated());
    handleLmsrTradeExecuted(lmsrTrade());

    assert.fieldEquals("Market", "7", "phase", "GRADUATED");
    assert.fieldEquals("Market", "7", "tradingEndsAt", "9999");
    assert.fieldEquals("Market", "7", "tradeEventCount", "1");
    assert.fieldEquals("Market", "7", "lastTradeVenue", "LMSR");
    assert.entityCount("Trade", 1);
  });

  test("attributes an exchange fill without inventing its side", () => {
    handleMarketCreated(marketCreated());
    handleMarketTokenBinding(tokenBinding());
    const fill = exchangeFill();
    handleExchangeOrderFilled(fill);

    const id = fill.transaction.hash.toHexString() + "-" + fill.logIndex.toString();
    assert.fieldEquals("Trade", id, "market", "7");
    assert.fieldEquals("Trade", id, "outcome", "YES");
    assert.fieldEquals("Trade", id, "venue", "CTF_EXCHANGE");
    assert.fieldEquals("Trade", id, "makerAmountFilledRaw", "40000");
    assert.fieldEquals("Trade", id, "takerAmountFilledRaw", "100000");
  });

  test("attributes a MiniCLOB fill through its condition and order reference", () => {
    handleMarketCreated(marketCreated());
    handleMarketTokenBinding(tokenBinding());
    handleMiniOrderPlaced(miniOrderPlaced());
    const fill = miniOrderFilled();
    handleMiniOrderFilled(fill);

    const id = fill.transaction.hash.toHexString() + "-" + fill.logIndex.toString();
    assert.fieldEquals("MiniOrderRef", "91", "market", "7");
    assert.fieldEquals("MiniOrderRef", "91", "outcome", "YES");
    assert.fieldEquals("Trade", id, "market", "7");
    assert.fieldEquals("Trade", id, "venue", "MINI_CLOB");
    assert.fieldEquals("Trade", id, "side", "ASK");
    assert.fieldEquals("Trade", id, "amountRaw", "50000");
    assert.fieldEquals("Trade", id, "paymentRaw", "30000");
  });

  test("advances resolved markets to the terminal closed phase", () => {
    handleMarketCreated(marketCreated());
    handleMarketResolutionObserved(resolutionObserved());
    assert.fieldEquals("Market", "7", "phase", "RESOLVED");
    assert.fieldEquals("Market", "7", "resolvedAt", "3000");

    handleMarketClosedOut(marketClosedOut());
    assert.fieldEquals("Market", "7", "phase", "CLOSED");
    assert.fieldEquals("Market", "7", "closedOutAt", "4000");
  });
});
