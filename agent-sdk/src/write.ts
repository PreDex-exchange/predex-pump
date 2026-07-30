import { ARC } from '@predex-pump/shared';
import {
  buildBuyTx,
  buildClaimFundingResidualTx,
  buildCloseoutTx,
  buildCommitteeResolveTx,
  buildCreateMarketTx,
  buildCtfApprovalForAllTx,
  buildErc20ApprovalTx,
  buildGraduateIfQualifiedTx,
  buildMiniClobCancelTx,
  buildMiniClobFillTx,
  buildMiniClobPlaceTx,
  buildObserveResolutionTx,
  buildRedeemTx,
  buildSellTx,
  buildSweepProtocolAfterCloseoutTx,
  type BuyTxInput,
  type CommitteeResolveTxInput,
  type CreateMarketTxInput,
  type CtfApprovalForAllTxInput,
  type Erc20ApprovalTxInput,
  type MarketIdTxInput,
  type MiniClobCancelTxInput,
  type MiniClobFillTxInput,
  type MiniClobPlaceTxInput,
  type RedeemTxInput,
  type SellTxInput,
  type TxRequest,
} from '@predex-pump/shared/tx';
import {
  createWalletClient,
  defineChain,
  http,
  type Account,
  type Hex,
  type Transport,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const arcAgentChain = defineChain({
  id: ARC.chainId,
  name: ARC.name,
  nativeCurrency: ARC.nativeCurrency,
  rpcUrls: {
    default: {
      http: [...ARC.rpcUrls],
    },
  },
  testnet: true,
});

export interface AgentWalletClientOptions {
  account: Account;
  rpcUrl?: string;
}

export function createAgentWalletClient({
  account,
  rpcUrl = ARC.rpcUrls[0],
}: AgentWalletClientOptions): WalletClient<
  Transport,
  typeof arcAgentChain,
  Account
> {
  return createWalletClient({
    account,
    chain: arcAgentChain,
    transport: http(rpcUrl),
  });
}

export type AgentWalletClient = ReturnType<typeof createAgentWalletClient>;

export class PredexWriteClient {
  constructor(readonly walletClient: AgentWalletClient) {}

  send(transaction: TxRequest) {
    return this.walletClient.sendTransaction({
      account: this.walletClient.account,
      chain: arcAgentChain,
      ...transaction,
    });
  }

  approveCollateral(input: Erc20ApprovalTxInput) {
    return this.send(buildErc20ApprovalTx(input));
  }

  approveCtfOperator(input: CtfApprovalForAllTxInput) {
    return this.send(buildCtfApprovalForAllTx(input));
  }

  createMarket(input: CreateMarketTxInput) {
    return this.send(buildCreateMarketTx(input));
  }

  buy(input: BuyTxInput) {
    return this.send(buildBuyTx(input));
  }

  sell(input: SellTxInput) {
    return this.send(buildSellTx(input));
  }

  graduateIfQualified(input: MarketIdTxInput) {
    return this.send(buildGraduateIfQualifiedTx(input));
  }

  graduate(input: MarketIdTxInput) {
    return this.graduateIfQualified(input);
  }

  placeOrder(input: MiniClobPlaceTxInput) {
    return this.send(buildMiniClobPlaceTx(input));
  }

  fillOrder(input: MiniClobFillTxInput) {
    return this.send(buildMiniClobFillTx(input));
  }

  cancelOrder(input: MiniClobCancelTxInput) {
    return this.send(buildMiniClobCancelTx(input));
  }

  resolve(input: CommitteeResolveTxInput) {
    return this.send(buildCommitteeResolveTx(input));
  }

  observeResolution(input: MarketIdTxInput) {
    return this.send(buildObserveResolutionTx(input));
  }

  redeem(input: RedeemTxInput) {
    return this.send(buildRedeemTx(input));
  }

  closeout(input: MarketIdTxInput) {
    return this.send(buildCloseoutTx(input));
  }

  claimFundingResidual(input: MarketIdTxInput) {
    return this.send(buildClaimFundingResidualTx(input));
  }

  sweepProtocolAfterCloseout(input: MarketIdTxInput) {
    return this.send(buildSweepProtocolAfterCloseoutTx(input));
  }
}

export function createWriteClient(options: AgentWalletClientOptions) {
  return new PredexWriteClient(createAgentWalletClient(options));
}

export function privateKeyAccountFromEnv(
  variableName: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const value = environment[variableName]?.trim();
  if (!value) {
    throw new Error(
      `Set ${variableName} in the caller environment before creating a signing account.`,
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/u.test(value)) {
    throw new Error(`${variableName} must contain a 32-byte 0x-prefixed key.`);
  }
  return privateKeyToAccount(value as Hex);
}
