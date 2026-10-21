import 'package:flutter/material.dart';

const ledgerBlue = Color(0xFF1D4ED8);

ThemeData ledgerTheme(Brightness brightness) {
  final scheme = ColorScheme.fromSeed(seedColor: ledgerBlue, brightness: brightness);
  return ThemeData(
    colorScheme: scheme,
    useMaterial3: true,
    inputDecorationTheme: const InputDecorationTheme(border: OutlineInputBorder()),
  );
}
