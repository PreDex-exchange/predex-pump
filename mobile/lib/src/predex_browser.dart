import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';

import 'app_config.dart';
import 'navigation_policy.dart';

typedef ExternalUrlLauncher = Future<bool> Function(Uri uri);

Future<bool> _launchExternalUrl(Uri uri) {
  return launchUrl(uri, mode: LaunchMode.externalApplication);
}

class PredexBrowser extends StatefulWidget {
  const PredexBrowser({
    required this.config,
    this.externalUrlLauncher = _launchExternalUrl,
    super.key,
  });

  final AppConfig config;
  final ExternalUrlLauncher externalUrlLauncher;

  @override
  State<PredexBrowser> createState() => _PredexBrowserState();
}

class _PredexBrowserState extends State<PredexBrowser>
    with WidgetsBindingObserver {
  late final NavigationPolicy _navigationPolicy;
  late final WebViewController _controller;
  double _progress = 0;
  String? _mainFrameError;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _navigationPolicy = NavigationPolicy(appOrigin: widget.config.origin);
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(const Color(0xFFFFF7EE))
      ..setNavigationDelegate(
        NavigationDelegate(
          onProgress: (progress) {
            if (!mounted) return;
            setState(() => _progress = progress / 100);
          },
          onPageStarted: (_) {
            if (!mounted) return;
            setState(() {
              _progress = 0;
              _mainFrameError = null;
            });
          },
          onPageFinished: (_) {
            if (!mounted) return;
            setState(() => _progress = 1);
          },
          onWebResourceError: (error) {
            if (error.isForMainFrame == false || !mounted) return;
            setState(() {
              _mainFrameError = kDebugMode
                  ? error.description
                  : 'Predex could not be reached.';
            });
          },
          onNavigationRequest: _handleNavigation,
        ),
      );
    unawaited(_controller.loadRequest(widget.config.appUri));
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      unawaited(_notifyWebViewResumed());
    }
  }

  Future<void> _notifyWebViewResumed() async {
    try {
      // Android WebView can become visible without promptly emitting the
      // browser focus event MetaMask Connect uses to resume its transport.
      await _controller.runJavaScript(
        "window.dispatchEvent(new Event('focus'));",
      );
    } on Object {
      // The first lifecycle event can arrive before the initial page is ready.
    }
  }

  NavigationDecision _handleNavigation(NavigationRequest request) {
    final disposition = _navigationPolicy.decide(request.url);
    if (disposition == NavigationDisposition.navigate) {
      return NavigationDecision.navigate;
    }
    if (request.isMainFrame &&
        disposition == NavigationDisposition.openExternally) {
      final uri = Uri.tryParse(request.url);
      if (uri != null) unawaited(_openExternal(uri));
      return NavigationDecision.prevent;
    }
    if (request.isMainFrame) {
      _showMessage('Blocked a link outside Predex.');
    }
    return NavigationDecision.prevent;
  }

  Future<void> _openExternal(Uri uri) async {
    try {
      final opened = await widget.externalUrlLauncher(uri);
      if (!opened && mounted) _showMessage('No app can open this link.');
    } on Object {
      if (mounted) _showMessage('No app can open this link.');
    }
  }

  void _showMessage(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _handleBack() async {
    if (await _controller.canGoBack()) {
      await _controller.goBack();
      return;
    }
    await SystemNavigator.pop();
  }

  void _retry() {
    setState(() {
      _mainFrameError = null;
      _progress = 0;
    });
    unawaited(_controller.loadRequest(widget.config.appUri));
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) unawaited(_handleBack());
      },
      child: Scaffold(
        body: SafeArea(
          child: Stack(
            children: [
              Positioned.fill(child: WebViewWidget(controller: _controller)),
              if (_progress < 1 && _mainFrameError == null)
                Align(
                  alignment: Alignment.topCenter,
                  child: Semantics(
                    label: 'Loading Predex',
                    child: LinearProgressIndicator(value: _progress),
                  ),
                ),
              if (_mainFrameError case final error?)
                Positioned.fill(
                  child: PredexNativeFailure(
                    title: 'Predex is offline',
                    message: 'Check your connection, then try loading the application again.',
                    detail: error,
                    retryLabel: 'Try again',
                    onRetry: _retry,
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class PredexNativeFailure extends StatelessWidget {
  const PredexNativeFailure({
    required this.title,
    required this.message,
    this.detail,
    this.retryLabel,
    this.onRetry,
    super.key,
  });

  final String title;
  final String message;
  final String? detail;
  final String? retryLabel;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: DecoratedBox(
                decoration: BoxDecoration(
                  color: Colors.white,
                  border: Border.all(color: const Color(0xFF2B2440), width: 2),
                  borderRadius: BorderRadius.circular(20),
                  boxShadow: const [
                    BoxShadow(color: Color(0xFF2B2440), offset: Offset(0, 5)),
                  ],
                ),
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const _PredexMark(),
                      const SizedBox(height: 20),
                      Text(
                        title,
                        textAlign: TextAlign.center,
                        style: Theme.of(context).textTheme.headlineSmall
                            ?.copyWith(
                              color: const Color(0xFF2B2440),
                              fontWeight: FontWeight.w800,
                            ),
                      ),
                      const SizedBox(height: 12),
                      Text(
                        message,
                        textAlign: TextAlign.center,
                        style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                          color: const Color(0xFF645D75),
                          height: 1.45,
                        ),
                      ),
                      if (kDebugMode && detail != null) ...[
                        const SizedBox(height: 12),
                        Text(
                          detail!,
                          textAlign: TextAlign.center,
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                      ],
                      if (onRetry != null && retryLabel != null) ...[
                        const SizedBox(height: 24),
                        FilledButton(
                          onPressed: onRetry,
                          style: FilledButton.styleFrom(
                            minimumSize: const Size.fromHeight(48),
                            backgroundColor: const Color(0xFFFF6B57),
                            foregroundColor: const Color(0xFF2B2440),
                            side: const BorderSide(
                              color: Color(0xFF2B2440),
                              width: 2,
                            ),
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(14),
                            ),
                          ),
                          child: Text(retryLabel!),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _PredexMark extends StatelessWidget {
  const _PredexMark();

  @override
  Widget build(BuildContext context) {
    return Semantics(
      image: true,
      label: 'Predex',
      child: Image.asset(
        'assets/predex-mark.png',
        width: 72,
        height: 72,
        filterQuality: FilterQuality.high,
      ),
    );
  }
}
