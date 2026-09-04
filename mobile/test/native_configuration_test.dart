import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('native package identifiers avoid reserved language keywords', () {
    final gradle = File('android/app/build.gradle.kts').readAsStringSync();
    final activity = File(
      'android/app/src/main/kotlin/exchange/predex/mobile/MainActivity.kt',
    ).readAsStringSync();
    final xcode = File('ios/Runner.xcodeproj/project.pbxproj')
        .readAsStringSync();

    expect(gradle, contains('namespace = "exchange.predex.mobile"'));
    expect(gradle, contains('applicationId = "exchange.predex.mobile"'));
    expect(activity, startsWith('package exchange.predex.mobile'));
    expect(
      xcode,
      contains('PRODUCT_BUNDLE_IDENTIFIER = exchange.predex.mobile;'),
    );
    expect('$gradle\n$activity\n$xcode', isNot(contains('fun.predex')));
  });

  test('native manifests keep production HTTPS-only and expose MetaMask', () {
    final androidMain = File('android/app/src/main/AndroidManifest.xml')
        .readAsStringSync();
    final androidDebug = File('android/app/src/debug/AndroidManifest.xml')
        .readAsStringSync();
    final iosInfo = File('ios/Runner/Info.plist').readAsStringSync();

    expect(androidMain, contains('android:usesCleartextTraffic="false"'));
    expect(androidMain, contains('android:allowBackup="false"'));
    expect(androidDebug, contains('android:usesCleartextTraffic="true"'));
    expect(androidMain, contains('android:name="io.metamask"'));
    expect(androidMain, contains('android:host="link.metamask.io"'));
    expect(iosInfo, contains('<string>metamask</string>'));
    expect(iosInfo, contains('<key>NSAllowsLocalNetworking</key>'));
    expect(iosInfo, contains('<string>Predex</string>'));
    expect(iosInfo, isNot(contains('<string>Predex Mobile</string>')));
  });

  test('native startup and fallback surfaces preserve Predex branding', () {
    final androidLaunch = File(
      'android/app/src/main/res/drawable/launch_background.xml',
    ).readAsStringSync();
    final androidLaunchV21 = File(
      'android/app/src/main/res/drawable-v21/launch_background.xml',
    ).readAsStringSync();
    final androidNight = File(
      'android/app/src/main/res/values-night/styles.xml',
    ).readAsStringSync();
    final iosLaunch = File('ios/Runner/Base.lproj/LaunchScreen.storyboard')
        .readAsStringSync();
    final failureSurface = File('lib/src/predex_browser.dart')
        .readAsStringSync();
    final pubspec = File('pubspec.yaml').readAsStringSync();

    for (final launch in <String>[androidLaunch, androidLaunchV21]) {
      expect(launch, contains('@color/predex_background'));
      expect(launch, contains('@mipmap/ic_launcher'));
    }
    expect(androidNight, isNot(contains('Theme.Black')));
    expect(androidNight, isNot(contains('?android:colorBackground')));
    expect(iosLaunch, contains('red="1" green="0.968627451"'));
    expect(failureSurface, contains("'assets/predex-mark.png'"));
    expect(failureSurface, isNot(contains('Icons.bolt')));
    expect(pubspec, contains('- assets/predex-mark.png'));

    expect(_pngDimensions('assets/predex-mark.png'), (192, 192));
    expect(
      _pngDimensions(
        'ios/Runner/Assets.xcassets/LaunchImage.imageset/LaunchImage.png',
      ),
      (168, 168),
    );
    expect(
      _pngDimensions(
        'ios/Runner/Assets.xcassets/LaunchImage.imageset/LaunchImage@2x.png',
      ),
      (336, 336),
    );
    expect(
      _pngDimensions(
        'ios/Runner/Assets.xcassets/LaunchImage.imageset/LaunchImage@3x.png',
      ),
      (504, 504),
    );
  });

  test('app resume wakes the browser wallet transport without a JS bridge', () {
    final browser = File('lib/src/predex_browser.dart').readAsStringSync();

    expect(browser, contains('with WidgetsBindingObserver'));
    expect(browser, contains('WidgetsBinding.instance.addObserver(this)'));
    expect(browser, contains('WidgetsBinding.instance.removeObserver(this)'));
    expect(browser, contains('state == AppLifecycleState.resumed'));
    expect(browser, contains("window.dispatchEvent(new Event('focus'))"));
    expect(browser, isNot(contains('addJavaScriptChannel')));
  });
}

(int, int) _pngDimensions(String path) {
  final bytes = File(path).readAsBytesSync();
  expect(bytes.length, greaterThanOrEqualTo(24), reason: path);
  expect(bytes.sublist(1, 4), <int>[80, 78, 71], reason: path);

  int readUint32(int offset) =>
      (bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3];

  return (readUint32(16), readUint32(20));
}
