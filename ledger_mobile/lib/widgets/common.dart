import 'package:flutter/material.dart';

import '../format.dart';

class ErrorText extends StatelessWidget {
  const ErrorText(this.message, {super.key});

  final String? message;

  @override
  Widget build(BuildContext context) {
    if (message == null || message!.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Text(message!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
    );
  }
}

class StatTile extends StatelessWidget {
  const StatTile({super.key, required this.label, required this.minor, required this.currency, this.hint, this.onTap});

  final String label;
  final String minor;
  final String currency;
  final String? hint;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(child: Text(label, style: theme.textTheme.labelLarge?.copyWith(color: theme.colorScheme.onSurfaceVariant))),
                  if (onTap != null) Icon(Icons.chevron_right, size: 18, color: theme.colorScheme.primary),
                ],
              ),
              const SizedBox(height: 6),
              Text(formatMinor(minor, currency: currency), style: theme.textTheme.titleMedium),
              if (hint != null) ...[const SizedBox(height: 4), Text(hint!, style: theme.textTheme.bodySmall)],
            ],
          ),
        ),
      ),
    );
  }
}

class EmptyNote extends StatelessWidget {
  const EmptyNote(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 24),
      child: Text(text, style: Theme.of(context).textTheme.bodyLarge),
    );
  }
}
