import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'src/app_config.dart';
import 'src/predex_browser.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setSystemUIOverlayStyle(
    const SystemUiOverlayStyle(
      statusBarColor: Color(0xFFFFF7EE),
      statusBarIconBrightness: Brightness.dark,
      systemNavigationBarColor: Color(0xFFFFF7EE),
      systemNavigationBarIconBrightness: Brightness.dark,
    ),
  );
  runApp(PredexApp.fromEnvironment());
}

class PredexApp extends StatelessWidget {
  const PredexApp({super.key, this.config, this.configurationError})
    : assert(
        (config == null) != (configurationError == null),
        'Provide either config or configurationError',
      );

  factory PredexApp.fromEnvironment() {
    try {
      return PredexApp(config: AppConfig.fromEnvironment());
    } on FormatException catch (error) {
      return PredexApp(configurationError: error.message);
    }
  }

  final AppConfig? config;
  final String? configurationError;

  @override
  Widget build(BuildContext context) {
    final colorScheme = ColorScheme.fromSeed(
      seedColor: const Color(0xFFFF6B57),
      brightness: Brightness.light,
      surface: const Color(0xFFFFF7EE),
    );
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'Predex',
      theme: ThemeData(
        colorScheme: colorScheme,
        scaffoldBackgroundColor: const Color(0xFFFFF7EE),
        useMaterial3: true,
      ),
      home: config == null
          ? PredexNativeFailure(
              title: 'This Predex build is not configured',
              message: 'Install a build that points to the official Predex application.',
              detail: configurationError,
            )
          : PredexBrowser(config: config!),
    );
  }
}
