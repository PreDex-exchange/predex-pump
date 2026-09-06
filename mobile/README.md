# Predex mobile

The first mobile release is a secure Flutter shell around the responsive Predex web app.
It deliberately reuses the audited wagmi/MetaMask, quote, contract-call, Hybrid-order,
REST, and WebSocket flows instead of duplicating protocol logic in Dart.

The shell provides native loading and retry states, Android back navigation, a strict
same-origin WebView policy, and external handling for MetaMask and Arcscan links. It has
no JavaScript bridge, private-key storage, embedded wallet, or native contract encoder.

## Configuration

Every build must provide its web-app URL:

```sh
flutter run --dart-define=PREDEX_APP_URL=https://app.example.com
```

Production URLs must use HTTPS. Local HTTP is accepted only for explicit debug builds:

```sh
flutter run \
  --dart-define=PREDEX_APP_URL=http://localhost:3002 \
  --dart-define=PREDEX_ALLOW_INSECURE_LOOPBACK=true
```

No API secret, wallet key, Reown project ID, or signing material belongs in this app.

## Verification

```sh
flutter pub get --enforce-lockfile
dart format --output=none --set-exit-if-changed .
flutter analyze --fatal-infos --fatal-warnings
flutter test
flutter build apk --debug \
  --dart-define=PREDEX_APP_URL=http://localhost:3002 \
  --dart-define=PREDEX_ALLOW_INSECURE_LOOPBACK=true
```

An APK is not the wallet acceptance gate. Before release, a physical Android phone must
complete: open app, browse a market, connect MetaMask, switch to Arc Testnet, approve and
submit a small trade, return to Predex, and observe the confirmed activity and holding.
