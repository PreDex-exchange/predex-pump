export function isConnectedWalletMaker(
  maker: string,
  connectedAddress?: string,
): boolean {
  return (
    connectedAddress !== undefined &&
    maker.toLowerCase() === connectedAddress.toLowerCase()
  );
}
