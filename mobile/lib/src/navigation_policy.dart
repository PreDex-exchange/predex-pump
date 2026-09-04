enum NavigationDisposition { navigate, openExternally, block }

class NavigationPolicy {
  NavigationPolicy({required this.appOrigin});

  static const _externalHttpsHosts = <String>{
    'link.metamask.io',
    'metamask.app.link',
    'testnet.arcscan.app',
  };

  final Uri appOrigin;

  NavigationDisposition decide(String rawUrl) {
    final uri = Uri.tryParse(rawUrl.trim());
    if (uri == null || !uri.hasScheme) return NavigationDisposition.block;
    if (uri.scheme == 'about' && uri.path == 'blank') {
      return NavigationDisposition.navigate;
    }
    if (_sameOrigin(uri, appOrigin)) return NavigationDisposition.navigate;
    if (uri.scheme == 'metamask') return NavigationDisposition.openExternally;
    if (uri.scheme == 'https' &&
        _externalHttpsHosts.contains(uri.host.toLowerCase())) {
      return NavigationDisposition.openExternally;
    }
    return NavigationDisposition.block;
  }

  bool _sameOrigin(Uri left, Uri right) {
    return left.scheme == right.scheme &&
        left.host.toLowerCase() == right.host.toLowerCase() &&
        _effectivePort(left) == _effectivePort(right);
  }

  int _effectivePort(Uri uri) {
    if (uri.hasPort) return uri.port;
    if (uri.scheme == 'https') return 443;
    if (uri.scheme == 'http') return 80;
    return -1;
  }
}
