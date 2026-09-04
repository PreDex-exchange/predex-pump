import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:predex_mobile/main.dart';
import 'package:predex_mobile/src/predex_browser.dart';

void main() {
  testWidgets('shows a native failure when the build URL is missing', (
    tester,
  ) async {
    await tester.pumpWidget(
      const PredexApp(configurationError: 'PREDEX_APP_URL is missing'),
    );

    expect(find.text('This Predex build is not configured'), findsOneWidget);
    expect(find.textContaining('official Predex application'), findsOneWidget);
    expect(find.text('PREDEX_APP_URL is missing'), findsOneWidget);
  });

  testWidgets('native load failure exposes one working retry action', (
    tester,
  ) async {
    var retries = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: PredexNativeFailure(
          title: 'Predex is offline',
          message: 'Check your connection.',
          retryLabel: 'Try again',
          onRetry: () => retries += 1,
        ),
      ),
    );

    await tester.tap(find.widgetWithText(FilledButton, 'Try again'));
    expect(retries, 1);
  });
}
