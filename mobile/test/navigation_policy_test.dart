import 'package:flutter_test/flutter_test.dart';
import 'package:predex_mobile/src/navigation_policy.dart';

void main() {
  final policy = NavigationPolicy(
    appOrigin: Uri.parse('https://app.predex.fun'),
  );

  group('NavigationPolicy', () {
    test('keeps only the exact configured origin inside the WebView', () {
      expect(
        policy.decide('https://app.predex.fun/market/3'),
        NavigationDisposition.navigate,
      );
      expect(
        policy.decide('https://app.predex.fun.evil.example/market/3'),
        NavigationDisposition.block,
      );
      expect(
        policy.decide('https://api.predex.fun/market/3'),
        NavigationDisposition.block,
      );
      expect(
        policy.decide('https://app.predex.fun:444/market/3'),
        NavigationDisposition.block,
      );
    });

    test('opens only known wallet and explorer destinations externally', () {
      for (final url in <String>[
        'metamask://connect?uri=example',
        'https://link.metamask.io/dapp/app.predex.fun',
        'https://metamask.app.link/dapp/app.predex.fun',
        'https://testnet.arcscan.app/tx/0x1234',
      ]) {
        expect(
          policy.decide(url),
          NavigationDisposition.openExternally,
          reason: url,
        );
      }
    });

    test('blocks unsafe schemes, malformed URLs, and unknown hosts', () {
      for (final url in <String>[
        'javascript:alert(1)',
        'data:text/html,hello',
        'file:///etc/passwd',
        'https://example.com',
        'https://link.metamask.io.evil.example/dapp/predex',
        'http://link.metamask.io/dapp/predex',
        'metamaskx://connect',
        'not a url',
      ]) {
        expect(policy.decide(url), NavigationDisposition.block, reason: url);
      }
    });
  });
}
