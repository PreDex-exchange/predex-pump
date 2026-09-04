import 'package:flutter/foundation.dart';

class AppConfig {
  AppConfig._(this.appUri);

  static const _loopbackHosts = <String>{'127.0.0.1', '10.0.2.2', 'localhost'};

  final Uri appUri;

  Uri get origin => Uri(
    scheme: appUri.scheme,
    host: appUri.host,
    port: appUri.hasPort ? appUri.port : null,
  );

  factory AppConfig.fromEnvironment() {
    return AppConfig.parse(
      appUrl: const String.fromEnvironment('PREDEX_APP_URL'),
      allowInsecureLoopback:
          kDebugMode &&
          const bool.fromEnvironment('PREDEX_ALLOW_INSECURE_LOOPBACK'),
    );
  }

  factory AppConfig.parse({
    required String appUrl,
    required bool allowInsecureLoopback,
  }) {
    final value = appUrl.trim();
    final uri = Uri.tryParse(value);
    if (value.isEmpty || uri == null || !uri.hasScheme || !uri.hasAuthority) {
      throw const FormatException('PREDEX_APP_URL must be an absolute URL');
    }
    if (uri.userInfo.isNotEmpty) {
      throw const FormatException(
        'PREDEX_APP_URL must not contain credentials',
      );
    }
    if (uri.hasQuery || uri.hasFragment) {
      throw const FormatException(
        'PREDEX_APP_URL must not contain a query or fragment',
      );
    }

    final secure = uri.scheme == 'https';
    final allowedLoopback =
        allowInsecureLoopback &&
        uri.scheme == 'http' &&
        _loopbackHosts.contains(uri.host.toLowerCase());
    if (!secure && !allowedLoopback) {
      throw const FormatException(
        'PREDEX_APP_URL must use HTTPS unless explicit loopback mode is enabled',
      );
    }

    return AppConfig._(uri);
  }
}
