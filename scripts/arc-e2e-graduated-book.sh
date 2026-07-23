#!/usr/bin/env bash
# Real-Arc e2e: create -> trade -> graduate -> (complete-set handoff seeds MiniCLOB) -> place -> fill.
# Drives via `cast` because Arc USDC cannot be simulated locally (blocklist precompile).
# Key is extracted into $KEY and NEVER printed. Do NOT add `set -x`. Portable to macOS bash 3.2.
set -euo pipefail

ARC=https://rpc.testnet.arc.io
USDC=0x3600000000000000000000000000000000000000
CTF=0xd6fcfDb350beaDd944E4eC93a788388d82EF2beb
ORACLE=0x8E93440689B3EB393AC359335bEc23F4D2F940E5
LMSR=0x48ecAe9E1Dc321f9a57970e9919eE3eb42A89ead
REGISTRY=0x8aeB31722A77C866f9F32463B4383d7d3047FEE5
MINICLOB=0x8eC37d407FEFfB0b3917c50ffee8FE39A085c22f
ME=0xfE4cc0643199d15a0e284E61088d4c9495D506aF

KEY=$(grep -oiE '(0x)?[0-9a-f]{64}' /Users/ggattacker/Documents/predex/.credentials/.arc | head -1)
case "$KEY" in 0x*) ;; *) KEY="0x$KEY";; esac

CALL() { cast call --rpc-url "$ARC" "$@"; }
num() { echo "${1%% *}"; }                              # strip " [1.2e3]" from a single value
# tok RAW N : strip sci annotations, flatten newlines, print Nth whitespace token (1-indexed)
tok() { echo "$1" | sed -E 's/ \[[^]]*\]//g' | tr '\n' ' ' | awk -v n="$2" '{print $n}'; }
send() {
  local label="$1"; shift
  if out=$(cast send --rpc-url "$ARC" --private-key "$KEY" "$@" 2>&1); then
    echo "  OK   $label  (status $(echo "$out" | awk '/^status/{print $2}'))"
  else
    echo "  FAIL $label"; echo "$out" | grep -v -iE '[0-9a-f]{60}' | tail -6; exit 1
  fi
}

echo "### 0. balance before: USDC=$(num "$(CALL $USDC 'balanceOf(address)(uint256)' $ME)")"

echo "### 1. approvals"
send "approve USDC->registry"  $USDC "approve(address,uint256)" $REGISTRY 1000000000000
send "approve USDC->LMSR"      $USDC "approve(address,uint256)" $LMSR     1000000000000
send "approve USDC->MiniCLOB"  $USDC "approve(address,uint256)" $MINICLOB 1000000000000
send "setApproval CTF->LMSR"      $CTF "setApprovalForAll(address,bool)" $LMSR     true
send "setApproval CTF->MiniCLOB"  $CTF "setApprovalForAll(address,bool)" $MINICLOB true

echo "### 2. create market (seed 1 USDC)"
ANC=0x70726564657870756d702d6172632d65326500
MH=$(cast keccak $ANC)
MKID=$(num "$(cast call --rpc-url "$ARC" --from $ME $REGISTRY 'createMarket(bytes,uint256,uint256,bytes32)(uint256)' $ANC 1000000 0 $MH)")
send "createMarket id=$MKID" $REGISTRY "createMarket(bytes,uint256,uint256,bytes32)" $ANC 1000000 0 $MH
TB=$(CALL $REGISTRY "tokenBinding(uint256)(address,address,address,bytes32,bytes32,uint256,uint256)" $MKID)
CONDID=$(tok "$TB" 5); YES=$(tok "$TB" 6); NO=$(tok "$TB" 7)
echo "  marketId=$MKID  conditionId=$CONDID"
echo "  yesToken=$YES"
echo "  noToken =$NO"

echo "### 3. buy 0.1 YES (exercise the curve; move frozen price off 0.5)"
NOW=$(num "$(cast block latest --rpc-url $ARC --field timestamp 2>/dev/null || date +%s)")
DL=$((NOW + 604800))
send "buyYes 100000" $LMSR "buyYes(uint256,uint256,uint256,uint256)" $MKID 100000 3000000 $DL

echo "### 4. graduate (toll->feeReceiver; halt; complete-set handoff seeds the book)"
send "graduateIfQualified" $REGISTRY "graduateIfQualified(uint256)" $MKID
NORD=$(num "$(CALL $MINICLOB 'nextOrderId()(uint256)')")
echo "  MiniCLOB nextOrderId=$NORD (>=3 => two seed asks exist)"

echo "### 5. inspect seeded book"
SEEDED=0; K=0
if [ "$NORD" -ge 3 ]; then
  O1=$(CALL $MINICLOB "orders(uint256)(address,bytes32,uint256,uint8,uint256,uint256,uint256,bool)" 1)
  O2=$(CALL $MINICLOB "orders(uint256)(address,bytes32,uint256,uint8,uint256,uint256,uint256,bool)" 2)
  FROZEN=$(tok "$O1" 5); K=$(tok "$O1" 6); NOPRICE=$(tok "$O2" 5); K2=$(tok "$O2" 6)
  echo "  order#1 YES ASK: price=$FROZEN size=$K filled=$(tok "$O1" 7)"
  echo "  order#2 NO  ASK: price=$NOPRICE size=$K2"
  echo "  MiniCLOB escrow: YES=$(num "$(CALL $CTF 'balanceOf(address,uint256)(uint256)' $MINICLOB $YES)") NO=$(num "$(CALL $CTF 'balanceOf(address,uint256)(uint256)' $MINICLOB $NO)")"
  [ "$K" -gt 0 ] && SEEDED=1
else
  echo "  book NOT seeded (K==0 path); graduation still succeeded"
fi

echo "### 6. place fresh BID for YES @0.40, size 0.20 (escrows 0.08 USDC)"
send "place BID YES (order#$NORD)" $MINICLOB "place(bytes32,uint256,uint8,uint256,uint256)" $CONDID $YES 0 400000 200000

echo "### 7. fill part of the seeded YES ASK (real settlement over graduated book)"
if [ "$SEEDED" -eq 1 ]; then
  FILL=$((K/2)); [ "$FILL" -lt 1 ] && FILL=1
  MINF=$(num "$(CALL $MINICLOB 'minimumFillRaw(uint256)(uint256)' 1)")
  [ "$FILL" -lt "$MINF" ] && FILL=$MINF
  YB0=$(num "$(CALL $CTF 'balanceOf(address,uint256)(uint256)' $ME $YES)")
  send "fill order#1 by $FILL (K=$K minFill=$MINF)" $MINICLOB "fill(uint256,uint256)" 1 $FILL
  O1b=$(CALL $MINICLOB "orders(uint256)(address,bytes32,uint256,uint8,uint256,uint256,uint256,bool)" 1)
  YB1=$(num "$(CALL $CTF 'balanceOf(address,uint256)(uint256)' $ME $YES)")
  echo "  order#1 filledRaw=$(tok "$O1b" 7) open=$(tok "$O1b" 8);  my YES $YB0 -> $YB1 (expect +$FILL)"
else
  echo "  (skipped; K==0)"
fi

echo "### 8. escrow invariants"
CALL $MINICLOB "checkEscrowInvariants(uint256)" $YES >/dev/null && echo "  YES escrow >= obligations OK"
CALL $MINICLOB "checkEscrowInvariants(uint256)" $NO  >/dev/null && echo "  NO  escrow >= obligations OK"

echo "### 9. balance after: USDC=$(num "$(CALL $USDC 'balanceOf(address)(uint256)' $ME)")"
echo "### e2e DONE (marketId=$MKID)"
