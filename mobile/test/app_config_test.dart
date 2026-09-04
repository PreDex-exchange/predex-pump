import 'package:flutter_test/flutter_test.dart';
import 'package:predex_mobile/src/app_config.dart';

void main() {
  group('AppConfig', () {
    test('accepts a production HTTPS origin', () {
      final config = AppConfig.parse(
        appUrl: 'https://app.predex.fun/terminal',
        allowInsecureLoopback: false,
      );

      expect(config.appUri, Uri.parse('https://app.predex.fun/terminal'));
      expect(config.origin, Uri.parse('https://app.predex.fun'));
    });

    test('accepts loopback HTTP only when the debug gate is explicit', () {
      final config = AppConfig.parse(
        appUrl: 'http://10.0.2.2:3002',
        allowInsecureLoopback: true,
      );

      expect(config.origin, Uri.parse('http://10.0.2.2:3002'));
      expect(
        () => AppConfig.parse(
          appUrl: 'http://10.0.2.2:3002',
          allowInsecureLoopback: false,
        ),
        throwsFormatException,
      );
    });

    test('rejects empty, credentialed, fragmented, and remote HTTP URLs', () {
      for (final appUrl in <String>[
        '',
        'https://user:secret@app.predex.fun',
        'https://app.predex.fun/#wallet',
        'http://app.predex.fun',
      ]) {
        expect(
          () => AppConfig.parse(appUrl: appUrl, allowInsecureLoopback: true),
          throwsFormatException,
          reason: appUrl,
        );
      }
    });
  });
}
